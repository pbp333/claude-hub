import type { IDockviewPanelProps } from 'dockview-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Transcript, TranscriptEntry } from '../../../shared/types'
import { errorMessage } from '../errors'
import { useProject, useUi } from '../store'
import { openSession } from '../workspace'
import { hubSessionFor, relativeTime } from './History'

interface Params {
  claudeSessionId: string
  title: string
}

/** **bold** and `code` inside a line, as React nodes (never HTML, so transcripts can't inject markup). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : (
          p
        )
      )}
    </>
  )
}

/** Text with ``` fences shown as code blocks; everything else keeps its line breaks. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <pre key={i} className="code">
            {part.replace(/\n$/, '')}
          </pre>
        ) : (
          part.trim() && (
            <div key={i} className="prose">
              <Inline text={part.trim()} />
            </div>
          )
        )
      )}
    </>
  )
}

function Subagent({ projectId, claudeSessionId, agentId }: { projectId: string; claudeSessionId: string; agentId: string }) {
  const [entries, setEntries] = useState<TranscriptEntry[] | null>()
  const [error, setError] = useState<string>()
  if (entries === undefined)
    return (
      <button
        className="subagent-load"
        onClick={() => {
          setEntries(null)
          window.hub
            .readSubagent(projectId, claudeSessionId, agentId)
            .then((e) => setEntries(e ?? []))
            .catch((err) => setError(errorMessage(err)))
        }}
      >
        Show the subagent's conversation
      </button>
    )
  if (error) return <div className="muted">{error}</div>
  if (entries === null) return <div className="muted">Loading…</div>
  return (
    <div className="subagent">
      {entries.length ? <Entries entries={entries} projectId={projectId} claudeSessionId={claudeSessionId} /> : <div className="muted">Empty.</div>}
    </div>
  )
}

function Entries({ entries, projectId, claudeSessionId }: { entries: TranscriptEntry[]; projectId: string; claudeSessionId: string }) {
  return (
    <>
      {entries.map((e, i) => {
        if (e.kind === 'tool')
          return (
            <details key={i} className={`entry tool${e.isError ? ' error' : ''}`}>
              <summary>
                <span className="tool-name">{e.name}</span> <span className="tool-summary">{e.summary}</span>
                {e.isError && <span className="tool-error">error</span>}
              </summary>
              <div className="tool-body">
                <div className="tool-label">Input</div>
                <pre className="code">{e.input}</pre>
                {e.result !== undefined && (
                  <>
                    <div className="tool-label">Result</div>
                    <pre className="code">{e.result || '(empty)'}</pre>
                  </>
                )}
                {e.agentId && <Subagent projectId={projectId} claudeSessionId={claudeSessionId} agentId={e.agentId} />}
              </div>
            </details>
          )
        return (
          <div key={i} className={`entry ${e.kind}`}>
            <div className="entry-who">
              {e.kind === 'user' ? 'You' : e.kind === 'command' ? 'Command' : 'Claude'}
              {e.at && <span className="muted"> · {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
            <RichText text={e.text} />
          </div>
        )
      })}
    </>
  )
}

function StepTimeline({ session }: { session: Session }) {
  if (!session.steps?.length || !session.stepHistory.length) return null
  const names = new Map(session.steps.map((s) => [s.id, s.name]))
  return (
    <div className="step-timeline">
      {session.stepHistory.map((h, i) => {
        const next = session.stepHistory[i + 1]?.enteredAt ?? session.closedAt ?? new Date().toISOString()
        const minutes = Math.max(0, Math.round((new Date(next).getTime() - new Date(h.enteredAt).getTime()) / 60000))
        return (
          <span key={i} className="step-chip">
            {names.get(h.stepId) ?? h.stepId} <span className="muted">{minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`}</span>
          </span>
        )
      })}
    </div>
  )
}

/** A read-only view of one Claude conversation, from its transcript file. */
export function TranscriptPanel({ params, api }: IDockviewPanelProps<Params>) {
  const project = useProject()
  const owner = useUi((s) => (s.hub ? hubSessionFor(s.hub.sessions, params.claudeSessionId) : undefined))
  const [transcript, setTranscript] = useState<Transcript | null>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const live = !!owner && !owner.archived && owner.running && owner.claudeSessionId === params.claudeSessionId

  const load = useCallback(() => {
    if (!project) return
    window.hub
      .readTranscript(project.id, params.claudeSessionId)
      .then((t) => {
        setTranscript(t ?? null)
        if (t && api.title !== t.title) api.setTitle(t.title.length > 40 ? t.title.slice(0, 40) + '…' : t.title)
      })
      .catch((err) => setError(errorMessage(err)))
  }, [project?.id, params.claudeSessionId, api])

  useEffect(load, [load])
  // A conversation still running keeps growing; refresh it while it's open.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [live, load])
  // Start at the end, where the latest exchange is.
  const scrolled = useRef(false)
  useEffect(() => {
    if (transcript && !scrolled.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
      scrolled.current = true
    }
  }, [transcript])

  async function resume() {
    if (!project) return
    try {
      const id = await window.hub.resumeHistory(project.id, params.claudeSessionId, transcript?.title ?? params.title)
      openSession(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="transcript-panel">
      <div className="transcript-header">
        <div className="transcript-title">{transcript?.title ?? params.title}</div>
        <div className="transcript-meta muted">
          {transcript?.startedAt && `Started ${relativeTime(transcript.startedAt)}`}
          {transcript?.branch && ` · ${transcript.branch}`}
          {owner && ` · ${owner.archived ? 'closed session' : 'session'} "${owner.name}"`}
          {owner?.jobTypeName && ` · ${owner.jobTypeName}`}
        </div>
        {owner && <StepTimeline session={owner} />}
        <div className="transcript-actions">
          <button className="primary" onClick={() => void resume()} title="Continue this conversation in a session (claude --resume)">
            {live ? 'Go to session' : 'Resume'}
          </button>
          <button onClick={load}>Refresh</button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(params.claudeSessionId)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            title={params.claudeSessionId}
          >
            {copied ? 'Copied' : 'Copy ID'}
          </button>
        </div>
      </div>
      <div className="transcript-body" ref={scroller}>
        {error && <div className="panel-error">{error}</div>}
        {transcript === undefined && !error && <div className="muted pad">Loading…</div>}
        {transcript === null && <div className="muted pad">This conversation's transcript wasn't found.</div>}
        {transcript?.truncated && <div className="muted pad">Long conversation: showing the latest part.</div>}
        {transcript && project && <Entries entries={transcript.entries} projectId={project.id} claudeSessionId={params.claudeSessionId} />}
      </div>
    </div>
  )
}
