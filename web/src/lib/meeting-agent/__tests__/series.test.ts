import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const { listSeries, pauseSeries, publicSeries, removeSeries, saveSeries, seriesIdOf, sweepSeries, SERIES_LOOKAHEAD_MS } = await import('@/lib/meeting-agent/series')
const { attendanceRow, fakeDb, ME, WS } = await import('./fake-db')

const NOW = Date.parse('2026-11-30T12:00:00.000Z')
const BRIEF = { goals: ['Keep the standup short'], may_share: [], ask: ['Any blockers?'], must_not_agree: [] }

function seriesRow(over: Record<string, unknown> = {}) {
  return { id: 'ser-1', workspace_id: WS, user_id: ME, series_id: 'master-1', title: 'Weekly standup', brief: BRIEF, brief_approved_at: '2026-11-29T10:00:00.000Z', dial_in_number: null, dial_in_pin: null, paused_at: null, created_at: '2026-11-29T10:00:00.000Z', ...over }
}
function occurrence(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_1_20261201T150000Z',
    title: 'Weekly standup',
    start: '2026-12-01T15:00:00.000Z',
    end: '2026-12-01T15:15:00.000Z',
    seriesMasterId: 'master-1',
    description: 'Google Meet +1 555 555 0142 PIN: 123 456 789#',
    ...over,
  }
}

describe('a recurring meeting', () => {
  it('is known by its series master id', () => {
    expect(seriesIdOf({ seriesMasterId: 'master-1' })).toBe('master-1')
    expect(seriesIdOf({})).toBeNull()
    expect(seriesIdOf({ seriesMasterId: '  ' })).toBeNull()
  })

  it('is saved once per person per series, approved now, and turned back on when saved again', async () => {
    const db = fakeDb()
    const s = await saveSeries(db.client, { workspaceId: WS, userId: ME, seriesId: 'master-1', title: 'Weekly standup', brief: BRIEF as never }, new Date(NOW))
    expect(s).toMatchObject({ seriesId: 'master-1', brief: BRIEF, pausedAt: null })
    expect(db.tables.meeting_attendance_series[0]).toMatchObject({ brief_approved_at: new Date(NOW).toISOString(), dial_in_number: null })
    db.tables.meeting_attendance_series[0].paused_at = '2026-11-30T00:00:00.000Z'
    await saveSeries(db.client, { workspaceId: WS, userId: ME, seriesId: 'master-1', title: 'Standup', brief: BRIEF as never, dialIn: { number: '+15555550142', digits: 'wwww1#' } })
    expect(db.tables.meeting_attendance_series).toHaveLength(1)
    expect(db.tables.meeting_attendance_series[0]).toMatchObject({ paused_at: null, title: 'Standup', dial_in_number: '+15555550142' })
    expect(publicSeries((await listSeries(db.client, { workspaceId: WS, userId: ME }))[0])).toMatchObject({ hasPin: true })
    expect(JSON.stringify(publicSeries((await listSeries(db.client, { workspaceId: WS, userId: ME }))[0]))).not.toContain('wwww1#')
  })

  it('pauses and is removed only by its person; removing cancels the occurrences it scheduled that have not started', async () => {
    const db = fakeDb({
      meeting_attendance_series: [seriesRow()],
      meeting_attendance: [attendanceRow({ id: 'a1', series_ref: 'ser-1', status: 'scheduled' }), attendanceRow({ id: 'a2', series_ref: 'ser-1', status: 'in_meeting' }), attendanceRow({ id: 'a3', status: 'scheduled' })],
    })
    expect(await pauseSeries(db.client, { workspaceId: WS, userId: 'user-other', id: 'ser-1' }, true)).toBe(false)
    expect(await pauseSeries(db.client, { workspaceId: WS, userId: ME, id: 'ser-1' }, true, new Date(NOW))).toBe(true)
    expect(db.tables.meeting_attendance_series[0].paused_at).toBe(new Date(NOW).toISOString())
    expect(await removeSeries(db.client, { workspaceId: WS, userId: 'user-other', id: 'ser-1' })).toBe(false)
    expect(await removeSeries(db.client, { workspaceId: WS, userId: ME, id: 'ser-1' })).toBe(true)
    expect(db.tables.meeting_attendance_series).toHaveLength(0)
    expect(db.tables.meeting_attendance.map((r) => [r.id, r.status])).toEqual([['a1', 'cancelled'], ['a2', 'in_meeting'], ['a3', 'scheduled']])
  })
})

