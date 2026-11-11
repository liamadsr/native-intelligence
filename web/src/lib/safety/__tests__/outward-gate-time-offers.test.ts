/**
 * The time offer tools at the gate (availability phase 3a,
 * src/lib/time-offers/send.ts, action-review.ts preApprovedCall):
 *
 *   offer_times by email or text   always the person's card with the exact
 *                                  words, in the app, by text and on a home
 *                                  turn; refused NEEDS_PERSON unattended. Its
 *                                  offer (the times held) is made only when
 *                                  the card is really raised, rides on the
 *                                  approval, and is let go when no card
 *                                  comes of it.
 *   offer_times by link            sends nothing: never held, never reviewed.
 *   accept_time_offer              pre-approved when the person saw who the
 *                                  offer went to (its card, or their own
 *                                  turn), never reviewed; from any other
 *                                  offer the card naming its guests (in the
 *                                  app, by text, on a home turn), refused
 *                                  NEEDS_PERSON unattended.
 *   cancel_offered_meeting         an external write: reviewed, carded by
 *                                  text; the tool refuses unattended.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const CARD = { title: 'Email Dana Reyes (dana@initech.example) times to meet?', why: 'From your mailbox, subject “Intro call: a few times to meet”: “Hi Dana, …” The times stay held …' }
const mocks = vi.hoisted(() => ({
  decide: vi.fn(async (): Promise<unknown> => ({ status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  hold: vi.fn(),
  prepare: vi.fn(),
  held: vi.fn(async () => {}),
  abandon: vi.fn(async () => {}),
  bookingHold: vi.fn(async (): Promise<unknown> => null),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarEventAttendees: async () => null }))
vi.mock('@/lib/email/thread-mailbox', () => ({ mailboxesForThread: async function* () {} }))
vi.mock('@/lib/workspace-member-emails', () => ({ findMembersByEmail: async () => new Map() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/time-offers/send', () => ({ timeOfferHold: mocks.hold }))
vi.mock('@/lib/time-offers/agent-booking', () => ({ offerBookingHold: mocks.bookingHold }))

import { gateRiskyCall, riskClassOf, type GateRequest } from '../action-review'
import { outwardHoldOf } from '../outward-gate'
import { approvalPromptText } from '@/lib/sms/approvals'

const INPUT = { recipient: { name: 'Dana Reyes', email: 'dana@initech.example' }, title: 'Intro call', slots: ['2026-11-17T10:00:00-05:00', '2026-11-18T14:00:00-05:00'], duration_minutes: 30, send_by: 'email' }
const OFFER_CONTEXT = { timeOffer: { offer_id: 'offer-1', card_hash: 'h-1' } }
const base = {
  door: 'chat' as const, userId: 'u-ava', workspaceId: 'w', toolName: 'offer_times', input: INPUT,
  sideEffect: 'external-write' as const, personMessages: ['Email Dana a couple of times next week'], source: 'person' as const,
  personMessageSeq: 3, runId: 'conv-1', caller: 'person' as const,
  approval: { supabase: {} as never, conversationId: 'conv-1' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  mocks.approve.mockReset().mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
  mocks.prepare.mockReset().mockResolvedValue({ ok: true, context: OFFER_CONTEXT })
  mocks.held.mockClear()
  mocks.abandon.mockClear()
  mocks.hold.mockReset().mockResolvedValue({ card: CARD, context: { timeOffer: { card_hash: 'h-1' } }, prepare: mocks.prepare, held: mocks.held, abandon: mocks.abandon })
  run.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('risk classes', () => {
  it('offer_times by link is never reviewed; by email or text, accept_time_offer (the gate asks whether its offer was shown) and cancel_offered_meeting are external writes', () => {
    expect(riskClassOf('offer_times', { ...INPUT, send_by: 'link' })).toBeNull()
    expect(riskClassOf('offer_times', { ...INPUT, send_by: undefined })).toBeNull()
    expect(riskClassOf('offer_times', INPUT)).toBe('external-write')
    expect(riskClassOf('offer_times', { ...INPUT, send_by: 'text' })).toBe('external-write')
    // Without its input (a guest's ceiling check), it reads as what it can be: an external write.
    expect(riskClassOf('offer_times')).toBe('external-write')
    expect(riskClassOf('accept_time_offer', { offer_id: 'o', start: 's' })).toBe('external-write')
    // Its MCP name is reviewed too (the gate asks the same question of it by its bare name).
    expect(riskClassOf('ni_accept_time_offer')).not.toBeNull()
    expect(riskClassOf('cancel_offered_meeting', { booking_id: 'b' })).toBe('external-write')
    expect(riskClassOf('withdraw_time_offer', { offer_id: 'o' })).toBeNull()
    expect(riskClassOf('list_time_offers', {})).toBeNull()
  })
})

describe('offer_times at the outward gate', () => {
  it('by email or text: its own card, the words pinned; by link, no hold', async () => {
    const hold = await outwardHoldOf({ workspaceId: 'w', userId: 'u-ava', toolName: 'offer_times', input: INPUT })
    expect(hold).toMatchObject({ reason: 'time_offer', card: CARD, context: { timeOffer: { card_hash: 'h-1' } }, refusal: expect.stringContaining("send_by 'link'") })
    expect(mocks.hold).toHaveBeenCalledWith({ service: true }, { workspaceId: 'w', userId: 'u-ava', input: INPUT, toolName: 'offer_times' })
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u-ava', toolName: 'offer_times', input: { ...INPUT, send_by: 'link' } })).toBeNull()
    expect(mocks.hold).toHaveBeenCalledTimes(1)
    // A call the tool refuses anyway, or unreadable rows: no hold (the tool says why).
    mocks.hold.mockResolvedValueOnce(null)
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u-ava', toolName: 'offer_times', input: INPUT })).toBeNull()
    mocks.hold.mockRejectedValueOnce(new Error('db down'))
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u-ava', toolName: 'offer_times', input: INPUT })).toBeNull()
  })

  it("in the app: the person's card, whatever the reviewer's mode; the offer made for it rides on the approval", async () => {
    for (const enforce of [false, true]) {
      const gated = await gateRiskyCall(base, run, enforce)
      expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    }
    expect(run).not.toHaveBeenCalled()
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ toolName: 'offer_times', reason: 'time_offer', card: CARD, input: INPUT, context: expect.objectContaining(OFFER_CONTEXT) }))
    expect(mocks.held).toHaveBeenCalledWith(OFFER_CONTEXT, 'appr-1')
    expect(mocks.abandon).not.toHaveBeenCalled()
  })

  it('by text: the same card (the exact words), its offer on the approval; the texted prompt carries the whole card', async () => {
    const HOLD = { reason: 'text_turn', message: 'Nothing ran: they now have a card for it.', cardWhy: 'you asked for it by text' }
    const gated = await gateRiskyCall({ ...base, caller: 'person_remote', alwaysHold: HOLD, defer: () => {} }, run, false)
    expect(gated).toEqual({ held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: HOLD.message } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'text_turn', card: CARD, context: expect.objectContaining(OFFER_CONTEXT) }))
    expect(run).not.toHaveBeenCalled()
    const prompt = approvalPromptText({ tool: 'offer_times', title: CARD.title, why: CARD.why } as never)
    expect(prompt).toContain(CARD.title)
    expect(prompt).toContain('“Intro call: a few times to meet”')
  })

  it("a home turn's call waits on the person's card in their home thread; an unattended run is refused and no offer is made", async () => {
    await gateRiskyCall({ ...base, caller: 'agent_unattended', homeTurn: true, defer: () => {} }, run)
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ card: CARD, reachPerson: true, context: expect.objectContaining(OFFER_CONTEXT) }))
    mocks.approve.mockClear()
    mocks.prepare.mockClear()
    const refused = await gateRiskyCall({ ...base, caller: 'agent_unattended', door: 'skill_run', defer: () => {} }, run)
    expect(refused).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON', approval_id: null } })
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('times no longer free: no card, nothing ran, and the model reads why', async () => {
    mocks.prepare.mockResolvedValueOnce({ ok: false, message: 'Nothing was sent or held: Something is already on your calendar at Tue, Nov 17, 10:00 AM.' })
    const gated = await gateRiskyCall(base, run)
    expect(gated).toEqual({ held: true, output: { success: false, code: 'NOT_HELD', approval_id: null, message: 'Nothing was sent or held: Something is already on your calendar at Tue, Nov 17, 10:00 AM.' } })
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('a card that could not be made lets the offer go', async () => {
    mocks.approve.mockResolvedValueOnce({ ok: false, code: 'TOO_MANY_PENDING', error: 'The person already has 20 approvals waiting.' })
    const gated = await gateRiskyCall(base, run)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: null } })
    expect(mocks.abandon).toHaveBeenCalledWith(OFFER_CONTEXT)
    expect(mocks.held).not.toHaveBeenCalled()
  })

  it('with no card to make, the call goes on to the tool, which refuses it (it sends only as a card replay)', async () => {
    mocks.hold.mockResolvedValue(null)
    const refused = { success: false, code: 'NO_BUSINESS_NUMBER', error: "This workspace has no texting number. Offer with send_by 'link'." }
    const tool = vi.fn(async () => refused)
    expect(await gateRiskyCall({ ...base, input: { ...INPUT, send_by: 'text' }, caller: 'person_remote', alwaysHold: { reason: 'text_turn', message: 'held' }, defer: () => {} }, tool)).toEqual({ held: false, value: refused })
    expect(await gateRiskyCall({ ...base, input: { ...INPUT, send_by: 'text' }, defer: () => {} }, tool, true)).toEqual({ held: false, value: refused })
    expect(mocks.approve).not.toHaveBeenCalled()
  })
})

describe("an agent booking from an offer whose guests the person never saw", () => {
  const BOOKING_CARD = { card: { title: 'Book "Intro call" with Mallory (mallory@evil.example)?', why: 'This books "Intro call" on your calendar, and your calendar emails the invitation …' }, refusal: 'Nothing ran. accept_time_offer would book "Intro call" and send the invitation to Mallory (mallory@evil.example) …' }
  const accept = { ...base, toolName: 'accept_time_offer', input: { offer_id: 'offer-9', start: '2026-11-17T15:00:00.000Z' }, sideEffect: 'external-write' as const }

  it("is the person's card naming the guests, in the app whatever the reviewer's mode, by text and on a home turn; never run on the model's word", async () => {
    mocks.bookingHold.mockResolvedValue(BOOKING_CARD)
    for (const extra of [{}, { caller: 'person_remote' as const, alwaysHold: { reason: 'text_turn', message: 'held' } }, { caller: 'agent_unattended' as const, homeTurn: true as const }]) {
      for (const enforce of [false, true]) {
        mocks.approve.mockClear()
        expect(await gateRiskyCall({ ...accept, ...extra, defer: () => {} }, run, enforce)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
        expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ toolName: 'accept_time_offer', reason: 'outside_attendees', card: BOOKING_CARD.card, input: accept.input }))
      }
    }
    expect(run).not.toHaveBeenCalled()
    mocks.bookingHold.mockReset().mockResolvedValue(null)
  })

  it('is refused NEEDS_PERSON for an unattended run (a loop, a skill run): no card is left waiting', async () => {
    mocks.bookingHold.mockResolvedValue(BOOKING_CARD)
    const refused = await gateRiskyCall({ ...accept, caller: 'agent_unattended', door: 'skill_run', defer: () => {} }, run)
    expect(refused).toEqual({ held: true, output: { success: false, code: 'NEEDS_PERSON', approval_id: null, message: BOOKING_CARD.refusal } })
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    mocks.bookingHold.mockReset().mockResolvedValue(null)
  })

  it('a check that fails is held, never run', async () => {
    mocks.bookingHold.mockRejectedValueOnce(new Error('db down'))
    expect(await gateRiskyCall({ ...accept, defer: () => {} }, run, false)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'outside_attendees', card: expect.objectContaining({ title: 'Approve accept_time_offer?' }) }))
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the calls that run as they are', () => {
  it('offer_times by link, and accept_time_offer from an offer the person saw, run in the app, by text and unattended, with no card', async () => {
    const link = { ...base, input: { ...INPUT, send_by: 'link' }, sideEffect: riskClassOf('offer_times', { ...INPUT, send_by: 'link' }) }
    const accept = { ...base, toolName: 'accept_time_offer', input: { offer_id: 'offer-1', start: '2026-11-17T15:00:00.000Z' }, sideEffect: riskClassOf('accept_time_offer', {}) }
    for (const request of [link, accept]) {
      for (const extra of [{}, { caller: 'person_remote' as const, alwaysHold: { reason: 'text_turn', message: 'held' } }, { caller: 'agent_unattended' as const, door: 'skill_run' as const }, { caller: 'agent_unattended' as const, homeTurn: true as const }]) {
        expect(await gateRiskyCall({ ...request, ...extra, defer: () => {} }, run, true)).toEqual({ held: false, value: { success: true } })
      }
    }
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.hold).not.toHaveBeenCalled()
    expect(mocks.bookingHold).toHaveBeenCalledWith({ service: true }, { workspaceId: 'w', userId: 'u-ava', input: accept.input, toolName: 'accept_time_offer' })
  })

  it('cancel_offered_meeting by text is the text turn\'s card, never run on a text alone', async () => {
    const cancel = { ...base, toolName: 'cancel_offered_meeting', input: { booking_id: 'b-1' }, sideEffect: riskClassOf('cancel_offered_meeting', { booking_id: 'b-1' }) }
    const gated = await gateRiskyCall({ ...cancel, caller: 'person_remote', alwaysHold: { reason: 'text_turn', message: 'held' }, defer: () => {} }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(run).not.toHaveBeenCalled()
    // In the app, with the reviewer in shadow, it runs (the tool itself refuses an unattended run).
    expect(await gateRiskyCall({ ...cancel, defer: () => {} }, run, false)).toEqual({ held: false, value: { success: true } })
  })
})
