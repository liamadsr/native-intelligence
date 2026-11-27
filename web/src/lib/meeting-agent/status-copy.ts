/**
 * What the person reads about their assistant in a meeting (roadmap #12
 * phase 2, docs/plans/agent-joins-meetings.md §5): one plain line per status,
 * and why when it couldn't get in. Pure and client-safe.
 */

export type AttendanceStatusName = 'draft' | 'scheduled' | 'dialling' | 'in_meeting' | 'ended' | 'cancelled' | 'failed' | 'objected'

const FAILED_BECAUSE: Record<string, string> = {
  not_let_in: "It called in but wasn't let in (a waiting room, or the meeting ID didn't work).",
  call_busy: 'The dial-in number was busy.',
  call_no_answer: "The dial-in number didn't answer.",
  call_failed: "The call to the dial-in number didn't go through.",
  call_canceled: 'The call was cancelled before it connected.',
  meeting_over: 'The meeting was already over.',
  not_ready: 'Its dial-in or brief was missing.',
  not_configured: "Meeting calls aren't set up on this server.",
  accept_failed: "The call couldn't be answered.",
  bridge_failed: 'The call dropped as it joined.',
}

/** The status line. Pure. */
export function attendanceStatusLine(status: AttendanceStatusName, detail: string | null): string {
  switch (status) {
    case 'draft':
      return 'Not sent yet.'
    case 'scheduled':
      return 'Will dial in at the start.'
    case 'dialling':
      return 'Calling in…'
    case 'in_meeting':
      return 'In the meeting now.'
    case 'ended':
      return detail === 'time_limit' ? 'Attended, and left at its time limit.' : detail === 'nothing_said' ? 'Attended. Nobody spoke, so there are no notes.' : 'Attended. The notes are in your captures.'
    case 'objected':
      return 'Left early: someone objected to it being there.'
    case 'cancelled':
      return detail === 'series_removed' ? 'Cancelled: you stopped the series.' : 'Cancelled.'
    case 'failed': {
      const refused = detail?.startsWith('dial_refused') ? "The call couldn't be placed." : null
      return `Couldn't attend. ${refused ?? FAILED_BECAUSE[detail ?? ''] ?? 'Something went wrong.'}`
    }
  }
}

/** Which actions the person has on one. Pure. */
export function attendanceActions(status: AttendanceStatusName, fromSeries: boolean): Array<'cancel' | 'skip' | 'pull_out'> {
  if (status === 'draft' || status === 'scheduled') return [fromSeries ? 'skip' : 'cancel']
  if (status === 'dialling' || status === 'in_meeting') return ['pull_out']
  return []
}
