/**
 * Your agent attends a recurring meeting for you (roadmap #12 phase 2,
 * migration 727; docs/plans/agent-joins-meetings.md §2). Liam's rule for the
 * feature (11-27, via the plan): "The person opts in per meeting, or per
 * recurring meeting, explicitly."
 *
 * The person approves one brief for a series (the chat tool's card, or the
 * app's Send with "every occurrence"). From then on a sweep
 * (src/lib/inngest/meeting-agent.ts, every 30 minutes) looks a day and a half
 * ahead on their calendar and sends the agent to each occurrence of that
 * series it hasn't seen yet, with that brief, through the same send as a
 * single meeting (./send.ts: the same checks, the same dial at the start).
 *
 *   - "Skip this one" is a cancel of that occurrence (DELETE ?id): the row
 *     stays cancelled, and the sweep never sends a meeting that already has a
 *     row, whatever its status.
 *   - Pausing the series stops the sweep; occurrences already scheduled stay
 *     (each can be cancelled). Removing it cancels the ones it scheduled that
 *     haven't started.
 *   - An occurrence with no dial-in on its invite (and none the person gave
 *     for the series) is skipped and logged, never guessed.
 *
 * Every read and write fences on the workspace and the person.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listCalendarEventsUnified, type CalendarEvent } from '@/lib/integrations/calendar'
import { EMPTY_BRIEF, parseBrief, type MeetingBrief } from './brief'
import { dialInOfEvent, isDialDigits } from './dial-in'
import { sendAgentToMeeting, type SendDeps } from './send'
import { MEETING_ATTENDANCE_TABLE } from './store'

export const MEETING_SERIES_TABLE = 'meeting_attendance_series'

/** How far ahead the sweep sends occurrences. */
export const SERIES_LOOKAHEAD_MS = 36 * 60 * 60_000
/** An occurrence starting sooner than this is left alone (the dial's lead and a margin). */
export const SERIES_MIN_LEAD_MS = 5 * 60_000
/** The most series one sweep reads. */
export const SERIES_SWEEP_MAX = 200

export interface MeetingSeries {
  id: string
  workspaceId: string
  userId: string
  seriesId: string
  title: string
  brief: MeetingBrief
  dialInNumber: string | null
  dialInPin: string | null
  pausedAt: string | null
}

export const SERIES_COLUMNS = 'id, workspace_id, user_id, series_id, title, brief, dial_in_number, dial_in_pin, paused_at'

interface SeriesRow {
  id: string
  workspace_id: string
  user_id: string
  series_id: string
  title: string | null
  brief: unknown
  dial_in_number: string | null
  dial_in_pin: string | null
  paused_at: string | null
}

export function seriesOfRow(row: SeriesRow): MeetingSeries {
  const parsed = parseBrief(row.brief)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    seriesId: row.series_id,
    title: row.title ?? '',
    brief: parsed.ok ? parsed.brief : EMPTY_BRIEF,
    dialInNumber: row.dial_in_number,
    dialInPin: row.dial_in_pin,
    pausedAt: row.paused_at,
  }
}

/** The person's view of one: everything but the PIN. */
export function publicSeries(s: MeetingSeries): Omit<MeetingSeries, 'dialInPin'> & { hasPin: boolean } {
  const { dialInPin, ...rest } = s
  return { ...rest, hasPin: !!dialInPin }
}

/** The series an event belongs to, or null for a one-off. Pure. */
export function seriesIdOf(event: Pick<CalendarEvent, 'seriesMasterId'>): string | null {
  const id = event.seriesMasterId?.trim()
  return id && id.length <= 300 ? id : null
}

