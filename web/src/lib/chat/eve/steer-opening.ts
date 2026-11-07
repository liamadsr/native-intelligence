/**
 * When a held message may go to eve as a steer (docs/plans/always-on-agent.md
 * §2b, UI-2). Pure: the transport feeds it the running turn's facts after
 * every event it reads, and POSTs the steer the first time this says `post`.
 *
 * The rule: POST only when eve would act on the message next, so Edit stays
 * honest while it waits (eve has no way to take a delivery back).
 *
 * What eve 0.66.3 does with a steering delivery (harness/generation-steering.js,
 * execution/session/turn.js):
 *  - It aborts the model call in flight only while neither `outputStarted`
 *    (a non-empty answer delta, a non-empty message.completed, or a
 *    result.completed: turn-scoped, carried across steps) nor `effectsStarted`
 *    (a local tool executing, an input request, the turn completing) is set.
 *    Reasoning is not output. The turn then continues with the message.
 *  - Otherwise it waits for the step boundary and feeds the message into the
 *    next step; when that step was the final answer, the message stays queued
 *    and becomes the next turn.
 *
 * So:
 *  | Running turn                                   | Action                          |
 *  |------------------------------------------------|---------------------------------|
 *  | Parked on a question (ask_user)                | never (typed words answer it)   |
 *  | Not identified yet (no stamped event)          | hold (no fold into its start)   |
 *  | No answer text yet, no tool executing          | post: eve interrupts the call   |
 *  | No answer text yet, a tool executing           | hold: post at the tool's result |
 *  | Answer text started, a tool executing/starting | post: the boundary eve would use|
 *  | Answer text streaming, no tool                 | hold: if the turn ends, it goes |
 *  |                                                | as the next turn (today's path) |
 */

export interface SteerOpeningFacts {
  /** The turn knows its own delivery ids (its first stamped event arrived). */
  identified: boolean
  /** The turn is parked on an open input request (an ask_user picker). */
  parked: boolean
  /** Non-empty answer text has streamed in this eve turn. */
  answerStarted: boolean
  /** A requested tool has not returned its result yet. */
  toolExecuting: boolean
  /** A tool call's input is streaming (the call is about to be requested). */
  toolCallStarting: boolean
}

/** Which rule opened the POST (telemetry: `steer_opening`). */
export type SteerOpeningReason = 'before_output' | 'tool_boundary'

export type SteerOpening =
  | { action: 'post'; reason: SteerOpeningReason }
  | { action: 'hold' }
  | { action: 'never' }

export function steerOpening(facts: SteerOpeningFacts): SteerOpening {
  if (facts.parked) return { action: 'never' }
  if (!facts.identified) return { action: 'hold' }
  if (!facts.answerStarted) {
    return facts.toolExecuting ? { action: 'hold' } : { action: 'post', reason: 'before_output' }
  }
  return facts.toolExecuting || facts.toolCallStarting
    ? { action: 'post', reason: 'tool_boundary' }
    : { action: 'hold' }
}
