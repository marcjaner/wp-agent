import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { executeMutation, hashPayload, insidePolicyExecution } from './policy.js';

dotenv.config({ quiet: true });

export type Page = {
  id: number;
  status: string;
  slug: string;
  link: string;
  template: string;
  parent: number;
  featured_media: number;
  menu_order: number;
  comment_status: string;
  excerpt?: { raw?: string; rendered: string };
  modified: string;
  title: { raw?: string; rendered: string };
  content: { raw?: string; rendered: string };
  meta: Record<string, unknown>;
};

export class WpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'WpError';
  }
}

export function siteUrl(): string {
  const config = path.resolve('.wp-agent/config.json');
  const saved = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')).url : undefined;
  const url = saved || process.env.WP_URL;
  if (!url) throw new Error('Site URL missing. Run wp-agent connect <url> or set WP_URL.');
  return new URL(url).toString();
}

export function saveSiteUrl(url: string): void {
  const normalized = new URL(url);
  if (!['https:', 'http:'].includes(normalized.protocol)) throw new Error('Expected an HTTP(S) WordPress URL.');
  if (normalized.username || normalized.password) throw new Error('Do not put credentials in the site URL.');
  fs.mkdirSync('.wp-agent', { recursive: true });
  fs.writeFileSync('.wp-agent/config.json', JSON.stringify({ url: normalized.toString() }, null, 2) + '\n', { mode: 0o600 });
}

export class WordPress {
  constructor(public url = siteUrl(), private credentials?: { user: string; appPassword: string }) {}

  private authorization(): string {
    const user = this.credentials?.user || process.env.WP_USER;
    const password = this.credentials?.appPassword || process.env.WP_APP_PASSWORD;
    if (!user || !password) throw new Error('Set WP_USER and WP_APP_PASSWORD in .env or the environment.');
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !insidePolicyExecution()) {
      const body = init.body;
      const fingerprintableBody = body === undefined || typeof body === 'string' || body instanceof URLSearchParams;
      return executeMutation({ tool: 'rest.raw', category: 'raw', mutation: true, target: { type: 'rest-route', id: route.split('?')[0] }, reversible: 'partial', input: { method, route: route.split('?')[0], routeHash: hashPayload(route), bodyHash: fingerprintableBody ? hashPayload(body?.toString()) : undefined, agentApprovalUnsupported: !fingerprintableBody } }, () => this.request<T>(route, init), { site: this.url, interactive: !process.argv.includes('--json') });
    }
    const url = new URL(`wp-json/${route.replace(/^\//, '')}`, this.url);
    const headers = new Headers(init.headers);
    headers.set('Authorization', this.authorization());
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      throw new WpError(0, 'network_error', error instanceof Error ? error.message : String(error));
    }
    const data = await response.json().catch(() => null) as T & { code?: string; message?: string };
    if (!response.ok) throw new WpError(response.status, data?.code || 'http_error', data?.message || `HTTP ${response.status}`);
    return data;
  }

  get<T>(route: string): Promise<T> { return this.request<T>(route); }
  post<T>(route: string, body: unknown): Promise<T> { return this.request<T>(route, { method: 'POST', body: JSON.stringify(body) }); }
  delete<T>(route: string): Promise<T> { return this.request<T>(route, { method: 'DELETE' }); }

  async all<T>(route: string): Promise<T[]> {
    const output: T[] = [];
    for (let page = 1; ; page++) {
      const separator = route.includes('?') ? '&' : '?';
      let batch: T[];
      try { batch = await this.get<T[]>(`${route}${separator}per_page=100&page=${page}`); }
      catch (error) {
        if (page > 1 && error instanceof WpError && error.code === 'rest_post_invalid_page_number') return output;
        throw error;
      }
      output.push(...batch);
      if (batch.length < 100) return output;
    }
  }

  page(id: number): Promise<Page> { return this.get<Page>(`wp/v2/pages/${id}?context=edit`); }

  async snapshot(page: Page): Promise<string> {
    const dir = path.resolve('.wp-agent/snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, `page-${page.id}-${Date.now()}.json`);
    fs.writeFileSync(filename, JSON.stringify(page, null, 2), { mode: 0o600 });
    return filename;
  }
}

export function pageSummary(page: Page) {
  return {
    id: page.id, title: page.title.raw ?? page.title.rendered, slug: page.slug,
    status: page.status, url: page.link, template: page.template,
    parent: page.parent, featuredMedia: page.featured_media, menuOrder: page.menu_order,
    modified: page.modified, content: page.content.raw ?? page.content.rendered,
    meta: page.meta,
  };
}
