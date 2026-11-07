/**
 * What follows a payment (src/lib/payments/paid.ts): the to-do closes, the
 * contact's timeline notes it, the owner is texted, the `job.paid` agent event
 * lands and track D's `job/completed` goes out, deduped on the job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

const hoisted = vi.hoisted(() => ({
  handler: null as null | ((ctx: { event: unknown; step: unknown }) => Promise<unknown>),
  db: null as unknown,
  texts: [] as Array<{ userId: string; body: string }>,
  events: [] as unknown[],
  closed: [] as unknown[],
  textSent: true,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>) => {
      hoisted.handler = handler
      return {}
    },
    send: vi.fn(async () => ({})),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('../deliver', () => ({
  textOwner: vi.fn(async (_s: unknown, userId: string, body: string) => {
    hoisted.texts.push({ userId, body })
    return hoisted.textSent ? { sent: true } : { sent: false, reason: 'no_phone' }
  }),
}))
vi.mock('../todo', () => ({
  closePaymentTodo: vi.fn(async (_s: unknown, args: unknown) => {
    hoisted.closed.push(args)
    return true
  }),
}))
vi.mock('@/lib/agent-events/record', () => ({
  recordAgentEvents: vi.fn(async (inputs: unknown[]) => {
    hoisted.events.push(...inputs)
    return inputs.length
  }),
}))

import { inngest } from '@/lib/inngest/client'
import { jobRefOf, paidText, PAYMENT_REQUEST_PAID, queuePaidFollowups } from '../paid'
import { memDb, type MemDb } from './mem-db'

function seed(over: Record<string, unknown> = {}): MemDb {
  return memDb({
    payment_request: [
      {
        id: 'req-1',
        workspace_id: 'ws-1',
        created_by: 'user-1',
        contact_id: 'contact-1',
        subject_type: 'quote',
        subject_id: 'quote-1',
        action_id: 'action-1',
        description: 'Rug wash, 8x10 wool',
        amount_cents: 60_000,
        currency: 'usd',
        application_fee_cents: 0,
        stripe_account_id: 'acct_owner123',
        stripe_payment_link_id: 'plink_1',
        url: 'https://buy.stripe.com/x',
        status: 'paid',
        paid_at: '2026-11-03T12:00:00.000Z',
        amount_paid_cents: 60_000,
        ...over,
      },
    ],
    contact: [{ id: 'contact-1', full_name: 'Sarah Lee' }],
    contact_interaction: [],
  })
}

async function run(db: MemDb) {
  hoisted.db = db.client
  const step = createStepMock()
  const out = await hoisted.handler!({ event: { name: PAYMENT_REQUEST_PAID, data: { requestId: 'req-1', workspaceId: 'ws-1' } }, step })
  return { out, step }
}

beforeEach(() => {
  hoisted.texts.length = 0
  hoisted.events.length = 0
  hoisted.closed.length = 0
  hoisted.textSent = true
})

describe('the paid follow-ups', () => {
  it('close the to-do, note the contact, text the owner, record job.paid and tell track D', async () => {
    const db = seed()
    const { out, step } = await run(db)
    expect(out).toMatchObject({ status: 'done', closedTodo: true, texted: true })
    expect(hoisted.closed).toEqual([{ actionId: 'action-1', workspaceId: 'ws-1', actorUserId: 'user-1' }])
    expect(db.tables.contact_interaction).toEqual([expect.objectContaining({ contact_id: 'contact-1', interaction_type: 'payment_received', reference_type: 'payment_request', reference_id: 'req-1', title: 'Paid $600.00' })])
    expect(db.rpcCalls).toEqual([{ fn: 'update_contact_interaction_stats', args: { p_contact_id: 'contact-1', p_occurred_at: '2026-11-03T12:00:00.000Z' } }])
    expect(hoisted.texts).toEqual([{ userId: 'user-1', body: 'Sarah Lee paid $600.00 for Rug wash, 8x10 wool. I closed its to-do.' }])
    expect(hoisted.events).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-1',
        userId: 'user-1',
        kind: 'job.paid',
        refType: 'quote',
        refId: 'quote-1',
        dedupeKey: 'payment:req-1:paid',
        facts: { title: 'Sarah Lee paid $600.00 for Rug wash, 8x10 wool.', contactId: 'contact-1', notified: true },
      }),
    ])
    expect(step.sendEvent).toHaveBeenCalledWith('job-completed', {
      id: 'job-completed:quote:quote-1',
      name: 'job/completed',
      data: { workspaceId: 'ws-1', contactId: 'contact-1', jobRef: { type: 'quote', id: 'quote-1' }, completedAt: '2026-11-03T12:00:00.000Z', reason: 'paid', paymentRequestId: 'req-1' },
    })
  })

  it('an owner the text did not reach gets it as a home-thread turn instead (notified false)', async () => {
    hoisted.textSent = false
    await run(seed())
    expect((hoisted.events[0] as { facts: { notified: boolean } }).facts.notified).toBe(false)
  })

  it('a request that is not paid (refunded since, say) does nothing', async () => {
    const { out } = await run(seed({ status: 'refunded' }))
    expect(out).toMatchObject({ status: 'skipped' })
    expect(hoisted.texts).toHaveLength(0)
    expect(hoisted.events).toHaveLength(0)
  })

  it('the contact note is written once, whatever the retries', async () => {
    const db = seed()
    await run(db)
    await run(db)
    expect(db.tables.contact_interaction).toHaveLength(1)
  })
})

describe('the pure parts', () => {
  it('names the job: the subject, else the request', () => {
    expect(jobRefOf({ id: 'r', subjectType: 'booking', subjectId: 'b1' })).toEqual({ type: 'booking', id: 'b1' })
    expect(jobRefOf({ id: 'r', subjectType: 'job', subjectId: null })).toEqual({ type: 'payment_request', id: 'r' })
  })

  it('words the owner’s text', () => {
    expect(paidText({ customerName: null, amountCents: 1234, currency: 'usd', description: 'Fringe repair', closedTodo: false })).toBe('A customer paid $12.34 for Fringe repair.')
  })
})

describe('queuing the follow-ups (the webhook’s side)', () => {
  it('sends one event per request (its id is the dedupe key) and stamps the request', async () => {
    const db = seed({ status: 'paid', paid_followups_queued_at: null })
    await queuePaidFollowups(db.client, { id: 'req-1', workspaceId: 'ws-1' })
    expect(inngest.send).toHaveBeenCalledWith({ id: 'payment-paid:req-1', name: 'payments/request.paid', data: { requestId: 'req-1', workspaceId: 'ws-1' } })
    expect(db.tables.payment_request[0].paid_followups_queued_at).toBeTruthy()
  })

  it('a stamp that fails throws, so the webhook answers 500 and Stripe’s retry queues again', async () => {
    const failing = {
      from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'db down' } }) }) }),
    }
    await expect(queuePaidFollowups(failing as never, { id: 'req-1', workspaceId: 'ws-1' })).rejects.toThrow('payment_request stamp failed')
  })

  it('a queue that refuses throws before stamping', async () => {
    const db = seed({ status: 'paid', paid_followups_queued_at: null })
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('inngest down'))
    await expect(queuePaidFollowups(db.client, { id: 'req-1', workspaceId: 'ws-1' })).rejects.toThrow('inngest down')
    expect(db.tables.payment_request[0].paid_followups_queued_at).toBeNull()
  })
})
