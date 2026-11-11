/**
 * Team calls' reads and writes (migrations 564-565). Two kinds of caller:
 *
 *   as the person (THEIR Supabase client, under RLS; 565's functions read
 *   auth.uid()): start a call, ring people, answer a ring, read calls;
 *
 *   as the service role: what LiveKit's webhooks say (who joined, who left,
 *   the room finished), a DM hung up, a ring that ran out, the sweeper. These
 *   functions are revoked from every client.
 *
 * A missed ring becomes a notification of the call's message
 * ({@link notifyMissedCalls}): the same `team_chat_message` notification a
 * message is (phase 2, migration 560), so it toasts, raises the desktop
 * banner, opens the conversation on the call when clicked, is read by
 * reading the conversation, and is emailed to someone away by the same
 * batcher. Each throws a TeamChatError on a failed call as the person (the
 * routes turn its code into a status); the service role's throw plain
 * errors (a step retries).
 *
 * Privacy: logs and events carry ids only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TeamChatError, teamChatErrorOf } from '@/lib/team-chat/store'
import { TEAM_CHAT_NOTIFICATION_TYPE } from '@/lib/team-chat/notify'
import { teamChatEmailEvent } from '@/lib/team-chat/email'
import {
  TEAM_CALL_COLUMNS,
  TEAM_CALL_MAX_RING,
  TEAM_CALL_PARTICIPANT_COLUMNS,
  TEAM_CALL_RING_COLUMNS,
  teamCallPlace,
  type TeamCall,
  type TeamCallEndReason,
  type TeamCallParticipant,
  type TeamCallRing,
  type TeamCallRingState,
  type TeamCallView,
} from './types'
import { cancelRingPushes, liveRingPushDeps } from './ring-push'

// ── As the person ───────────────────────────────────────────────────────────

export interface StartedCall {
  callId: string
  room: string
  messageId: string | null
  /** False: a call was live there already, and this is it. */
  created: boolean
}

/** Start a call in a channel or DM the person may post in, or find the one live there (565's team_call_start). */
export async function startCall(supabase: SupabaseClient, channelId: string): Promise<StartedCall> {
  const { data, error } = await supabase.rpc('team_call_start', { ch: channelId })
  if (error) throw teamChatErrorOf(error, 'call start')
  const row = (Array.isArray(data) ? data[0] : data) as { call_id?: string; room?: string; message_id?: string | null; created?: boolean } | undefined
  if (!row?.call_id || !row.room) throw new TeamChatError('failed', 'call start returned no call')
  return { callId: row.call_id, room: row.room, messageId: row.message_id ?? null, created: row.created === true }
}

export interface MadeRing {
  ringId: string
  memberId: string
  userId: string
  state: Extract<TeamCallRingState, 'ringing' | 'busy'>
  expiresAt: string
}

/** Ring members for a call the person may read (565's team_call_ring_members). Returns the rings made. */
export async function ringMembers(supabase: SupabaseClient, callId: string, memberIds: readonly string[]): Promise<MadeRing[]> {
  if (memberIds.length === 0) return []
  if (memberIds.length > TEAM_CALL_MAX_RING) throw new TeamChatError('bad_request', 'ring: too many people')
  const { data, error } = await supabase.rpc('team_call_ring_members', { target_call: callId, members: [...memberIds] })
  if (error) throw teamChatErrorOf(error, 'ring')
  return ((data ?? []) as Array<{ ring_id: string; member_id: string; user_id: string; state: string; expires_at: string }>)
    .filter((r) => r.state === 'ringing' || r.state === 'busy')
    .map((r) => ({ ringId: r.ring_id, memberId: r.member_id, userId: r.user_id, state: r.state as MadeRing['state'], expiresAt: r.expires_at }))
}

