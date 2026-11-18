import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { cleanSteps, clampStep, progressLabel } from '../shared/steps'
import { needsAttention } from '../shared/tags'
import type {
  AttentionState,
  HubState,
  NewSessionOptions,
  PrInfo,
  Project,
  Session,
  SessionRepo
} from '../shared/types'
import { CONFIG_FILES, loadConfig, type LoadedConfig } from './config'
import { cmdShimCommandLine, getEnv, which } from './env'
import { isInside } from './files'
import { claudeProjectsDir, closestConversation, listHistory } from './history'
import { currentBranch, fetchPr, findRepos, repoFor, toPosix } from './git'
import { HookServer, isClaudeSessionId, shouldNotify, showsDialog, stateForEvent, type HookEvent } from './hooks'
import { writePlugin } from './plugin'
import { PtyManager } from './pty'
import { applyStepTool, describeSteps, stepContext, type ToolResult } from './stepTools'
import type { JsonStore } from './store'

/** What the session manager needs from the Electron side. */
export interface Host {
  stateChanged(): void
  ptyData(sessionId: string, data: string): void
  notify(session: Session, body: string): void
  /** True when the window is focused and this session's tab is the active one. */
  isViewing(sessionId: string): boolean
}

const debug = !!process.env.CLAUDE_HUB_DEBUG && !app.isPackaged

const QUIET_MS = 5000
const READY_QUIET_MS = 1500
const READY_MAX_MS = 15000
const PR_BACKOFF_MS = 5 * 60 * 1000
const MAX_ARCHIVED = 300

interface PrCacheEntry {
  pr?: PrInfo
  at: number
  error?: boolean
  pending?: Promise<void>
}

interface Runtime {
  quietTimer?: NodeJS.Timeout
  readyTimer?: NodeJS.Timeout
  readyDeadline?: NodeJS.Timeout
  /** The CLI is showing a dialog (folder trust, login) that the user has to answer. */
  awaitingUser?: boolean
  nextPrCheck: number
  prTimer?: NodeJS.Timeout
}

export class SessionManager {
  config: LoadedConfig
  projects: Project[]
  sessions: Session[]
  recentFolders: string[]
  readonly hooks: HookServer
  private ptys: PtyManager
  private runtime = new Map<string, Runtime>()
  private pollTimer?: NodeJS.Timeout
  private quitting = false
  /** Spawn generation per session; hook events carry "<id>.<generation>". */
  private generations = new Map<string, number>()
  /** PR lookups by repo + branch, shared by every session working in that repo. */
  private prCache = new Map<string, PrCacheEntry>()

  constructor(
    private store: JsonStore,
    private host: Host
  ) {
    this.config = loadConfig(store)
    // A damaged state file is set aside (<file>.corrupt) rather than stopping the app from starting.
    this.projects = store.readState<Project[]>('projects.json', [], Array.isArray)
    this.recentFolders = store.readState<string[]>('recent.json', [], Array.isArray)
    this.sessions = store.readState<Session[]>('sessions.json', [], Array.isArray).map(migrateSession)
    this.hooks = new HookServer({
      onEvent: (e) => this.onHook(e),
      onTool: (key, name, args) => this.onStepTool(key, name, args)
    })
    this.ptys = new PtyManager(
      (id, data) => this.onPtyData(id, data),
      (id, code) => this.onPtyExit(id, code)
    )
  }

  /** Starts the hook server and resumes sessions that were running in the workspaces being reopened. */
  async start(openProjectIds: string[]): Promise<void> {
    await this.hooks.start()
    this.store.write('hub-hooks.json', JSON.parse(this.hooks.settingsJson()))
    this.store.write('hub-mcp.json', JSON.parse(this.hooks.mcpConfigJson()))
    try {
      writePlugin(this.store.path('claude-plugin'))
    } catch (err) {
      console.error('Could not write the Claude plugin:', err)
    }
    const wasRunning = new Set(this.sessions.filter((s) => s.running && !s.archived).map((s) => s.id))
    for (const s of this.sessions) {
      s.running = false
      s.attentionState = 'exited'
      s.unread = false
    }
    if (this.config.settings.restoreOnLaunch) {
      const open = new Set(openProjectIds)
      for (const s of this.sessions) if (wasRunning.has(s.id) && open.has(s.projectId)) void this.resume(s)
    }
    this.pollTimer = setInterval(() => this.pollPrs(), 15000)
    this.changed()
  }

