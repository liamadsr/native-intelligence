/**
 * A scheduled meeting's call capture, linked to the meeting's calendar event
 * as a person's own capture of that meeting is (one recorder per call, phase
 * 2; migration 656 decides, from what the database knows for certain, never
 * from a title or a time). With the link, the capture is the meeting's in the
 * calendar, and the meeting's prep and the linked event's title read it as
 * they read any capture of the meeting. Server only.
 *
 * Settings (an empty value counts as unset):
 *   TEAM_CALL_EVENT_LINK=on  link a meeting link's call capture to its
 *                            calendar event when the recorder's session
 *                            starts. Needs the call recorder on
 *                            (TEAM_CALL_RECORDER). Off unless set.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { teamCallRecorderOn } from './recorder'

export function teamCallEventLinkOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEAM_CALL_EVENT_LINK?.trim().toLowerCase() === 'on' && teamCallRecorderOn(env)
}

export type CallEventLink = 'linked' | 'already' | 'no_meeting' | 'not_host' | 'no_event' | 'taken' | 'not_a_call' | 'off' | 'error'

/** Link the capture to its meeting's event (656's team_call_capture_link_event). Never throws. */
export async function linkCallCaptureToEvent(svc: SupabaseClient, captureId: string, env: NodeJS.ProcessEnv = process.env): Promise<CallEventLink> {
  if (!teamCallEventLinkOn(env)) return 'off'
  try {
    const { data, error } = await svc.rpc('team_call_capture_link_event', { target_capture: captureId })
    if (error) throw new Error(error.message)
    const outcome = (typeof data === 'string' ? data : 'error') as CallEventLink
    // Only what it became, by id: 'taken' means the owner's own capture of the event keeps it.
    if (outcome === 'linked' || outcome === 'taken') console.info(`[team-call-event] capture=${captureId} outcome=${outcome}`)
    return outcome
  } catch (err) {
    console.warn(`[team-call-event] capture=${captureId} not linked:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return 'error'
  }
}
