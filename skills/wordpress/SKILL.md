---
name: wordpress
description: Use wp-agent to inspect and change a WordPress site, preserve Gutenberg blocks, and verify draft or published pages in a browser. Apply when a task calls for the wp-agent CLI or library; ordinary WordPress advice does not need this skill.
---

# Work with wp-agent

Use the structured `wp-agent` CLI or library for WordPress changes. From this repository, `node dist/cli.js` is equivalent to the installed `wp-agent` command. Read the current CLI help or [README](../../README.md) for command options when needed.

## Establish the site and scope

- Run `wp-agent status --json` and `wp-agent inspect --json` to confirm the connected site, account capabilities, active theme and plugins, and available adapters.
- Check `wp-agent session status --json`. For a new task, start a session with the actual `disposable`, `staging`, or `production` environment and a concise goal. The environment is supplied by the operator; do not infer it from the hostname. Preserve the current session when continuing the same task.
- Inspect relevant pages with `pages list`, `pages get`, `blocks list`, `blocks map`, and authenticated `pages preview` as useful. Choose create, clone, or edit based on the requested outcome; clones and new pages start as drafts.

## Make controlled changes

- Prefer semantic operations such as `pages`, `blocks`, `content`, `media`, `plugins`, `themes generatepress`, and `custom-css`. Preserve unknown Gutenberg block attributes and markup. For GenerateBlocks style changes, use `blocks style get/set` so editable styles and compiled CSS remain aligned.
- Check `policy explain` for consequential actions. Follow the policy decision and the user's scope. Publishing, deleting preexisting content, changing published production pages, and production site-wide or plugin/theme changes can require explicit approval. A `--yes` flag does not grant that approval. JSON mode returns a policy error rather than prompting.
- Use raw REST or WP-CLI mutation paths only when a structured operation cannot do the requested work, and keep them inside wp-agent's policy boundary. SSH/WP-CLI, the bridge plugin, and Jev are optional; discover capabilities before relying on them. Theme installation and activation currently require SSH/WP-CLI. Never put credentials in command arguments, URLs, logs, or committed files.
- Snapshots and the session journal aid review, but they are not an automatic rollback. Review the saved state before restoring anything.

## Verify and report

- Run `wp-agent verify <page-id> --json` for desktop and mobile screenshots, expected status, HTTP response, login redirect, and browser errors. Add `--expect-status publish` for a published page. Inspect the screenshots and page content yourself; a passing result does not establish visual quality or Gutenberg editor validity.
- For complex or third-party blocks, open the Gutenberg editor with deterministic browser selectors and check for invalid-block warnings. Confirm responsive behavior at any breakpoint relevant to the change.
- Report the page ID, status, authenticated draft preview URL if applicable, screenshots, observed checks, and any remaining limitations. Do not publish unless the user has authorized it and the policy decision permits it.
