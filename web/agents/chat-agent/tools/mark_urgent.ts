/**
 * mark_urgent — how a background update says its message can't wait for the
 * morning (docs/plans/reach-follows-you.md §4, part D).
 *
 * The system decides where a message goes (Liam, 2026-10-31): a banner when
 * the person is at an app, a text or Slack when they are away, and nothing
 * routine between 21:00 and 08:00 their time (src/lib/reach/route.ts). The
 * agent never picks a channel. The one thing it may say is how urgent a
 * message is: this call's `by`, the time the person must know or act by. The
 * router lets an urgent message through quiet hours only when `by` is ahead,
 * at most 18 hours away, and no later than 2 hours after quiet hours end:
 * Jess at 21:07 about a 09:00 call is texted at once, a lunch at noon waits
 * for the morning.
 *
 * ── STATIC, like no_reply ───────────────────────────────────────────────────
 * The home thread's person turns and server turns share one cached prompt
 * prefix, and the tool list is part of it, so the tool is always advertised
 * and gated in `execute` (the same gate as tools/no_reply.ts: the run token's
 * `server: 'home_turn'`). On a person's own turn, a text or a Slack turn it
 * answers `{ marked: false }` with a note: their answer reaches them where
 * they are anyway. `availableInSubagents: false` keeps it off delegated
 * copies; the declared helpers have their own tools/ and never get it.
 *
 * The app side: finishHomeTurn reads the last call that answered
 * `{ marked: true }` (src/lib/chat/home-turn.ts urgentByOfParts), writes its
 * `by` and `why` onto the message's metadata (urgent_by, urgent_why) and
 * leaves the call itself out of the stored message. Nothing else marks a
 * message urgent in v1 but a guest's message_owner `by`.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runTokenFromAuth, serverFromRunToken } from '../lib/spec-client.js'

/** The tool's name (the file slug). Mirrored by src/lib/chat/home-turn.ts URGENT_TOOL_NAME. */
export const MARK_URGENT_TOOL_NAME = 'mark_urgent'

/** A full ISO 8601 time with its UTC offset (`Z` or ±hh:mm), the shape the router reads. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

/** True when this turn's run token is a home turn's server token (a background update). Never throws. */
export function mayMarkUrgent(auth: unknown): boolean {
  try {
    return serverFromRunToken(runTokenFromAuth(auth as never)) === 'home_turn'
  } catch {
    return false
  }
}

/** What the call returns: `marked` says whether the message is now urgent. */
export type MarkUrgentOutput = { marked: true; by: string } | { marked: false; note: string }

/** On a turn a person started (or a text or Slack turn): not marked. */
export const MARK_URGENT_REFUSED: MarkUrgentOutput = {
  marked: false,
  note: 'Not available: a person wrote to you, and your answer reaches them where they are.',
}
/** A `by` without its offset, or not a time at all. */
export const MARK_URGENT_BAD_TIME: MarkUrgentOutput = {
  marked: false,
  note: 'Not marked: `by` needs a full ISO 8601 time with its UTC offset, like 2026-11-01T09:00:00-04:00.',
}
/** A `by` already past. */
export const MARK_URGENT_PAST: MarkUrgentOutput = { marked: false, note: 'Not marked: that time has passed.' }

export const MARK_URGENT_DESCRIPTION =
  'In a background update ([BACKGROUND UPDATE …]) only: mark the message you are about to write as urgent, because the person must know or act before `by`. ' +
  'Native Intelligence decides where it goes; urgent only lets it reach them during the night when `by` is before about 10 am tomorrow. Anything later waits for their morning like every other message. ' +
  'Use it rarely: a meeting moved or cancelled before tomorrow morning, someone waiting on them tonight. Never for routine news. ' +
  '`by` is an ISO 8601 time with their UTC offset (2026-11-01T09:00:00-04:00). Call it once, then write the message.'

/** Whether `by` is a full ISO 8601 time with its offset that a clock reads. */
export function isUrgentBy(by: unknown): by is string {
  return typeof by === 'string' && ISO_WITH_OFFSET.test(by) && Number.isFinite(Date.parse(by))
}

/** The gate and the checks (see the header). Pure but for the clock. */
export function markUrgent(input: { by?: unknown }, auth: unknown, now: number = Date.now()): MarkUrgentOutput {
  if (!mayMarkUrgent(auth)) return MARK_URGENT_REFUSED
  if (!isUrgentBy(input.by)) return MARK_URGENT_BAD_TIME
  if (Date.parse(input.by) <= now) return MARK_URGENT_PAST
  return { marked: true, by: input.by }
}

export default defineTool({
  description: MARK_URGENT_DESCRIPTION,
  availableInSubagents: false,
  inputSchema: z.object({
    by: z.string().describe('When the person must know or act by: an ISO 8601 time with their UTC offset.'),
    why: z.string().max(200).optional().describe('Why it cannot wait, in a few words. Kept in the history; never sent.'),
  }),
  execute: (input, ctx): MarkUrgentOutput => markUrgent(input, ctx?.session?.auth),
})