/** Answer the person's own ring (565's team_call_answer): its state now (a ring settled elsewhere keeps how it was settled). */
export async function answerRing(supabase: SupabaseClient, ringId: string, accept: boolean): Promise<{ callId: string; state: TeamCallRingState }> {
  const { data, error } = await supabase.rpc('team_call_answer', { target_ring: ringId, accept })
  if (error) throw teamChatErrorOf(error, 'answer')
  const row = (Array.isArray(data) ? data[0] : data) as { call_id?: string; state?: TeamCallRingState } | undefined
  if (!row?.call_id || !row.state) throw new TeamChatError('failed', 'answer returned nothing')
  return { callId: row.call_id, state: row.state }
}

/** A call the person may read, with its channel's workspace and kind, or null. */
export async function getCall(
  supabase: SupabaseClient,
  callId: string,
): Promise<(TeamCall & { room: string; workspace_id: string; channel_kind: 'channel' | 'dm'; channel_archived: boolean }) | null> {
  const { data, error } = await supabase
    .from('team_call')
    .select(`${TEAM_CALL_COLUMNS}, room, workspace_id`)
    .eq('id', callId)
    .maybeSingle<TeamCall & { room: string; workspace_id: string }>()
  if (error) throw teamChatErrorOf(error, 'call read')
  if (!data) return null
  const { data: channel, error: channelError } = await supabase
    .from('team_chat_channel')
    .select('kind, archived_at')
    .eq('id', data.channel_id)
    .maybeSingle<{ kind: 'channel' | 'dm'; archived_at: string | null }>()
  if (channelError) throw teamChatErrorOf(channelError, 'call channel read')
  if (!channel) return null
  return { ...data, ringing: data.ringing ?? [], declined: data.declined ?? [], channel_kind: channel.kind, channel_archived: !!channel.archived_at }
}

/** The calls these messages show, with who is in them (a page of a conversation). */
export async function callViews(supabase: SupabaseClient, callIds: readonly string[]): Promise<TeamCallView[]> {
  const ids = [...new Set(callIds)]
  if (ids.length === 0) return []
  const [calls, people] = await Promise.all([
    supabase.from('team_call').select(TEAM_CALL_COLUMNS).in('id', ids),
    supabase.from('team_call_participant').select(TEAM_CALL_PARTICIPANT_COLUMNS).in('call_id', ids),
  ])
  if (calls.error) throw teamChatErrorOf(calls.error, 'calls read')
  if (people.error) throw teamChatErrorOf(people.error, 'call people read')
  const byCall = new Map<string, TeamCallParticipant[]>()
  for (const p of (people.data ?? []) as TeamCallParticipant[]) byCall.set(p.call_id, [...(byCall.get(p.call_id) ?? []), p])
  return ((calls.data ?? []) as TeamCall[]).map((call) => ({
    call: { ...call, ringing: call.ringing ?? [], declined: call.declined ?? [] },
    participants: byCall.get(call.id) ?? [],
  }))
}

/** The person's rings still open (an app opening mid-ring draws it). */
export async function openRings(supabase: SupabaseClient, now: Date = new Date()): Promise<TeamCallRing[]> {
  const { data, error } = await supabase
    .from('team_call_ring')
    .select(TEAM_CALL_RING_COLUMNS)
    .in('state', ['ringing', 'busy'])
    .gt('expires_at', now.toISOString())
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) throw teamChatErrorOf(error, 'rings read')
  return (data ?? []) as TeamCallRing[]
}

// ── As the service role ─────────────────────────────────────────────────────

export type ParticipantOutcome = 'joined' | 'left' | 'same' | 'stale' | 'ended' | 'unknown' | 'ejected'

/** A LiveKit participant event, applied in order of the sessions' joins (565's team_call_participant_event). */
export async function participantEvent(
  svc: SupabaseClient,
  input: { room: string; memberId: string; sid: string | null; joined: boolean; at: string; sessionJoinedAt: string | null },
): Promise<ParticipantOutcome> {
  const { data, error } = await svc.rpc('team_call_participant_event', {
    room_name: input.room,
    member_ref: input.memberId,
    session_ref: input.sid,
    is_join: input.joined,
    event_at: input.at,
    session_joined_at: input.sessionJoinedAt,
  })
  if (error) throw new Error(`team calls: participant event failed: ${error.message}`)
  return (data as ParticipantOutcome) ?? 'unknown'
}

