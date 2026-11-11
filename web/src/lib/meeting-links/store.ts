/**
 * Meeting links' reads and writes (migrations 572-575). Two kinds of caller:
 *
 *   as the person (THEIR Supabase client, under RLS; 574's functions read
 *   auth.uid()): make a meeting, join one by its link, revoke it, admit or
 *   decline a waiting guest, remove a guest, read a conversation's meeting
 *   and its guests;
 *
 *   as the service role, only after a public route checked what vouches for
 *   the caller (a link's token by its hash, a guest's signed cookie):
 *   find a meeting by its token, a guest's request, their lobby's poll,
 *   their leaving; LiveKit's webhooks for a guest; the sweeper.
 *
 * Person calls throw a TeamChatError (the routes turn its code into a
 * status); the service role's throw plain errors. Logs carry ids only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { teamChatErrorOf, TeamChatError } from '@/lib/team-chat/store'
import { MEETING_COLUMNS, MEETING_GUEST_COLUMNS, MEETING_MAX_WAITING, type MeetingGuest, type MeetingGuestState, type MeetingView } from './shape'

// ── As the person ───────────────────────────────────────────────────────────

/** 574's refusal ("meetings: that time has passed") as a sentence: "That time has passed." */
export function meetingLine(message: string): string {
  const words = message.replace(/^meetings: /, '').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}${/[.!?]$/.test(words) ? '' : '.'}` : 'That didn’t work.'
}

export interface MadeMeeting {
  meetingId: string
  channelId: string
  opensAt: string
  closesAt: string
}

/**
 * Make a meeting and its conversation: as the person (574's meeting_create,
 * they are the host), or with the service role for a member the server
 * already knows (`hostMemberId`: 574's meeting_create_for). The id and the
 * token's hash are the server's.
 */
export async function insertMeeting(
  supabase: SupabaseClient,
  input: { meetingId: string; workspaceId: string; title: string; tokenDigest: string; tokenNonce: string; startsAt: string | null; minutes: number | null; hostMemberId?: string },
): Promise<MadeMeeting> {
  const { data, error } = await supabase.rpc(input.hostMemberId ? 'meeting_create_for' : 'meeting_create', {
    ...(input.hostMemberId ? { host_member: input.hostMemberId } : {}),
    meeting_ref: input.meetingId,
    ws: input.workspaceId,
    meeting_title: input.title,
    token_digest: input.tokenDigest,
    token_nonce: input.tokenNonce,
    starts: input.startsAt,
    minutes: input.minutes,
  })
  // 574's own words for a refused title or time ("that time has passed"), for the dialog to say.
  if (error?.code === '22023' && /^meetings: /.test(error.message ?? '')) throw new TeamChatError('bad_request', meetingLine(error.message))
  if (error) throw teamChatErrorOf(error, 'meeting create')
  const row = (Array.isArray(data) ? data[0] : data) as { meeting_id?: string; channel_id?: string; opens_at?: string; closes_at?: string } | undefined
  if (!row?.meeting_id || !row.channel_id) throw new TeamChatError('failed', 'meeting create returned nothing')
  return { meetingId: row.meeting_id, channelId: row.channel_id, opensAt: String(row.opens_at), closesAt: String(row.closes_at) }
}

/** A member who opened a link joins its conversation (574's meeting_join, by the token's hash). */
export async function joinMeetingByDigest(supabase: SupabaseClient, digest: string): Promise<{ meetingId: string; channelId: string; workspaceId: string; title: string }> {
  const { data, error } = await supabase.rpc('meeting_join', { token_digest: digest })
  if (error) throw teamChatErrorOf(error, 'meeting join')
  const row = (Array.isArray(data) ? data[0] : data) as { meeting_id?: string; channel_id?: string; workspace_id?: string; title?: string } | undefined
  if (!row?.meeting_id || !row.channel_id || !row.workspace_id) throw new TeamChatError('failed', 'meeting join returned nothing')
  return { meetingId: row.meeting_id, channelId: row.channel_id, workspaceId: row.workspace_id, title: row.title ?? 'Meeting' }
}

/** The host revokes a link (574's meeting_revoke): the live call there, if any, for the route to end or not. */
export async function revokeMeeting(supabase: SupabaseClient, meetingId: string): Promise<{ revoked: boolean; callId: string | null; room: string | null }> {
  const { data, error } = await supabase.rpc('meeting_revoke', { target_meeting: meetingId })
  if (error) throw teamChatErrorOf(error, 'meeting revoke')
  const row = (Array.isArray(data) ? data[0] : data) as { revoked?: boolean; call_id?: string | null; room?: string | null } | undefined
  return { revoked: row?.revoked === true, callId: row?.call_id ?? null, room: row?.room ?? null }
}

/**
 * The host revokes a link from the app's calendar, with the service role
 * (586's meeting_revoke_as: the meeting's host only, whoever signed in how,
 * a device's token included). As meeting_revoke otherwise.
 */
export async function revokeMeetingAs(svc: SupabaseClient, meetingId: string, userId: string): Promise<{ revoked: boolean; callId: string | null; room: string | null }> {
  const { data, error } = await svc.rpc('meeting_revoke_as', { target_meeting: meetingId, acting_user: userId })
  if (error) throw teamChatErrorOf(error, 'meeting revoke')
  const row = (Array.isArray(data) ? data[0] : data) as { revoked?: boolean; call_id?: string | null; room?: string | null } | undefined
  return { revoked: row?.revoked === true, callId: row?.call_id ?? null, room: row?.room ?? null }
}

/** The host replaces the link (574's meeting_new_link): a new token; the old one stops working. */
export async function replaceMeetingLink(supabase: SupabaseClient, input: { meetingId: string; tokenDigest: string; tokenNonce: string }): Promise<void> {
  const { error } = await supabase.rpc('meeting_new_link', { target_meeting: input.meetingId, token_digest: input.tokenDigest, token_nonce: input.tokenNonce })
  if (error?.code === '22023' && /^meetings: /.test(error.message ?? '')) throw new TeamChatError('bad_request', meetingLine(error.message))
  if (error) throw teamChatErrorOf(error, 'meeting new link')
}

/** A meeting's link's nonce (the server's only: no client may read it), to show the link again. */
export async function meetingNonce(svc: SupabaseClient, meetingId: string): Promise<string | null> {
  const { data, error } = await svc.from('meeting').select('token_nonce').eq('id', meetingId).maybeSingle<{ token_nonce: string | null }>()
  if (error) throw new Error(`meetings: nonce read failed: ${error.message}`)
  return data?.token_nonce ?? null
}

/** Someone in the call lets a waiting guest in, or not (574's meeting_guest_decide). */
export async function decideGuest(supabase: SupabaseClient, guestId: string, admit: boolean): Promise<{ state: MeetingGuestState; callId: string | null }> {
  const { data, error } = await supabase.rpc('meeting_guest_decide', { target_guest: guestId, admit })
  if (error) throw teamChatErrorOf(error, 'guest decide')
  const row = (Array.isArray(data) ? data[0] : data) as { state?: MeetingGuestState; call_id?: string | null } | undefined
  if (!row?.state) throw new TeamChatError('failed', 'guest decide returned nothing')
  return { state: row.state, callId: row.call_id ?? null }
}

/** A member removes a guest for good (574's meeting_guest_remove). True when they were in the room (the eject outbox has them). */
export async function removeGuest(supabase: SupabaseClient, guestId: string): Promise<{ ejected: boolean }> {
  const { data, error } = await supabase.rpc('meeting_guest_remove', { target_guest: guestId })
  if (error) throw teamChatErrorOf(error, 'guest remove')
  const row = (Array.isArray(data) ? data[0] : data) as { ejected?: boolean } | undefined
  return { ejected: row?.ejected === true }
}

type MeetingRow = Omit<MeetingView, 'url'>

/** A conversation's meeting, as the person may read it (RLS: who may read the conversation), or null. */
export async function meetingOfChannel(supabase: SupabaseClient, channelId: string): Promise<(MeetingRow & { workspace_id: string }) | null> {
  const { data, error } = await supabase.from('meeting').select(`${MEETING_COLUMNS}, workspace_id`).eq('channel_id', channelId).maybeSingle<MeetingRow & { workspace_id: string }>()
  if (error) throw teamChatErrorOf(error, 'meeting read')
  return data ?? null
}

/** A meeting by its id, as the person may read it, or null. */
export async function meetingById(supabase: SupabaseClient, meetingId: string): Promise<(MeetingRow & { workspace_id: string }) | null> {
  const { data, error } = await supabase.from('meeting').select(`${MEETING_COLUMNS}, workspace_id`).eq('id', meetingId).maybeSingle<MeetingRow & { workspace_id: string }>()
  if (error) throw teamChatErrorOf(error, 'meeting read')
  return data ?? null
}

/** A conversation's guests still in play (waiting, or let into a call), as members see the lobby. */
export async function guestsOfChannel(supabase: SupabaseClient, channelId: string): Promise<MeetingGuest[]> {
  const { data, error } = await supabase
    .from('meeting_guest')
    .select(MEETING_GUEST_COLUMNS)
    .eq('channel_id', channelId)
    .in('state', ['waiting', 'admitted'])
    .order('requested_at', { ascending: true })
    .limit(100)
  if (error) throw teamChatErrorOf(error, 'guests read')
  return (data ?? []) as MeetingGuest[]
}

// ── As the service role ─────────────────────────────────────────────────────

/** A meeting as the public routes read it (by its token's hash). */
export interface PublicMeeting {
  id: string
  workspace_id: string
  channel_id: string
  host_member_id: string | null
  title: string
  starts_at: string | null
  opens_at: string
  closes_at: string
  revoked_at: string | null
  token_nonce: string | null
}

/** The meeting a token's hash names, or null. */
export async function meetingByDigest(svc: SupabaseClient, digest: string): Promise<PublicMeeting | null> {
  const { data, error } = await svc
    .from('meeting')
    .select('id, workspace_id, channel_id, host_member_id, title, starts_at, opens_at, closes_at, revoked_at, token_nonce')
    .eq('token_hash', digest)
    .maybeSingle<PublicMeeting>()
  if (error) throw new Error(`meetings: lookup failed: ${error.message}`)
  return data ?? null
}

/** The host's first name (all a guest's page says of them), or null. */
export async function hostName(svc: SupabaseClient, memberId: string | null): Promise<string | null> {
  if (!memberId) return null
  const { data } = await svc.from('member').select('display_name').eq('id', memberId).maybeSingle<{ display_name: string | null }>()
  return data?.display_name ?? null
}

export type GuestRequestOutcome = 'waiting' | 'early' | 'inactive' | 'full'

export interface GuestRequest {
  outcome: GuestRequestOutcome
  guestId: string | null
  hostMemberId: string | null
  membersInCall: number
  callId: string | null
}

/** A guest asks to join (574's meeting_guest_request). */
export async function requestToJoin(svc: SupabaseClient, input: { meetingId: string; name: string; rateKey: string }): Promise<GuestRequest> {
  const { data, error } = await svc.rpc('meeting_guest_request', { target_meeting: input.meetingId, guest_name: input.name, key: input.rateKey, max_waiting: MEETING_MAX_WAITING })
  if (error) throw new Error(`meetings: guest request failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: GuestRequestOutcome; guest_id?: string | null; host_member_id?: string | null; members_in_call?: number; call_id?: string | null } | undefined
  return {
    outcome: row?.outcome ?? 'inactive',
    guestId: row?.guest_id ?? null,
    hostMemberId: row?.host_member_id ?? null,
    membersInCall: Number(row?.members_in_call ?? 0) || 0,
    callId: row?.call_id ?? null,
  }
}

