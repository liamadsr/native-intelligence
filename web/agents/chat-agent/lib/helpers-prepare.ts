/**
 * The `helpers` tool's first step (A4 slice 3), alone in its module ON
 * PURPOSE. The workflow body (../tools/helpers.ts) imports this module, and in
 * the workflow bundle eve swaps the step for a proxy and strips the imports
 * nothing else uses. Anything else exported here would keep its imports (the
 * spec client, eve/context through ./helpers-tasks.ts) in the Workflow VM,
 * which refuses Node builtins and fails `eve build`. Keep this file to the one
 * step.
 */
import type { WorkflowStepToolContext } from 'eve/tools'
import { fetchChatSpec, fetchHelperTiers, runTokenFromAuth, turnCtxFromAuth } from './spec-client.js'
import { helperTierText, prepareHelperTasks } from './helpers-tasks.js'
import type { HelperTaskInput, PreparedHelpers } from './helpers.js'

/**
 * The tool's first step: read the conversation's spec with the session's
 * verified run token, refuse unless the spec route allowed helpers
 * (`helpersAllowed`, from the token's claims: src/lib/chat/helpers-gate.ts),
 * and build each helper's message. Beside the spec read, the same round trip
 * sends each task's chosen `model` and asks what it runs on (the plan and the
 * daily cap may refuse a premium one; with no choice, the rules pick), which
 * picks its declared helper; a failed answer starts plain helpers. A step,
 * so replay never re-reads the spec or re-decides a model, and the body
 * stays deterministic.
 */
export async function prepareHelpers(ctx: WorkflowStepToolContext, tasks: HelperTaskInput[]): Promise<PreparedHelpers> {
  'use step'
  const auth = ctx.session.auth
  const runToken = runTokenFromAuth(auth)
  const turnCtx = turnCtxFromAuth(auth)
  const [spec, tiers] = await Promise.all([
    fetchChatSpec(runToken, turnCtx, { skills: true }),
    fetchHelperTiers(runToken, turnCtx, tasks.map(helperTierText), tasks.map((t) => t.model ?? null)),
  ])
  return prepareHelperTasks(tasks, spec, tiers)
}

