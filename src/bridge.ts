import { WordPress, WpError } from './wordpress.js';

export type BridgeInfo = { bridgeVersion: string; capabilities: string[] };
export type CssState = { stylesheet: string; css: string; hash: string; postId: number | null };
export type ThemeSettings = { stylesheet: string; settings: Record<string, string | number | boolean> };

export class BridgeClient {
  constructor(private wp: WordPress) {}

  async discover(): Promise<BridgeInfo | null> {
    let info: BridgeInfo;
    try { info = await this.wp.get<BridgeInfo>('wp-agent/v1/manifest'); }
    catch (error) {
      if (error instanceof WpError && error.status === 404) return null;
      throw error;
    }
    if (!/^0\.1\.\d+$/.test(info?.bridgeVersion) || !Array.isArray(info.capabilities)) {
      throw new Error(`Incompatible wp-agent Bridge version: ${info?.bridgeVersion ?? 'unknown'}. CLI supports 0.1.x.`);
    }
    return info;
  }

  async require(): Promise<BridgeInfo> {
    const info = await this.discover();
    if (!info) throw new Error('wp-agent Bridge is not installed or active on this site.');
    return info;
  }

  async requireCapability(capability: string): Promise<void> {
    const info = await this.require();
    if (!info.capabilities.includes(capability)) throw new Error(`wp-agent Bridge ${info.bridgeVersion} does not provide ${capability}.`);
  }

  async readSettings(ids: string[]): Promise<ThemeSettings> {
    await this.requireCapability('theme.customizerSettings.read');
    const query = new URLSearchParams();
    for (const id of ids) query.append('ids[]', id);
    return this.wp.get<ThemeSettings>(`wp-agent/v1/theme-settings?${query}`);
  }

  async writeSettings(settings: ThemeSettings['settings']): Promise<ThemeSettings> {
    await this.requireCapability('theme.customizerSettings.write');
    return this.wp.post<ThemeSettings>('wp-agent/v1/theme-settings', { settings });
  }

  async readCss(): Promise<CssState> {
    await this.requireCapability('customCss.read');
    return this.wp.get<CssState>('wp-agent/v1/custom-css');
  }

  async writeCss(css: string, expectedHash: string): Promise<CssState> {
    await this.requireCapability('customCss.write');
    return this.wp.post<CssState>('wp-agent/v1/custom-css', { css, expectedHash });
  }
}
