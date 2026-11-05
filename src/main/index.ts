import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, Rectangle } from 'electron'
import { watch, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { effectiveTags } from '../shared/tags'
import type { NewSessionOptions, Session, UiCommand, WindowInfo } from '../shared/types'
import { CONFIG_FILES } from './config'
import { loadLoginShellEnv } from './env'
import { FolderWatcher, isInside, listDir, readText, resolveInside, resolveLinks, writeText } from './files'
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

// Only one copy of the app runs: a second launch just focuses it (see 'second-instance').
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

/** Dev aids (CLAUDE_HUB_* env vars, the dev server URL) work only in unpackaged builds. */
const DEV = !app.isPackaged
const env = (name: string) => (DEV ? process.env[name] : undefined)

const windows = new Map<number, HubWindow>()
let manager: SessionManager
let stateTimer: NodeJS.Timeout | undefined
let quitting = false
let menuKey = ''
/** Windows open when the last one was closed (Windows/Linux quit then), so they reopen next time. */
let lastWindows: SavedWindow[] | undefined
/** Kept referenced: a garbage-collected Notification loses its click handler. */
const notifications = new Set<Notification>()

// Dev aid: a separate data folder, so test runs never touch real sessions.
if (env('CLAUDE_HUB_USER_DATA')) app.setPath('userData', env('CLAUDE_HUB_USER_DATA')!)
const store = new JsonStore(join(app.getPath('userData'), 'data'))

const devServerUrl = env('ELECTRON_RENDERER_URL')
const appPageUrl = devServerUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** True for the app's own page; anything else (a dropped file, a navigated frame) gets no API. */
function isAppPage(url: string | undefined): boolean {
  if (!url) return false
  const page = url.split('#')[0].split('?')[0]
  return devServerUrl ? page.startsWith(new URL(devServerUrl).origin + '/') : page === appPageUrl
}

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
    notifications.add(n)
    n.on('click', () => {
      notifications.delete(n)
      focusSession(session.id)
    })
    n.on('close', () => notifications.delete(n))
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
  if (quitting || lastWindows) return
  store.writeSoon('windows.json', windowsSnapshot, 500)
}

function windowsSnapshot(): SavedWindow[] {
  return live().map((w) => ({ projectId: w.projectId, bounds: w.win.getNormalBounds() }))
}

/** Saved bounds, unless no display shows the window's top-left area any more (monitor unplugged). */
function visibleBounds(bounds?: Rectangle): Partial<Rectangle> | undefined {
  if (!bounds) return undefined
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
    const x = bounds.x + 40
    const y = bounds.y + 20
    return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height
  })
  return onScreen ? bounds : { width: bounds.width, height: bounds.height }
}

function createWindow(projectId?: string, savedBounds?: Rectangle): HubWindow {
  const bounds = visibleBounds(savedBounds)
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })
  const hw: HubWindow = { win }
  const id = win.webContents.id
  windows.set(id, hw)
  setWorkspace(hw, projectId)
  win.on('ready-to-show', () => win.show())
  // Dev aid: CLAUDE_HUB_DEBUG=1 prints the renderer console to stdout.
  if (env('CLAUDE_HUB_DEBUG'))
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  win.on('focus', () => hw.activeSessionId && manager.markRead(hw.activeSessionId))
  win.on('moved', saveWindows)
  win.on('resized', saveWindows)
  // Windows/Linux quit when the last window closes; remember it before it's gone.
  win.on('close', () => {
    if (process.platform !== 'darwin' && live().length === 1 && !quitting) lastWindows = windowsSnapshot()
  })
  win.on('closed', () => {
    windows.delete(id)
    saveWindows()
    updateWatcher()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the app. Dropping a file or following a link must not
  // navigate it: the new page would get the preload's API.
  const stay = (e: Electron.Event, url: string) => {
    if (!isAppPage(url)) e.preventDefault()
  }
  win.webContents.on('will-navigate', stay)
  win.webContents.on('will-redirect', stay)
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  if (devServerUrl) void win.loadURL(devServerUrl)
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

// ---- IPC -----------------------------------------------------------------
// Every handler checks that the caller is the app's own page and that arguments have the
// expected types; file access is limited to open workspaces and the config folder.

class IpcError extends Error {}

const str = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || v.length > max) throw new IpcError('expected text')
  return v
}
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10000) throw new IpcError('expected a number')
  return v
}

