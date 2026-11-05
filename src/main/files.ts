import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DirEntry } from '../shared/types'

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store'])

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function readText(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB')
  return readFile(path, 'utf8')
}

export async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
}

export interface ResolvedLink {
  text: string
  path: string
}

/**
 * Resolves candidate paths printed in a terminal against the session's folder. Only files
 * that exist are returned, so the terminal never links words that only look like paths.
 */
export async function resolveLinks(cwd: string, candidates: string[]): Promise<ResolvedLink[]> {
  const found: ResolvedLink[] = []
  await Promise.all(
    candidates.map(async (text) => {
      const clean = text.replace(/^["'(]+|["'),.;:]+$/g, '')
      const path = isAbsolute(clean) ? clean : resolve(cwd, clean.replace(/^~(?=[/\\])/, homedir()))
      try {
        if ((await stat(path)).isFile()) found.push({ text, path })
      } catch {
        // not a file
      }
    })
  )
  return found
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The real path of `path` if it lies inside one of `roots` (after resolving symlinks, so a
 * link inside a workspace can't reach outside it), else undefined. A file that doesn't exist
 * yet is checked by its folder.
 */
export async function resolveInside(path: string, roots: string[]): Promise<string | undefined> {
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined
  let real: string
  try {
    real = await realpath(path)
  } catch {
    try {
      real = join(await realpath(dirname(path)), basename(path))
    } catch {
      return undefined
    }
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      continue
    }
    if (isInside(realRoot, real)) return real
  }
  return undefined
}

const IGNORED_SEGMENT = /(^|[\\/])(node_modules|build|dist|out|target|\.gradle|Pods|\.expo|\.next|\.venv|DerivedData|\.cache)([\\/]|$)/

/**
 * Watches workspace folders and reports changed paths (debounced, batched). Uses the OS's
 * recursive watcher (FSEvents on macOS, ReadDirectoryChangesW on Windows), so a large folder
 * with many repos costs one handle. Inside .git only index and HEAD changes are reported,
 * which is enough to refresh git markers after a commit or checkout.
 */
export class FolderWatcher {
  private watchers = new Map<string, FSWatcher>()
  private pending = new Set<string>()
  private timer?: NodeJS.Timeout
  private firstPendingAt = 0
  private onChange: (paths: string[]) => void

  constructor(onChange: (paths: string[]) => void) {
    this.onChange = onChange
  }

  setFolders(folders: string[]): void {
    const wanted = new Set(folders)
    for (const [dir, w] of this.watchers) {
      if (!wanted.has(dir)) {
        w.close()
        this.watchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue
      try {
        const w = watch(dir, { recursive: true }, (_event, file) => {
          if (!file) return
          const rel = String(file)
          if (IGNORED_SEGMENT.test(rel)) return
          const gitIndex = rel.match(/(^|[\\/])\.git[\\/](.*)$/)
          if (gitIndex && !/^(index|HEAD)$/.test(gitIndex[2])) return
          this.queue(join(dir, rel))
        })
        w.on('error', () => undefined)
        this.watchers.set(dir, w)
      } catch {
        // folder gone or not watchable
      }
    }
  }

  private queue(path: string): void {
    if (!this.pending.size) this.firstPendingAt = Date.now()
    this.pending.add(path)
    clearTimeout(this.timer)
    // Wait for a quiet 200 ms, but never more than 1 s: a file written constantly (a log)
    // would otherwise hold every update back forever.
    const wait = Math.max(0, Math.min(200, this.firstPendingAt + 1000 - Date.now()))
    this.timer = setTimeout(() => {
      const paths = [...this.pending]
      this.pending.clear()
      this.onChange(paths)
    }, wait)
  }

  close(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}
