/**
 * The earned-autonomy switch (docs/plans/earned-autonomy.md §8):
 * `EARNED_AUTONOMY`, empty is off.
 *
 *   empty (or anything unknown)  off: nothing is recorded or shown, as before.
 *   'record'                     each settled card is recorded per person and
 *                                kind, and Settings › Autonomy shows the
 *                                record, read-only. Nothing runs without a card.
 *   'graduate'                   later phases: offers, and graduated kinds
 *                                running with an undo. Until those ship (and
 *                                the owner has decided, plan "Decisions"), it
 *                                behaves exactly as 'record'.
 *
 * The workspace kill switch (agent_autonomy.mode 'off') outranks it.
 */
export const EARNED_AUTONOMY_ENV = 'EARNED_AUTONOMY'

export type EarnedAutonomyMode = 'off' | 'record' | 'graduate'

export function earnedAutonomyMode(env: Record<string, string | undefined> = process.env): EarnedAutonomyMode {
  const v = (env[EARNED_AUTONOMY_ENV] ?? '').trim().toLowerCase()
  return v === 'record' || v === 'graduate' ? v : 'off'
}

/** Is the track record kept (and shown)? */
export function earnedAutonomyRecording(env: Record<string, string | undefined> = process.env): boolean {
  return earnedAutonomyMode(env) !== 'off'
}
