import assert from 'node:assert/strict';
import test from 'node:test';
import { blockTree, copyBlock, removeBlock, replaceImageBlock, replaceText } from '../dist/blocks.js';

const content = `<!-- wp:group {"className":"layout"} -->
<div class="wp-block-group layout">
<!-- wp:heading -->
<h2>Old heading</h2>
<!-- /wp:heading -->
<!-- wp:generateblocks/text {"uniqueId":"demo","content":"Old heading","styles":{"color":"red"}} -->
<p class="gb-text">Old heading and Old heading</p>
<!-- /wp:generateblocks/text -->
</div>
<!-- /wp:group -->`;

test('nested Gutenberg and third-party blocks have stable paths', () => {
  assert.deepEqual(blockTree(content).map(block => `${block.path} ${block.name}`), [
    '0 core/group', '0.0 core/heading', '0.1 generateblocks/text',
  ]);
});

test('text replacement preserves block attributes and markup', () => {
  const result = replaceText(content, 'Old heading', 'New <heading>');
  assert.equal(result.count, 3);
  assert.match(result.content, /"content":"Old heading"/);
  assert.match(result.content, /"styles":\{"color":"red"\}/);
  assert.match(result.content, /<h2>New &lt;heading&gt;<\/h2>/);
  assert.match(result.content, /<p class="gb-text">New &lt;heading&gt; and New &lt;heading&gt;<\/p>/);
});

test('copies a third-party section between pages without changing its serialization', () => {
  const source = `<!-- wp:generateblocks/element {"uniqueId":"section-a","tagName":"section"} -->\n<section class="gb-element-section-a">\n<!-- wp:paragraph -->\n<p>Ride Mallorca</p>\n<!-- /wp:paragraph -->\n</section>\n<!-- /wp:generateblocks/element -->`;
  const target = `<!-- wp:heading -->\n<h2>Start</h2>\n<!-- /wp:heading -->\n\n<!-- wp:block {"ref":45} /-->`;
  const result = copyBlock(source, '0', target, '0');
  assert.ok(result.includes(source));
  assert.deepEqual(blockTree(result).map(block => block.name), ['core/heading', 'generateblocks/element', 'core/paragraph', 'core/block']);
  assert.ok(result.indexOf(source) < result.indexOf('<!-- wp:block'));
});

test('inserts a section beside a nested block within its parent', () => {
  const source = '<!-- wp:generateblocks/element {"uniqueId":"other","tagName":"section"} -->\n<section class="gb-element-other"></section>\n<!-- /wp:generateblocks/element -->';
  const target = '<!-- wp:group -->\n<div class="wp-block-group">\n<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->\n</div>\n<!-- /wp:group -->';
  const result = copyBlock(source, '0', target, '0.0');
  assert.deepEqual(blockTree(result).map(block => block.path), ['0', '0.0', '0.1']);
  assert.ok(result.indexOf(source) < result.indexOf('</div>'));
});

test('rejects duplicate third-party block IDs on the target page', () => {
  const section = '<!-- wp:generateblocks/element {"uniqueId":"repeat"} -->\n<div></div>\n<!-- /wp:generateblocks/element -->';
  assert.throws(() => copyBlock(section, '0', section), /uniqueId already exists/);
});

test('removes one nested block while preserving its parent and siblings', () => {
  const updated = removeBlock(content, '0.0');
  assert.deepEqual(blockTree(updated).map(block => block.name), ['core/group', 'generateblocks/text']);
  assert.match(updated, /"styles":\{"color":"red"\}/);
});

test('replaces a core image without losing unknown block attributes', () => {
  const source = '<!-- wp:image {"id":12,"sizeSlug":"full","linkDestination":"none","customFlag":"keep"} -->\n<figure class="wp-block-image size-full"><img src="https://old.example/old.jpg" alt="Old" class="wp-image-12 extra"/></figure>\n<!-- /wp:image -->';
  const updated = replaceImageBlock(source, '0', { id: 27, url: 'https://new.example/new.jpg', alt: 'New & bright' });
  assert.equal(blockTree(updated)[0].attributes.customFlag, 'keep');
  assert.match(updated, /"id":27/);
  assert.match(updated, /src="https:\/\/new.example\/new.jpg"/);
  assert.match(updated, /alt="New &amp; bright"/);
  assert.match(updated, /class="extra wp-image-27"/);
  assert.doesNotMatch(updated, /wp-image-12/);
});
