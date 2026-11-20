import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { HookServer } from '../src/main/hooks.ts'
import {
  applyStepTool,
  applyTagTool,
  describeSteps,
  describeTags,
  handleRpc,
  invokedSkill,
  skillContext,
  stepContext,
  type StepChange
} from '../src/main/stepTools.ts'
import { parseStepsInput, progressLabel, stepsInputText } from '../src/shared/steps.ts'

const plan = { steps: ['Reproduce', 'Fix', 'Test'], currentStep: 1 }

test('steps typed by the user: names one per line, or a count', () => {
  assert.deepEqual(parseStepsInput(' Plan \n\n  Build it  \nShip'), ['Plan', 'Build it', 'Ship'])
  assert.deepEqual(parseStepsInput('4'), ['', '', '', ''])
  assert.deepEqual(parseStepsInput('500').length, 30)
  assert.deepEqual(parseStepsInput('  '), [])
  assert.equal(stepsInputText(['', '', '']), '3')
  assert.equal(stepsInputText(['A', 'B']), 'A\nB')
  assert.equal(progressLabel(plan), '2/3 Fix')
  assert.equal(progressLabel({ steps: ['', ''], currentStep: 0 }), '1/2')
  assert.equal(progressLabel({ steps: ['A'], currentStep: 1 }), 'Done 1/1')
  assert.equal(progressLabel({ steps: [] }), undefined)
})

test('Claude sets steps, completes them, and jumps between them', () => {
  const set = applyStepTool({}, 'set_steps', { steps: ['Plan', ' ', 'Build'], current: 2 }) as StepChange
  assert.deepEqual([set.steps, set.currentStep], [['Plan', 'Build'], 1])
  assert.equal(typeof applyStepTool({}, 'set_steps', { steps: [] }), 'string')
  assert.equal(typeof applyStepTool({}, 'set_steps', { steps: 'Plan' }), 'string')
  assert.equal(typeof applyStepTool({}, 'complete_step', {}), 'string', 'no steps yet')
  const done = applyStepTool(plan, 'complete_step', { note: ' fixed it ' }) as StepChange
  assert.deepEqual([done.currentStep, done.note], [2, 'fixed it'])
  assert.ok(done.text.includes('step 3 of 3: Test'))
  const last = applyStepTool({ ...plan, currentStep: 2 }, 'complete_step', {}) as StepChange
  assert.equal(last.currentStep, 3)
  assert.ok(last.text.includes('all steps are done'))
  assert.equal(typeof applyStepTool({ ...plan, currentStep: 3 }, 'complete_step', {}), 'string', 'already done')
  assert.equal((applyStepTool(plan, 'set_step', { step: 1 }) as StepChange).currentStep, 0)
  assert.equal(typeof applyStepTool(plan, 'set_step', { step: 4 }), 'string')
  const keep = applyStepTool(plan, 'set_steps', { steps: ['A', 'B', 'C', 'D'] }) as StepChange
  assert.equal(keep.currentStep, 1, 'keeps the current step')
})

test('prompts carry the current step while steps remain', () => {
  assert.ok(stepContext(plan)?.includes('step 2 of 3: Fix'))
  assert.equal(stepContext({ ...plan, currentStep: 3 }), undefined)
  assert.equal(stepContext({}), undefined)
  assert.ok(describeSteps(plan).includes('→ 2. Fix'))
  assert.ok(describeSteps({ steps: ['', ''], currentStep: 0 }).includes('1. Step 1'))
})

test('MCP messages: initialize, list, call, notifications, unknown methods', () => {
  const call = () => ({ text: 'hi' })
  const init = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, call) as {
    result: { protocolVersion: string }
  }
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, call), undefined)
  const list = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, call) as { result: { tools: { name: string }[] } }
  assert.deepEqual(list.result.tools.map((t) => t.name), ['get_steps', 'set_steps', 'complete_step', 'set_step', 'get_tags', 'set_tags'])
  const result = handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_steps' } }, call) as {
    result: { content: { text: string }[] }
  }
  assert.equal(result.result.content[0].text, 'hi')
  assert.ok('error' in (handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm' } }, call) as object))
  assert.ok('error' in (handleRpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, call) as object))
})

