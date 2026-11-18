import { cleanSteps, clampStep, MAX_STEPS, stepName } from '../shared/steps.ts'
import type { Session } from '../shared/types'

/**
 * The tools that let Claude read and update its session's steps, served to each session the
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
        ? `Step ${cur + 1} done. That was the last step; all steps are done.`
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
