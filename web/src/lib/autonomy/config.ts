/**
 * The earned-autonomy switch (docs/plans/earned-autonomy.md §8):
 * `EARNED_AUTONOMY`, empty is off.
 *
 *   empty (or anything unknown)  off: nothing is recorded or shown, as before.
 *   'record'                     each settled card is recorded per person and
 *                                kind, and Settings › Autonomy shows the
 *                                record, read-only. Nothing runs without a card.
 *   'graduate'                   also: the agent offers to take over a kind
 *                                that earned it, the person's yes is stored,
 *                                and a granted kind's held call runs on its
 *                                own after a 5-minute undo window (Liam,
 *                                11-27, decision 1: the person's yes to
 *                                "handle this kind yourself" is their final
 *                                yes, amending 10-26's "nothing reaches
 *                                another person without the person's final
 *                                yes"). Off by default; setting it on the
 *                                server is the owner's call.
 *
 * `EARNED_AUTONOMY_QUIET` ('1' or 'true', and only with 'graduate'): the
 * quiet level. Off at launch (Liam, 11-27, decision 2: "Ceiling at launch is
 * tell"); off, nothing is offered quiet and a stored quiet reads as tell.
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

export const EARNED_AUTONOMY_QUIET_ENV = 'EARNED_AUTONOMY_QUIET'

/** Is a granted kind's call allowed to run on its own (after its undo window)? */
export function earnedAutonomyGraduating(env: Record<string, string | undefined> = process.env): boolean {
  return earnedAutonomyMode(env) === 'graduate'
}

/** The quiet level: only with 'graduate', and only when its own switch is on (off at launch, decision 2). */
export function earnedAutonomyQuiet(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env[EARNED_AUTONOMY_QUIET_ENV] ?? '').trim().toLowerCase()
  return earnedAutonomyGraduating(env) && (v === '1' || v === 'true')
}
