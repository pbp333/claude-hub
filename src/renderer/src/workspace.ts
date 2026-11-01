import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { getProject, getSession, useUi } from './store'

let api: DockviewApi | undefined
/** A session to open once the workspace (dockview) is ready, e.g. from a notification click. */
let pendingSession: string | undefined
const listeners = new Set<(path: string, line?: number, column?: number) => void>()

export function setWorkspaceApi(next: DockviewApi | undefined): void {
  api = next
  retryPendingSession()
}

/** Called when the workspace or the session list becomes ready. */
export function retryPendingSession(): void {
  if (!api || !pendingSession) return
  const id = pendingSession
  pendingSession = undefined
  openSession(id)
}

export function sessionPanelId(sessionId: string): string {
  return `session:${sessionId}`
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function openSession(sessionId: string): void {
  if (!api || !getSession(sessionId)) {
    pendingSession = sessionId
    return
  }
  const id = sessionPanelId(sessionId)
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return
  }
  const session = getSession(sessionId)
  api.addPanel({
    id,
    component: 'terminal',
    title: session?.name ?? 'Session',
    params: { sessionId },
    // New sessions open next to the active terminal group, not inside an editor group.
    position: activeTerminalGroupReference()
  })
}

export function closeSessionPanel(sessionId: string): void {
  api?.getPanel(sessionPanelId(sessionId))?.api.close()
}

export function renameSessionPanel(sessionId: string, title: string): void {
  const panel = api?.getPanel(sessionPanelId(sessionId))
  if (panel && panel.title !== title) panel.api.setTitle(title)
}

/** Opens a file in an editor tab, or focuses it and jumps to the line if it is already open. */
export function openFile(path: string, opts: { line?: number; column?: number; diff?: boolean } = {}): void {
  if (!api) return
  const id = `${opts.diff ? 'diff' : 'file'}:${path}`
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
    if (opts.line) for (const l of listeners) l(path, opts.line, opts.column)
    return
  }
  api.addPanel({
    id,
    component: opts.diff ? 'diff' : 'editor',
    title: opts.diff ? `${fileName(path)} (diff)` : fileName(path),
    params: { path, line: opts.line, column: opts.column },
    position: editorPosition()
  })
}

/** Editors subscribe so a repeated open of the same file can jump to a new line. */
export function onRevealRequest(cb: (path: string, line?: number, column?: number) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function closeActivePanel(): void {
  api?.activePanel?.api.close()
}

export function saveLayout(): void {
  const project = getProject()
  if (api && project) window.hub.saveLayout(project.id, api.toJSON())
}

function isTerminal(panel: IDockviewPanel | undefined): boolean {
  return !!panel && panel.id.startsWith('session:')
}

function activeTerminalGroupReference() {
  const active = api?.activePanel
  if (isTerminal(active)) return { referenceGroup: active!.group }
  const terminal = api?.panels.find(isTerminal)
  return terminal ? { referenceGroup: terminal.group } : undefined
}

/** Files open beside the terminals: in an existing editor group, else in a new group on the right. */
function editorPosition() {
  const editor = api?.panels.find((p) => !isTerminal(p))
  if (editor) return { referenceGroup: editor.group }
  const terminal = api?.activePanel ?? api?.panels[0]
  return terminal ? { referencePanel: terminal.id, direction: 'right' as const } : undefined
}

export function activeSessionFromPanel(panel: IDockviewPanel | undefined): string | undefined {
  if (!panel) return useUi.getState().activeSessionId
  return isTerminal(panel) ? panel.id.slice('session:'.length) : useUi.getState().activeSessionId
}
