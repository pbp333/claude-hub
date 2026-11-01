import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, Rectangle } from 'electron'
import { watch, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { effectiveTags } from '../shared/tags'
import type { NewSessionOptions, Session, UiCommand, WindowInfo } from '../shared/types'
import { CONFIG_FILES } from './config'
import { loadLoginShellEnv } from './env'
import { FolderWatcher, listDir, readText, resolveLinks, writeText } from './files'
import { gitStatus, headContent, listFiles } from './git'
import { SessionManager } from './sessions'
import { JsonStore } from './store'

/** A window shows one workspace (or the welcome screen) and remembers its active session. */
interface HubWindow {
  win: BrowserWindow
  projectId?: string
  activeSessionId?: string
}

interface SavedWindow {
  projectId?: string
  bounds?: Rectangle
}

const windows = new Map<number, HubWindow>()
let manager: SessionManager
let stateTimer: NodeJS.Timeout | undefined
let quitting = false
let menuKey = ''

// Dev aid: a separate data folder, so test runs never touch real sessions.
if (process.env.CLAUDE_HUB_USER_DATA) app.setPath('userData', process.env.CLAUDE_HUB_USER_DATA)
const store = new JsonStore(join(app.getPath('userData'), 'data'))

function live(): HubWindow[] {
  return [...windows.values()].filter((w) => !w.win.isDestroyed())
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of live()) w.win.webContents.send(channel, ...args)
}

function fromEvent(e: IpcMainEvent | IpcMainInvokeEvent): HubWindow | undefined {
  return windows.get(e.sender.id)
}

function focused(): HubWindow | undefined {
  const win = BrowserWindow.getFocusedWindow()
  return (win && windows.get(win.webContents.id)) ?? live().at(-1)
}

function windowFor(projectId: string): HubWindow | undefined {
  return live().find((w) => w.projectId === projectId)
}

function command(cmd: UiCommand, target = focused()): void {
  target?.win.webContents.send('command', cmd)
}

function show(hw: HubWindow): void {
  if (hw.win.isMinimized()) hw.win.restore()
  hw.win.show()
  hw.win.focus()
}

/** Brings up the session's workspace window, reopening it if it was closed, and selects the session. */
function focusSession(sessionId: string): void {
  const s = manager.get(sessionId)
  if (!s) return
  let hw = windowFor(s.projectId)
  if (!hw) {
    hw = createWindow(s.projectId)
    const created = hw
    created.win.webContents.once('did-finish-load', () => setTimeout(() => command({ type: 'focusSession', sessionId }, created), 300))
  } else command({ type: 'focusSession', sessionId }, hw)
  show(hw)
}

const host = {
  stateChanged() {
    // Coalesce bursts of hook events into one UI update per frame.
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = undefined
      broadcast('state', manager.snapshot())
      updateBadge()
      updateWatcher()
      // Open Recent lists recent workspaces; rebuild only when that list changes.
      const key = manager.recentFolders.join('\0')
      if (key !== menuKey) buildMenu()
    }, 16)
  },
  ptyData(sessionId: string, data: string) {
    broadcast('pty-data', sessionId, data)
  },
  notify(session: Session, body: string) {
    if (!manager.config.settings.notifications || !Notification.isSupported()) return
    const n = new Notification({ title: session.name, body, silent: false })
    n.on('click', () => focusSession(session.id))
    n.show()
  },
  isViewing(sessionId: string) {
    return live().some((w) => w.win.isFocused() && w.activeSessionId === sessionId)
  }
}

const folderWatcher = new FolderWatcher((paths) => broadcast('fs-changed', paths))

function updateWatcher(): void {
  const folders = new Set<string>()
  for (const w of live()) {
    const p = manager.project(w.projectId)
    if (p) folders.add(p.path)
  }
  folderWatcher.setFolders([...folders])
}

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
  else if (process.platform === 'win32')
    for (const w of live()) w.win.setOverlayIcon(count ? redDot() : null, count ? `${count} need you` : '')
}

// ---- windows -------------------------------------------------------------

function saveWindows(): void {
  if (quitting) return
  store.writeSoon('windows.json', windowsSnapshot, 500)
}

function windowsSnapshot(): SavedWindow[] {
  return live().map((w) => ({ projectId: w.projectId, bounds: w.win.getNormalBounds() }))
}

