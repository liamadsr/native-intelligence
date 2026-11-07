/**
 * update_plan — a skill run's checklist for its job (docs/plans/always-on-agent.md
 * §4b, A4 slice 2). Each call replaces the whole list; steps are pending,
 * in_progress, done or skipped, one in progress at a time.
 *
 * It posts `{ toolName: 'update_plan', input: { steps } }` to the skill-run tool
 * route with the run token read off the verified session principal, never from
 * model input. `update_plan` is not a workspace tool (not in createTools, so no
 * ceiling and no MCP): the route handles the name before its ceiling check, as
 * a special case, and stores the plan on the run's own job (the token's
 * `workItemId`) through the one validating writer (src/lib/work/plan.ts). A run
 * with no job gets a note to skip it.
 *
 * The schema mirrors src/lib/work/plan.ts (plan-drift.test.ts keeps the limits
 * equal); the server's validator is the authority. It returns the whole plan
 * every time, so each step update re-states it.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { dispatchWorkspaceTool, runTokenFromAuth } from '../lib/spec-client.js'

export const PLAN_MAX_STEPS = 12
export const PLAN_STEP_MAX_CHARS = 140
export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const

/** The tool's name on the skill-run tool route (the route's special case). */
export const UPDATE_PLAN_TOOL_NAME = 'update_plan'

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
    'Keep your plan for this job: a short checklist the person watches live. Use it only for a job of 3 or more ' +
    'steps: once you know the steps, then again when a step starts or finishes (not after every tool call). ' +
    'Send the WHOLE list each time; at most 12 steps of one short line, exactly one in_progress while you work. ' +
    'Mark a step skipped when it turns out not to be needed. The plan is not your output.',
  inputSchema: updatePlanInput,
  execute: (input, ctx) => dispatchWorkspaceTool(UPDATE_PLAN_TOOL_NAME, runTokenFromAuth(ctx.session.auth), input),
})
