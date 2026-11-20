import { cleanSteps, clampStep, MAX_STEPS, stepName } from '../shared/steps.ts'
import type { Session, Tag } from '../shared/types'

/**
 * The tools that let Claude read and update its session's steps and tags, served to each session the
 * app started as a small MCP server (see HookServer). Kept free of Electron so it can be
 * tested on its own.
 */

export const MCP_SERVER_NAME = 'claude-hub'
const PROTOCOL_VERSION = '2025-06-18'
const MAX_NOTE = 500

const noteSchema = { type: 'string', description: 'One short sentence on what was done, shown to the user' }

export const TOOLS = [
  {
    name: 'get_steps',
    description: "Shows this Claude Hub session's steps and which one is current.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_steps',
    description:
      "Sets this session's step list, shown to the user as progress (for example: Plan, Implement, Test, Open PR). " +
      'Use it once the task is understood, and again if the plan changes. Keeps the current step unless you pass one.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' }, maxItems: MAX_STEPS, description: 'Short step names, in order' },
        current: { type: 'integer', minimum: 1, description: 'The step being worked on now, counting from 1' }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'complete_step',
    description:
      'Marks the current step done and moves to the next one. Call it when the step is actually finished and verified, ' +
      'not before. Completing the last step marks the whole list done.',
    inputSchema: { type: 'object', properties: { note: noteSchema }, additionalProperties: false }
  },
  {
    name: 'set_step',
    description: 'Moves to a given step (counting from 1), for example to go back to an earlier step. Prefer complete_step to move forward.',
    inputSchema: {
      type: 'object',
      properties: { step: { type: 'integer', minimum: 1 }, note: noteSchema },
      required: ['step'],
      additionalProperties: false
    }
  },
  {
    name: 'get_tags',
    description: "Lists the tags the user has set up in Claude Hub and which ones are on this session.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_tags',
    description:
      "Marks this session with the user's tags, or clears them (for example Blocked while you wait on the user, " +
      'Needs tests, Ready to merge). Only existing tags can be used; call get_tags to see them.',
    inputSchema: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' }, description: 'Tag names (or ids) to put on the session' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tag names (or ids) to take off' }
      },
      additionalProperties: false
    }
  }
]

/** The steps as a numbered list with the current one marked. */
export function describeSteps(s: Pick<Session, 'steps' | 'currentStep'>): string {
  const steps = s.steps ?? []
  if (!steps.length) return 'This session has no steps yet. Call set_steps once the task is clear.'
  const cur = clampStep(steps, s.currentStep)
  const lines = steps.map((_, i) => `${i < cur ? '✓' : i === cur ? '→' : ' '} ${i + 1}. ${stepName(steps, i)}`)
  if (cur >= steps.length) lines.push('All steps are done.')
  return lines.join('\n')
}

/** Added to each prompt (UserPromptSubmit hook) while the session has unfinished steps. */
export function stepContext(s: Pick<Session, 'steps' | 'currentStep'>): string | undefined {
  const steps = s.steps ?? []
  const cur = clampStep(steps, s.currentStep)
  if (!steps.length || cur >= steps.length) return undefined
  return (
    `[Claude Hub] This session is on step ${cur + 1} of ${steps.length}: ${stepName(steps, cur)}. ` +
    `When that step is finished and verified, call the ${MCP_SERVER_NAME} complete_step tool; if the plan changes, call set_steps.`
  )
}

export interface StepChange {
  steps: string[]
  currentStep: number
  note?: string
  /** What the tool tells Claude. */
  text: string
}

const noteOf = (args: Record<string, unknown>) =>
  typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, MAX_NOTE) : undefined

/** Works out what a tool call changes; a string is an error to return to Claude. */
export function applyStepTool(s: Pick<Session, 'steps' | 'currentStep'>, name: string, args: Record<string, unknown>): StepChange | string {
  const steps = s.steps ?? []
  const cur = clampStep(steps, s.currentStep)
  if (name === 'set_steps') {
    if (!Array.isArray(args.steps) || !args.steps.every((x) => typeof x === 'string')) return '"steps" must be a list of step names.'
    const next = cleanSteps(args.steps as string[])
    if (!next.length) return 'Give at least one step name.'
    const wanted = args.current === undefined ? cur : Number(args.current) - 1
    if (!Number.isInteger(wanted) || wanted < 0) return '"current" must be a step number from 1.'
    const change = { steps: next, currentStep: Math.min(wanted, next.length - 1) }
    return { ...change, text: `Steps set.\n${describeSteps(change)}` }
  }
  if (!steps.length) return 'This session has no steps yet. Call set_steps first.'
  if (name === 'complete_step') {
    if (cur >= steps.length) return 'All steps are already done.'
    const currentStep = cur + 1
    const text =
      currentStep >= steps.length
        ? `Step ${cur + 1} done. That was the last step; all steps are done. If one of the user's tags now applies ` +
          '(for example Ready to merge), or one no longer does (Blocked), update them with set_tags; get_tags lists them.'
        : `Step ${cur + 1} done. Now on step ${currentStep + 1} of ${steps.length}: ${stepName(steps, currentStep)}.`
    return { steps, currentStep, note: noteOf(args), text }
  }
  if (name === 'set_step') {
    const n = Number(args.step)
    if (!Number.isInteger(n) || n < 1 || n > steps.length) return `"step" must be between 1 and ${steps.length}.`
    return { steps, currentStep: n - 1, note: noteOf(args), text: `Now on step ${n} of ${steps.length}: ${stepName(steps, n - 1)}.` }
  }
  return `Unknown tool: ${name}`
}

