/**
 * The tool route's guest branch: the guest is read live (removed or not
 * theirs: refused), the tool must be one the owner gave them, the guest
 * class decides, an internal write under "any change at all" or on Needs
 * approval is the owner's card all the same (held before any review), and
 * everything runs as the owner's tools with the guest's
 * dispatch: the guest caller, the owner's home thread for cards, and the
 * text-turn hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGuest } from '../store'

const h = vi.hoisted(() => ({
  guest: null as unknown,
  runTool: vi.fn(),
  createTools: vi.fn(() => ({ create_calendar_event: { execute: vi.fn() } })),
  events: [] as unknown[],
}))

vi.mock('../guest-turn', async (orig) => ({
  ...(await orig<typeof import('../guest-turn')>()),
  loadGuestTurn: vi.fn(async () => h.guest),
}))
vi.mock('@/lib/chat/chat-tool-dispatch', () => ({ runTool: h.runTool }))
vi.mock('@/lib/ai/tools', () => ({ createTools: h.createTools }))
vi.mock('@/lib/integrations/calendar', () => ({ listCalendarEventsUnified: vi.fn(async () => h.events) }))
vi.mock('@/lib/agent-events/member-time-zone', () => ({ readMemberTimeZone: vi.fn(async () => ({ timeZone: 'America/Los_Angeles', source: 'member' })) }))

import { GUEST_PAYMENT_STOP, freeBusyRange, guestApprovalContext, guestDispatchContext, guestToolCall, parseRangeEdge, withGuestPaymentStop } from '../guest-tools'

const CLAIMS = {
  conversationId: 'conv-g',
  userId: 'owner-1',
  workspaceId: 'ws-1',
  server: 'channel_turn' as const,
  surface: 'sms' as const,
  guestId: 'g1',
  exp: Date.now() + 60_000,
} as never

function guest(over: Partial<AgentGuest> = {}): AgentGuest {
  return {
    id: 'g1',
    ownerUserId: 'owner-1',
    workspaceId: 'ws-1',
    displayName: 'Sam',
    phone: '+15551234567',
    channels: ['sms'],
    phoneBoundAt: null,
    slackTeamId: null,
    slackUserId: null,
    peerUserId: null,
    peerBoundAt: null,
    calendarEmails: [],
    businessNumberId: null,
    contactId: null,
    preset: 'colleague',
    tools: ['get_free_busy', 'create_calendar_event', 'message_owner', 'ask_owner_agent', 'remember_about_guest'],
    askTools: ['create_calendar_event'],
    askBefore: ['payments', 'deletes', 'changes'],
    notes: null,
    state: 'active',
    inviteExpiresAt: null,
    requestedAt: null,
    activatedAt: null,
    removedAt: null,
    optedOut: false,
    lastInboundAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    ...over,
  }
}

const supabase = {} as never

beforeEach(() => {
  h.guest = guest()
  h.runTool.mockReset()
  h.runTool.mockResolvedValue(new Response(JSON.stringify({ output: { ok: true } })))
  h.events = []
})

describe('guestToolCall', () => {
  it('a guest who is gone (removed, not theirs, not their thread) gets nothing', async () => {
    h.guest = null
    const res = await guestToolCall(supabase, CLAIMS, 'get_free_busy', { input: {} })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'GUEST_UNAVAILABLE' })
  })

  it('only the tools the owner gave them: anything else, the owner’s mail or memory included, is out of the ceiling', async () => {
    for (const tool of ['list_emails', 'remember', 'get_calendar_events', 'send_bot_message', 'mcp__gmail__send']) {
      const res = await guestToolCall(supabase, CLAIMS, tool, { input: {} })
      expect(res.status, tool).toBe(403)
      expect((await res.json()).code, tool).toBe('TOOL_OUT_OF_CEILING')
    }
    expect(h.runTool).not.toHaveBeenCalled()
  })

  it('a tool the owner set to Needs approval asks, even an internal write the class would run: the owner’s card, through runTool', async () => {
    h.guest = guest({ tools: ['create_action', 'message_owner', 'ask_owner_agent', 'remember_about_guest'], askTools: ['create_action'], askBefore: [] })
    await guestToolCall(supabase, CLAIMS, 'create_action', { input: { title: 'x' } })
    expect(h.runTool).toHaveBeenCalledTimes(1)
    const [ctx, tool, input, , , options] = h.runTool.mock.calls[0]
    expect(tool).toBe('create_action')
    expect(input).toEqual({ title: 'x' })
    expect(ctx).toMatchObject({ caller: 'guest', cardConversationId: null, approvalContext: { guest: { guestId: 'g1', name: 'Sam' } } })
    expect(typeof options?.gate).toBe('function')
  })

  it('an internal write the owner left on Always allow (no asks) runs through the normal gate', async () => {
    h.guest = guest({ tools: ['create_action', 'message_owner', 'ask_owner_agent', 'remember_about_guest'], askTools: [], askBefore: [] })
    await guestToolCall(supabase, CLAIMS, 'create_action', { input: { title: 'x' } })
    expect(h.runTool.mock.calls[0][5]).toEqual({})
  })

  it('the owner tools run here, with their input checked', async () => {
    const res = await guestToolCall(supabase, CLAIMS, 'ask_owner_agent', { input: {} })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INPUT_INVALID')
    expect(h.runTool).not.toHaveBeenCalled()
  })

  it('an internal write under "any change at all" is the owner’s card too, never refused', async () => {
    h.guest = guest({ tools: ['create_action', 'message_owner', 'ask_owner_agent'] })
    await guestToolCall(supabase, CLAIMS, 'create_action', { input: { title: 'x' } })
    expect(h.runTool).toHaveBeenCalledTimes(1)
    expect(typeof h.runTool.mock.calls[0][5]?.gate).toBe('function')
  })

  it('a risky call keeps the reviewer’s text hold, not the internal-write gate', async () => {
    await guestToolCall(supabase, CLAIMS, 'create_calendar_event', { input: { title: 'Lunch' } })
    expect(h.runTool.mock.calls[0][5]).toEqual({})
  })

  it('a risky call runs through the gate as the guest: cards in the owner’s home thread, the text-turn hold, the owner’s tools', async () => {
    await guestToolCall(supabase, CLAIMS, 'create_calendar_event', { input: { title: 'Lunch' } })
    expect(h.runTool).toHaveBeenCalledTimes(1)
    const [ctx, tool] = h.runTool.mock.calls[0]
    expect(tool).toBe('create_calendar_event')
    expect(ctx).toMatchObject({
      userId: 'owner-1',
      workspaceId: 'ws-1',
      caller: 'guest',
      cardConversationId: null,
      approvalContext: { guest: { guestId: 'g1', name: 'Sam' } },
      reviewOverride: { alwaysHold: { reason: 'guest_text' } },
    })
    expect(h.createTools).toHaveBeenCalledWith('owner-1', supabase, 'ws-1', undefined, expect.objectContaining({ origin: { actor: 'agent', depth: 1 } }))
  })

  it('a delete waits for the owner while the person’s deletes ask first, and runs without the hold once the owner turned that off and allowed the tool', async () => {
    const tools = ['delete_calendar_event', 'message_owner', 'ask_owner_agent', 'remember_about_guest']
    h.guest = guest({ tools, askTools: ['delete_calendar_event'], askBefore: ['payments', 'deletes'] })
    await guestToolCall(supabase, CLAIMS, 'delete_calendar_event', { input: { eventId: 'e1' } })
    expect(h.runTool.mock.calls[0][0]).toMatchObject({ reviewOverride: { alwaysHold: { reason: 'guest_text' } } })

    // Off, but the tool still on Needs approval: still the owner's card.
    h.guest = guest({ tools, askTools: ['delete_calendar_event'], askBefore: ['payments'] })
    await guestToolCall(supabase, CLAIMS, 'delete_calendar_event', { input: { eventId: 'e1' } })
    expect(h.runTool.mock.calls[1][0]).toMatchObject({ reviewOverride: { alwaysHold: { reason: 'guest_text' } } })

    // Off and Always allow: it runs, through the reviewer, with no hold.
    h.guest = guest({ tools, askTools: [], askBefore: ['payments'] })
    await guestToolCall(supabase, CLAIMS, 'delete_calendar_event', { input: { eventId: 'e1' } })
    const ctx = h.runTool.mock.calls[2][0]
    expect(ctx.caller).toBe('guest')
    expect(ctx.reviewOverride).toBeUndefined()
  })

  it('an outward call on Needs approval keeps the hold whatever the person’s asks', async () => {
    h.guest = guest({ askTools: ['create_calendar_event'], askBefore: [] })
    await guestToolCall(supabase, CLAIMS, 'create_calendar_event', { input: { title: 'Lunch' } })
    expect(h.runTool.mock.calls[0][0]).toMatchObject({ reviewOverride: { alwaysHold: { reason: 'guest_text' } } })
  })

  it('a browser task keeps its card while "Paying for anything asks you first" is on, whatever its own row says', async () => {
    const tools = ['run_browser_task', 'message_owner', 'ask_owner_agent', 'remember_about_guest']
    h.guest = guest({ tools, askTools: [], askBefore: ['payments'] })
    await guestToolCall(supabase, CLAIMS, 'run_browser_task', { input: { goal: 'Book a table' } })
    expect(h.runTool.mock.calls[0][0]).toMatchObject({ reviewOverride: { alwaysHold: { reason: 'guest_text' } } })
    h.runTool.mockClear()
    h.guest = guest({ tools, askTools: [], askBefore: [] })
    await guestToolCall(supabase, CLAIMS, 'run_browser_task', { input: { goal: 'Book a table' } })
    expect(h.runTool.mock.calls[0][0]).not.toHaveProperty('reviewOverride')
  })

  // Liam, 2026-11-02: "I should be able to decide what she can do".
  it('an outward call or a delete the owner set to Always allow runs without the hold; "any change at all" still holds it', async () => {
    const tools = ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'message_owner', 'ask_owner_agent', 'remember_about_guest']
    for (const tool of ['update_calendar_event', 'delete_calendar_event']) {
      h.runTool.mockClear()
      h.guest = guest({ tools, askTools: ['create_calendar_event'], askBefore: ['payments', 'deletes'] })
      await guestToolCall(supabase, CLAIMS, tool, { input: { event_id: 'e1' } })
      expect(h.runTool.mock.calls[0][0], tool).not.toHaveProperty('reviewOverride')
      expect(h.runTool.mock.calls[0][5], tool).toEqual({})
    }
    h.runTool.mockClear()
    h.guest = guest({ tools, askTools: [], askBefore: ['payments', 'changes'] })
    await guestToolCall(supabase, CLAIMS, 'update_calendar_event', { input: { event_id: 'e1' } })
    expect(h.runTool.mock.calls[0][0]).toMatchObject({ reviewOverride: { alwaysHold: { reason: 'guest_text' } } })
  })

  it('a booking stops before paying while payments ask first, and the card shows the goal as it will run', async () => {
    const tools = ['run_browser_task', 'message_owner', 'ask_owner_agent', 'remember_about_guest']
    h.guest = guest({ tools, askTools: ['run_browser_task'], askBefore: ['payments', 'deletes'] })
    await guestToolCall(supabase, CLAIMS, 'run_browser_task', { input: { goal: 'Book a table for 2 at 7pm' } })
    expect(h.runTool.mock.calls[0][2]).toEqual({ goal: `Book a table for 2 at 7pm\n\n${GUEST_PAYMENT_STOP}` })

    h.guest = guest({ tools, askTools: ['run_browser_task'], askBefore: ['deletes'] })
    await guestToolCall(supabase, CLAIMS, 'run_browser_task', { input: { goal: 'Book a table for 2 at 7pm' } })
    expect(h.runTool.mock.calls[1][2]).toEqual({ goal: 'Book a table for 2 at 7pm' })
  })

  it('get_free_busy set to Needs approval never runs: the agent is told to ask the owner', async () => {
    h.guest = guest({ tools: ['get_free_busy', 'message_owner', 'ask_owner_agent', 'remember_about_guest'], askTools: ['get_free_busy'], askBefore: [] })
    h.events = [{ start: '2026-10-27T17:00:00.000Z', end: '2026-10-27T18:00:00.000Z', title: 'Therapy', location: 'Dr. K', attendees: [] }]
    const res = await guestToolCall(supabase, CLAIMS, 'get_free_busy', { input: {} })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('OWNER_ASKS_FIRST')
    expect(JSON.stringify(body)).not.toMatch(/17:00|Therapy/)
  })

  it('get_free_busy answers busy blocks only, never what an event is', async () => {
    h.events = [{ start: '2026-10-27T17:00:00.000Z', end: '2026-10-27T18:00:00.000Z', title: 'Therapy', location: 'Dr. K', attendees: ['k@example.com'] }]
    const res = await guestToolCall(supabase, CLAIMS, 'get_free_busy', { input: { from: '2026-10-27', to: '2026-10-27' } })
    const { output } = await res.json()
    expect(output).toMatchObject({ success: true, time_zone: 'America/Los_Angeles', busy: [{ start: '2026-10-27T17:00:00.000Z', end: '2026-10-27T18:00:00.000Z' }] })
    expect(JSON.stringify(output)).not.toMatch(/Therapy|Dr\. K|example/)
  })
})

describe('the free/busy range', () => {
  it('a bare date is midnight in the owner’s zone, and a bare end date is through that day', () => {
    expect(new Date(parseRangeEdge('2026-10-27', 'America/Los_Angeles')!).toISOString()).toBe('2026-10-27T07:00:00.000Z')
    const range = freeBusyRange({ from: '2026-10-27', to: '2026-10-27' }, 'America/Los_Angeles', 0)
    expect(range).toEqual({ from: Date.parse('2026-10-27T07:00:00.000Z'), to: Date.parse('2026-10-28T07:00:00.000Z') })
  })

  it('defaults to a week from now, and refuses a bad or too-long range', () => {
    expect(freeBusyRange({}, 'UTC', 1000)).toEqual({ from: 1000, to: 1000 + 7 * 24 * 60 * 60_000 })
    expect(freeBusyRange({ from: 'soon' }, 'UTC', 0)).toHaveProperty('error')
    expect(freeBusyRange({ from: '2026-10-28', to: '2026-10-27' }, 'UTC', 0)).toHaveProperty('error')
    expect(freeBusyRange({ from: '2026-10-01', to: '2026-12-01' }, 'UTC', 0)).toHaveProperty('error')
  })
})

it('the dispatch context keys its per-turn guards by the guest, never the owner', () => {
  expect(guestDispatchContext(supabase, CLAIMS, guest()).keyScope).toBe('guest:g1')
})

it('the payment stop: only on a browser task, once, and missing asks read as asking', () => {
  expect(withGuestPaymentStop('create_action', { goal: 'x' }, ['payments'])).toEqual({ goal: 'x' })
  expect(withGuestPaymentStop('run_browser_task', { goal: 'x' }, null)).toEqual({ goal: `x\n\n${GUEST_PAYMENT_STOP}` })
  expect(withGuestPaymentStop('run_browser_task', { goal: 'x' }, ['changes'])).toEqual({ goal: `x\n\n${GUEST_PAYMENT_STOP}` })
  const once = withGuestPaymentStop('run_browser_task', { goal: 'x' }, ['payments'])
  expect(withGuestPaymentStop('run_browser_task', once, ['payments'])).toEqual(once)
})

it("a guest's or a linked agent's held call records omitGrants, so its approved replay reads no grant of the owner's", () => {
  const guest = { id: 'g-1', displayName: 'Kai' }
  expect(guestApprovalContext(guest).tools).toEqual({ origin: { actor: 'agent', depth: 1 }, omitGrants: true })
  expect(guestApprovalContext(guest, { linkId: 'l-1' } as never).tools).toMatchObject({ omitGrants: true })
})
