/**
 * The agent's one money tool (roadmap C2): send_payment_link. Exactly one
 * tool touches payments, it only makes payment links, it never runs without
 * the owner's approval once Stripe is ready, and before that it reaches only
 * the owner (their setup link). The one other tool that names Stripe,
 * import_stripe_customers (roadmap #10), only reads it: list calls on the
 * connected account's customers and charges, into the CRM importer.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoisted = vi.hoisted(() => ({
  setupTexts: [] as unknown[],
  customerTexts: [] as Array<{ phone: string; body: string }>,
  emails: [] as Array<{ to: string; subject: string; text: string }>,
  stripeCalls: [] as Array<{ params: Record<string, unknown>; options: Record<string, unknown> }>,
  linkActive: true,
  createFails: false,
  setupResult: { sent: true, url: 'https://dial8.ai/payments/setup/x', expiresAt: 'later' } as Record<string, unknown>,
}))

vi.mock('@/lib/payments/setup', () => ({
  textSetupLink: vi.fn(async (_s: unknown, args: unknown) => {
    hoisted.setupTexts.push(args)
    return hoisted.setupResult
  }),
}))
vi.mock('@/lib/payments/deliver', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/payments/deliver')>()
  return {
    ...real,
    textCustomer: vi.fn(async (_s: unknown, args: { phone: string; body: string }) => {
      hoisted.customerTexts.push(args)
      return { sent: true }
    }),
    emailCustomer: vi.fn(async (args: { to: string; subject: string; text: string }) => {
      hoisted.emails.push(args)
      return { sent: true }
    }),
  }
})
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    paymentLinks: {
      create: vi.fn(async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        if (hoisted.createFails) throw new Error('card_payments inactive')
        hoisted.stripeCalls.push({ params, options })
        return { id: 'plink_1', url: 'https://buy.stripe.com/test_1' }
      }),
      update: vi.fn(),
      retrieve: vi.fn(async () => ({ active: hoisted.linkActive })),
    },
  }),
}))

import { TOOL_CATEGORIES, TOOL_REGISTRY_MAP } from '../tool-registry'
import { createTools } from '../tools'
import { createPaymentTools } from '../tools/payments'
import { memDb, type MemDb } from '@/lib/payments/__tests__/mem-db'

/** A tool name's words that mean money (transfer alone is a loop's ownership: transfer_flow_owner). */
const MONEY_WORDS = new Set(['pay', 'payment', 'payments', 'refund', 'refunds', 'stripe', 'charge', 'charges', 'invoice', 'invoices', 'payout', 'payouts', 'funds', 'balance', 'money', 'billing', 'subscription', 'checkout'])
const MONEY = { test: (name: string) => name.toLowerCase().split(/[_-]/).some((word) => MONEY_WORDS.has(word)) }

/** Names Stripe but moves no money: it reads the connected account's customers into the CRM (roadmap #10). */
const STRIPE_READER = 'import_stripe_customers'

