/**
 * The meeting agent's "I'll check with you" message in the person's home
 * thread (ui_message.metadata.kind), which the reach router sends on to find
 * them (src/lib/reach/route-policy.ts): urgent, since someone in a meeting is
 * waiting on the answer. Pure and client-safe.
 */
export const MEETING_ASK_MESSAGE_KIND = 'meeting_ask' as const

/** metadata key: the attendance the ask came from (migration 723). */
export const MEETING_ASK_ATTENDANCE_KEY = 'meeting_attendance_id' as const