function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isAppPage(e.senderFrame?.url) && windows.has(e.sender.id)
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('not allowed')
    return fn(e, ...args)
  })
}

function on(channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!trusted(e)) return
    try {
      fn(e, ...args)
    } catch (err) {
      if (!(err instanceof IpcError)) console.error(`ipc ${channel}:`, err)
    }
  })
}

/** Folders the UI may read and write in: every workspace, plus the config folder. */
function allowedRoots(): string[] {
  return [...manager.projects.map((p) => p.path), store.dir]
}

async function allowedPath(path: unknown): Promise<string> {
  const real = await resolveInside(str(path), allowedRoots())
  if (!real) throw new Error('That file is outside the open folders')
  return real
}

function workspacePath(path: unknown): string {
  const p = str(path)
  if (!manager.projects.some((project) => project.path === p)) throw new Error('not an open folder')
  return p
}

function registerIpc(): void {
  handle('get-state', () => manager.snapshot())
  handle('window-info', (e): WindowInfo => ({ projectId: fromEvent(e)?.projectId }))
  on('open-folder', (e) => void pickFolder(fromEvent(e)))
  on('open-recent', (e, folder) => {
    const f = str(folder)
    // Only folders the app already knows; any other folder goes through the picker.
    if (manager.recentFolders.includes(f) || manager.projects.some((p) => p.path === f)) openFolderPath(f, fromEvent(e))
  })
  on('new-window', () => show(createWindow()))
  handle('create-session', async (_e, opts) => {
    const o = (opts ?? {}) as Record<string, unknown>
    const kind = o.kind === 'shell' ? 'shell' : 'claude'
    const session = await manager.create({
      projectId: str(o.projectId),
      name: o.name === undefined ? undefined : str(o.name, 200),
      kind,
      jobTypeId: o.jobTypeId === undefined ? undefined : str(o.jobTypeId, 200)
    } satisfies NewSessionOptions)
    return session.id
  })
  on('restart-session', (_e, id) => manager.restart(str(id)))
  on('close-session', (_e, id) => manager.close(str(id)))
  on('rename-session', (_e, id, name) => manager.rename(str(id), str(name, 200)))
  on('session-menu', (e, id) => {
    const hw = fromEvent(e)
    if (hw) sessionContextMenu(str(id), hw)
  })
  on('set-active-session', (e, id) => {
    const hw = fromEvent(e)
    if (!hw) return
    hw.activeSessionId = id === undefined || id === null ? undefined : str(id)
    if (hw.activeSessionId && hw.win.isFocused()) manager.markRead(hw.activeSessionId)
  })
  on('toggle-tag', (_e, id, tagId) => manager.toggleTag(str(id), str(tagId)))
  on('next-step', (_e, id) => manager.nextStep(str(id)))
  on('set-step', (_e, id, stepId) => manager.setStep(str(id), str(stepId)))

  on('pty-write', (_e, id, data) => manager.write(str(id), str(data, 1024 * 1024)))
  on('pty-resize', (_e, id, cols, rows) => manager.resize(str(id), int(cols), int(rows)))
  handle('pty-buffer', (_e, id) => manager.buffer(str(id)))

  handle('list-dir', async (_e, dir) => listDir(await allowedPath(dir)))
  handle('read-file', async (_e, path) => readText(await allowedPath(path)))
  handle('write-file', async (_e, path, content) => writeText(await allowedPath(path), str(content, 50 * 1024 * 1024)))
  handle('head-content', async (_e, path) => headContent(await allowedPath(path)))
  handle('git-status', (_e, workspace) => gitStatus(workspacePath(workspace)))
  handle('list-files', (_e, workspace) => listFiles(workspacePath(workspace)))
  handle('resolve-links', async (_e, cwd, candidates) => {
    const root = workspacePath(cwd)
    if (!Array.isArray(candidates)) return []
    const found = await resolveLinks(root, candidates.slice(0, 50).map((c) => str(c, 1024)))
    // Links only open files the editor may read.
    const roots = allowedRoots()
    return found.filter((f) => roots.some((r) => isInside(r, f.path)))
  })
  handle('config-path', (_e, file) => manager.configFilePath(str(file)))

  // One layout per workspace, so each folder reopens with its own tabs and splits.
  const layoutFile = (projectId: unknown) => `layout-${str(projectId).replace(/[^\w-]/g, '')}.json`
  handle('load-layout', (_e, projectId) => store.readState<unknown>(layoutFile(projectId), null))
  on('save-layout', (_e, projectId, layout) => {
    if (JSON.stringify(layout ?? null).length > 5 * 1024 * 1024) return
    store.writeSoon(layoutFile(projectId), () => layout, 1000)
  })
  on('open-external', (_e, url) => {
    const u = str(url)
    if (/^https?:\/\//.test(u)) void shell.openExternal(u)
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

app.on('second-instance', () => {
  const hw = focused()
  if (hw) show(hw)
  else if (manager) show(createWindow())
})

app.whenReady().then(async () => {
  app.setName('Claude Hub')
  await loadLoginShellEnv()
  manager = new SessionManager(store, host)
  registerIpc()
  buildMenu()
  watchConfig()

  // Start the hook server before any window exists, so no session can spawn without it.
  const saved = store
    .readState<SavedWindow[]>('windows.json', [], Array.isArray)
    .filter((w) => !w.projectId || manager.project(w.projectId))
  await manager.start(saved.map((w) => w.projectId).filter((p): p is string => !!p))
  // Reopen the windows from last time, each with its workspace.
  if (saved.length) for (const w of saved) createWindow(w.projectId, w.bounds)
  else createWindow()

  if (DEV) await runDevAids()
})

/** Dev aids for testing without clicking through the UI; see the README. Unpackaged builds only. */
async function runDevAids(): Promise<void> {
  // CLAUDE_HUB_DEMO="claude|shell:<folder>[:jobTypeId]" opens the folder and starts a session.
  const demo = env('CLAUDE_HUB_DEMO')?.match(/^(claude|shell):([^:]+)(?::(.+))?$/)
  if (demo) {
    openFolderPath(demo[2], live()[0])
    const hw = live()[0]
    const session = await manager.create({ projectId: hw.projectId!, kind: demo[1] as 'claude' | 'shell', jobTypeId: demo[3] })
    hw.win.webContents.once('did-finish-load', () => setTimeout(() => command({ type: 'focusSession', sessionId: session.id }, hw), 500))
    // CLAUDE_HUB_DEMO_OPEN="<path>:<line>" opens a file the way a terminal link click does.
    const open = env('CLAUDE_HUB_DEMO_OPEN')?.match(/^(.+):(\d+)$/)
    if (open) setTimeout(() => command({ type: 'openFile', path: open[1], line: Number(open[2]) }, hw), 4000)
    // CLAUDE_HUB_DEMO_INPUT is typed into the session; it is a JSON string body ("\r" = Enter).
    const input = env('CLAUDE_HUB_DEMO_INPUT')
    if (input) {
      let text = input
      try {
        text = JSON.parse(JSON.stringify(input).replace(/\\\\/g, '\\'))
      } catch {
        // use as is
      }
      setTimeout(() => manager.write(session.id, text), Number(env('CLAUDE_HUB_DEMO_INPUT_DELAY') ?? 2500))
    }
  }
  // CLAUDE_HUB_SCREENSHOT=/path.png captures the first window after a delay and quits.
  const shot = env('CLAUDE_HUB_SCREENSHOT')
  if (shot) {
    setTimeout(async () => {
      const image = await live()[0].win.webContents.capturePage()
      writeFileSync(shot, image.toPNG())
      app.quit()
    }, Number(env('CLAUDE_HUB_SCREENSHOT_DELAY') ?? 6000))
  }
}

// macOS: clicking the Dock icon with no windows open brings one back.
app.on('activate', () => {
  if (manager && !live().length) show(createWindow())
})

app.on('before-quit', () => {
  if (!manager) return
  // Remember the open windows before they close (closing them would empty the list).
  store.flush('windows.json', () => lastWindows ?? windowsSnapshot())
  quitting = true
  store.flushAll()
  manager.shutdown()
  folderWatcher.close()
})

// On macOS the app (and its Claude sessions) keeps running with no windows, like other Mac apps.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
