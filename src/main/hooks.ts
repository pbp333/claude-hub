import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AttentionState } from '../shared/types'

export interface HookEvent {
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

/**
 * Local HTTP server that receives Claude Code `http` hooks from every session the app
 * started. Bound to 127.0.0.1 on a random port and protected by a per-launch token.
 */
export class HookServer {
  readonly token = randomBytes(24).toString('hex')
  private server?: Server
  port = 0
  private onEvent: (event: HookEvent) => void

  constructor(onEvent: (event: HookEvent) => void) {
    this.onEvent = onEvent
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers['x-hub-token'] !== this.token) {
        res.writeHead(403).end()
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        // Answer immediately with an empty decision so Claude never waits on the app.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        const hubSessionId = String(req.headers['x-hub-session'] || '')
        try {
          const payload = JSON.parse(body) as Record<string, unknown>
          const name = String(payload.hook_event_name || '')
          if (hubSessionId && name) this.onEvent({ hubSessionId, name, payload })
        } catch {
          // ignore malformed bodies
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
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
