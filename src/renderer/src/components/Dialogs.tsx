import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionKind } from '../../../shared/types'
import { getSession, useSession, useUi } from '../store'
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
  return <Palette mode={dialog.mode} onClose={close} />
}

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const hub = useUi((s) => s.hub)
  const [cwd, setCwd] = useState(hub?.recentFolders[0] ?? '')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SessionKind>('claude')
  const [jobTypeId, setJobTypeId] = useState(() => localStorage.getItem('lastJobType') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function pick() {
    const folder = await window.hub.pickFolder()
    if (folder) setCwd(folder)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!cwd || busy) return
    setBusy(true)
    try {
      localStorage.setItem('lastJobType', jobTypeId)
    } catch {
      // storage unavailable
    }
    let id: string
    try {
      id = await window.hub.createSession({ cwd, name, kind, jobTypeId: jobTypeId || undefined })
    } catch (err) {
      // Electron prefixes errors thrown in the main process; show only the message.
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
      return
    }
    onClose()
    // The session appears with the next state push; open its tab once it exists.
    const open = () => (getSession(id) ? openSession(id) : setTimeout(open, 30))
    open()
  }

  const job = hub?.jobTypes.find((j) => j.id === jobTypeId)
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="form">
        <h2>New session</h2>
        <label>
          Folder
          <div className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" autoFocus />
            <button type="button" onClick={pick}>
              Choose…
            </button>
          </div>
        </label>
        {!!hub?.recentFolders.length && (
          <div className="recent">
            {hub.recentFolders.slice(0, 6).map((f) => (
              <button type="button" key={f} className={f === cwd ? 'chip on' : 'chip'} onClick={() => setCwd(f)} title={f}>
                {f.split(/[\\/]/).pop()}
              </button>
            ))}
          </div>
        )}
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the project name" />
        </label>
        <label>
          Run
          <select value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
            <option value="claude">Claude Code</option>
            <option value="shell">Plain shell</option>
          </select>
        </label>
        {kind === 'claude' && (
          <label>
            Job type
            <select value={jobTypeId} onChange={(e) => setJobTypeId(e.target.value)}>
              <option value="">None</option>
              {hub?.jobTypes.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'claude' && job && (
          <ol className="steps-preview">
            {job.steps.map((s) => (
              <li key={s.id}>
                {s.name}
                {s.advanceOn && s.advanceOn !== 'manual' && (
                  <span className="muted">
                    {' '}
                    · moves on {s.advanceOn === 'stop' ? 'when Claude finishes' : `on GitHub: ${s.advanceOn.github}`}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!cwd || busy}>
            Start
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
    { label: 'Go to next session that needs me', run: () => goToNextNeedsYou() },
    { label: 'Toggle file tree', run: () => ui.toggleFileTree() },
    { label: 'Close tab', run: () => closeActivePanel() },
    { label: 'Edit job types', detail: 'jobTypes.json', run: editConfig('jobTypes.json') },
    { label: 'Edit tags', detail: 'tags.json', run: editConfig('tags.json') },
    { label: 'Edit GitHub rules', detail: 'rules.json', run: editConfig('rules.json') },
    { label: 'Edit settings', detail: 'settings.json', run: editConfig('settings.json') }
  ]
  if (session) {
    items.push(
      { label: 'Rename session', detail: session.name, run: () => ui.openDialog({ type: 'rename', sessionId: session.id }) },
      { label: session.running ? 'Restart session' : 'Resume session', detail: session.name, run: () => window.hub.restartSession(session.id) },
      { label: 'Session menu (tags, job type, steps)', detail: session.name, run: () => window.hub.sessionMenu(session.id) }
    )
    if (session.steps) {
      items.push({ label: 'Next step', detail: session.name, run: () => window.hub.nextStep(session.id) })
      for (const step of session.steps)
        items.push({ label: `Go to step: ${step.name}`, detail: session.name, run: () => window.hub.setStep(session.id, step.id) })
    }
    if (session.pr) items.push({ label: `Open PR #${session.pr.number}`, run: () => window.hub.openExternal(session.pr!.url) })
    for (const tag of ui.hub?.tags ?? [])
      items.push({ label: `Toggle tag: ${tag.name}`, detail: session.name, run: () => window.hub.toggleTag(session.id, tag.id) })
  }
  for (const s of ui.hub?.sessions ?? [])
    items.push({ label: `Go to session: ${s.name}`, run: () => openSession(s.id) })
  return items
}

export function goToNextNeedsYou(): void {
  const { sidebarOrder, activeSessionId, hub } = useUi.getState()
  const wanting = new Set(
    (hub?.sessions ?? []).filter((s) => s.attentionState === 'needs-you' || (s.attentionState === 'done' && s.unread)).map((s) => s.id)
  )
  const start = activeSessionId ? sidebarOrder.indexOf(activeSessionId) : -1
  for (let i = 1; i <= sidebarOrder.length; i++) {
    const id = sidebarOrder[(start + i) % sidebarOrder.length]
    if (wanting.has(id)) return openSession(id)
  }
}

function Palette({ mode, onClose }: { mode: 'files' | 'commands'; onClose: () => void }) {
  const activeSessionId = useUi((s) => s.activeSessionId)
  const session = useSession(activeSessionId)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [files, setFiles] = useState<string[]>()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode !== 'files' || !session) return
    void window.hub.listFiles(session.cwd).then((f) => setFiles(f ?? []))
  }, [mode, session?.cwd])

  const items = useMemo<PaletteItem[]>(() => {
    if (mode === 'commands') return commandItems()
    if (!session) return []
    const sep = session.cwd.includes('\\') ? '\\' : '/'
    return (files ?? []).map((rel) => ({
      label: rel,
      run: () => openFile(session.cwd + sep + (sep === '\\' ? rel.replace(/\//g, '\\') : rel))
    }))
  }, [mode, files, session])

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
          placeholder={mode === 'files' ? (session ? 'Open file by name' : 'Open a session first') : 'Type a command'}
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
          {mode === 'files' && session && !files && <div className="muted pad">Loading files…</div>}
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
