import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell } from 'electron'
import { watch } from 'node:fs'
import { join } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { effectiveTags } from '../shared/tags'
import type { NewSessionOptions, Session, UiCommand } from '../shared/types'
import { CONFIG_FILES } from './config'
import { loadLoginShellEnv } from './env'
import { FolderWatcher, listDir, readText, resolveLinks, writeText } from './files'
import { gitStatus, headContent, listFiles } from './git'
import { SessionManager } from './sessions'
import { JsonStore } from './store'

let win: BrowserWindow | undefined
let manager: SessionManager
let activeSessionId: string | undefined
let stateTimer: NodeJS.Timeout | undefined

// Dev aid: a separate data folder, so test runs never touch real sessions.
if (process.env.CLAUDE_HUB_USER_DATA) app.setPath('userData', process.env.CLAUDE_HUB_USER_DATA)
const store = new JsonStore(join(app.getPath('userData'), 'data'))

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function command(cmd: UiCommand): void {
  send('command', cmd)
}

function focusSession(sessionId: string): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  command({ type: 'focusSession', sessionId })
}

const host = {
  stateChanged() {
    // Coalesce bursts of hook events into one UI update per frame.
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = undefined
      send('state', manager.snapshot())
      updateBadge()
      folderWatcher.setFolders([...new Set(manager.sessions.filter((s) => s.running).map((s) => s.cwd))])
    }, 16)
  },
  ptyData(sessionId: string, data: string) {
    send('pty-data', sessionId, data)
  },
  notify(session: Session, body: string) {
    if (!manager.config.settings.notifications || !Notification.isSupported()) return
    const n = new Notification({ title: session.name, body, silent: false })
    n.on('click', () => focusSession(session.id))
    n.show()
  },
  isViewing(sessionId: string) {
    return !!win && win.isFocused() && activeSessionId === sessionId
  }
}

const folderWatcher = new FolderWatcher((paths) => send('fs-changed', paths))

let overlayIcon: Electron.NativeImage | undefined
function redDot(): Electron.NativeImage {
  if (overlayIcon) return overlayIcon
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5)
      const i = (y * size + x) * 4
      if (d <= 7) buf.set([0x4d, 0x48, 0xe5, 0xff], i) // BGRA
    }
  overlayIcon = nativeImage.createFromBitmap(buf, { width: size, height: size })
  return overlayIcon
}

function updateBadge(): void {
  const count = manager.badgeCount()
  if (process.platform === 'darwin') app.setBadgeCount(count)
  else if (process.platform === 'win32' && win) win.setOverlayIcon(count ? redDot() : null, count ? `${count} need you` : '')
}

