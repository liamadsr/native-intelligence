/**
 * A meeting's goal (migration 356): what the person wants out of the call,
 * set before it from the prep card's composer (MeetingGoalComposer), the main
 * chat (set_meeting_goal), or during it from the live HUD's goal line. The
 * live agent and the HUD read it by capture once the call starts
 * (findMeetingGoalForCapture).
 *
 * Calendar events are not rows, so a goal is keyed by the meeting itself:
 * (workspace, person, calendar event id, start). The start is part of the key
 * because one id can stand for a whole series (an EventKit event), and it is
 * normalised to one ISO instant (normalizeStartsAt), so "2026-10-17T14:30:00Z",
 * "…14:30:00.000Z" and "…10:30:00-04:00" are the same meeting. An ad-hoc
 * call (a capture with no calendar event) is its own meeting: its goal is kept
 * under a synthetic event id, `capture:<captureId>`, at the capture's start
 * (meetingKeyForCapture), and linked to the capture.
 *
 * A goal is private to the person who set it. Every query here fences on the
 * workspace AND the person as well as RLS, because the chat tool and a desktop
 * device token run on the service role.
 *
 * Client-safe: only a type import, so the composer shares the rules below.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const MEETING_GOAL_MAX_CHARS = 500
/** Where a goal was set (the table's check). */
export const MEETING_GOAL_SOURCES = ['prep_card', 'chat', 'hud'] as const
export type MeetingGoalSource = (typeof MEETING_GOAL_SOURCES)[number]
/** The longest calendar event id kept (the table's check; ids can be long). */
export const MEETING_GOAL_EVENT_ID_MAX = 300

/** The meeting a goal is for: the person's, in a workspace. */
export interface MeetingGoalKey {
  workspaceId: string
  userId: string
  calendarEventId: string
  /** Any parseable instant; normalised with normalizeStartsAt. */
  startsAt: string
}

export interface MeetingGoal {
  id: string
  calendarEventId: string
  /** ISO instant (toISOString). */
  startsAt: string
  captureId: string | null
  goal: string
  source: MeetingGoalSource
  updatedAt: string
}

export type MeetingGoalWriteResult =
  | { ok: true; goal: MeetingGoal }
  | { ok: false; reason: 'empty' | 'too_long' | 'bad_key' | 'error'; message: string }

const COLUMNS = 'id, calendar_event_id, starts_at, capture_id, goal, source, updated_at'
const MEETING_KEY_CONFLICT = 'workspace_id,user_id,calendar_event_id,starts_at'

export function isMeetingGoalSource(v: unknown): v is MeetingGoalSource {
  return typeof v === 'string' && (MEETING_GOAL_SOURCES as readonly string[]).includes(v)
}

/** A start as one ISO instant (ms precision, UTC), or null when unreadable. Pure. */
export function normalizeStartsAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** A calendar event id as kept, or null when missing or too long. Pure. */
export function normalizeEventId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= MEETING_GOAL_EVENT_ID_MAX ? id : null
}

/**
 * The goal's words, trimmed. '' is "no goal" (the callers clear on it);
 * over MEETING_GOAL_MAX_CHARS is refused, never cut. Pure.
 */
export function normalizeGoalText(value: unknown): { ok: true; goal: string } | { ok: false; reason: 'too_long' | 'invalid' } {
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' }
  const goal = value.trim()
  return goal.length > MEETING_GOAL_MAX_CHARS ? { ok: false, reason: 'too_long' } : { ok: true, goal }
}

/** The cache key a meeting goes by on the client (event id and normalised start). Pure. */
export function meetingGoalCacheKey(calendarEventId: string, startsAt: string): string {
  return `${calendarEventId}|${normalizeStartsAt(startsAt) ?? startsAt}`
}

function toGoal(row: Record<string, unknown>): MeetingGoal {
  return {
    id: String(row.id),
    calendarEventId: String(row.calendar_event_id),
    startsAt: normalizeStartsAt(row.starts_at) ?? String(row.starts_at),
    captureId: typeof row.capture_id === 'string' ? row.capture_id : null,
    goal: String(row.goal),
    source: isMeetingGoalSource(row.source) ? row.source : 'prep_card',
    updatedAt: String(row.updated_at),
  }
}

