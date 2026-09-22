import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeClient, type CssState } from './bridge.js';
import { WordPress } from './wordpress.js';
import { remoteWp } from './wpcli.js';

export type BackendPreference = 'auto' | 'bridge' | 'wp-cli';
export type Backend = 'bridge' | 'wp-cli';

export async function resolveBackend(client: WordPress, preference: BackendPreference = 'auto'): Promise<Backend> {
  if (!['auto', 'bridge', 'wp-cli'].includes(preference)) throw new Error(`Unknown backend: ${preference}`);
  const hasSsh = !!(process.env.WP_SSH_HOST && process.env.WP_SSH_USER && process.env.WP_SSH_KEY_PATH && process.env.WP_PATH);
  if (preference === 'wp-cli') {
    if (!hasSsh) throw new Error('WP-CLI backend unavailable: SSH configuration is incomplete.');
    return 'wp-cli';
  }
  if (preference === 'bridge') {
    await new BridgeClient(client).require();
    return 'bridge';
  }
  if (hasSsh && await remoteWp(['core', 'version']).then(() => true).catch(() => false)) return 'wp-cli';
  if (await new BridgeClient(client).discover()) return 'bridge';
  throw new Error('Capability unavailable: install wp-agent Bridge or configure optional SSH/WP-CLI.');
}

export function saveCapabilitySnapshot(name: string, value: unknown): string {
  const dir = path.resolve('.wp-agent/snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return file;
}

export async function readCustomCss(client: WordPress, preference: BackendPreference = 'auto'): Promise<CssState & { backend: Backend }> {
  const backend = await resolveBackend(client, preference);
  if (backend === 'bridge') return { ...await new BridgeClient(client).readCss(), backend };
  const [stylesheet, encoded, postIdText] = await Promise.all([
    remoteWp(['eval', 'echo get_stylesheet();']),
    remoteWp(['eval', '$p = wp_get_custom_css_post(); echo base64_encode($p ? $p->post_content : "");']),
    remoteWp(['eval', '$p = wp_get_custom_css_post(); echo $p ? $p->ID : "";']),
  ]);
  const css = Buffer.from(encoded, 'base64').toString('utf8');
  return { stylesheet, css, hash: createHash('sha256').update(css).digest('hex'), postId: postIdText ? Number(postIdText) : null, backend };
}

export async function writeCustomCss(client: WordPress, css: string, expectedHash: string, preference: BackendPreference = 'auto') {
  const current = await readCustomCss(client, preference);
  if (current.hash !== expectedHash) throw new Error('Custom CSS changed since it was read.');
  const snapshot = saveCapabilitySnapshot('custom-css', current);
  if (current.backend === 'bridge') {
    const state = await new BridgeClient(client).writeCss(css, expectedHash);
    if (state.css !== css) throw new Error('WordPress did not retain the requested CSS.');
    return { state, backend: current.backend, snapshot };
  }
  const encoded = Buffer.from(css).toString('base64');
  await remoteWp(['eval', `wp_update_custom_css_post(base64_decode('${encoded}'));`]);
  const state = await readCustomCss(client, 'wp-cli');
  if (state.css !== css) throw new Error('WordPress did not retain the requested CSS.');
  return { state, backend: current.backend, snapshot };
}
