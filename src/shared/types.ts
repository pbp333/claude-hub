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


/** One change of a session's current step. */
export interface StepEntry {
  /** 0-based index of the step entered; equal to the step count when all are done. */
  step: number
  at: string
  by: 'user' | 'claude'
  note?: string
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
  /** Claude's id for the conversation now running (changes on /clear); used for --resume. */
  claudeSessionId?: string
  /** Every Claude conversation this session has had, oldest first, for the History tab. */
  claudeSessionIds: string[]
  /** Closed sessions are kept (archived) so History still shows their steps and tags. */
  archived?: boolean
  closedAt?: string
  attentionState: AttentionState
  /** Set when the state changed while the session wasn't focused; cleared on focus. */
  unread: boolean
  /** True once a hook event arrived, so the output-activity fallback stops. */
  hookSeen: boolean
  running: boolean
  tagIds: string[]
  /** Tag ids set by GitHub rules, across the session's repos. */
  autoTags: string[]
  /**
   * The session's own step list, set by the user or by Claude (hub tools). Names may be
   * empty: a plain count ("step 2 of 5") is fine.
   */
  steps?: string[]
  /** 0-based index of the step being worked on; equal to steps.length once all are done. */
  currentStep?: number
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
  showHistory: string
  closeTab: string
}

export interface Settings {
  /** Shell for plain-shell sessions. Empty = $SHELL on macOS, PowerShell on Windows. */
  shell: string
  /** "claude" (looked up on PATH) or a full path to the executable. */
  claudeCommand: string
  claudeArgs: string[]
  hooksEnabled: boolean
  /** When the user starts a skill (/name), ask Claude to plan steps from it and keep them and the session's tags current. */
  trackSkills: boolean
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
  /** Optional steps to start with. */
  steps?: string[]
  /** Continue this Claude conversation (from History) instead of starting a new one. */
  resumeClaudeSessionId?: string
  /**
   * Folder to run in, inside the workspace; defaults to the workspace. Set only by the main
   * process (resuming a conversation that was started in a subfolder), never from the UI.
   */
  cwd?: string
}

/** One Claude conversation from the workspace's transcripts. */
export interface HistoryItem {
  claudeSessionId: string
  title: string
  firstPrompt?: string
  startedAt: string
  endedAt: string
  /** Prompts plus replies. */
  messages: number
  /** Time spent in the conversation: gaps over 30 minutes between messages don't count. */
  activeMs: number
  branch?: string
  cwd: string
  sizeBytes: number
}

export type TranscriptEntry =
  | { kind: 'user' | 'assistant' | 'command'; text: string; at: string }
  | {
      kind: 'tool'
      name: string
      summary: string
      /** Tool input as pretty JSON, clipped. */
      input: string
      result?: string
      isError?: boolean
      /** Set when the tool ran a subagent; its own transcript can be loaded on demand. */
      agentId?: string
      at: string
    }

export interface Transcript {
  claudeSessionId: string
  title: string
  startedAt?: string
  branch?: string
  entries: TranscriptEntry[]
  /** Only the latest part of a very long conversation is included. */
  truncated: boolean
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
  | { type: 'showHistory' }
  | { type: 'openTranscript'; claudeSessionId: string; title: string }
  | { type: 'closeTab' }
  | { type: 'editSteps'; sessionId?: string }
  | { type: 'focusSession'; sessionId: string }
  | { type: 'switchSession'; index: number }
  | { type: 'openFile'; path: string; line?: number; column?: number }
  | { type: 'rename'; sessionId: string }
