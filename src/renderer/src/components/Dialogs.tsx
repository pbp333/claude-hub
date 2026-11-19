import { useEffect, useMemo, useRef, useState } from 'react'
import { parseStepsInput, stepName, stepsInputText } from '../../../shared/steps'
import { needsAttention } from '../../../shared/tags'
import type { SessionKind } from '../../../shared/types'
import { errorMessage } from '../errors'
import { getSession, useProject, useSession, useUi } from '../store'
import { closeActivePanel, openFile, openSession } from '../workspace'

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

export function Dialogs() {
  const dialog = useUi((s) => s.dialog)
  const openDialog = useUi((s) => s.openDialog)
  const close = () => openDialog(undefined)
  if (!dialog) return null
  if (dialog.type === 'newSession') return <NewSessionDialog onClose={close} />
  if (dialog.type === 'rename') return <RenameDialog sessionId={dialog.sessionId} onClose={close} />
  if (dialog.type === 'steps') return <StepsDialog sessionId={dialog.sessionId} onClose={close} />
  return <Palette mode={dialog.mode} onClose={close} />
}

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const project = useProject()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SessionKind>('claude')
  const [steps, setSteps] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!project || busy) return
    setBusy(true)
    let id: string
    try {
      const list = parseStepsInput(steps)
      id = await window.hub.createSession({ projectId: project.id, name, kind, steps: list.length ? list : undefined })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
      return
    }
    onClose()
    // The session appears with the next state push; open its tab once it exists.
    const open = () => (getSession(id) ? openSession(id) : setTimeout(open, 30))
    open()
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="form">
        <h2>New session</h2>
        <p className="muted form-note" title={project?.path}>
          Starts in <strong>{project?.name}</strong>, so Claude sees every repo in it and loads its CLAUDE.md and skills.
        </p>
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the folder name" autoFocus />
        </label>
        <label>
          Run
          <select value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
            <option value="claude">Claude Code</option>
            <option value="shell">Plain shell</option>
          </select>
        </label>
        <label>
          Steps (optional)
          <StepsInput value={steps} onChange={setSteps} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!project || busy}>
            Start
          </button>
        </div>
      </form>
    </Modal>
  )
}

function StepsInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <>
      <textarea
        className="steps-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        autoFocus={autoFocus}
        placeholder={'One step per line, or just a number (e.g. 4).\nClaude can also set them: /hub:steps'}
      />
    </>
  )
}

/** Edit a session's steps: names one per line, or a count. */
function StepsDialog({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const activeId = useUi((s) => s.activeSessionId)
  const id = sessionId ?? activeId
  const session = useSession(id)
  const [text, setText] = useState(() => stepsInputText(session?.steps))
  if (!session) return null
  const parsed = parseStepsInput(text)
  return (
    <Modal onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          window.hub.setSteps(session.id, parsed)
          onClose()
        }}
      >
        <h2>Steps for {session.name}</h2>
        <StepsInput value={text} onChange={setText} autoFocus />
        <p className="muted form-note">
          {parsed.length
            ? `${parsed.length} step${parsed.length === 1 ? '' : 's'}: ${parsed.map((_, i) => stepName(parsed, i)).join(' → ')}`
            : 'No steps. Saving clears them.'}
        </p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}

function RenameDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const session = useSession(sessionId)
  const [name, setName] = useState(session?.name ?? '')
  return (
    <Modal onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          window.hub.renameSession(sessionId, name)
          onClose()
        }}
      >
        <h2>Rename session</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Rename
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface PaletteItem {
  label: string
  detail?: string
  run: () => void
}

/** Subsequence match, scored so consecutive and early matches rank first. */
function score(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let ti = 0
  let total = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    streak = found === ti ? streak + 1 : 0
    total += 1 + streak * 2 - found * 0.001
    ti = found + 1
  }
  return total
}

