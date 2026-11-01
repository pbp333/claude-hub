import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
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
      const path = isAbsolute(clean) ? clean : resolve(cwd, clean.replace(/^~(?=[/\\])/, process.env.HOME ?? '~'))
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
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
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

  constructor(private onChange: (paths: string[]) => void) {}

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
    this.pending.add(path)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const paths = [...this.pending]
      this.pending.clear()
      this.onChange(paths)
    }, 200)
  }

  close(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}
