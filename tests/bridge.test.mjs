import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeClient } from '../dist/bridge.js';
import { WpError } from '../dist/wordpress.js';

test('bridge discovery accepts a compatible version', async () => {
  const client = new BridgeClient({ get: async () => ({ bridgeVersion: '0.1.2', capabilities: ['customCss.read'] }) });
  assert.deepEqual(await client.discover(), { bridgeVersion: '0.1.2', capabilities: ['customCss.read'] });
});

test('bridge discovery treats a missing route as unavailable', async () => {
  const client = new BridgeClient({ get: async () => { throw new WpError(404, 'rest_no_route', 'Missing'); } });
  assert.equal(await client.discover(), null);
});

test('bridge discovery rejects an incompatible version clearly', async () => {
  const client = new BridgeClient({ get: async () => ({ bridgeVersion: '1.0.0', capabilities: [] }) });
  await assert.rejects(client.discover(), /Incompatible wp-agent Bridge version: 1\.0\.0/);
});

test('bridge rejects a missing capability before calling its endpoint', async () => {
  const client = new BridgeClient({ get: async () => ({ bridgeVersion: '0.1.0', capabilities: [] }) });
  await assert.rejects(client.readCss(), /does not provide customCss.read/);
});