function createWindow(projectId?: string, bounds?: Rectangle): HubWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? 1400,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
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
  const hw: HubWindow = { win }
  const id = win.webContents.id
  windows.set(id, hw)
  setWorkspace(hw, projectId)
  win.on('ready-to-show', () => win.show())
  // Dev aid: CLAUDE_HUB_DEBUG=1 prints the renderer console to stdout.
  if (process.env.CLAUDE_HUB_DEBUG)
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  win.on('focus', () => hw.activeSessionId && manager.markRead(hw.activeSessionId))
  win.on('moved', saveWindows)
  win.on('resized', saveWindows)
  win.on('closed', () => {
    windows.delete(id)
    saveWindows()
    updateWatcher()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return hw
}

function setWorkspace(hw: HubWindow, projectId: string | undefined): void {
  const project = manager.project(projectId)
  hw.projectId = project?.id
  hw.activeSessionId = undefined
  hw.win.setTitle(project ? `${project.name} — Claude Hub` : 'Claude Hub')
  if (process.platform === 'darwin') hw.win.setRepresentedFilename(project?.path ?? '')
  const info: WindowInfo = { projectId: hw.projectId }
  hw.win.webContents.send('window-info', info)
  saveWindows()
  updateWatcher()
}

/** Opens a folder: focuses its window if one has it, else shows it in `target` (or a new window). */
function openFolderPath(folder: string, target?: HubWindow): void {
  let project
  try {
    project = manager.openWorkspace(folder)
  } catch (err) {
    void dialog.showMessageBox({ type: 'error', message: (err as Error).message })
    return
  }
  const existing = windowFor(project.id)
  if (existing) return show(existing)
  if (target) {
    setWorkspace(target, project.id)
    show(target)
  } else show(createWindow(project.id))
}

async function pickFolder(target?: HubWindow): Promise<void> {
  const parent = target?.win
  const r = parent
    ? await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (!r.canceled && r.filePaths[0]) openFolderPath(r.filePaths[0], target)
}

// ---- menus ---------------------------------------------------------------

function buildMenu(): void {
  menuKey = manager.recentFolders.join('\0')
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
      click: () => {
        const id = focused()?.activeSessionId
        if (id) manager.toggleTag(id, t.id)
      }
    }))
  const recent: MenuItemConstructorOptions[] = manager.recentFolders.map((folder) => ({
    label: `${basename(folder)}  —  ${folder}`,
    click: () => openFolderPath(folder, focused())
  }))
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: kb.newWindow, click: () => show(createWindow()) },
        { label: 'Open Folder…', accelerator: kb.openFolder, click: () => void pickFolder(focused()) },
        { label: 'Open Recent', submenu: recent.length ? recent : [{ label: 'No recent folders', enabled: false }] },
        { type: 'separator' },
        item('New Session…', kb.newSession, { type: 'newSession' }),
        item('Open File…', kb.quickOpen, { type: 'quickOpen' }),
        item('Close Tab', kb.closeTab, { type: 'closeTab' }),
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => focused()?.win.close() },
        ...(process.platform === 'darwin' ? [] : [{ role: 'quit' as const }])
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
    // Custom, not role 'windowMenu': its Close item would take ⌘W from Close Tab.
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function sessionContextMenu(sessionId: string, hw: HubWindow): void {
  const s = manager.get(sessionId)
  if (!s) return
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
  const prItems: MenuItemConstructorOptions[] = s.repos
    .filter((r) => r.pr)
    .map((r) => ({ label: `Open PR #${r.pr!.number} (${r.name})`, click: () => void shell.openExternal(r.pr!.url) }))
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
    ...prItems,
    { label: 'Rename…', click: () => command({ type: 'rename', sessionId }, hw) },
    { label: s.running ? 'Restart' : s.claudeSessionId ? 'Resume' : 'Start again', click: () => manager.restart(sessionId) },
    { type: 'separator' },
    {
      label: 'Close session',
      click: async () => {
        if (s.running) {
          const r = await dialog.showMessageBox(hw.win, {
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
  Menu.buildFromTemplate(template).popup({ window: hw.win })
}

// ---- IPC -----------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('get-state', () => manager.snapshot())
  ipcMain.handle('window-info', (e): WindowInfo => ({ projectId: fromEvent(e)?.projectId }))
  ipcMain.on('open-folder', (e) => void pickFolder(fromEvent(e)))
  ipcMain.on('open-recent', (e, folder: string) => openFolderPath(folder, fromEvent(e)))
  ipcMain.on('new-window', () => show(createWindow()))
  ipcMain.handle('create-session', async (_e, opts: NewSessionOptions) => (await manager.create(opts)).id)
  ipcMain.on('restart-session', (_e, id: string) => manager.restart(id))
  ipcMain.on('close-session', (_e, id: string) => manager.close(id))
  ipcMain.on('rename-session', (_e, id: string, name: string) => manager.rename(id, name))
  ipcMain.on('session-menu', (e, id: string) => {
    const hw = fromEvent(e)
    if (hw) sessionContextMenu(id, hw)
  })
  ipcMain.on('set-active-session', (e, id: string | undefined) => {
    const hw = fromEvent(e)
    if (!hw) return
    hw.activeSessionId = id
    if (id && hw.win.isFocused()) manager.markRead(id)
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
  ipcMain.handle('git-status', (_e, workspace: string) => gitStatus(workspace))
  ipcMain.handle('list-files', (_e, workspace: string) => listFiles(workspace))
  ipcMain.handle('resolve-links', (_e, cwd: string, candidates: string[]) => resolveLinks(cwd, candidates))
  ipcMain.handle('config-path', (_e, file: string) => manager.configFilePath(file))

  // One layout per workspace, so each folder reopens with its own tabs and splits.
  const layoutFile = (projectId: string) => `layout-${projectId.replace(/[^\w-]/g, '')}.json`
  ipcMain.handle('load-layout', (_e, projectId: string) => store.read<unknown>(layoutFile(projectId), null))
  ipcMain.on('save-layout', (_e, projectId: string, layout: unknown) =>
    store.writeSoon(layoutFile(projectId), () => layout, 1000)
  )
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

// ---- app lifecycle ---------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', () => {
  const hw = focused()
  if (hw) show(hw)
  else show(createWindow())
})

app.whenReady().then(async () => {
  app.setName('Claude Hub')
  await loadLoginShellEnv()
  manager = new SessionManager(store, host)
  registerIpc()
  buildMenu()
  watchConfig()

  // Reopen the windows from last time, each with its workspace.
  const saved = store.read<SavedWindow[]>('windows.json', []).filter((w) => !w.projectId || manager.project(w.projectId))
  if (saved.length) for (const w of saved) createWindow(w.projectId, w.bounds)
  else createWindow()
  await manager.start(saved.map((w) => w.projectId).filter((p): p is string => !!p))

  // Dev aid: CLAUDE_HUB_DEMO="claude|shell:<folder>[:jobTypeId]" opens the folder and starts a session.
  const demo = process.env.CLAUDE_HUB_DEMO?.match(/^(claude|shell):([^:]+)(?::(.+))?$/)
  if (demo) {
    openFolderPath(demo[2], live()[0])
    const projectId = live()[0].projectId!
    const session = await manager.create({ projectId, kind: demo[1] as 'claude' | 'shell', jobTypeId: demo[3] })
    const hw = live()[0]
    hw.win.webContents.once('did-finish-load', () => setTimeout(() => command({ type: 'focusSession', sessionId: session.id }, hw), 500))
    // CLAUDE_HUB_DEMO_OPEN="<path>:<line>" opens a file the way a terminal link click does.
    const open = process.env.CLAUDE_HUB_DEMO_OPEN?.match(/^(.+):(\d+)$/)
    if (open) setTimeout(() => command({ type: 'openFile', path: open[1], line: Number(open[2]) }, hw), 4000)
    if (process.env.CLAUDE_HUB_DEMO_INPUT)
      setTimeout(
        () => manager.write(session.id, JSON.parse(`"${process.env.CLAUDE_HUB_DEMO_INPUT}"`)),
        Number(process.env.CLAUDE_HUB_DEMO_INPUT_DELAY ?? 2500)
      )
  }

  // Dev aid: CLAUDE_HUB_SCREENSHOT=/path.png captures the first window after a delay and quits.
  const shot = process.env.CLAUDE_HUB_SCREENSHOT
  if (shot) {
    setTimeout(async () => {
      const image = await live()[0].win.webContents.capturePage()
      writeFileSync(shot, image.toPNG())
      app.quit()
    }, Number(process.env.CLAUDE_HUB_SCREENSHOT_DELAY ?? 6000))
  }
})

// macOS: clicking the Dock icon with no windows open brings one back.
app.on('activate', () => {
  if (manager && !live().length) show(createWindow())
})

app.on('before-quit', () => {
  // Remember the open windows before they close (closing them would empty the list).
  store.flush('windows.json', windowsSnapshot)
  quitting = true
  manager?.shutdown()
  folderWatcher.close()
})

// On macOS the app (and its Claude sessions) keeps running with no windows, like other Mac apps.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