/** The key's columns, normalised; null when the event id or start is unusable. */
function keyColumns(key: MeetingGoalKey) {
  const calendarEventId = normalizeEventId(key.calendarEventId)
  const startsAt = normalizeStartsAt(key.startsAt)
  if (!calendarEventId || !startsAt) return null
  return { workspace_id: key.workspaceId, user_id: key.userId, calendar_event_id: calendarEventId, starts_at: startsAt }
}

/** The person's goal for this meeting, or null. Throws on a failed read. */
export async function getMeetingGoal(sb: SupabaseClient, key: MeetingGoalKey): Promise<MeetingGoal | null> {
  const cols = keyColumns(key)
  if (!cols) return null
  const { data, error } = await sb
    .from('meeting_goal')
    .select(COLUMNS)
    .eq('workspace_id', cols.workspace_id)
    .eq('user_id', cols.user_id)
    .eq('calendar_event_id', cols.calendar_event_id)
    .eq('starts_at', cols.starts_at)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGoal(data as Record<string, unknown>) : null
}

/**
 * Set the person's goal for this meeting (one per meeting: a second write
 * replaces it). `captureId` is written only when given, so a write without one
 * keeps the capture an earlier one linked. An empty goal is refused here: the
 * callers clear instead (clearMeetingGoal).
 */
export async function upsertMeetingGoal(
  sb: SupabaseClient,
  args: MeetingGoalKey & { goal: string; source: MeetingGoalSource; captureId?: string | null },
): Promise<MeetingGoalWriteResult> {
  const cols = keyColumns(args)
  if (!cols) return { ok: false, reason: 'bad_key', message: 'A calendar event id and a start time are required' }
  const text = normalizeGoalText(args.goal)
  if (!text.ok) {
    return text.reason === 'too_long'
      ? { ok: false, reason: 'too_long', message: `A goal is at most ${MEETING_GOAL_MAX_CHARS} characters` }
      : { ok: false, reason: 'empty', message: 'The goal is empty' }
  }
  if (!text.goal) return { ok: false, reason: 'empty', message: 'The goal is empty' }
  const { data, error } = await sb
    .from('meeting_goal')
    .upsert(
      {
        ...cols,
        goal: text.goal,
        source: args.source,
        ...(args.captureId ? { capture_id: args.captureId } : {}),
      },
      { onConflict: MEETING_KEY_CONFLICT },
    )
    .select(COLUMNS)
    .single()
  if (error || !data) return { ok: false, reason: 'error', message: error?.message ?? 'The goal was not saved' }
  return { ok: true, goal: toGoal(data as Record<string, unknown>) }
}

/** Remove the person's goal for this meeting. True when one was there. Throws on a failed write. */
export async function clearMeetingGoal(sb: SupabaseClient, key: MeetingGoalKey): Promise<boolean> {
  const cols = keyColumns(key)
  if (!cols) return false
  const { data, error } = await sb
    .from('meeting_goal')
    .delete()
    .eq('workspace_id', cols.workspace_id)
    .eq('user_id', cols.user_id)
    .eq('calendar_event_id', cols.calendar_event_id)
    .eq('starts_at', cols.starts_at)
    .select('id')
  if (error) throw new Error(error.message)
  return Array.isArray(data) && data.length > 0
}

// ── The meeting a capture stands for ────────────────────────────────────────

/** The synthetic event id an ad-hoc call's goal is kept under: `capture:<captureId>`. */
export const CAPTURE_MEETING_EVENT_PREFIX = 'capture:'

export function captureMeetingEventId(captureId: string): string {
  return `${CAPTURE_MEETING_EVENT_PREFIX}${captureId}`
}

/** A capture row's columns that say which meeting it is. */
export interface CaptureMeetingRow {
  calendar_event_id?: unknown
  occurrence_start?: unknown
  scheduled_start?: unknown
  started_at?: unknown
  created_at?: unknown
}

/**
 * The meeting a goal for this capture is kept under, when no goal is yet:
 * its calendar event at the occurrence's start (else the scheduled start), as
 * findMeetingGoalForCapture looks it up; with no event (or no start for it),
 * the capture's own synthetic meeting (captureMeetingEventId) at the
 * capture's start, else its creation. Null when no start is readable. Pure.
 */
