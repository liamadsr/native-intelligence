/**
 * A customer's booking through the approvals (roadmap B4): its card asks in
 * the owner's home thread and the reach router takes it to their phone; the
 * owner's yes runs confirm_booking (never a registry tool) after the
 * booking's own re-check; a no or a lapse settles the booking. The booking
 * module is mocked: ../../customers/__tests__/booking.test.ts covers it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  home: vi.fn(async () => ({ written: true, conversationId: 'home-conv' })),
  createTools: vi.fn(() => ({})),
  permits: vi.fn(async () => true),
  confirm: vi.fn(async () => ({ success: true, booking_id: 'b-1', message: 'Booked' })),
  settle: vi.fn(async () => {}),
}))
vi.mock('@/lib/ai/tools', () => ({ createTools: mocks.createTools }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }), executeExternalMcpCall: vi.fn() }))
vi.mock('@/lib/chat/chat-ceiling', () => ({
  isToolExcludedForSurface: () => false,
  resolveAgentToolCeiling: async () => null,
  resolveChatCeiling: async () => null,
  resolveTeammateChatBounds: async () => null,
  resolveTeammateChatCeiling: async () => new Set(),
}))
vi.mock('@/lib/flows/run-skill', () => ({ computeSkillCeiling: () => null }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: mocks.home }))
vi.mock('@/lib/work/agent-paused', () => ({ isAgentPaused: async () => false }))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: vi.fn(async () => 1) }))
const reach = vi.hoisted(() => ({ request: vi.fn(async () => {}), pending: [] as Promise<unknown>[] }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: reach.request }))
vi.mock('../approval-turn', () => ({ requestApprovalTurn: vi.fn(async () => {}) }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  deferLogWrite: (work: Promise<unknown>) => void reach.pending.push(work),
}))
vi.mock('@/lib/customers/booking', () => ({
  CONFIRM_BOOKING_TOOL: 'confirm_booking',
  bookingApprovalPermits: mocks.permits,
  confirmBooking: mocks.confirm,
  settleBookingApproval: mocks.settle,
}))

import { approvalCeilingPermits, approveToolCall, askHomeText, createToolApproval, denyToolCall, executeStoredCall, expireLapsedApprovals, type NewApproval } from '../approvals'

const OWNER = 'user-owner'
const WS = 'ws-rug'
const owner = { callerClass: 'person' as const, userId: OWNER }
let db: FakeSupabase

const booking: NewApproval = {
  door: 'chat',
  userId: OWNER,
  workspaceId: WS,
  toolName: 'confirm_booking',
  sideEffect: 'external-write',
  input: { booking_id: 'b-1', when: 'Mon, Nov 2, 10:00 AM', customer: 'Sarah Lee' },
  conversationId: null,
  context: { booking: { bookingId: 'b-1' }, tools: { origin: { actor: 'agent', depth: 1 } }, guest: { guestId: 'g-sarah', name: 'Sarah Lee' } },
  reason: 'customer_booking',
  card: { title: 'Pickup for Sarah Lee, Mon, Nov 2, 10:00 AM', why: 'Sarah Lee picked this time by text.' },
}

async function raise(approval: NewApproval = booking) {
  const created = await createToolApproval(db as never, approval)
  if (!created.ok) throw new Error(created.error)
  const card = db.rows('attention_item').find((row) => row.id === created.cardId)! as { workspace_id: string; payload: unknown }
  return { created, card }
}

beforeEach(() => {
  // project: an update().select() answers the named columns, as PostgREST does (deny reads the context back).
  db = makeFakeSupabase({ project: true })
  db.seed('member', [{ id: 'member-1', user_id: OWNER, workspace_id: WS }])
  for (const m of Object.values(mocks)) m.mockClear()
  mocks.permits.mockResolvedValue(true)
  reach.request.mockClear()
  reach.pending.length = 0
})

describe("the owner's card", () => {
  it('asks in their home thread (nobody is in a chat) and is routed to their phone', async () => {
    const { created } = await raise()
    expect(mocks.home).toHaveBeenCalledOnce()
    await Promise.all(reach.pending)
    expect(reach.request).toHaveBeenCalledWith({ userId: OWNER, workspaceId: WS, conversationId: 'home-conv' }, `approval:${created.approvalId}`)
  })

  it("says it's a customer's booking, by text or from the booking page", () => {
    expect(askHomeText(booking)).toBe('Sarah Lee asked to book this by text. Nothing is booked: it waits for your yes.')
    expect(askHomeText({ ...booking, context: { booking: { bookingId: 'b-1' } } })).toBe('A customer asked to book this on your booking page. Nothing is booked: it waits for your yes.')
  })
})

describe('the yes', () => {
  it("re-checks the booking itself, then confirms it: never through createTools", async () => {
    const { card } = await raise()
    const out = await approveToolCall(db as never, owner, card)
    expect(out).toMatchObject({ ok: true, success: true })
    expect(mocks.permits).toHaveBeenCalledWith(db, expect.objectContaining({ tool: 'confirm_booking', context: expect.objectContaining({ booking: { bookingId: 'b-1' } }) }))
    expect(mocks.confirm).toHaveBeenCalledWith(db, { userId: OWNER, workspaceId: WS, bookingId: 'b-1' })
    expect(mocks.createTools).not.toHaveBeenCalled()
  })

  it('a booking no longer waiting refuses the yes: nothing runs', async () => {
    mocks.permits.mockResolvedValue(false)
    const { card } = await raise()
    expect(await approveToolCall(db as never, owner, card)).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('a booking context only ever runs confirm_booking, and only on the chat door', async () => {
    expect(await executeStoredCall(db as never, { workspace_id: WS, user_id: OWNER, tool: 'delete_action', input: {}, conversation_id: null, door: 'chat', context: { booking: { bookingId: 'b-1' } }, skill_id: null })).toMatchObject({ success: false })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(await approvalCeilingPermits(db as never, { door: 'skill_run', workspace_id: WS, user_id: OWNER, tool: 'confirm_booking', skill_id: 's', context: { booking: { bookingId: 'b-1' } } })).toBe(false)
  })

  it("the tool is no registry tool: without its booking context it can't be approved into running", async () => {
    expect(await approvalCeilingPermits(db as never, { door: 'chat', workspace_id: WS, user_id: OWNER, tool: 'confirm_booking', skill_id: null, context: {} })).toBe(false)
  })
})

describe('caps', () => {
  it("customers' bookings have their own cap, and never use up the owner's", async () => {
    for (let i = 0; i < 10; i++) await raise({ ...booking, input: { booking_id: `b-${i}` }, context: { ...booking.context, booking: { bookingId: `b-${i}` } } })
    expect(await createToolApproval(db as never, { ...booking, input: { booking_id: 'b-x' }, context: { booking: { bookingId: 'b-x' } } })).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
    // The owner's own agent can still hold its calls.
    expect(await createToolApproval(db as never, { ...booking, toolName: 'delete_action', sideEffect: 'delete', input: { action_id: 'GEN-1' }, context: {} })).toMatchObject({ ok: true })
  })
})

describe('the no, and no answer', () => {
  it('a no settles the booking as denied', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, owner, card)
    expect(mocks.settle).toHaveBeenCalledWith(db, { workspace_id: WS, context: expect.objectContaining({ booking: { bookingId: 'b-1' } }) }, 'denied')
  })

  it('a lapsed approval settles it as expired', async () => {
    const { created } = await raise()
    const row = db.rows('tool_approval').find((r) => r.id === created.approvalId)!
    row.expires_at = new Date(Date.now() - 60_000).toISOString()
    expect(await expireLapsedApprovals(db as never)).toBe(1)
    expect(mocks.settle).toHaveBeenCalledWith(db, { workspace_id: WS, context: expect.objectContaining({ booking: { bookingId: 'b-1' } }) }, 'expired')
  })

  it('any other approval settles no booking', async () => {
    const { card } = await raise({ ...booking, toolName: 'delete_action', sideEffect: 'delete', context: {} })
    await denyToolCall(db as never, owner, card)
    expect(mocks.settle).not.toHaveBeenCalled()
  })
})