  snapshot(): HubState {
    return {
      projects: this.projects,
      sessions: this.sessions,
      tags: this.config.tags,
      rules: this.config.rules,
      settings: this.config.settings,
      configErrors: this.config.errors,
      recentFolders: this.recentFolders,
      configDir: this.store.dir,
      platform: process.platform
    }
  }

  reloadConfig(): void {
    this.config = loadConfig(this.store)
    this.changed()
  }

  configFilePath(file: string): string | undefined {
    return CONFIG_FILES.includes(file) ? this.store.path(file) : undefined
  }

  get(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id)
  }

  // ---- lifecycle -------------------------------------------------------

  /** Registers a folder as a workspace (or finds it) and moves it to the top of the recent list. */
  openWorkspace(folder: string): Project {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`Folder not found: ${folder}`)
    const project = this.ensureProject(folder)
    this.recentFolders = [folder, ...this.recentFolders.filter((f) => f !== folder)].slice(0, 15)
    this.store.write('recent.json', this.recentFolders)
    this.changed()
    return project
  }

  project(id: string | undefined): Project | undefined {
    return id ? this.projects.find((p) => p.id === id) : undefined
  }

  /** Every session runs in its workspace folder, so Claude sees all of its repos and its .claude config. */
  async create(opts: NewSessionOptions): Promise<Session> {
    const project = this.project(opts.projectId)
    if (!project) throw new Error('No folder is open in this window')
    if (!existsSync(project.path)) throw new Error(`Folder not found: ${project.path}`)
    const cwd = opts.cwd && isInside(project.path, opts.cwd) && existsSync(opts.cwd) ? opts.cwd : project.path
    const now = new Date().toISOString()
    const count = this.sessions.filter((s) => s.projectId === project.id && !s.archived).length
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      name: opts.name?.trim() || (count ? `${project.name} ${count + 1}` : project.name),
      kind: opts.kind,
      cwd,
      repos: [],
      claudeSessionIds: [],
      attentionState: 'starting',
      unread: false,
      hookSeen: false,
      running: false,
      tagIds: [],
      autoTags: [],
      stepHistory: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now
    }
    const steps = Array.isArray(opts.steps) ? cleanSteps(opts.steps.filter((x) => typeof x === 'string')) : []
    // A plain count arrives as empty names; cleanSteps would drop those.
    const stepCount = Array.isArray(opts.steps) && opts.steps.every((x) => x === '') ? Math.min(opts.steps.length, 30) : 0
    if (steps.length || stepCount) {
      session.steps = steps.length ? steps : Array(stepCount).fill('')
      session.currentStep = 0
    }
    // A workspace that is itself a repo is always the session's repo.
    const repos = await findRepos(project.path)
    if (repos.length === 1 && repos[0] === toPosix(project.path).replace(/\/$/, '')) await this.addRepo(session, repos[0])
    const resume = opts.resumeClaudeSessionId
    if (resume && isClaudeSessionId(resume)) {
      session.claudeSessionId = resume
      session.claudeSessionIds = [resume]
    }
    this.sessions.push(session)
    this.spawn(session, !!session.claudeSessionId)
    return session
  }

  /**
   * Continues a conversation from History. A hub session that already had it is reused,
   * keeping its tags and job steps (and brought back from the archive if it was closed);
   * otherwise a new session resumes it.
   */
  async resumeFromHistory(projectId: string, claudeSessionId: string, title?: string, cwd?: string): Promise<string> {
    if (!isClaudeSessionId(claudeSessionId)) throw new Error('Not a Claude conversation id')
    const owner = this.sessions.find(
      (s) => s.projectId === projectId && (s.claudeSessionId === claudeSessionId || s.claudeSessionIds.includes(claudeSessionId))
    )
    if (owner) {
      if (owner.running && owner.claudeSessionId === claudeSessionId) return owner.id
      owner.archived = false
      owner.closedAt = undefined
      owner.claudeSessionId = claudeSessionId
      this.spawn(owner, true)
      return owner.id
    }
    // claude --resume looks the conversation up by folder, so run where it was started.
    const session = await this.create({
      projectId,
      kind: 'claude',
      name: title?.slice(0, 80),
      resumeClaudeSessionId: claudeSessionId,
      cwd
    })
    return session.id
  }

  restart(id: string): void {
    const s = this.get(id)
    if (s) void this.resume(s)
  }

  /**
   * Starts a session again, continuing its Claude conversation. If the session's own
   * conversation isn't known (or its transcript is gone), the conversation in this folder
   * whose title is closest to the session's name is resumed instead; failing that, Claude's
   * own resume picker opens, searching for the name.
   */
  private async resume(s: Session): Promise<void> {
    if (s.kind !== 'claude') return this.spawn(s, true)
    const project = this.project(s.projectId)
    let items: Awaited<ReturnType<typeof listHistory>> = []
    try {
      if (project) items = await listHistory(claudeProjectsDir(getEnv()), project.path)
    } catch {
      items = []
    }
    if (s.claudeSessionId && items.some((i) => i.claudeSessionId === s.claudeSessionId)) return this.spawn(s, true)
    const busy = new Set(
      this.sessions.filter((x) => x.id !== s.id && x.running && !x.archived && x.claudeSessionId).map((x) => x.claudeSessionId!)
    )
    const match = closestConversation(items, s.name, busy)
    if (match) {
      this.update(s.id, (x) => {
        x.claudeSessionId = match.claudeSessionId
        if (!x.claudeSessionIds.includes(match.claudeSessionId)) x.claudeSessionIds.push(match.claudeSessionId)
        // claude --resume finds a conversation by the folder it was recorded in.
        if (project && match.cwd && isInside(project.path, match.cwd) && existsSync(match.cwd)) x.cwd = match.cwd
      })
      this.spawn(s, true)
      this.ptys.print(s.id, `\x1b[2mResuming "${match.title}", the conversation closest to this session's name.\x1b[0m\r\n`)
      return
    }
    // Only a session that had a conversation (and lost track of it) gets the picker; one that
    // never talked to Claude just starts fresh.
    const hadConversation = !!s.claudeSessionId || s.claudeSessionIds.length > 0
    this.update(s.id, (x) => (x.claudeSessionId = undefined))
    this.spawn(s, true, hadConversation ? s.name : undefined)
  }

  /** Stops the session and moves it to the archive, where History still finds it. */
  close(id: string): void {
    this.ptys.remove(id)
    this.clearRuntime(id)
    this.retireSpawnKey(id)
    const s = this.get(id)
    if (s) {
      s.archived = true
      s.closedAt = new Date().toISOString()
      s.running = false
      s.attentionState = 'exited'
      s.unread = false
    }
    // Keep the archive bounded: the oldest closed sessions go first.
    const archived = this.sessions.filter((x) => x.archived).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    const drop = new Set(archived.slice(MAX_ARCHIVED).map((x) => x.id))
    if (drop.size) this.sessions = this.sessions.filter((x) => !drop.has(x.id))
    this.changed()
  }

  rename(id: string, name: string): void {
    this.update(id, (s) => {
      if (name.trim()) s.name = name.trim().slice(0, 200)
    })
  }

  write(id: string, data: string): void {
    this.ptys.write(id, data)
    const rt = this.runtime.get(id)
    const s = this.get(id)
    if (rt?.awaitingUser && s) {
      // The user answered the dialog: wait for the CLI to settle again, then re-check.
      rt.awaitingUser = false
      s.attentionState = 'starting'
      clearTimeout(rt.readyDeadline)
      rt.readyDeadline = setTimeout(() => this.onReady(id), READY_MAX_MS)
      this.changed()
    }
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.resize(id, cols, rows)
  }

  buffer(id: string): string {
    return this.ptys.buffer(id)
  }

  markRead(id: string): void {
    const s = this.get(id)
    if (s?.unread) this.update(id, (x) => (x.unread = false))
  }

  /** Flush state and stop everything; sessions that were running restart on next launch. */
  shutdown(): void {
    this.quitting = true
    clearInterval(this.pollTimer)
    this.store.flush('sessions.json', () => this.sessions)
    this.ptys.killAll()
    this.hooks.stop()
  }

  /** `searchName`: no known conversation; open Claude's resume picker searching for this. */
  private spawn(session: Session, resume: boolean, searchName?: string): void {
    const settings = this.config.settings
    // Each process gets a new spawn key and token: hooks from a process that was replaced
    // (restart) or from another session are rejected or ignored.
    this.retireSpawnKey(session.id)
    const generation = (this.generations.get(session.id) ?? 0) + 1
    this.generations.set(session.id, generation)
    const spawnKey = `${session.id}.${generation}`
    const env: NodeJS.ProcessEnv = {
      ...getEnv(),
      CLAUDE_HUB_SESSION_ID: spawnKey,
      CLAUDE_HUB_TOKEN: this.hooks.register(spawnKey)
    }
    let file: string
    let args: string[] | string
    if (session.kind === 'shell') {
      file = settings.shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh')
      args = process.platform === 'win32' ? [] : ['-l']
    } else {
      const exe = which(settings.claudeCommand)
      if (!exe) {
        this.ptys.print(
          session.id,
          `\r\n\x1b[31mCould not find "${settings.claudeCommand}" on your PATH.\x1b[0m\r\n` +
            'Install Claude Code, or set "claudeCommand" in settings.json to its full path.\r\n'
        )
        this.update(session.id, (s) => {
          s.running = false
          s.attentionState = 'exited'
        })
        return
      }
      const claudeArgs = [...settings.claudeArgs]
      if (settings.hooksEnabled)
        claudeArgs.push(
          '--settings',
          this.store.path('hub-hooks.json'),
          '--mcp-config',
          this.store.path('hub-mcp.json'),
          '--plugin-dir',
          this.store.path('claude-plugin')
        )
      if (resume && session.claudeSessionId && isClaudeSessionId(session.claudeSessionId))
        claudeArgs.push('--resume', session.claudeSessionId)
      else if (resume && searchName) {
        // One "--resume=<name>" argument, so a name can't be read as another option.
        const name = searchName.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)
        if (name) claudeArgs.push(`--resume=${name}`)
      }
      // .cmd shims can't be spawned directly on Windows; cmd.exe gets one escaped command line.
      if (/\.(cmd|bat)$/i.test(exe)) {
        file = process.env.ComSpec || 'cmd.exe'
        args = cmdShimCommandLine(exe, claudeArgs)
      } else {
        file = exe
        args = claudeArgs
      }
    }
    this.clearRuntime(session.id)
    const rt = this.rt(session.id)
    try {
      this.ptys.spawn(session.id, file, args, session.cwd, env)
    } catch (err) {
      this.ptys.print(session.id, `\r\n\x1b[31mFailed to start: ${(err as Error).message}\x1b[0m\r\n`)
      this.update(session.id, (s) => {
        s.running = false
        s.attentionState = 'exited'
      })
      return
    }
    rt.readyDeadline = setTimeout(() => this.onReady(session.id), READY_MAX_MS)
    this.update(session.id, (s) => {
      s.running = true
      s.hookSeen = false
      s.attentionState = 'starting'
    })
  }

  private onReady(id: string): void {
    const rt = this.rt(id)
    clearTimeout(rt.readyTimer)
    clearTimeout(rt.readyDeadline)
    rt.readyTimer = rt.readyDeadline = undefined
    const s = this.get(id)
    if (!s) return
    if (s.kind === 'claude' && showsDialog(this.ptys.screenText(id))) {
      // The session needs the user until they answer it.
      rt.awaitingUser = true
      this.setState(s, 'needs-you', 'Waiting for you to answer a prompt')
      return
    }
    if (s.attentionState === 'starting') this.setState(s, this.usesFallback(s) ? 'quiet' : 'idle')
  }

  private onPtyData(id: string, data: string): void {
    this.host.ptyData(id, data)
    const s = this.get(id)
    if (!s) return
    s.lastActivityAt = new Date().toISOString()
    const rt = this.rt(id)
    if (s.attentionState === 'starting') {
      clearTimeout(rt.readyTimer)
      rt.readyTimer = setTimeout(() => this.onReady(id), READY_QUIET_MS)
      return
    }
    if (this.usesFallback(s)) {
      if (s.attentionState !== 'active') this.setState(s, 'active')
      clearTimeout(rt.quietTimer)
      rt.quietTimer = setTimeout(() => {
        const cur = this.get(id)
        if (cur?.running && cur.attentionState === 'active') this.setState(cur, 'quiet')
      }, QUIET_MS)
    }
  }

  private onPtyExit(id: string, code: number): void {
    if (this.quitting) return
    this.ptys.print(id, `\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`)
    this.clearRuntime(id)
    this.retireSpawnKey(id)
    this.update(id, (s) => {
      s.running = false
      s.attentionState = 'exited'
    })
  }

  /** Plain shells, and claude with hooks turned off, get state from terminal output instead of hooks. */
  private usesFallback(s: Session): boolean {
    return s.kind === 'shell' || (!this.config.settings.hooksEnabled && !s.hookSeen)
  }

  // ---- hook events -----------------------------------------------------

  /** The session whose current process has this spawn key; a replaced process gets nothing. */
  private sessionForKey(key: string): Session | undefined {
    const dot = key.lastIndexOf('.')
    const id = key.slice(0, dot)
    if (dot < 0 || `${id}.${this.generations.get(id)}` !== key) return undefined
    return this.get(id)
  }

  /** Handles a hook event; returns the hook's reply (context added to the prompt), if any. */
  private onHook(event: HookEvent): object | undefined {
    if (debug) console.log(`[hook] ${event.name} ${event.hubSessionId}`)
    const s = this.sessionForKey(event.hubSessionId)
    if (!s) return undefined
    // Claude's session id ends up on the command line (--resume), so take only real ids.
    const raw = event.payload.session_id
    const claudeId = typeof raw === 'string' && isClaudeSessionId(raw) ? raw : undefined
    s.hookSeen = true
    if (claudeId) {
      s.claudeSessionId = claudeId
      if (!s.claudeSessionIds.includes(claudeId)) s.claudeSessionIds.push(claudeId)
    }
    s.lastActivityAt = new Date().toISOString()
    const next = stateForEvent(event)
    if (next && next !== s.attentionState) {
      const message = typeof event.payload.message === 'string' ? event.payload.message : undefined
      this.setState(s, next, message)
    } else {
      this.changed()
    }
    void this.trackRepos(s, event)
    if (event.name === 'Stop') {
      void this.refreshBranches(s.id)
      this.schedulePrCheck(s.id, 3000)
    }
    if (event.name === 'UserPromptSubmit') {
      const context = stepContext(s)
      if (context) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }
    }
    return undefined
  }

  /** The step tools (get_steps, set_steps, complete_step, set_step), called by Claude through the hub's MCP server. */
  private onStepTool(key: string, name: string, args: Record<string, unknown>): ToolResult {
    const s = this.sessionForKey(key)
    if (!s) return { text: 'This Claude process is no longer managed by Claude Hub.', isError: true }
    if (name === 'get_steps') return { text: describeSteps(s) }
    const change = applyStepTool(s, name, args)
    if (typeof change === 'string') return { text: change, isError: true }
    this.changeSteps(s.id, change.steps, change.currentStep, 'claude', change.note)
    return { text: change.text }
  }

  /**
   * Works out which repos of the workspace a session is working in, from the files its tools
   * touch, the directory Claude is in, and repo names in its shell commands.
   */
  private async trackRepos(s: Session, event: HookEvent): Promise<void> {
    if (event.name !== 'PreToolUse' && event.name !== 'PostToolUse' && event.name !== 'UserPromptSubmit') return
    const repos = await findRepos(s.cwd)
    if (!repos.length || !this.get(s.id)) return
    const candidates: string[] = []
    const absolute = (p: unknown) => (typeof p === 'string' && p ? (isAbsolute(p) ? p : resolve(s.cwd, p)) : undefined)
    const cwd = absolute(event.payload.cwd)
    if (cwd) candidates.push(cwd)
    const input = (event.payload.tool_input ?? {}) as Record<string, unknown>
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const p = absolute(input[key])
      if (p) candidates.push(p)
    }
    const found = new Set<string>()
    for (const c of candidates) {
      const repo = repoFor(repos, c)
      if (repo) found.add(repo)
    }
    if (typeof input.command === 'string') {
      const root = toPosix(s.cwd).replace(/\/$/, '')
      for (const repo of repos) {
        if (repo === root) continue
        const rel = repo.slice(root.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // "cd web", "web/src/x.ts", "git -C ./web status", but not "web-admin".
        if (new RegExp(`(^|[\\s'"=/])(\\./)?${rel}(?=$|[\\s'"/;&|)])`).test(input.command)) found.add(repo)
      }
    }
    let added = false
    for (const repo of found) {
      if (!this.get(s.id)) return
      if (!s.repos.some((r) => r.path === repo)) {
        await this.addRepo(s, repo)
        added = true
      }
    }
    if (added) {
      this.changed()
      this.schedulePrCheck(s.id, 1000)
    }
  }

  private async addRepo(s: Session, repo: string): Promise<void> {
    if (s.repos.some((r) => r.path === repo)) return
    s.repos.push({ path: repo, name: basename(repo), branch: await currentBranch(repo) })
    s.repos.sort((a, b) => a.name.localeCompare(b.name))
  }

  private setState(s: Session, state: AttentionState, message?: string): void {
    if (debug) console.log(`[state] ${s.name}: ${s.attentionState} -> ${state}`)
    s.attentionState = state
    s.updatedAt = new Date().toISOString()
    if (shouldNotify(state) && !this.host.isViewing(s.id)) {
      s.unread = true
      const body = message || (state === 'needs-you' ? 'Needs you' : 'Finished, your turn')
      this.host.notify(s, body)
    }
    this.changed()
  }

  // ---- tags ------------------------------------------------------------

  toggleTag(id: string, tagId: string): void {
    const tag = this.config.tags.find((t) => t.id === tagId)
    this.update(id, (s) => {
      if (s.tagIds.includes(tagId)) {
        s.tagIds = s.tagIds.filter((t) => t !== tagId)
        return
      }
      if (tag?.exclusive && tag.group) {
        const sameGroup = new Set(this.config.tags.filter((t) => t.group === tag.group && t.exclusive).map((t) => t.id))
        s.tagIds = s.tagIds.filter((t) => !sameGroup.has(t))
      }
      s.tagIds.push(tagId)
    })
  }

  // ---- steps -----------------------------------------------------------

  /** Replaces a session's steps (from the user); empty clears them. */
  setSteps(id: string, steps: string[]): void {
    const s = this.get(id)
    if (!s) return
    const names = steps.every((x) => x === '') ? steps.slice(0, 30) : cleanSteps(steps)
    if (!names.length) {
      this.update(id, (x) => {
        x.steps = x.currentStep = undefined
        x.stepHistory = []
      })
      return
    }
    this.changeSteps(id, names, clampStep(names, Math.min(s.currentStep ?? 0, names.length - 1)), 'user')
  }

  /** Moves the current step by `delta` (the Next/Back buttons and Cmd+Alt+N). */
  moveStep(id: string, delta: number): void {
    const s = this.get(id)
    if (!s?.steps?.length) return
    this.changeSteps(id, s.steps, clampStep(s.steps, (s.currentStep ?? 0) + delta), 'user')
  }

  /** Sets the current step (0-based; steps.length = all done). */
  goToStep(id: string, index: number): void {
    const s = this.get(id)
    if (!s?.steps?.length || !Number.isInteger(index)) return
    this.changeSteps(id, s.steps, clampStep(s.steps, index), 'user')
  }

  private changeSteps(id: string, steps: string[], currentStep: number, by: 'user' | 'claude', note?: string): void {
    const s = this.get(id)
    if (!s) return
    const moved = s.currentStep !== currentStep || !s.steps
    this.update(id, (x) => {
      x.steps = steps
      x.currentStep = currentStep
      if (moved) {
        x.stepHistory.push({ step: currentStep, at: new Date().toISOString(), by, ...(note ? { note } : {}) })
        if (x.stepHistory.length > 200) x.stepHistory.splice(0, x.stepHistory.length - 200)
      }
    })
    // Claude moving on is worth a heads-up when you're not looking at the session.
    if (by === 'claude' && moved && !this.host.isViewing(id)) {
      const label = currentStep >= steps.length ? 'All steps done' : `Now on ${progressLabel({ steps, currentStep })}`
      this.host.notify(s, `${label}${note ? ` (${note})` : ''}`)
    }
  }

  // ---- GitHub ----------------------------------------------------------

  private async refreshBranches(id: string): Promise<void> {
    const s = this.get(id)
    if (!s) return
    let changed = false
    for (const repo of s.repos) {
      const branch = await currentBranch(repo.path)
      if (branch !== repo.branch) {
        repo.branch = branch
        changed = true
      }
    }
    if (changed) this.update(id, () => undefined)
  }

  private schedulePrCheck(id: string, delayMs: number): void {
    if (!this.get(id)) return
    const rt = this.rt(id)
    clearTimeout(rt.prTimer)
    rt.prTimer = setTimeout(() => void this.checkPr(id, true), delayMs)
  }

  private pollPrs(): void {
    const now = Date.now()
    for (const s of this.sessions) {
      if (s.running && s.repos.some((r) => r.branch) && now >= this.rt(s.id).nextPrCheck) void this.checkPr(s.id, false)
    }
  }

  /** Looks up the PR for a repo's branch, reusing a recent result another session already fetched. */
  private async prFor(repo: SessionRepo, fresh: boolean): Promise<PrCacheEntry> {
    const key = `${repo.path}\0${repo.branch}`
    const maxAge = (this.config.settings.pollIntervalSec * 1000) / 2
    const cached = this.prCache.get(key)
    if (cached?.pending) {
      await cached.pending
      return this.prCache.get(key)!
    }
    if (cached && (cached.error ? Date.now() - cached.at < PR_BACKOFF_MS : !fresh && Date.now() - cached.at < maxAge))
      return cached
    const entry: PrCacheEntry = { at: Date.now() }
    entry.pending = fetchPr(repo.path, this.config.settings.botLogins)
      .then(({ pr, error }) => {
        entry.pr = pr
        // Rate limits and auth problems: back off instead of hammering gh.
        entry.error = !!error
      })
      .catch(() => {
        entry.error = true
      })
      .finally(() => {
        entry.at = Date.now()
        entry.pending = undefined
      })
    this.prCache.set(key, entry)
    await entry.pending
    return entry
  }

  private async checkPr(id: string, fresh: boolean): Promise<void> {
    const s = this.get(id)
    if (!s) return
    const rt = this.rt(id)
    rt.nextPrCheck = Date.now() + this.config.settings.pollIntervalSec * 1000
    const conditions = new Set<string>()
    for (const repo of s.repos) {
      if (!repo.branch) continue
      const entry = await this.prFor(repo, fresh)
      if (entry.error) continue
      repo.pr = entry.pr
      for (const c of entry.pr?.conditions ?? []) conditions.add(c)
    }
    const autoTags = this.config.rules.filter((r) => r.enabled && conditions.has(r.when)).map((r) => r.setTag)
    this.update(id, (x) => (x.autoTags = autoTags))
  }

  // ---- helpers ---------------------------------------------------------

  badgeCount(): number {
    return this.sessions.filter(needsAttention).length
  }

  private ensureProject(root: string): Project {
    const now = new Date().toISOString()
    let project = this.projects.find((p) => p.path === root)
    if (!project) {
      project = { id: randomUUID(), name: basename(root) || root, path: root, lastOpenedAt: now, updatedAt: now }
      this.projects.push(project)
    } else {
      project.lastOpenedAt = project.updatedAt = now
    }
    this.store.write('projects.json', this.projects)
    return project
  }

  private update(id: string, fn: (s: Session) => void): void {
    const s = this.get(id)
    if (!s) return
    fn(s)
    s.updatedAt = new Date().toISOString()
    this.changed()
  }

  private changed(): void {
    if (this.quitting) return
    this.store.writeSoon('sessions.json', () => this.sessions)
    this.host.stateChanged()
  }

  private rt(id: string): Runtime {
    let rt = this.runtime.get(id)
    if (!rt) {
      rt = { nextPrCheck: 0 }
      this.runtime.set(id, rt)
    }
    return rt
  }

  private retireSpawnKey(id: string): void {
    const generation = this.generations.get(id)
    if (generation !== undefined) this.hooks.unregister(`${id}.${generation}`)
  }

  private clearRuntime(id: string): void {
    const rt = this.runtime.get(id)
    if (!rt) return
    clearTimeout(rt.quietTimer)
    clearTimeout(rt.readyTimer)
    clearTimeout(rt.readyDeadline)
    clearTimeout(rt.prTimer)
    this.runtime.delete(id)
  }
}


