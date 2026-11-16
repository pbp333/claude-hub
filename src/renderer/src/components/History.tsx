import { useCallback, useEffect, useMemo, useState } from 'react'
import { effectiveTags } from '../../../shared/tags'
import type { HistoryItem, Session } from '../../../shared/types'
import { errorMessage } from '../errors'
import { useProject, useUi } from '../store'
import { openTranscript } from '../workspace'

const REFRESH_MS = 20000

export function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** The hub session that ran a conversation, if any. */
export function hubSessionFor(sessions: Session[], claudeSessionId: string): Session | undefined {
  return sessions.find((s) => s.claudeSessionId === claudeSessionId || s.claudeSessionIds?.includes(claudeSessionId))
}

/** Claude conversations recorded for the open folder, including ones started outside the hub. */
export function HistoryList() {
  const project = useProject()
  const hub = useUi((s) => s.hub)
  const [items, setItems] = useState<HistoryItem[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')

  const refresh = useCallback(() => {
    if (!project) return
    window.hub
      .listHistory(project.id)
      .then((list) => {
        setItems(list)
        setError(undefined)
      })
      .catch((err) => setError(errorMessage(err)))
  }, [project?.id])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const sessions = useMemo(() => (hub?.sessions ?? []).filter((s) => s.projectId === project?.id), [hub, project?.id])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!items || !q) return items ?? []
    return items.filter((item) => {
      const owner = hubSessionFor(sessions, item.claudeSessionId)
      return [item.title, item.firstPrompt ?? '', item.branch ?? '', owner?.name ?? '', owner?.jobTypeName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [items, query, sessions])

  if (!project || !hub) return null
  return (
    <>
      <div className="history-toolbar">
        <input className="sidebar-filter" placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={refresh} title="Refresh">
          ↻
        </button>
      </div>
      <div className="session-list">
        {error && <div className="empty">{error}</div>}
        {!items && !error && <div className="empty">Reading transcripts…</div>}
        {items && items.length === 0 && (
          <div className="empty">No Claude conversations recorded for {project.name} yet.</div>
        )}
        {items && items.length > 0 && visible.length === 0 && <div className="empty">Nothing matches "{query}".</div>}
        {visible.map((item) => {
          const owner = hubSessionFor(sessions, item.claudeSessionId)
          const live = owner && !owner.archived && owner.running && owner.claudeSessionId === item.claudeSessionId
          const tags = owner ? effectiveTags(owner, hub.tags) : []
          return (
            <div
              key={item.claudeSessionId}
              className="history-row"
              onClick={() => openTranscript(item.claudeSessionId, item.title)}
              title={item.firstPrompt}
            >
              <div className="history-title">
                {live && <span className="dot working" title="Running now" />}
                <span>{item.title}</span>
              </div>
              <div className="session-sub">
                {relativeTime(item.endedAt)} · {duration(item.activeMs)} active · {item.messages} messages
                {item.branch ? ` · ${item.branch}` : ''}
              </div>
              {owner && (
                <div className="session-sub">
                  {owner.archived ? 'Closed session' : 'Session'} "{owner.name}"
                  {owner.jobTypeName ? ` · ${owner.jobTypeName}` : ''}
                </div>
              )}
              {tags.length > 0 && (
                <div className="session-tags">
                  {tags.map(({ tag, source }) => (
                    <span key={tag.id} className={`tag ${source}`} style={{ borderColor: tag.color, color: tag.color }}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
