import type { ConfigError, JobType, PrCondition, Rule, Settings, Tag } from '../shared/types'
import type { JsonStore } from './store'

export const PR_CONDITIONS: PrCondition[] = [
  'prOpen',
  'draft',
  'botReviewed',
  'approved',
  'changesRequested',
  'ciFailing',
  'ciPassing',
  'merged'
]

export const DEFAULT_SETTINGS: Settings = {
  shell: '',
  claudeCommand: 'claude',
  claudeArgs: [],
  hooksEnabled: true,
  pollIntervalSec: 60,
  botLogins: [],
  notifications: true,
  restoreOnLaunch: true,
  terminalFont: process.platform === 'win32' ? 'Cascadia Mono, Consolas, monospace' : 'Menlo, monospace',
  terminalFontSize: 13,
  keybindings: {
    newSession: 'CmdOrCtrl+T',
    nextNeedsYou: 'CmdOrCtrl+J',
    nextStep: 'CmdOrCtrl+Shift+N',
    quickOpen: 'CmdOrCtrl+P',
    commandPalette: 'CmdOrCtrl+Shift+P',
    toggleFileTree: 'CmdOrCtrl+B',
    closeTab: 'CmdOrCtrl+W'
  }
}

export const DEFAULT_TAGS: Tag[] = [
  { id: 'blocked', name: 'Blocked', color: '#e5484d', shortcut: 'CmdOrCtrl+Alt+B' },
  { id: 'needs-tests', name: 'Needs tests', color: '#f5a524' },
  { id: 'ready-to-merge', name: 'Ready to merge', color: '#30a46c' },
  { id: 'wf-draft', name: 'Draft', color: '#8b8d98', group: 'Workflow', exclusive: true },
  { id: 'wf-in-review', name: 'In review', color: '#3e63dd', group: 'Workflow', exclusive: true },
  { id: 'waiting-review', name: 'Waiting review', color: '#8e4ec6' },
  { id: 'pr-open', name: 'PR opened', color: '#3e63dd', group: 'GitHub' },
  { id: 'pr-draft', name: 'Draft PR', color: '#8b8d98', group: 'GitHub' },
  { id: 'bot-reviewed', name: 'Reviewed by bot', color: '#12a594', group: 'GitHub' },
  { id: 'approved', name: 'Approved', color: '#30a46c', group: 'GitHub' },
  { id: 'changes-requested', name: 'Changes requested', color: '#f76b15', group: 'GitHub' },
  { id: 'ci-failing', name: 'CI failing', color: '#e5484d', group: 'GitHub' },
  { id: 'merged', name: 'Merged', color: '#8e4ec6', group: 'GitHub' }
]

export const DEFAULT_RULES: Rule[] = [
  { id: 'pr-open', when: 'prOpen', setTag: 'pr-open', enabled: true },
  { id: 'draft', when: 'draft', setTag: 'pr-draft', enabled: true },
  { id: 'bot-reviewed', when: 'botReviewed', setTag: 'bot-reviewed', enabled: true },
  { id: 'approved', when: 'approved', setTag: 'approved', enabled: true },
  { id: 'changes-requested', when: 'changesRequested', setTag: 'changes-requested', enabled: true },
  { id: 'ci-failing', when: 'ciFailing', setTag: 'ci-failing', enabled: true },
  { id: 'merged', when: 'merged', setTag: 'merged', enabled: true }
]

export const DEFAULT_JOB_TYPES: JobType[] = [
  {
    id: 'feature',
    name: 'Feature',
    steps: [
      { id: 'plan', name: 'Plan', prompt: "Read the task and propose a plan. Don't write code yet.", advanceOn: 'manual' },
      { id: 'implement', name: 'Implement', prompt: 'Implement the agreed plan, with tests.', advanceOn: 'manual' },
      { id: 'pr', name: 'Open PR', prompt: 'Commit, push and open a PR.', advanceOn: { github: 'prOpen' } },
      { id: 'review', name: 'Review', advanceOn: { github: 'approved' }, tag: 'waiting-review' },
      { id: 'done', name: 'Done' }
    ]
  },
  {
    id: 'bugfix',
    name: 'Bug fix',
    steps: [
      { id: 'reproduce', name: 'Reproduce', prompt: 'Reproduce the bug with a failing test first.', advanceOn: 'stop' },
      { id: 'fix', name: 'Fix', prompt: 'Fix the bug so the test passes.', advanceOn: 'manual' },
      { id: 'pr', name: 'Open PR', prompt: 'Commit, push and open a PR.', advanceOn: { github: 'prOpen' } },
      { id: 'done', name: 'Done' }
    ]
  }
]

export interface LoadedConfig {
  settings: Settings
  tags: Tag[]
  rules: Rule[]
  jobTypes: JobType[]
  errors: ConfigError[]
}

export const CONFIG_FILES = ['settings.json', 'tags.json', 'rules.json', 'jobTypes.json']

