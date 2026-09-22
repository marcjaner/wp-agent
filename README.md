# wp-agent

A TypeScript CLI and library that gives coding agents structured control of WordPress and Playwright screenshots for visual verification. It uses the WordPress REST API for pages, media, plugins, and discovery. Theme installation and activation use WP-CLI over SSH because the core REST API does not provide those mutations. No WordPress bridge plugin or MCP server is required.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Fill in WP_URL, WP_USER, WP_APP_PASSWORD, and WP_PASSWORD.
# Set the optional SSH variables and WP_PATH for WP-CLI theme operations.
npm run build
node dist/cli.js connect https://your-site.example --json
node dist/cli.js status --json
```

`WP_APP_PASSWORD` is a WordPress Application Password for REST calls. `WP_PASSWORD` is the account password used only to log Playwright into `/wp-login.php` so it can see draft previews. The site URL is saved in `.wp-agent/config.json`; credentials stay in environment variables or `.env`. `.env`, `.wp-agent`, and screenshots are ignored by Git. Avoid putting secrets in command arguments or URLs.

## Common workflow

```bash
node dist/cli.js inspect --json
node dist/cli.js pages list --json
node dist/cli.js pages get 142 --json
node dist/cli.js blocks list 142 --json
node dist/cli.js pages preview 142 --json
node dist/cli.js pages clone 142 --title "New draft" --json
node dist/cli.js blocks copy 142 3 381 --after 1 --json
node dist/cli.js content replace 381 --from "Old heading" --to "New heading" --json
node dist/cli.js verify 381 --json
```

New pages and clones are drafts. Publishing needs `--publish` or an explicit status update. Existing page updates and deletions write a local JSON snapshot first. Deleting a page requires `--yes`; `--force` permanently deletes it. `verify` expects a draft unless `--expect-status publish` is supplied. It checks the page through REST, renders desktop and mobile previews, saves both screenshots, and fails on HTTP, login redirect, fatal WordPress text, or browser errors.

Other commands:

```text
pages create --title ... [--content-file ...] [--publish]
pages update ID [--title ...] [--content-file ...] [--status ...]
pages delete ID --yes [--force]
pages revisions ID
blocks get ID PATH
blocks copy SOURCE_ID PATH TARGET_ID [--after TOP_LEVEL_PATH]
media list | search TERM | upload FILE [--alt ...]
plugins list | install SLUG | activate SLUG | deactivate SLUG | remove SLUG --yes
themes list | install SLUG | activate SLUG
browser open URL [--authenticated]
screenshot URL [--mobile | --desktop] [--authenticated]
```

`pages get` includes raw Gutenberg content. `blocks list` parses WordPress block delimiters and reports nested paths. Clone sends the original raw content back unchanged, preserving unknown and third-party blocks. `blocks copy` moves a serialized block or section from one page to another without regenerating third-party markup; it rejects duplicate block `uniqueId` values and snapshots the target before saving. `content replace` changes visible text nodes while keeping block comments, JSON attributes, tags, and the surrounding layout intact. For larger changes, use `pages update --content-file` with carefully constructed Gutenberg markup. Browser access is used for rendering and verification, with authenticated draft previews. Preview screenshots hide the WordPress admin bar so the captured layout matches a visitor view.

The same operations can be called from TypeScript without spawning the CLI:

```ts
import { WordPress, PlaywrightDriver, clonePage, verifyPage } from 'wp-agent';

const client = new WordPress('https://your-site.example/', {
  user: process.env.WP_USER!,
  appPassword: process.env.WP_APP_PASSWORD!,
});
const { clone } = await clonePage(client, 142, 'New draft');
const browser = new PlaywrightDriver(client.url);
try {
  console.log(await verifyPage(client, browser, clone.id));
} finally {
  await browser.close();
}
```

The `BrowserDriver` interface is independent of Playwright. SSH and WP-CLI are optional and currently used only for WordPress version discovery and theme mutations. A future small bridge plugin can provide structured theme operations for hosts without SSH.

## Tests

```bash
npm test
npm run test:live
```

The live test needs an existing Gutenberg page with a heading, paragraph, and at least six blocks. It previews the source, clones it, changes a heading and paragraph, confirms the block names, paths, and attributes survived, captures desktop and mobile screenshots, then installs, activates, and deactivates Hello Dolly. It writes `artifacts/live-report.json`. The included `examples/layout-fixture.html` can seed a richer test page on an otherwise empty installation after replacing its image placeholders with an uploaded media ID and URL.

## Scope

The core exports `WordPress`, Gutenberg parsing helpers, and a `BrowserDriver` interface with a Playwright implementation. A later MCP server can call these same library functions. Translation can follow the same raw-block-preserving approach: extract text, translate it, inject the translated text, then let a WPML/Polylang/TranslatePress adapter associate pages. No translation or provider-specific visual analysis is included yet.
