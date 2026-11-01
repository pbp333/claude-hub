import { useCallback, useEffect, useState } from 'react'
import type { DirEntry, GitStatus } from '../../../shared/types'
import { useProject } from '../store'
import { openFile } from '../workspace'

const norm = (p: string) => p.replace(/\\/g, '/')

export function FileTree() {
  const root = useProject()?.path
  const [status, setStatus] = useState<GitStatus>({})
  const [version, setVersion] = useState(0)

  const refresh = useCallback(() => {
    if (!root) return
    void window.hub.gitStatus(root).then(setStatus)
    setVersion((v) => v + 1)
  }, [root])

  useEffect(() => {
    refresh()
    if (!root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = window.hub.onFsChanged((paths) => {
      if (!paths.some((p) => p.startsWith(root))) return
      // Git markers follow commits and checkouts (.git/index, .git/HEAD) too.
      clearTimeout(timer)
      timer = setTimeout(refresh, 300)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [root, refresh])

  if (!root) return <aside className="file-tree" />
  return (
    <aside className="file-tree">
      <div className="file-tree-header" title={root}>
        {root.split(/[\\/]/).pop()}
      </div>
      <div className="file-tree-body">
        <DirNode key={root} path={root} depth={0} status={status} version={version} initiallyOpen />
      </div>
    </aside>
  )
}

function DirNode(props: { path: string; depth: number; status: GitStatus; version: number; initiallyOpen?: boolean }) {
  const { path, depth, status, version } = props
  const [open, setOpen] = useState(!!props.initiallyOpen)
  const [entries, setEntries] = useState<DirEntry[]>()

  useEffect(() => {
    if (!open) return
    window.hub
      .listDir(path)
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [open, path, version])

  const name = path.split(/[\\/]/).pop()
  const mark = status[norm(path)]
  return (
    <div>
      {depth > 0 && (
        <div className={`tree-row dir${mark ? ' changed' : ''}`} style={{ paddingLeft: depth * 12 }} onClick={() => setOpen(!open)}>
          <span className="twisty">{open ? '▾' : '▸'}</span>
          {name}
        </div>
      )}
      {open &&
        entries?.map((e) =>
          e.isDir ? (
            <DirNode key={e.path} path={e.path} depth={depth + 1} status={status} version={version} />
          ) : (
            <FileRow key={e.path} entry={e} depth={depth + 1} mark={status[norm(e.path)]} />
          )
        )}
    </div>
  )
}

function FileRow({ entry, depth, mark }: { entry: DirEntry; depth: number; mark?: string }) {
  return (
    <div
      className={`tree-row file${mark ? ` git-${mark === '?' ? 'U' : mark}` : ''}`}
      style={{ paddingLeft: depth * 12 + 12 }}
      onClick={() => openFile(entry.path)}
      title={entry.path}
    >
      <span className="tree-name">{entry.name}</span>
      {mark && <span className="git-mark">{mark === '?' ? 'U' : mark}</span>}
    </div>
  )
}
