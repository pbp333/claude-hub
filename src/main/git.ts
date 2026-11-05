import { existsSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { GitStatus, PrCondition, PrInfo } from '../shared/types'
import { run as runCommand } from './env'

/**
 * Settings forced on every git (and gh, which runs git) call. A repo's own .git/config can
 * name programs for git to run, e.g. core.fsmonitor on every `git status`; opening a folder
 * from an archive must not run them. Command-line config (here via GIT_CONFIG_*) wins over
 * the repo's. No optional locks also keeps background `git status` from fighting the
 * user's own commits over index.lock.
 */
const SAFE_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'protocol.ext.allow',
  GIT_CONFIG_VALUE_1: 'never'
}

function run(command: 'git' | 'gh', args: string[], cwd: string, timeout?: number) {
  return runCommand(command, args, cwd, timeout, SAFE_GIT_ENV)
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 5000)
  return r.ok ? r.stdout.trim() || undefined : undefined
}

/** Folders that never hold repos worth finding and are slow to scan. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'out', 'target', '.gradle', 'Pods', '.expo', '.next', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'DerivedData', '.cache', 'coverage'
])

export const toPosix = (p: string) => p.replace(/\\/g, '/')

const repoCache = new Map<string, { repos: string[]; at: number }>()

/**
 * Git repos in a workspace: the workspace itself if it is one, otherwise repos up to two
 * levels down (~/code/web-app, ~/code/clients/api). Cached briefly; paths use forward slashes.
 */
export async function findRepos(workspace: string, maxAgeMs = 10000): Promise<string[]> {
  const root = toPosix(workspace).replace(/\/$/, '')
  const cached = repoCache.get(root)
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.repos
  const repos: string[] = []
  const isRepo = (dir: string) => existsSync(`${dir}/.git`)
  if (isRepo(root)) repos.push(root)
  else {
    const scan = async (dir: string, depth: number) => {
      let entries: Dirent[] = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        const child = `${dir}/${e.name}`
        if (isRepo(child)) repos.push(child)
        else if (depth < 2) await scan(child, depth + 1)
      }
    }
    await scan(root, 1)
  }
  repos.sort()
  repoCache.set(root, { repos, at: Date.now() })
  return repos
}

/** The repo (from `repos`) that contains `path`, picking the deepest match. */
export function repoFor(repos: string[], path: string): string | undefined {
  const p = toPosix(path)
  let best: string | undefined
  for (const r of repos) if ((p === r || p.startsWith(r + '/')) && (!best || r.length > best.length)) best = r
  return best
}

async function repoStatus(root: string, status: GitStatus): Promise<void> {
  const r = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, 10000)
  if (!r.ok) return
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const rel = entry.slice(3)
    if (code[0] === 'R' || code[0] === 'C') i++ // rename or copy: the next part is the old path
    status[`${root}/${rel}`] =
      code === '??' ? '?' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : code.includes('U') ? 'U' : 'M'
  }
}

/**
 * Changed files in every repo of the workspace, keyed by absolute path with forward slashes,
 * plus each parent folder up to the workspace marked 'M' so the tree shows where changes are.
 */
export async function gitStatus(workspace: string): Promise<GitStatus> {
  const root = toPosix(workspace).replace(/\/$/, '')
  const status: GitStatus = {}
  await Promise.all((await findRepos(root)).map((repo) => repoStatus(repo, status)))
  for (const file of Object.keys(status)) {
    let dir = file.slice(0, file.lastIndexOf('/'))
    while (dir.length > root.length && !status[dir]) {
      status[dir] = 'M'
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }
  return status
}

/** File content at HEAD, for the diff view. Empty string for new files. */
export async function headContent(path: string): Promise<string> {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  // "HEAD:./name" is relative to the cwd, so symlinked or differently-cased paths to the
  // repo still find the file (slicing off `git rev-parse --show-toplevel` did not).
  const r = await run('git', ['show', `HEAD:./${path.slice(cut + 1)}`], path.slice(0, cut) || '/', 10000)
  return r.ok ? r.stdout : ''
}

/**
 * Files for quick open, relative to the workspace with forward slashes: each repo's tracked
 * and untracked (not ignored) files, plus files outside any repo (skipping build folders).
 */
export async function listFiles(workspace: string, limit = 50000): Promise<string[]> {
  const root = toPosix(workspace).replace(/\/$/, '')
  const repos = await findRepos(root)
  const out: string[] = []
  await Promise.all(
    repos.map(async (repo) => {
      const r = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], repo, 15000)
      if (!r.ok) return
      const prefix = repo === root ? '' : repo.slice(root.length + 1) + '/'
      for (const f of r.stdout.split('\n')) if (f) out.push(prefix + f)
    })
  )
  if (!repos.includes(root)) {
    const repoSet = new Set(repos)
    const walk = async (dir: string, depth: number) => {
      if (out.length >= limit || depth > 4) return
      let entries: Dirent[] = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const child = `${dir}/${e.name}`
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !repoSet.has(child)) await walk(child, depth + 1)
        } else if (e.name !== '.DS_Store') out.push(child.slice(root.length + 1))
      }
    }
    await walk(root, 1)
  }
  return out.slice(0, limit).sort()
}

interface GhPr {
  number: number
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string
  reviews?: { author?: { login?: string }; state?: string }[]
  statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]
}

/** Runs `gh pr view` for the branch checked out in `cwd`. Undefined = no PR (or gh unavailable). */
export async function fetchPr(cwd: string, botLogins: string[]): Promise<{ pr?: PrInfo; error?: string }> {
  const r = await run(
    'gh',
    ['pr', 'view', '--json', 'number,state,isDraft,reviews,reviewDecision,statusCheckRollup,url'],
    cwd,
    20000
  )
  if (!r.ok) {
    if (/no pull requests found/i.test(r.stderr)) return {}
    return { error: r.stderr.trim() || 'gh failed' }
  }
  let data: GhPr
  try {
    data = JSON.parse(r.stdout) as GhPr
  } catch {
    return { error: 'gh returned unexpected output' }
  }
  return {
    pr: {
      number: data.number,
      url: data.url,
      state: data.state,
      isDraft: data.isDraft,
      reviewDecision: data.reviewDecision ?? '',
      conditions: prConditions(data, botLogins),
      checkedAt: new Date().toISOString()
    }
  }
}

export function prConditions(data: GhPr, botLogins: string[]): PrCondition[] {
  const conditions: PrCondition[] = []
  if (data.state === 'OPEN') conditions.push('prOpen')
  if (data.state === 'MERGED') conditions.push('merged')
  if (data.isDraft) conditions.push('draft')
  const bots = new Set(botLogins.map((l) => l.toLowerCase()))
  if ((data.reviews ?? []).some((r) => isBot(r.author?.login ?? '', bots))) conditions.push('botReviewed')
  if (data.reviewDecision === 'APPROVED') conditions.push('approved')
  if (data.reviewDecision === 'CHANGES_REQUESTED') conditions.push('changesRequested')
  const checks = data.statusCheckRollup ?? []
  const failed = checks.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? c.state ?? ''))
  const pending = checks.some((c) => c.status && c.status !== 'COMPLETED')
  if (failed) conditions.push('ciFailing')
  else if (checks.length && !pending) conditions.push('ciPassing')
  return conditions
}

function isBot(login: string, bots: Set<string>): boolean {
  const l = login.toLowerCase()
  return l.endsWith('[bot]') || bots.has(l)
}
