import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import type { ApprovalContext } from '@/lib/safety/approvals'
import { BRIEF_MAX_CHARS, BRIEF_MAX_ITEMS, briefIsEmpty, parseBrief } from '@/lib/meeting-agent/brief'
import { meetingAgentCard } from '@/lib/meeting-agent/card'
import { findMeeting } from '@/lib/meeting-agent/lookup'
import { sendAgentToMeeting } from '@/lib/meeting-agent/send'
import { saveSeries, seriesIdOf } from '@/lib/meeting-agent/series'
import { meetingAgentOn } from '@/lib/meeting-agent/settings'
import { normalizeEventId, normalizeStartsAt } from '@/lib/meetings/meeting-goal'

/**
 * Send the person's agent to one of their meetings, from the chat ("go to my
 * 3pm for me"): roadmap #12, docs/plans/agent-joins-meetings.md §5. Liam,
 * 11-27: "let's do it".
 *
 * Never immediate: the person opts in per meeting, explicitly. The first call
 * raises their approval card, which shows the meeting, the dial-in it found
 * and the whole brief; the agent is sent only when they accept (the Accept
 * replays this exact call: approvedCall). It dials in by phone at the start,
 * says who it is and that it takes notes, speaks only from the brief, texts
 * the person when something needs them, and leaves the notes as a capture.
 *
 * With every_occurrence (phase 2, migration 727), the same approved brief
 * covers every later occurrence of a recurring meeting: the card says so, and
 * each one is listed and can be skipped. Liam's rule (11-27, via the plan):
 * "The person opts in per meeting, or per recurring meeting, explicitly."
 *
 * The meeting is read from the person's own calendar (find it first with
 * get_calendar_events): it never attends one they're not on. An unattended
 * run never sends it. Off unless MEETING_AGENT is on.
 */

const ATTENDED_ONLY = 'Your assistant is sent to a meeting by the person, from the chat, never by an unattended run.'

export interface MeetingAgentToolsOptions {
  unattended?: boolean
  conversationId?: string | null
  approvedCall?: ApprovedCall
  approvalContext?: Omit<ApprovalContext, 'flow' | 'connection' | 'bots' | 'document'>
  env?: Record<string, string | undefined>
}

const list = (what: string) => z.array(z.string().max(BRIEF_MAX_CHARS)).max(BRIEF_MAX_ITEMS).optional().describe(`${what} (short lines, at most ${BRIEF_MAX_ITEMS})`)


