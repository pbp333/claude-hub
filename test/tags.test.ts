import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attentionKind, attentionRank, effectiveTags, needsAttention } from '../src/shared/tags.ts'
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

test('combines manual and rule tags without duplicates', () => {
  const s = session({ tagIds: ['blocked'], autoTags: ['pr-open', 'blocked'] })
  assert.deepEqual(effectiveTags(s, tags).map((t) => [t.tag.id, t.source]), [
    ['blocked', 'manual'],
    ['pr-open', 'auto']
  ])
})

test('needs attention when blocked, or done and unseen', () => {
  assert.equal(needsAttention(session({ attentionState: 'needs-you' })), true)
  assert.equal(needsAttention(session({ attentionState: 'done', unread: true })), true)
  assert.equal(needsAttention(session({ attentionState: 'done', unread: false })), false)
  assert.equal(needsAttention(session({ attentionState: 'working' })), false)
})

test('tells waiting-for-input apart from unread output', () => {
  assert.equal(attentionKind(session({ attentionState: 'needs-you' })), 'input')
  assert.equal(attentionKind(session({ attentionState: 'needs-you', unread: true })), 'input')
  assert.equal(attentionKind(session({ attentionState: 'done', unread: true })), 'unread')
  assert.equal(attentionKind(session({ attentionState: 'done', unread: false })), undefined)
  assert.equal(attentionKind(session({ attentionState: 'idle', unread: true })), undefined)
  const ranks = [
    session({ attentionState: 'working' }),
    session({ attentionState: 'done', unread: true }),
    session({ attentionState: 'needs-you' })
  ].map(attentionRank)
  assert.deepEqual(ranks, [2, 1, 0])
})
