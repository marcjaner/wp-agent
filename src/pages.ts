import path from 'node:path';
import { copyBlock, removeBlock, replaceImageBlock, replaceText } from './blocks.js';
import { previewUrl, type BrowserDriver } from './browser.js';
import { WordPress, pageSummary, type Page } from './wordpress.js';

export async function clonePage(client: WordPress, sourceId: number, title?: string): Promise<{ source: Page; clone: Page }> {
  const source = await client.page(sourceId);
  const clone = await client.post<Page>('wp/v2/pages', {
    title: title || `${source.title.raw || source.title.rendered} (Copy)`,
    content: source.content.raw, status: 'draft', template: source.template,
    parent: source.parent, featured_media: source.featured_media,
    menu_order: source.menu_order, comment_status: source.comment_status,
    excerpt: source.excerpt?.raw, meta: source.meta,
  });
  const saved = await client.page(clone.id);
  if (saved.content.raw !== source.content.raw) throw new Error(`Clone ${clone.id} content differed from source ${source.id}.`);
  return { source, clone };
}

export async function replacePageText(client: WordPress, pageId: number, from: string, to: string) {
  const page = await client.page(pageId);
  const { content, count } = replaceText(page.content.raw || '', from, to);
  const snapshot = await client.snapshot(page);
  const updated = await client.post<Page>(`wp/v2/pages/${page.id}`, { content });
  return { page: updated, replacements: count, snapshot };
}

export async function copyPageBlock(client: WordPress, sourceId: number, sourcePath: string, targetId: number, afterPath?: string) {
  const source = await client.page(sourceId);
  const target = await client.page(targetId);
  const content = copyBlock(source.content.raw || '', sourcePath, target.content.raw || '', afterPath);
  const snapshot = await client.snapshot(target);
  const updated = await client.post<Page>(`wp/v2/pages/${targetId}`, { content });
  const saved = await client.page(targetId);
  if (saved.content.raw !== content) throw new Error(`Copied block content differed after saving page ${targetId}.`);
  return { page: updated, snapshot };
}

export async function removePageBlock(client: WordPress, pageId: number, blockPath: string) {
  const page = await client.page(pageId);
  const content = removeBlock(page.content.raw || '', blockPath);
  const snapshot = await client.snapshot(page);
  await client.post<Page>(`wp/v2/pages/${pageId}`, { content });
  const saved = await client.page(pageId);
  if (saved.content.raw !== content) throw new Error(`Page ${pageId} content differed after block removal.`);
  return { page: saved, snapshot };
}

export async function replacePageImage(client: WordPress, pageId: number, blockPath: string, mediaId: number) {
  const [page, media] = await Promise.all([
    client.page(pageId),
    client.get<{ id: number; source_url: string; alt_text: string; mime_type: string; media_details?: { sizes?: Record<string, { source_url: string }> } }>(`wp/v2/media/${mediaId}?context=edit`),
  ]);
  if (!media.mime_type.startsWith('image/')) throw new Error(`Media ${mediaId} is not an image.`);
  const sizes = Object.fromEntries(Object.entries(media.media_details?.sizes || {}).map(([name, value]) => [name, value.source_url]));
  const content = replaceImageBlock(page.content.raw || '', blockPath, { id: media.id, url: media.source_url, alt: media.alt_text || '', sizes });
  const snapshot = await client.snapshot(page);
  await client.post<Page>(`wp/v2/pages/${pageId}`, { content });
  const saved = await client.page(pageId);
  if (saved.content.raw !== content) throw new Error(`Page ${pageId} content differed after image replacement.`);
  return { page: saved, snapshot };
}

export async function verifyPage(client: WordPress, driver: BrowserDriver, pageId: number, options: { expectedStatus?: string; screenshotDir?: string } = {}) {
  const page = await client.page(pageId);
  const url = page.status === 'publish' ? page.link : previewUrl(page, client.url);
  const prefix = path.join(options.screenshotDir || 'artifacts', `page-${pageId}`);
  const desktop = await driver.render(url, 'desktop', `${prefix}-desktop.png`, page.status !== 'publish');
  const mobile = await driver.render(url, 'mobile', `${prefix}-mobile.png`, page.status !== 'publish');
  const expectedHost = new URL(client.url).host;
  const checks = {
    exists: true,
    status: page.status,
    statusMatches: page.status === (options.expectedStatus || 'draft'),
    http: desktop.status === 200 && mobile.status === 200,
    browser: [desktop, mobile].every(result => {
      const final = new URL(result.finalUrl);
      return final.host === expectedHost && !final.pathname.includes('wp-login.php');
    }),
    noErrors: desktop.errors.length === 0 && mobile.errors.length === 0,
  };
  return { ok: checks.statusMatches && checks.http && checks.browser && checks.noErrors, page: pageSummary(page), checks, previewUrl: url, desktop, mobile };
}
