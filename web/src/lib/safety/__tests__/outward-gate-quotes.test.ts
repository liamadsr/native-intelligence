/**
 * send_quote and book_quote at the outward gate (roadmap F3): every call is
 * the owner's approval card saying exactly who gets what text, whatever the
 * reviewer's mode, with the hash of those words on the approval for the
 * replay (src/lib/customers/quote-reply.ts). By text ("yes CODE") the card is
 * the same one, not the text turn's generic words. Nobody to answer it: a
 * NEEDS_PERSON refusal. A call the tool would refuse anyway: no hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const CARD = { title: 'Text Dana Ruiz their quote, $240?', why: '“Brightside Window Washing: here is your quote: $240. Reply here to pick a time.” by text to +1 (312) 555-0142, …' }
const CONTEXT = { quoteReply: { kind: 'send' as const, quote_id: 'q-1', card_hash: 'abc123' } }
const mocks = vi.hoisted(() => ({
  decide: vi.fn(async (): Promise<unknown> => ({ status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  hold: vi.fn(),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarEventAttendees: async () => null }))
vi.mock('@/lib/email/thread-mailbox', () => ({ mailboxesForThread: async function* () {} }))
vi.mock('@/lib/workspace-member-emails', () => ({ findMembersByEmail: async () => new Map() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/customers/quote-reply', () => ({ quoteReplyHold: mocks.hold }))

import { gateRiskyCall, riskClassOf, type GateRequest } from '../action-review'
import { outwardHoldOf } from '../outward-gate'
import { getToolSideEffect } from '@/lib/ai/tool-registry'

const INPUT = { quote_id: 'q-1', price: 240 }
const base = {
  door: 'chat' as const, userId: 'u-owner', workspaceId: 'w', toolName: 'send_quote', input: INPUT,
  sideEffect: 'external-write' as const, personMessages: ['Send Dana the quote at $240'], source: 'person' as const,
  personMessageSeq: 3, runId: 'conv-1', caller: 'person' as const,
  approval: { supabase: {} as never, conversationId: 'conv-1' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  mocks.approve.mockClear()
  mocks.hold.mockReset().mockResolvedValue({ card: CARD, context: CONTEXT })
  run.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('send_quote and book_quote at the outward gate', () => {
  it('are external writes, always reviewed', () => {
    for (const name of ['send_quote', 'book_quote']) {
      expect(getToolSideEffect(name)).toBe('external-write')
      expect(riskClassOf(name)).toBe('external-write')
    }
  })

  it("are always the owner's card, with the card's words pinned for the replay (the Native Intelligence MCP name too)", async () => {
    const hold = await outwardHoldOf({ workspaceId: 'w', userId: 'u-owner', toolName: 'book_quote', input: { quote_id: 'q-1', start: '2026-11-04T09:30' } })
    expect(hold).toMatchObject({ reason: 'customer_quote', card: CARD, context: CONTEXT, refusal: expect.stringContaining("books a customer's job") })
    expect(mocks.hold).toHaveBeenCalledWith({ service: true }, { workspaceId: 'w', userId: 'u-owner', toolName: 'book_quote', input: { quote_id: 'q-1', start: '2026-11-04T09:30' } })
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u-owner', toolName: 'ni_send_quote', input: INPUT })).toMatchObject({ reason: 'customer_quote' })
    expect(mocks.hold).toHaveBeenLastCalledWith({ service: true }, expect.objectContaining({ toolName: 'send_quote' }))
  })

  it('holds nothing for a call the tool refuses anyway, rows it cannot read, or no caller (the tool runs only as a card replay)', async () => {
    mocks.hold.mockResolvedValueOnce(null)
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u', toolName: 'send_quote', input: INPUT })).toBeNull()
    mocks.hold.mockRejectedValueOnce(new Error('db down'))
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u', toolName: 'send_quote', input: INPUT })).toBeNull()
    expect(await outwardHoldOf({ workspaceId: 'w', toolName: 'send_quote', input: INPUT })).toBeNull()
  })

  it("in the app, the person's call never runs: its card, whatever the reviewer's mode", async () => {
    for (const enforce of [false, true]) {
      const gated = await gateRiskyCall(base, run, enforce)
      expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    }
    expect(run).not.toHaveBeenCalled()
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ toolName: 'send_quote', reason: 'customer_quote', card: CARD, input: INPUT, context: expect.objectContaining(CONTEXT) }))
  })

  it('by text, the card is the same one (who gets what), its check kept, and the reply code follows', async () => {
    const HOLD = { reason: 'text_turn', message: 'Nothing ran: they now have a card for it.', cardWhy: 'you asked for it by text, and a text alone never runs it' }
    const gated = await gateRiskyCall({ ...base, caller: 'person_remote', alwaysHold: HOLD, defer: () => {} }, run, false)
    expect(gated).toEqual({ held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: HOLD.message } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'text_turn', card: CARD, context: expect.objectContaining(CONTEXT) }))
    expect(run).not.toHaveBeenCalled()
  })

  it('with no card to make (no price, a plain member, unreadable rows), the call goes on to the tool, which refuses it: never a card that could never run', async () => {
    mocks.hold.mockResolvedValue(null)
    const refused = { success: false, code: 'APPROVAL_REQUIRED', error: 'Nothing was sent. send_quote only runs from the owner’s own approval card.' }
    const tool = vi.fn(async () => refused)
    const HOLD = { reason: 'text_turn', message: 'held' }
    // By text, by a home turn, and with the reviewer enforced.
    expect(await gateRiskyCall({ ...base, caller: 'person_remote', alwaysHold: HOLD, defer: () => {} }, tool)).toEqual({ held: false, value: refused })
    expect(await gateRiskyCall({ ...base, caller: 'agent_unattended', homeTurn: true, defer: () => {} }, tool)).toEqual({ held: false, value: refused })
    expect(await gateRiskyCall({ ...base, defer: () => {} }, tool, true)).toEqual({ held: false, value: refused })
    expect(tool).toHaveBeenCalledTimes(3)
    expect(mocks.approve).not.toHaveBeenCalled()
    // Someone else texting is still refused before anything runs.
    expect(await gateRiskyCall({ ...base, caller: 'other_person', alwaysHold: HOLD, defer: () => {} }, tool)).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(tool).toHaveBeenCalledTimes(3)
  })

  it("by text, a connected app's write keeps the text turn's own card", async () => {
    const HOLD = { reason: 'text_turn', message: 'held', cardWhy: 'you asked for it by text, and a text alone never runs it' }
    await gateRiskyCall({ ...base, toolName: 'mcp__gmail__send_email', sideEffect: 'unclassified', caller: 'person_remote', alwaysHold: HOLD, defer: () => {} }, run)
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({
      card: { title: 'Approve mcp__gmail__send_email?', why: 'This runs an outside tool (mcp__gmail__send_email), once, with exactly the inputs below; you asked for it by text, and a text alone never runs it.' },
    }))
  })

  it("a home turn's call waits on the owner's card in their home thread; an unattended run is refused, never carded", async () => {
    await gateRiskyCall({ ...base, caller: 'agent_unattended', homeTurn: true, defer: () => {} }, run)
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ card: CARD, reachPerson: true }))
    mocks.approve.mockClear()
    const refused = await gateRiskyCall({ ...base, caller: 'agent_unattended', door: 'skill_run', defer: () => {} }, run)
    expect(refused).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON', approval_id: null, message: expect.stringContaining('Do not retry') } })
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
