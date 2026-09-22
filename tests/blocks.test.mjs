import assert from 'node:assert/strict';
import test from 'node:test';
import { blockTree, replaceText } from '../dist/blocks.js';

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
