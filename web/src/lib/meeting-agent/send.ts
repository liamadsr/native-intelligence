/**
 * Sending the agent to a meeting, and calling it off (roadmap #12,
 * docs/plans/agent-joins-meetings.md §2, §5). The person opts in per meeting,
 * explicitly: this runs only from their own approval (the chat tool's card,
 * or the attendance API from the app), with the brief they approved.
 *
 * Send checks the meeting (not over, a US/CA dial-in with its digits), the
 * brief (./brief.ts: within the limits, with a goal or a question), and the
 * person's name (it joins as "<Name>'s assistant (AI)"), then writes the row
 * as `scheduled` and asks the scheduler to dial at the start.
 *
 * Calling it off: before the call, the row is `cancelled` and the scheduled
 * dial finds nothing to do; during it, the call is hung up (OpenAI's session,
 * and Twilio's leg as a backstop) and the bridge finishes the notes as usual.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callerDisplayName } from '@/lib/calls/caller'
import { firstName } from '@/lib/calls/live-session'
import { hangUpLiveCall, liveApiKey } from '@/lib/calls/live-api'
import { inngest } from '@/lib/inngest/client'
import { normalizeEventId, normalizeStartsAt } from '@/lib/meetings/meeting-goal'
import { accountUrl, twilioRest } from '@/lib/twilio/rest'
import { twilioConfig } from '@/lib/twilio/config'
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { briefIsEmpty, parseBrief, type MeetingBrief } from './brief'
import { isDialDigits } from './dial-in'
import { assistantDisplayName } from './session'
import { meetingAgentOn } from './settings'
import { getAttendance, moveAttendance, scheduleAttendance, type MeetingAttendance } from './store'

export const MEETING_SCHEDULED_EVENT = 'meeting-agent/scheduled' as const
export const MEETING_CANCELLED_EVENT = 'meeting-agent/cancelled' as const
export interface MeetingScheduledData {
  attendanceId: string
  startsAt: string
}

export type SendFailure = 'off' | 'bad_meeting' | 'over' | 'no_dial_in' | 'bad_brief' | 'empty_brief' | 'no_name' | 'busy' | 'error'

export type SendRefusal = { ok: false; reason: SendFailure; message: string }
export type SendResult = { ok: true; attendance: MeetingAttendance } | SendRefusal

export interface SendInput {
  workspaceId: string
  userId: string
  calendarEventId: string
  startsAt: string
  endsAt?: string | null
  title: string
  dialIn: { number: string; digits: string } | null
  brief: unknown
  /** The series sending this occurrence (727), when it is one. */
  seriesRef?: string | null
}

export interface SendDeps {
  env?: Record<string, string | undefined>
  now?: () => Date
  displayName?: typeof callerDisplayName
  send?: (event: { name: string; data: unknown; id?: string }) => Promise<unknown>
}

function fail(reason: SendFailure, message: string): SendRefusal {
  return { ok: false, reason, message }
}

/** A send that passed every check, ready to write (checkSend). */
export interface CheckedSend {
  eventId: string
  startsAt: string
  endsAt: string | null
  number: string
  digits: string
  brief: MeetingBrief
  firstName: string
}

/**
 * Every check a send makes, with no write: the setting, the meeting (not
 * over), a US/CA dial-in with its digits, the brief (within the limits, with
 * a goal or a question) and the person's name. The prep card's brief editor
 * runs it for its Review step, so what it shows is what a send would do.
 */
export async function checkSend(svc: SupabaseClient, input: SendInput, deps: SendDeps = {}): Promise<{ ok: true; checked: CheckedSend } | SendRefusal> {
  if (!meetingAgentOn(deps.env ?? process.env)) return fail('off', 'Sending your assistant to meetings is not turned on yet.')
  const now = (deps.now ?? (() => new Date()))()
  const eventId = normalizeEventId(input.calendarEventId)
  const startsAt = normalizeStartsAt(input.startsAt)
  if (!eventId || !startsAt) return fail('bad_meeting', 'That meeting could not be found.')
  const endsAt = input.endsAt ? normalizeStartsAt(input.endsAt) : null
  if ((endsAt && Date.parse(endsAt) <= now.getTime()) || (!endsAt && Date.parse(startsAt) < now.getTime() - 30 * 60_000)) {
    return fail('over', 'That meeting is already over.')
  }
  const number = normalizeE164(input.dialIn?.number)
  if (!number || !isNanpNumber(number) || !isDialDigits(input.dialIn?.digits)) {
    return fail('no_dial_in', 'This meeting has no US or Canadian dial-in number with its meeting ID. Add one to the invite (or give it to me) and try again.')
  }
  const parsed = parseBrief(input.brief)
  if (!parsed.ok) return fail('bad_brief', `The brief can't be used as it is (${parsed.field ?? 'brief'}: ${parsed.reason.replace('_', ' ')}).`)
  if (briefIsEmpty(parsed.brief)) return fail('empty_brief', 'Give your assistant at least one goal or one question to ask.')
  const name = firstName(await (deps.displayName ?? callerDisplayName)(svc, { userId: input.userId, workspaceId: input.workspaceId }))
  if (!name) return fail('no_name', 'Your assistant needs your name to introduce itself. Add a display name to your profile first.')
  return { ok: true, checked: { eventId, startsAt, endsAt, number, digits: input.dialIn!.digits, brief: parsed.brief, firstName: name } }
}

