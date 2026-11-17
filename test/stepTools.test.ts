import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { validateJobTypes } from '../src/main/config.ts'
import { HookServer } from '../src/main/hooks.ts'
import { completedText, decideCompletion, handleRpc, jobStatus, stepContext } from '../src/main/stepTools.ts'
import type { JobStep, Session } from '../src/shared/types.ts'

const steps: JobStep[] = [
  { id: 'plan', name: 'Plan', advanceOn: 'manual' },
  { id: 'reproduce', name: 'Reproduce', prompt: 'Write a failing test.', advanceOn: 'claude' },
  { id: 'fix', name: 'Fix', prompt: 'Make it pass.', advanceOn: 'claude', confirm: true, autoSend: true },
  { id: 'pr', name: 'Open PR', advanceOn: { github: 'prOpen' } }
]

function session(currentStepId?: string, extra: Partial<Session> = {}): Session {
  const now = new Date().toISOString()
  return {
    id: 's1', projectId: 'p', name: 'x', kind: 'claude', cwd: '/tmp', repos: [], claudeSessionIds: [],
    attentionState: 'working', unread: false, hookSeen: true, running: true, tagIds: [], autoTags: [],
    stepHistory: [], createdAt: now, updatedAt: now, lastActivityAt: now,
    ...(currentStepId ? { jobTypeId: 'bugfix', jobTypeName: 'Bug fix', steps, currentStepId } : {}),
    ...extra
  }
}

test('Claude can close only the current step, and only steps marked "claude"', () => {
  assert.equal(decideCompletion(session(), { step_id: 'plan' }).ok, false, 'no job')
  const plan = decideCompletion(session('plan'), { step_id: 'plan' })
  assert.ok(!plan.ok && plan.message.includes('the user'), 'manual step')
  const skip = decideCompletion(session('reproduce'), { step_id: 'fix' })
  assert.ok(!skip.ok && skip.message.includes("can't be skipped"))
  const pr = decideCompletion(session('pr'), { step_id: 'pr' })
  assert.ok(!pr.ok && pr.message.includes('GitHub'))
  const ok = decideCompletion(session('reproduce'), { step_id: 'reproduce', note: '  test added  ' })
  assert.ok(ok.ok)
  assert.equal(ok.next?.id, 'fix')
  assert.equal(ok.confirm, false)
  assert.equal(ok.note, 'test added')
  const confirm = decideCompletion(session('fix'), { step_id: 'fix' })
  assert.ok(confirm.ok && confirm.confirm)
  const again = decideCompletion(session('fix', { pendingStep: { stepId: 'fix', at: '' } }), { step_id: 'fix' })
  assert.ok(!again.ok, 'already waiting for the user')
})

test('prompts get step context only while Claude closes the step', () => {
  assert.equal(stepContext(session('plan')), undefined)
  const context = stepContext(session('reproduce'))
  assert.ok(context?.includes('step_id "reproduce"') && context.includes('Write a failing test.'))
  assert.equal(stepContext(session('fix', { pendingStep: { stepId: 'fix', at: '' } })), undefined)
  assert.ok(jobStatus(session('reproduce')).includes('→ reproduce: Reproduce'))
  assert.equal(jobStatus(session()), 'This session has no job assigned.')
})

test('the next step goal is returned when Claude should carry on', () => {
  assert.ok(completedText(steps[1], steps[2], true).includes('Its goal: Make it pass.'))
  assert.ok(completedText(steps[1], steps[2], false).includes('the user will start it'))
  assert.ok(completedText(steps[3], undefined, false).includes('last step'))
})

test('MCP messages: initialize, list, call, notifications, unknown methods', () => {
  const call = () => ({ text: 'hi' })
  const init = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, call) as {
    result: { protocolVersion: string }
  }
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, call), undefined)
  const list = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, call) as { result: { tools: { name: string }[] } }
  assert.deepEqual(list.result.tools.map((t) => t.name), ['job_status', 'complete_step'])
  const result = handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'job_status' } }, call) as {
    result: { content: { text: string }[] }
  }
  assert.equal(result.result.content[0].text, 'hi')
  assert.ok('error' in (handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm' } }, call) as object))
  assert.ok('error' in (handleRpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, call) as object))
})

test('job types accept advanceOn "claude" and a boolean confirm', () => {
  assert.deepEqual(validateJobTypes([{ id: 'j', name: 'J', steps }]), [])
  const bad = validateJobTypes([{ id: 'j', name: 'J', steps: [{ id: 'a', name: 'A', advanceOn: 'claude', confirm: 'yes' }] }])
  assert.equal(bad.length, 1)
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
