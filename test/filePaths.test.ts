import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPathCandidates } from '../src/renderer/src/filePaths.ts'

const paths = (line: string) => findPathCandidates(line).map((m) => [m.path, m.line, m.column])

test('finds relative paths with line and column', () => {
  assert.deepEqual(paths('see src/main/pty.ts:20 for details'), [['src/main/pty.ts', 20, undefined]])
  assert.deepEqual(paths('Error at src/a.tsx:12:7'), [['src/a.tsx', 12, 7]])
  assert.deepEqual(paths('Edited ./README.md and ../x/y.json'), [['./README.md', undefined, undefined], ['../x/y.json', undefined, undefined]])
})

test('finds absolute and home paths', () => {
  assert.deepEqual(paths('open /Users/me/app/index.ts:3'), [['/Users/me/app/index.ts', 3, undefined]])
  assert.deepEqual(paths('~/notes/todo.md'), [['~/notes/todo.md', undefined, undefined]])
  assert.deepEqual(paths('C:\\code\\app\\main.ts:9'), [['C:\\code\\app\\main.ts', 9, undefined]])
})

test('reports the start index of each match', () => {
  const [m] = findPathCandidates('  ⎿ Updated src/x.ts')
  assert.equal('  ⎿ Updated src/x.ts'.slice(m.index, m.index + m.text.length), 'src/x.ts')
})

test('ignores URLs, versions and plain numbers', () => {
  assert.deepEqual(paths('https://github.com/a/b.ts'), [])
  assert.deepEqual(paths('Claude Code v2.1.316'), [])
  assert.deepEqual(paths('took 0.5 seconds, version 1.2.3'), [])
})

test('handles wrapping punctuation', () => {
  assert.deepEqual(paths('(see src/a.ts)'), [['src/a.ts', undefined, undefined]])
  assert.deepEqual(paths('"package.json"'), [['package.json', undefined, undefined]])
})