export function createMeetingAgentTools(userId: string, _supabase: SupabaseClient, workspaceId: string, opts: MeetingAgentToolsOptions = {}) {
  return {
    send_agent_to_meeting: tool({
      description:
        "Send the person's AI assistant to one of THEIR meetings in their place, when they ask (\"go to my 3pm for me\", \"can you sit in on the Acme call\"). It dials in by phone, introduces itself as their AI assistant, takes notes, speaks only from the brief, and texts them if it needs them. Find the meeting first with get_calendar_events and pass its id and start exactly. Write the brief from what they said and the meeting's prep (their goal for it, open items): goals, facts it may share, questions to ask, and what it must not agree to. Never immediate: it raises the person's card showing the brief, and nothing is sent until they accept. Needs a phone dial-in on the invite (pass dial_in_number and dial_in_digits only if the person gives them).",
      inputSchema: z.object({
        calendar_event_id: z.string().describe("The meeting's calendar event id (get_calendar_events' id)"),
        starts_at: z.string().describe("The meeting's start as an ISO 8601 date-time (the event's start)"),
        goals: list('What the person wants out of the meeting'),
        may_share: list('Facts the assistant may share'),
        ask: list('Questions the assistant should ask'),
        must_not_agree: list('What the assistant must not agree to (money, dates and decisions are always off limits)'),
        dial_in_number: z.string().optional().describe("Only if the person gave one: the meeting's dial-in phone number"),
        dial_in_digits: z.string().optional().describe('Only with dial_in_number: the meeting ID / PIN digits to key in, with # where the bridge wants it'),
        every_occurrence: z.boolean().optional().describe('Only when the person asks for every time this recurring meeting happens ("every week", "all my standups"): the same brief covers every later occurrence'),
      }),
      execute: async (input) => {
        if (opts.unattended) return { success: false, error: ATTENDED_ONLY }
        if (!meetingAgentOn(opts.env ?? process.env)) return { success: false, error: 'Sending the assistant to meetings is not turned on yet.' }
        const calendarEventId = normalizeEventId(input.calendar_event_id)
        const startsAt = normalizeStartsAt(input.starts_at)
        if (!calendarEventId || !startsAt) return { success: false, error: 'Find the meeting with get_calendar_events and pass its id and start exactly.' }
        const brief = parseBrief({ goals: input.goals, may_share: input.may_share, ask: input.ask, must_not_agree: input.must_not_agree })
        if (!brief.ok) return { success: false, error: `The brief can't be used as it is (${brief.field ?? 'brief'}: ${brief.reason}).` }
        if (briefIsEmpty(brief.brief)) return { success: false, error: 'Ask the person what they want out of the meeting: the assistant needs at least one goal or question.' }

        let found
        try {
          found = await findMeeting(userId, { calendarEventId, startsAt })
        } catch (err) {
          return { success: false, error: `Their calendar could not be read: ${err instanceof Error ? err.message : 'error'}` }
        }
        if (!found) return { success: false, error: "That meeting isn't on the person's calendar at that start. Find it with get_calendar_events." }
        const given = input.dial_in_number ? { number: input.dial_in_number, digits: (input.dial_in_digits ?? '').replace(/[^0-9#*]/g, '') } : null
        // A person's own digits wait for the bridge to answer first, as the found ones do.
        const dialIn = given ? { number: given.number, digits: given.digits ? `wwwwww${given.digits}` : '' } : found.dialIn
        const seriesId = seriesIdOf(found.event)
        const everyOccurrence = input.every_occurrence === true
        if (everyOccurrence && !seriesId) return { success: false, code: 'NOT_RECURRING', error: "That meeting doesn't repeat. Send the assistant to it alone." }
        if (!dialIn) {
          return { success: false, code: 'NO_DIAL_IN', error: 'This meeting has no phone dial-in on its invite. Ask the person for the dial-in number and meeting ID (or PIN), then call again with dial_in_number and dial_in_digits.' }
        }

        if (opts.approvedCall?.tool !== 'send_agent_to_meeting') {
          const { createToolApproval } = await import('@/lib/safety/approvals')
          const held = await createToolApproval(getServiceClient(), {
            door: 'chat',
            userId,
            workspaceId,
            toolName: 'send_agent_to_meeting',
            sideEffect: 'external-write',
            input: { ...input, calendar_event_id: calendarEventId, starts_at: startsAt },
            conversationId: opts.conversationId ?? null,
            context: { ...(opts.approvalContext ?? {}) },
            reason: 'meeting_agent_send',
            card: meetingAgentCard({ title: found.event.title, number: dialIn.number, brief: brief.brief, everyOccurrence }),
          })
          if (!held.ok) return { success: false, code: held.code, error: held.error }
          return {
            success: false,
            code: 'APPROVAL_REQUIRED',
            approval_id: held.approvalId,
            message: 'Waiting for the person: their card shows the meeting and the brief. Nothing is sent until they accept; do not call this again for the same meeting.',
          }
        }

        const sent = await sendAgentToMeeting(getServiceClient(), {
          workspaceId,
          userId,
          calendarEventId,
          startsAt,
          endsAt: found.event.end || null,
          title: found.event.title,
          dialIn,
          brief: brief.brief,
        })
        if (!sent.ok) return { success: false, code: sent.reason.toUpperCase(), error: sent.message }
        if (everyOccurrence && seriesId) {
          const a = sent.attendance
          await saveSeries(getServiceClient(), {
            workspaceId,
            userId,
            seriesId,
            title: found.event.title,
            brief: a.brief,
            // The person's own dial-in rides along for every occurrence; one read from this invite is read again from each.
            dialIn: given && a.dialInNumber && a.dialInPin ? { number: a.dialInNumber, digits: a.dialInPin } : null,
          })
        }
        return {
          success: true,
          attendance_id: sent.attendance.id,
          status: sent.attendance.status,
          every_occurrence: everyOccurrence,
          message: `Your assistant will dial in to “${found.event.title}” at its start as “${sent.attendance.displayName}”${everyOccurrence ? ', and to every later occurrence with the same brief' : ''}. You'll get a text if it needs you, and the notes land as a capture.`,
        }
      },
    }),
  }
}
