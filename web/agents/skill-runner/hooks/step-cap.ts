/**
 * step-cap — the skill run's 12-model-step limit, enforced INSIDE the session.
 *
 * Main's run_skill ran generateText with `stopWhen: isStepCount(12)`. eve has no
 * step-count limit (its session limits are token/cost budgets). The server
 * (src/lib/flows/run-skill-eve.ts, SKILL_RUN_MAX_STEPS) stops reading at the
 * 13th `step.started` and cancels, but a cancel lands after that model call has
 * started. This hook stops the turn on `step.started` at stepIndex 12 (0-based
 * per turn, so the 13th call), BEFORE the call runs.
 *
 * eve 0.68+ logs and IGNORES a hook throw (docs/guides/hooks.md "What happens
 * when a hook throws"), so the stop is `ctx.cancel()`: eve cancels the turn
 * before that model call, and it ends with `turn.cancelled` then
 * `session.waiting`. (Up to eve 0.66 this threw a `fatal: true` error, and a
 * task session ended with session.failed.) The server reads the cap from the
 * 13th step.started it saw (run-skill-eve.ts).
 *
 * SKILL_RUN_MAX_STEPS must equal the server constant; the eve bundle cannot
 * import it, so agents/skill-runner/lib/__tests__/step-cap.test.ts pins them.
 */
import { defineHook } from 'eve/hooks'

export const SKILL_RUN_MAX_STEPS = 12

export const STEP_CAP_MESSAGE = `This skill run reached its ${SKILL_RUN_MAX_STEPS}-step limit.`

export default defineHook({
  events: {
    async 'step.started'(event, ctx) {
      const stepIndex = (event as { data?: { stepIndex?: unknown } } | undefined)?.data?.stepIndex
      if (typeof stepIndex === 'number' && stepIndex >= SKILL_RUN_MAX_STEPS) {
        console.warn('[skill-runner] step-cap: cancelling the turn', { sessionId: ctx.session.id, reason: STEP_CAP_MESSAGE })
        ctx.cancel()
      }
    },
  },
})
