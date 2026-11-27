/**
 * The meeting agent's rows (migration 723, meeting_attendance). One per person
 * per meeting (calendar event id and start, as 356's meeting_goal). Every read
 * and write here runs on the service role and fences on the workspace AND the
 * person, as well as RLS for a signed-in client.
 *
 * Status, in order: draft (a brief not approved yet) → scheduled (approved,
 * waiting for the start) → dialling (Twilio is calling the meeting) →
 * in_meeting (OpenAI answered with our token) → ended, or objected (someone
 * objected and it left), failed (it never got in), cancelled (the person
 * called it off).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { EMPTY_BRIEF, parseBrief, type MeetingBrief } from './brief'

export const MEETING_ATTENDANCE_TABLE = 'meeting_attendance'

export const ATTENDANCE_STATUSES = ['draft', 'scheduled', 'dialling', 'in_meeting', 'ended', 'cancelled', 'failed', 'objected'] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

/** The states a meeting is over in: nothing dials or answers again. */
export const FINAL_STATUSES: ReadonlySet<AttendanceStatus> = new Set(['ended', 'cancelled', 'failed', 'objected'])

export interface MeetingAsk {
  at: string
  question: string
  messageId: string
}

export interface MeetingAttendance {
  id: string
  workspaceId: string
  userId: string
  calendarEventId: string
  startsAt: string
  endsAt: string | null
  title: string
  status: AttendanceStatus
  statusDetail: string | null
  dialInNumber: string | null
  dialInPin: string | null
  brief: MeetingBrief
  briefApprovedAt: string | null
  displayName: string
  ownerFirstName: string
  captureId: string | null
  liveSessionId: string | null
  twilioCallSid: string | null
  asks: MeetingAsk[]
  joinedAt: string | null
  leftAt: string | null
}

export const ATTENDANCE_COLUMNS =
  'id, workspace_id, user_id, calendar_event_id, starts_at, ends_at, title, status, status_detail, dial_in_number, dial_in_pin, brief, brief_approved_at, display_name, owner_first_name, capture_id, live_session_id, twilio_call_sid, asks, joined_at, left_at'

interface Row {
  id: string
  workspace_id: string
  user_id: string
  calendar_event_id: string
  starts_at: string
  ends_at: string | null
  title: string | null
  status: string
  status_detail: string | null
  dial_in_number: string | null
  dial_in_pin: string | null
  brief: unknown
  brief_approved_at: string | null
  display_name: string
  owner_first_name: string
  capture_id: string | null
  live_session_id: string | null
  twilio_call_sid: string | null
  asks: unknown
  joined_at: string | null
  left_at: string | null
}

function asks(raw: unknown): MeetingAsk[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((a) => {
    const r = a as Record<string, unknown>
    return typeof r?.at === 'string' && typeof r?.question === 'string' && typeof r?.message_id === 'string' ? [{ at: r.at, question: r.question, messageId: r.message_id }] : []
  })
}

export function attendanceOfRow(row: Row): MeetingAttendance {
  const parsed = parseBrief(row.brief)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    calendarEventId: row.calendar_event_id,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    title: row.title ?? '',
    status: (ATTENDANCE_STATUSES as readonly string[]).includes(row.status) ? (row.status as AttendanceStatus) : 'failed',
    statusDetail: row.status_detail,
    dialInNumber: row.dial_in_number,
    dialInPin: row.dial_in_pin,
    brief: parsed.ok ? parsed.brief : EMPTY_BRIEF,
    briefApprovedAt: row.brief_approved_at,
    displayName: row.display_name,
    ownerFirstName: row.owner_first_name,
    captureId: row.capture_id,
    liveSessionId: row.live_session_id,
    twilioCallSid: row.twilio_call_sid,
    asks: asks(row.asks),
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  }
}

/** The person's view of one: everything but the PIN. */
export function publicAttendance(a: MeetingAttendance): Omit<MeetingAttendance, 'dialInPin'> & { hasPin: boolean } {
  const { dialInPin, ...rest } = a
  return { ...rest, hasPin: !!dialInPin }
}

export interface SendInput {
  workspaceId: string
  userId: string
  calendarEventId: string
  startsAt: string
  endsAt: string | null
  title: string
  dialInNumber: string
  dialInPin: string
  brief: MeetingBrief
  displayName: string
  ownerFirstName: string
  captureId: string | null
  /** The series that sent it (727's series_ref); only written when set, so a write works before 727. */
  seriesRef?: string | null
}

/**
 * Send the agent to a meeting with an approved brief: the row is made (or a
 * draft, a cancelled or a failed one for the same meeting is made ready
 * again) as `scheduled`. A meeting it's already in, or dialling, is left
 * alone: 'busy'.
 */