export function commandItems(): PaletteItem[] {
  const ui = useUi.getState()
  const session = getSession(ui.activeSessionId)
  const editConfig = (file: string) => async () => {
    const path = await window.hub.configPath(file)
    if (path) openFile(path)
  }
  const items: PaletteItem[] = [
    { label: 'New session', run: () => ui.openDialog({ type: 'newSession' }) },
    { label: 'Open folder…', run: () => window.hub.openFolder() },
    { label: 'Show history', detail: 'past Claude conversations', run: () => ui.setSidebarTab('history') },
    { label: 'New window', run: () => window.hub.newWindow() },
    { label: 'Go to next session that needs me', run: () => goToNextNeedsYou() },
    { label: 'Toggle file tree', run: () => ui.toggleFileTree() },
    { label: 'Close tab', run: () => closeActivePanel() },
    { label: 'Edit tags', detail: 'tags.json', run: editConfig('tags.json') },
    { label: 'Edit GitHub rules', detail: 'rules.json', run: editConfig('rules.json') },
    { label: 'Edit settings', detail: 'settings.json', run: editConfig('settings.json') }
  ]
  if (session) {
    items.push(
      { label: 'Rename session', detail: session.name, run: () => ui.openDialog({ type: 'rename', sessionId: session.id }) },
      { label: session.running ? 'Restart session' : 'Resume session', detail: session.name, run: () => window.hub.restartSession(session.id) },
      { label: 'Session menu (tags, steps)', detail: session.name, run: () => window.hub.sessionMenu(session.id) },
      { label: session.steps ? 'Edit steps' : 'Add steps', detail: session.name, run: () => ui.openDialog({ type: 'steps', sessionId: session.id }) }
    )
    const steps = session.steps ?? []
    if (steps.length) {
      items.push(
        { label: 'Next step', detail: session.name, run: () => window.hub.moveStep(session.id, 'next') },
        { label: 'Previous step', detail: session.name, run: () => window.hub.moveStep(session.id, 'back') }
      )
      steps.forEach((_, i) =>
        items.push({ label: `Go to step ${i + 1}: ${stepName(steps, i)}`, detail: session.name, run: () => window.hub.goToStep(session.id, i) })
      )
    }
    for (const repo of session.repos)
      if (repo.pr) items.push({ label: `Open PR #${repo.pr.number} (${repo.name})`, run: () => window.hub.openExternal(repo.pr!.url) })
    for (const tag of ui.hub?.tags ?? [])
      items.push({ label: `Toggle tag: ${tag.name}`, detail: session.name, run: () => window.hub.toggleTag(session.id, tag.id) })
  }
  for (const s of (ui.hub?.sessions ?? []).filter((x) => x.projectId === ui.projectId && !x.archived))
    items.push({ label: `Go to session: ${s.name}`, run: () => openSession(s.id) })
  return items
}

export function goToNextNeedsYou(): void {
  const { sidebarOrder, activeSessionId, hub } = useUi.getState()
  const wanting = new Set(
    (hub?.sessions ?? []).filter(needsAttention).map((s) => s.id)
  )
  const start = activeSessionId ? sidebarOrder.indexOf(activeSessionId) : -1
  for (let i = 1; i <= sidebarOrder.length; i++) {
    const id = sidebarOrder[(start + i) % sidebarOrder.length]
    if (wanting.has(id)) return openSession(id)
  }
}

function Palette({ mode, onClose }: { mode: 'files' | 'commands'; onClose: () => void }) {
  const project = useProject()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [files, setFiles] = useState<string[]>()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode !== 'files' || !project) return
    void window.hub.listFiles(project.path).then(setFiles)
  }, [mode, project?.path])

  const items = useMemo<PaletteItem[]>(() => {
    if (mode === 'commands') return commandItems()
    if (!project) return []
    const sep = project.path.includes('\\') ? '\\' : '/'
    return (files ?? []).map((rel) => ({
      label: rel,
      run: () => openFile(project.path + sep + (sep === '\\' ? rel.replace(/\//g, '\\') : rel))
    }))
  }, [mode, files, project])

  const results = useMemo(
    () =>
      items
        .map((item) => ({ item, s: score(query, item.label) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 200)
        .map((r) => r.item),
    [items, query]
  )

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  function run(item: PaletteItem | undefined) {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <Modal onClose={onClose}>
      <div className="palette">
        <input
          autoFocus
          value={query}
          placeholder={mode === 'files' ? 'Open file by name' : 'Type a command'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(results[selected])
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {mode === 'files' && !files && <div className="muted pad">Loading files…</div>}
          {results.map((item, i) => (
            <div
              key={item.label + i}
              className={i === selected ? 'palette-item selected' : 'palette-item'}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(item)}
            >
              <span>{item.label}</span>
              {item.detail && <span className="muted">{item.detail}</span>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
