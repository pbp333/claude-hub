import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stateForEvent, type HookEvent } from '../src/main/hooks.ts'

const ev = (name: string, payload: Record<string, unknown> = {}): HookEvent => ({ hubSessionId: 'x', name, payload })

test('maps work events to working', () => {
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) assert.equal(stateForEvent(ev(name)), 'working')
})

test('permission requests and blocking notifications need the user', () => {
  assert.equal(stateForEvent(ev('PermissionRequest')), 'needs-you')
  assert.equal(stateForEvent(ev('Notification', { notification_type: 'permission_prompt' })), 'needs-you')
  assert.equal(stateForEvent(ev('Notification', { notification_type: 'idle_prompt' })), 'needs-you')
  assert.equal(stateForEvent(ev('Notification', { message: 'Claude needs your permission to use Bash' })), 'needs-you')
})

test('informational notifications change nothing', () => {
  assert.equal(stateForEvent(ev('Notification', { notification_type: 'auth_success' })), undefined)
})

test('stop means done; session end means exited unless it is /clear', () => {
  assert.equal(stateForEvent(ev('Stop')), 'done')
  assert.equal(stateForEvent(ev('SessionEnd', { reason: 'prompt_input_exit' })), 'exited')
  assert.equal(stateForEvent(ev('SessionEnd', { reason: 'clear' })), 'idle')
})
