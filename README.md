# Claude Hub

A desktop app for running several Claude Code CLI sessions side by side, in a folder that can hold many repos. It shows which session needs you, lets you tag sessions, tracks each session's progress through its own steps (which Claude can update), and has a file tree and editor next to the terminals.

It hosts the real `claude` CLI in terminals and never calls the Claude API itself.

> Claude Hub is an independent project. It is not made by, affiliated with, or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for their products.

## Run from source

```sh
npm install      # also fixes node-pty's spawn-helper permissions
npm run dev      # app with hot reload
```

Other scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm run dist:mac`, `npm run dist:win`.

Needs Node 24+ and Claude Code on your PATH (or set `claudeCommand` in `settings.json` to its full path). If you start the app from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first (VS Code sets it, and Electron then runs as plain Node).

## How it works

- **Workspaces**: each window opens a folder (File → Open Folder, ⌘/Ctrl+O), like VS Code. Every session starts in that folder, so Claude sees all the repos inside it and loads the folder's `CLAUDE.md` and `.claude/skills`. ⌘/Ctrl+Shift+N opens another window for another folder. Windows and their folders reopen on launch, each with its own tabs and splits.
- **Repos per session**: the app finds the git repos in the workspace (up to two levels down) and learns which ones each session works in from its hook events: files its tools edit, the directory Claude is in, and repo names in its shell commands. The sidebar shows them with their branches, and warns when two running sessions have touched the same repo.
- **Sessions** are `claude` (or plain shell) processes in node-pty, shown with xterm.js. Output is buffered in the main process, so tabs can move and reopen without losing scrollback.
- **Conversation name**: each Claude session starts with `--name <session name>`, so the conversation shows up under the same name in Claude's `/resume` picker, the terminal title and History. Renaming a hub session applies the next time it restarts (unless `claudeArgs` already sets `--name`).
- **Resume / Restart** continues the session's Claude conversation. If the session doesn't know its conversation (or the transcript is gone), it resumes the conversation in this folder whose title is closest to the session's name (a session named "login bug" finds "Fix the login bug on Safari"; one already running elsewhere is skipped), in the folder it was recorded in. If nothing is close and the session had a conversation before, Claude's own resume picker opens, searching for the name. A session that never talked to Claude just starts fresh.
- **Session kind**: Claude sessions show a violet ✻ and plain shells a blue `>_`, on their sidebar rows and tabs.
- **Keyboard**: Option is a normal character key in terminals, so Option-layer characters like `@` (Option+2 on Portuguese/Spanish Macs) type as expected; Option+Enter, Option+Backspace and Option+arrows still send their Esc-prefixed sequences.
- **Attention states** show as a dot on each session's sidebar row and tab and tell two kinds of "needs you" apart: **waiting for your input** (a question, permission prompt or dialog: red dot with a halo, red tab) and **new output you haven't read** (finished while you were elsewhere: filled amber dot, amber underline, bold name). Once you've looked, a finished session keeps an amber ring ("Your turn"). Sessions waiting for input sort above unread ones and come from Claude Code `http` hooks. Each session is started with `--settings <data>/hub-hooks.json` and `--mcp-config <data>/hub-mcp.json` (the step tools, same server and token) and `--plugin-dir <data>/claude-plugin` (the `/hub:steps` skill), so your own `~/.claude/settings.json` is untouched. Hooks POST to a server on `127.0.0.1` (random port, a separate random token per session process). Plain shells use an output-activity fallback.
- **Dialogs**: a headless terminal tracks each session's screen. When the CLI shows a selection dialog (folder trust, login, feature offers), the session is marked "Waiting for your input" until you answer it.
- **Steps**: each session can have its own step list, shown as a segmented progress bar on its sidebar row (and in History and transcripts). Set it when starting the session or later ("+ steps" on the row, right-click → Edit steps, or the palette): one name per line, or just a number ("4") for unnamed steps. Move with ‹ ›, ⌘/Ctrl+Alt+N, or by clicking a segment (clicking the current one marks it done).
- **Claude updates the steps and tags**: every session gets the app's session tools (a local MCP server, `claude-hub`: `get_steps`, `set_steps`, `complete_step`, `set_step`, `get_tags`, `set_tags`) and a bundled skill, **`/hub:steps`** (loaded with `--plugin-dir`, so your own skills folders are untouched). Run `/hub:steps` (optionally with step names or a count) and Claude breaks the task into steps and keeps them current as it works; it may also use it by itself on multi-step tasks. **When you start a skill** (`/fix-issue 123`, `/my-plugin:deploy`, …), the prompt hook tells Claude to read that skill, turn its workflow into steps, set them before working, complete them with notes as it goes, and tag the session when a tag clearly applies (e.g. Blocked while it waits on you). Claude can only use tags you've already set up, and leaves rule-driven ones alone. Turn this off with `"trackSkills": false` in settings.json. Otherwise, while a session has unfinished steps, each prompt carries a one-line note of the current step. The step history records who moved each step and Claude's note; you get a notification when Claude moves a step in a session you aren't looking at.
- **GitHub tags** come from `gh pr view` for each of the session's repos on its current branch (every `pollIntervalSec`, and after each Stop; results are shared between sessions), turned into tags by `rules.json`.
- **History** (sidebar tab, ⌘/Ctrl+Shift+H): every Claude conversation recorded for the open folder, read from Claude Code's own transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`), including conversations started outside the app and in subfolders. Each shows its title, when, active time and size, plus the hub session, its steps and tags. Opening one shows a read-only transcript: prompts, replies, tool calls (collapsed, with input and result) and subagent runs. **Resume** continues it in a session (`claude --resume`, in the folder it was started in); a closed session that had it comes back with its tags and steps. Closing a session (its tab, the × on its sidebar row, or ⌘/Ctrl+W) stops it and archives it rather than deleting it, so this information stays. It asks first only while Claude is mid-turn.
- **macOS**: closing a window leaves its sessions running; a notification click reopens the folder's window.
- **Files**: file paths printed in a terminal become links (including the hyperlinks Claude prints); a click opens them at that line in a Monaco tab. Edits on disk reload into open editors; unsaved edits are kept and flagged. The editor opens files inside your open folders only. Web links open in your browser.