/** One ring that ended unanswered, with what its notification says. */
export interface MissedRing {
  ring_id: string
  call_id: string
  message_id: string | null
  workspace_id: string
  channel_id: string
  channel_kind: 'channel' | 'dm'
  channel_name: string | null
  member_id: string
  user_id: string
  caller_member_id: string | null
  caller_name: string
}

/**
 * End a call, once (565's team_call_end). Returns its rings that were still
 * open: missed. The phones still ringing for them are stopped (./ring-push.ts:
 * each ring's cancel, once, when it was pushed), started here and never
 * waited on: a slow Apple never holds a hang-up or a webhook.
 */
export async function endCall(
  svc: SupabaseClient,
  callId: string,
  reason: TeamCallEndReason,
  at: Date = new Date(),
  stopPhones: (ringIds: string[]) => Promise<unknown> = (ringIds) => cancelRingPushes(liveRingPushDeps(svc), { ringIds }),
): Promise<MissedRing[]> {
  const { data, error } = await svc.rpc('team_call_end', { target_call: callId, end_reason: reason, end_at: at.toISOString() })
  if (error) throw new Error(`team calls: end failed: ${error.message}`)
  const missed = (data ?? []) as MissedRing[]
  if (missed.length > 0) void stopPhones(missed.map((r) => r.ring_id)).catch(() => undefined)
  return missed
}

/** Rings past their time are missed (565's team_call_expire_rings): just this one, or all. */
export async function expireRings(svc: SupabaseClient, ringId: string | null = null): Promise<MissedRing[]> {
  const { data, error } = await svc.rpc('team_call_expire_rings', { only_ring: ringId })
  if (error) throw new Error(`team calls: expire failed: ${error.message}`)
  return (data ?? []) as MissedRing[]
}

/** A live call by its room (the webhook's word), or null. */
export async function liveCallOfRoom(svc: SupabaseClient, room: string): Promise<{ id: string } | null> {
  const { data, error } = await svc.from('team_call').select('id').eq('room', room).eq('status', 'live').maybeSingle<{ id: string }>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  return data ?? null
}

/**
 * A missed call's notification title: "Missed call from Ana Ruiz", "… in
 * #launch". Its line is the call's message as it is now (560's trigger
 * writes a team chat notification's body from its message, and keeps it
 * following the message): "Started a call", then how the call went.
 */
export function missedCallTitle(ring: Pick<MissedRing, 'caller_name' | 'channel_kind' | 'channel_name'>): string {
  const who = ring.caller_name.trim() || 'a teammate'
  const place = teamCallPlace(ring)
  return place ? `Missed call from ${who} in ${place}` : `Missed call from ${who}`
}

type SendEvents = (events: Array<ReturnType<typeof teamChatEmailEvent>>) => Promise<unknown>

async function sendEvents(events: Array<ReturnType<typeof teamChatEmailEvent>>, send?: SendEvents): Promise<void> {
  if (events.length === 0) return
  if (send) {
    await send(events)
    return
  }
  const { inngest } = await import('@/lib/inngest/client')
  await inngest.send(events)
}

/**
 * Tell each person a ring missed: one `team_chat_message` notification of
 * the call's message (written, or the one they had for it turned into the
 * missed call and unread again), then the email batcher. Once per ring: a
 * ring whose person was told already (team_call_ring.notified_at) is
 * skipped, and each one told is marked, so a retry, a second event or the
 * sweeper's backlog never tells anyone twice. Never throws for one person
 * (logged); throws when nothing could be written (a step retries).
 */
