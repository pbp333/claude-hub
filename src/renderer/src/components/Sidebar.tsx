import { useEffect, useMemo, useState } from 'react'
import { currentStep, effectiveTags, needsAttention } from '../../../shared/tags'
import type { AttentionState, HubState, Session } from '../../../shared/types'
import { useProject, useUi } from '../store'
import { openSession } from '../workspace'

const STATE_LABEL: Record<AttentionState, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  'needs-you': 'Needs you',
  done: 'Done, your turn',
  exited: 'Exited',
  active: 'Active',
  quiet: 'Quiet'
}

type GroupBy = 'none' | 'repo' | 'step' | string // string = a tag group name

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const na = needsAttention(a) ? 0 : 1
    const nb = needsAttention(b) ? 0 : 1
    if (na !== nb) return na - nb
    return b.lastActivityAt.localeCompare(a.lastActivityAt)
  })
}

function groupSessions(hub: HubState, sessions: Session[], groupBy: GroupBy): [string, Session[]][] {
  if (groupBy === 'none') return [['', sessions]]
  const groups = new Map<string, Session[]>()
  const add = (key: string, s: Session) => {
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  for (const s of sessions) {
    if (groupBy === 'repo') add(s.repos.map((r) => r.name).join(', ') || 'No repo yet', s)
    else if (groupBy === 'step') {
      const step = currentStep(s)
      add(step ? `${s.jobTypeName} · ${step.name}` : 'No job type', s)
    } else {
      const tag = effectiveTags(s, hub.tags).find((t) => t.tag.group === groupBy)
      add(tag?.tag.name ?? `No ${groupBy}`, s)
    }
  }
  return [...groups.entries()]
}

export function Sidebar() {
  const hub = useUi((s) => s.hub)
  const project = useProject()
  const activeSessionId = useUi((s) => s.activeSessionId)
  const openDialog = useUi((s) => s.openDialog)
  const setSidebarOrder = useUi((s) => s.setSidebarOrder)
  const [filter, setFilter] = useState('')
  const [quick, setQuick] = useState<string>('all')
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try {
      const saved = localStorage.getItem('groupBy')
      return saved && saved !== 'project' ? saved : 'none'
    } catch {
      return 'none'
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('groupBy', groupBy)
    } catch {
      // storage unavailable
    }
  }, [groupBy])

  const groups = useMemo(() => {
    if (!hub || !project) return []
    const text = filter.trim().toLowerCase()
    const visible = hub.sessions.filter((s) => {
      if (s.projectId !== project.id) return false
      const tags = effectiveTags(s, hub.tags)
      if (quick === 'needs-you' && !needsAttention(s)) return false
      if (quick.startsWith('tag:') && !tags.some((t) => t.tag.id === quick.slice(4))) return false
      if (!text) return true
      const repos = s.repos.flatMap((r) => [r.name, r.branch ?? ''])
      const haystack = [s.name, ...repos, currentStep(s)?.name ?? '', ...tags.map((t) => t.tag.name)]
      return haystack.join(' ').toLowerCase().includes(text)
    })
    return groupSessions(hub, sortSessions(visible), groupBy)
  }, [hub, project, filter, quick, groupBy])

  useEffect(() => {
    setSidebarOrder(groups.flatMap(([, list]) => list.map((s) => s.id)))
  }, [groups, setSidebarOrder])

  if (!hub || !project) return <aside className="sidebar" />
  const mine = hub.sessions.filter((s) => s.projectId === project.id)
  const overlaps = repoOverlaps(mine)
  const tagGroups = [...new Set(hub.tags.map((t) => t.group).filter((g): g is string => !!g))]
  const usedTags = hub.tags.filter((t) => mine.some((s) => effectiveTags(s, hub.tags).some((e) => e.tag.id === t.id)))
  const needCount = mine.filter(needsAttention).length

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title" title={project.path}>
          {project.name}
        </span>
        <button className="primary" onClick={() => openDialog({ type: 'newSession' })} title="New session">
          + New
        </button>
      </div>
      <input
        className="sidebar-filter"
        placeholder="Filter sessions"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="quick-filters">
        <button className={quick === 'all' ? 'chip on' : 'chip'} onClick={() => setQuick('all')}>
          All
        </button>
        <button className={quick === 'needs-you' ? 'chip on' : 'chip'} onClick={() => setQuick('needs-you')}>
          Needs you{needCount ? ` (${needCount})` : ''}
        </button>
        {usedTags.map((t) => (
          <button
            key={t.id}
            className={quick === `tag:${t.id}` ? 'chip on' : 'chip'}
            onClick={() => setQuick(quick === `tag:${t.id}` ? 'all' : `tag:${t.id}`)}
          >
            {t.name}
          </button>
        ))}
      </div>
      <label className="group-by">
        Group by
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <option value="none">Nothing</option>
          <option value="repo">Repo</option>
          <option value="step">Job step</option>
          {tagGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>
      <div className="session-list">
        {mine.length === 0 && (
          <div className="empty">
            No sessions yet. Press <kbd>+ New</kbd> to start Claude in {project.name}.
          </div>
        )}
        {groups.map(([name, list]) => (
          <div key={name} className="session-group">
            {name && <div className="group-name">{name}</div>}
            {list.map((s) => (
              <SessionRow key={s.id} hub={hub} session={s} active={s.id === activeSessionId} overlaps={overlaps.get(s.id)} />
            ))}
          </div>
        ))}
      </div>
      {hub.configErrors.length > 0 && (
        <div className="config-errors">
          <strong>Config problems</strong>
          {hub.configErrors.slice(0, 5).map((e, i) => (
            <div key={i}>
              {e.file}: {e.message}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

/** For each running session, the other running sessions that have touched the same repos. */
function repoOverlaps(sessions: Session[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const running = sessions.filter((s) => s.running)
  for (const s of running) {
    const notes: string[] = []
    for (const other of running) {
      if (other.id === s.id) continue
      const shared = s.repos.filter((r) => other.repos.some((o) => o.path === r.path)).map((r) => r.name)
      if (shared.length) notes.push(`${shared.join(', ')} (also in "${other.name}")`)
    }
    if (notes.length) out.set(s.id, notes)
  }
  return out
}

/** The PR behind a GitHub tag: the first repo whose PR meets a rule that sets this tag. */
function prForTag(hub: HubState, s: Session, tagId: string): string | undefined {
  const conditions = new Set(hub.rules.filter((r) => r.setTag === tagId).map((r) => r.when))
  return s.repos.find((r) => r.pr?.conditions.some((c) => conditions.has(c)))?.pr?.url
}

function SessionRow({ hub, session: s, active, overlaps }: { hub: HubState; session: Session; active: boolean; overlaps?: string[] }) {
  const step = currentStep(s)
  const stepIndex = s.steps && step ? s.steps.indexOf(step) : -1
  const tags = effectiveTags(s, hub.tags)
  const isLast = s.steps ? stepIndex === s.steps.length - 1 : true

  return (
    <div
      className={`session-row${active ? ' active' : ''}${s.unread ? ' unread' : ''}`}
      onClick={() => openSession(s.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        window.hub.sessionMenu(s.id)
      }}
    >
      <span className={`dot ${s.attentionState}`} title={STATE_LABEL[s.attentionState]} />
      <div className="session-main">
        <div className="session-name">
          {s.name}
          {s.kind === 'shell' && <span className="kind">shell</span>}
        </div>
        <div className="session-sub">{STATE_LABEL[s.attentionState]}</div>
        {s.repos.length > 0 && (
          <div className="session-repos" title={s.repos.map((r) => r.path).join('\n')}>
            {s.repos.map((r) => (
              <span key={r.path}>
                {r.name}
                {r.branch && <span className="muted"> ({r.branch})</span>}
              </span>
            ))}
          </div>
        )}
        {overlaps && (
          <div className="session-overlap" title="Two sessions editing the same repo can overwrite each other's changes.">
            ⚠ Shared: {overlaps.join('; ')}
          </div>
        )}
        {step && s.steps && (
          <div className="session-step">
            <span>
              {s.jobTypeName} · {stepIndex + 1}/{s.steps.length} {step.name}
            </span>
            {!isLast && (
              <button
                className="step-next"
                title="Next step"
                onClick={(e) => {
                  e.stopPropagation()
                  window.hub.nextStep(s.id)
                }}
              >
                Next ›
              </button>
            )}
            <div className="progress">
              <div style={{ width: `${((stepIndex + 1) / s.steps.length) * 100}%` }} />
            </div>
          </div>
        )}
        {tags.length > 0 && (
          <div className="session-tags">
            {tags.map(({ tag, source }) => (
              <span
                key={tag.id}
                className={`tag ${source}`}
                style={{ borderColor: tag.color, color: tag.color }}
                title={source === 'auto' ? 'From GitHub, click to open the PR' : source === 'step' ? 'Set by the current step' : 'Manual tag'}
                onClick={(e) => {
                  const url = source === 'auto' ? prForTag(hub, s, tag.id) : undefined
                  if (url) {
                    e.stopPropagation()
                    window.hub.openExternal(url)
                  }
                }}
              >
                {tag.name}
                {source === 'auto' && ' ↗'}
              </span>
            ))}
          </div>
        )}
      </div>
      {!s.running && (
        <button
          className="resume"
          title={s.claudeSessionId ? 'Resume the Claude conversation' : 'Start again'}
          onClick={(e) => {
            e.stopPropagation()
            window.hub.restartSession(s.id)
            openSession(s.id)
          }}
        >
          {s.kind === 'claude' && s.claudeSessionId ? 'Resume' : 'Start'}
        </button>
      )}
    </div>
  )
}
