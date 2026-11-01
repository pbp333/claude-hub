# Claude Hub

A desktop app for running several Claude Code CLI sessions side by side. It shows which session needs you, lets you tag sessions, tracks each session through a configurable job type (a list of steps), and has a file tree and editor next to the terminals.

It hosts the real `claude` CLI in terminals and never calls the Claude API itself. Plan: [Claude Hub plan](https://claude.ai/artifact/Sk3C3JCBMNpuLtBL5rd1Lj).

## Run from source

```sh
npm install      # also fixes node-pty's spawn-helper permissions
npm run dev      # app with hot reload
```

Other scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm run dist:mac`, `npm run dist:win`.

Needs Node 24+ and Claude Code on your PATH. If you start the app from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first (VS Code sets it, and Electron then runs as plain Node).

## How it works

- **Sessions** are `claude` (or plain shell) processes in node-pty, shown with xterm.js. Output is buffered in the main process, so tabs can move and reopen without losing scrollback.
- **Attention states** come from Claude Code `http` hooks. Each session is started with `--settings <data>/hub-hooks.json`, so your own `~/.claude/settings.json` is untouched. Hooks POST to a server on `127.0.0.1` (random port, per-launch token). Plain shells use an output-activity fallback.
- **Dialogs**: a headless terminal tracks each session's screen. When the CLI shows a selection dialog (folder trust, login, feature offers), the session is marked "Needs you" and any job-step prompt waits until you answer it.
- **Job types** are step lists picked when opening a session. A step can paste a prompt (`autoSend` presses Enter too), and moves on manually, when Claude stops (`stop`), or on a GitHub condition (`{ "github": "prOpen" }`). A step can set a tag while active.
- **GitHub tags** come from `gh pr view` for the session's branch (every `pollIntervalSec`, and after each Stop), turned into tags by `rules.json`.
- **Files**: file paths printed in a terminal become links; ⌘/Ctrl+click opens them at that line in a Monaco tab. Edits on disk reload into open editors; unsaved edits are kept and flagged.

## Configuration

JSON files in the app data folder (`~/Library/Application Support/Claude Hub/data` on macOS, `%APPDATA%\Claude Hub\data` on Windows). Open them from the command palette (⌘/Ctrl+Shift+P → "Edit job types", "Edit tags", ...). They reload on save; problems show at the bottom of the sidebar.

| File | Holds |
| --- | --- |
| `jobTypes.json` | Job types and their steps |
| `tags.json` | Tags: `id`, `name`, `color`, optional `group`, `exclusive`, `shortcut` |
| `rules.json` | GitHub rules: `when` (condition) → `setTag` |
| `settings.json` | Shell, `claudeCommand`, `claudeArgs`, hooks on/off, poll interval, bot logins, notifications, font, keybindings |

Step fields: `id`, `name`, `prompt`, `autoSend`, `advanceOn` (`"manual"`, `"stop"` or `{ "github": "prOpen" | "draft" | "botReviewed" | "approved" | "changesRequested" | "ciFailing" | "ciPassing" | "merged" }`), `tag`.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘/Ctrl+T | New session |
| ⌘/Ctrl+1…9 | Switch to session (sidebar order) |
| ⌘/Ctrl+J | Next session that needs you |
| ⌘/Ctrl+Shift+N | Next step |
| ⌘/Ctrl+P | Open file |
| ⌘/Ctrl+Shift+P | Command palette |
| ⌘/Ctrl+B | Toggle file tree |
| ⌘/Ctrl+W | Close tab |

All rebindable in `settings.json` → `keybindings`. Right-click a session for tags, job type, steps, rename, restart and close.

## Dev aids

Environment variables for testing without clicking through the UI:

- `CLAUDE_HUB_USER_DATA=<dir>`: use a separate data folder.
- `CLAUDE_HUB_DEMO="claude|shell:<folder>[:<jobTypeId>]"`: start a session on launch.
- `CLAUDE_HUB_DEMO_INPUT` / `CLAUDE_HUB_DEMO_INPUT_DELAY`: type into that session (JSON string escapes).
- `CLAUDE_HUB_DEMO_OPEN="<path>:<line>"`: open a file as a terminal link would.
- `CLAUDE_HUB_SCREENSHOT=<file.png>` / `CLAUDE_HUB_SCREENSHOT_DELAY`: capture the window and quit.
- `CLAUDE_HUB_DEBUG=1`: log hook events, state changes and the renderer console.

## CI

Every push runs typecheck, tests and build on Linux. macOS and Windows installers build only on a `v*` tag or a manual run (Actions → CI → Run workflow), because macOS minutes count 10x against the private-repo quota.
