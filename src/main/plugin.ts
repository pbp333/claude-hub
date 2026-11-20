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
description: Plan the current task as steps and keep its progress and tags up to date in Claude Hub. Use when the user starts a skill or slash command in a Claude Hub session, when starting any multi-step task there, or when the user asks to plan, set or update steps.
---

This session runs in Claude Hub. The app shows the session's steps as a progress bar and its tags
as coloured labels, next to the terminal and in the session list, so the user can see at a glance
where every session is. Keep both accurate with the ${MCP_SERVER_NAME} tools.

## 1. Decide the steps

- If arguments were given ("$ARGUMENTS"), use them: step names, or a number of steps to name yourself.
- If the user started a skill or slash command (for example \`/fix-issue 123\`), base the steps on that
  skill. Read its instructions (its SKILL.md or command file) and look for its workflow: numbered
  steps, phases, headings such as "Investigate / Implement / Verify", or a checklist. Turn that into
  3 to 8 short step names, a few words each, in the order you will do them. Adapt it to this request:
  leave out phases that clearly won't happen and split a big phase if it will take a while.
- Otherwise look at the task and pick 3 to 7 steps (for example: Reproduce, Fix, Test, Open PR).

Call \`get_steps\` first. If the session already has steps for an earlier, finished or unrelated task,
replace them; if they already fit this task, keep them.

## 2. Set them before doing the work

Call \`set_steps\` with the names. If work is already underway, pass \`current\` (counting from 1).

## 3. Keep them current

- When a step is finished and verified, call \`complete_step\` with a one-line note on what was done.
  Do this as you go, not in a batch at the end.
- If the plan changes (a step turns out unnecessary, or new work appears), call \`set_steps\` again.
- To go back to an earlier step (for example tests failed after a fix), use \`set_step\`.

## 4. Mark the session with tags

Call \`get_tags\` to see the user's tags, then \`set_tags\` with \`add\` / \`remove\` when one clearly applies:

- **Blocked** while you are waiting on the user or on something outside your control; remove it when unblocked.
- Workflow-style tags (for example Draft, In review) to match where the work is.
- **Needs tests** / **Ready to merge** style tags when they become true, and remove them when they stop being true.

Only use tags that exist, don't invent meanings for them, and leave tags marked [auto] alone (the app's
rules set those).

Don't set steps or tags for a quick one-shot question.
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
