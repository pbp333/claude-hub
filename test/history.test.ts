import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeProjectPath, listHistory, readSubagent, readTranscript } from '../src/main/history.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function setup() {
  const projects = mkdtempSync(join(tmpdir(), 'hub-history-'))
  const root = '/work/apps'
  const own = join(projects, encodeProjectPath(root))
  mkdirSync(own)
  writeFileSync(
    join(own, `${A}.jsonl`),
    jsonl([
      { type: 'user', isMeta: true, message: { content: 'meta stuff' }, timestamp: '2026-01-01T10:00:00Z', cwd: root },
      { type: 'user', message: { content: '<system-reminder>ignore</system-reminder>Fix the login bug' }, timestamp: '2026-01-01T10:00:01Z', cwd: root, gitBranch: 'fix/login' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] }, timestamp: '2026-01-01T10:00:02Z' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all good' }] }, timestamp: '2026-01-01T10:00:03Z' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { description: 'review' } }] }, timestamp: '2026-01-01T10:00:04Z' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'launched' }] }] }, toolUseResult: { agentId: 'abc123' }, timestamp: '2026-01-01T10:00:05Z' },
      { type: 'user', message: { content: '<command-name>/compact</command-name><command-args></command-args>' }, timestamp: '2026-01-01T10:05:00Z' },
      { type: 'custom-title', customTitle: 'Login bug', sessionId: A }
    ])
  )
  mkdirSync(join(own, A, 'subagents'), { recursive: true })
  writeFileSync(
    join(own, A, 'subagents', 'agent-abc123.jsonl'),
    jsonl([
      { type: 'user', isSidechain: true, message: { content: 'Review the diff' }, timestamp: '2026-01-01T10:00:04Z' },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Looks fine.' }] }, timestamp: '2026-01-01T10:00:09Z' }
    ])
  )
  // A session started in a subfolder of the workspace: included.
  const sub = join(projects, encodeProjectPath(`${root}/web`))
  mkdirSync(sub)
  writeFileSync(join(sub, `${B}.jsonl`), jsonl([{ type: 'user', message: { content: 'Style the header' }, timestamp: '2026-01-02T09:00:00Z', cwd: `${root}/web` }]))
  // Another folder whose encoded name merely starts the same ("/work/apps-old"): excluded.
  const other = join(projects, encodeProjectPath('/work/apps-old'))
  mkdirSync(other)
  writeFileSync(join(other, `${C}.jsonl`), jsonl([{ type: 'user', message: { content: 'Old project' }, timestamp: '2026-01-03T09:00:00Z', cwd: '/work/apps-old' }]))
  return { projects, root }
}

test('lists conversations of the workspace and its subfolders, newest first', async () => {
  const { projects, root } = setup()
  const items = await listHistory(projects, root)
  assert.deepEqual(items.map((i) => i.claudeSessionId), [B, A])
  const a = items.find((i) => i.claudeSessionId === A)!
  assert.equal(a.title, 'Login bug')
  assert.equal(a.firstPrompt, 'Fix the login bug')
  assert.equal(a.branch, 'fix/login')
  // 10:00:00 → 10:05:00: every gap is under 30 minutes, so all of it counts.
  assert.equal(a.activeMs, 300000)
  assert.equal(a.messages, 4, '2 prompts (one a command) + 2 assistant records')
  assert.equal(items.find((i) => i.claudeSessionId === B)!.title, 'Style the header', 'no title: first prompt')
})

test('reads a transcript with tool results and subagent links', async () => {
  const { projects, root } = setup()
  const t = await readTranscript(projects, root, A)
  assert.ok(t)
  assert.deepEqual(
    t.entries.map((e) => e.kind),
    ['user', 'assistant', 'tool', 'tool', 'command']
  )
  const [, , bash, agent, command] = t.entries
  assert.equal(bash.kind === 'tool' && bash.result, 'all good')
  assert.equal(agent.kind === 'tool' && agent.agentId, 'abc123')
  assert.equal(command.kind === 'command' && command.text, '/compact')
  const sub = await readSubagent(projects, root, A, 'abc123')
  assert.deepEqual(sub?.map((e) => e.kind), ['user', 'assistant'])
})

test('does not read conversations of other folders', async () => {
  const { projects, root } = setup()
  assert.equal(await readTranscript(projects, root, C), undefined)
})
