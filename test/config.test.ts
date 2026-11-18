import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RULES, DEFAULT_TAGS, validateRules, validateTags } from '../src/main/config.ts'

test('defaults are valid', () => {
  assert.deepEqual(validateTags(DEFAULT_TAGS), [])
  assert.deepEqual(validateRules(DEFAULT_RULES), [])
})

test('every default rule points at a default tag', () => {
  const ids = new Set(DEFAULT_TAGS.map((t) => t.id))
  for (const r of DEFAULT_RULES) assert.ok(ids.has(r.setTag), r.setTag)
})

test('rules with unknown PR conditions are reported', () => {
  const bad = [{ id: 'r', when: 'shipped', setTag: 'x', enabled: true }]
  assert.equal(validateRules(bad).length, 1)
})
