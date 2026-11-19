import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AttentionState } from '../shared/types'
import { handleRpc, MCP_SERVER_NAME, TOOLS, type ToolResult } from './stepTools.ts'

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

export interface HookHandlers {
  /** Handles a hook event; what it returns is the hook's JSON reply (e.g. context for the prompt). */
  onEvent(event: HookEvent): object | undefined
  /** Runs one of the step tools for the session with this spawn key. */
  onTool(hubSessionId: string, name: string, args: Record<string, unknown>): ToolResult
}

/**
 * Local HTTP server for every session the app started: it receives Claude Code `http`
 * hooks on /hook and serves the step tools as an MCP server on /mcp. Bound to
 * 127.0.0.1 on a random port. Each running process gets its own random token, so a
 * process inside one session can't post events or close steps for another.
 */
export class HookServer {
  private server?: Server
  port = 0
  private handlers: HookHandlers
  /** Spawn key (see SessionManager) → that process's token. */
  private tokens = new Map<string, Buffer>()

  constructor(handlers: HookHandlers) {
    this.handlers = handlers
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
      if (req.headers.host !== `127.0.0.1:${this.port}` || !this.authorized(key, token) || (req.url !== '/hook' && req.url !== '/mcp')) {
        res.writeHead(403).end()
        return
      }
      // MCP clients may open a GET stream for server messages; this server sends none.
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
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
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = undefined
        }
        if (req.url === '/mcp') return this.answerMcp(key, parsed, res)
        // Handled synchronously, so Claude gets its answer at once and never waits on the app.
        let reply: object | undefined
        try {
          const payload = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
          const name = String(payload.hook_event_name || '')
          if (name) reply = this.handlers.onEvent({ hubSessionId: key, name, payload })
        } catch {
          reply = undefined
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply ?? {}))
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

  private answerMcp(key: string, message: unknown, res: ServerResponse): void {
    if (!message || typeof message !== 'object') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    const call = (name: string, args: Record<string, unknown>): ToolResult => {
      try {
        return this.handlers.onTool(key, name, args)
      } catch (err) {
        return { text: `Claude Hub couldn't do that: ${(err as Error).message}`, isError: true }
      }
    }
    const replies = (Array.isArray(message) ? message : [message]).map((m) => handleRpc(m, call)).filter(Boolean)
    if (!replies.length) {
      res.writeHead(202).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]))
  }

  /** MCP config passed to `claude --mcp-config`: the step tools, authenticated like the hooks. */
  mcpConfigJson(): string {
    const server = {
      type: 'http',
      url: `http://127.0.0.1:${this.port}/mcp`,
      headers: { 'X-Hub-Token': '${CLAUDE_HUB_TOKEN}', 'X-Hub-Session': '${CLAUDE_HUB_SESSION_ID}' }
    }
    return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)
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
    // The step tools only touch this session's steps, so they don't need a prompt each time.
    const allow = TOOLS.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`)
    return JSON.stringify({ hooks, permissions: { allow } }, null, 2)
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
