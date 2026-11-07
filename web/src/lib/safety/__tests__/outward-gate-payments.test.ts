/**
 * send_payment_link at the outward gate (roadmap C2): once the workspace's
 * Stripe can take payments, every call is the owner's approval card saying
 * the amount, what it's for and who gets it (a NEEDS_PERSON refusal when no
 * one is there to answer it). Before Stripe is ready nothing is held: the
 * tool then reaches only the owner, with their setup link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  decide: vi.fn(async (): Promise<unknown> => ({ status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  ready: true as boolean | 'throws',
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarEventAttendees: async () => null }))
vi.mock('@/lib/email/thread-mailbox', () => ({ mailboxesForThread: async function* () {} }))
vi.mock('@/lib/workspace-member-emails', () => ({ findMembersByEmail: async () => new Map() }))
vi.mock('@/lib/payments/ready', () => ({
  paymentsReady: vi.fn(async () => {
    if (mocks.ready === 'throws') throw new Error('db down')
    return mocks.ready
  }),
}))

import { gateRiskyCall, type GateRequest } from '../action-review'
import { outwardHoldOf } from '../outward-gate'

const INPUT = { subject: 'quote', subject_id: 'q1', amount: 600, description: 'Rug wash, 8x10 wool', to_phone: '+15552014567', to_email: 'sarah@example.com' }
const base = {
  door: 'chat' as const, userId: 'u', workspaceId: 'w', toolName: 'send_payment_link',
  input: INPUT, sideEffect: 'external-write' as const, personMessages: ['Send Sarah the payment link for her rug'],
  source: 'person' as const, personMessageSeq: 3, runId: 'conv-1', caller: 'person' as const,
  approval: { supabase: {} as never, conversationId: 'conv-1' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  mocks.ready = true
  mocks.approve.mockClear()
  run.mockClear()
})

describe('send_payment_link at the outward gate', () => {
  it('Stripe ready: always the owner’s card, naming the amount, what it’s for and who gets it', async () => {
    const hold = await outwardHoldOf({ workspaceId: 'w', userId: 'u', toolName: 'send_payment_link', input: INPUT })
    expect(hold).toMatchObject({ reason: 'payment_link' })
    expect(hold?.card.title).toBe('Send a $600.00 payment link?')
    expect(hold?.card.why).toContain('For “Rug wash, 8x10 wool”, by text to +15552014567 and by email to sarah@example.com.')
    const gated = await gateRiskyCall(base, run, false)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ toolName: 'send_payment_link', reason: 'payment_link', input: INPUT }))
  })

  it('held for the person whatever trust they have: the reviewer’s allow does not let it run', async () => {
    expect(await gateRiskyCall(base, run, true)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('nobody there to answer (an unattended run): NEEDS_PERSON, no card, nothing sent', async () => {
    const gated = await gateRiskyCall({ ...base, door: 'skill_run' as const, source: 'loop_instructions' as const, caller: 'agent_unattended' as const }, run, false)
    expect(gated).toMatchObject({ held: true, output: { success: false, code: 'NEEDS_PERSON', approval_id: null } })
    expect(run).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('Stripe not ready: not held (the tool then only texts the owner their setup link)', async () => {
    mocks.ready = false
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u', toolName: 'send_payment_link', input: INPUT })).toBeNull()
  })

  it('a readiness lookup that fails holds it', async () => {
    mocks.ready = 'throws'
    expect(await outwardHoldOf({ workspaceId: 'w', userId: 'u', toolName: 'dial8_send_payment_link', input: INPUT })).toMatchObject({ reason: 'payment_link' })
  })

  it('an input the tool would refuse anyway (no recipient, a bad amount) is not carded', async () => {
    expect(await outwardHoldOf({ workspaceId: 'w', toolName: 'send_payment_link', input: { ...INPUT, to_phone: undefined, to_email: undefined } })).toBeNull()
    expect(await outwardHoldOf({ workspaceId: 'w', toolName: 'send_payment_link', input: { ...INPUT, amount: 0.001 } })).toBeNull()
  })
})
