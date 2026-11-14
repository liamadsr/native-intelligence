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
 *     → { outcome, session: { id, startedAt, round, captureId, guests, audio } }
 *     outcome 'started' / 'resumed' (the session for the source's current
 *     round, made once: a second start, or one after a restart, finds it),
 *     'busy' (another producer feeds it), 'not_wanted' (no notes, or the
 *     capture was closed), 'unknown'. `guests`: the meeting guests the
 *     producer may hear (they said go to this round's notes). It hears every
 *     member, and no other guest: it does not even transcribe one.
 *     `producer.id` names the producer's room identity
 *     (notes-recorder-<id>): one id per producer process.
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
 *     { producer, sessions: [id] } → { sessions: [{ id, keep, reason, guests }] }.
 *     Every few seconds, for every session the producer runs: keep true
 *     with the guests it may hear now (a guest who says go mid-round joins
 *     the list); keep false means stop (notes went off, the call ended, the
 *     3-hour bound, the capture was closed, or `feed_off`: the source's
 *     switch is off on this server), after delivering what it still holds.
 *   POST /api/internal/capture-feed/sessions/<id>/end
 *     { producer, reason } → { ended }. The producer has delivered
 *     everything it heard for this session and leaves it (every stop but a
 *     restart): the notes' finish waits for this, a short while at most,
 *     before it locks the capture.
 *
 * Audio (migration 650, off unless the source's switch is on): a session the
 * app wants a sound file of says `audio: true` in the start's answer. The
 * producer then keeps one file per take (from where it began hearing the
 * session to where it stopped: a restart that takes the session up again
 * goes on in the same take, a producer that left and came back later makes
 * a new one), its time running on the session's clock from `offsetMs`, with
 * silence where nobody spoke. Every member's voice is in it; a meeting
 * guest's never is (their notice covers notes, not their voice kept). The
 * file waits for nothing and nothing waits for it: the notes, their finish
 * and their summary never do.
 *   POST /api/internal/capture-feed/sessions/<id>/audio
 *     { producer, take, offsetMs, durationMs, bytes, contentType }
 *     → { outcome, upload?: { url, method: 'PUT', headers }, expiresAt }.
 *     'granted': PUT the file's bytes to `url` (one use, soon, never
 *     overwriting: ask again for every attempt; a refusal because the file
 *     is there already is settled by `stored`); 'stored' (that take is in
 *     already), 'not_wanted' (the app keeps no sound of this session: the
 *     switch, the source, or past its 30 days), 'too_large', 'too_many' (10
 *     takes a session, 200 links a take), 'taken', 'unknown': drop the file.
 *     `take`: the producer's own key for the file, the same for every retry.
 *   POST /api/internal/capture-feed/sessions/<id>/audio/stored
 *     { producer, take } → { outcome, expiresAt }: the upload is done.
 *     'stored' once Storage has it, of the type the grant named; 'missing':
 *     upload it again; 'invalid' (another type): drop it.
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
  // It is logged, put in a LiveKit identity and checked by 587: letters, digits, dot, underscore, dash.
  id: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
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

/** The sound file types a producer may hand over (650's capture_audio.content_type). */
export const CAPTURE_FEED_AUDIO_TYPES = ['audio/mp4', 'audio/ogg'] as const
/** The largest file (the recordings bucket's own limit, 566). */
export const CAPTURE_FEED_AUDIO_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** A producer's key for one file (650's take_key). */
const take = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/)

export const AudioGrantSchema = z.object({
  producer: ProducerSchema,
  take,
  offsetMs: ms,
  durationMs: ms,
  bytes: z.number().int().min(1).max(CAPTURE_FEED_AUDIO_MAX_BYTES),
  contentType: z.enum(CAPTURE_FEED_AUDIO_TYPES),
})
export type CaptureFeedAudioGrant = z.infer<typeof AudioGrantSchema>

export const AudioStoredSchema = z.object({
  producer: ProducerSchema,
  take,
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