export interface GuestPoll {
  state: MeetingGuestState
  callId: string | null
  room: string | null
  notes: boolean
  recording: string
  open: boolean
  /** They must see the notice (notes or a recording on that they haven't said go to) before they may publish. */
  needsNotice: boolean
  /** Workspace members in the call now (none: the host has left). */
  membersInCall: number
}

/** A guest's lobby, as their page polls it (574's meeting_guest_poll, one read: by the guest and the link's hash), or null for a guest that isn't this link's. */
export async function pollGuest(svc: SupabaseClient, guestId: string, digest: string): Promise<GuestPoll | null> {
  const { data, error } = await svc.rpc('meeting_guest_poll', { target_guest: guestId, token_digest: digest })
  if (error) throw new Error(`meetings: poll failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as
    | { state?: MeetingGuestState; call_id?: string | null; room?: string | null; notes?: boolean; recording?: string; open?: boolean; needs_notice?: boolean; members_in_call?: number }
    | undefined
  if (!row?.state) return null
  return {
    state: row.state,
    callId: row.call_id ?? null,
    room: row.room ?? null,
    notes: row.notes === true,
    recording: row.recording ?? 'off',
    open: row.open === true,
    needsNotice: row.needs_notice === true,
    membersInCall: Number(row.members_in_call ?? 0) || 0,
  }
}

/** An admitted guest said go to the notice (574's meeting_guest_ack): their call's room, or null (not let into a live call). */
export async function ackGuest(svc: SupabaseClient, guestId: string, digest: string): Promise<{ callId: string; room: string } | null> {
  const { data, error } = await svc.rpc('meeting_guest_ack', { target_guest: guestId, token_digest: digest })
  if (error) throw new Error(`meetings: ack failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { call_id?: string; room?: string } | undefined
  return row?.call_id && row.room ? { callId: row.call_id, room: row.room } : null
}

/** A meeting's live calls with guests and no member for `graceSeconds` (574's meeting_guest_only_calls): the sweeper ends them. */
export async function guestOnlyCalls(svc: SupabaseClient, graceSeconds: number): Promise<Array<{ callId: string; room: string }>> {
  const { data, error } = await svc.rpc('meeting_guest_only_calls', { grace_seconds: graceSeconds })
  if (error) throw new Error(`meetings: guest-only calls read failed: ${error.message}`)
  return ((data ?? []) as Array<{ call_id: string; room: string }>).map((r) => ({ callId: r.call_id, room: r.room }))
}

/** The guest went (574's meeting_guest_leave). */
export async function leaveAsGuest(svc: SupabaseClient, guestId: string, digest: string): Promise<string> {
  const { data, error } = await svc.rpc('meeting_guest_leave', { target_guest: guestId, token_digest: digest })
  if (error) throw new Error(`meetings: leave failed: ${error.message}`)
  return typeof data === 'string' ? data : 'unknown'
}

export type GuestEventOutcome = 'joined' | 'left' | 'same' | 'stale' | 'ended' | 'unknown' | 'ejected'

/** LiveKit's join or leave of a guest identity (574's meeting_guest_event). */
export async function guestEvent(
  svc: SupabaseClient,
  input: { room: string; guestId: string; sid: string | null; joined: boolean; at: string; sessionJoinedAt: string | null },
): Promise<GuestEventOutcome> {
  const { data, error } = await svc.rpc('meeting_guest_event', {
    room_name: input.room,
    guest_ref: input.guestId,
    session_ref: input.sid,
    is_join: input.joined,
    event_at: input.at,
    session_joined_at: input.sessionJoinedAt,
  })
  if (error) throw new Error(`meetings: guest event failed: ${error.message}`)
  return (data as GuestEventOutcome) ?? 'unknown'
}

/** The sweeper's check of every guest connected (574's meeting_guest_fence): how many were put out. */
export async function fenceGuests(svc: SupabaseClient): Promise<number> {
  const { data, error } = await svc.rpc('meeting_guest_fence')
  if (error) throw new Error(`meetings: guest fence failed: ${error.message}`)
  return Array.isArray(data) ? data.length : 0
}

/** The sweeper's tidying (every five minutes): guests waiting who stopped polling have left. */
export async function sweepMeetings(svc: SupabaseClient, now: Date = new Date()): Promise<{ gone: number }> {
  const { data, error } = await svc
    .from('meeting_guest')
    .update({ state: 'left' })
    .eq('state', 'waiting')
    .lt('last_seen_at', new Date(now.getTime() - 2 * 60_000).toISOString())
    .select('id')
  if (error) throw new Error(`meetings: lobby sweep failed: ${error.message}`)
  return { gone: (data ?? []).length }
}

/** How long a guest's name is kept after they are done with a meeting, and their address key after they stop waiting. */
export const MEETING_GUEST_NAME_KEEP_MS = 30 * 24 * 60 * 60_000
export const MEETING_GUEST_KEY_KEEP_MS = 24 * 60 * 60_000

/**
 * The daily prune: limit windows over a day old go; a guest's address key
 * goes a day after they stopped waiting (it only counts guests waiting); a
 * guest done with a meeting for 30 days keeps no name ("Guest"; the row stays,
 * as meeting_guest is published to Realtime and is never hard-deleted by the
 * app). Throws only when nothing could be done.
 */
export async function pruneMeetingGuests(svc: SupabaseClient, now: Date = new Date()): Promise<{ rates: number; keys: number; names: number }> {
  const day = new Date(now.getTime() - MEETING_GUEST_KEY_KEEP_MS).toISOString()
  const month = new Date(now.getTime() - MEETING_GUEST_NAME_KEEP_MS).toISOString()
  const out = { rates: 0, keys: 0, names: 0 }
  const rates = await svc.from('meeting_rate').delete().lt('window_start', day).select('bucket')
  if (rates.error) console.warn('[meetings] limit windows not pruned:', rates.error.message)
  else out.rates = (rates.data ?? []).length
  const done = await svc.from('meeting_guest').select('id').in('state', ['left', 'declined', 'removed']).lt('requested_at', day).limit(1000)
  if (done.error) console.warn('[meetings] done guests not read:', done.error.message)
  else if ((done.data ?? []).length > 0) {
    const ids = (done.data as Array<{ id: string }>).map((g) => g.id)
    const keys = await svc.from('meeting_guest_key').delete().in('guest_id', ids).select('guest_id')
    if (keys.error) console.warn('[meetings] guest keys not pruned:', keys.error.message)
    else out.keys = (keys.data ?? []).length
  }
  const names = await svc
    .from('meeting_guest')
    .update({ name: 'Guest', session_sid: null })
    .in('state', ['left', 'declined', 'removed'])
    .lt('requested_at', month)
    .neq('name', 'Guest')
    .select('id')
  if (names.error) console.warn('[meetings] old guest names not cleared:', names.error.message)
  else out.names = (names.data ?? []).length
  return out
}

// ── The host's notice ───────────────────────────────────────────────────────

export const MEETING_WAITING_NOTIFICATION_TYPE = 'meeting_waiting' as const

/** The notice's title: "Dana is waiting to join Design review". */
export function waitingTitle(guestName: string, title: string): string {
  return `${guestName} is waiting to join ${title}`.slice(0, 200)
}

/**
 * Tell the host someone is waiting and nobody is in the call to let them in:
 * one notification through the ordinary path (a toast, the desktop banner;
 * a click opens the meeting's conversation). One at a time: while the host
 * has an unread one for this meeting from the last ten minutes, it is
 * renamed for the newest guest instead of a second one. Never throws.
 */
export async function notifyHostWaiting(
  svc: SupabaseClient,
  input: { meeting: Pick<PublicMeeting, 'id' | 'workspace_id' | 'channel_id' | 'host_member_id' | 'title'>; guestId: string; guestName: string },
  now: Date = new Date(),
): Promise<'sent' | 'renamed' | 'skipped'> {
  const host = input.meeting.host_member_id
  if (!host) return 'skipped'
  try {
    const title = waitingTitle(input.guestName, input.meeting.title)
    const { data: open } = await svc
      .from('notification')
      .select('id')
      .eq('type', MEETING_WAITING_NOTIFICATION_TYPE)
      .eq('recipient_id', host)
      .eq('target_id', input.meeting.channel_id)
      .eq('is_read', false)
      .gt('created_at', new Date(now.getTime() - 10 * 60_000).toISOString())
      .limit(1)
    if (open && open.length > 0) {
      await svc.from('notification').update({ title, metadata: { meeting_id: input.meeting.id, channel_id: input.meeting.channel_id, guest_id: input.guestId } }).eq('id', (open[0] as { id: string }).id)
      return 'renamed'
    }
    const { error } = await svc.from('notification').insert({
      workspace_id: input.meeting.workspace_id,
      recipient_id: host,
      type: MEETING_WAITING_NOTIFICATION_TYPE,
      title,
      body: 'Open the meeting to let them in.',
      target_type: 'team_chat_channel',
      target_id: input.meeting.channel_id,
      context_type: 'team_chat_channel',
      context_id: input.meeting.channel_id,
      group_key: `meeting:${input.meeting.id}`,
      metadata: { meeting_id: input.meeting.id, channel_id: input.meeting.channel_id, guest_id: input.guestId },
    })
    if (error) {
      console.warn(`[meetings] meeting=${input.meeting.id} waiting notice not written:`, error.message)
      return 'skipped'
    }
    return 'sent'
  } catch (err) {
    console.warn(`[meetings] meeting=${input.meeting.id} waiting notice failed:`, err instanceof Error ? err.message : 'unknown')
    return 'skipped'
  }
}
