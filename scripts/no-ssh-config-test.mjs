import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BridgeClient } from '../dist/bridge.js';
import { readCustomCss, writeCustomCss } from '../dist/capabilities.js';
import { readGeneratePressConfig, writeGeneratePressConfig } from '../dist/adapters/generatepress.js';
import { WordPress } from '../dist/wordpress.js';

for (const name of ['WP_SSH_HOST', 'WP_SSH_USER', 'WP_SSH_KEY_PATH', 'WP_PATH']) {
  assert.equal(process.env[name], '', `${name} must be explicitly disabled for this test`);
}

const client = new WordPress();
const bridge = new BridgeClient(client);
const manifest = await bridge.require();
const before = await readGeneratePressConfig(client);
const originalCss = await readCustomCss(client);
const originalLogo = (await bridge.readSettings(['custom_logo'])).settings.custom_logo;
assert.equal(before.backend, 'bridge');
assert.equal(originalCss.backend, 'bridge');

const alternate = {
  containerWidth: 1180,
  headerLayout: 'contained-header',
  headerInnerWidth: 'contained',
  navigationLayout: 'contained-nav',
  navigationPosition: 'nav-below-header',
  contentLayout: 'separate-containers',
  sidebarLayout: 'right-sidebar',
  footerWidgets: 1,
  backgroundColor: '#fefefe',
  textColor: '#454b6e',
};
const report = { sshDisabled: true, bridge: manifest, backend: 'bridge', themeFields: Object.keys(alternate), logo: false, css: false, restored: false };
try {
  const changed = await writeGeneratePressConfig(client, alternate);
  assert.deepEqual(changed.config, alternate);
  await bridge.writeSettings({ custom_logo: 0 });
  assert.equal(Number((await bridge.readSettings(['custom_logo'])).settings.custom_logo), 0);
  report.logo = true;
  const css = await writeCustomCss(client, `${originalCss.css}\n/* no-ssh bridge probe */\n`, originalCss.hash);
  assert.ok(css.state.css.endsWith('/* no-ssh bridge probe */\n'));
  report.css = true;
} finally {
  await writeGeneratePressConfig(client, before.config);
  await bridge.writeSettings({ custom_logo: originalLogo });
  const currentCss = await readCustomCss(client);
  if (currentCss.hash !== originalCss.hash) await writeCustomCss(client, originalCss.css, currentCss.hash);
  report.restored = true;
}
assert.deepEqual((await readGeneratePressConfig(client)).config, before.config);
assert.equal(Number((await bridge.readSettings(['custom_logo'])).settings.custom_logo), Number(originalLogo));
assert.equal((await readCustomCss(client)).hash, originalCss.hash);
fs.writeFileSync('artifacts/no-ssh-config-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
