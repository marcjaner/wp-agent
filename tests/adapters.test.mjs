import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtInAdapters, capabilityImplementations, describeAdapters, detectAdapters } from '../dist/adapters/registry.js';
import { generatePressAdapter } from '../dist/adapters/generatepress.js';
import { generateBlocksAdapter, generateBlocksClassNames, generateBlocksStyleSummary, setAccordionDefaultOpen } from '../dist/adapters/generateblocks.js';
import { blockTree, copyBlock } from '../dist/blocks.js';
import { clonePage } from '../dist/pages.js';

const installation = {
  activeTheme: { template: 'generatepress', stylesheet: 'generatepress' },
  activePlugins: [{ plugin: 'generateblocks/plugin.php', status: 'active' }],
  registeredBlocks: ['core/paragraph', 'generateblocks/element'],
};

test('registry detects adapters and reports their semantic capabilities', () => {
  assert.deepEqual(describeAdapters(detectAdapters(installation)), [
    { id: 'generatepress', capabilities: ['theme.config'] },
    { id: 'generateblocks', capabilities: ['block.renderedClassHint', 'block.styleSummary'] },
  ]);
  const [config] = capabilityImplementations(detectAdapters(installation), 'theme.config');
  assert.equal(typeof config.read, 'function');
  assert.equal(typeof config.write, 'function');
  assert.deepEqual(generateBlocksClassNames({ name: 'generateblocks/element', attributes: { uniqueId: 'abc' } }), ['gb-element-abc']);
  assert.deepEqual(generateBlocksClassNames({ name: 'core/group', attributes: { uniqueId: 'abc' } }), []);
});

test('disabling GeneratePress leaves generic Gutenberg and page cloning available', async () => {
  assert.deepEqual(describeAdapters(detectAdapters(installation, [generateBlocksAdapter])), [
    { id: 'generateblocks', capabilities: ['block.renderedClassHint', 'block.styleSummary'] },
  ]);
  const content = '<!-- wp:paragraph --><p>Original</p><!-- /wp:paragraph -->';
  const source = { id: 1, title: { raw: 'Source' }, content: { raw: content }, template: '', parent: 0, featured_media: 0, menu_order: 0, comment_status: 'open', meta: {} };
  const client = {
    url: 'https://example.test/',
    page: async id => id === 1 ? source : { ...source, id: 2 },
    post: async (_route, body) => ({ ...source, id: 2, content: { raw: body.content } }),
  };
  const previousFile = process.env.WP_AGENT_SESSION_FILE;
  process.env.WP_AGENT_SESSION_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agent-adapter-')), 'session.json');
  let clone;
  try { ({ clone } = await clonePage(client, 1)); }
  finally {
    if (previousFile === undefined) delete process.env.WP_AGENT_SESSION_FILE;
    else process.env.WP_AGENT_SESSION_FILE = previousFile;
  }
  assert.equal(clone.content.raw, content);
  assert.equal(blockTree(clone.content.raw)[0].name, 'core/paragraph');
});

test('disabling GenerateBlocks preserves its unknown attributes and serialized subtree', () => {
  assert.deepEqual(describeAdapters(detectAdapters(installation, [generatePressAdapter])), [
    { id: 'generatepress', capabilities: ['theme.config'] },
  ]);
  const source = '<!-- wp:generateblocks/element {"uniqueId":"abc","futureField":{"nested":true}} --><div class="gb-element-abc">Text</div><!-- /wp:generateblocks/element -->';
  const copied = copyBlock(source, '0', '');
  assert.ok(copied.includes(source));
  assert.deepEqual(blockTree(copied)[0].attributes.futureField, { nested: true });
});

test('a third fixture adapter can expose a capability unrelated to themes or blocks', () => {
  const mediaAdapter = {
    id: 'fixture-media',
    detect: site => site.activePlugins.some(plugin => plugin.plugin === 'media-fixture/plugin.php'),
    capabilities: [{ id: 'media.altText', implementation: { summarize: value => value.trim() } }],
  };
  const site = { activeTheme: { template: 'twentytwentyfive' }, activePlugins: [{ plugin: 'media-fixture/plugin.php', status: 'active' }], registeredBlocks: [] };
  const detected = detectAdapters(site, [...builtInAdapters, mediaAdapter]);
  assert.deepEqual(describeAdapters(detected), [{ id: 'fixture-media', capabilities: ['media.altText'] }]);
  assert.equal(capabilityImplementations(detected, 'media.altText')[0].summarize('  photo  '), 'photo');
});

test('GenerateBlocks summarizes responsive styles and shared classes without changing content', () => {
  const content = '<!-- wp:generateblocks/element {"uniqueId":"grid","styles":{"display":"grid","@media (max-width: 767px)":{"gridTemplateColumns":"1fr"}},"globalClasses":["shared-card"],"css":".gb-element-grid{display:grid}"} --><section class="gb-element-grid shared-card"></section><!-- /wp:generateblocks/element -->';
  const summary = generateBlocksStyleSummary(content, '0');
  assert.deepEqual(summary.baseStyles, { display: 'grid' });
  assert.deepEqual(summary.responsiveStyles, { '@media (max-width: 767px)': { gridTemplateColumns: '1fr' } });
  assert.deepEqual(summary.globalClasses, ['shared-card']);
  assert.equal(summary.css, '.gb-element-grid{display:grid}');
  assert.match(content, /"uniqueId":"grid"/);
});

test('Pro accordion mutation is available only with Pro and preserves unknown attributes and markup', () => {
  const proInstallation = { ...installation, activePlugins: [...installation.activePlugins, { plugin: 'generateblocks-pro/plugin.php', status: 'active' }] };
  assert.deepEqual(capabilityImplementations(detectAdapters(installation), 'accordion.defaultOpen'), []);
  assert.deepEqual(describeAdapters(detectAdapters(proInstallation))[1].capabilities, ['block.renderedClassHint', 'block.styleSummary', 'accordion.defaultOpen']);
  assert.equal(capabilityImplementations(detectAdapters(proInstallation), 'accordion.defaultOpen')[0], setAccordionDefaultOpen);
  const content = '<!-- wp:generateblocks-pro/accordion-item {"uniqueId":"item","futureField":{"keep":true}} --><div class="gb-accordion__item">Answer</div><!-- /wp:generateblocks-pro/accordion-item -->';
  const updated = setAccordionDefaultOpen(content, '0', true);
  assert.equal(blockTree(updated)[0].attributes.openByDefault, true);
  assert.deepEqual(blockTree(updated)[0].attributes.futureField, { keep: true });
  assert.ok(updated.includes('<div class="gb-accordion__item gb-accordion__item-open">Answer</div>'));
  assert.ok(setAccordionDefaultOpen(updated, '0', false).includes('<div class="gb-accordion__item">Answer</div>'));
  assert.throws(() => setAccordionDefaultOpen(content, '0', 'yes'), /boolean/);
});
