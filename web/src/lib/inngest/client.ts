import { Inngest } from 'inngest'

/**
 * `INNGEST_CHECKPOINTING=0` turns the SDK's checkpointing off for every
 * function that does not set `checkpointing` itself, without a code change.
 *
 * Checkpointing is how SDK v4 runs a function unless told otherwise: the steps
 * run back to back inside one request, and each finished step is reported to
 * Inngest (`POST /v1/checkpoint/<run id>/async`) while that request is still
 * open. Off, Inngest makes one request per step, as v3 did. The switch exists
 * for the move to a self-hosted Inngest server, where the default path had
 * never carried this app's functions: if it misbehaves there, set this and
 * redeploy. The SDK reads a function's own setting first, then the client's.
 *
 * Unset, empty, `1`, `true` and `on` leave the SDK default: on. Every other
 * value turns it off, not only `0`, `false` and `off`: whoever sets this
 * wants it off, and a typo must not leave it on with nothing to show for it.
 *
 * The value is an argument, never read in here: a default parameter would
 * read the real environment whenever a caller passed `undefined`.
 */
export function checkpointingDisabled(value: string | undefined): boolean {
  const setting = (value ?? '').trim().toLowerCase()
  return setting !== '' && !['1', 'true', 'on'].includes(setting)
}

export const inngest = new Inngest({
  id: 'native-intelligence',
  ...(checkpointingDisabled(process.env.INNGEST_CHECKPOINTING) ? { checkpointing: false as const } : {}),
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
