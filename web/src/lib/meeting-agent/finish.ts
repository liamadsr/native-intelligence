/**
 * The end of a meeting the agent attended (roadmap #12,
 * docs/plans/agent-joins-meetings.md §4): its words become the person's
 * capture of the meeting, and the capture's finishing pass runs on Inngest
 * (src/lib/inngest/meeting-agent.ts: the same batch and post-extraction a
 * recorded meeting gets: summary, action items, decisions, title, index).
 *
 * The capture: the person's own open capture of this meeting when one is
 * waiting (calendar sync's pending row for the occurrence) and it has no
 * words yet, else a new one linked to the calendar event. A call where the
 * meeting said nothing leaves no capture.
 *
 * Never throws: the attendance always ends up in a final state.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { notesPreamble, type MeetingNotes } from './notes'
import { moveAttendance, type MeetingAttendance } from './store'

export type MeetingEnd = 'ended' | 'objected' | 'cut'

export const MEETING_NOTES_READY_EVENT = 'meeting-agent/notes.ready' as const
export interface MeetingNotesReadyData {
  attendanceId: string
  captureId: string
  workspaceId: string
  userId: string
}

/** The capture's metadata mark: notes the meeting agent took. */
export const MEETING_AGENT_CAPTURE_SOURCE = 'meeting_agent'

export interface FinishDeps {
  send?: (event: { name: typeof MEETING_NOTES_READY_EVENT; data: MeetingNotesReadyData; id: string }) => Promise<unknown>
  now?: () => Date
}

/** Write the notes to a capture; its id, or null when there was nothing to keep. Throws on a failed write. */
export async function writeMeetingCapture(svc: SupabaseClient, a: MeetingAttendance, transcript: string, now: Date): Promise<string | null> {
  if (!transcript.trim()) return null
  const meta = { source: MEETING_AGENT_CAPTURE_SOURCE, meeting_attendance_id: a.id }
  const { data: open } = await svc
    .from('captures')
    .select('id, transcript, metadata')
    .eq('workspace_id', a.workspaceId)
    .eq('user_id', a.userId)
    .eq('calendar_event_id', a.calendarEventId)
    .eq('scheduled_start', a.startsAt)
    .is('ended_at', null)
    .neq('status', 'archived')
    // An eval's capture is never the person's own (docs/plans/evals.md §5.2).
    .neq('is_eval', true)
    .limit(1)
    .maybeSingle<{ id: string; transcript: string | null; metadata: Record<string, unknown> | null }>()
  if (open && !(open.transcript ?? '').trim()) {
    const { error } = await svc
      .from('captures')
      .update({ transcript, started_at: a.joinedAt ?? a.startsAt, ended_at: now.toISOString(), is_transcript_locked: true, metadata: { ...(open.metadata ?? {}), ...meta } })
      .eq('id', open.id)
      .eq('user_id', a.userId)
    if (error) throw new Error(`meeting agent: capture update failed: ${error.message}`)
    return open.id
  }
  const { data, error } = await svc
    .from('captures')
    .insert({
      user_id: a.userId,
      workspace_id: a.workspaceId,
      title: a.title || 'Meeting',
      calendar_event_id: a.calendarEventId,
      scheduled_start: a.startsAt,
      scheduled_end: a.endsAt,
      status: 'active',
      transcript,
      started_at: a.joinedAt ?? a.startsAt,
      ended_at: now.toISOString(),
      is_transcript_locked: true,
      metadata: meta,
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !data) throw new Error(`meeting agent: capture insert failed: ${error?.message ?? 'no row'}`)
  return data.id
}

/** Finish one attended meeting. Never throws. */
export async function finishMeeting(svc: SupabaseClient, args: { attendance: MeetingAttendance; notes: MeetingNotes; end: MeetingEnd }, deps: FinishDeps = {}): Promise<{ captureId: string | null }> {
  const a = args.attendance
  const now = (deps.now ?? (() => new Date()))()
  let captureId: string | null = null
  let detail: string | null = args.end === 'cut' ? 'time_limit' : null
  try {
    if (args.notes.meetingSpoke()) {
      const transcript = [notesPreamble({ assistantLabel: a.displayName, firstName: a.ownerFirstName, ended: args.end }), args.notes.transcript()].join('\n')
      captureId = await writeMeetingCapture(svc, a, transcript, now)
    } else {
      detail = detail ?? 'nothing_said'
    }
  } catch (err) {
    detail = 'notes_failed'
    console.error(`[meeting-agent] ALERT attendance=${a.id} notes not written: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    await moveAttendance(svc, a.id, ['in_meeting', 'dialling'], args.end === 'objected' ? 'objected' : 'ended', { left_at: now.toISOString(), status_detail: detail, ...(captureId ? { capture_id: captureId } : {}) }, now)
  } catch (err) {
    console.error(`[meeting-agent] ALERT attendance=${a.id} not closed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (captureId) {
    try {
      await (deps.send ?? ((e) => inngest.send(e)))({
        name: MEETING_NOTES_READY_EVENT,
        data: { attendanceId: a.id, captureId, workspaceId: a.workspaceId, userId: a.userId },
        id: `meeting-notes:${a.id}`,
      })
    } catch (err) {
      console.error(`[meeting-agent] ALERT attendance=${a.id} capture=${captureId} finishing pass not queued: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.info(`[meeting-agent] attendance=${a.id} end=${args.end} capture=${captureId ?? 'none'}${detail ? ` detail=${detail}` : ''}`)
  return { captureId }
}
