import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BridgeClient } from '../dist/bridge.js';
import { WordPress, WpError } from '../dist/wordpress.js';
import { remoteWp } from '../dist/wpcli.js';

const admin = new WordPress();
const bridge = new BridgeClient(admin);
const id = 'generate_settings[container_width]';
const endpoint = route => new URL(`wp-json/wp-agent/v1/${route}`, admin.url);
const request = (route, options = {}) => fetch(endpoint(route), options);
const failures = [];
const report = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
};

await report('capability discovery', async () => {
  const response = await request('manifest');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.bridgeVersion, /^0\.1\./);
  assert.ok(data.capabilities.includes('customCss.write'));
  assert.deepEqual(await bridge.discover(), data);
});

let originalWidth;
let originalCss;
await report('authenticated reads', async () => {
  originalWidth = (await bridge.readSettings([id])).settings[id];
  originalCss = await bridge.readCss();
  assert.ok(Number(originalWidth) > 0);
  assert.match(originalCss.hash, /^[a-f0-9]{64}$/);
});

await report('anonymous access cannot read or mutate', async () => {
  for (const [route, options] of [
    ['theme-settings?ids%5B%5D=generate_settings%5Bcontainer_width%5D', {}],
    ['custom-css', {}],
    ['theme-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { [id]: 999 } }) }],
    ['custom-css', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ css: 'body{}', expectedHash: originalCss.hash }) }],
  ]) {
    const response = await request(route, options);
    assert.ok(response.status === 401 || response.status === 403, `${route}: ${response.status}`);
    const error = await response.json();
    assert.equal(typeof error.code, 'string');
  }
  assert.equal((await bridge.readSettings([id])).settings[id], originalWidth);
  assert.equal((await bridge.readCss()).hash, originalCss.hash);
});

let userId;
try {
  const username = `wpagent_bridge_${randomBytes(5).toString('hex')}`;
  userId = Number(await remoteWp(['user', 'create', username, `${username}@example.invalid`, '--role=subscriber', '--porcelain']));
  const appPassword = await remoteWp(['user', 'application-password', 'create', String(userId), 'wp-agent-security-test', '--porcelain']);
  const subscriber = new WordPress(admin.url, { user: username, appPassword });
  await report('insufficient permissions cannot read or mutate', async () => {
    for (const [route, body] of [
      ['wp-agent/v1/theme-settings?ids%5B%5D=generate_settings%5Bcontainer_width%5D', undefined],
      ['wp-agent/v1/custom-css', undefined],
      ['wp-agent/v1/theme-settings', { settings: { [id]: 999 } }],
      ['wp-agent/v1/custom-css', { css: 'body{}', expectedHash: originalCss.hash }],
    ]) {
      await assert.rejects(body ? subscriber.post(route, body) : subscriber.get(route), error => error instanceof WpError && error.status === 403);
    }
    assert.equal((await bridge.readSettings([id])).settings[id], originalWidth);
    assert.equal((await bridge.readCss()).hash, originalCss.hash);
  });
} finally {
  if (userId) await remoteWp(['user', 'delete', String(userId), '--yes']);
}

await report('setting allowlist and validation', async () => {
  for (const payload of [
    { settings: { active_plugins: 'x' } },
    { settings: { [id]: ['invalid'] } },
    { settings: { [id]: 'x'.repeat(4097) } },
    { settings: { 'generate_settings[header_inner_width]': 'full' } },
    { settings: {} },
  ]) {
    await assert.rejects(admin.post('wp-agent/v1/theme-settings', payload), error => error instanceof WpError && error.status === 400 || error instanceof WpError && error.status === 404);
  }
  assert.equal((await bridge.readSettings([id])).settings[id], originalWidth);
});

await report('theme setting mutation and restoration', async () => {
  const changed = Number(originalWidth) === 1190 ? 1191 : 1190;
  try {
    await bridge.writeSettings({ [id]: changed });
    assert.equal(Number((await bridge.readSettings([id])).settings[id]), changed);
  } finally {
    await bridge.writeSettings({ [id]: originalWidth });
  }
  assert.equal(Number((await bridge.readSettings([id])).settings[id]), Number(originalWidth));
});

await report('CSS mutation, conflict, and restoration', async () => {
  const probe = `${originalCss.css}\n/* wp-agent security test */\n`;
  try {
    const changed = await bridge.writeCss(probe, originalCss.hash);
    assert.equal(changed.css, probe);
    await assert.rejects(bridge.writeCss('body{}', originalCss.hash), error => error instanceof WpError && error.status === 409);
    await assert.rejects(bridge.writeCss('</style><script>', changed.hash), error => error instanceof WpError && error.status === 400);
  } finally {
    const current = await bridge.readCss();
    if (current.css !== originalCss.css) await bridge.writeCss(originalCss.css, current.hash);
  }
  assert.equal((await bridge.readCss()).hash, originalCss.hash);
});

if (failures.length) process.exitCode = 1;
