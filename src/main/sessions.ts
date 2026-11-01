import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { currentStep, needsAttention } from '../shared/tags'
import type {
  AttentionState,
  HubState,
  JobType,
  NewSessionOptions,
  PrInfo,
  Project,
  Session,
  SessionRepo
} from '../shared/types'
import { CONFIG_FILES, loadConfig, type LoadedConfig } from './config'
import { getEnv, which } from './env'
import { currentBranch, fetchPr, findRepos, repoFor, toPosix } from './git'
import { HookServer, shouldNotify, stateForEvent, type HookEvent } from './hooks'
import { PtyManager } from './pty'
import type { JsonStore } from './store'

/** What the session manager needs from the Electron side. */
export interface Host {
  stateChanged(): void
  ptyData(sessionId: string, data: string): void
  notify(session: Session, body: string): void
  /** True when the window is focused and this session's tab is the active one. */
  isViewing(sessionId: string): boolean
}

const QUIET_MS = 5000
const READY_QUIET_MS = 1500
const READY_MAX_MS = 15000
const PR_BACKOFF_MS = 5 * 60 * 1000

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
  /** Prompt waiting for the CLI to finish starting. */
  pendingPrompt?: { text: string; send: boolean }
  /** The CLI is showing a dialog (folder trust, login); the prompt waits until the user answers it. */
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
  /** PR lookups by repo + branch, shared by every session working in that repo. */
  private prCache = new Map<string, PrCacheEntry>()

  constructor(
    private store: JsonStore,
    private host: Host
  ) {
    this.config = loadConfig(store)
    this.projects = store.read<Project[]>('projects.json', [])
    this.recentFolders = store.read<string[]>('recent.json', [])
    this.sessions = store.read<Session[]>('sessions.json', []).map(migrateSession)
    this.hooks = new HookServer((e) => this.onHook(e))
    this.ptys = new PtyManager(
      (id, data) => this.onPtyData(id, data),
      (id, code) => this.onPtyExit(id, code)
    )
  }

  /** Starts the hook server and resumes sessions that were running in the workspaces being reopened. */
  async start(openProjectIds: string[]): Promise<void> {
    await this.hooks.start()
    this.store.write('hub-hooks.json', JSON.parse(this.hooks.settingsJson()))
    const wasRunning = new Set(this.sessions.filter((s) => s.running).map((s) => s.id))
    for (const s of this.sessions) {
      s.running = false
      s.attentionState = 'exited'
      s.unread = false
    }
    if (this.config.settings.restoreOnLaunch) {
      const open = new Set(openProjectIds)
      for (const s of this.sessions) if (wasRunning.has(s.id) && open.has(s.projectId)) this.spawn(s, true)
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
      jobTypes: this.config.jobTypes,
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
    const now = new Date().toISOString()
    const job = opts.jobTypeId ? this.config.jobTypes.find((j) => j.id === opts.jobTypeId) : undefined
    const count = this.sessions.filter((s) => s.projectId === project.id).length
    const session: Session = {
      id: randomUUID(),
      projectId: project.id,
      name: opts.name?.trim() || (count ? `${project.name} ${count + 1}` : project.name),
      kind: opts.kind,
      cwd: project.path,
      repos: [],
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
    if (job && opts.kind === 'claude') this.applyJob(session, job)
    // A workspace that is itself a repo is always the session's repo.
    const repos = await findRepos(project.path)
    if (repos.length === 1 && repos[0] === toPosix(project.path).replace(/\/$/, '')) await this.addRepo(session, repos[0])
    this.sessions.push(session)
    this.spawn(session, false)
    return session
  }

  restart(id: string): void {
    const s = this.get(id)
    if (s) this.spawn(s, true)
  }

  close(id: string): void {
    this.ptys.remove(id)
    this.clearRuntime(id)
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.changed()
  }

  rename(id: string, name: string): void {
    this.update(id, (s) => {
      if (name.trim()) s.name = name.trim()
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

  private spawn(session: Session, resume: boolean): void {
    const settings = this.config.settings
    const env: NodeJS.ProcessEnv = {
      ...getEnv(),
      CLAUDE_HUB_SESSION_ID: session.id,
      CLAUDE_HUB_TOKEN: this.hooks.token,
      CLAUDE_HUB_PORT: String(this.hooks.port)
    }
    let file: string
    let args: string[]
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
      args = [...settings.claudeArgs]
      if (settings.hooksEnabled) args.push('--settings', this.store.path('hub-hooks.json'))
      if (resume && session.claudeSessionId) args.push('--resume', session.claudeSessionId)
      // .cmd shims can't be spawned directly on Windows.
      if (/\.(cmd|bat)$/i.test(exe)) {
        file = process.env.ComSpec || 'cmd.exe'
        args = ['/d', '/c', exe, ...args]
      } else {
        file = exe
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
    // A new session starts on the job's first step: paste its prompt once the CLI is ready.
    if (!resume && session.kind === 'claude') {
      const step = currentStep(session)
      if (step?.prompt) rt.pendingPrompt = { text: step.prompt, send: !!step.autoSend }
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
      // Never type into a dialog: a pasted prompt plus Enter could pick an option.
      rt.awaitingUser = true
      this.setState(s, 'needs-you', 'Waiting for you to answer a prompt')
      return
    }
    if (s.attentionState === 'starting') this.setState(s, this.usesFallback(s) ? 'quiet' : 'idle')
    if (rt.pendingPrompt) {
      const { text, send } = rt.pendingPrompt
      rt.pendingPrompt = undefined
      this.pastePrompt(id, text, send)
    }
  }

  /** Pastes now, or holds the prompt while the CLI is starting or waiting on a permission prompt or dialog. */
  private deliverPrompt(s: Session, text: string, send: boolean): void {
    const rt = this.rt(s.id)
    if (s.attentionState === 'starting' || s.attentionState === 'needs-you' || rt.awaitingUser)
      rt.pendingPrompt = { text, send }
    else this.pastePrompt(s.id, text, send)
  }

  private pastePrompt(id: string, text: string, send: boolean): void {
    // Bracketed paste keeps multi-line prompts as one input instead of submitting at each newline.
    this.ptys.write(id, `\x1b[200~${text}\x1b[201~`)
    if (send) setTimeout(() => this.ptys.write(id, '\r'), 150)
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

  private onHook(event: HookEvent): void {
    if (process.env.CLAUDE_HUB_DEBUG) console.log(`[hook] ${event.name} ${event.hubSessionId}`)
    const s = this.get(event.hubSessionId)
    if (!s) return
    const claudeId = typeof event.payload.session_id === 'string' ? event.payload.session_id : undefined
    s.hookSeen = true
    if (claudeId) s.claudeSessionId = claudeId
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
      // A prompt held back while Claude was asking for permission goes in now.
      const rt = this.rt(s.id)
      if (rt.pendingPrompt && !rt.awaitingUser) {
        const { text, send } = rt.pendingPrompt
        rt.pendingPrompt = undefined
        this.pastePrompt(s.id, text, send)
      }
      const step = currentStep(s)
      if (step?.advanceOn === 'stop') this.nextStep(s.id, 'Claude finished')
      void this.refreshBranches(s.id)
      this.schedulePrCheck(s.id, 3000)
    }
  }

  /**
   * Works out which repos of the workspace a session is working in, from the files its tools
   * touch, the directory Claude is in, and repo names in its shell commands.
   */
  private async trackRepos(s: Session, event: HookEvent): Promise<void> {
    if (event.name !== 'PreToolUse' && event.name !== 'PostToolUse' && event.name !== 'UserPromptSubmit') return
    const repos = await findRepos(s.cwd)
    if (!repos.length) return
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
        // "cd recipe-app", "recipe-app/src/x.ts", "git -C ./recipe-app status", but not "recipe-app-backend".
        if (new RegExp(`(^|[\\s'"=/])(\\./)?${rel}(?=$|[\\s'"/;&|)])`).test(input.command)) found.add(repo)
      }
    }
    let added = false
    for (const repo of found) {
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
    if (process.env.CLAUDE_HUB_DEBUG) console.log(`[state] ${s.name}: ${s.attentionState} -> ${state}`)
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

  // ---- job types -------------------------------------------------------

  private applyJob(s: Session, job: JobType): void {
    s.jobTypeId = job.id
    s.jobTypeName = job.name
    s.steps = structuredClone(job.steps)
    s.currentStepId = job.steps[0].id
    s.stepHistory = [{ stepId: job.steps[0].id, enteredAt: new Date().toISOString() }]
  }

  setJobType(id: string, jobTypeId: string | undefined): void {
    const job = jobTypeId ? this.config.jobTypes.find((j) => j.id === jobTypeId) : undefined
    this.update(id, (s) => {
      if (job) this.applyJob(s, job)
      else {
        s.jobTypeId = s.jobTypeName = s.steps = s.currentStepId = undefined
        s.stepHistory = []
      }
    })
    const s = this.get(id)
    const step = s && currentStep(s)
    if (s?.running && step?.prompt) this.deliverPrompt(s, step.prompt, !!step.autoSend)
  }

  nextStep(id: string, reason?: string): void {
    const s = this.get(id)
    if (!s?.steps) return
    const i = s.steps.findIndex((st) => st.id === s.currentStepId)
    if (i < 0 || i >= s.steps.length - 1) return
    this.setStep(id, s.steps[i + 1].id, reason)
  }

  setStep(id: string, stepId: string, reason?: string): void {
    const s = this.get(id)
    const step = s?.steps?.find((st) => st.id === stepId)
    if (!s || !step || s.currentStepId === stepId) return
    this.update(id, (x) => {
      x.currentStepId = stepId
      x.stepHistory.push({ stepId, enteredAt: new Date().toISOString() })
    })
    if (reason) this.host.notify(s, `${reason}: moved to "${step.name}"`)
    if (s.running && step.prompt) {
      this.deliverPrompt(s, step.prompt, !!step.autoSend)
    }
    // A step waiting on GitHub may already be satisfied.
    if (typeof step.advanceOn === 'object') this.schedulePrCheck(id, 1000)
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
    entry.pending = fetchPr(repo.path, this.config.settings.botLogins).then(({ pr, error }) => {
      entry.pr = pr
      // Rate limits and auth problems: back off instead of hammering gh.
      entry.error = !!error
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
    const step = currentStep(s)
    if (step && typeof step.advanceOn === 'object' && conditions.has(step.advanceOn.github)) {
      this.nextStep(id, `GitHub: ${step.advanceOn.github}`)
    }
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

/** True when the screen shows one of the CLI's selection dialogs (folder trust, login, theme, new-feature offers). */
export function showsDialog(screen: string): boolean {
  return /Enter to confirm|trust this folder|Do you trust/i.test(screen)
}

/** Sessions saved before workspaces had one branch/PR for their own folder. */
function migrateSession(raw: Session): Session {
  const old = raw as Session & { branch?: string; pr?: PrInfo }
  if (!Array.isArray(old.repos)) {
    old.repos = old.branch ? [{ path: toPosix(old.cwd), name: basename(old.cwd), branch: old.branch, pr: old.pr }] : []
  }
  delete old.branch
  delete old.pr
  return old
}
