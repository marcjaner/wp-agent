import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { siteUrl } from '../dist/wordpress.js';

dotenv.config({ quiet: true });
const pageId = Number(process.argv[2]);
const blockType = process.argv[3] || 'generateblocks/text';
const expectedText = process.argv[4] || 'GenerateBlocks content survives cloning.';
if (!Number.isSafeInteger(pageId) || !process.env.WP_USER || !process.env.WP_PASSWORD) throw new Error('Usage: node scripts/check-editor.mjs PAGE_ID [BLOCK_TYPE] [EXPECTED_TEXT] (with WP_USER and WP_PASSWORD set)');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL('wp-login.php', siteUrl()).toString());
  await page.locator('#user_login').fill(process.env.WP_USER);
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD);
  await Promise.all([
    page.waitForURL(url => !url.pathname.includes('wp-login.php'), { timeout: 30000 }),
    page.locator('#wp-submit').click(),
  ]);
  await page.goto(new URL(`wp-admin/post.php?post=${pageId}&action=edit`, siteUrl()).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const frames = page.frames();
  const text = (await Promise.all(frames.map(frame => frame.locator('body').innerText().catch(() => '')))).join('\n');
  const blocks = (await Promise.all(frames.map(frame => frame.locator(`[data-type="${blockType}"]`).count().catch(() => 0)))).reduce((sum, count) => sum + count, 0);
  const result = {
    pageId, editorUrl: page.url(), blockType, matchingBlocks: blocks,
    invalidBlockWarning: /This block contains unexpected or invalid content|Attempt Block Recovery|Este bloque contiene contenido inesperado o no válido/i.test(text),
    textPresent: text.includes(expectedText),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!blocks || result.invalidBlockWarning || !result.textPresent) process.exitCode = 1;
} finally {
  await browser.close();
}
