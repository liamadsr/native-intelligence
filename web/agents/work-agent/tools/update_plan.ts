/**
 * update_plan — the work run's checklist for its job (docs/plans/always-on-agent.md
 * §4b, A4 slice 2). Each call replaces the whole list; steps are pending,
 * in_progress, done or skipped, one in progress at a time.
 *
 * It POSTs `{ kind: 'plan', steps }` to the shared agent-run event route with
 * the run token read off the verified session principal (runTokenFromAuth),
 * never from model input. The route resolves the run's job and stores the plan
 * in `tracked_job.plan` through its one validating writer (src/lib/work/plan.ts),
 * where the person sees it live: the job's detail panel, a "3/5" badge on its
 * row, and the main agent's list_bot_work / get_bot_item.
 *
 * A native tool, not a workspace proxy (createTools): its `update_` name never
 * meets the write-verb rule, it never reaches MCP, and it needs no ceiling or
 * persona grant. It returns the whole plan every time, so each step update
 * re-states it (recitation across a long run's compaction).
 *
 * The schema mirrors src/lib/work/plan.ts (plan-drift.test.ts keeps the limits
 * equal); the server's validator is the authority, and its error words come
 * back to the model as they are.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { postWorkPlan, runTokenFromAuth } from '../lib/spec-client.js'

export const PLAN_MAX_STEPS = 12
export const PLAN_STEP_MAX_CHARS = 140
export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const

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
    'Mark a step skipped when it turns out not to be needed. The plan is not a deliverable and never replaces finish_work.',
  inputSchema: updatePlanInput,
  async execute(input, ctx) {
    const result = await postWorkPlan(runTokenFromAuth(ctx.session.auth), input.steps)
    const stop = result.canceling ? { stop: true, message: 'This run is being stopped. Stop now; do not call more tools.' } : {}
    if (!result.ok) return { ok: false, error: result.error, ...stop }
    return { ok: true, plan: result.steps, ...stop }
  },
})