export async function notifyMissedCalls(svc: SupabaseClient, missed: readonly MissedRing[], send?: SendEvents): Promise<number> {
  let told = 0
  const emails: Array<ReturnType<typeof teamChatEmailEvent>> = []
  let failures = 0
  const ids = [...new Set(missed.map((r) => r.ring_id))]
  if (ids.length === 0) return 0
  const { data: untold, error: readError } = await svc.from('team_call_ring').select('id').in('id', ids).is('notified_at', null)
  if (readError) throw new Error(`team calls: rings read failed: ${readError.message}`)
  const open = new Set(((untold ?? []) as Array<{ id: string }>).map((r) => r.id))
  for (const ring of missed) {
    if (!open.has(ring.ring_id)) continue
    open.delete(ring.ring_id)
    if (!ring.message_id) continue
    const title = missedCallTitle(ring)
    const groupKey = `team_chat:${ring.channel_id}`
    const place = teamCallPlace(ring)
    const row = {
      workspace_id: ring.workspace_id,
      recipient_id: ring.member_id,
      type: TEAM_CHAT_NOTIFICATION_TYPE,
      title,
      actor_id: ring.caller_member_id,
      target_type: 'team_chat_message',
      target_id: ring.message_id,
      context_type: 'team_chat_channel',
      context_id: ring.channel_id,
      group_key: groupKey,
      metadata: {
        channel_id: ring.channel_id,
        message_id: ring.message_id,
        thread_root_id: null,
        channel_kind: ring.channel_kind,
        reason: 'missed_call',
        call_id: ring.call_id,
        author_name: ring.caller_name,
        place,
      },
    }
    const { error } = await svc.from('notification').insert(row)
    if (error?.code === '23505') {
      // They had one for this call's message (a channel set to all): it is the missed call now.
      const { error: again } = await svc
        .from('notification')
        .update({ title: row.title, metadata: row.metadata, is_read: false, read_at: null })
        .eq('type', TEAM_CHAT_NOTIFICATION_TYPE)
        .eq('recipient_id', ring.member_id)
        .eq('target_id', ring.message_id)
      if (again) {
        failures++
        console.warn(`[team-calls] ring=${ring.ring_id} missed call not written:`, again.message)
        continue
      }
    } else if (error) {
      failures++
      console.warn(`[team-calls] ring=${ring.ring_id} missed call not written:`, error.message)
      continue
    }
    told++
    await svc.from('team_call_ring').update({ notified_at: new Date().toISOString() }).eq('id', ring.ring_id)
    emails.push(teamChatEmailEvent({ userId: ring.user_id, workspaceId: ring.workspace_id }))
  }
  if (failures > 0 && told === 0) throw new Error(`team calls: no missed call written (${failures} failed)`)
  try {
    await sendEvents(emails, send)
  } catch (err) {
    console.warn('[team-calls] missed call emails not requested:', err instanceof Error ? err.message : 'unknown')
  }
  return told
}

const MISSED_RING_COLUMNS = 'id, call_id, workspace_id, channel_id, channel_kind, channel_name, member_id, user_id, caller_member_id, caller_name'

async function asMissed(svc: SupabaseClient, rows: Array<Record<string, unknown>>): Promise<MissedRing[]> {
  if (rows.length === 0) return []
  const callIds = [...new Set(rows.map((r) => String(r.call_id)))]
  const { data: calls, error } = await svc.from('team_call').select('id, message_id').in('id', callIds)
  if (error) throw new Error(`team calls: calls read failed: ${error.message}`)
  const messageOf = new Map(((calls ?? []) as Array<{ id: string; message_id: string | null }>).map((c) => [c.id, c.message_id]))
  return rows.map((r) => ({
    ring_id: String(r.id),
    call_id: String(r.call_id),
    message_id: messageOf.get(String(r.call_id)) ?? null,
    workspace_id: String(r.workspace_id),
    channel_id: String(r.channel_id),
    channel_kind: r.channel_kind as MissedRing['channel_kind'],
    channel_name: (r.channel_name as string | null) ?? null,
    member_id: String(r.member_id),
    user_id: String(r.user_id),
    caller_member_id: (r.caller_member_id as string | null) ?? null,
    caller_name: String(r.caller_name ?? ''),
  }))
}

