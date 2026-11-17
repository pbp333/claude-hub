import type { JobStep, Session } from '../shared/types'

/**
 * The tools that let Claude see its job's steps and close the current one, served to each
 * session the app started as a small MCP server (see HookServer). Kept free of Electron so
 * it can be tested on its own.
 */

// Same as shared/tags currentStep; repeated so tests can load this file without a bundler.
const currentStep = (s: Session) => s.steps?.find((st) => st.id === s.currentStepId)

export const MCP_SERVER_NAME = 'claude-hub'
const PROTOCOL_VERSION = '2025-06-18'
const MAX_NOTE = 500

export const TOOLS = [
  {
    name: 'job_status',
    description:
      "Shows the job this Claude Hub session is working through: its steps, the current step and that step's goal. " +
      'Use it when you are unsure what step you are on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'complete_step',
    description:
      "Marks the session's current job step as done once its goal is actually met (for example, the failing test exists, " +
      "or the tests pass). Pass the current step's id. Only works on steps the user lets you close; if a step needs the " +
      "user's approval, this asks them and you should wait.",
    inputSchema: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: 'The id of the current step' },
        note: { type: 'string', description: 'One sentence on what was done, shown to the user' }
      },
      required: ['step_id'],
      additionalProperties: false
    }
  }
]

function describeCloser(step: JobStep): string {
  const a = step.advanceOn
  if (a === 'claude') return step.confirm ? 'you, with the user accepting it' : 'you, with complete_step'
  if (a === 'stop') return 'the app, when your turn ends'
  if (typeof a === 'object') return `GitHub, when the PR condition "${a.github}" is met`
  return 'the user'
}

/** The text job_status returns. */
export function jobStatus(s: Session): string {
  const step = currentStep(s)
  if (!s.steps?.length || !step) return 'This session has no job assigned.'
  const lines = [`Job: ${s.jobTypeName ?? s.jobTypeId}`, 'Steps:']
  for (const st of s.steps) lines.push(`${st.id === step.id ? '→' : ' '} ${st.id}: ${st.name} (closed by ${describeCloser(st)})`)
  lines.push('', `Current step: ${step.name} (id "${step.id}")`)
  if (step.prompt) lines.push(`Goal: ${step.prompt}`)
  if (s.pendingStep?.stepId === step.id) lines.push('You already reported it done; the user has not accepted it yet.')
  return lines.join('\n')
}

/**
 * Added to each prompt (UserPromptSubmit hook) while the current step is one Claude closes,
 * so it knows to call complete_step without being told every time.
 */
export function stepContext(s: Session): string | undefined {
  const step = currentStep(s)
  if (!step || step.advanceOn !== 'claude' || s.pendingStep) return undefined
  return (
    `[Claude Hub] This session is on step "${step.name}" (id "${step.id}") of the "${s.jobTypeName ?? s.jobTypeId}" job.` +
    (step.prompt ? ` Step goal: ${step.prompt}` : '') +
    ` When the goal is met and verified, call the ${MCP_SERVER_NAME} complete_step tool with step_id "${step.id}". Don't call it before then.`
  )
}

export type Completion =
  | { ok: false; message: string }
  | { ok: true; step: JobStep; next?: JobStep; confirm: boolean; note?: string }

/** Whether Claude may close the step it named, and what follows. */
export function decideCompletion(s: Session, args: Record<string, unknown>): Completion {
  const step = currentStep(s)
  if (!s.steps?.length || !step) return { ok: false, message: 'This session has no job assigned, so there is no step to complete.' }
  const stepId = typeof args.step_id === 'string' ? args.step_id : ''
  if (stepId !== step.id)
    return { ok: false, message: `The current step is "${step.name}" (id "${step.id}"), not "${stepId}". Steps can't be skipped.` }
  if (step.advanceOn !== 'claude')
    return {
      ok: false,
      message: `Step "${step.name}" is closed by ${describeCloser(step)}, not by you. Tell the user it is ready instead.`
    }
  if (s.pendingStep?.stepId === step.id)
    return { ok: false, message: 'You already reported this step done; wait for the user to accept it.' }
  const i = s.steps.indexOf(step)
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, MAX_NOTE) : undefined
  return { ok: true, step, next: s.steps[i + 1], confirm: !!step.confirm, note }
}

/** What complete_step tells Claude after the step moved on. */
export function completedText(step: JobStep, next: JobStep | undefined, continueNow: boolean): string {
  if (!next) return `Step "${step.name}" is done. That was the last step of the job.`
  let text = `Step "${step.name}" is done. Now on step "${next.name}" (id "${next.id}").`
  if (next.prompt && continueNow) text += `\nIts goal: ${next.prompt}\nContinue with it now.`
  else text += ' Stop here; the user will start it.'
  return text
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
