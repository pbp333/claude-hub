import type { IDockviewPanelProps } from 'dockview-react'
import { useEffect, useRef } from 'react'
import { useSession } from '../store'
import { attachTerminal, fitTerminal } from '../terminals'

export function TerminalPanel({ params, api }: IDockviewPanelProps<{ sessionId: string }>) {
  const ref = useRef<HTMLDivElement>(null)
  const session = useSession(params.sessionId)

  useEffect(() => {
    const container = ref.current!
    const entry = attachTerminal(params.sessionId, container)
    const observer = new ResizeObserver(() => fitTerminal(params.sessionId))
    observer.observe(container)
    const focus = api.onDidActiveChange(({ isActive }) => {
      if (isActive) {
        fitTerminal(params.sessionId)
        entry.term.focus()
      }
    })
    requestAnimationFrame(() => {
      fitTerminal(params.sessionId)
      if (api.isActive) entry.term.focus()
    })
    return () => {
      observer.disconnect()
      focus.dispose()
      // Keep the terminal alive: the panel may only be moving to another group.
      if (entry.element.parentElement === container) container.removeChild(entry.element)
    }
  }, [params.sessionId, api])

  useEffect(() => {
    if (session && api.title !== session.name) api.setTitle(session.name)
  }, [session?.name, api])

  return (
    <div className="terminal-panel">
      <div ref={ref} className="terminal-container" />
      {session && !session.running && (
        <div className="terminal-exited">
          <span>Session exited.</span>
          <button onClick={() => window.hub.restartSession(session.id)}>
            {session.kind === 'claude' && session.claudeSessionId ? 'Resume' : 'Start again'}
          </button>
        </div>
      )}
    </div>
  )
}