## Configuration

JSON files in the app data folder (`~/Library/Application Support/Claude Hub/data` on macOS, `%APPDATA%\Claude Hub\data` on Windows). Open them from the command palette (⌘/Ctrl+Shift+P → "Edit tags", ...). They reload on save; problems show at the bottom of the sidebar.

| File | Holds |
| --- | --- |
| `tags.json` | Tags: `id`, `name`, `color`, optional `group`, `exclusive`, `shortcut` |
| `rules.json` | GitHub rules: `when` (condition) → `setTag` |
| `settings.json` | Shell, `claudeCommand`, `claudeArgs`, hooks on/off, poll interval, bot logins, notifications, font, keybindings |


## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘/Ctrl+O | Open folder |
| ⌘/Ctrl+Shift+N | New window |
| ⌘/Ctrl+T | New session |
| ⌘/Ctrl+1…9 | Switch to session (sidebar order) |
| ⌘/Ctrl+J | Next session that needs you |
| ⌘/Ctrl+Alt+N | Next step |
| ⌘/Ctrl+P | Open file |
| ⌘/Ctrl+Shift+P | Command palette |
| ⌘/Ctrl+B | Toggle file tree |
| ⌘/Ctrl+Shift+H | History |
| ⌘/Ctrl+W | Close tab (a session tab closes the session) |

All rebindable in `settings.json` → `keybindings`. Right-click a session for tags, steps, rename, restart and close.

## Security

- The window only shows the app's own page: navigation and file drops are blocked, the renderer is sandboxed with context isolation, and every IPC call is checked to come from that page. File reads and writes are limited to your open folders and the config folder. History reads transcripts through separate channels that take a workspace and a conversation id (a UUID), never a path.
- The hook server listens on `127.0.0.1` only, checks the Host header, and requires a per-session token (compared in constant time). The token is in each session's environment, so programs running inside a session can post events for that session only; Claude's session id from an event is accepted only if it is a UUID, since it ends up on the `--resume` command line.
- git and gh run with `core.fsmonitor=false` and `protocol.ext.allow=never` forced, so a repo's own `.git/config` can't make them run programs when you open a folder.
- Installers are unsigned (no Apple Developer ID or Windows certificate). macOS needs right-click → Open the first time; Windows SmartScreen asks once. Packaged builds have Electron's RunAsNode, NODE_OPTIONS and inspector fuses off and asar integrity on.

Report security problems privately through GitHub's "Report a vulnerability" on this repo rather than in a public issue.

## Dev aids

Environment variables for testing without clicking through the UI. They work in unpackaged builds only (`npm run dev` / `npx electron .`) and are ignored in installed apps:

- `CLAUDE_HUB_USER_DATA=<dir>`: use a separate data folder.
- `CLAUDE_HUB_DEMO="claude|shell:<folder>[:<steps>]"`: open the folder and start a session on launch, optionally with steps (a count, or names separated by `|`).
- `CLAUDE_HUB_DEMO_INPUT` / `CLAUDE_HUB_DEMO_INPUT_DELAY`: type into that session (JSON string escapes).
- `CLAUDE_HUB_DEMO_CLOSE=<ms>`: press Close Tab after that delay.
- `CLAUDE_HUB_DEMO_OPEN="<path>:<line>"`: open a file as a terminal link would.
- `CLAUDE_HUB_DEMO_TRANSCRIPT=<conversation id>`: show History and open that conversation.
- `CLAUDE_HUB_DEMO_RESUME=<conversation id>`: resume that conversation from History.
- `CLAUDE_HUB_SCREENSHOT=<file.png>` / `CLAUDE_HUB_SCREENSHOT_DELAY`: capture the window and quit.
- `CLAUDE_HUB_DEBUG=1`: log hook events, state changes and the renderer console.

## CI

Every push and pull request runs typecheck, tests and build on Linux (`npm ci`, read-only token, no secrets). macOS and Windows installers build on a `v*` tag or a manual run (Actions → CI → Run workflow).

If `npm ci` fails in CI after changing dependencies on macOS ("Missing: … from lock file"), npm dropped other platforms' optional packages from the lockfile. Regenerate it from scratch: `rm -rf node_modules package-lock.json && npm install`.

## License

[MIT](LICENSE)
