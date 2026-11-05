import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

let loginEnv: NodeJS.ProcessEnv = { ...process.env }

/**
 * Apps launched from the Dock or Finder get a minimal PATH, so claude, gh and git
 * may not be found. Read the login shell's environment once at startup and use it
 * for every terminal and child process.
 */
export async function loadLoginShellEnv(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__CLAUDE_HUB_ENV__'
  const output = await new Promise<string>((resolve) => {
    execFile(
      shell,
      // NUL-separated, so values containing newlines (exported shell functions) survive.
      ['-ilc', `printf '%s\\0' ${marker}; env -0; printf '%s\\0' ${marker}`],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout)
    )
  })
  const parts = output.split('\0')
  const start = parts.indexOf(marker)
  const end = parts.indexOf(marker, start + 1)
  if (start < 0 || end < 0) return
  const env: NodeJS.ProcessEnv = {}
  for (const entry of parts.slice(start + 1, end)) {
    const i = entry.indexOf('=')
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1)
  }
  if (env.PATH) loginEnv = { ...process.env, ...env }
}

// Markers a running Claude Code session sets for its own children. If the app is started
// from inside Claude Code, passing them on makes every session think it is a sub-session.
// User settings such as CLAUDE_CODE_USE_BEDROCK are kept. CLAUDE_HUB_* are the app's own
// per-session variables (set again for each session) and dev aids, never inherited.
const SESSION_MARKERS =
  /^(ELECTRON_RUN_AS_NODE|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_HUB_\w+|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_\w+|CHILD_SESSION|MESSAGING_\w+|SSE_PORT|STARTUP_\w+|EMIT_\w+|ENABLE_SDK_\w+|ENABLE_TASKS|QUESTION_PREVIEW_FORMAT))$/

export function getEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(loginEnv)) if (!SESSION_MARKERS.test(key)) env[key] = value
  return env
}

/** PATH, whatever its casing: a copy of process.env on Windows keeps the real key, usually "Path". */
function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key && env[key]) || ''
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Finds an executable: a full path is checked as given, a bare name is looked up on the
 * login PATH. On Windows it tries .exe first (the native installer), then .cmd/.bat shims.
 */
export function which(command: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    for (const ext of exts) if (isFile(command + ext)) return command + ext
    return undefined
  }
  for (const dir of pathValue(loginEnv).split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 15000,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, env: { ...getEnv(), ...extraEnv }, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    )
  })
}

/**
 * Builds the command line for running a .cmd/.bat shim through cmd.exe, which re-parses it:
 * every argument is quoted and cmd's metacharacters escaped (twice for the shim's own
 * re-parse, as cross-spawn does), so values with spaces, & or | stay single arguments.
 */
export function cmdShimCommandLine(shim: string, args: string[]): string {
  const meta = /([()\][%!^"`<>&|;, *?])/g
  const quote = (arg: string) => {
    let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
    a = `"${a}"`
    return a.replace(meta, '^$1').replace(meta, '^$1')
  }
  const exe = shim.replace(meta, '^$1')
  return `/d /s /c "${[exe, ...args.map(quote)].join(' ')}"`
}