export function meetingKeyForCapture(
  captureId: string,
  row: CaptureMeetingRow | null | undefined,
): { calendarEventId: string; startsAt: string } | null {
  if (!captureId || !row) return null
  const eventId = normalizeEventId(row.calendar_event_id)
  const eventStart = normalizeStartsAt(row.occurrence_start) ?? normalizeStartsAt(row.scheduled_start)
  if (eventId && eventStart) return { calendarEventId: eventId, startsAt: eventStart }
  const ownStart = normalizeStartsAt(row.started_at) ?? normalizeStartsAt(row.created_at)
  return ownStart ? { calendarEventId: captureMeetingEventId(captureId), startsAt: ownStart } : null
}

/**
 * The person's goal for a capture's meeting, or null: the goal linked to the
 * capture, else the one for the capture's calendar event at its start (the
 * occurrence's start, else its scheduled start). A goal set from the chat
 * before the capture existed is found the second way. A capture with no
 * event (an ad-hoc call) looks under its own synthetic meeting
 * (captureMeetingEventId), in case the link was not kept. Throws on a failed
 * read.
 */
export async function findMeetingGoalForCapture(
  sb: SupabaseClient,
  args: { workspaceId: string; userId: string; captureId: string },
): Promise<MeetingGoal | null> {
  const linked = await sb
    .from('meeting_goal')
    .select(COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .eq('capture_id', args.captureId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (linked.error) throw new Error(linked.error.message)
  if (linked.data) return toGoal(linked.data as Record<string, unknown>)

  const capture = await sb
    .from('captures')
    .select('calendar_event_id, occurrence_start, scheduled_start')
    .eq('id', args.captureId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (capture.error) throw new Error(capture.error.message)
  const row = capture.data as CaptureMeetingRow | null
  if (!row) return null
  const calendarEventId = normalizeEventId(row.calendar_event_id)
  const starts = [...new Set([normalizeStartsAt(row.occurrence_start), normalizeStartsAt(row.scheduled_start)].filter((s): s is string => !!s))]
  if (!calendarEventId || !starts.length) {
    // An ad-hoc call: its own synthetic meeting, at whatever start it was kept.
    const own = await sb
      .from('meeting_goal')
      .select(COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('calendar_event_id', captureMeetingEventId(args.captureId))
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (own.error) throw new Error(own.error.message)
    return own.data ? toGoal(own.data as Record<string, unknown>) : null
  }
  const { data, error } = await sb
    .from('meeting_goal')
    .select(COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .eq('calendar_event_id', calendarEventId)
    .in('starts_at', starts)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGoal(data as Record<string, unknown>) : null
}

/**
 * The person's goal for the next occurrence of a calendar event that hasn't
 * started more than `sinceMs` ago (get_meeting_prep with an event id and no
 * start: a provider's instance id names one occurrence anyway). Throws on a
 * failed read.
 */
export async function findUpcomingMeetingGoalForEvent(
  sb: SupabaseClient,
  args: { workspaceId: string; userId: string; calendarEventId: string; sinceMs: number },
): Promise<MeetingGoal | null> {
  const calendarEventId = normalizeEventId(args.calendarEventId)
  if (!calendarEventId) return null
  const { data, error } = await sb
    .from('meeting_goal')
    .select(COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .eq('calendar_event_id', calendarEventId)
    .gte('starts_at', new Date(args.sinceMs).toISOString())
    .order('starts_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGoal(data as Record<string, unknown>) : null
}

// ── A goal changed on this page (the live HUD's Briefing line re-reads) ──────

/** Window event: a meeting's goal was saved or cleared from this page (the prep card's composer, set_meeting_goal's result, the live HUD's goal line). */
export const MEETING_GOAL_CHANGED_EVENT = 'dial8:meeting-goal-changed'

export interface MeetingGoalChangedDetail {
  calendarEventId: string
  startsAt: string
  /** The capture standing for the meeting, when the writer knows it. */
  captureId: string | null
}

/** Say a meeting's goal changed (no-op off the browser). */
export function dispatchMeetingGoalChanged(detail: MeetingGoalChangedDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<MeetingGoalChangedDetail>(MEETING_GOAL_CHANGED_EVENT, { detail }))
}

/**
 * Whether a goal change may be this capture's meeting: its own capture, or a
 * change that names no capture (set_meeting_goal knows only the event and
 * start; a re-read then settles it). Another capture's change is not. Pure.
 */
export function goalChangeMayConcernCapture(detail: unknown, captureId: string): boolean {
  if (!detail || typeof detail !== 'object') return false
  const c = (detail as { captureId?: unknown }).captureId
  return c == null || c === captureId
}