function send(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

test('the MCP endpoint and hook replies use the per-process token', async () => {
  const calls: string[] = []
  const server = new HookServer({
    onEvent: (e) => (e.name === 'UserPromptSubmit' ? { hookSpecificOutput: { hookEventName: e.name, additionalContext: 'ctx' } } : undefined),
    onTool: (key, name) => {
      calls.push(`${key} ${name}`)
      return { text: 'done' }
    }
  })
  await server.start()
  try {
    const token = server.register('a.1')
    const auth = { 'x-hub-session': 'a.1', 'x-hub-token': token }
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_step', arguments: { step_id: 'x' } } })
    assert.equal((await send(server.port, '/mcp', { 'x-hub-session': 'a.1', 'x-hub-token': 'nope' }, rpc)).status, 403)
    const ok = await send(server.port, '/mcp', auth, rpc)
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).result.content[0].text, 'done')
    assert.deepEqual(calls, ['a.1 complete_step'])
    assert.equal((await send(server.port, '/mcp', auth, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202)
    const hook = await send(server.port, '/hook', auth, JSON.stringify({ hook_event_name: 'UserPromptSubmit' }))
    assert.equal(JSON.parse(hook.body).hookSpecificOutput.additionalContext, 'ctx')
    assert.equal((await send(server.port, '/other', auth, '{}')).status, 403)
  } finally {
    server.stop()
  }
})


const TAGS = [
  { id: 'blocked', name: 'Blocked', color: '#f00' },
  { id: 'wf-draft', name: 'Draft', color: '#888', group: 'Workflow', exclusive: true },
  { id: 'wf-in-review', name: 'In review', color: '#00f', group: 'Workflow', exclusive: true },
  { id: 'pr-open', name: 'PR opened', color: '#00f', group: 'GitHub' }
]

test('set_tags adds and removes existing tags by name or id', () => {
  const r = applyTagTool(TAGS, ['wf-draft'], { add: ['blocked', 'in review'] })
  assert.ok(typeof r !== 'string')
  // "In review" replaces "Draft": same exclusive group.
  assert.deepEqual(r.tagIds, ['blocked', 'wf-in-review'])
  assert.match(r.text, /Blocked, In review/)
  const cleared = applyTagTool(TAGS, ['blocked'], { remove: ['Blocked'] })
  assert.ok(typeof cleared !== 'string')
  assert.deepEqual(cleared.tagIds, [])
})

test('set_tags rejects unknown tags and empty calls', () => {
  assert.match(applyTagTool(TAGS, [], { add: ['Urgent'] }) as string, /Unknown tag: Urgent/)
  assert.equal(typeof applyTagTool(TAGS, [], {}), 'string')
  assert.equal(typeof applyTagTool(TAGS, [], { add: 'Blocked' }), 'string')
})

test('get_tags marks manual and rule tags', () => {
  const text = describeTags(TAGS, ['blocked'], ['pr-open'])
  assert.match(text, /\[x\] Blocked/)
  assert.match(text, /\[auto\] PR opened/)
  assert.match(text, /\[ \] Draft \(group Workflow, one at a time\)/)
})

test('detects a skill the user starts, not built-in commands or plain prompts', () => {
  assert.equal(invokedSkill('/fix-issue 123'), 'fix-issue')
  assert.equal(invokedSkill('  /my-plugin:deploy'), 'my-plugin:deploy')
  assert.equal(invokedSkill('/do-something'), 'do-something')
  assert.equal(invokedSkill('/clear'), undefined)
  assert.equal(invokedSkill('/hub:steps a, b'), undefined)
  assert.equal(invokedSkill('please look at /etc/hosts'), undefined)
  assert.equal(invokedSkill('/usr/bin/env is broken'), undefined)
  assert.equal(invokedSkill(42), undefined)
})

test('skill context asks for steps and mentions existing ones', () => {
  const fresh = skillContext('fix-issue', {})
  assert.match(fresh, /started \/fix-issue/)
  assert.match(fresh, /set_steps/)
  assert.match(fresh, /set_tags/)
  assert.ok(!fresh.includes('already has steps'))
  assert.match(skillContext('fix-issue', { steps: ['Old'], currentStep: 1 }), /already has steps/)
})
