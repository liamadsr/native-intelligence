/**
 * LiveKit's webhooks are the truth about a call (the route
 * src/app/api/calls/livekit/webhook/route.ts has checked the signature
 * first): who joined, who left, and when the room finished. LiveKit sends
 * each event more than once at times, and not always in order, so:
 *
 *   - an event id already applied is skipped (team_call_webhook_event);
 *   - a participant event is applied by 565's team_call_participant_event,
 *     which orders a member's sessions by when they joined (LiveKit's own
 *     milliseconds, sent with a leave too): a late join of a session that
 *     left is stale, an older session's leave after a newer one joined is
 *     stale (a reconnect's old leave lands in the same second as its new
 *     join);
 *   - room_finished ends the call once (team_call_end), whatever came
 *     before or comes after, unless the room is open again (made again for
 *     the live call since); the rings still open then are missed calls,
 *     told through an Inngest event per ring (never inline, so a failed
 *     write can't lose them; the sweeper finds any left untold);
 *   - a join by someone who may not read the conversation is refused by the
 *     database and they are taken out of the room at once (./eject.ts).
 *
 *   - track_published of a member's microphone while the call's notes are
 *     on starts that track's notes file (./notes-store.ts; once per track
 *     and round of notes, however often the webhook comes);
 *   - egress_started / egress_updated / egress_ended are an egress's state
 *     (566's team_call_egress), applied in the order LiveKit made them (its
 *     updatedAt): the row is found by the file's name (the app names each
 *     file after its row, so an event that comes before the start's answer
 *     still finds it) or by the egress id. A notes file that ended with
 *     audio is transcribed next (its own Inngest run).
 *
 * A room that is none of ours (another app's on the same server, a test
 * room), an identity that is not a member id, and any other event are
 * answered and ignored: LiveKit would only send them again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid } from '@/lib/team-chat/types'
import { endCall, liveCallOfRoom, participantEvent, requestMissedNotices, type MissedRing, type ParticipantOutcome } from './store'
import { teamCallIdOfRoom } from './types'
import type { TeamCallEgressPort } from './egress'
import { egressRowOfPath, egressStatusOf } from './notes'
import { applyEgressEvent, liveCallForEgress, requestNotesFiles, startNotesForTrack } from './notes-store'

/** What the route hands over: the parts of LiveKit's WebhookEvent read here. */
export interface TeamCallWebhookEvent {
  id?: string
  event?: string
  /** Seconds since the epoch (an int64: a bigint from the SDK). */
  createdAt?: bigint | number
  room?: { name?: string } | undefined
  participant?: { identity?: string; sid?: string; joinedAt?: bigint | number; joinedAtMs?: bigint | number } | undefined
  /** track_published: TrackType AUDIO is 0, TrackSource MICROPHONE is 2. */
  track?: { sid?: string; type?: number; source?: number } | undefined
  egressInfo?: WebhookEgressInfo | undefined
}

/** The parts of LiveKit's EgressInfo read here (nanosecond int64s). */
export interface WebhookEgressInfo {
  egressId?: string
  roomName?: string
  status?: number
  updatedAt?: bigint | number
  error?: string
  request?: { case?: string; value?: unknown }
  fileResults?: Array<{ filename?: string; startedAt?: bigint | number; endedAt?: bigint | number; duration?: bigint | number; size?: bigint | number }>
}

export type TeamCallWebhookOutcome =
  | 'repeat'
  | 'ignored'
  | ParticipantOutcome
  | 'ended'
  | 'already_ended'
  | 'reopened'
  | 'notes_started'
  | 'notes_not_started'
  | 'egress_applied'
  | 'egress_stale'
  | 'egress_unknown'

export interface TeamCallWebhookDeps {
  /** Ask for the missed rings' notices (an Inngest event per ring; the default). */
  requestMissed?: (missed: readonly MissedRing[]) => Promise<unknown>
  /** Take a refused joiner out at once (the eject outbox, drained). */
  drainEjections?: () => Promise<unknown>
  /** Is this room open on the server now? A room_finished for a room made again since is not the call's end. Null: can't tell. */
  roomOpen?: (room: string) => Promise<boolean | null>
  now?: () => Date
  /** LiveKit Egress (null when the server runs none: notes then start nothing). */
  egress?: TeamCallEgressPort | null
  /** Ask for notes files' words (default: Inngest). */
  requestFiles?: (rowIds: readonly string[]) => Promise<void>
}

/** An int64 of seconds as a time, or null. */
export function webhookTime(seconds: bigint | number | undefined | null): Date | null {
  if (seconds === undefined || seconds === null) return null
  const n = typeof seconds === 'bigint' ? Number(seconds) : seconds
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000)
}

/** An int64 of milliseconds as a time, or null. */
export function webhookTimeMs(ms: bigint | number | undefined | null): Date | null {
  if (ms === undefined || ms === null) return null
  const n = typeof ms === 'bigint' ? Number(ms) : ms
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n)
}

/** When a participant's session joined: LiveKit's milliseconds, else its seconds. */
export function sessionJoinedAt(participant: TeamCallWebhookEvent['participant']): Date | null {
  return webhookTimeMs(participant?.joinedAtMs) ?? webhookTime(participant?.joinedAt)
}

