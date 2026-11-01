import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_JOB_TYPES, DEFAULT_RULES, DEFAULT_TAGS, validateJobTypes, validateRules, validateTags } from '../src/main/config.ts'

test('defaults are valid', () => {
  assert.deepEqual(validateJobTypes(DEFAULT_JOB_TYPES), [])
  assert.deepEqual(validateTags(DEFAULT_TAGS), [])
  assert.deepEqual(validateRules(DEFAULT_RULES), [])
})

test('every default rule and step tag points at a default tag', () => {
  const ids = new Set(DEFAULT_TAGS.map((t) => t.id))
  for (const r of DEFAULT_RULES) assert.ok(ids.has(r.setTag), r.setTag)
  for (const j of DEFAULT_JOB_TYPES) for (const s of j.steps) if (s.tag) assert.ok(ids.has(s.tag), s.tag)
})

test('job type problems are reported with their location', () => {
  const problems = validateJobTypes([
    { id: 'a', name: 'A', steps: [{ id: 's', name: 'S' }, { id: 's', name: 'Again', advanceOn: 'later' }] },
    { id: 'a', name: 'Dup', steps: [] }
  ])
  assert.ok(problems.some((p) => p.includes('duplicate step id "s"')))
  assert.ok(problems.some((p) => p.includes('"advanceOn" must be')))
  assert.ok(problems.some((p) => p.includes('duplicate id')))
  assert.ok(problems.some((p) => p.includes('"steps" must be a non-empty list')))
})

test('accepts github advance conditions and rejects unknown ones', () => {
  const ok = [{ id: 'j', name: 'J', steps: [{ id: 'pr', name: 'PR', advanceOn: { github: 'prOpen' } }] }]
  const bad = [{ id: 'j', name: 'J', steps: [{ id: 'pr', name: 'PR', advanceOn: { github: 'shipped' } }] }]
  assert.deepEqual(validateJobTypes(ok), [])
  assert.equal(validateJobTypes(bad).length, 1)
})
