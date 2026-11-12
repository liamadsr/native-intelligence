/**
 * What the team call routes (src/app/api/account/team-calls/*) share: the
 * answer when calling is off, the person's member row in a call's
 * workspace (a ring can come from a workspace other than the one on screen,
 * so the routes never assume the current one), and the join answer.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { createTeamCallRoom, openTeamCallRooms, teamCallToken, type TeamCallsConfig } from './livekit'
import { endCall, requestMissedNotices } from './store'
import { holdMicOnJoin, type TeamCallNotesView } from './notes'
import { teamCallFeatures } from './egress'

/** Calling is off (the LiveKit settings are unset): every call route says so, the same way. */
export function teamCallsUnavailable(): Response {
  return apiError('Calls are not available', { status: 404, code: 'CALLS_NOT_AVAILABLE' })
}

/** The person's member row in a workspace (RLS: they see their own), or null. */
export async function memberIn(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<{ id: string; display_name: string | null } | null> {
  const { data, error } = await supabase
    .from('member')
    .select('id, display_name')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string; display_name: string | null }>()
  if (error) throw new Error(`team calls: member read failed: ${error.message}`)
  return data ?? null
}

/** A live call older than this whose room is gone is over (its end was lost), not one to bring back. */
export const STALE_CALL_MS = 60_000

/** The answer when a call can't be joined: it ended (or its conversation was archived). */
export function callEnded(message = 'This call has ended'): Response {
  return apiError(message, { status: 409, code: 'CALL_ENDED' })
}

/** The answer when LiveKit can't be reached. */
export function callsUnreachable(): Response {
  return apiError('The call server could not be reached', { status: 503, code: 'CALLS_UNREACHABLE' })
}

/**
 * Before any token for a live call: its room is open on the server. LiveKit
 * never makes a room by itself (room.auto_create false, deploy/livekit), so
 * the app makes it: open already, ready; gone and the call young (its first
 * person hasn't come, or the last just left), made again; gone and the call
 * older, the call is over (its end never arrived): ended, 'swept', and the
 * answer says so. Throws when LiveKit can't be asked.
 */
export async function readyRoom(config: TeamCallsConfig, call: { id: string; room: string; started_at: string }, now: number = Date.now()): Promise<'ready' | 'ended'> {
  const open = await openTeamCallRooms(config, [call.room])
  if (open.has(call.room)) return 'ready'
  if (now - Date.parse(call.started_at) >= STALE_CALL_MS) {
    const missed = await endCall(getServiceClient(), call.id, 'swept')
    await requestMissedNotices(missed)
    return 'ended'
  }
  await createTeamCallRoom(config, call.room)
  return 'ready'
}

/** What a client needs to join a call's room: the address and a token for it. */
export interface TeamCallJoin {
  url: string
  token: string
  room: string
  callId: string
  /** False: the token is listen-only until the person has seen the notes notice. */
  canPublish: boolean
}

export async function joinAnswer(
  config: TeamCallsConfig,
  input: { callId: string; room: string; memberId: string; name: string | null; listenOnly?: boolean },
): Promise<TeamCallJoin> {
  const token = await teamCallToken(config, { room: input.room, memberId: input.memberId, name: input.name ?? '', listenOnly: input.listenOnly })
  return { url: config.url, token, room: input.room, callId: input.callId, canPublish: input.listenOnly !== true }
}

/**
 * Does this join's token wait for the person (phase 6)? Yes when the call is
 * being recorded, or its Egress notes are on by someone else's doing, and the
 * join request did not say the person has seen that (`noticeSeen: true`, sent
 * only after the client showed its notice). A client that doesn't send it
 * joins listen-only; POST [id]/notice lifts it once they have seen it. The
 * call recorder's notes never hold a member (holdMicOnJoin).
 */
export function joinsListenOnly(
  call: Partial<TeamCallNotesView> | null | undefined,
  memberId: string,
  noticeSeen: unknown,
  features = teamCallFeatures(),
): boolean {
  return noticeSeen !== true && holdMicOnJoin({ memberId, notes: notesViewOf(call), features })
}

/** A readable call as a join answer names it: where it is, who the person is in it, what the server offers, its notes and recording. */
export function callPlaceOf(
  call: { id: string; channel_id: string; workspace_id: string; message_id: string | null; channel_kind: 'channel' | 'dm' | 'meeting' } & Partial<TeamCallNotesView>,
  memberId: string,
) {
  return {
    id: call.id,
    channelId: call.channel_id,
    workspaceId: call.workspace_id,
    messageId: call.message_id,
    channelKind: call.channel_kind,
    memberId,
    features: teamCallFeatures(),
    notes: notesViewOf(call),
  }
}

/** A call's notes and recording, as a join answer carries them (the panel draws its indicators from these, then from Realtime). */
export function notesViewOf(call: Partial<TeamCallNotesView> | null | undefined): TeamCallNotesView {
  return {
    notes: call?.notes === true,
    notes_by: call?.notes_by ?? null,
    notes_state: call?.notes_state ?? 'none',
    capture_id: call?.capture_id ?? null,
    recording: call?.recording ?? 'off',
    recording_by: call?.recording_by ?? null,
  }
}