/** Loads every config file, writing defaults for missing ones. Invalid files keep the defaults and report an error. */
export function loadConfig(store: JsonStore): LoadedConfig {
  const errors: ConfigError[] = []

  function load<T>(file: string, fallback: T, validate: (value: unknown) => string[]): T {
    if (!store.exists(file)) {
      store.write(file, fallback)
      return fallback
    }
    try {
      const value = store.read<unknown>(file, fallback)
      const problems = validate(value)
      if (problems.length) {
        for (const message of problems) errors.push({ file, message })
        return fallback
      }
      return value as T
    } catch (err) {
      errors.push({ file, message: (err as Error).message })
      return fallback
    }
  }

  const rawSettings = load<Partial<Settings>>('settings.json', DEFAULT_SETTINGS, (v) =>
    isObject(v) ? [] : ['must be a JSON object']
  )
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...rawSettings,
    keybindings: { ...DEFAULT_SETTINGS.keybindings, ...(rawSettings.keybindings ?? {}) }
  }
  const tags = load('tags.json', DEFAULT_TAGS, validateTags)
  const rules = load('rules.json', DEFAULT_RULES, validateRules)
  const jobTypes = load('jobTypes.json', DEFAULT_JOB_TYPES, validateJobTypes)
  return { settings, tags, rules, jobTypes, errors }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function validateTags(value: unknown): string[] {
  if (!Array.isArray(value)) return ['must be a list of tags']
  const problems: string[] = []
  const ids = new Set<string>()
  value.forEach((tag, i) => {
    const where = `tag ${i + 1}`
    if (!isObject(tag)) return problems.push(`${where}: must be an object`)
    if (!isNonEmptyString(tag.id)) problems.push(`${where}: "id" is required`)
    else if (ids.has(tag.id)) problems.push(`${where}: duplicate id "${tag.id}"`)
    else ids.add(tag.id)
    if (!isNonEmptyString(tag.name)) problems.push(`${where}: "name" is required`)
    if (!isNonEmptyString(tag.color)) problems.push(`${where}: "color" is required`)
    return undefined
  })
  return problems
}

export function validateRules(value: unknown): string[] {
  if (!Array.isArray(value)) return ['must be a list of rules']
  const problems: string[] = []
  value.forEach((rule, i) => {
    const where = `rule ${i + 1}`
    if (!isObject(rule)) return problems.push(`${where}: must be an object`)
    if (!isNonEmptyString(rule.id)) problems.push(`${where}: "id" is required`)
    if (!PR_CONDITIONS.includes(rule.when as PrCondition))
      problems.push(`${where}: "when" must be one of ${PR_CONDITIONS.join(', ')}`)
    if (!isNonEmptyString(rule.setTag)) problems.push(`${where}: "setTag" is required`)
    return undefined
  })
  return problems
}

export function validateJobTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return ['must be a list of job types']
  const problems: string[] = []
  const ids = new Set<string>()
  value.forEach((job, i) => {
    const where = isObject(job) && isNonEmptyString(job.id) ? `job type "${job.id}"` : `job type ${i + 1}`
    if (!isObject(job)) return problems.push(`${where}: must be an object`)
    if (!isNonEmptyString(job.id)) problems.push(`${where}: "id" is required`)
    else if (ids.has(job.id)) problems.push(`${where}: duplicate id`)
    else ids.add(job.id)
    if (!isNonEmptyString(job.name)) problems.push(`${where}: "name" is required`)
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      problems.push(`${where}: "steps" must be a non-empty list`)
      return undefined
    }
    const stepIds = new Set<string>()
    job.steps.forEach((step: unknown, j: number) => {
      const at = `${where}, step ${j + 1}`
      if (!isObject(step)) return problems.push(`${at}: must be an object`)
      if (!isNonEmptyString(step.id)) problems.push(`${at}: "id" is required`)
      else if (stepIds.has(step.id)) problems.push(`${at}: duplicate step id "${step.id}"`)
      else stepIds.add(step.id)
      if (!isNonEmptyString(step.name)) problems.push(`${at}: "name" is required`)
      if (step.prompt !== undefined && typeof step.prompt !== 'string') problems.push(`${at}: "prompt" must be text`)
      if (step.autoSend !== undefined && typeof step.autoSend !== 'boolean')
        problems.push(`${at}: "autoSend" must be true or false`)
      if (step.tag !== undefined && !isNonEmptyString(step.tag)) problems.push(`${at}: "tag" must be a tag id or name`)
      const advance = step.advanceOn
      const validAdvance =
        advance === undefined ||
        advance === 'manual' ||
        advance === 'stop' ||
        (isObject(advance) && PR_CONDITIONS.includes(advance.github as PrCondition))
      if (!validAdvance)
        problems.push(`${at}: "advanceOn" must be "manual", "stop" or { "github": one of ${PR_CONDITIONS.join(', ')} }`)
      return undefined
    })
    return undefined
  })
  return problems
}
