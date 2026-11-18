import type { Session } from './types'

/** A session's step list: set by the user or by Claude, names optional. */

export const MAX_STEPS = 30
export const MAX_STEP_NAME = 120

/**
 * Steps from what the user typed: one name per line, or just a number for that many
 * unnamed steps ("5"). Empty input means no steps.
 */
export function parseStepsInput(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (/^\d+$/.test(trimmed)) return Array(Math.min(Number(trimmed), MAX_STEPS)).fill('')
  return cleanSteps(trimmed.split('\n'))
}

/** Text for the steps editor: the names one per line, or the count when none are named. */
export function stepsInputText(steps: string[] | undefined): string {
  if (!steps?.length) return ''
  return steps.every((s) => !s) ? String(steps.length) : steps.join('\n')
}

/** Trims names, drops blank lines and caps size; anything not a string is rejected by the caller. */
export function cleanSteps(names: string[]): string[] {
  return names
    .map((n) => n.replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_NAME))
    .filter(Boolean)
    .slice(0, MAX_STEPS)
}

export function stepName(steps: string[], index: number): string {
  return steps[index] || `Step ${index + 1}`
}

/** "2/5 Implement", "2/5", or "Done 5/5". */
export function progressLabel(session: Pick<Session, 'steps' | 'currentStep'>): string | undefined {
  const steps = session.steps
  if (!steps?.length) return undefined
  const i = clampStep(steps, session.currentStep)
  if (i >= steps.length) return `Done ${steps.length}/${steps.length}`
  return `${i + 1}/${steps.length}${steps[i] ? ' ' + steps[i] : ''}`
}

/** A valid current-step index: 0..steps.length (the last meaning all done). */
export function clampStep(steps: string[], index: number | undefined): number {
  const i = Number.isInteger(index) ? (index as number) : 0
  return Math.max(0, Math.min(steps.length, i))
}
