import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PlaywrightDriver } from '../dist/browser.js';

const html = '<main><section class="prefix-id-abc">Unique ID</section><section id="anchor-one">Anchor</section><div class="only-this">Class</div><p>Unmapped</p></main>';
const content = `<!-- wp:group {"uniqueId":"id-abc"} --><div>Unique ID</div><!-- /wp:group -->
<!-- wp:group {"anchor":"anchor-one"} --><div>Anchor</div><!-- /wp:group -->
<!-- wp:group {"className":"only-this"} --><div>Class</div><!-- /wp:group -->
<!-- wp:paragraph --><p>Unmapped</p><!-- /wp:paragraph -->`;
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const driver = new PlaywrightDriver(url);
try {
  const result = await driver.mapBlocks({ id: 1, status: 'publish', link: url, content: { raw: content } });
  assert.deepEqual(result.blocks.map(block => block.match), ['uniqueId', 'anchor', 'className', null]);
  assert.ok(result.blocks.slice(0, 3).every(block => block.bounds && block.text));
  console.log('PASS rendered block mapping: unique ID, anchor, unique class, and explicit unmatched result');
} finally {
  await driver.close();
  server.close();
}
