---
name: wordpress
description: Work on a WordPress site with wp-agent's structured CLI and visual verification.
---

# WordPress workflow

1. Run `wp-agent status --json` and `wp-agent inspect --json` to confirm the site, account, theme, plugins, and available blocks.
2. Run `wp-agent pages list --json`. Inspect likely reference pages with `pages get`, `blocks list`, and `pages preview`.
3. Clone the closest existing page into a draft. Use `content replace` for simple visible text edits; preserve block comments and third-party attributes.
4. Search existing media before uploading a new file. Use its WordPress media ID and URL in a valid image block when content requires an image.
5. Run `wp-agent verify <id> --json`. Inspect both screenshots and confirm the expected title, content, layout, and plugin state.
6. Report the page ID, draft preview URL, block structure, screenshots, status, and any errors. Publish only when explicitly requested.

Use REST or WP-CLI commands for mutations. Use the browser for rendering, inspection, and interactions lacking a structured operation. Never put credentials in command arguments or logs.
