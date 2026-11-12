/**
 * The capture feed (migrations 587-588): how a producer on the server
 * delivers a call's speech to the app while the call happens. The app owns
 * everything the speech becomes: the capture, its transcript (`[Label]
 * words` lines, appended live), its participants and its end. A producer
 * only hears and says what it heard.
 *
 * The contract knows nothing of LiveKit, or of any one producer. Today's
 * producer is the call recorder (recorder/ at the repo's root), for our own
 * team calls; a producer that joins someone's Meet, Teams or Zoom call is a
 * second source kind, not a second contract.
 *
 *   POST /api/internal/capture-feed/start
 *     { source: { kind, ref }, producer: { kind, id } }
 *     → { outcome, session: { id, startedAt, round, captureId } }
 *     outcome 'started' / 'resumed' (the session for the source's current
 *     round, made once: a second start, or one after a restart, finds it),
 *     'busy' (another producer feeds it), 'not_wanted', 'unknown'.
 *   POST /api/internal/capture-feed/sessions/<id>/roster
 *     { producer, events: [{ key, speaker, kind: 'joined' | 'left', atMs,
 *       identity?: { memberId } | { guestId } | { name, email? } }] }
 *     → { results: [{ key, outcome }] }. A speaker key's first event says
 *     who it is; one person is one participant row, with one label.
 *   POST /api/internal/capture-feed/sessions/<id>/segments
 *     { producer, segments: [{ key, speaker, text, startMs, endMs }] }
 *     → { outcome, accepted, duplicate, dropped, transcriptLength }.
 *     Final segments only. `key` is the segment's idempotency key: sent
 *     again (a retry), it is a duplicate and changes nothing.
 *   POST /api/internal/capture-feed/heartbeat
 *     { producer, sessions: [id] } → { sessions: [{ id, keep, reason }] }.
 *     Every few seconds, for every session the producer runs: keep false
 *     means stop (notes went off, the call ended, the 3-hour bound), after
 *     delivering what it still holds.
 *   POST /api/internal/capture-feed/sessions/<id>/end
 *     { producer, reason } → { ended }.
 *
 * Times: every `atMs`, `startMs` and `endMs` is milliseconds from the
 * session's `startedAt` (the app's clock), so a producer that restarts goes
 * on in the same time. Delivery is at least once: a producer sends each
 * request until it is answered, in the order it made them (a speaker's
 * roster event before their words), and the app takes a repeat as a repeat.
 *
 * Auth: `Authorization: Bearer <CAPTURE_FEED_SECRET>` (./auth.ts).
 */
import { z } from 'zod'

/** The kinds of source a feed may be of (587's capture_feed_session_source_kind). */
export const CAPTURE_FEED_SOURCE_KINDS = ['team_call'] as const
export type CaptureFeedSourceKind = (typeof CAPTURE_FEED_SOURCE_KINDS)[number]

/** The most segments or roster events one request carries (588 reads at most 500). */
export const CAPTURE_FEED_MAX_BATCH = 200
/** The longest a segment's words are (587). */
export const CAPTURE_FEED_MAX_TEXT = 4000

const uuid = z.string().uuid()
/** A time in the feed's clock: up to a day of milliseconds. */
const ms = z.number().int().min(0).max(24 * 60 * 60 * 1000)
const key = z.string().min(1).max(128)

export const ProducerSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  id: z.string().min(1).max(80),
})
export type CaptureFeedProducer = z.infer<typeof ProducerSchema>

export const StartSchema = z.object({
  source: z.object({ kind: z.enum(CAPTURE_FEED_SOURCE_KINDS), ref: uuid }),
  producer: ProducerSchema,
})

export const IdentitySchema = z.union([
  z.object({ memberId: uuid }).strict(),
  z.object({ guestId: uuid }).strict(),
  z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(254).optional() }).strict(),
])
export type CaptureFeedIdentity = z.infer<typeof IdentitySchema>

export const RosterSchema = z.object({
  producer: ProducerSchema,
  events: z
    .array(
      z.object({
        key,
        speaker: key,
        kind: z.enum(['joined', 'left']),
        atMs: ms,
        identity: IdentitySchema.optional(),
      }),
    )
    .min(1)
    .max(CAPTURE_FEED_MAX_BATCH),
})
export type CaptureFeedRosterEvent = z.infer<typeof RosterSchema>['events'][number]

export const SegmentsSchema = z.object({
  producer: ProducerSchema,
  segments: z
    .array(
      z
        .object({
          key,
          speaker: key,
          text: z.string().min(1).max(CAPTURE_FEED_MAX_TEXT),
          startMs: ms,
          endMs: ms,
        })
        .refine((s) => s.endMs >= s.startMs, { message: 'endMs before startMs' }),
    )
    .min(1)
    .max(CAPTURE_FEED_MAX_BATCH),
})
export type CaptureFeedSegment = z.infer<typeof SegmentsSchema>['segments'][number]

export const HeartbeatSchema = z.object({
  producer: ProducerSchema,
  sessions: z.array(uuid).max(CAPTURE_FEED_MAX_BATCH),
})

export const EndSchema = z.object({
  producer: ProducerSchema,
  reason: z.string().trim().min(1).max(40).optional(),
})

/** A roster event as 588 reads it (snake_case: at_ms, member_id, guest_id). */
export function rosterEventRow(e: CaptureFeedRosterEvent): Record<string, unknown> {
  const identity = e.identity
    ? 'memberId' in e.identity
      ? { member_id: e.identity.memberId.toLowerCase() }
      : 'guestId' in e.identity
        ? { guest_id: e.identity.guestId.toLowerCase() }
        : { name: e.identity.name, ...(e.identity.email ? { email: e.identity.email } : {}) }
    : undefined
  return { key: e.key, speaker: e.speaker, kind: e.kind, at_ms: e.atMs, ...(identity ? { identity } : {}) }
}

/** A segment as 588 reads it. */
export function segmentRow(s: CaptureFeedSegment): Record<string, unknown> {
  return { key: s.key, speaker: s.speaker, text: s.text, start_ms: s.startMs, end_ms: s.endMs }
}
