import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import type { HistoryItem, Transcript, TranscriptEntry } from '../shared/types'

/**
 * Reads Claude Code's own conversation transcripts (~/.claude/projects/<folder>/<id>.jsonl)
 * for the History tab. Read-only: the app never writes these files.
 */

const MAX_TEXT = 20000
const MAX_TOOL_TEXT = 4000
const MAX_ENTRIES = 4000
/** A pause longer than this between messages counts as time away, not time in the conversation. */
const ACTIVE_GAP_MS = 30 * 60 * 1000

export function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
}

/** Claude Code names a project's transcript folder after its path, every non-alphanumeric character as "-". */
export function encodeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Transcript folders for a workspace: its own, plus those of sessions started in a subfolder.
 * The folder name is lossy (apps-old also starts with "apps-"), so a candidate counts only if
 * its transcripts' recorded cwd really is the workspace or inside it.
 */
async function workspaceDirs(projectsDir: string, root: string): Promise<string[]> {
  const own = encodeProjectPath(root)
  let names: string[]
  try {
    names = await readdir(projectsDir)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const name of names) {
    if (name !== own && !name.startsWith(own + '-')) continue
    const dir = join(projectsDir, name)
    if (name === own) {
      dirs.push(dir)
      continue
    }
    const file = (await transcriptFiles(dir))[0]
    const cwd = file && (await summarize(file))?.cwd
    if (cwd && inside(root, cwd)) dirs.push(dir)
  }
  return dirs
}

async function transcriptFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => /^[0-9a-f-]{36}\.jsonl$/i.test(f)).map((f) => join(dir, f))
  } catch {
    return []
  }
}

async function* records(file: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') yield value as Record<string, unknown>
    } catch {
      // a partly written last line
    }
  }
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** What a user record says, without system reminders; slash commands as "/name args". */
function userText(record: Record<string, unknown>): { text: string; command: boolean } | undefined {
  if (record.isMeta) return undefined
  const content = (record.message as { content?: unknown } | undefined)?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content))
    text = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  text = text.replace(REMINDER, '').trim()
  if (!text) return undefined
  const command = text.match(/<command-name>([^<]*)<\/command-name>/)
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
    return { text: `${command[1].trim()}${args ? ' ' + args : ''}`, command: true }
  }
  if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-input)>/.test(text)) return undefined
  return { text, command: false }
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '…' : s)

interface Cached {
  mtimeMs: number
  size: number
  item: HistoryItem
}
const summaries = new Map<string, Cached>()

/** One transcript's list entry, cached until the file changes. */
async function summarize(file: string): Promise<HistoryItem | undefined> {
  let info
  try {
    info = await stat(file)
  } catch {
    return undefined
  }
  const cached = summaries.get(file)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.item
  const id = file.slice(-42, -6)
  let title: string | undefined
  let aiTitle: string | undefined
  let firstPrompt: string | undefined
  let startedAt: string | undefined
  let endedAt: string | undefined
  let cwd: string | undefined
  let branch: string | undefined
  let messages = 0
  let activeMs = 0
  let lastMs: number | undefined
  for await (const r of records(file)) {
    if (r.isSidechain) continue
    const at = typeof r.timestamp === 'string' ? r.timestamp : undefined
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') title = r.customTitle
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') aiTitle = r.aiTitle
    if (r.type === 'summary' && typeof r.summary === 'string') aiTitle ??= r.summary
    if (r.type !== 'user' && r.type !== 'assistant') continue
    if (at) {
      startedAt ??= at
      endedAt = at
      const ms = Date.parse(at)
      if (lastMs !== undefined && ms - lastMs > 0 && ms - lastMs < ACTIVE_GAP_MS) activeMs += ms - lastMs
      if (!Number.isNaN(ms)) lastMs = ms
    }
    if (!cwd && typeof r.cwd === 'string') cwd = r.cwd
    if (typeof r.gitBranch === 'string' && r.gitBranch !== 'HEAD') branch = r.gitBranch
    if (r.type === 'assistant') messages++
    else {
      const u = userText(r)
      if (u) {
        messages++
        if (!firstPrompt && !u.command) firstPrompt = clip(u.text.replace(/\s+/g, ' '), 300)
      }
    }
  }
  if (!messages) return undefined
  const item: HistoryItem = {
    claudeSessionId: id,
    title: title || aiTitle || firstPrompt || 'Untitled conversation',
    firstPrompt,
    startedAt: startedAt ?? info.mtime.toISOString(),
    endedAt: endedAt ?? info.mtime.toISOString(),
    messages,
    activeMs,
    branch,
    cwd: cwd ?? '',
    sizeBytes: info.size
  }
  summaries.set(file, { mtimeMs: info.mtimeMs, size: info.size, item })
  return item
}

/** Every Claude conversation recorded for this workspace, newest first. */
export async function listHistory(projectsDir: string, root: string): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []
  for (const dir of await workspaceDirs(projectsDir, root)) {
    for (const file of await transcriptFiles(dir)) {
      const item = await summarize(file)
      if (item) items.push(item)
    }
  }
  return items.sort((a, b) => b.endedAt.localeCompare(a.endedAt))
}

