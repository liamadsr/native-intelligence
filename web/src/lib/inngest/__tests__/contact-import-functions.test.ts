/**
 * The importer's Inngest functions (roadmap track G): apply runs a batch's
 * chunks then finishes it (the owner's text) or hands on to a fresh run;
 * Google Contacts reads every page into the batch, then asks for apply; a
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
    for (const id of ['contact-import-apply', 'contact-import-undo', 'contact-import-google-contacts', 'contact-import-brevo']) {
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