export async function scheduleAttendance(svc: SupabaseClient, input: SendInput, now: Date = new Date()): Promise<{ ok: true; attendance: MeetingAttendance } | { ok: false; reason: 'busy' | 'error'; message: string }> {
  const key = { workspace_id: input.workspaceId, user_id: input.userId, calendar_event_id: input.calendarEventId, starts_at: input.startsAt }
  const { data: existing, error: readError } = await svc.from(MEETING_ATTENDANCE_TABLE).select('id, status').match(key).maybeSingle<{ id: string; status: string }>()
  if (readError) return { ok: false, reason: 'error', message: readError.message }
  if (existing && (existing.status === 'dialling' || existing.status === 'in_meeting')) return { ok: false, reason: 'busy', message: 'Your assistant is already in this meeting.' }
  const fields = {
    ...key,
    ends_at: input.endsAt,
    title: input.title.slice(0, 300),
    status: 'scheduled',
    status_detail: null,
    status_at: now.toISOString(),
    join_method: 'dial_in',
    dial_in_number: input.dialInNumber,
    dial_in_pin: input.dialInPin,
    brief: input.brief,
    brief_approved_at: now.toISOString(),
    display_name: input.displayName,
    owner_first_name: input.ownerFirstName,
    capture_id: input.captureId,
    join_token_hash: null,
    live_session_id: null,
    twilio_call_sid: null,
    ...(input.seriesRef ? { series_ref: input.seriesRef } : {}),
  }
  const write = existing
    ? svc.from(MEETING_ATTENDANCE_TABLE).update(fields).eq('id', existing.id).eq('user_id', input.userId).select(ATTENDANCE_COLUMNS).single<Row>()
    : svc.from(MEETING_ATTENDANCE_TABLE).insert(fields).select(ATTENDANCE_COLUMNS).single<Row>()
  const { data, error } = await write
  if (error || !data) return { ok: false, reason: 'error', message: error?.message ?? 'not written' }
  return { ok: true, attendance: attendanceOfRow(data) }
}

/** One of the person's, or null. */
export async function getAttendance(svc: SupabaseClient, scope: { workspaceId: string; userId: string; id: string }): Promise<MeetingAttendance | null> {
  const { data, error } = await svc.from(MEETING_ATTENDANCE_TABLE).select(ATTENDANCE_COLUMNS).eq('id', scope.id).eq('workspace_id', scope.workspaceId).eq('user_id', scope.userId).maybeSingle<Row>()
  if (error) throw new Error(`meeting agent: read failed: ${error.message}`)
  return data ? attendanceOfRow(data) : null
}

/** One by id alone, for the server's own steps (the dial, the status webhook). */
export async function getAttendanceById(svc: SupabaseClient, id: string): Promise<MeetingAttendance | null> {
  const { data, error } = await svc.from(MEETING_ATTENDANCE_TABLE).select(ATTENDANCE_COLUMNS).eq('id', id).maybeSingle<Row>()
  if (error) throw new Error(`meeting agent: read failed: ${error.message}`)
  return data ? attendanceOfRow(data) : null
}

/** The person's from `since` on, soonest first. */
export async function listAttendances(svc: SupabaseClient, scope: { workspaceId: string; userId: string; since: string }): Promise<MeetingAttendance[]> {
  const { data, error } = await svc
    .from(MEETING_ATTENDANCE_TABLE)
    .select(ATTENDANCE_COLUMNS)
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .gte('starts_at', scope.since)
    .order('starts_at', { ascending: true })
    .limit(50)
  if (error) throw new Error(`meeting agent: list failed: ${error.message}`)
  return ((data ?? []) as Row[]).map(attendanceOfRow)
}

/**
 * Move one from any of `from` to `to` (a compare-and-set: two steps racing
 * can't both move it). The updated row, or null when it wasn't in `from`.
 */
export async function moveAttendance(
  svc: SupabaseClient,
  id: string,
  from: readonly AttendanceStatus[],
  to: AttendanceStatus,
  extra: Record<string, unknown> = {},
  now: Date = new Date(),
): Promise<MeetingAttendance | null> {
  const { data, error } = await svc
    .from(MEETING_ATTENDANCE_TABLE)
    .update({ status: to, status_at: now.toISOString(), ...extra })
    .eq('id', id)
    .in('status', [...from])
    .select(ATTENDANCE_COLUMNS)
    .maybeSingle<Row>()
  if (error) throw new Error(`meeting agent: move to ${to} failed: ${error.message}`)
  return data ? attendanceOfRow(data) : null
}

/**
 * The webhook's match: the attendance dialling with this token's hash. The
 * hash is cleared in the same write, so a replayed or second call with the
 * same token finds nothing.
 */
export async function claimByJoinToken(svc: SupabaseClient, tokenHash: string, liveSessionId: string, now: Date = new Date()): Promise<MeetingAttendance | null> {
  const { data, error } = await svc
    .from(MEETING_ATTENDANCE_TABLE)
    .update({ status: 'in_meeting', status_at: now.toISOString(), status_detail: null, join_token_hash: null, live_session_id: liveSessionId, joined_at: now.toISOString() })
    .eq('join_token_hash', tokenHash)
    .eq('status', 'dialling')
    .select(ATTENDANCE_COLUMNS)
    .maybeSingle<Row>()
  if (error) throw new Error(`meeting agent: token claim failed: ${error.message}`)
  return data ? attendanceOfRow(data) : null
}

/** Record one question put to the person (appended, read-modify-write: one bridge writes per attendance). */
export async function recordAsk(svc: SupabaseClient, id: string, ask: MeetingAsk): Promise<void> {
  const { data } = await svc.from(MEETING_ATTENDANCE_TABLE).select('asks').eq('id', id).maybeSingle<{ asks: unknown }>()
  const list = Array.isArray(data?.asks) ? (data!.asks as unknown[]) : []
  await svc
    .from(MEETING_ATTENDANCE_TABLE)
    .update({ asks: [...list, { at: ask.at, question: ask.question, message_id: ask.messageId }].slice(-50) })
    .eq('id', id)
}

/** Stamp a moment of the call (announced_at, objected_at). */
export async function stampAttendance(svc: SupabaseClient, id: string, column: 'announced_at' | 'objected_at', now: Date = new Date()): Promise<void> {
  await svc.from(MEETING_ATTENDANCE_TABLE).update({ [column]: now.toISOString() }).eq('id', id)
}
