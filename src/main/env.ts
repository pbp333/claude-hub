import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

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
      ['-ilc', `echo ${marker}; env; echo ${marker}`],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout)
    )
  })
  const body = output.split(marker)[1]
  if (!body) return
  const env: NodeJS.ProcessEnv = {}
  for (const line of body.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
  }
  if (env.PATH) loginEnv = { ...process.env, ...env }
}

// Markers a running Claude Code session sets for its own children. If the app is started
// from inside Claude Code, passing them on makes every session think it is a sub-session.
// User settings such as CLAUDE_CODE_USE_BEDROCK are kept.
const SESSION_MARKERS =
  /^(ELECTRON_RUN_AS_NODE|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_\w+|CHILD_SESSION|MESSAGING_\w+|SSE_PORT|STARTUP_\w+|EMIT_\w+|ENABLE_SDK_\w+|ENABLE_TASKS|QUESTION_PREVIEW_FORMAT))$/

export function getEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(loginEnv)) if (!SESSION_MARKERS.test(key)) env[key] = value
  return env
}

/** Finds an executable on the login PATH (handles claude.exe / claude.cmd on Windows). */
export function which(command: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (loginEnv.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      if (dir && existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 15000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, env: getEnv(), timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    )
  })
}