// ---- tags ------------------------------------------------------------

/** The user's tags, with the ones on this session marked. */
export function describeTags(all: Tag[], on: string[], auto: string[] = []): string {
  if (!all.length) return 'The user has no tags set up.'
  const lines = all.map((t) => {
    const mark = on.includes(t.id) ? '[x]' : auto.includes(t.id) ? '[auto]' : '[ ]'
    const group = t.group ? ` (group ${t.group}${t.exclusive ? ', one at a time' : ''})` : ''
    return `${mark} ${t.name}${group}`
  })
  if (auto.length) lines.push('[auto] tags are set by the app\'s rules (e.g. from the PR) and can\'t be changed here.')
  return lines.join('\n')
}

const findTagByName = (all: Tag[], name: string) => {
  const key = name.trim().toLowerCase()
  return all.find((t) => t.id.toLowerCase() === key || t.name.toLowerCase() === key)
}

/** Works out a set_tags call; a string is an error to return to Claude. */
export function applyTagTool(all: Tag[], tagIds: string[], args: Record<string, unknown>): { tagIds: string[]; text: string } | string {
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)
  const add = list(args.add)
  const remove = list(args.remove)
  if (!add || !remove) return '"add" and "remove" must be lists of tag names.'
  if (!add.length && !remove.length) return 'Pass tags to "add" or "remove".'
  const unknown = [...add, ...remove].filter((n) => !findTagByName(all, n))
  if (unknown.length)
    return `Unknown tag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Existing tags: ${all.map((t) => t.name).join(', ') || 'none'}.`
  let next = [...tagIds]
  for (const n of remove) {
    const tag = findTagByName(all, n)!
    next = next.filter((id) => id !== tag.id)
  }
  for (const n of add) {
    const tag = findTagByName(all, n)!
    if (next.includes(tag.id)) continue
    if (tag.exclusive && tag.group) {
      const sameGroup = new Set(all.filter((t) => t.group === tag.group && t.exclusive).map((t) => t.id))
      next = next.filter((id) => !sameGroup.has(id))
    }
    next.push(tag.id)
  }
  const names = next.map((id) => all.find((t) => t.id === id)?.name ?? id)
  return { tagIds: next, text: names.length ? `Tags on this session: ${names.join(', ')}.` : 'This session has no tags now.' }
}

// ---- skills ----------------------------------------------------------

// Commands the CLI handles itself; typing them isn't starting a task.
const BUILTIN_COMMANDS = new Set(
  'add-dir agents bug clear compact config context cost doctor exit export help hooks ide init install-github-app login logout mcp memory model permissions plugin pr-comments release-notes resume review rename status statusline terminal-setup todos usage vim'.split(' ')
)

/** The skill or command a prompt starts, e.g. "/fix-issue 123" -> "fix-issue"; undefined for anything else. */
export function invokedSkill(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string') return undefined
  const m = prompt.trimStart().match(/^\/([A-Za-z0-9][\w.:-]{0,80})(?=\s|$)/)
  if (!m) return undefined
  const name = m[1]
  if (BUILTIN_COMMANDS.has(name.toLowerCase()) || name.toLowerCase().startsWith('hub:')) return undefined
  return name
}

/** Added to the prompt when the user starts a skill: plan steps from it and keep them (and tags) current. */
export function skillContext(skill: string, s: Pick<Session, 'steps' | 'currentStep'>): string {
  const existing = s.steps?.length
    ? ` The session already has steps:\n${describeSteps(s)}\nReplace them if they belong to an earlier task; keep them if they already fit this one.`
    : ''
  return (
    `[Claude Hub] The user started /${skill}. Track it in Claude Hub (follow the hub:steps skill): once you have read ` +
    `/${skill}'s instructions, turn its workflow (its phases or numbered steps, adapted to this request) into 3-8 short ` +
    `step names and call the ${MCP_SERVER_NAME} set_steps tool before doing the work. Call complete_step with a one-line ` +
    `note as each step is finished, and use set_tags to mark the session when something applies (for example Blocked ` +
    `while you wait on the user).` +
    existing
  )
}

export interface ToolResult {
  text: string
  isError?: boolean
}

interface RpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

/**
 * Answers one MCP JSON-RPC message (Streamable HTTP, JSON responses only, no streaming).
 * Returns undefined for notifications, which get no reply.
 */
export function handleRpc(
  message: RpcRequest,
  callTool: (name: string, args: Record<string, unknown>) => ToolResult
): object | undefined {
  const id = message.id
  if (id === undefined || id === null) return undefined
  const reply = (result: object) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, msg: string) => ({ jsonrpc: '2.0', id, error: { code, message: msg } })
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' }
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`)
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
      const result = callTool(name, args)
      return reply({ content: [{ type: 'text', text: result.text }], isError: !!result.isError })
    }
    default:
      return fail(-32601, `Method not found: ${String(message.method)}`)
  }
}