/** Save (or update, and turn back on) the person's series with this approved brief. Throws on a failed write. */
export async function saveSeries(
  svc: SupabaseClient,
  input: { workspaceId: string; userId: string; seriesId: string; title: string; brief: MeetingBrief; dialIn?: { number: string; digits: string } | null },
  now: Date = new Date(),
): Promise<MeetingSeries> {
  const key = { workspace_id: input.workspaceId, user_id: input.userId, series_id: input.seriesId }
  const fields = {
    ...key,
    title: input.title.slice(0, 300),
    brief: input.brief,
    brief_approved_at: now.toISOString(),
    dial_in_number: input.dialIn?.number ?? null,
    dial_in_pin: input.dialIn?.digits ?? null,
    paused_at: null,
  }
  const { data: existing } = await svc.from(MEETING_SERIES_TABLE).select('id').match(key).maybeSingle<{ id: string }>()
  const write = existing
    ? svc.from(MEETING_SERIES_TABLE).update(fields).eq('id', existing.id).eq('user_id', input.userId).select(SERIES_COLUMNS).single<SeriesRow>()
    : svc.from(MEETING_SERIES_TABLE).insert(fields).select(SERIES_COLUMNS).single<SeriesRow>()
  const { data, error } = await write
  if (error || !data) throw new Error(`meeting agent: series not saved: ${error?.message ?? 'no row'}`)
  return seriesOfRow(data)
}

/** The person's series. */
export async function listSeries(svc: SupabaseClient, scope: { workspaceId: string; userId: string }): Promise<MeetingSeries[]> {
  const { data, error } = await svc.from(MEETING_SERIES_TABLE).select(SERIES_COLUMNS).eq('workspace_id', scope.workspaceId).eq('user_id', scope.userId).limit(50)
  if (error) throw new Error(`meeting agent: series read failed: ${error.message}`)
  return ((data ?? []) as SeriesRow[]).map(seriesOfRow)
}

/** Pause (or turn back on) one of the person's series. Whether it was theirs. */
export async function pauseSeries(svc: SupabaseClient, scope: { workspaceId: string; userId: string; id: string }, paused: boolean, now: Date = new Date()): Promise<boolean> {
  const { data, error } = await svc
    .from(MEETING_SERIES_TABLE)
    .update({ paused_at: paused ? now.toISOString() : null })
    .eq('id', scope.id)
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .select('id')
    .maybeSingle<{ id: string }>()
  if (error) throw new Error(`meeting agent: series not changed: ${error.message}`)
  return !!data
}

/**
 * Remove one of the person's series: the occurrences it scheduled that
 * haven't started are cancelled first (an occurrence already dialling or in
 * its meeting is left to finish). Whether it was theirs.
 */
export async function removeSeries(svc: SupabaseClient, scope: { workspaceId: string; userId: string; id: string }, now: Date = new Date()): Promise<boolean> {
  const { data: own } = await svc.from(MEETING_SERIES_TABLE).select('id').eq('id', scope.id).eq('workspace_id', scope.workspaceId).eq('user_id', scope.userId).maybeSingle<{ id: string }>()
  if (!own) return false
  await svc
    .from(MEETING_ATTENDANCE_TABLE)
    .update({ status: 'cancelled', status_detail: 'series_removed', status_at: now.toISOString() })
    .eq('series_ref', scope.id)
    .eq('user_id', scope.userId)
    .in('status', ['draft', 'scheduled'])
  const { error } = await svc.from(MEETING_SERIES_TABLE).delete().eq('id', scope.id).eq('user_id', scope.userId)
  if (error) throw new Error(`meeting agent: series not removed: ${error.message}`)
  return true
}

export interface SweepDeps {
  list?: typeof listCalendarEventsUnified
  send?: typeof sendAgentToMeeting
  sendDeps?: SendDeps
  now?: () => number
}

export interface SweepSummary {
  series: number
  sent: number
  known: number
  noDialIn: number
  failed: number
}

/** Whether the person has a row (any status) for this occurrence already. */
async function occurrenceKnown(svc: SupabaseClient, s: MeetingSeries, event: CalendarEvent): Promise<boolean> {
  const { data, error } = await svc
    .from(MEETING_ATTENDANCE_TABLE)
    .select('id')
    .eq('workspace_id', s.workspaceId)
    .eq('user_id', s.userId)
    .eq('calendar_event_id', event.id)
    .eq('starts_at', new Date(Date.parse(event.start)).toISOString())
    .maybeSingle<{ id: string }>()
  if (error) throw new Error(`meeting agent: occurrence read failed: ${error.message}`)
  return !!data
}

