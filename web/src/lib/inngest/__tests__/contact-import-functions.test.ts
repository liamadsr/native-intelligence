/**
 * The importer's Inngest functions (roadmap track G): apply runs a batch's
 * chunks then finishes it (the owner's text) or hands on to a fresh run;
 * Google Contacts reads every page into the batch, then asks for apply; a
 * connected Stripe's payments and customers are read the same way (#10); a
 * source that can't be read fails the batch and tells the owner how to try
 * again. One batch per workspace at a time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  configs: {} as Record<string, Record<string, unknown>>,
  batch: {
    applyPendingItems: vi.fn(),
    loadImportBatch: vi.fn(),
    stageRecords: vi.fn(async (_db: unknown, _batch: unknown, records: unknown[]) => ({ staged: records.length, skipped: 0 })),
    failImportBatch: vi.fn(async () => {}),
  },
  finish: { finishImportBatch: vi.fn(async () => ({ summary: 'done', texted: true })), tellOwner: vi.fn(async () => ({ texted: true })), tellUndo: vi.fn(async () => ({ texted: true })) },
  undo: { undoImportItems: vi.fn(), finishUndo: vi.fn(async () => ({ batch: { id: 'b' }, tallies: { removed: 1, restored: 0, kept: 0 }, transitioned: true })) },
  token: vi.fn(async (): Promise<{ token: string; email: string | null; accountId: string } | null> => ({ token: 'tok', email: null, accountId: 'acct-1' })),
  google: {
    listGoogleContactGroups: vi.fn(async () => ({})),
    listGoogleConnections: vi.fn(),
  },
  stripeAccount: vi.fn(async (): Promise<{ stripeAccountId: string; status: string } | null> => ({ stripeAccountId: 'acct_1', status: 'ready' })),
  stripe: {
    charges: { list: vi.fn() },
    customers: { list: vi.fn() },
  },
}))

vi.mock('../client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handlers[config.id as string] = fn
      hoisted.configs[config.id as string] = config
      return { id: config.id }
    },
  },
}))
// The claim a failure notice takes (notified_at): it succeeds, once.
const claimDb = () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['update', 'eq', 'is', 'select']) chain[m] = () => chain
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'b-1' }], error: null }).then(ok)
  return { from: () => chain }
}
vi.mock('@/lib/admin', () => ({ getServiceClient: claimDb }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidTokenForAccount: hoisted.token }))
vi.mock('@/lib/crm/import/batch', () => hoisted.batch)
vi.mock('@/lib/crm/import/finish', () => hoisted.finish)
vi.mock('@/lib/crm/import/undo', () => hoisted.undo)
vi.mock('@/lib/crm/import/sources/google-contacts', async (orig) => ({ ...(await orig<object>()), ...hoisted.google }))
vi.mock('@/lib/payments/accounts', () => ({ getConnectedAccount: hoisted.stripeAccount }))
vi.mock('@/lib/stripe', () => ({ getStripe: () => hoisted.stripe }))

await import('../contact-import-functions')

const EVENT = { data: { batchId: 'b-1', workspaceId: 'ws-1' } }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.batch.loadImportBatch.mockResolvedValue({ id: 'b-1', status: 'staging', account_id: 'acct-1', total: 0 })
  hoisted.token.mockResolvedValue({ token: 'tok', email: null, accountId: 'acct-1' })
})

describe('registration', () => {
  it('one batch per workspace at a time, for every function', () => {
    // One key for all four (scope env): an apply, an undo and a source read never overlap in one workspace.
    for (const id of ['contact-import-apply', 'contact-import-undo', 'contact-import-google-contacts', 'contact-import-brevo', 'contact-import-stripe']) {
      expect(hoisted.configs[id].concurrency).toEqual([{ limit: 1, key: '"contact-import:" + event.data.workspaceId', scope: 'env' }])
      expect(hoisted.configs[id].onFailure).toEqual(expect.any(Function))
    }
  })
})

describe('apply', () => {
  it('applies chunks until none are left, then finishes (the owner told once)', async () => {
    hoisted.batch.applyPendingItems.mockResolvedValueOnce({ remaining: true }).mockResolvedValueOnce({ remaining: false })
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-apply']({ event: EVENT, step })).toEqual({ status: 'done', summary: 'done' })
    expect(hoisted.batch.applyPendingItems).toHaveBeenCalledTimes(2)
    expect(hoisted.finish.finishImportBatch).toHaveBeenCalledTimes(1)
  })

  it('hands a huge batch on to a fresh run instead of finishing early', async () => {
    hoisted.batch.applyPendingItems.mockResolvedValue({ remaining: true })
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-apply']({ event: EVENT, step })).toEqual({ status: 'continued' })
    expect(step.sendEvent).toHaveBeenCalledWith('continue-apply', { name: 'crm/import.apply', data: EVENT.data })
    expect(hoisted.finish.finishImportBatch).not.toHaveBeenCalled()
  })
})

describe('Google Contacts', () => {
  it('reads every page into the batch, then asks for apply', async () => {
    hoisted.google.listGoogleConnections
      .mockResolvedValueOnce({ people: [{ resourceName: 'people/c1', names: [{ displayName: 'Ana Ruiz' }] }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ people: [{ resourceName: 'people/c2', names: [{ displayName: 'Ben Ode' }] }], nextPageToken: null })
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-google-contacts']({ event: EVENT, step })).toEqual({ status: 'staged' })
    expect(hoisted.google.listGoogleConnections.mock.calls.map((c) => c[1])).toEqual([null, 'p2'])
    expect(hoisted.batch.stageRecords.mock.calls.map((c) => (c[2] as Array<{ externalId: string }>).map((r) => r.externalId))).toEqual([['people/c1'], ['people/c2']])
    expect(step.sendEvent).toHaveBeenCalledWith('apply', { name: 'crm/import.apply', data: EVENT.data })
  })

  it('no token: the batch fails and the owner hears how to try again; nothing is applied', async () => {
    hoisted.token.mockResolvedValue(null)
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-google-contacts']({ event: EVENT, step })).toEqual({ status: 'failed' })
    expect(hoisted.batch.failImportBatch).toHaveBeenCalledWith(expect.anything(), 'b-1', expect.stringContaining('token'))
    expect(hoisted.finish.tellOwner).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining('connect Google Contacts'), 'contact-import-failed-b-1')
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('a batch that is not staging any more (applied, undone) is left alone', async () => {
    hoisted.batch.loadImportBatch.mockResolvedValue({ id: 'b-1', status: 'done', account_id: 'acct-1' })
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-google-contacts']({ event: EVENT, step })).toEqual({ status: 'skipped' })
    expect(hoisted.google.listGoogleConnections).not.toHaveBeenCalled()
  })
})

describe('undo', () => {
  it('undoes chunks, then tells the owner', async () => {
    hoisted.undo.undoImportItems.mockResolvedValueOnce({ remaining: false })
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-undo']({ event: EVENT, step })).toEqual({ status: 'undone' })
    expect(hoisted.finish.tellUndo).toHaveBeenCalledWith(expect.anything(), { id: 'b' }, { removed: 1, restored: 0, kept: 0 })
  })
})

describe('Stripe', () => {
  const STRIPE_BATCH = { id: 'b-1', status: 'staging', source: 'stripe', account_id: null, total: 0 }
  const paid = (id: string, customer: string | null, email?: string) => ({
    id,
    status: 'succeeded',
    paid: true,
    amount: 48_000,
    amount_refunded: 0,
    currency: 'usd',
    created: 1_740_787_200,
    description: 'Rug wash',
    customer,
    billing_details: { email: email ?? null, name: 'Ben Ode' },
  })

  beforeEach(() => {
    hoisted.batch.loadImportBatch.mockResolvedValue(STRIPE_BATCH)
    hoisted.stripeAccount.mockResolvedValue({ stripeAccountId: 'acct_1', status: 'ready' })
    hoisted.stripe.charges.list.mockResolvedValue({ data: [paid('ch_1', 'cus_ana'), paid('ch_2', null, 'ben@example.com')], has_more: false })
    hoisted.stripe.customers.list
      .mockResolvedValueOnce({ data: [{ id: 'cus_ana', name: 'Ana Ruiz', email: 'ana@example.com' }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: 'cus_cy', name: 'Cy Lane', email: 'cy@example.com' }], has_more: false })
  })

  it('reads payments, then every page of customers with theirs, then the guests; then asks for apply', async () => {
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-stripe']({ event: EVENT, step })).toEqual({ status: 'staged' })
    // Every call on the connected account, never the platform's own.
    for (const call of [...hoisted.stripe.charges.list.mock.calls, ...hoisted.stripe.customers.list.mock.calls]) expect(call[1]).toEqual({ stripeAccount: 'acct_1' })
    expect(hoisted.stripe.customers.list.mock.calls.map((c) => c[0])).toEqual([{ limit: 100 }, { limit: 100, starting_after: 'cus_ana' }])
    const staged = hoisted.batch.stageRecords.mock.calls.map((c) => c[2] as Array<{ externalId?: string; emails: string[]; history: unknown[]; relationship: string }>)
    expect(staged.map((page) => page.map((r) => r.externalId ?? r.emails[0]))).toEqual([['cus_ana'], ['cus_cy'], ['ben@example.com']])
    expect(staged[0][0]).toMatchObject({ history: [expect.any(Object)], relationship: 'customer' })
    // Every payment was read and none is Cy's: a lead.
    expect(staged[1][0]).toMatchObject({ history: [], relationship: 'lead' })
    expect(staged[2][0]).toMatchObject({ relationship: 'customer' })
    expect(step.sendEvent).toHaveBeenCalledWith('apply', { name: 'crm/import.apply', data: EVENT.data })
  })

  it('Stripe disconnected since: the batch fails and the owner hears how to try again; nothing is read', async () => {
    hoisted.stripeAccount.mockResolvedValue({ stripeAccountId: 'acct_1', status: 'disconnected' })
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-stripe']({ event: EVENT, step })).toEqual({ status: 'failed' })
    expect(hoisted.batch.failImportBatch).toHaveBeenCalledWith(expect.anything(), 'b-1', 'Stripe is not connected')
    expect(hoisted.finish.tellOwner).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining('Connect Stripe again'), 'contact-import-failed-b-1')
    expect(hoisted.stripe.charges.list).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('a Stripe error fails the batch (what came in stays undoable); another source\'s batch is left alone', async () => {
    hoisted.stripe.charges.list.mockRejectedValue(new Error('rate limited'))
    const step = createStepMock()
    expect(await hoisted.handlers['contact-import-stripe']({ event: EVENT, step })).toEqual({ status: 'failed' })
    expect(hoisted.batch.failImportBatch).toHaveBeenCalledWith(expect.anything(), 'b-1', 'rate limited')
    hoisted.batch.loadImportBatch.mockResolvedValue({ ...STRIPE_BATCH, source: 'brevo' })
    expect(await hoisted.handlers['contact-import-stripe']({ event: EVENT, step: createStepMock() })).toEqual({ status: 'skipped' })
  })
})
