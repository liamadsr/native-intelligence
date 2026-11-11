/**
 * A poll's tools at the gate (availability phase 5, src/lib/time-offers/
 * poll-send.ts, action-review.ts preApprovedCall), each gated as its nearest
 * sibling:
 *
 *   offer_times with recipients     as offer_times: by email or text the
 *                                   person's card (it names every guest), by
 *                                   link no hold.
 *   nudge_time_offer                as offer_times: by email or text always
 *                                   the person's card with the exact words
 *                                   (in the app, by text, on a home turn;
 *                                   NEEDS_PERSON unattended), its texted
 *                                   prompt the whole card; by link no hold.
 *   record_time_offer_answer,
 *   book_poll_time                  as accept_time_offer: pre-approved by the
 *                                   poll, never held (book_poll_time refuses
 *                                   an unattended run itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const CARD = { title: 'Email Dana Reyes (dana@initech.example), Sam Ortiz (sam@globex.example) a reminder about the times?', why: 'From your mailbox, each with their own link, subject “Reminder: Planning: which times work?”: “Hi, …” It runs once, as shown, when you accept.' }
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
vi.mock('@/lib/time-offers/send', () => ({ timeOfferHold: mocks.hold }))

import { gateRiskyCall, riskClassOf, type GateRequest } from '../action-review'
import { outwardHoldOf } from '../outward-gate'
import { approvalPromptText } from '@/lib/sms/approvals'
import { GUEST_NEVER_TOOLS } from '@/lib/guests/presets'
import { getToolSideEffect, getMutatingToolNames } from '@/lib/ai/tool-registry'

const NUDGE = { offer_id: '11111111-1111-4111-8111-111111111111', send_by: 'email' }
const CONTEXT = { timeOffer: { offer_id: NUDGE.offer_id, card_hash: 'h-1' } }
const base = {
  door: 'chat' as const, userId: 'u-ava', workspaceId: 'w', toolName: 'nudge_time_offer', input: NUDGE,
  sideEffect: 'external-write' as const, personMessages: ['Remind the ones who have not answered'], source: 'person' as const,
  personMessageSeq: 3, runId: 'conv-1', caller: 'person' as const,
  approval: { supabase: {} as never, conversationId: 'conv-1' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  mocks.approve.mockReset().mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
  mocks.hold.mockReset().mockResolvedValue({ card: CARD, context: CONTEXT, prepare: async () => ({ ok: true, context: CONTEXT }), held: async () => {}, abandon: async () => {} })
  run.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('risk classes and pinned lists', () => {
  it('nudge_time_offer by email or text is an external write; by link, record_time_offer_answer and book_poll_time are never reviewed', () => {
    expect(riskClassOf('nudge_time_offer', NUDGE)).toBe('external-write')
    expect(riskClassOf('nudge_time_offer', { ...NUDGE, send_by: 'text' })).toBe('external-write')
    expect(riskClassOf('nudge_time_offer', { offer_id: NUDGE.offer_id })).toBeNull()
    expect(riskClassOf('nudge_time_offer')).toBe('external-write')
    expect(riskClassOf('record_time_offer_answer', { offer_id: 'o', guest_id: 'g', works: [] })).toBeNull()
    expect(riskClassOf('book_poll_time', { offer_id: 'o', start: 's' })).toBeNull()
    expect(riskClassOf('offer_times', { recipients: [{ name: 'A' }, { name: 'B' }], send_by: 'email' })).toBe('external-write')
    expect(riskClassOf('offer_times', { recipients: [{ name: 'A' }, { name: 'B' }] })).toBeNull()
  })

  it('every poll tool is an external write in the registry, a write for report mode, and never a guest\'s', () => {
    for (const name of ['record_time_offer_answer', 'book_poll_time', 'nudge_time_offer']) {
      expect(getToolSideEffect(name), name).toBe('external-write')
      expect(getMutatingToolNames().has(name), name).toBe(true)
      expect(GUEST_NEVER_TOOLS.has(name), name).toBe(true)
    }
  })
})

describe('nudge_time_offer by email or text', () => {
  it('in the app: the person\'s card with the exact words; nothing runs', async () => {
    const gated = await gateRiskyCall({ ...base, defer: () => {} }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    expect(run).not.toHaveBeenCalled()
    const [, approval] = mocks.approve.mock.calls[0] as unknown as [unknown, { card: { title: string }; context: { timeOffer: unknown } }]
    expect(approval.card.title).toBe(CARD.title)
    expect(approval.context.timeOffer).toEqual(CONTEXT.timeOffer)
    expect(mocks.hold).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toolName: 'nudge_time_offer', input: NUDGE }))
  })

  it('by text: the same card, and the texted prompt carries it whole', async () => {
    const gated = await gateRiskyCall({ ...base, caller: 'person_remote', alwaysHold: { reason: 'text_turn', message: 'held' }, defer: () => {} }, run, false)
    expect(gated).toMatchObject({ held: true })
    const prompt = approvalPromptText({ tool: 'nudge_time_offer', title: CARD.title, why: CARD.why } as never)
    expect(prompt).toContain('sam@globex.example')
    expect(prompt).toContain('It runs once, as shown, when you accept.')
  })

  it('unattended: refused, nobody to give the card', async () => {
    const gated = await gateRiskyCall({ ...base, caller: 'agent_unattended', door: 'skill_run', defer: () => {} }, run, true)
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('the outward gate makes its card; by link there is none', async () => {
    expect(await outwardHoldOf({ toolName: 'nudge_time_offer', input: NUDGE, workspaceId: 'w', userId: 'u-ava' })).toMatchObject({ reason: 'time_offer', card: CARD })
    expect(await outwardHoldOf({ toolName: 'nudge_time_offer', input: { offer_id: NUDGE.offer_id }, workspaceId: 'w', userId: 'u-ava' })).toBeNull()
  })
})

describe('the calls that run as they are', () => {
  it('a nudge by link, record_time_offer_answer and book_poll_time run in the app, by text and unattended, with no card', async () => {
    const requests = [
      { ...base, input: { offer_id: NUDGE.offer_id }, sideEffect: riskClassOf('nudge_time_offer', { offer_id: NUDGE.offer_id }) },
      { ...base, toolName: 'record_time_offer_answer', input: { offer_id: 'o', guest_id: 'g', works: [] }, sideEffect: riskClassOf('record_time_offer_answer', {}) },
      { ...base, toolName: 'book_poll_time', input: { offer_id: 'o', start: 's' }, sideEffect: riskClassOf('book_poll_time', {}) },
    ]
    for (const request of requests) {
      for (const extra of [{}, { caller: 'person_remote' as const, alwaysHold: { reason: 'text_turn', message: 'held' } }, { caller: 'agent_unattended' as const, door: 'skill_run' as const }]) {
        expect(await gateRiskyCall({ ...request, ...extra, defer: () => {} }, run, true)).toEqual({ held: false, value: { success: true } })
      }
    }
    expect(mocks.approve).not.toHaveBeenCalled()
  })
})
