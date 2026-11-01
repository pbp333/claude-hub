import { DockviewReact, themeDark, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import { useEffect } from 'react'
import type { UiCommand } from '../../shared/types'
import { Dialogs, goToNextNeedsYou } from './components/Dialogs'
import { DiffPanel, EditorPanel } from './components/EditorPanel'
import { FileTree } from './components/FileTree'
import { Sidebar } from './components/Sidebar'
import { TerminalPanel } from './components/TerminalPanel'
import { Welcome } from './components/Welcome'
import { getSession, useProject, useUi } from './store'
import { disposeTerminal } from './terminals'
import {
  activeSessionFromPanel,
  closeActivePanel,
  closeSessionPanel,
  openFile,
  openSession,
  retryPendingSession,
  saveLayout,
  setWorkspaceApi
} from './workspace'

const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  terminal: TerminalPanel as React.FunctionComponent<IDockviewPanelProps>,
  editor: EditorPanel as React.FunctionComponent<IDockviewPanelProps>,
  diff: DiffPanel as React.FunctionComponent<IDockviewPanelProps>
}

function Watermark() {
  return (
    <div className="watermark">
      <p>Pick a session on the left, or start a new one.</p>
      <p className="muted">
        <kbd>⌘/Ctrl T</kbd> new session · <kbd>⌘/Ctrl P</kbd> open file · <kbd>⌘/Ctrl ⇧ P</kbd> commands
      </p>
    </div>
  )
}

async function onReady(event: DockviewReadyEvent, projectId: string): Promise<void> {
  const api = event.api
  const layout = await window.hub.loadLayout(projectId)
  if (layout) {
    try {
      api.fromJSON(layout as Parameters<typeof api.fromJSON>[0])
    } catch {
      api.clear()
    }
    // Drop tabs for sessions that no longer exist or belong to another workspace.
    for (const panel of [...api.panels]) {
      const sessionId = panel.id.startsWith('session:') ? panel.id.slice(8) : undefined
      if (sessionId && getSession(sessionId)?.projectId !== projectId) panel.api.close()
    }
  }
  setWorkspaceApi(api)
  api.onDidLayoutChange(() => saveLayout())
  api.onDidActivePanelChange(({ panel }) => {
    const id = activeSessionFromPanel(panel)
    if (id !== useUi.getState().activeSessionId) useUi.getState().setActiveSession(id)
  })
  api.onDidRemovePanel((panel) => {
    // A terminal tab closed for good (not moved): its xterm can go; the process keeps running.
    if (panel.id.startsWith('session:') && !api.getPanel(panel.id)) disposeTerminal(panel.id.slice(8))
  })
  const id = activeSessionFromPanel(api.activePanel)
  if (id) useUi.getState().setActiveSession(id)
}

function handleCommand(cmd: UiCommand): void {
  const ui = useUi.getState()
  switch (cmd.type) {
    case 'newSession':
      return ui.openDialog({ type: 'newSession' })
    case 'quickOpen':
      return ui.openDialog({ type: 'palette', mode: 'files' })
    case 'commandPalette':
      return ui.openDialog({ type: 'palette', mode: 'commands' })
    case 'toggleFileTree':
      return ui.toggleFileTree()
    case 'closeTab':
      return closeActivePanel()
    case 'nextNeedsYou':
      return goToNextNeedsYou()
    case 'nextStep':
      if (ui.activeSessionId) window.hub.nextStep(ui.activeSessionId)
      return
    case 'focusSession':
      return openSession(cmd.sessionId)
    case 'switchSession': {
      const id = ui.sidebarOrder[cmd.index]
      if (id) openSession(id)
      return
    }
    case 'openFile':
      return openFile(cmd.path, { line: cmd.line, column: cmd.column })
    case 'rename':
      return ui.openDialog({ type: 'rename', sessionId: cmd.sessionId })
  }
}

export function App() {
  const hub = useUi((s) => s.hub)
  const project = useProject()
  const fileTreeVisible = useUi((s) => s.fileTreeVisible)

  useEffect(() => {
    void window.hub.getState().then((state) => {
      useUi.getState().setHub(state)
      retryPendingSession()
    })
    void window.hub.windowInfo().then((info) => useUi.getState().setProject(info.projectId))
    const offWindow = window.hub.onWindowInfo((info) => {
      if (info.projectId !== useUi.getState().projectId) {
        setWorkspaceApi(undefined)
        useUi.getState().setProject(info.projectId)
      }
    })
    const offState = window.hub.onState((state) => {
      const prev = useUi.getState().hub
      useUi.getState().setHub(state)
      retryPendingSession()
      // Close tabs of sessions that were removed.
      for (const s of prev?.sessions ?? []) {
        if (!state.sessions.some((x) => x.id === s.id)) {
          closeSessionPanel(s.id)
          disposeTerminal(s.id)
        }
      }
    })
    const offCommand = window.hub.onCommand(handleCommand)
    return () => {
      offWindow()
      offState()
      offCommand()
    }
  }, [])

  if (!hub) return null
  if (!project) return <Welcome />
  return (
    <div className={`app${fileTreeVisible ? ' with-tree' : ''}`}>
      <Sidebar />
      <main className="workspace">
        {/* Keyed by workspace: opening another folder in this window starts a fresh layout. */}
        <DockviewReact
            key={project.id}
            components={components}
            onReady={(e) => void onReady(e, project.id)}
            theme={themeDark}
            watermarkComponent={Watermark}
            defaultRenderer="always"
          />
      </main>
      {fileTreeVisible && <FileTree />}
      <Dialogs />
    </div>
  )
}
