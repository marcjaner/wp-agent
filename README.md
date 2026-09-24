# wp-agent

A TypeScript CLI and library that gives coding agents structured control of WordPress and Playwright screenshots for visual verification. It uses the WordPress REST API for pages, media, plugins, and discovery. The optional WordPress bridge provides registered Customizer settings and Custom CSS over authenticated HTTP. Optional SSH/WP-CLI remains available for theme installation, activation, and configuration.

## Install

```bash
npm install -g wp-agent
npx playwright install chromium
# Set WP_URL, WP_USER, WP_APP_PASSWORD, and WP_PASSWORD in the environment.
wp-agent connect https://your-site.example --json
wp-agent status --json
```

For a source checkout:

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
node dist/cli.js session start --goal "Create a new draft based on an existing page" --environment production --json
node dist/cli.js inspect --json
node dist/cli.js pages list --json
node dist/cli.js pages get 142 --json
node dist/cli.js blocks list 142 --json
node dist/cli.js blocks map 142 --json
node dist/cli.js pages preview 142 --json
node dist/cli.js pages clone 142 --title "New draft" --json
node dist/cli.js blocks copy 142 3 381 --after 1 --json
node dist/cli.js blocks remove 381 2 --json
node dist/cli.js blocks replace-image 381 1.0.0 27 --json
node dist/cli.js content replace 381 --from "Old heading" --to "New heading" --json
node dist/cli.js verify 381 --json
```

New pages and clones are drafts. Publishing needs `--publish` or an explicit status update. Existing page updates and deletions write a local JSON snapshot first. Deleting a page requires `--yes`; `--force` permanently deletes it. `verify` expects a draft unless `--expect-status publish` is supplied. It checks the page through REST, renders desktop and mobile previews, saves both screenshots, and fails on HTTP, login redirect, fatal WordPress text, or browser errors.

## Policy and session journal

Start a session with an explicit site environment: `disposable`, `staging`, or `production`. The goal is optional, but supplying it lets the optional semantic classifier judge whether a proposed change fits the task. The environment is never inferred from the hostname. Without an explicit session, wp-agent starts a conservative production session with no goal when the first action is recorded.

```bash
node dist/cli.js session start --goal "Create a new draft page" --environment production --json
node dist/cli.js session status --json
node dist/cli.js session history --json
node dist/cli.js policy explain pages.delete 42 --json
node dist/cli.js policy explain pages.update 105 --publish --json
```

The policy evaluates WordPress operations before REST, Bridge, or WP-CLI executes them. Reads and edits to drafts created in the current session usually proceed. Editing a preexisting published production page, deleting preexisting content, publishing, or changing plugins and themes on production requires approval. Reversible changes on less important environments may proceed with a snapshot. `--yes` for deletion does not override a policy decision. Interactive CLI commands ask for an explicit `approve`; `--json` commands return a `policy_decision` error with the action, risk, decision, and reason, without executing the operation. Raw REST and WP-CLI mutation escape hatches are classified conservatively.

The journal is `.wp-agent/session.json`; starting a new session archives the previous journal under `.wp-agent/sessions/`. It records the goal, environment, resource ownership, action decisions, snapshots, and outcomes. When an operation fails after taking a snapshot, the error includes its path for review and recovery. Secrets are redacted, and `.wp-agent/` is ignored by Git. Set `WP_AGENT_SESSION_FILE` only when a separate journal path is needed, such as an isolated test. A human should review the journal and snapshots before restoring any previous state; wp-agent does not promise universal rollback.

`TYPESAFE_API_KEY` enables the optional Jev semantic provider. It receives the goal, environment, recent action summaries, and the proposed semantic operation, then may raise the required decision. It cannot lower a deterministic rule. Reads and ordinary edits to session-created drafts do not call Jev. If a configured Jev call fails or returns invalid output for an action selected for semantic review, approval is required. Without the key, deterministic policy remains active. The SDK is an optional package dependency and loads only for a configured semantic call.

Other commands:

```text
pages create --title ... [--content-file ...] [--publish]
pages update ID [--title ...] [--content-file ...] [--status ...]
pages delete ID --yes [--force]
pages revisions ID
blocks get ID PATH
blocks map ID [--mobile] [--all]
blocks copy SOURCE_ID PATH TARGET_ID [--after BLOCK_PATH]
blocks remove PAGE_ID PATH
blocks replace-image PAGE_ID PATH MEDIA_ID
blocks style get PAGE_ID PATH
blocks style set PAGE_ID PATH --file styles.json
media list | search TERM | upload FILE [--alt ...]
plugins list | install SLUG | activate SLUG | deactivate SLUG | remove SLUG --yes
themes list | install SLUG | activate SLUG
browser open URL [--authenticated]
screenshot URL [--mobile | --desktop] [--authenticated]
```

`pages get` includes raw Gutenberg content. `blocks list` parses WordPress block delimiters and reports nested paths. `blocks map` relates rendered elements and their page coordinates to block paths using a unique ID, anchor, or uniquely matching class; it reports unmatched blocks rather than guessing. It maps top-level blocks by default and can inspect nested blocks with `--all`. Clone sends the original raw content back unchanged, preserving unknown and third-party blocks. `blocks copy` copies a serialized block or section from one page to another without regenerating third-party markup; `--after` accepts a nested path to insert a sibling at that level. It rejects duplicate block `uniqueId` values and snapshots the target before saving. `blocks remove` removes an identified block. `blocks replace-image` updates a core Image block using an existing WordPress media item while preserving other block attributes. `blocks style set` updates a GenerateBlocks Element's base and responsive `styles` plus generated `css`; it rejects existing CSS that cannot be safely regenerated. A style file can contain `{ "base": { "gridTemplateColumns": "2fr 1fr" }, "responsive": { "@media (max-width: 850px)": { "gridTemplateColumns": "1fr" } } }`. These mutations snapshot the page before saving. `content replace` changes visible text nodes while keeping block comments, JSON attributes, tags, and the surrounding layout intact. Browser access is used for rendering and verification, with authenticated draft previews. Preview screenshots hide the WordPress admin bar so the captured layout matches a visitor view.

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

## Agent skill

The package includes [skills/wordpress/SKILL.md](skills/wordpress/SKILL.md), a short workflow for coding agents using wp-agent. After installation it is at `node_modules/wp-agent/skills/wordpress/SKILL.md`. npm does not automatically register skills with an agent; add that folder through the agent's skill installation mechanism or give the agent the file path. The skill explains session policy, structured mutations, optional backends, and the separate browser and Gutenberg checks needed beyond `verify`.

## Optional WordPress bridge

Package the plugin with `npm run bridge:package`. This creates `wp-agent-bridge.zip` containing the `wp-agent-bridge/` plugin directory. Install it on any compatible WordPress site through **Plugins → Add Plugin → Upload Plugin → Activate**. WP-CLI is not required for installation. Sites without the bridge retain core REST and browser operations.

The bridge registers `GET /wp-json/wp-agent/v1/manifest` for version and capability discovery. Authenticated routes require a WordPress Application Password and the appropriate WordPress capability:

| Route | Capability | Operation |
| --- | --- | --- |
| `GET/POST /wp-agent/v1/theme-settings` | `edit_theme_options` plus per-setting capability | Read/write registered, sanitized Customizer theme settings |
| `GET/POST /wp-agent/v1/custom-css` | `edit_css` | Read/write active-theme Custom CSS |

Theme setting writes accept only registered `theme_mod` settings or individual keys of registered Customizer option arrays, and require a registered sanitizer. The bridge does not expose arbitrary options, files, code execution, SQL, or shell commands. Custom CSS writes require the hash returned by the preceding read and use WordPress's `custom_css` post, which keeps revisions. `wp-agent inspect --json` reports bridge availability, version, and capabilities. CLI versions currently accept bridge protocol `0.1.x`.

## Integration boundary

`inspect --json` also reports `adapters`, with each detected integration's ID and semantic capabilities. The internal registry detects GeneratePress from the active theme and GenerateBlocks from its active plugin or registered block types. The older `detectedBuilders` field remains a plugin-name heuristic for compatibility; `adapters` is the semantic detection result. GeneratePress provides the `theme.config` interpretation and uses the existing Bridge or WP-CLI backend for reads and writes. GenerateBlocks provides a rendered class hint for mapping its `uniqueId` to a visible element. Gutenberg parsing, copying, removal, unknown attribute preservation, and the browser mapping algorithm stay generic and work when either adapter is absent. A small media fixture in the adapter tests checks that the registry can hold a structurally different capability; it is not a shipped integration.

The GenerateBlocks adapter summarizes local and responsive styles, compiled CSS, and global class names for a block. `blocks style set` updates both editable styles and compiled CSS for supported GenerateBlocks Elements; it rejects existing CSS it cannot safely regenerate. When GenerateBlocks Pro is active, the adapter also exposes `accordion.defaultOpen`; `setAccordionDefaultOpen(content, path, open)` updates both the block attribute and Pro's saved open-state class. It returns content for the caller to save through the usual WordPress page operation. Pro global style management is not yet an adapter operation.

The existing `themes generatepress get/set` commands remain the public CLI. A future `theme config get/set` surface would be useful once another theme adapter provides the same capability; changing the command now would add migration cost without another real implementation to validate it. Adapters describe what an integration means. REST, Bridge, WP-CLI, and Playwright remain execution backends.

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
npm run test:jev # optional live API test; requires TYPESAFE_API_KEY
npm run test:live
npm run test:bridge
```

The live test needs an existing Gutenberg page with a heading, paragraph, and at least six blocks. Start a session for a disposable site before running it, since it installs and activates Hello Dolly. It previews the source, clones it, changes a heading and paragraph, confirms the block names, paths, and attributes survived, captures desktop and mobile screenshots, then tests plugin lifecycle. It writes `artifacts/live-report.json`. The older bridge security test exercises raw REST and WP-CLI mutations and now requires adaptation to the policy boundary before it can be run unattended. The included `examples/layout-fixture.html` can seed a richer test page on an otherwise empty installation after replacing its image placeholders with an uploaded media ID and URL.

## Scope

The core exports `WordPress`, Gutenberg parsing helpers, bridge and capability clients, and a `BrowserDriver` interface with a Playwright implementation. A later MCP server can call these same library functions. Provider-specific visual analysis is outside this milestone.
