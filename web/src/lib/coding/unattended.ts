/**
 * Who is behind a coding run, for the rules that depend on it (P10):
 *
 *   - the PR ceiling (eve-templates-lessons.md F4, Foreman's writePolicy: "a
 *     draft can't merge"): a run nobody started by hand opens its pull
 *     request as a DRAFT, always. A person marks it ready;
 *   - the reviewer: an unattended run never opens a PR whose diff was cut
 *     short, and opens nothing when its review can't run (review.ts);
 *   - what a stopped run tells: a person's run notifies them, an unattended
 *     one settles quietly.
 *
 * A run is the person's only when they started it themselves: origin 'user'
 * (Start on an action) AND nothing on the row says something else started
 * it. Fail closed: any other origin (a loop's run_agent, an attempt, a CI
 * fix, a delegation, a value this does not know), or a row carrying a flow,
 * a fire key or a parent run, is unattended, whatever its origin says.
 * Every coding run is agent_unattended to the trust layer
 * (src/lib/safety/caller.ts: nobody watches the sandbox); this is about who
 * asked for it.
 *
 * Pure.
 */

/** The agent_run columns that say who started a run. */
export interface CodingRunStarter {
  origin?: unknown
  flow_id?: unknown
  fire_key?: unknown
  parent_run_id?: unknown
}

const set = (v: unknown) => v !== null && v !== undefined && v !== ''

/** Whether a coding run was started by no person. */
export function isUnattendedCodingRun(run: CodingRunStarter | null | undefined): boolean {
  if (!run || typeof run !== 'object') return true
  if (run.origin !== 'user') return true
  return set(run.flow_id) || set(run.fire_key) || set(run.parent_run_id)
}

/** The PR a run may open: ready for review (a person's run) or a draft (every other). */
export type PrCeiling = 'ready' | 'draft'

export function prCeilingFor(run: CodingRunStarter | null | undefined): PrCeiling {
  return isUnattendedCodingRun(run) ? 'draft' : 'ready'
}