/** Send the agent to one meeting with this brief. */
export async function sendAgentToMeeting(svc: SupabaseClient, input: SendInput, deps: SendDeps = {}): Promise<SendResult> {
  const check = await checkSend(svc, input, deps)
  if (!check.ok) return check
  const now = (deps.now ?? (() => new Date()))()
  const { eventId, startsAt, endsAt, number, digits, brief, firstName: name } = check.checked

  const written = await scheduleAttendance(
    svc,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      calendarEventId: eventId,
      startsAt,
      endsAt,
      title: input.title.replace(/\s+/g, ' ').trim(),
      dialInNumber: number,
      dialInPin: digits,
      brief,
      displayName: assistantDisplayName(name),
      ownerFirstName: name,
      captureId: null,
      seriesRef: input.seriesRef ?? null,
    },
    now,
  )
  if (!written.ok) return fail(written.reason, written.message)
  await (deps.send ?? ((e) => inngest.send(e as never)))({
    name: MEETING_SCHEDULED_EVENT,
    data: { attendanceId: written.attendance.id, startsAt } satisfies MeetingScheduledData,
    id: `meeting-dial:${written.attendance.id}:${startsAt}`,
  })
  console.info(`[meeting-agent] attendance=${written.attendance.id} scheduled starts=${startsAt}`)
  return { ok: true, attendance: written.attendance }
}

export interface CancelDeps {
  send?: (event: { name: string; data: unknown }) => Promise<unknown>
  hangUp?: (sessionId: string) => Promise<unknown>
  endTwilioCall?: (callSid: string) => Promise<unknown>
}

/** End Twilio's leg (the backstop when the OpenAI session can't be reached). */
async function endTwilioCall(callSid: string): Promise<void> {
  const config = twilioConfig()
  if (!config) return
  await twilioRest(config, accountUrl(config, `/Calls/${encodeURIComponent(callSid)}.json`), { method: 'POST', form: { Status: 'completed' } }).catch(() => null)
}

/**
 * Call it off. 'cancelled' before the call; 'pulled_out' during it (the bridge
 * then finishes the notes); 'over' when there's nothing left to stop.
 */
export async function cancelAttendance(svc: SupabaseClient, scope: { workspaceId: string; userId: string; id: string }, deps: CancelDeps = {}): Promise<'cancelled' | 'pulled_out' | 'over' | 'not_found'> {
  const a = await getAttendance(svc, scope)
  if (!a) return 'not_found'
  if (a.status === 'draft' || a.status === 'scheduled') {
    const moved = await moveAttendance(svc, a.id, ['draft', 'scheduled'], 'cancelled', { status_detail: 'by_person' })
    if (moved) {
      await (deps.send ?? ((e) => inngest.send(e as never)))({ name: MEETING_CANCELLED_EVENT, data: { attendanceId: a.id } }).catch(() => {})
      return 'cancelled'
    }
    return cancelAttendance(svc, scope, deps)
  }
  if (a.status === 'dialling' || a.status === 'in_meeting') {
    const apiKey = liveApiKey()
    if (a.liveSessionId && apiKey) await (deps.hangUp ?? ((id: string) => hangUpLiveCall(id, { apiKey })))(a.liveSessionId).catch(() => {})
    if (a.twilioCallSid) await (deps.endTwilioCall ?? endTwilioCall)(a.twilioCallSid).catch(() => {})
    // Still dialling: no bridge will ever finish it.
    if (a.status === 'dialling') await moveAttendance(svc, a.id, ['dialling'], 'cancelled', { status_detail: 'by_person', join_token_hash: null })
    return 'pulled_out'
  }
  return 'over'
}
