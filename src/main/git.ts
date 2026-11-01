import type { GitStatus, PrCondition, PrInfo } from '../shared/types'
import { run } from './env'

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 5000)
  return r.ok ? r.stdout.trim() || undefined : undefined
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await run('git', ['rev-parse', '--show-toplevel'], cwd, 5000)
  return r.ok ? r.stdout.trim() || undefined : undefined
}

/** Changed files keyed by absolute path (forward slashes on every OS), plus every parent folder marked 'M' so the tree shows where changes are. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repoRoot(cwd)
  if (!root) return {}
  const r = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, 10000)
  if (!r.ok) return {}
  const status: GitStatus = {}
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const rel = entry.slice(3)
    if (code[0] === 'R') i++ // rename: the next part is the old path
    const mark: GitStatus[string] =
      code === '??' ? '?' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : code.includes('U') ? 'U' : 'M'
    const abs = `${root}/${rel}`
    status[abs] = mark
    let dir = abs.slice(0, abs.lastIndexOf('/'))
    while (dir.length > root.length && !status[dir]) {
      status[dir] = 'M'
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }
  return status
}

/** File content at HEAD, for the diff view. Empty string for new files. */
export async function headContent(path: string): Promise<string> {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  const root = await repoRoot(dir)
  if (!root) return ''
  const rel = path.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1)
  const r = await run('git', ['show', `HEAD:${rel}`], root, 10000)
  return r.ok ? r.stdout : ''
}

/** Tracked and untracked (not ignored) files, for quick open. */
export async function listFiles(cwd: string): Promise<string[] | undefined> {
  const r = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], cwd, 10000)
  if (!r.ok) return undefined
  return r.stdout.split('\n').filter(Boolean)
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
  const data = JSON.parse(r.stdout) as GhPr
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
