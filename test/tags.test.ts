import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveTags, needsAttention } from '../src/shared/tags.ts'
import type { Session, Tag } from '../src/shared/types.ts'

const tags: Tag[] = [
  { id: 'blocked', name: 'Blocked', color: 'red' },
  { id: 'pr-open', name: 'PR opened', color: 'blue' },
  { id: 'waiting-review', name: 'Waiting review', color: 'purple' }
]

function session(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString()
  return {
    id: 's', projectId: 'p', name: 'S', kind: 'claude', cwd: '/x', attentionState: 'idle', unread: false,
    hookSeen: true, running: true, tagIds: [], autoTags: [], stepHistory: [], createdAt: now, updatedAt: now, lastActivityAt: now,
    ...over
  }
}

test('combines manual, rule and step tags without duplicates', () => {
  const s = session({
    tagIds: ['blocked'],
    autoTags: ['pr-open', 'blocked'],
    steps: [{ id: 'review', name: 'Review', tag: 'Waiting review' }],
    currentStepId: 'review'
  })
  assert.deepEqual(effectiveTags(s, tags).map((t) => [t.tag.id, t.source]), [
    ['blocked', 'manual'],
    ['pr-open', 'auto'],
    ['waiting-review', 'step']
  ])
})

test('needs attention when blocked, or done and unseen', () => {
  assert.equal(needsAttention(session({ attentionState: 'needs-you' })), true)
  assert.equal(needsAttention(session({ attentionState: 'done', unread: true })), true)
  assert.equal(needsAttention(session({ attentionState: 'done', unread: false })), false)
  assert.equal(needsAttention(session({ attentionState: 'working' })), false)
})
