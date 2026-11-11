/**
 * Team calls (calls plan, phase 5, migrations 564-565): audio and video calls
 * between the people of a team chat channel or DM, over the self-hosted
 * LiveKit server (deploy/livekit). Not the phone line to a person's own
 * agent (src/lib/calls): that is another feature.
 *
 * This module is the shared vocabulary, pure and client-safe. A call lives
 * in one channel or DM (at most one live at a time there) and shows in the
 * conversation as a message of its own kind (`team_chat_message.kind =
 * 'call'`); who is in it and when it ended come from LiveKit's webhooks
 * (./webhook.ts). A ring is one person's incoming call: a DM's start rings
 * the other person, a channel's rings only the people the caller picks.
 */

/** How long a ring rings before it is a missed call (565's `interval '40 seconds'`). */
export const TEAM_CALL_RING_SECONDS = 40
/** A join token's lifetime: LiveKit refreshes it while connected; a full rejoin asks the token route again. */
export const TEAM_CALL_TOKEN_TTL_SECONDS = 10 * 60
/** A new room's wait for its first person, then for anyone after the last leaves (LiveKit's own timers). */
export const TEAM_CALL_EMPTY_TIMEOUT_SECONDS = 60
export const TEAM_CALL_DEPARTURE_TIMEOUT_SECONDS = 15
/** The most people in one call (the room's cap). */
export const TEAM_CALL_MAX_PARTICIPANTS = 50
/** The most people one ring request rings (565's cap). */
export const TEAM_CALL_MAX_RING = 20

export type TeamCallStatus = 'live' | 'ended'
export type TeamCallEndReason = 'finished' | 'left' | 'swept' | 'failed'
export type TeamCallRingState = 'ringing' | 'busy' | 'accepted' | 'declined' | 'missed' | 'cancelled'

/** A call, as the conversation shows it (team_call's columns a page reads). */
export interface TeamCall {
  id: string
  channel_id: string
  message_id: string | null
  started_by: string | null
  status: TeamCallStatus
  started_at: string
  ended_at: string | null
  ended_reason: TeamCallEndReason | null
  duration_seconds: number | null
  participant_count: number
  peak_participants: number
  /** Members being rung now. */
  ringing: string[]
  /** Members who said no. */
  declined: string[]
}

export const TEAM_CALL_COLUMNS =
  'id, channel_id, message_id, started_by, status, started_at, ended_at, ended_reason, duration_seconds, participant_count, peak_participants, ringing, declined'

/** One member in (or once in) a call. */
export interface TeamCallParticipant {
  call_id: string
  member_id: string
  state: 'joined' | 'left'
  joined_at: string
  left_at: string | null
}

export const TEAM_CALL_PARTICIPANT_COLUMNS = 'call_id, member_id, state, joined_at, left_at'

/** One person's incoming call, as its own row says it (their own rows only, by RLS). */
export interface TeamCallRing {
  id: string
  call_id: string
  workspace_id: string
  channel_id: string
  member_id: string
  caller_member_id: string | null
  caller_name: string
  channel_kind: 'channel' | 'dm'
  channel_name: string | null
  state: TeamCallRingState
  created_at: string
  expires_at: string
}

export const TEAM_CALL_RING_COLUMNS =
  'id, call_id, workspace_id, channel_id, member_id, caller_member_id, caller_name, channel_kind, channel_name, state, created_at, expires_at'

/** A call and who is in it, as the conversation's message draws it. */
export interface TeamCallView {
  call: TeamCall
  participants: TeamCallParticipant[]
}

/** The LiveKit room of a call ('tc-<id>', 565's team_call_start). */
export function teamCallRoom(callId: string): string {
  return `tc-${callId}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The call a LiveKit room is, or null for a room that is none of ours. */
export function teamCallIdOfRoom(room: string | null | undefined): string | null {
  if (!room || !room.startsWith('tc-')) return null
  const id = room.slice(3)
  return UUID.test(id) ? id.toLowerCase() : null
}

/** A duration as a call's line says it: "under a minute", "12 min", "1 h 5 min", "2 h". */
export function teamCallDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0))
  if (s < 60) return 'under a minute'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return m > 0 ? `${h} h ${m} min` : `${h} h`
}

/**
 * An ended call's line, the same words 565's team_call_summary writes onto
 * its message: "Call ended · 12 min · 3 people", "Missed call" for a DM
 * nobody answered, "Call ended" when nobody joined.
 */
export function teamCallSummary(channelKind: 'channel' | 'dm', seconds: number | null | undefined, peak: number | null | undefined): string {
  const people = Math.max(0, Math.floor(peak ?? 0))
  if (channelKind === 'dm' && people <= 1) return 'Missed call'
  if (people === 0) return 'Call ended'
  return `Call ended · ${teamCallDuration(seconds)} · ${people} ${people === 1 ? 'person' : 'people'}`
}

/** The members in a call now, in the order they joined. */
export function inCallNow(participants: readonly TeamCallParticipant[] | undefined): TeamCallParticipant[] {
  return (participants ?? []).filter((p) => p.state === 'joined').sort((a, b) => a.joined_at.localeCompare(b.joined_at))
}

/** A participant row into a call's list (replacing that member's), as Realtime and a page hand them over. */
export function upsertParticipant(list: readonly TeamCallParticipant[] | undefined, row: TeamCallParticipant): TeamCallParticipant[] {
  const next = (list ?? []).filter((p) => p.member_id !== row.member_id)
  next.push(row)
  return next
}

/** Where a ring is from, as the incoming-call surface says it: "#launch", or null for a DM. */
export function teamCallPlace(ring: Pick<TeamCallRing, 'channel_kind' | 'channel_name'>): string | null {
  return ring.channel_kind === 'channel' ? `#${ring.channel_name ?? 'channel'}` : null
}

/** The incoming-call surface's line: "Ana Ruiz is calling" (a DM), "Ana Ruiz is calling you in #launch". */
export function teamCallRingLine(ring: Pick<TeamCallRing, 'caller_name' | 'channel_kind' | 'channel_name'>): string {
  const who = ring.caller_name.trim() || 'A teammate'
  const place = teamCallPlace(ring)
  return place ? `${who} is calling you in ${place}` : `${who} is calling`
}
