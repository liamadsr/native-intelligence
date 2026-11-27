/**
 * Starting the call to a meeting at its time (roadmap #12): the scheduler's
 * one step (src/lib/inngest/meeting-agent.ts). Everything is checked again
 * here, at the moment it dials, since a row can change in the hours between
 * the send and the start:
 *
 *   - the server still has the meeting agent on, and the calls are set up
 *     (Twilio's account and number, GPT_LIVE_TRUNK_SECRET, MEETING_AGENT_SIP_URI);
 *   - the attendance is still `scheduled`, for the start this run was made for
 *     (a meeting moved is a new run), with an approved brief and a number;
 *   - the meeting hasn't ended (or isn't long past its start, with no end).
 *
 * Then it moves to `dialling` with a fresh one-time token's hash (a
 * compare-and-set: one dial per send), and Twilio calls the meeting
 * (./dial-out.ts). A refused call moves it to `failed` with the reason.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { twilioConfig } from '@/lib/twilio/config'
import { dialMeeting, meetingStatusCallbackUrl, meetingTwiml, newJoinToken, type DialDeps } from './dial-out'
import { isDialDigits } from './dial-in'
import { meetingAgentMaxMinutes, meetingAgentOn, meetingAgentSipUri } from './settings'
import { getAttendanceById, moveAttendance } from './store'

/** With no end on the calendar, it won't dial this long after the start. */
export const LATE_DIAL_MAX_MS = 30 * 60_000

export type DialOutcome =
  | 'dialling'
  | 'off'
  | 'not_configured'
  | 'gone'
  | 'not_scheduled'
  | 'moved'
  | 'over'
  | 'not_ready'
  | 'lost_race'
  | 'refused'

type Env = Record<string, string | undefined>

export interface DialStepDeps extends DialDeps {
  env?: Env
  now?: () => number
  dial?: typeof dialMeeting
}

/** Dial one attendance, if it is still due. Throws only on a failed read or write (the step retries). */
export async function dialAttendance(svc: SupabaseClient, args: { attendanceId: string; startsAt: string }, deps: DialStepDeps = {}): Promise<DialOutcome> {
  const env = deps.env ?? process.env
  const now = (deps.now ?? Date.now)()
  if (!meetingAgentOn(env)) return 'off'
  const twilio = twilioConfig()
  const sipUri = meetingAgentSipUri(env)
  const trunkSecret = env.GPT_LIVE_TRUNK_SECRET?.trim()
  if (!twilio?.fromNumber || !sipUri || !trunkSecret) {
    console.error(`[meeting-agent] ALERT attendance=${args.attendanceId} not dialled: the calls are not set up (Twilio number, MEETING_AGENT_SIP_URI, GPT_LIVE_TRUNK_SECRET)`)
    await moveAttendance(svc, args.attendanceId, ['scheduled'], 'failed', { status_detail: 'not_configured' })
    return 'not_configured'
  }
  const a = await getAttendanceById(svc, args.attendanceId)
  if (!a) return 'gone'
  if (a.status !== 'scheduled') return 'not_scheduled'
  if (Date.parse(a.startsAt) !== Date.parse(args.startsAt)) return 'moved'
  const end = a.endsAt ? Date.parse(a.endsAt) : Date.parse(a.startsAt) + LATE_DIAL_MAX_MS
  if (now >= end) {
    await moveAttendance(svc, a.id, ['scheduled'], 'failed', { status_detail: 'meeting_over' })
    return 'over'
  }
  if (!a.briefApprovedAt || !a.dialInNumber || !isDialDigits(a.dialInPin)) {
    await moveAttendance(svc, a.id, ['scheduled'], 'failed', { status_detail: 'not_ready' })
    return 'not_ready'
  }

  const { token, hash } = newJoinToken()
  const claimed = await moveAttendance(svc, a.id, ['scheduled'], 'dialling', { join_token_hash: hash, dial_started_at: new Date(now).toISOString(), status_detail: null })
  if (!claimed) return 'lost_race'

  const timeLimitSeconds = meetingAgentMaxMinutes(env) * 60
  const result = await (deps.dial ?? dialMeeting)(
    twilio,
    {
      from: twilio.fromNumber,
      to: a.dialInNumber,
      twiml: meetingTwiml({ digits: a.dialInPin!, sipUri, trunkSecret, token, timeLimitSeconds }),
      timeLimitSeconds,
      statusCallback: meetingStatusCallbackUrl(a.id),
    },
    { fetch: deps.fetch },
  )
  if (!result.ok) {
    console.warn(`[meeting-agent] attendance=${a.id} dial refused status=${result.status} code=${result.code ?? 'none'}`)
    await moveAttendance(svc, a.id, ['dialling'], 'failed', { status_detail: `dial_refused:${result.code ?? result.status}`.slice(0, 80), join_token_hash: null })
    return 'refused'
  }
  await svc.from('meeting_attendance').update({ twilio_call_sid: result.callSid }).eq('id', a.id)
  console.info(`[meeting-agent] attendance=${a.id} dialling call=${result.callSid}`)
  return 'dialling'
}
