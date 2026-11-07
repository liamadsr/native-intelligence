/**
 * The reviewer's mode (src/lib/safety/action-review.ts; L5,
 * docs/plans/teammate-agent.md). Only a type import, so any module can read
 * the mode without loading the reviewer (and through it the tool registry).
 *
 * ACTION_REVIEW_MODE, read per call:
 *   unset, empty or 'default'
 *                   'default': BLOCKING for the Dial8 agent on the person's
 *                   Mac only: every call it makes (`mustEnforce`, or an
 *                   approval context naming its job), a job a loop started
 *                   included. Everything that runs today (the person's own
 *                   turns, relays, server turns, loops and skill runs that
 *                   don't use the Mac) stays log-only, as on PROD. Why: the
 *                   reviewer's first live eval
 *                   (docs/evaluations/jev/2026-10-21/action-review-v1.json)
 *                   let no bad call through, but held 8 to 9 of 14 calls the
 *                   person plainly asked for, and scored a loop that keeps to
 *                   its saved instructions at 0.22: blocking those would card
 *                   nearly every risky loop call and fill people's card caps.
 *   'blocking'      blocking for every caller.
 *   'shadow'        log only for every caller (the kill switch). Loops can't
 *                   start Mac jobs, and a running loop job is stopped at its
 *                   next tool call (src/lib/local-agent/unattended.ts).
 *   anything else   'blocking', with a warning: a typo never opens the gate.
 * Setting it on Vercel is the founder's call.
 */
import type { CallerClass } from './caller'

/** The env var. */
export const ACTION_REVIEW_MODE_ENV = 'ACTION_REVIEW_MODE'

export type ActionReviewMode = 'default' | 'blocking' | 'shadow'

/** The last ACTION_REVIEW_MODE value logged, so each process says its mode once. */
let loggedModeValue: string | null = null

/** The mode from ACTION_REVIEW_MODE. Logs one `[action-review] mode` line per process and value, never more. */
export function actionReviewMode(env: Record<string, string | undefined> = process.env): ActionReviewMode {
  const raw = (env[ACTION_REVIEW_MODE_ENV] ?? '').trim().toLowerCase()
  const mode: ActionReviewMode = !raw || raw === 'default' ? 'default' : raw === 'shadow' ? 'shadow' : 'blocking'
  if (loggedModeValue !== raw) {
    loggedModeValue = raw
    const source = !raw ? 'default' : raw === 'default' || raw === 'shadow' || raw === 'blocking' ? 'env' : 'env_unknown_value'
    const line = JSON.stringify({ mode, source, ...(source === 'env_unknown_value' ? { value: raw.slice(0, 40) } : {}) })
    if (source === 'env_unknown_value') console.warn('[action-review] mode', line)
    else console.info('[action-review] mode', line)
  }
  return mode
}

/** Who a call comes from, as the reviewer's mode reads it (the door's verified facts). */
export interface ReviewedCaller {
  /** caller.ts's class (read by 'blocking' and 'shadow' alike; the default looks only at the Mac). */
  caller?: CallerClass
  /** A call from the Dial8 agent on the Mac (the door's flag, or its approval context's job). */
  mustEnforce?: boolean
}

/** Whether the reviewer blocks this call under `mode` (see the header): the default blocks the Mac body alone. */
export function reviewerBlocks(mode: ActionReviewMode, who: ReviewedCaller): boolean {
  if (mode === 'shadow') return false
  if (mode === 'blocking') return true
  return who.mustEnforce === true
}