/** Sessions saved before workspaces had one branch/PR for their own folder. */
function migrateSession(raw: Session): Session {
  const old = raw as Session & { branch?: string; pr?: PrInfo }
  if (!Array.isArray(old.repos)) {
    old.repos = old.branch ? [{ path: toPosix(old.cwd), name: basename(old.cwd), branch: old.branch, pr: old.pr }] : []
  }
  delete old.branch
  delete old.pr
  if (old.claudeSessionId && !isClaudeSessionId(old.claudeSessionId)) delete old.claudeSessionId
  if (!Array.isArray(old.claudeSessionIds)) old.claudeSessionIds = old.claudeSessionId ? [old.claudeSessionId] : []
  old.claudeSessionIds = old.claudeSessionIds.filter((id) => typeof id === 'string' && isClaudeSessionId(id))
  if (!Array.isArray(old.tagIds)) old.tagIds = []
  if (!Array.isArray(old.autoTags)) old.autoTags = []
  // Steps used to come from job types ({ id, name, ... } objects with a current step id).
  const legacy = old as Session & { currentStepId?: string; jobTypeId?: string; jobTypeName?: string; pendingStep?: unknown }
  if (Array.isArray(legacy.steps) && legacy.steps.some((x) => typeof x !== 'string')) {
    const objs = legacy.steps as unknown as { id?: string; name?: string }[]
    legacy.currentStep = Math.max(0, objs.findIndex((x) => x?.id === legacy.currentStepId))
    legacy.steps = cleanSteps(objs.map((x) => (typeof x?.name === 'string' ? x.name : '')))
    legacy.stepHistory = []
  }
  delete legacy.currentStepId
  delete legacy.jobTypeId
  delete legacy.jobTypeName
  delete legacy.pendingStep
  if (!Array.isArray(old.steps) || !old.steps.length) {
    delete old.steps
    delete old.currentStep
  } else old.currentStep = clampStep(old.steps, old.currentStep)
  if (!Array.isArray(old.stepHistory) || old.stepHistory.some((h) => typeof h?.step !== 'number')) old.stepHistory = []
  return old
}
