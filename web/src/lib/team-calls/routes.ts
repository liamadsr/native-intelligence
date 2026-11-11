/**
 * What the team call routes (src/app/api/account/team-calls/*) share: the
 * answer when calling is off, the person's member row in a call's
 * workspace (a ring can come from a workspace other than the one on screen,
 * so the routes never assume the current one), and the join answer.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '@/lib/api-errors'
import { teamCallToken, type TeamCallsConfig } from './livekit'
import type { TeamCallNotesView } from './notes'
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

/** What a client needs to join a call's room: the address and a token for it. */
export interface TeamCallJoin {
  url: string
  token: string
  room: string
  callId: string
}

export async function joinAnswer(config: TeamCallsConfig, input: { callId: string; room: string; memberId: string; name: string | null }): Promise<TeamCallJoin> {
  const token = await teamCallToken(config, { room: input.room, memberId: input.memberId, name: input.name ?? '' })
  return { url: config.url, token, room: input.room, callId: input.callId }
}

/** A readable call as a join answer names it: where it is, who the person is in it, what the server offers, its notes and recording. */
export function callPlaceOf(
  call: { id: string; channel_id: string; workspace_id: string; message_id: string | null; channel_kind: 'channel' | 'dm' } & Partial<TeamCallNotesView>,
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
