import { BridgeClient } from '../bridge.js';
import { resolveBackend, saveCapabilitySnapshot, type BackendPreference } from '../capabilities.js';
import { WordPress } from '../wordpress.js';
import { remoteWp } from '../wpcli.js';
import { executeMutation } from '../policy.js';
import type { Adapter } from './registry.js';

export type GeneratePressConfig = {
  containerWidth: number;
  headerLayout: string;
  headerInnerWidth: string;
  navigationLayout: string;
  navigationPosition: string;
  contentLayout: string;
  sidebarLayout: string;
  footerWidgets: number;
  backgroundColor: string;
  textColor: string;
};

const settingNames: Record<keyof GeneratePressConfig, string> = {
  containerWidth: 'container_width',
  headerLayout: 'header_layout_setting',
  headerInnerWidth: 'header_inner_width',
  navigationLayout: 'nav_layout_setting',
  navigationPosition: 'nav_position_setting',
  contentLayout: 'content_layout_setting',
  sidebarLayout: 'layout_setting',
  footerWidgets: 'footer_widget_setting',
  backgroundColor: 'background_color',
  textColor: 'text_color',
};

const choices: Partial<Record<keyof GeneratePressConfig, string[]>> = {
  headerLayout: ['fluid-header', 'contained-header'],
  headerInnerWidth: ['full-width', 'contained'],
  navigationLayout: ['fluid-nav', 'contained-nav'],
  navigationPosition: ['nav-below-header', 'nav-above-header', 'nav-float-right', 'nav-float-left', 'nav-left-sidebar', 'nav-right-sidebar', ''],
  contentLayout: ['separate-containers', 'one-container'],
  sidebarLayout: ['left-sidebar', 'right-sidebar', 'no-sidebar', 'both-sidebars', 'both-left', 'both-right'],
};

function validateConfig(changes: Partial<GeneratePressConfig>): void {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new Error('Provide GeneratePress configuration fields.');
  for (const [field, value] of Object.entries(changes)) {
    if (!(field in settingNames)) throw new Error(`Unsupported GeneratePress field: ${field}`);
    if (field === 'containerWidth' && !(Number.isInteger(value) && Number(value) >= 300 && Number(value) <= 2000)) throw new Error('containerWidth must be an integer from 300 to 2000.');
    if (field === 'footerWidgets' && !(Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 5)) throw new Error('footerWidgets must be an integer from 0 to 5.');
    if ((field === 'backgroundColor' || field === 'textColor') && !(typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value))) throw new Error(`${field} must be a six-digit hex color.`);
    const allowed = choices[field as keyof GeneratePressConfig];
    if (allowed && !allowed.includes(value as string)) throw new Error(`Invalid GeneratePress ${field}.`);
  }
}

async function ensureGeneratePress(client: WordPress): Promise<void> {
  const themes = await client.all<{ status: string; template: string }>('wp/v2/themes?context=edit');
  if (!generatePressAdapter.detect({ activeTheme: themes.find(theme => theme.status === 'active'), activePlugins: [], registeredBlocks: [] })) throw new Error('The active theme is not GeneratePress.');
}

export async function readGeneratePressConfig(client: WordPress, preference: BackendPreference = 'auto') {
  await ensureGeneratePress(client);
  const backend = await resolveBackend(client, preference);
  let raw: Record<string, unknown>;
  if (backend === 'bridge') {
    const ids = Object.values(settingNames).map(name => `generate_settings[${name}]`);
    const result = await new BridgeClient(client).readSettings(ids);
    raw = Object.fromEntries(Object.entries(settingNames).map(([, name]) => [name, result.settings[`generate_settings[${name}]`]]));
  } else {
    raw = JSON.parse(await remoteWp(['option', 'get', 'generate_settings', '--format=json']));
  }
  const config = Object.fromEntries(Object.entries(settingNames).map(([field, name]) => [field, field === 'containerWidth' || field === 'footerWidgets' ? Number(raw[name]) : raw[name]])) as GeneratePressConfig;
  return { backend, config };
}

export async function writeGeneratePressConfig(client: WordPress, changes: Partial<GeneratePressConfig>, preference: BackendPreference = 'auto') {
  validateConfig(changes);
  const before = await readGeneratePressConfig(client, preference);
  let snapshot = '';
  return executeMutation({ tool: 'theme.config.set', category: 'site_config', mutation: true, target: { type: 'theme', id: 'generatepress' }, intent: { changes: Object.keys(changes) }, reversible: 'reversible', input: { fields: Object.keys(changes) } }, async () => {
    snapshot ||= saveCapabilitySnapshot('generatepress', before);
    if (before.backend === 'bridge') {
      const values = Object.fromEntries(Object.entries(changes).map(([field, value]) => [`generate_settings[${settingNames[field as keyof GeneratePressConfig]}]`, value]));
      await new BridgeClient(client).writeSettings(values);
    } else {
      for (const [field, value] of Object.entries(changes)) {
        await remoteWp(['option', 'patch', 'update', 'generate_settings', settingNames[field as keyof GeneratePressConfig], String(value)]);
      }
    }
    const after = await readGeneratePressConfig(client, before.backend);
    for (const [field, value] of Object.entries(changes)) {
      if (after.config[field as keyof GeneratePressConfig] !== value) throw new Error(`GeneratePress did not retain ${field}.`);
    }
    return { ...after, snapshot };
  }, { site: client.url, snapshot: () => snapshot = saveCapabilitySnapshot('generatepress', before) });
}

export const generatePressAdapter: Adapter = {
  id: 'generatepress',
  detect: installation => installation.activeTheme?.template === 'generatepress',
  capabilities: [{ id: 'theme.config', implementation: { read: readGeneratePressConfig, write: writeGeneratePressConfig } }],
};