/**
 * Send the agent to every occurrence of every series that's on, a day and a
 * half ahead, that has no row yet. Never throws for one person's calendar or
 * one occurrence; throws only when the series can't be read (the step retries).
 */
export async function sweepSeries(svc: SupabaseClient, deps: SweepDeps = {}): Promise<SweepSummary> {
  const now = (deps.now ?? Date.now)()
  const summary: SweepSummary = { series: 0, sent: 0, known: 0, noDialIn: 0, failed: 0 }
  const { data, error } = await svc.from(MEETING_SERIES_TABLE).select(SERIES_COLUMNS).is('paused_at', null).order('created_at', { ascending: true }).limit(SERIES_SWEEP_MAX)
  if (error) throw new Error(`meeting agent: series read failed: ${error.message}`)
  const all = ((data ?? []) as SeriesRow[]).map(seriesOfRow)
  summary.series = all.length
  const byUser = new Map<string, MeetingSeries[]>()
  for (const s of all) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s])

  for (const [userId, series] of byUser) {
    let events: CalendarEvent[]
    try {
      events = await (deps.list ?? listCalendarEventsUnified)(userId, {
        timeMin: new Date(now + SERIES_MIN_LEAD_MS).toISOString(),
        timeMax: new Date(now + SERIES_LOOKAHEAD_MS).toISOString(),
      })
    } catch (err) {
      summary.failed++
      console.warn(`[meeting-agent] series sweep: a calendar could not be read: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    for (const s of series) {
      for (const event of events) {
        if (seriesIdOf(event) !== s.seriesId || event.status === 'cancelled') continue
        const start = Date.parse(event.start)
        if (!Number.isFinite(start) || start < now + SERIES_MIN_LEAD_MS) continue
        try {
          if (await occurrenceKnown(svc, s, event)) {
            summary.known++
            continue
          }
          const own = s.dialInNumber && isDialDigits(s.dialInPin) ? { number: s.dialInNumber, digits: s.dialInPin! } : null
          const dialIn = own ?? dialInOfEvent(event)
          if (!dialIn) {
            summary.noDialIn++
            console.info(`[meeting-agent] series=${s.id} occurrence skipped: no dial-in on its invite`)
            continue
          }
          const sent = await (deps.send ?? sendAgentToMeeting)(
            svc,
            { workspaceId: s.workspaceId, userId: s.userId, calendarEventId: event.id, startsAt: event.start, endsAt: event.end || null, title: event.title, dialIn, brief: s.brief, seriesRef: s.id },
            deps.sendDeps,
          )
          if (sent.ok) summary.sent++
          else {
            summary.failed++
            console.info(`[meeting-agent] series=${s.id} occurrence not sent: ${sent.reason}`)
          }
        } catch (err) {
          summary.failed++
          console.warn(`[meeting-agent] series=${s.id} occurrence failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }
  console.info(`[meeting-agent] series sweep series=${summary.series} sent=${summary.sent} known=${summary.known} no_dial_in=${summary.noDialIn} failed=${summary.failed}`)
  return summary
}

/**
 * Which of these attendances a series sent (727's series_ref), by id. Read on
 * its own and best effort, so the list still loads on a database without 727.
 */
export async function seriesRefsOf(svc: SupabaseClient, scope: { userId: string; ids: readonly string[] }): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (scope.ids.length === 0) return out
  const { data, error } = await svc.from(MEETING_ATTENDANCE_TABLE).select('id, series_ref').eq('user_id', scope.userId).in('id', [...scope.ids])
  if (error) return out
  for (const r of (data ?? []) as Array<{ id: string; series_ref: string | null }>) if (r.series_ref) out.set(r.id, r.series_ref)
  return out
}
