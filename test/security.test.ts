import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sanitizeSettings } from '../src/main/config.ts'
import { cmdShimCommandLine } from '../src/main/env.ts'
import { resolveInside } from '../src/main/files.ts'
import { HookServer, isClaudeSessionId, showsDialog, type HookEvent } from '../src/main/hooks.ts'

function post(port: number, headers: Record<string, string>, body = '{"hook_event_name":"Stop"}'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('hook server accepts only a registered session with its own token', async () => {
  const events: HookEvent[] = []
  const server = new HookServer((e) => events.push(e))
  await server.start()
  try {
    const a = server.register('a.1')
    const b = server.register('b.1')
    assert.equal(await post(server.port, { 'x-hub-session': 'a.1', 'x-hub-token': a }), 200)
    assert.equal(await post(server.port, { 'x-hub-session': 'a.1', 'x-hub-token': b }), 403, "another session's token")
    assert.equal(await post(server.port, { 'x-hub-session': 'a.1' }), 403, 'no token')
    assert.equal(await post(server.port, { 'x-hub-session': 'a.1', 'x-hub-token': a, host: 'evil.test' }), 403, 'wrong Host')
    server.unregister('a.1')
    assert.equal(await post(server.port, { 'x-hub-session': 'a.1', 'x-hub-token': a }), 403, 'retired process')
    const big = JSON.stringify({ hook_event_name: 'Stop', pad: 'x'.repeat(1024 * 1024 + 10) })
    assert.equal(await post(server.port, { 'x-hub-session': 'b.1', 'x-hub-token': b }, big), 413)
    assert.deepEqual(events.map((e) => e.hubSessionId), ['a.1'])
  } finally {
    server.stop()
  }
})

test('only UUIDs count as Claude session ids', () => {
  assert.equal(isClaudeSessionId('9acf9fef-0828-411d-9613-612e11561f23'), true)
  assert.equal(isClaudeSessionId('--dangerously-skip-permissions'), false)
  assert.equal(isClaudeSessionId('x & calc'), false)
  assert.equal(isClaudeSessionId('9acf9fef-0828-411d-9613-612e11561f23 --verbose'), false)
})

test('dialogs are detected from the bottom of the screen only', () => {
  const dialog = ['Do you trust this folder?', '❯ No, exit', '  Yes, I trust this folder', '', 'Enter to confirm · Esc to cancel'].join('\n')
  assert.equal(showsDialog(dialog), true)
  const quoted = ['● The dialog says "Enter to confirm · Esc to cancel".', ...Array(6).fill('more output'), '❯ ', '  ? for shortcuts'].join('\n')
  assert.equal(showsDialog(quoted), false)
})

test('cmd.exe command lines keep each argument whole', () => {
  const line = cmdShimCommandLine('C:\\Users\\First Last\\npm\\claude.cmd', ['--settings', 'C:\\x\\Claude Hub\\h.json', 'a & calc'])
  assert.ok(line.startsWith('/d /s /c "'))
  assert.ok(!/[^^]&/.test(line), 'every & is escaped')
  assert.ok(line.includes('First^ Last'), 'spaces in the shim path are escaped')
})

test('settings with wrong types fall back per field', () => {
  const { settings, problems } = sanitizeSettings({
    claudeArgs: '--verbose' as unknown as string[],
    botLogins: 'me' as unknown as string[],
    pollIntervalSec: 1,
    terminalFontSize: 14,
    keybindings: { nextStep: 'CmdOrCtrl+Shift+N' } as never
  })
  assert.deepEqual(settings.claudeArgs, [])
  assert.deepEqual(settings.botLogins, [])
  assert.equal(settings.pollIntervalSec, 15)
  assert.equal(settings.terminalFontSize, 14)
  assert.equal(settings.keybindings.nextStep, 'CmdOrCtrl+Alt+N', 'old default migrates')
  assert.equal(problems.length, 3)
})

test('file access stays inside the allowed folders, symlinks included', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hub-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.txt'), 'x')
  writeFileSync(join(base, 'secret.txt'), 'x')
  symlinkSync(join(base, 'secret.txt'), join(root, 'link.txt'))
  assert.ok(await resolveInside(join(root, 'a.txt'), [root]))
  assert.ok(await resolveInside(join(root, 'new.txt'), [root]), 'a new file in the folder')
  assert.equal(await resolveInside(join(base, 'secret.txt'), [root]), undefined)
  assert.equal(await resolveInside(join(root, '..', 'secret.txt'), [root]), undefined)
  assert.equal(await resolveInside(join(root, 'link.txt'), [root]), undefined, 'symlink pointing outside')
  assert.equal(await resolveInside('relative.txt', [root]), undefined)
})