function buildMenu(): void {
  const kb = manager.config.settings.keybindings
  const item = (label: string, accelerator: string, cmd: UiCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => command(cmd)
  })
  const switchItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) =>
    item(`Session ${i + 1}`, `CmdOrCtrl+${i + 1}`, { type: 'switchSession', index: i })
  )
  const tagItems: MenuItemConstructorOptions[] = manager.config.tags
    .filter((t) => t.shortcut)
    .map((t) => ({
      label: `Toggle "${t.name}"`,
      accelerator: t.shortcut,
      click: () => activeSessionId && manager.toggleTag(activeSessionId, t.id)
    }))
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        item('New Session…', kb.newSession, { type: 'newSession' }),
        item('Open File…', kb.quickOpen, { type: 'quickOpen' }),
        item('Close Tab', kb.closeTab, { type: 'closeTab' }),
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('Command Palette…', kb.commandPalette, { type: 'commandPalette' }),
        item('Toggle File Tree', kb.toggleFileTree, { type: 'toggleFileTree' }),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Session',
      submenu: [
        item('Next Session That Needs Me', kb.nextNeedsYou, { type: 'nextNeedsYou' }),
        item('Next Step', kb.nextStep, { type: 'nextStep' }),
        { type: 'separator' },
        ...switchItems,
        ...(tagItems.length ? [{ type: 'separator' as const }, ...tagItems] : [])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function sessionContextMenu(sessionId: string): void {
  const s = manager.get(sessionId)
  if (!s || !win) return
  const tags = manager.config.tags
  const active = new Set(effectiveTags(s, tags).map((t) => t.tag.id))
  const groups = new Map<string, MenuItemConstructorOptions[]>()
  for (const t of tags) {
    const g = t.group ?? ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push({
      label: t.name,
      type: 'checkbox',
      checked: active.has(t.id),
      enabled: !s.autoTags.includes(t.id),
      click: () => manager.toggleTag(sessionId, t.id)
    })
  }
  const tagMenu: MenuItemConstructorOptions[] = []
  for (const [group, items] of groups) {
    if (tagMenu.length) tagMenu.push({ type: 'separator' })
    if (group) tagMenu.push({ label: group, enabled: false })
    tagMenu.push(...items)
  }
  const stepMenu: MenuItemConstructorOptions[] = (s.steps ?? []).map((st, i) => ({
    label: `${i + 1}. ${st.name}`,
    type: 'radio',
    checked: st.id === s.currentStepId,
    click: () => manager.setStep(sessionId, st.id)
  }))
  const jobMenu: MenuItemConstructorOptions[] = [
    { label: 'None', type: 'radio', checked: !s.jobTypeId, click: () => manager.setJobType(sessionId, undefined) },
    ...manager.config.jobTypes.map(
      (j): MenuItemConstructorOptions => ({
        label: j.name,
        type: 'radio',
        checked: s.jobTypeId === j.id,
        click: () => manager.setJobType(sessionId, j.id)
      })
    )
  ]
  const template: MenuItemConstructorOptions[] = [
    { label: 'Tags', submenu: tagMenu },
    ...(s.kind === 'claude' ? [{ label: 'Job type', submenu: jobMenu }] : []),
    ...(stepMenu.length
      ? [
          { label: 'Next step', click: () => manager.nextStep(sessionId) },
          { label: 'Go to step', submenu: stepMenu }
        ]
      : []),
    { type: 'separator' },
    ...(s.pr ? [{ label: `Open PR #${s.pr.number}`, click: () => void shell.openExternal(s.pr!.url) }] : []),
    { label: 'Rename…', click: () => command({ type: 'rename', sessionId }) },
    { label: s.running ? 'Restart' : s.claudeSessionId ? 'Resume' : 'Start again', click: () => manager.restart(sessionId) },
    { type: 'separator' },
    {
      label: 'Close session',
      click: async () => {
        if (s.running) {
          const r = await dialog.showMessageBox(win!, {
            type: 'question',
            buttons: ['Close', 'Cancel'],
            defaultId: 0,
            message: `Close "${s.name}"?`,
            detail: 'The running process will be stopped.'
          })
          if (r.response !== 0) return
        }
        manager.close(sessionId)
      }
    }
  ]
  Menu.buildFromTemplate(template).popup({ window: win })
}

function registerIpc(): void {
  ipcMain.handle('get-state', () => manager.snapshot())
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('create-session', async (_e, opts: NewSessionOptions) => (await manager.create(opts)).id)
  ipcMain.on('restart-session', (_e, id: string) => manager.restart(id))
  ipcMain.on('close-session', (_e, id: string) => manager.close(id))
  ipcMain.on('rename-session', (_e, id: string, name: string) => manager.rename(id, name))
  ipcMain.on('session-menu', (_e, id: string) => sessionContextMenu(id))
  ipcMain.on('set-active-session', (_e, id: string | undefined) => {
    activeSessionId = id
    if (id && win?.isFocused()) manager.markRead(id)
  })
  ipcMain.on('toggle-tag', (_e, id: string, tagId: string) => manager.toggleTag(id, tagId))
  ipcMain.on('next-step', (_e, id: string) => manager.nextStep(id))
  ipcMain.on('set-step', (_e, id: string, stepId: string) => manager.setStep(id, stepId))

  ipcMain.on('pty-write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('pty-resize', (_e, id: string, cols: number, rows: number) => manager.resize(id, cols, rows))
  ipcMain.handle('pty-buffer', (_e, id: string) => manager.buffer(id))

  ipcMain.handle('list-dir', (_e, dir: string) => listDir(dir))
  ipcMain.handle('read-file', (_e, path: string) => readText(path))
  ipcMain.handle('write-file', (_e, path: string, content: string) => writeText(path, content))
  ipcMain.handle('head-content', (_e, path: string) => headContent(path))
  ipcMain.handle('git-status', (_e, cwd: string) => gitStatus(cwd))
  ipcMain.handle('list-files', (_e, cwd: string) => listFiles(cwd))
  ipcMain.handle('resolve-links', (_e, cwd: string, candidates: string[]) => resolveLinks(cwd, candidates))
  ipcMain.handle('config-path', (_e, file: string) => manager.configFilePath(file))

  ipcMain.handle('load-layout', () => store.read<unknown>('layout.json', null))
  ipcMain.on('save-layout', (_e, layout: unknown) => store.writeSoon('layout.json', () => layout, 1000))
  ipcMain.on('open-external', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
}

/** Reload tags, rules, job types and settings when their files change (also when edited inside the app). */
function watchConfig(): void {
  let timer: NodeJS.Timeout | undefined
  watch(store.dir, (_event, file) => {
    if (!file || !CONFIG_FILES.includes(String(file))) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      manager.reloadConfig()
      buildMenu()
    }, 200)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'Claude Hub',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win?.show())
  // Dev aid: CLAUDE_HUB_DEBUG=1 prints the renderer console to stdout.
  if (process.env.CLAUDE_HUB_DEBUG)
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  win.on('focus', () => activeSessionId && manager.markRead(activeSessionId))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  // Debug aid: CLAUDE_HUB_SCREENSHOT=/path.png captures the window after a few seconds and quits.
  const shot = process.env.CLAUDE_HUB_SCREENSHOT
  if (shot) {
    setTimeout(async () => {
      const image = await win!.webContents.capturePage()
      const { writeFileSync } = await import('node:fs')
      writeFileSync(shot, image.toPNG())
      app.quit()
    }, Number(process.env.CLAUDE_HUB_SCREENSHOT_DELAY ?? 6000))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
})

app.whenReady().then(async () => {
  app.setName('Claude Hub')
  await loadLoginShellEnv()
  manager = new SessionManager(store, host)
  registerIpc()
  buildMenu()
  createWindow()
  watchConfig()
  await manager.start()
  // Dev aid: CLAUDE_HUB_DEMO="claude|shell:<folder>[:jobTypeId]" starts a session on launch.
  const demo = process.env.CLAUDE_HUB_DEMO?.match(/^(claude|shell):([^:]+)(?::(.+))?$/)
  if (demo) {
    const session = await manager.create({ kind: demo[1] as 'claude' | 'shell', cwd: demo[2], jobTypeId: demo[3] })
    win?.webContents.once('did-finish-load', () => setTimeout(() => focusSession(session.id), 500))
    // CLAUDE_HUB_DEMO_OPEN="<path>:<line>" opens a file the way a terminal link click does.
    const open = process.env.CLAUDE_HUB_DEMO_OPEN?.match(/^(.+):(\d+)$/)
    if (open) setTimeout(() => command({ type: 'openFile', path: open[1], line: Number(open[2]) }), 4000)
    if (process.env.CLAUDE_HUB_DEMO_INPUT) setTimeout(() => manager.write(session.id, JSON.parse(`"${process.env.CLAUDE_HUB_DEMO_INPUT}"`)), Number(process.env.CLAUDE_HUB_DEMO_INPUT_DELAY ?? 2500))
  }
})

app.on('before-quit', () => {
  manager?.shutdown()
  folderWatcher.close()
})

app.on('window-all-closed', () => app.quit())