async function findTranscript(projectsDir: string, root: string, claudeSessionId: string): Promise<string | undefined> {
  for (const dir of await workspaceDirs(projectsDir, root)) {
    const file = join(dir, `${claudeSessionId}.jsonl`)
    try {
      if ((await stat(file)).isFile()) return file
    } catch {
      // not in this folder
    }
  }
  return undefined
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined
  const summary =
    pick('command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'path', 'prompt') ??
    Object.values(input).find((v) => typeof v === 'string')
  return summary ? clip(String(summary).replace(/\s+/g, ' '), 200) : ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  return ''
}

/** Turns a transcript file into display entries: prompts, replies, tool calls with their results. */
async function parseTranscript(file: string, sidechain: boolean): Promise<{ entries: TranscriptEntry[]; truncated: boolean; title?: string }> {
  let entries: TranscriptEntry[] = []
  let truncated = false
  let title: string | undefined
  const tools = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>()
  const push = (e: TranscriptEntry) => {
    entries.push(e)
    // Keep the most recent part of very long conversations.
    if (entries.length > MAX_ENTRIES * 1.25) {
      entries = entries.slice(-MAX_ENTRIES)
      truncated = true
    }
  }
  for await (const r of records(file)) {
    if (!sidechain && r.isSidechain) continue
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') title = r.customTitle
    const at = typeof r.timestamp === 'string' ? r.timestamp : ''
    const content = (r.message as { content?: unknown } | undefined)?.content
    if (r.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const last = entries[entries.length - 1]
          if (last?.kind === 'assistant') last.text = clip(last.text + '\n\n' + block.text, MAX_TEXT)
          else push({ kind: 'assistant', text: clip(block.text, MAX_TEXT), at })
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          const input = (block.input ?? {}) as Record<string, unknown>
          const entry: Extract<TranscriptEntry, { kind: 'tool' }> = {
            kind: 'tool',
            name: block.name,
            summary: toolSummary(block.name, input),
            input: clip(JSON.stringify(input, null, 2), MAX_TOOL_TEXT),
            at
          }
          if (typeof block.id === 'string') tools.set(block.id, entry)
          push(entry)
        }
      }
    } else if (r.type === 'user') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue
          const tool = tools.get(block.tool_use_id)
          if (!tool) continue
          tool.result = clip(resultText(block.content), MAX_TOOL_TEXT)
          tool.isError = !!block.is_error
          const agentId = (r.toolUseResult as { agentId?: unknown } | undefined)?.agentId
          if (typeof agentId === 'string' && /^[\w-]{1,64}$/.test(agentId)) tool.agentId = agentId
        }
      }
      const u = userText(r)
      if (u) push({ kind: u.command ? 'command' : 'user', text: clip(u.text, MAX_TEXT), at })
    }
  }
  return { entries, truncated, title }
}

export async function readTranscript(projectsDir: string, root: string, claudeSessionId: string): Promise<Transcript | undefined> {
  const file = await findTranscript(projectsDir, root, claudeSessionId)
  if (!file) return undefined
  const [summary, parsed] = await Promise.all([summarize(file), parseTranscript(file, false)])
  return {
    claudeSessionId,
    title: summary?.title ?? parsed.title ?? 'Conversation',
    startedAt: summary?.startedAt,
    branch: summary?.branch,
    entries: parsed.entries,
    truncated: parsed.truncated
  }
}

/** A subagent's own transcript, stored next to its parent conversation. */
export async function readSubagent(
  projectsDir: string,
  root: string,
  claudeSessionId: string,
  agentId: string
): Promise<TranscriptEntry[] | undefined> {
  const parent = await findTranscript(projectsDir, root, claudeSessionId)
  if (!parent) return undefined
  const file = join(parent.slice(0, -6), 'subagents', `agent-${agentId}.jsonl`)
  try {
    await stat(file)
  } catch {
    return undefined
  }
  return (await parseTranscript(file, true)).entries
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

/** How alike a session name and a conversation title are, from 0 to 1. */
export function titleSimilarity(name: string, title: string): number {
  const a = words(name)
  const b = words(title)
  if (!a.length || !b.length) return 0
  if (a.join(' ') === b.join(' ')) return 1
  const setB = new Set(b)
  const shared = a.filter((w) => setB.has(w)).length
  // The name inside the title ("login bug" in "Fix the login bug on Safari") counts almost as a match.
  if (shared === a.length && a.length >= 2) return 0.9
  return (2 * shared) / (a.length + b.length)
}

/** Below this, a title isn't taken as the conversation the session name refers to. */
export const MATCH_THRESHOLD = 0.6

/**
 * The conversation whose title is closest to a session name, the newest one on a tie.
 * Conversations in `exclude` (already running in another session) are skipped.
 */
export function closestConversation(items: HistoryItem[], name: string, exclude: Set<string>): HistoryItem | undefined {
  let best: HistoryItem | undefined
  let bestScore = MATCH_THRESHOLD
  for (const item of items) {
    if (exclude.has(item.claudeSessionId)) continue
    const score = titleSimilarity(name, item.title)
    if (score > bestScore || (score === bestScore && best && item.endedAt > best.endedAt) || (score === bestScore && !best)) {
      best = item
      bestScore = score
    }
  }
  return best
}
