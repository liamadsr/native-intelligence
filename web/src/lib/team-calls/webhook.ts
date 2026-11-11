/**
 * LiveKit's webhooks are the truth about a call (the route
 * src/app/api/calls/livekit/webhook/route.ts has checked the signature
 * first): who joined, who left, and when the room finished. LiveKit sends
 * each event more than once at times, and not always in order, so:
 *
 *   - an event id already applied is skipped (team_call_webhook_event);
 *   - a participant event is applied by 565's team_call_participant_event,
 *     which keeps the newest per member and session (a late join of a
 *     session that left is stale, an older session's leave after a newer
 *     join is stale);
 *   - room_finished ends the call once (team_call_end), whatever came
 *     before or comes after; the rings still open then are missed calls.
 *
 * A room that is none of ours (another app's on the same server, a test
 * room), an identity that is not a member id, and any other event are
 * answered and ignored: LiveKit would only send them again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid } from '@/lib/team-chat/types'
import { endCall, liveCallOfRoom, notifyMissedCalls, participantEvent, type MissedRing, type ParticipantOutcome } from './store'
import { teamCallIdOfRoom } from './types'

/** What the route hands over: the parts of LiveKit's WebhookEvent read here. */
export interface TeamCallWebhookEvent {
  id?: string
  event?: string
  /** Seconds since the epoch (an int64: a bigint from the SDK). */
  createdAt?: bigint | number
  room?: { name?: string } | undefined
  participant?: { identity?: string; sid?: string; joinedAt?: bigint | number } | undefined
}

export type TeamCallWebhookOutcome = 'repeat' | 'ignored' | ParticipantOutcome | 'ended' | 'already_ended'

export interface TeamCallWebhookDeps {
  notifyMissed?: (svc: SupabaseClient, missed: readonly MissedRing[]) => Promise<unknown>
  now?: () => Date
}

/** An int64 of seconds as a time, or null. */
export function webhookTime(seconds: bigint | number | undefined | null): Date | null {
  if (seconds === undefined || seconds === null) return null
  const n = typeof seconds === 'bigint' ? Number(seconds) : seconds
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000)
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
  const room = event.room?.name ?? null
  const outcome = teamCallIdOfRoom(room) ? await apply(svc, event, room!, now, deps) : 'ignored'
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
      const when = joined ? (webhookTime(event.participant?.joinedAt) ?? at) : at
      return participantEvent(svc, { room, memberId: identity.toLowerCase(), sid: event.participant?.sid ?? null, joined, at: when.toISOString() })
    }
    case 'room_finished': {
      const call = await liveCallOfRoom(svc, room)
      if (!call) return 'already_ended'
      const missed = await endCall(svc, call.id, 'finished', at)
      if (missed.length > 0) await (deps.notifyMissed ?? notifyMissedCalls)(svc, missed)
      return 'ended'
    }
    default:
      return 'ignored'
  }
}
