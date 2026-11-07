/**
 * update_plan — the main chat's checklist for a long job (docs/plans/always-on-agent.md
 * §4b, A4 slice 1). Each call replaces the whole list; steps are pending,
 * in_progress, done or skipped, one in progress at a time.
 *
 * Eve-native: it validates (../lib/plan.ts, the twin of src/lib/work/plan.ts)
 * and writes durable session state, with no app round trip. The browser draws
 * the plan from this tool's part (the chat's plan card under the reply), and
 * the plan instructions resolver (../instructions/plan.ts) re-shows it after a
 * checkpoint. It returns the whole plan every call, so each update re-states
 * it to the model.
 *
 * Deliberately NOT a createTools tool: tools/workspace_tools.ts proxies only
 * the registry's names, so this one never meets the write-verb rule (an
 * `update_` name counts as mutating there and would be barred from report
 * mode), never reaches MCP and needs no persona grant. It touches nothing but
 * this conversation's own state, so every surface may keep it.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { PLAN_MAX_STEPS, PLAN_STEP_MAX_CHARS, PLAN_STEP_STATUSES, planHasOpenSteps, savePlan, validatePlanSteps } from '../lib/plan.js'

export const updatePlanInput = z.object({
  steps: z
    .array(
      z.object({
        // No length bound here: the validator (it tidies whitespace first, then
        // counts) is the one judge, so a padded line isn't refused by the schema.
        text: z.string().describe(`One short line, at most ${PLAN_STEP_MAX_CHARS} characters: what this step does.`),
        status: z.enum(PLAN_STEP_STATUSES).describe('pending, in_progress (at most one), done or skipped.'),
      }),
    )
    .min(1)
    .max(PLAN_MAX_STEPS)
    .describe('The WHOLE plan, in order. Each call replaces the last one.'),
})

export default defineTool({
  description:
    'Keep a short checklist for a job of 3 or more steps; the person sees it under your reply. Call it once you ' +
    'know the steps, then again when a step starts or finishes (never after every tool call). Send the WHOLE list ' +
    'each time: at most 12 steps of one short line, exactly one in_progress while you work, skipped for a step ' +
    'that turned out not to be needed. Skip it for quick answers and small tasks.',
  inputSchema: updatePlanInput,
  execute: (input) => {
    const valid = validatePlanSteps(input.steps)
    if (!valid.ok) return { ok: false, error: valid.error }
    savePlan(valid.steps)
    return planHasOpenSteps(valid.steps)
      ? { ok: true, plan: valid.steps }
      : { ok: true, plan: valid.steps, note: 'Every step is finished. Give your answer; no need to update the plan again.' }
  },
})