/** Apply one verified event. Throws on a failed write (LiveKit retries a delivery that fails). */
export async function applyTeamCallWebhook(svc: SupabaseClient, event: TeamCallWebhookEvent, deps: TeamCallWebhookDeps = {}): Promise<TeamCallWebhookOutcome> {
  const now = deps.now?.() ?? new Date()
  const id = typeof event.id === 'string' && event.id ? event.id.slice(0, 128) : null
  if (id) {
    const { data: seen, error } = await svc.from('team_call_webhook_event').select('id').eq('id', id).maybeSingle()
    if (error) throw new Error(`team calls: webhook read failed: ${error.message}`)
    if (seen) return 'repeat'
  }
  const isEgress = event.event === 'egress_started' || event.event === 'egress_updated' || event.event === 'egress_ended'
  const room = (isEgress ? event.egressInfo?.roomName : event.room?.name) ?? event.room?.name ?? null
  const outcome = !teamCallIdOfRoom(room) ? 'ignored' : isEgress ? (event.egressInfo ? await applyEgressWebhook(svc, event.egressInfo, deps) : 'ignored') : await apply(svc, event, room!, now, deps)
  if (id) {
    // Applied: a repeat of it is skipped from now on (two at once both apply, harmlessly: each step is idempotent).
    const { error } = await svc.from('team_call_webhook_event').insert({ id })
    if (error && error.code !== '23505') console.warn(`[team-calls] webhook=${id} not remembered:`, error.message)
  }
  return outcome
}

async function apply(svc: SupabaseClient, event: TeamCallWebhookEvent, room: string, now: Date, deps: TeamCallWebhookDeps): Promise<TeamCallWebhookOutcome> {
  const at = webhookTime(event.createdAt) ?? now
  switch (event.event) {
    case 'participant_joined':
    case 'participant_left':
    case 'participant_connection_aborted': {
      const identity = event.participant?.identity
      if (!isUuid(identity)) return 'ignored'
      const joined = event.event === 'participant_joined'
      // Sessions are ordered by when they joined, never by when an event arrived (a reconnect's old leave and new join share a second).
      const sessionJoined = sessionJoinedAt(event.participant)
      const when = joined ? (sessionJoined ?? at) : at
      const outcome = await participantEvent(svc, {
        room,
        memberId: identity.toLowerCase(),
        sid: event.participant?.sid ?? null,
        joined,
        at: when.toISOString(),
        sessionJoinedAt: sessionJoined?.toISOString() ?? null,
      })
      // Someone without access to the conversation joined: out of the room now.
      if (outcome === 'ejected') await deps.drainEjections?.()
      return outcome
    }
    case 'room_finished': {
      const call = await liveCallOfRoom(svc, room)
      if (!call) return 'already_ended'
      // The room was made again since (someone joined the live call after it closed): not the call's end.
      if ((await deps.roomOpen?.(room).catch(() => null)) === true) return 'reopened'
      const missed = await endCall(svc, call.id, 'finished', at)
      // Out of the request path, once per ring; a notice not asked for is the sweeper's to find.
      if (missed.length > 0) await (deps.requestMissed ?? requestMissedNotices)(missed)
      return 'ended'
    }
    case 'track_published': {
      const track = event.track
      const identity = event.participant?.identity
      // A member's microphone, audio (TrackType AUDIO 0, TrackSource MICROPHONE 2).
      if (!deps.egress || !track?.sid || track.type !== 0 || track.source !== 2 || !isUuid(identity)) return 'ignored'
      const call = await liveCallForEgress(svc, room)
      if (!call?.notes) return 'ignored'
      const started = await startNotesForTrack(svc, deps.egress, call, identity.toLowerCase(), track.sid)
      return started === 'started' ? 'notes_started' : 'notes_not_started'
    }
    default:
      return 'ignored'
  }
}

/** An int64 of nanoseconds as an ISO time, or null. */
export function webhookTimeNs(ns: bigint | number | undefined | null): string | null {
  if (ns === undefined || ns === null) return null
  const n = typeof ns === 'bigint' ? Number(ns / BigInt(1_000_000)) : ns / 1_000_000
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n).toISOString()
}

const big = (v: bigint | number | undefined | null): number | null => {
  if (v === undefined || v === null) return null
  const n = typeof v === 'bigint' ? Number(v) : v
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The file name an egress was asked to write (a track's direct file, or a composite's), as the app named it. */
export function requestedFilepath(info: WebhookEgressInfo): string | null {
  const value = info.request?.value as
    | { output?: { case?: string; value?: { filepath?: string } }; fileOutputs?: Array<{ filepath?: string }> }
    | undefined
  const direct = value?.output?.case === 'file' ? value.output.value?.filepath : undefined
  return direct ?? value?.fileOutputs?.[0]?.filepath ?? info.fileResults?.[0]?.filename ?? null
}

/** An egress webhook, applied (566's team_call_egress, in LiveKit's order). */
export async function applyEgressWebhook(svc: SupabaseClient, info: WebhookEgressInfo, deps: TeamCallWebhookDeps): Promise<TeamCallWebhookOutcome> {
  const row = egressRowOfPath(requestedFilepath(info))
  if (!row && !info.egressId) return 'ignored'
  const file = info.fileResults?.[0]
  const durationNs = big(file?.duration)
  const result = await applyEgressEvent(svc, {
    rowId: row?.rowId ?? null,
    egressId: info.egressId || null,
    status: egressStatusOf(info.status),
    atNs: typeof info.updatedAt === 'bigint' ? info.updatedAt : String(Math.max(0, Math.floor(Number(info.updatedAt ?? 0)))),
    fileStartedAt: webhookTimeNs(file?.startedAt),
    fileEndedAt: webhookTimeNs(file?.endedAt),
    durationMs: durationNs === null ? null : Math.round(durationNs / 1_000_000),
    sizeBytes: big(file?.size),
    error: info.error || null,
  })
  if (result.outcome === 'applied' && result.kind === 'notes' && result.rowId && (result.status === 'complete' || result.status === 'limit')) {
    await (deps.requestFiles ?? ((ids) => requestNotesFiles(ids)))([result.rowId])
  }
  return result.outcome === 'applied' ? 'egress_applied' : result.outcome === 'stale' ? 'egress_stale' : 'egress_unknown'
}
