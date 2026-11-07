/// <reference types="eve/workflow-modules" />
/**
 * helpers — the main chat's quick in-turn helpers (A4 slice 3,
 * docs/plans/always-on-agent.md §4, docs/plans/helpers-spike.md "Fallback").
 *
 * A BLOCKING (`execute`) workflow tool: the parent turn parks on this call,
 * 1–4 declared `helper` children run in parallel (subagents/helper/, read
 * plus drafts only, each on the model the main agent chose for its task), and
 * their results come back as this one tool result in the same turn. No later
 * turns, no server writer: saving, billing and Stop work as for any long
 * tool call.
 *
 *   1. `prepareHelpers` (a step, lib/helpers-prepare.ts) reads the spec with
 *      the session's verified run token and refuses, with the spec route's
 *      exact reason, unless `helpersAllowed` (no device ask, bot conversation,
 *      relayed turn or server-minted token; the kill switch). It writes each
 *      task's message, the asked-for playbooks inlined.
 *   2. One `ctx.agent('helper')` session per task, sent its message; the
 *      turn's `response.result()` settles it (lib/helpers.ts
 *      helperTurnSettlement). ctx.agent is built on durable hooks, so racing
 *      it against `sleep` survives replay.
 *   3. One deadline, raced in a loop: after each child settles the body yields
 *      a progress snapshot (eve `action.partial`, drawn as the "N helpers
 *      working" row). When the deadline wins it returns what finished, the
 *      rest `timed_out`; eve ends the sessions the run opened when the run
 *      finishes, which cancels any helper turn still running.
 *
 * Steering: a message sent while this runs waits for it. eve (0.69+) aborts
 * `ctx.abortSignal` for a steering message too; the body ignores that
 * interrupt (lib/helpers.ts isSteerInterrupt), so the deadline bounds the
 * wait as before. Send now is Stop: it cancels the turn, which aborts the
 * signal as a cancel, and the body returns at once so the run and its
 * helpers end without eve's 30 s unwind grace. One gap: after a steer has
 * aborted the signal, a later Stop can't abort it again, so that Stop waits
 * out the grace (lib/__tests__/helpers-spike.test.ts pins the mechanics).
 *
 * The body stays thin and deterministic; everything it computes is plain data
 * from lib/helpers.ts, unit-tested there (vitest can't resolve `workflow`).
 * Static, as workflow tools must be: hidden per conversation by the gate, not
 * by the resolver. Not a registry tool, so it never reaches MCP or a skill run.
 */
import { defineWorkflowTool, type AgentMessageResult, type WorkflowToolContext } from 'eve/tools'
import { sleep } from 'workflow'
import {
  HELPER_AGENT_NAME,
  HELPERS_TOOL_DESCRIPTION,
  assembleHelperResults,
  deadlineDuration,
  helperErrorText,
  helperTurnSettlement,
  helpersInputSchema,
  helpersProgress,
  isSteerInterrupt,
  refusedHelpers,
  unrecognisedAbortReason,
  type HelperSettlement,
  type HelpersInput,
  type HelpersOutput,
  type HelpersProgress,
} from '../lib/helpers.js'
import { prepareHelpers } from '../lib/helpers-prepare.js'

type RaceWinner = HelperSettlement | { index: -1; end: 'deadline' | 'cancelled' }

/**
 * One helper: a new session with the declared helper for its task's model
 * (`helper`, or another roster helper: lib/helpers.ts HELPER_AGENT_BY_MODEL),
 * its task, and how that turn ended.
 */
async function runHelper(ctx: WorkflowToolContext, agent: string, message: string): Promise<AgentMessageResult> {
  // No `signal`: a steer must not cancel a helper's turn. The run's end does.
  const response = await ctx.agent(agent).send(message)
  return response.result()
}

/** The workflow body (a top-level function; eve names it by its module path and `execute`). */
async function* execute(input: HelpersInput, ctx: WorkflowToolContext): AsyncGenerator<HelpersProgress, HelpersOutput> {
  'use workflow'
  const prepared = await prepareHelpers(ctx, input.tasks)
  if (!prepared.ok) return refusedHelpers(prepared.reason)

  const tasks = prepared.tasks
  const settled: Record<number, HelperSettlement> = {}
  yield helpersProgress(tasks, settled)

  const runs: Array<Promise<RaceWinner>> = tasks.map((task, index) =>
    runHelper(ctx, task.agent ?? HELPER_AGENT_NAME, task.message).then(
      (result): RaceWinner => helperTurnSettlement(index, result),
      (error: unknown): RaceWinner => ({ index, ok: false, error: helperErrorText(error) }),
    ),
  )
  const deadline: Promise<RaceWinner> = sleep(deadlineDuration(input.deadlineSeconds)).then(() => ({ index: -1, end: 'deadline' }))
  // Stop (or the session ending) wins the race; a steer's interrupt does not.
  const cancelled = new Promise<RaceWinner>((resolve) => {
    const onAbort = () => {
      const reason = ctx.abortSignal.reason
      const unknown = unrecognisedAbortReason(reason)
      // eve names its two abort reasons; anything else is drift (an eve bump):
      // log it, and treat it as a cancel.
      if (unknown) console.warn('[helpers] unrecognised abort reason; treating it as a cancel', { reason: unknown })
      if (!isSteerInterrupt(reason)) resolve({ index: -1, end: 'cancelled' })
    }
    if (ctx.abortSignal.aborted) onAbort()
    else ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
  })

  while (Object.keys(settled).length < tasks.length) {
    const next = await Promise.race([...runs.filter((_, i) => settled[i] === undefined), deadline, cancelled])
    if ('end' in next) break
    settled[next.index] = next
    yield helpersProgress(tasks, settled)
  }
  return assembleHelperResults(tasks, settled, prepared.unknownSkills)
}

export default defineWorkflowTool({
  description: HELPERS_TOOL_DESCRIPTION,
  inputSchema: helpersInputSchema,
  execute,
})
