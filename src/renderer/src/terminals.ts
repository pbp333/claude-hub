import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ILink } from '@xterm/xterm'
import { findPathCandidates } from './filePaths'
import { getSession, useUi } from './store'
import { openFile } from './workspace'

interface Entry {
  term: Terminal
  fit: FitAddon
  /** Stays attached to the terminal; moved between panel containers as tabs move. */
  element: HTMLDivElement
  live: boolean
  /** Loaded on first attach (see attachTerminal); undefined = not yet, null = unavailable. */
  webgl?: WebglAddon | null
  /** True while old output is being replayed; xterm's automatic replies to it must not reach the process. */
  replaying: boolean
}

const terminals = new Map<string, Entry>()
const resolved = new Map<string, { path?: string; at: number }>()
const RESOLVE_TTL = 5000

window.hub.onPtyData((id, data) => {
  const entry = terminals.get(id)
  if (entry?.live) entry.term.write(data)
})

export function getTerminal(sessionId: string): Entry {
  let entry = terminals.get(sessionId)
  if (entry) return entry
  const settings = useUi.getState().hub?.settings
  const term = new Terminal({
    fontFamily: settings?.terminalFont ?? 'Menlo, monospace',
    fontSize: settings?.terminalFontSize ?? 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: { background: '#1e1e1e' }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.hub.openExternal(uri)))
  const element = document.createElement('div')
  element.className = 'terminal-host'
  term.open(element)
  term.onData((data) => {
    // Replayed output contains the CLI's old terminal queries; answering them now would send
    // stray escape sequences (read as an Esc key press) into whatever the CLI is showing.
    if (!terminals.get(sessionId)?.replaying) window.hub.ptyWrite(sessionId, data)
  })
  term.onResize(({ cols, rows }) => window.hub.ptyResize(sessionId, cols, rows))
  term.registerLinkProvider({ provideLinks: (y, cb) => void provideFileLinks(sessionId, term, y, cb) })
  entry = { term, fit, element, live: false, replaying: false }
  terminals.set(sessionId, entry)
  // Replay what the process printed before this view existed. IPC keeps order, so any
  // live chunk that arrives before this reply is already in the buffer.
  void window.hub.ptyBuffer(sessionId).then((buffer) => {
    const e = terminals.get(sessionId)
    if (!e) return
    e.replaying = true
    e.live = true
    e.term.write(buffer, () => (e.replaying = false))
  })
  return entry
}

/**
 * Puts the session's terminal in a panel. With `terminalWebgl` on, the WebGL renderer is
 * loaded only now, once the element is on the page, so it measures real cells.
 */
export function attachTerminal(sessionId: string, container: HTMLElement): Entry {
  const entry = getTerminal(sessionId)
  container.appendChild(entry.element)
  if (entry.webgl === undefined && !useUi.getState().hub?.settings.terminalWebgl) entry.webgl = null
  if (entry.webgl === undefined) {
    requestAnimationFrame(() => {
      if (entry.webgl !== undefined || !entry.element.isConnected) return
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          entry.webgl = null
        })
        entry.term.loadAddon(webgl)
        entry.webgl = webgl
      } catch {
        entry.webgl = null // DOM renderer
      }
    })
  }
  return entry
}

// Moving the window to a display with another pixel ratio leaves WebGL's glyphs blurry or
// mis-sized; rebuild them.
function watchPixelRatio(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      for (const entry of terminals.values()) entry.webgl?.clearTextureAtlas()
      watchPixelRatio()
    },
    { once: true }
  )
}
watchPixelRatio()

export function disposeTerminal(sessionId: string): void {
  terminals.get(sessionId)?.term.dispose()
  terminals.delete(sessionId)
}

export function fitTerminal(sessionId: string): void {
  const entry = terminals.get(sessionId)
  if (!entry || !entry.element.isConnected || entry.element.clientWidth === 0) return
  try {
    entry.fit.fit()
    window.hub.ptyResize(sessionId, entry.term.cols, entry.term.rows)
  } catch {
    // not laid out yet
  }
}

async function provideFileLinks(
  sessionId: string,
  term: Terminal,
  y: number,
  callback: (links: ILink[] | undefined) => void
): Promise<void> {
  const session = getSession(sessionId)
  const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
  const matches = session ? findPathCandidates(text) : []
  if (!session || !matches.length) return callback(undefined)

  const now = Date.now()
  const unknown = [...new Set(matches.map((m) => m.path))].filter((p) => {
    const hit = resolved.get(`${session.cwd}\0${p}`)
    return !hit || now - hit.at > RESOLVE_TTL
  })
  if (unknown.length) {
    const found = await window.hub.resolveLinks(session.cwd, unknown)
    const byText = new Map(found.map((f) => [f.text, f.path]))
    for (const p of unknown) resolved.set(`${session.cwd}\0${p}`, { path: byText.get(p), at: now })
  }

  const links: ILink[] = []
  for (const m of matches) {
    const path = resolved.get(`${session.cwd}\0${m.path}`)?.path
    if (!path) continue
    links.push({
      text: m.text,
      range: { start: { x: m.index + 1, y }, end: { x: m.index + m.text.length, y } },
      decorations: { underline: true, pointerCursor: true },
      activate: (event) => {
        if (event.metaKey || event.ctrlKey) openFile(path, { line: m.line, column: m.column })
      }
    })
  }
  callback(links.length ? links : undefined)
}
