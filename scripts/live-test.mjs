import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { blockTree } from '../dist/blocks.js';

function run(...args) {
  return JSON.parse(execFileSync(process.execPath, ['dist/cli.js', ...args, '--json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
}

const status = run('status');
const inspect = run('inspect');
const pages = run('pages', 'list');
const source = pages.find(page => {
  const blocks = blockTree(page.content);
  return blocks.length >= 6 && blocks.some(block => block.name === 'core/heading') && blocks.some(block => block.name === 'core/paragraph') && !page.title.startsWith('WP Agent Live Test');
});
if (!source) throw new Error('No existing Gutenberg page with a non-trivial layout and headings was found.');
const sourceBlocks = run('blocks', 'list', String(source.id));
const original = run('pages', 'preview', String(source.id));
const media = run('media', 'list');
const clone = run('pages', 'clone', String(source.id), '--title', `WP Agent Live Test ${new Date().toISOString()}`);
const pageId = clone.page.id;
const heading = sourceBlocks.find(block => block.name === 'core/heading' && block.text);
const paragraph = sourceBlocks.find(block => block.name === 'core/paragraph' && block.text);
if (!heading || !paragraph) throw new Error('Source page lacks editable heading or paragraph text.');
run('content', 'replace', String(pageId), '--from', heading.text, '--to', 'A verified new heading');
run('content', 'replace', String(pageId), '--from', paragraph.text, '--to', 'This paragraph was safely changed by wp-agent.');
const final = run('verify', String(pageId));
const after = run('pages', 'get', String(pageId));
const finalBlocks = run('blocks', 'list', String(pageId));
const sameStructure = JSON.stringify(sourceBlocks.map(block => [block.path, block.name, block.attributes])) === JSON.stringify(finalBlocks.map(block => [block.path, block.name, block.attributes]));
if (!final.ok || !sameStructure || !after.content.includes('A verified new heading') || !after.content.includes('This paragraph was safely changed')) throw new Error(`Page verification failed for ${pageId}`);

const installed = run('plugins', 'list').find(plugin => plugin.plugin === 'hello-dolly/hello');
if (installed?.status === 'active') run('plugins', 'deactivate', 'hello-dolly');
if (installed) run('plugins', 'remove', 'hello-dolly', '--yes');
const pluginInstalled = run('plugins', 'install', 'hello-dolly');
const pluginActive = run('plugins', 'activate', 'hello-dolly');
const pluginInactive = run('plugins', 'deactivate', 'hello-dolly');
if (pluginInstalled.status !== 'inactive' || pluginActive.status !== 'active' || pluginInactive.status !== 'inactive') throw new Error('Plugin lifecycle verification failed.');

const report = {
  site: status.url, version: inspect.version, sourcePageId: source.id, pageId,
  previewUrl: final.previewUrl, sourceBlocks, sameStructure,
  selectedMedia: media.filter(item => after.content.includes(`wp-image-${item.id}`)).map(item => ({ id: item.id, url: item.source_url })),
  originalScreenshot: original.screenshot, desktopScreenshot: final.desktop.screenshot, mobileScreenshot: final.mobile.screenshot,
  verification: final.checks,
  plugin: { plugin: pluginInactive.plugin, installed: pluginInstalled.status, activated: pluginActive.status, final: pluginInactive.status },
};
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/live-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