/** These rings, if missed and their person not told yet. */
export async function untoldMissedRings(svc: SupabaseClient, ringIds: readonly string[]): Promise<MissedRing[]> {
  if (ringIds.length === 0) return []
  const { data, error } = await svc.from('team_call_ring').select(MISSED_RING_COLUMNS).in('id', [...ringIds]).eq('state', 'missed').is('notified_at', null)
  if (error) throw new Error(`team calls: rings read failed: ${error.message}`)
  return asMissed(svc, (data ?? []) as Array<Record<string, unknown>>)
}

/** The sweeper's backlog: missed rings nobody was told about (a notice that failed), older than a moment, within a day. */
export async function missedRingsNobodyWasToldOf(svc: SupabaseClient, now: Date = new Date()): Promise<MissedRing[]> {
  const { data, error } = await svc
    .from('team_call_ring')
    .select(MISSED_RING_COLUMNS)
    .eq('state', 'missed')
    .is('notified_at', null)
    .lt('created_at', new Date(now.getTime() - 2 * 60_000).toISOString())
    .gt('created_at', new Date(now.getTime() - 24 * 60 * 60_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) throw new Error(`team calls: missed rings read failed: ${error.message}`)
  return asMissed(svc, (data ?? []) as Array<Record<string, unknown>>)
}

// ── Missed-call notices, through Inngest ────────────────────────────────────

export const TEAM_CALL_MISSED_EVENT = 'team-calls/missed.requested' as const

/** The event that tells one missed ring's person (its id is the ring's: one notice however often asked). */
export function teamCallMissedEvent(ringId: string) {
  return { name: TEAM_CALL_MISSED_EVENT, id: `team-call-missed-${ringId}`, data: { ringId } }
}

/**
 * Ask for these missed rings' notices (after a call ended, out of the
 * request path). Never throws: a notice not asked for is found by the
 * sweeper (notified_at still empty).
 */
export async function requestMissedNotices(missed: readonly Pick<MissedRing, 'ring_id'>[], send?: (events: Array<ReturnType<typeof teamCallMissedEvent>>) => Promise<unknown>): Promise<void> {
  if (missed.length === 0) return
  const events = [...new Set(missed.map((r) => r.ring_id))].map(teamCallMissedEvent)
  try {
    if (send) await send(events)
    else {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send(events)
    }
  } catch (err) {
    console.warn(`[team-calls] missed call notices not requested (${events.length}):`, err instanceof Error ? err.message : 'unknown')
  }
}

/** The sweeper's check: everyone connected to a live call who may no longer read its conversation, marked left and put on the eject outbox (565's team_call_fence). */
export async function fenceTeamCalls(svc: SupabaseClient): Promise<number> {
  const { data, error } = await svc.rpc('team_call_fence', { only_member: null, only_channel: null })
  if (error) throw new Error(`team calls: fence failed: ${error.message}`)
  return Array.isArray(data) ? data.length : 0
}

// ── The ring's timer ────────────────────────────────────────────────────────

export const TEAM_CALL_RING_EVENT = 'team-calls/ring.started' as const

/** The event that runs a ring's timer (its id dedupes a retried request). */
export function teamCallRingEvent(ring: Pick<MadeRing, 'ringId' | 'expiresAt'>) {
  return { name: TEAM_CALL_RING_EVENT, id: `team-call-ring-${ring.ringId}`, data: { ringId: ring.ringId, expiresAt: ring.expiresAt } }
}

/** Start the timers of new rings. Never throws: the sweeper misses a ring a lost timer left (logged). */
export async function requestRingTimers(rings: readonly MadeRing[], send?: (events: Array<ReturnType<typeof teamCallRingEvent>>) => Promise<unknown>): Promise<void> {
  if (rings.length === 0) return
  const events = rings.map(teamCallRingEvent)
  try {
    if (send) await send(events)
    else {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send(events)
    }
  } catch (err) {
    console.warn(`[team-calls] ring timers not requested (${rings.length}):`, err instanceof Error ? err.message : 'unknown')
  }
}
