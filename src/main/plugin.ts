import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from './stepTools'

/**
 * A small Claude Code plugin the app loads into its sessions (`--plugin-dir`), so its skills
 * are available without touching the user's own ~/.claude or project folders.
 */

export const PLUGIN_NAME = 'hub'

const STEPS_SKILL = `---
name: steps
description: Break the current task into steps and keep its progress up to date in Claude Hub. Use when starting a multi-step task in a Claude Hub session, or when the user asks to plan, set or update steps.
---

This session runs in Claude Hub, which shows the session's steps as a progress bar next to it.
Keep them accurate with the ${MCP_SERVER_NAME} tools:

1. Decide the steps. If arguments were given ("$ARGUMENTS"), use them: step names, or a number
   of steps to name yourself. Otherwise look at the task and pick 3 to 7 short names, a few words
   each (for example: Reproduce, Fix, Test, Open PR).
2. Call \`set_steps\` with them. If work is already underway, pass \`current\` (counting from 1).
3. Work through them. When a step is finished and verified, call \`complete_step\` with a one-line
   note on what was done. If the plan changes, call \`set_steps\` again; to go back, use \`set_step\`.

Call \`get_steps\` if you are unsure where things stand. Don't set steps for a quick one-shot request.
`

/** Writes the plugin into `dir` (replacing an older copy) and returns that folder. */
export function writePlugin(dir: string): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'steps'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Claude Hub session tools' }, null, 2)
  )
  writeFileSync(join(dir, 'skills', 'steps', 'SKILL.md'), STEPS_SKILL)
  return dir
}
