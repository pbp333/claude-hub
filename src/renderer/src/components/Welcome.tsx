import { useUi } from '../store'

/** Shown in a window with no folder open. */
export function Welcome() {
  const recent = useUi((s) => s.hub?.recentFolders ?? [])
  return (
    <div className="welcome">
      <div className="welcome-box">
        <h1>Claude Hub</h1>
        <p className="muted">
          Open a folder to work in. Every session starts there, so Claude sees all of its repos and loads its CLAUDE.md
          and skills.
        </p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => window.hub.openFolder()}>
            Open Folder…
          </button>
          <button onClick={() => window.hub.newWindow()}>New Window</button>
        </div>
        {recent.length > 0 && (
          <>
            <h2>Recent</h2>
            <ul className="recent-list">
              {recent.slice(0, 10).map((folder) => (
                <li key={folder}>
                  <button className="link" onClick={() => window.hub.openRecent(folder)} title={folder}>
                    <span>{folder.split(/[\\/]/).pop()}</span>
                    <span className="muted">{folder}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">
          <kbd>⌘/Ctrl O</kbd> open folder · <kbd>⌘/Ctrl ⇧ N</kbd> new window
        </p>
      </div>
    </div>
  )
}
