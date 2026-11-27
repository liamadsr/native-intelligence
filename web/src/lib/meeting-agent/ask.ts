/**
 * "I'll check with <Name>" (roadmap #12, docs/plans/agent-joins-meetings.md §3):
 * the question goes to the person's home thread as one message, and the reach
 * router takes it to wherever they are (a banner at an app, else push, a
 * text or Slack). It is urgent (`urgent_by`, MEETING_ASK_URGENT_MS out): the
 * router otherwise holds a routine message while the person is busy in a
 * meeting, and someone in this one is waiting on the answer. Quiet hours
 * still hold for anything but urgent, which this always is.
 *
 * Their reply lands in the same thread, from whatever channel they answer on.
 * Relaying it back into the meeting live is phase 2; in phase 1 the notes
 * record that the question was put to them.
 *
 * Never throws: an ask that couldn't be written is logged, and the meeting
 * was already told the assistant will check.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { requestRoute } from '@/lib/reach/route'
import { MEETING_ASK_ATTENDANCE_KEY, MEETING_ASK_MESSAGE_KIND } from './message-kind'
import { recordAsk, type MeetingAttendance } from './store'

/**
 * The ask's deadline (`urgent_by`): the router sends a message urgent while
 * its deadline is still ahead, through "busy" and quiet hours. The router
 * first waits out its grace (REACH_ROUTE_DEBOUNCE_PERIOD, 2 minutes), so the
 * deadline sits well past that; the meeting is still going on then, and the
 * answer is still wanted.
 */
export const MEETING_ASK_URGENT_MS = 15 * 60_000

/** The ask's words in the thread (and the text). Pure. */
export function meetingAskText(args: { title: string; question: string }): string {
  const title = args.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'your meeting'
  const question = args.question.replace(/\s+/g, ' ').trim().slice(0, 400)
  return `From ${title}, where I'm attending for you: ${question || 'something came up that needs you.'} Reply here and I'll keep it in the notes.`
}

/** The ask's message id: one per hand-off, so a retry writes it once. */
export function meetingAskMessageId(attendanceId: string, delegationId: string): string {
  return `meeting-ask:${attendanceId}:${delegationId}`
}

export interface MeetingAskDeps {
  append?: typeof appendHomeMessage
  route?: typeof requestRoute
  record?: typeof recordAsk
  now?: () => number
}

/** Put one question to the person. Whether it was written. */
export async function askOwner(
  supabase: SupabaseClient,
  args: { attendance: MeetingAttendance; delegationId: string; question: string },
  deps: MeetingAskDeps = {},
): Promise<boolean> {
  const a = args.attendance
  const now = (deps.now ?? Date.now)()
  const messageId = meetingAskMessageId(a.id, args.delegationId)
  try {
    const written = await (deps.append ?? appendHomeMessage)(supabase, {
      userId: a.userId,
      workspaceId: a.workspaceId,
      messageId,
      parts: [{ type: 'text', text: meetingAskText({ title: a.title, question: args.question }) }],
      metadata: { kind: MEETING_ASK_MESSAGE_KIND, [MEETING_ASK_ATTENDANCE_KEY]: a.id, urgent_by: new Date(now + MEETING_ASK_URGENT_MS).toISOString() },
    })
    if (!written.written) {
      console.warn(`[meeting-agent] attendance=${a.id} ask not written: ${written.reason ?? 'unknown'}`)
      return false
    }
    await (deps.record ?? recordAsk)(supabase, a.id, { at: new Date(now).toISOString(), question: args.question.slice(0, 400), messageId })
    if (written.conversationId) {
      await (deps.route ?? requestRoute)({ userId: a.userId, workspaceId: a.workspaceId, conversationId: written.conversationId }, messageId)
    }
    return true
  } catch (err) {
    console.warn(`[meeting-agent] attendance=${a.id} ask failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
