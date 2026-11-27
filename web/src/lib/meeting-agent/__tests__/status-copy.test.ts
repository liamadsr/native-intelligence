import { describe, expect, it } from 'vitest'
import { attendanceActions, attendanceStatusLine } from '@/lib/meeting-agent/status-copy'

describe("what the person reads about their assistant", () => {
  it('one plain line per status', () => {
    expect(attendanceStatusLine('scheduled', null)).toBe('Will dial in at the start.')
    expect(attendanceStatusLine('dialling', null)).toBe('Calling in…')
    expect(attendanceStatusLine('in_meeting', null)).toBe('In the meeting now.')
    expect(attendanceStatusLine('ended', null)).toBe('Attended. The notes are in your captures.')
    expect(attendanceStatusLine('ended', 'time_limit')).toContain('time limit')
    expect(attendanceStatusLine('ended', 'nothing_said')).toContain('no notes')
    expect(attendanceStatusLine('objected', null)).toContain('someone objected')
    expect(attendanceStatusLine('cancelled', 'series_removed')).toContain('stopped the series')
  })
  it("says why it couldn't attend", () => {
    expect(attendanceStatusLine('failed', 'not_let_in')).toBe("Couldn't attend. It called in but wasn't let in (a waiting room, or the meeting ID didn't work).")
    expect(attendanceStatusLine('failed', 'dial_refused:21215')).toBe("Couldn't attend. The call couldn't be placed.")
    expect(attendanceStatusLine('failed', 'something_new')).toBe("Couldn't attend. Something went wrong.")
  })
  it('offers cancel before, skip for a series, pull out during, nothing after', () => {
    expect(attendanceActions('scheduled', false)).toEqual(['cancel'])
    expect(attendanceActions('scheduled', true)).toEqual(['skip'])
    expect(attendanceActions('in_meeting', false)).toEqual(['pull_out'])
    expect(attendanceActions('dialling', true)).toEqual(['pull_out'])
    expect(attendanceActions('ended', false)).toEqual([])
    expect(attendanceActions('failed', true)).toEqual([])
  })
})
