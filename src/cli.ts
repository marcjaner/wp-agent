#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { WordPress, WpError, pageSummary, saveSiteUrl, type Page } from './wordpress.js';
import { BridgeClient } from './bridge.js';
import { readCustomCss, writeCustomCss, type BackendPreference } from './capabilities.js';
import { readGeneratePressConfig, writeGeneratePressConfig } from './adapters/generatepress.js';
import { blockTree } from './blocks.js';
import { PlaywrightDriver, previewUrl } from './browser.js';
import { clonePage, copyPageBlock, removePageBlock, replacePageImage, replacePageText, verifyPage as verifyPageCore } from './pages.js';
import { remoteWp } from './wpcli.js';

const program = new Command();
program.name('wp-agent').description('Structured WordPress control and browser verification').option('--json', 'Machine-readable JSON output');
program.configureOutput({ writeErr: () => {} });
program.exitOverride();
const wp = () => new WordPress();
const id = (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid page ID: ${value}`);
  return parsed;
};
const output = (data: unknown, human?: string) => {
  if (program.opts().json) console.log(JSON.stringify(data, null, 2));
  else console.log(human ?? JSON.stringify(data, null, 2));
};
const text = (value: string | undefined) => value || '';

async function render(url: string, filename: string, viewport: 'desktop' | 'mobile', authenticated = false) {
  const driver = new PlaywrightDriver(authenticated ? wp().url : url);
  try { return await driver.render(url, viewport, filename, authenticated); }
  finally { await driver.close(); }
}

async function wordpressVersion(url: string): Promise<{ version: string | null; source: string | null }> {
  const fromCli = await remoteWp(['core', 'version']).catch(() => null);
  if (fromCli) return { version: fromCli, source: 'wp-cli' };
  const html = await fetch(url).then(response => response.text()).catch(() => '');
  const fromAsset = html.match(/wp-includes\/(?:js|css)\/[^"'\s>]+[?&]ver=(\d+\.\d+(?:\.\d+)?)/)?.[1];
  return { version: fromAsset || null, source: fromAsset ? 'core-asset' : null };
}

async function verifyPage(pageId: number, expectedStatus = 'draft') {
  const client = wp();
  const driver = new PlaywrightDriver(client.url);
  try { return await verifyPageCore(client, driver, pageId, { expectedStatus }); }
  finally { await driver.close(); }
}

program.command('connect <url>').description('Save a site URL and check authentication').action(async url => {
  const client = new WordPress(url);
  const me = await client.get<{ id: number; username: string; roles: string[]; capabilities: Record<string, boolean> }>('wp/v2/users/me?context=edit');
  saveSiteUrl(url);
  output({ url: client.url, user: me.username, roles: me.roles }, `Connected to ${client.url} as ${me.username}`);
});

program.command('status').description('Check credentials and basic permissions').action(async () => {
  const client = wp();
  const me = await client.get<{ id: number; username: string; roles: string[]; capabilities: Record<string, boolean> }>('wp/v2/users/me?context=edit');
  const capabilities = Object.fromEntries(['edit_pages', 'publish_pages', 'delete_pages', 'install_plugins', 'activate_plugins', 'install_themes', 'switch_themes', 'upload_files'].map(key => [key, !!me.capabilities[key]]));
  output({ authenticated: true, url: client.url, user: me.username, roles: me.roles, capabilities });
});

program.command('inspect').description('Discover the WordPress installation').action(async () => {
  const client = wp();
  const [settings, themes, plugins, types, root, blocks, versionInfo, bridge] = await Promise.all([
    client.get<{ title: string; url: string }>('wp/v2/settings'),
    client.all<ArrayItem>('wp/v2/themes'),
    client.all<ArrayItem>('wp/v2/plugins'),
    client.get<Record<string, unknown>>('wp/v2/types'),
    client.get<{ routes: Record<string, unknown> }>(''),
    client.get<{ name: string }[]>('wp/v2/block-types?context=edit'),
    wordpressVersion(client.url),
    new BridgeClient(client).discover(),
  ]);
  const data = {
    version: versionInfo.version, versionSource: versionInfo.source, siteUrl: settings.url, title: settings.title,
    activeTheme: themes.find(theme => theme.status === 'active'), installedThemes: themes,
    activePlugins: plugins.filter(plugin => plugin.status === 'active'), installedPlugins: plugins,
    postTypes: Object.keys(types), capabilities: Object.keys(root.routes).filter(route => route.startsWith('/wp/v2/')),
    gutenberg: blocks.length > 0, registeredBlocks: blocks.map(block => block.name),
    detectedBuilders: plugins.filter(plugin => /generateblocks|kadence|spectra|elementor|wpml|polylang|translatepress/i.test(`${plugin.plugin} ${plugin.name}`)),
    bridge: bridge ? { installed: true, ...bridge } : { installed: false },
  };
  output(data);
});

type ArrayItem = { status: string; plugin?: string; slug?: string; name?: unknown; stylesheet?: string };
const matchesPlugin = (plugin: ArrayItem, slug: string) => plugin.plugin === slug || plugin.slug === slug || plugin.plugin?.split('/')[0] === slug;
const pages = program.command('pages');
pages.command('list').action(async () => {
  const found = await wp().all<Page>('wp/v2/pages?context=edit&status=any');
  output(found.map(pageSummary));
});
pages.command('get <id>').action(async value => output(pageSummary(await wp().page(id(value)))));
pages.command('create').requiredOption('--title <title>').option('--content <html>').option('--content-file <path>').option('--publish').option('--template <template>').action(async options => {
  const content = options.contentFile ? fs.readFileSync(options.contentFile, 'utf8') : text(options.content);
  const page = await wp().post<Page>('wp/v2/pages', { title: options.title, content, status: options.publish ? 'publish' : 'draft', template: options.template });
  output(pageSummary(page));
});
pages.command('update <id>').option('--title <title>').option('--content <html>').option('--content-file <path>').option('--status <status>').option('--template <template>').option('--parent <id>').option('--publish').action(async (value, options) => {
  const client = wp();
  const previous = await client.page(id(value));
  const snapshot = await client.snapshot(previous);
  const changes: Record<string, unknown> = {};
  if (options.title !== undefined) changes.title = options.title;
  if (options.contentFile !== undefined) changes.content = fs.readFileSync(options.contentFile, 'utf8');
  else if (options.content !== undefined) changes.content = options.content;
  if (options.template !== undefined) changes.template = options.template;
  if (options.parent !== undefined) changes.parent = id(options.parent);
  if (options.status !== undefined) changes.status = options.status;
  if (options.publish) changes.status = 'publish';
  if (!Object.keys(changes).length) throw new Error('Provide a field to update.');
  const updated = await client.post<Page>(`wp/v2/pages/${previous.id}`, changes);
  output({ ...pageSummary(updated), snapshot });
});
pages.command('delete <id>').requiredOption('--yes', 'Confirm deletion').option('--force', 'Permanently delete instead of moving to trash').action(async (value, options) => {
  const client = wp();
  const previous = await client.page(id(value));
  const snapshot = await client.snapshot(previous);
  await client.delete(`wp/v2/pages/${previous.id}?force=${options.force ? 'true' : 'false'}`);
  const current = await client.page(previous.id).catch(error => {
    if (error instanceof WpError && error.status === 404) return null;
    throw error;
  });
  const deleted = options.force ? current === null : current?.status === 'trash';
  if (!deleted) throw new Error(`Page deletion was not confirmed for ${previous.id}`);
  output({ id: previous.id, deleted, status: current?.status || 'deleted', snapshot });
});
pages.command('clone <id>').option('--title <title>').action(async (value, options) => {
  const client = wp();
  const { source, clone } = await clonePage(client, id(value), options.title);
  const check = await verifyPage(clone.id);
  if (!check.ok) throw new Error(`Cloned page ${clone.id}, but render verification failed: ${JSON.stringify(check.checks)}`);
  output({ sourceId: source.id, page: pageSummary(clone), verification: check });
});
pages.command('revisions <id>').action(async value => output(await wp().all(`wp/v2/pages/${id(value)}/revisions?context=edit`)));
pages.command('preview <id>').option('--mobile').action(async (value, options) => {
  const page = await wp().page(id(value));
  const url = page.status === 'publish' ? page.link : previewUrl(page, wp().url);
  const viewport = options.mobile ? 'mobile' : 'desktop';
  const result = await render(url, `artifacts/page-${page.id}-${viewport}.png`, viewport, page.status !== 'publish');
  output(result);
  if (result.status !== 200 || result.errors.length || new URL(result.finalUrl).pathname.includes('wp-login.php')) process.exitCode = 1;
});

const blocks = program.command('blocks');
blocks.command('list <page-id>').action(async value => {
  const page = await wp().page(id(value));
  const tree = blockTree(page.content.raw || '');
  output(tree, `Page ${page.id}\n${tree.map(block => `${'  '.repeat(block.path.split('.').length - 1)}${block.path} ${block.name}`).join('\n')}`);
});
blocks.command('map <page-id>').description('Map rendered elements and positions to Gutenberg block paths').option('--mobile').option('--all', 'Include nested blocks').action(async (value, options) => {
  const client = wp();
  const page = await client.page(id(value));
  const driver = new PlaywrightDriver(client.url);
  try { output(await driver.mapBlocks(page, options.mobile ? 'mobile' : 'desktop', !!options.all)); }
  finally { await driver.close(); }
});
blocks.command('get <page-id> <block-path>').action(async (value, blockPath) => {
  const page = await wp().page(id(value));
  const block = blockTree(page.content.raw || '').find(item => item.path === blockPath);
  if (!block) throw new Error(`Block ${blockPath} not found`);
  output(block);
});
blocks.command('copy <source-page-id> <block-path> <target-page-id>').option('--after <block-path>', 'Insert after a top-level block; otherwise append').action(async (sourceId, blockPath, targetId, options) => {
  const result = await copyPageBlock(wp(), id(sourceId), blockPath, id(targetId), options.after);
  output({ page: pageSummary(result.page), copiedFrom: { pageId: id(sourceId), path: blockPath }, after: options.after ?? null, snapshot: result.snapshot });
});
blocks.command('remove <page-id> <block-path>').action(async (pageId, blockPath) => {
  const result = await removePageBlock(wp(), id(pageId), blockPath);
  output({ page: pageSummary(result.page), removed: blockPath, snapshot: result.snapshot });
});
blocks.command('replace-image <page-id> <block-path> <media-id>').action(async (pageId, blockPath, mediaId) => {
  const result = await replacePageImage(wp(), id(pageId), blockPath, id(mediaId));
  output({ page: pageSummary(result.page), blockPath, mediaId: id(mediaId), snapshot: result.snapshot });
});

program.command('content').command('replace <page-id>').requiredOption('--from <text>').requiredOption('--to <text>').action(async (value, options) => {
  const result = await replacePageText(wp(), id(value), options.from, options.to);
  output({ page: pageSummary(result.page), replacements: result.replacements, snapshot: result.snapshot });
});

const media = program.command('media');
media.command('list').action(async () => output(await wp().all('wp/v2/media?context=edit')));
media.command('search <term>').action(async term => output(await wp().all(`wp/v2/media?context=edit&search=${encodeURIComponent(term)}`)));
media.command('upload <file>').option('--alt <text>').action(async (file, options) => {
  const name = path.basename(file);
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(file)]), name);
  if (options.alt) form.set('alt_text', options.alt);
  const uploaded = await wp().request<Record<string, unknown>>('wp/v2/media', { method: 'POST', body: form });
  output(uploaded);
});

const plugins = program.command('plugins');
plugins.command('list').action(async () => output(await wp().all('wp/v2/plugins')));
plugins.command('install <slug>').action(async slug => {
  const client = wp();
  const installed = await client.post<ArrayItem>('wp/v2/plugins', { slug, status: 'inactive' });
  const checked = await client.get<ArrayItem>(`wp/v2/plugins/${installed.plugin}`);
  if (checked.status !== 'inactive') throw new Error(`Plugin installed but unexpected state: ${checked.status}`);
  output(checked);
});
plugins.command('activate <slug>').action(async slug => {
  const client = wp();
  const plugin = (await client.all<ArrayItem>('wp/v2/plugins')).find(item => matchesPlugin(item, slug));
  if (!plugin?.plugin) throw new Error(`Plugin not installed: ${slug}`);
  await client.post(`wp/v2/plugins/${plugin.plugin}`, { status: 'active' });
  const checked = await client.get<ArrayItem>(`wp/v2/plugins/${plugin.plugin}`);
  if (checked.status !== 'active') throw new Error(`Plugin activation failed: ${slug}`);
  output(checked);
});
plugins.command('deactivate <slug>').action(async slug => {
  const client = wp();
  const plugin = (await client.all<ArrayItem>('wp/v2/plugins')).find(item => matchesPlugin(item, slug));
  if (!plugin?.plugin) throw new Error(`Plugin not installed: ${slug}`);
  await client.post(`wp/v2/plugins/${plugin.plugin}`, { status: 'inactive' });
  const checked = await client.get<ArrayItem>(`wp/v2/plugins/${plugin.plugin}`);
  if (checked.status !== 'inactive') throw new Error(`Plugin deactivation failed: ${slug}`);
  output(checked);
});
plugins.command('remove <slug>').requiredOption('--yes', 'Confirm removal').action(async slug => {
  const client = wp();
  const plugin = (await client.all<ArrayItem>('wp/v2/plugins')).find(item => matchesPlugin(item, slug));
  if (!plugin?.plugin) throw new Error(`Plugin not installed: ${slug}`);
  if (plugin.status === 'active') throw new Error('Deactivate the plugin before removing it.');
  await client.delete(`wp/v2/plugins/${plugin.plugin}`);
  const remaining = (await client.all<ArrayItem>('wp/v2/plugins')).some(item => item.plugin === plugin.plugin);
  if (remaining) throw new Error(`Plugin removal was not confirmed: ${slug}`);
  output({ plugin: plugin.plugin, removed: true });
});

const themes = program.command('themes');
themes.command('list').action(async () => output(await wp().all('wp/v2/themes')));
themes.command('install <slug>').action(async slug => {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Theme slug must contain lowercase letters, digits, or hyphens.');
  await remoteWp(['theme', 'install', slug]);
  const installed = (await wp().all<ArrayItem>('wp/v2/themes')).find(theme => theme.stylesheet === slug);
  if (!installed) throw new Error(`Theme installation was not confirmed: ${slug}`);
  output(installed);
});
themes.command('activate <slug>').action(async slug => {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid theme slug.');
  await remoteWp(['theme', 'activate', slug]);
  const active = (await wp().all<ArrayItem>('wp/v2/themes')).find(theme => theme.status === 'active');
  if (active?.stylesheet !== slug) throw new Error(`Theme activation was not confirmed: ${slug}`);
  output(active);
});
const generatepress = themes.command('generatepress');
generatepress.command('get').option('--backend <backend>', 'auto, bridge, or wp-cli', 'auto').action(async options => {
  output(await readGeneratePressConfig(wp(), options.backend as BackendPreference));
});
generatepress.command('set').requiredOption('--file <path>', 'JSON file with GeneratePress fields').option('--backend <backend>', 'auto, bridge, or wp-cli', 'auto').action(async options => {
  output(await writeGeneratePressConfig(wp(), JSON.parse(fs.readFileSync(options.file, 'utf8')), options.backend as BackendPreference));
});

const customCss = program.command('custom-css');
customCss.command('get').option('--backend <backend>', 'auto, bridge, or wp-cli', 'auto').action(async options => {
  output(await readCustomCss(wp(), options.backend as BackendPreference));
});
customCss.command('set').requiredOption('--file <path>', 'CSS file').option('--backend <backend>', 'auto, bridge, or wp-cli', 'auto').action(async options => {
  const client = wp();
  const current = await readCustomCss(client, options.backend as BackendPreference);
  output(await writeCustomCss(client, fs.readFileSync(options.file, 'utf8'), current.hash, options.backend as BackendPreference));
});

const browser = program.command('browser');
browser.command('open <url>').option('--authenticated').action(async (url, options) => output(await render(url, 'artifacts/browser-open.png', 'desktop', !!options.authenticated)));
program.command('screenshot <url>').option('--mobile').option('--desktop').option('--authenticated').action(async (url, options) => {
  const viewport = options.mobile ? 'mobile' : 'desktop';
  output(await render(url, `artifacts/screenshot-${viewport}.png`, viewport, !!options.authenticated));
});
program.command('verify <page-id>').option('--expect-status <status>', 'Expected WordPress status', 'draft').action(async (value, options) => {
  const result = await verifyPage(id(value), options.expectStatus);
  output(result, `${result.ok ? '✓' : '✗'} Page ${value}: ${result.checks.status}\nDesktop: ${result.desktop.screenshot}\nMobile: ${result.mobile.screenshot}\nErrors: ${[...result.desktop.errors, ...result.mobile.errors].join('; ') || 'none'}`);
  if (!result.ok) process.exitCode = 1;
});

program.parseAsync(process.argv).catch(error => {
  if (error?.code === 'commander.helpDisplayed') return;
  const message = (error instanceof Error ? error.message : String(error)).replace(/^error:\s*/i, '');
  const data = { ok: false, error: { code: error instanceof WpError ? error.code : error?.code || 'command_error', status: error instanceof WpError ? error.status : undefined, message } };
  console.error(program.opts().json || process.argv.includes('--json') ? JSON.stringify(data) : `Error: ${data.error.message}`);
  process.exitCode = 1;
});
