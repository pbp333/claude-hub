import type { ConfigError, PrCondition, Rule, Settings, Tag } from '../shared/types'
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
  trackSkills: true,
  pollIntervalSec: 60,
  botLogins: [],
  notifications: true,
  restoreOnLaunch: true,
  terminalFont: process.platform === 'win32' ? 'Cascadia Mono, Consolas, monospace' : 'Menlo, monospace',
  terminalFontSize: 13,
  terminalWebgl: false,
  keybindings: {
    newWindow: 'CmdOrCtrl+Shift+N',
    openFolder: 'CmdOrCtrl+O',
    newSession: 'CmdOrCtrl+T',
    nextNeedsYou: 'CmdOrCtrl+J',
    nextStep: 'CmdOrCtrl+Alt+N',
    quickOpen: 'CmdOrCtrl+P',
    commandPalette: 'CmdOrCtrl+Shift+P',
    toggleFileTree: 'CmdOrCtrl+B',
    showHistory: 'CmdOrCtrl+Shift+H',
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

export interface LoadedConfig {
  settings: Settings
  tags: Tag[]
  rules: Rule[]
  errors: ConfigError[]
}

export const CONFIG_FILES = ['settings.json', 'tags.json', 'rules.json']

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
  const { settings, problems } = sanitizeSettings(rawSettings)
  for (const message of problems) errors.push({ file: 'settings.json', message })
  const tags = load('tags.json', DEFAULT_TAGS, validateTags)
  const rules = load('rules.json', DEFAULT_RULES, validateRules)
  return { settings, tags, rules, errors }
}

export const MIN_POLL_INTERVAL_SEC = 15

/**
 * Checks each setting's type and keeps the default for any that is wrong, so one typo
 * (say "claudeArgs": "--verbose") can't break spawning or GitHub polling.
 */
export function sanitizeSettings(raw: Partial<Settings>): { settings: Settings; problems: string[] } {
  const problems: string[] = []
  const settings: Settings = { ...DEFAULT_SETTINGS, keybindings: { ...DEFAULT_SETTINGS.keybindings } }
  const r = raw as Record<string, unknown>
  const take = <K extends keyof Settings>(key: K, ok: (v: unknown) => boolean, expected: string) => {
    if (r[key] === undefined) return
    if (ok(r[key])) settings[key] = r[key] as Settings[K]
    else problems.push(`"${key}" must be ${expected}; using the default`)
  }
  const isString = (v: unknown) => typeof v === 'string'
  const isStringList = (v: unknown) => Array.isArray(v) && v.every(isString)
  const isBool = (v: unknown) => typeof v === 'boolean'
  take('shell', isString, 'text')
  take('claudeCommand', isNonEmptyString, 'a command name or full path')
  take('claudeArgs', isStringList, 'a list of text arguments, e.g. ["--model", "opus"]')
  take('hooksEnabled', isBool, 'true or false')
  take('trackSkills', isBool, 'true or false')
  take('pollIntervalSec', (v) => typeof v === 'number' && Number.isFinite(v), 'a number of seconds')
  if (settings.pollIntervalSec < MIN_POLL_INTERVAL_SEC) {
    problems.push(`"pollIntervalSec" is at least ${MIN_POLL_INTERVAL_SEC}`)
    settings.pollIntervalSec = MIN_POLL_INTERVAL_SEC
  }
  take('botLogins', isStringList, 'a list of GitHub logins')
  take('notifications', isBool, 'true or false')
  take('restoreOnLaunch', isBool, 'true or false')
  take('terminalFont', isNonEmptyString, 'a font name')
  take('terminalFontSize', (v) => typeof v === 'number' && v >= 6 && v <= 72, 'a number from 6 to 72')
  take('terminalWebgl', isBool, 'true or false')
  if (r.keybindings !== undefined) {
    if (!isObject(r.keybindings)) problems.push('"keybindings" must be an object; using the defaults')
    else {
      const kb = { ...r.keybindings }
      // Next step used to default to ⌘⇧N, which is now New Window.
      if (kb.nextStep === 'CmdOrCtrl+Shift+N' && !kb.newWindow) delete kb.nextStep
      for (const [name, value] of Object.entries(kb)) {
        if (!(name in settings.keybindings)) problems.push(`unknown keybinding "${name}"`)
        else if (!isNonEmptyString(value)) problems.push(`keybinding "${name}" must be text like "CmdOrCtrl+T"`)
        else settings.keybindings[name as keyof Settings['keybindings']] = value
      }
    }
  }
  return { settings, problems }
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

