export type AttentionState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'needs-you'
  | 'done'
  | 'exited'
  // Output-activity fallback, used until a session's first hook event arrives.
  | 'active'
  | 'quiet'

export type SessionKind = 'claude' | 'shell'

/** A workspace: the folder a window has open. Sessions start in it; it may hold several git repos. */
export interface Project {
  id: string
  name: string
  path: string
  lastOpenedAt: string
  updatedAt: string
}

export interface Tag {
  id: string
  name: string
  color: string
  /** Tags in the same group are listed together; with `exclusive`, setting one clears the others. */
  group?: string
  exclusive?: boolean
  /** Electron accelerator that toggles the tag on the active session, e.g. "CmdOrCtrl+Alt+B". */
  shortcut?: string
}

export type PrCondition =
  | 'prOpen'
  | 'draft'
  | 'botReviewed'
  | 'approved'
  | 'changesRequested'
  | 'ciFailing'
  | 'ciPassing'
  | 'merged'

export interface Rule {
  id: string
  when: PrCondition
  /** Tag id to set while the condition holds. */
  setTag: string
  enabled: boolean
}

export type AdvanceOn = 'manual' | 'stop' | { github: PrCondition }

export interface JobStep {
  id: string
  name: string
  prompt?: string
  autoSend?: boolean
  advanceOn?: AdvanceOn
  /** Tag id or name set while the session is on this step. */
  tag?: string
}

export interface JobType {
  id: string
  name: string
  steps: JobStep[]
}

export interface StepEntry {
  stepId: string
  enteredAt: string
}

export interface PrInfo {
  number: number
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string
  conditions: PrCondition[]
  checkedAt: string
}

/** A git repo a session has worked in, found from the files its tools touched. */
export interface SessionRepo {
  /** Absolute path of the repo root. */
  path: string
  name: string
  branch?: string
  pr?: PrInfo
}

export interface Session {
  id: string
  /** The workspace this session belongs to. */
  projectId: string
  name: string
  kind: SessionKind
  cwd: string
  repos: SessionRepo[]
  claudeSessionId?: string
  attentionState: AttentionState
  /** Set when the state changed while the session wasn't focused; cleared on focus. */
  unread: boolean
  /** True once a hook event arrived, so the output-activity fallback stops. */
  hookSeen: boolean
  running: boolean
  tagIds: string[]
  /** Tag ids set by GitHub rules, across the session's repos. */
  autoTags: string[]
  jobTypeId?: string
  jobTypeName?: string
  /** Copied from the job type at start, so editing jobTypes.json never breaks a running session. */
  steps?: JobStep[]
  currentStepId?: string
  stepHistory: StepEntry[]
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

export interface Keybindings {
  newWindow: string
  openFolder: string
  newSession: string
  nextNeedsYou: string
  nextStep: string
  quickOpen: string
  commandPalette: string
  toggleFileTree: string
  closeTab: string
}

export interface Settings {
  /** Shell for plain-shell sessions. Empty = $SHELL on macOS, PowerShell on Windows. */
  shell: string
  /** "claude" (looked up on PATH) or a full path to the executable. */
  claudeCommand: string
  claudeArgs: string[]
  hooksEnabled: boolean
  pollIntervalSec: number
  botLogins: string[]
  notifications: boolean
  restoreOnLaunch: boolean
  terminalFont: string
  terminalFontSize: number
  /**
   * GPU (WebGL) terminal rendering. Off by default: on some GPU/display setups (seen on an
   * Intel Mac with an external display) it draws tiny, widely spaced glyphs. The DOM
   * renderer is always correct and fast enough for Claude's UI.
   */
  terminalWebgl: boolean
  keybindings: Keybindings
}

export interface ConfigError {
  file: string
  message: string
}

export interface HubState {
  projects: Project[]
  sessions: Session[]
  tags: Tag[]
  rules: Rule[]
  jobTypes: JobType[]
  settings: Settings
  configErrors: ConfigError[]
  recentFolders: string[]
  configDir: string
  platform: string
}

export interface NewSessionOptions {
  projectId: string
  name?: string
  kind: SessionKind
  jobTypeId?: string
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export type GitStatus = Record<string, 'M' | 'A' | 'D' | 'R' | 'U' | '?'>

/** What a window shows; undefined projectId = the welcome screen. */
export interface WindowInfo {
  projectId?: string
}

/** Commands sent from the app menu (keyboard shortcuts) to the UI. */
export type UiCommand =
  | { type: 'newSession' }
  | { type: 'nextNeedsYou' }
  | { type: 'nextStep' }
  | { type: 'quickOpen' }
  | { type: 'commandPalette' }
  | { type: 'toggleFileTree' }
  | { type: 'closeTab' }
  | { type: 'focusSession'; sessionId: string }
  | { type: 'switchSession'; index: number }
  | { type: 'openFile'; path: string; line?: number; column?: number }
  | { type: 'rename'; sessionId: string }
