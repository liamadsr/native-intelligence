import { Inngest } from 'inngest'

export const inngest = new Inngest({
  id: 'dial8',
})

/**
 * Prospecting's two events, named and typed HERE rather than only at the
 * `createFunction` trigger.
 *
 * The client is deliberately untyped — `new Inngest({ id })` with no schema —
 * so `inngest.send()` accepts any name and any payload, and a typo in a
 * sender is a run that never happens and never errors. Every other event
 * family in this repo lives with that. These two do not, because the sender
 * (the kickoff route) and the receiver (`prospecting-functions.ts`) are in
 * different packages written against a written contract, and the payload has
 * four required ids that a route could plausibly get wrong.
 *
 * This is a NAMING contract, not a runtime one: importing the constant is what
 * makes a rename break the build. Sender and receiver must both use them.
 */
export const PROSPECTING_RUN_REQUESTED = 'prospecting/run.requested' as const
export const PROSPECTING_RUN_CANCEL = 'prospecting/run.cancel' as const

/** Payload of {@link PROSPECTING_RUN_REQUESTED}. The route creates the
 *  `prospecting_run` row FIRST and sends its id; the engine never creates one,
 *  so the partial unique index is the only thing deciding whether a second
 *  Find is allowed. */
export interface ProspectingRunRequestedEvent {
  name: typeof PROSPECTING_RUN_REQUESTED
  data: {
    runId: string
    workspaceId: string
    listId: string
    /** Who started it. A profile run the engine chained carries the user of
     *  the run it chained from (`chainProfileRun` passes it through); NULL
     *  only when no starting user is on record. */
    userId: string | null
    /**
     * Present on a profile run the engine chained (discovery → profile, or a
     * profile pass → the next pass). `before` is the instant the hand-off
     * began: a company whose card was stamped AFTER it was scored by this
     * hand-off and is never picked again, which is what makes the passes
     * terminate — each one only ever targets companies the previous ones did
     * not card. Absent on a run a person started.
     */
    handoff?: { before: string }
  }
}

/** Payload of {@link PROSPECTING_RUN_CANCEL}. The cancel route writes
 *  `status='canceling'` BEFORE sending: the engine's own between-angle check
 *  reads that column, and it is what turns a cancel into `canceled` WITH the
 *  partial results rather than a run frozen mid-flight. */
export interface ProspectingRunCancelEvent {
  name: typeof PROSPECTING_RUN_CANCEL
  data: { runId: string }
}

export type ProspectingEvent = ProspectingRunRequestedEvent | ProspectingRunCancelEvent