describe('exactly one money tool', () => {
  it('the registry has one payments tool, send_payment_link, an external write; the Stripe reader only writes the CRM', () => {
    const money = TOOL_CATEGORIES.flatMap((c) => c.tools).filter((t) => MONEY.test(t.name))
    expect(money.map((t) => t.name).sort()).toEqual([STRIPE_READER, 'send_payment_link'])
    expect(TOOL_REGISTRY_MAP.get('send_payment_link')?.tool.sideEffect).toBe('external-write')
    expect(TOOL_REGISTRY_MAP.get(STRIPE_READER)?.tool).toMatchObject({ sideEffect: 'internal-write', writeTarget: 'crm' })
  })

  it('the assembled tool set has it and nothing else that touches money', () => {
    const keys = Object.keys(createTools('u', {} as unknown as SupabaseClient, 'w'))
    expect(keys.filter((k) => MONEY.test(k)).sort()).toEqual([STRIPE_READER, 'send_payment_link'])
  })

  it('the Stripe customer import only lists: no create, update, delete, refund or payout, and only on the connected account', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/crm/import/sources/stripe.ts'), 'utf8')
    const calls = [...source.matchAll(/\bstripe\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`)
    expect(calls.sort()).toEqual(['charges.list', 'customers.list'])
    // Every call names the owner's account, never the platform's own.
    expect(source.match(/\{ stripeAccount \}\)/g)).toHaveLength(2)
  })

  it('no other tool module reaches Stripe or the payments code, statically or dynamically', () => {
    const root = join(process.cwd(), 'src/lib/ai/tools')
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
    const reaching = files.filter((f) => /(from\s+|import\(\s*)'(@\/lib\/stripe|stripe|@\/lib\/payments\/[^']+)'/.test(readFileSync(join(root, f), 'utf8')))
    expect(reaching).toEqual(['payments.ts'])
  })

  it('the payments code only ever makes or switches off payment links: no refunds, payouts, transfers or customer edits', () => {
    const dir = join(process.cwd(), 'src/lib/payments')
    const forbidden = /\.(refunds|payouts|transfers|customers|charges|balance|balanceTransactions|invoices|subscriptions|topups|issuing|treasury)\.|disputes\.(update|close)/
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => forbidden.test(readFileSync(join(dir, f), 'utf8')))
    expect(hits).toEqual([])
  })
})

const READY = { workspace_id: 'ws-1', stripe_account_id: 'acct_owner123', status: 'ready', linked_via: 'created', livemode: false, charges_enabled: true, payouts_enabled: true, details_submitted: true, connected_by: 'user-1', application_fee_bps: 0, application_fee_cents: 0, ready_at: 'x', ready_notified_at: 'x' }

function seed(account: Record<string, unknown> | null = READY, opts: { missingTables?: string[] } = {}): MemDb {
  return memDb({
    stripe_connect_account: account ? [account] : [],
    workspace: [{ id: 'ws-1', name: 'Bright Loom' }],
    contact: [{ id: '11111111-1111-4111-8111-111111111111', workspace_id: 'ws-1', full_name: 'Sarah Lee' }],
    team: [{ id: 'team-1', workspace_id: 'ws-1', created_at: '1' }],
    workflow_state: [{ id: 'state-1', team_id: 'team-1', is_default: true }],
    member: [{ id: 'member-1', workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' }],
    payment_request: [],
    actions: [],
    action_assignee: [],
    entity_link: [],
    contact_interaction: [],
    customer_quote: [{ id: 'quote-1', workspace_id: 'ws-1', contact_id: null }],
  }, {}, opts)
}

const INPUT = {
  subject: 'quote' as const,
  subject_id: 'quote-1',
  amount: 600,
  description: 'Rug wash, 8x10 wool',
  contact_id: '11111111-1111-4111-8111-111111111111',
  to_phone: '+1 (555) 201-4567',
  to_email: 'sarah@example.com',
}

type Exec = (input: unknown, opts: unknown) => Promise<Record<string, unknown>>
function exec(db: MemDb, approved: boolean) {
  const tools = createPaymentTools('user-1', db.client, 'ws-1', approved ? { approvedCall: { approvalId: 'appr-1', tool: 'send_payment_link' } } : {})
  return (tools.send_payment_link.execute as unknown as Exec)(INPUT, { toolCallId: 't', messages: [] })
}

beforeEach(() => {
  hoisted.setupTexts.length = 0
  hoisted.customerTexts.length = 0
  hoisted.emails.length = 0
  hoisted.stripeCalls.length = 0
  hoisted.linkActive = true
  hoisted.createFails = false
  hoisted.setupResult = { sent: true, url: 'https://dial8.ai/payments/setup/x', expiresAt: 'later' }
  process.env.STRIPE_SECRET_KEY = 'sk_test_platform'
  delete process.env.STRIPE_CONNECT_LIVE
})

describe('send_payment_link', () => {
  it('never runs unapproved once Stripe is ready: nothing reaches Stripe or the customer', async () => {
    const db = seed()
    const result = await exec(db, false)
    expect(result).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(hoisted.stripeCalls).toHaveLength(0)
    expect(hoisted.customerTexts).toHaveLength(0)
    expect(hoisted.emails).toHaveLength(0)
    expect(db.tables.payment_request).toHaveLength(0)
  })

  it('before Stripe is connected, texts the OWNER their setup link and sends the customer nothing', async () => {
    for (const account of [null, { ...READY, status: 'onboarding' }]) {
      hoisted.setupTexts.length = 0
      const db = seed(account)
      const result = await exec(db, true)
      expect(result).toMatchObject({ success: false, code: 'STRIPE_NOT_READY' })
      expect(hoisted.setupTexts).toEqual([{ workspaceId: 'ws-1', userId: 'user-1' }])
      expect(hoisted.stripeCalls).toHaveLength(0)
      expect(hoisted.customerTexts).toHaveLength(0)
    }
  })

  it('with live Connect switched off, does nothing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_platform'
    const result = await exec(seed(), true)
    expect(result).toMatchObject({ success: false, code: 'PAYMENTS_OFF' })
    expect(hoisted.stripeCalls).toHaveLength(0)
  })

  it('approved: makes a direct-charge link on the owner’s account, texts and emails it, with a Get paid to-do', async () => {
    const db = seed()
    const result = await exec(db, true)
    expect(result).toMatchObject({ success: true, url: 'https://buy.stripe.com/test_1', amount: '$600.00', sent_via: ['text', 'email'] })
    expect(hoisted.stripeCalls).toHaveLength(1)
    expect(hoisted.stripeCalls[0].options).toMatchObject({ stripeAccount: 'acct_owner123' })
    expect(hoisted.stripeCalls[0].params).not.toHaveProperty('application_fee_amount')
    expect(hoisted.customerTexts).toEqual([{ workspaceId: 'ws-1', phone: '+15552014567', body: 'Bright Loom: here is your payment link for Rug wash, 8x10 wool ($600.00): https://buy.stripe.com/test_1' }])
    expect(hoisted.emails[0]).toMatchObject({ to: 'sarah@example.com', subject: 'Bright Loom: payment for Rug wash, 8x10 wool' })
    expect(hoisted.emails[0].text).toContain('Hi Sarah,')
    expect(db.tables.actions).toEqual([expect.objectContaining({ title: 'Get paid: $600.00 from Sarah Lee (Rug wash, 8x10 wool)', assignee_id: 'member-1', workspace_id: 'ws-1' })])
    expect(db.tables.payment_request[0]).toMatchObject({ subject_type: 'quote', subject_id: 'quote-1', contact_id: INPUT.contact_id, action_id: db.tables.actions[0].id, sent_via: ['text', 'email'], sent_to_phone: '+15552014567' })
    expect(db.tables.contact_interaction).toEqual([expect.objectContaining({ interaction_type: 'payment_requested', reference_type: 'payment_request' })])
  })

  it('takes the workspace’s optional platform fee', async () => {
    await exec(seed({ ...READY, application_fee_bps: 100 }), true)
    expect(hoisted.stripeCalls[0].params.application_fee_amount).toBe(600)
  })

  it('asked again for the same quote, resends the open link instead of making another; a paid one is never resent', async () => {
    const db = seed()
    await exec(db, true)
    const again = await exec(db, true)
    expect(again).toMatchObject({ success: true, resent: true, url: 'https://buy.stripe.com/test_1' })
    expect(hoisted.stripeCalls).toHaveLength(1)
    db.tables.payment_request[0].status = 'paid'
    expect(await exec(db, true)).toMatchObject({ success: false, code: 'ALREADY_PAID' })
  })

  it('refuses a contact from another workspace', async () => {
    const db = seed()
    db.tables.contact[0].workspace_id = 'ws-other'
    expect(await exec(db, true)).toMatchObject({ success: false })
    expect(hoisted.stripeCalls).toHaveLength(0)
  })

  it('refuses a quote of another workspace; with no quotes table yet (track B unmerged), takes the id as given', async () => {
    const foreign = seed()
    foreign.tables.customer_quote[0].workspace_id = 'ws-other'
    expect(await exec(foreign, true)).toMatchObject({ success: false, error: expect.stringContaining('No quote with that id') })
    expect(hoisted.stripeCalls).toHaveLength(0)
    expect(await exec(seed(READY, { missingTables: ['customer_quote'] }), true)).toMatchObject({ success: true })
  })

  it('never puts the setup link in the result (model context), even when it could not be texted', async () => {
    hoisted.setupResult = { sent: false, reason: 'no_phone', url: 'https://dial8.ai/payments/setup/SECRETTOKENxxxxxxxxxxxxx' }
    const result = await exec(seed(null), true)
    expect(result).toMatchObject({ success: false, code: 'STRIPE_NOT_READY' })
    expect(JSON.stringify(result)).not.toContain('/payments/setup/')
  })

  it('an account made in the other mode is not ready: it gets the setup link, never a payment link', async () => {
    const result = await exec(seed({ ...READY, livemode: true }), true)
    expect(result).toMatchObject({ success: false, code: 'STRIPE_NOT_READY' })
    expect(hoisted.stripeCalls).toHaveLength(0)
  })

  it('a link Stripe switched off is never resent: the old request is cancelled and a new link made', async () => {
    const db = seed()
    await exec(db, true)
    hoisted.linkActive = false
    const again = await exec(db, true)
    expect(again).toMatchObject({ success: true })
    expect(again).not.toHaveProperty('resent')
    expect(hoisted.stripeCalls).toHaveLength(2)
    expect(db.tables.payment_request.map((r) => r.status)).toEqual(['cancelled', 'open'])
  })

  it('a link Stripe refuses leaves no "Get paid" to-do behind', async () => {
    hoisted.createFails = true
    const db = seed()
    expect(await exec(db, true)).toMatchObject({ success: false })
    expect(db.tables.actions).toHaveLength(0)
  })
})
