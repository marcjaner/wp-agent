import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Page as WpPage } from './wordpress.js';

export type RenderResult = {
  url: string;
  finalUrl: string;
  title: string;
  status: number | null;
  screenshot: string;
  errors: string[];
  viewport: 'desktop' | 'mobile';
};

export interface BrowserDriver {
  render(url: string, viewport: 'desktop' | 'mobile', screenshot: string, authenticated?: boolean): Promise<RenderResult>;
  close(): Promise<void>;
}

export function previewUrl(page: WpPage, siteUrl: string): string {
  const url = new URL('/', siteUrl);
  url.searchParams.set('page_id', String(page.id));
  url.searchParams.set('preview', 'true');
  return url.toString();
}

export class PlaywrightDriver implements BrowserDriver {
  private browser?: Browser;
  private context?: BrowserContext;

  constructor(private siteUrl: string) {}

  private async getContext(viewport: 'desktop' | 'mobile'): Promise<BrowserContext> {
    this.browser ??= await chromium.launch({ headless: true });
    return this.browser.newContext({
      viewport: viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      isMobile: viewport === 'mobile',
    });
  }

  private async login(page: Page): Promise<void> {
    const user = process.env.WP_USER;
    const password = process.env.WP_PASSWORD;
    if (!user || !password) throw new Error('Draft preview requires WP_USER and WP_PASSWORD for browser login.');
    await page.goto(new URL('wp-login.php', this.siteUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.locator('#user_login').fill(user);
    await page.locator('#user_pass').fill(password);
    await Promise.all([
      page.waitForURL(url => !url.pathname.includes('wp-login.php'), { timeout: 30000 }),
      page.locator('#wp-submit').click(),
    ]).catch(() => { throw new Error('WordPress browser login failed. Check WP_USER and WP_PASSWORD.'); });
  }

  async render(url: string, viewport: 'desktop' | 'mobile', screenshot: string, authenticated = false): Promise<RenderResult> {
    const context = await this.getContext(viewport);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      if (authenticated) await this.login(page);
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const html = await page.locator('body').innerText();
      if (/There has been a critical error on this website|Fatal error:|Error establishing a database connection/i.test(html)) errors.push('Fatal WordPress error rendered');
      if (authenticated) await page.addStyleTag({ content: '#wpadminbar { display: none !important; } html { margin-top: 0 !important; }' });
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      await page.screenshot({ path: screenshot, fullPage: true });
      return { url, finalUrl: page.url(), title: await page.title(), status: response?.status() ?? null, screenshot: path.resolve(screenshot), errors, viewport };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> { await this.browser?.close(); }
}
