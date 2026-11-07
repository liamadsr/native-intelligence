import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MEETING_GOAL_MAX_CHARS,
  clearMeetingGoal,
  normalizeEventId,
  normalizeGoalText,
  normalizeStartsAt,
  upsertMeetingGoal,
} from '@/lib/meetings/meeting-goal'

/**
 * The person's goal for one of their meetings, from the main chat ("the goal
 * of my 2:30 is to close the pilot"), the same store the prep card's composer
 * writes (migration 356, src/lib/meetings/meeting-goal.ts). The live agent and
 * the HUD read it once the call starts (a later phase).
 *
 * The meeting is its calendar event id and start, which the model has from
 * get_calendar_events (the event's id and start) or a prep report. An EMPTY
 * goal clears it: one tool, no second flag to get wrong.
 *
 * Only for a person at the keyboard: a goal is what the person wants out of
 * their call, so an unattended run (work-run, skill-run) is refused. Private to
 * the person: the store fences every write on them and the workspace.
 */
export function createMeetingGoalTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  unattended = false,
) {
  return {
    set_meeting_goal: tool({
      description:
        "Set (or clear) the user's goal for one of THEIR upcoming meetings, when they tell you what they want out of it (\"the goal of my 2:30 is to close the pilot\", \"for the Acme call I want a yes on pricing\"). It is kept with that meeting, and its prep card shows it. Find the meeting first with get_calendar_events (or the meeting prep report) and pass that event's id and start exactly. The goal in the user's words, one or two short sentences. An empty goal clears it. Never for a goal you inferred.",
      inputSchema: z.object({
        calendar_event_id: z.string().describe("The meeting's calendar event id (get_calendar_events' id, or the prep report's calendar event)"),
        starts_at: z.string().describe("The meeting's start as an ISO 8601 date-time (the event's start)"),
        goal: z.string().describe(`The goal, in the user's words (at most ${MEETING_GOAL_MAX_CHARS} characters). Empty clears it.`),
      }),
      execute: async ({ calendar_event_id, starts_at, goal }) => {
        if (unattended) return { success: false, error: 'A meeting goal is set by the person, from the chat' }
        const calendarEventId = normalizeEventId(calendar_event_id)
        if (!calendarEventId) return { success: false, error: 'calendar_event_id is required: find the meeting with get_calendar_events' }
        const startsAt = normalizeStartsAt(starts_at)
        if (!startsAt) return { success: false, error: 'starts_at must be an ISO 8601 date-time (the event start)' }
        const text = normalizeGoalText(goal)
        if (!text.ok) {
          return { success: false, error: text.reason === 'too_long' ? `A goal is at most ${MEETING_GOAL_MAX_CHARS} characters` : 'goal must be text' }
        }
        const key = { workspaceId, userId, calendarEventId, startsAt }
        try {
          if (!text.goal) {
            const cleared = await clearMeetingGoal(supabase, key)
            return { success: true, cleared, calendar_event_id: calendarEventId, starts_at: startsAt, message: cleared ? 'Goal cleared.' : 'That meeting had no goal.' }
          }
          const result = await upsertMeetingGoal(supabase, { ...key, goal: text.goal, source: 'chat' })
          if (!result.ok) return { success: false, error: result.message }
          return {
            success: true,
            goal: result.goal.goal,
            calendar_event_id: result.goal.calendarEventId,
            starts_at: result.goal.startsAt,
            message: 'Goal saved for that meeting. Its prep card shows it.',
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'The goal was not saved' }
        }
      },
    }),
  }
}
