import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AttentionState } from '../shared/types'

export interface HookEvent {
  /** The spawn key from the X-Hub-Session header: "<session id>.<generation>". */
  hubSessionId: string
  name: string
  payload: Record<string, unknown>
}

// SessionStart only supports command hooks, so it isn't here: the app knows when it starts a session.
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd'
]

const MAX_BODY = 1024 * 1024

/**
 * Local HTTP server that receives Claude Code `http` hooks from every session the app
 * started. Bound to 127.0.0.1 on a random port. Each running process gets its own
 * random token, so a process inside one session can't post events for another.
 */
export class HookServer {
  private server?: Server
  port = 0
  private onEvent: (event: HookEvent) => void
  /** Spawn key (see SessionManager) → that process's token. */
  private tokens = new Map<string, Buffer>()

  constructor(onEvent: (event: HookEvent) => void) {
    this.onEvent = onEvent
  }

  /** A fresh token for one process; it is passed to that process only, in its environment. */
  register(key: string): string {
    const token = randomBytes(24).toString('hex')
    this.tokens.set(key, Buffer.from(token))
    return token
  }

  unregister(key: string): void {
    this.tokens.delete(key)
  }

  private authorized(key: string, token: string): boolean {
    const expected = this.tokens.get(key)
    const given = Buffer.from(token)
    return !!expected && expected.length === given.length && timingSafeEqual(expected, given)
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const key = String(req.headers['x-hub-session'] || '')
      const token = String(req.headers['x-hub-token'] || '')
      // The Host check is defense in depth against DNS rebinding: a page on another name
      // that resolves to 127.0.0.1 would send its own Host.
      if (
        req.method !== 'POST' ||
        req.url !== '/hook' ||
        req.headers.host !== `127.0.0.1:${this.port}` ||
        !this.authorized(key, token)
      ) {
        res.writeHead(403).end()
        return
      }
      req.setEncoding('utf8')
      let body = ''
      let tooLarge = false
      req.on('data', (chunk: string) => {
        if (tooLarge) return
        body += chunk
        if (Buffer.byteLength(body) > MAX_BODY) {
          tooLarge = true
          res.writeHead(413).end()
        }
      })
      req.on('end', () => {
        if (tooLarge) return
        // Answer immediately with an empty decision so Claude never waits on the app.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        try {
          const payload = JSON.parse(body) as Record<string, unknown>
          const name = String(payload.hook_event_name || '')
          if (name) this.onEvent({ hubSessionId: key, name, payload })
        } catch {
          // ignore malformed bodies
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
    this.server.on('error', () => undefined)
    this.port = (this.server.address() as AddressInfo).port
  }

  stop(): void {
    this.server?.close()
  }

  /** Settings passed to `claude --settings`, so the hooks apply only to sessions the app launched. */
  settingsJson(): string {
    const hook = {
      type: 'http',
      url: `http://127.0.0.1:${this.port}/hook`,
      timeout: 5,
      headers: { 'X-Hub-Token': '$CLAUDE_HUB_TOKEN', 'X-Hub-Session': '$CLAUDE_HUB_SESSION_ID' },
      allowedEnvVars: ['CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']
    }
    const hooks: Record<string, unknown> = {}
    for (const event of EVENTS) hooks[event] = [{ hooks: [hook] }]
    return JSON.stringify({ hooks }, null, 2)
  }
}

/** Maps a hook event to the session's new attention state; undefined = no change. */
export function stateForEvent(event: HookEvent): AttentionState | undefined {
  switch (event.name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      return 'needs-you'
    case 'Notification': {
      const type = String(event.payload.notification_type ?? event.payload.type ?? '')
      if (['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(type))
        return 'needs-you'
      // Older CLIs send no type; fall back to the message text.
      const message = String(event.payload.message ?? '').toLowerCase()
      if (!type && (message.includes('permission') || message.includes('waiting for your input'))) return 'needs-you'
      return undefined
    }
    case 'Stop':
    case 'StopFailure':
      return 'done'
    case 'SessionEnd':
      // /clear and /resume end one conversation but keep the CLI running.
      return ['clear', 'resume'].includes(String(event.payload.reason ?? '')) ? 'idle' : 'exited'
    default:
      return undefined
  }
}

/** States that ask for the user's attention and should notify. */
export function shouldNotify(state: AttentionState): boolean {
  return state === 'needs-you' || state === 'done'
}

/**
 * True when the screen shows one of the CLI's selection dialogs (folder trust, login, theme,
 * new-feature offers). Only the bottom of the screen counts, where the dialog's
 * "Enter to confirm · Esc to cancel" footer sits, so Claude's own output quoting those
 * words higher up doesn't hold a prompt back.
 */
export function showsDialog(screen: string): boolean {
  const bottom = screen
    .split('\n')
    .filter((l) => l.trim())
    .slice(-4)
    .join('\n')
  return /Enter to confirm|Esc to cancel/i.test(bottom)
}

/** Claude Code session ids are UUIDs. */
export function isClaudeSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}
