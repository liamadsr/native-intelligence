import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn() }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn() }))

const { askOwner, meetingAskMessageId, meetingAskText, MEETING_ASK_URGENT_MS } = await import('@/lib/meeting-agent/ask')
const { MEETING_ASK_MESSAGE_KIND } = await import('@/lib/meeting-agent/message-kind')
const { attendanceOfRow } = await import('@/lib/meeting-agent/store')
const { attendanceRow } = await import('./fake-db')

const attendance = attendanceOfRow(attendanceRow() as never)
const NOW = Date.parse('2026-11-30T18:10:00.000Z')

describe('"I\'ll check with <Name>"', () => {
  it('writes one urgent message to the home thread, records the ask, and routes it', async () => {
    const append = vi.fn(async () => ({ written: true, conversationId: 'conv-1' }))
    const route = vi.fn(async () => {})
    const record = vi.fn(async () => {})
    const ok = await askOwner({} as never, { attendance, delegationId: 'd7', question: 'Can we start Monday?' }, { append: append as never, route: route as never, record: record as never, now: () => NOW })
    expect(ok).toBe(true)
    const msg = (append.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]
    expect(msg.messageId).toBe(meetingAskMessageId(attendance.id, 'd7'))
    expect(msg.metadata).toEqual({ kind: MEETING_ASK_MESSAGE_KIND, meeting_attendance_id: attendance.id, urgent_by: new Date(NOW + MEETING_ASK_URGENT_MS).toISOString() })
    expect(JSON.stringify(msg.parts)).toContain('Can we start Monday?')
    expect(record).toHaveBeenCalledWith({}, attendance.id, { at: new Date(NOW).toISOString(), question: 'Can we start Monday?', messageId: msg.messageId })
    expect(route).toHaveBeenCalledWith({ userId: attendance.userId, workspaceId: attendance.workspaceId, conversationId: 'conv-1' }, msg.messageId)
  })
  it('an ask that could not be written is not routed, and never throws', async () => {
    const route = vi.fn()
    expect(await askOwner({} as never, { attendance, delegationId: 'd', question: 'q' }, { append: vi.fn(async () => ({ written: false, reason: 'error' })) as never, route, record: vi.fn() })).toBe(false)
    expect(route).not.toHaveBeenCalled()
    expect(await askOwner({} as never, { attendance, delegationId: 'd', question: 'q' }, { append: vi.fn(async () => { throw new Error('db') }) as never, route })).toBe(false)
  })
  it("names the meeting and the question in the person's words", () => {
    expect(meetingAskText({ title: 'Pilot review', question: 'Can we start Monday?' })).toBe("From Pilot review, where I'm attending for you: Can we start Monday? Reply here and I'll keep it in the notes.")
    expect(meetingAskText({ title: '', question: '' })).toContain('something came up that needs you')
  })
})