describe('the series sweep', () => {
  it("sends each upcoming occurrence of the person's series with its brief, from the invite's dial-in, a day and a half ahead", async () => {
    const db = fakeDb({ meeting_attendance_series: [seriesRow()] })
    const list = vi.fn(async () => [occurrence(), occurrence({ id: 'other', seriesMasterId: 'master-2' }), occurrence({ id: 'oneoff', seriesMasterId: undefined })])
    const send = vi.fn(async () => ({ ok: true as const, attendance: {} as never }))
    const out = await sweepSeries(db.client, { list: list as never, send: send as never, now: () => NOW })
    expect(out).toEqual({ series: 1, sent: 1, known: 0, noDialIn: 0, failed: 0 })
    const [userId, window] = list.mock.calls[0] as unknown as [string, { timeMin: string; timeMax: string }]
    expect(userId).toBe(ME)
    expect(Date.parse(window.timeMax) - NOW).toBe(SERIES_LOOKAHEAD_MS)
    expect((send.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]).toMatchObject({
      workspaceId: WS,
      userId: ME,
      calendarEventId: 'evt_1_20261201T150000Z',
      startsAt: '2026-12-01T15:00:00.000Z',
      brief: BRIEF,
      seriesRef: 'ser-1',
      dialIn: { number: '+15555550142', digits: 'wwwwww123456789#' },
    })
  })

  it("never sends an occurrence that already has a row: a skipped (cancelled) one stays skipped", async () => {
    const db = fakeDb({ meeting_attendance_series: [seriesRow()], meeting_attendance: [attendanceRow({ calendar_event_id: 'evt_1_20261201T150000Z', starts_at: '2026-12-01T15:00:00+00:00', status: 'cancelled' })] })
    const send = vi.fn()
    const out = await sweepSeries(db.client, { list: vi.fn(async () => [occurrence()]) as never, send: send as never, now: () => NOW })
    expect(out.known).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it("uses the person's own dial-in for the series when they gave one, and skips an occurrence with none", async () => {
    const own = fakeDb({ meeting_attendance_series: [seriesRow({ dial_in_number: '+15555550143', dial_in_pin: 'wwwwww987#' })] })
    const send = vi.fn(async () => ({ ok: true as const, attendance: {} as never }))
    await sweepSeries(own.client, { list: vi.fn(async () => [occurrence({ description: '' })]) as never, send: send as never, now: () => NOW })
    expect((send.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]).toMatchObject({ dialIn: { number: '+15555550143', digits: 'wwwwww987#' } })
    const none = fakeDb({ meeting_attendance_series: [seriesRow()] })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(await sweepSeries(none.client, { list: vi.fn(async () => [occurrence({ description: '' })]) as never, send: vi.fn() as never, now: () => NOW })).toMatchObject({ noDialIn: 1, sent: 0 })
    info.mockRestore()
  })

  it('a paused series, a cancelled occurrence, and one about to start are left alone; one calendar failing never stops the rest', async () => {
    const db = fakeDb({ meeting_attendance_series: [seriesRow({ paused_at: '2026-11-30T00:00:00.000Z' }), seriesRow({ id: 'ser-2', user_id: 'user-other', series_id: 'master-9' }), seriesRow({ id: 'ser-3', user_id: 'user-3', series_id: 'master-1' })] })
    const list = vi.fn(async (userId: string) => {
      if (userId === 'user-other') throw new Error('token expired')
      return [occurrence({ status: 'cancelled' }), occurrence({ id: 'soon', start: new Date(NOW + 60_000).toISOString() })]
    })
    const send = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await sweepSeries(db.client, { list: list as never, send: send as never, now: () => NOW })
    warn.mockRestore()
    expect(out).toMatchObject({ series: 2, sent: 0, failed: 1 })
    expect(list).not.toHaveBeenCalledWith(ME, expect.anything())
    expect(send).not.toHaveBeenCalled()
  })
})
