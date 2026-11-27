import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  found: null as null | { event: Record<string, unknown>; dialIn: { number: string; digits: string; platform: string } | null },
  approvals: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ svc: true }) }))
vi.mock('@/lib/meeting-agent/lookup', () => ({ findMeeting: async () => h.found }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_svc: unknown, a: Record<string, unknown>) => (h.approvals.push(a), { ok: true, approvalId: 'appr-1' }),
}))
vi.mock('@/lib/meeting-agent/send', () => ({
  sendAgentToMeeting: async (_svc: unknown, input: Record<string, unknown>) => (h.sends.push(input), { ok: true, attendance: { id: 'att-1', status: 'scheduled', displayName: "Sam's assistant (AI)" } }),
}))

const { createMeetingAgentTools } = await import('../meeting-agent')

const ON = { MEETING_AGENT: 'on' }
const START = '2026-11-30T18:00:00.000Z'
const INPUT = { calendar_event_id: 'evt_1', starts_at: START, goals: ['Get a yes on the pilot'], ask: ['Who signs off?'], must_not_agree: ['Exclusivity'] }

function tools(opts: Record<string, unknown> = {}) {
  return createMeetingAgentTools('user-me', {} as never, 'ws-1', { env: ON, conversationId: 'conv-1', ...opts })
}
async function call(t: ReturnType<typeof tools>, input: Record<string, unknown>) {
  return (t.send_agent_to_meeting.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, { toolCallId: 'c1', messages: [] })
}

beforeEach(() => {
  h.found = { event: { id: 'evt_1', title: 'Pilot review', start: START, end: '2026-11-30T18:30:00.000Z' }, dialIn: { number: '+15555550142', digits: 'wwwwww123456789#', platform: 'meet' } }
  h.approvals = []
  h.sends = []
})

describe('send_agent_to_meeting', () => {
  it("never sends on its own: the first call raises the person's card with the meeting and the whole brief", async () => {
    const r = await call(tools(), INPUT)
    expect(r).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(h.sends).toEqual([])
    const a = h.approvals[0]
    expect(a).toMatchObject({ door: 'chat', toolName: 'send_agent_to_meeting', sideEffect: 'external-write', conversationId: 'conv-1', userId: 'user-me', workspaceId: 'ws-1' })
    const card = a.card as { title: string; why: string }
    expect(card.title).toBe('Send your assistant to “Pilot review”?')
    expect(card.why).toContain('introduces itself as your AI assistant, says it is taking notes, and leaves if anyone objects')
    expect(card.why).toContain('Goals: Get a yes on the pilot')
    expect(card.why).toContain('Exclusivity')
    expect(card.why).toContain('Any payment, price')
    expect(card.why).not.toContain('5555550142')
  })

  it('sends on the replay of the accepted card, with the meeting as the calendar has it', async () => {
    const r = await call(tools({ approvedCall: { tool: 'send_agent_to_meeting' } }), INPUT)
    expect(r).toMatchObject({ success: true, attendance_id: 'att-1' })
    expect(h.sends[0]).toMatchObject({ calendarEventId: 'evt_1', startsAt: START, endsAt: '2026-11-30T18:30:00.000Z', title: 'Pilot review', dialIn: { number: '+15555550142', digits: 'wwwwww123456789#' } })
    expect(h.approvals).toEqual([])
  })

  it('refuses an unattended run, the setting off, a meeting not on their calendar, an empty brief, and a meeting with no dial-in', async () => {
    expect(await call(tools({ unattended: true }), INPUT)).toMatchObject({ success: false })
    expect(await call(tools({ env: {} }), INPUT)).toMatchObject({ success: false, error: expect.stringContaining('not turned on') })
    expect(await call(tools(), { ...INPUT, goals: [], ask: [] })).toMatchObject({ success: false, error: expect.stringContaining('at least one goal') })
    h.found = { ...h.found!, dialIn: null }
    expect(await call(tools(), INPUT)).toMatchObject({ success: false, code: 'NO_DIAL_IN' })
    h.found = null
    expect(await call(tools(), INPUT)).toMatchObject({ success: false, error: expect.stringContaining("isn't on the person's calendar") })
    expect(h.approvals).toEqual([])
    expect(h.sends).toEqual([])
  })

  it("takes the person's own dial-in when they give one, waiting for the bridge before the digits", async () => {
    h.found = { ...h.found!, dialIn: null }
    await call(tools({ approvedCall: { tool: 'send_agent_to_meeting' } }), { ...INPUT, dial_in_number: '+1 555 555 0143', dial_in_digits: '987 654 321#' })
    expect(h.sends[0]).toMatchObject({ dialIn: { number: '+1 555 555 0143', digits: 'wwwwww987654321#' } })
  })
})
