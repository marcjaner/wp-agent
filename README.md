# wp-agent

A TypeScript CLI and library that gives coding agents structured control of WordPress and Playwright screenshots for visual verification. It uses the WordPress REST API for pages, media, plugins, and discovery. The optional WordPress bridge provides registered Customizer settings and Custom CSS over authenticated HTTP. Optional SSH/WP-CLI remains available for theme installation, activation, and configuration.

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
node dist/cli.js blocks remove 381 2 --json
node dist/cli.js blocks replace-image 381 1.0.0 27 --json
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
blocks remove PAGE_ID PATH
blocks replace-image PAGE_ID PATH MEDIA_ID
media list | search TERM | upload FILE [--alt ...]
plugins list | install SLUG | activate SLUG | deactivate SLUG | remove SLUG --yes
themes list | install SLUG | activate SLUG
browser open URL [--authenticated]
screenshot URL [--mobile | --desktop] [--authenticated]
```

`pages get` includes raw Gutenberg content. `blocks list` parses WordPress block delimiters and reports nested paths. Clone sends the original raw content back unchanged, preserving unknown and third-party blocks. `blocks copy` moves a serialized block or section from one page to another without regenerating third-party markup; it rejects duplicate block `uniqueId` values and snapshots the target before saving. `blocks remove` removes an identified block. `blocks replace-image` updates a core Image block using an existing WordPress media item while preserving other block attributes. These mutations snapshot the page before saving. `content replace` changes visible text nodes while keeping block comments, JSON attributes, tags, and the surrounding layout intact. Browser access is used for rendering and verification, with authenticated draft previews. Preview screenshots hide the WordPress admin bar so the captured layout matches a visitor view.

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

The `BrowserDriver` interface is independent of Playwright. SSH and WP-CLI are optional. The bridge and WP-CLI can both handle the tested GeneratePress settings and Custom CSS; `auto` uses a working WP-CLI connection when available, then the bridge. The browser still handles rendering and editor verification.

## Optional WordPress bridge

Package the plugin with `npm run bridge:package`. This creates `wp-agent-bridge.zip` containing the `wp-agent-bridge/` plugin directory. Install it on any compatible WordPress site through **Plugins → Add Plugin → Upload Plugin → Activate**. WP-CLI is not required for installation. Sites without the bridge retain core REST and browser operations.

The bridge registers `GET /wp-json/wp-agent/v1/manifest` for version and capability discovery. Authenticated routes require a WordPress Application Password and the appropriate WordPress capability:

| Route | Capability | Operation |
| --- | --- | --- |
| `GET/POST /wp-agent/v1/theme-settings` | `edit_theme_options` plus per-setting capability | Read/write registered, sanitized Customizer theme settings |
| `GET/POST /wp-agent/v1/custom-css` | `edit_css` | Read/write active-theme Custom CSS |

Theme setting writes accept only registered `theme_mod` settings or individual keys of registered Customizer option arrays, and require a registered sanitizer. The bridge does not expose arbitrary options, files, code execution, SQL, or shell commands. Custom CSS writes require the hash returned by the preceding read and use WordPress's `custom_css` post, which keeps revisions. `wp-agent inspect --json` reports bridge availability, version, and capabilities. CLI versions currently accept bridge protocol `0.1.x`.

GeneratePress interpretation lives in [src/adapters/generatepress.ts](src/adapters/generatepress.ts), outside the plugin:

```bash
node dist/cli.js themes generatepress get --backend bridge --json
node dist/cli.js themes generatepress set --file theme-config.json --backend bridge --json
node dist/cli.js custom-css get --backend bridge --json
node dist/cli.js custom-css set --file site.css --backend bridge --json
```

`--backend auto` is the default; `wp-cli` can be selected explicitly. The settings file contains semantic fields such as `containerWidth`, `sidebarLayout`, and `backgroundColor`. Writes create local snapshots under `.wp-agent/snapshots/`. For a no-SSH test, set `WP_SSH_HOST`, `WP_SSH_USER`, `WP_SSH_KEY_PATH`, and `WP_PATH` to empty strings in the process environment so `.env` cannot supply them.

```bash
WP_SSH_HOST='' WP_SSH_USER='' WP_SSH_KEY_PATH='' WP_PATH='' node scripts/no-ssh-config-test.mjs
```

## Tests

```bash
npm test
npm run test:live
npm run test:bridge
```

The live test needs an existing Gutenberg page with a heading, paragraph, and at least six blocks. It previews the source, clones it, changes a heading and paragraph, confirms the block names, paths, and attributes survived, captures desktop and mobile screenshots, then installs, activates, and deactivates Hello Dolly. It writes `artifacts/live-report.json`. The bridge live test uses a disposable site with SSH available only to create and remove a temporary subscriber for permission tests. It checks anonymous and subscriber denial, validation, discovery, authorized reads and mutations, CSS conflicts, and restoration. The included `examples/layout-fixture.html` can seed a richer test page on an otherwise empty installation after replacing its image placeholders with an uploaded media ID and URL.

## Scope

The core exports `WordPress`, Gutenberg parsing helpers, bridge and capability clients, and a `BrowserDriver` interface with a Playwright implementation. A later MCP server can call these same library functions. Provider-specific visual analysis is outside this milestone.
