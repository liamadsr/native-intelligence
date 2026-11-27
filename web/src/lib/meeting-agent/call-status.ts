/**
 * Twilio's word on the outbound leg (roadmap #12): /api/calls/meeting/status
 * hands each status change here. The bridge is what runs a call once OpenAI
 * answered it; this covers what the bridge never sees:
 *
 *   - the meeting's number was busy, didn't answer, or the call failed:
 *     `failed` with Twilio's word for it;
 *   - the call ended while still `dialling`: OpenAI never answered with our
 *     token (the host never let it in from a waiting room, the PIN was
 *     wrong, or the SIP leg failed): `failed`, `not_let_in`;
 *   - the call ended while `in_meeting`: nothing here, the bridge finishes it
 *     (and a bridge that died is caught by its own catch in the webhook route).
 *
 * Only a leg whose CallSid is the attendance's own counts. Pure over the store.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAttendanceById, moveAttendance } from './store'

export type CallStatusOutcome = 'ignored' | 'unknown' | 'failed' | 'not_let_in'

const FAILED = new Set(['busy', 'no-answer', 'failed', 'canceled'])

export async function handleMeetingCallStatus(svc: SupabaseClient, args: { attendanceId: string; callSid: string; status: string }): Promise<CallStatusOutcome> {
  const a = await getAttendanceById(svc, args.attendanceId)
  if (!a || !args.callSid || a.twilioCallSid !== args.callSid) return 'unknown'
  if (a.status !== 'dialling') return 'ignored'
  if (FAILED.has(args.status)) {
    await moveAttendance(svc, a.id, ['dialling'], 'failed', { status_detail: `call_${args.status.replace('-', '_')}`, join_token_hash: null })
    return 'failed'
  }
  if (args.status === 'completed') {
    await moveAttendance(svc, a.id, ['dialling'], 'failed', { status_detail: 'not_let_in', join_token_hash: null })
    return 'not_let_in'
  }
  return 'ignored'
}
