import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

/**
 * The push path, via the createFunction-capture pattern: email-incremental-sync
 * reads which threads changed (ids only), indexes and triages them once from
 * metadata (triageArrivals), and hands the draftable and held ones to
 * email-draft-replies, which refreshes holds, drafts within the cap and
 * records one Activity row. Nothing is stored but ids, flags and addresses.
 */

type Handler = (ctx: { event: { id?: string; data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  triageArrivals: vi.fn(),
  indexRecentThreads: vi.fn(async () => ({ synced: 3 })),
  draftRepliesToNewMail: vi.fn(),
  arrivalGate: vi.fn(async () => ({ blocked: null as string | null, remaining: 5 })),
  refreshHeldThreads: vi.fn(),
  recordArrivalDrafts: vi.fn(async () => {}),
  recordDraftPassEvents: vi.fn(async (..._a: unknown[]) => 0),
  tables: [] as string[],
  history: vi.fn(async () => ({
    history: [
      { messagesAdded: [{ message: { id: 'm-2', threadId: 't-1' } }] },
      { labelsRemoved: [{ message: { id: 'm-0', threadId: 't-3' } }], messagesDeleted: [{ message: { id: 'm-9', threadId: 't-4' } }] },
    ],
    historyId: 'h-2',
  })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, fn: Handler) => {
      hoisted.handlers[config.id] = fn
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/email/triage', () => ({ triageArrivals: hoisted.triageArrivals, MAX_ARRIVAL_THREADS: 2 }))
vi.mock('@/lib/crm/email-sync', () => ({ indexRecentThreads: hoisted.indexRecentThreads }))
vi.mock('@/lib/email/arrival-drafts', async (importOriginal) => ({
  draftRepliesToNewMail: hoisted.draftRepliesToNewMail,
  recordArrivalDrafts: hoisted.recordArrivalDrafts,
  arrivalGate: hoisted.arrivalGate,
  dailyCapCheck: () => async () => true,
  unsureReasons: (await importOriginal<typeof import('@/lib/email/arrival-drafts')>()).unsureReasons,
}))
vi.mock('@/lib/email/held-refresh', () => ({ refreshHeldThreads: hoisted.refreshHeldThreads }))
vi.mock('@/lib/email/hold', () => ({ expireHolds: vi.fn() }))
vi.mock('@/lib/agent-events/email', () => ({ recordDraftPassEvents: hoisted.recordDraftPassEvents }))
vi.mock('@/lib/email/gmail-api', () => ({
  fetchGmailProfile: vi.fn(async () => ({ historyId: 'h-0' })),
  fetchGmailHistory: hoisted.history,
}))
vi.mock('@/lib/email/outlook-api', () => ({
  fetchOutlookDelta: vi.fn(),
  getOutlookDeltaLink: vi.fn(),
}))
vi.mock('@/lib/email/gmail-watch', () => ({ setupGmailWatch: vi.fn() }))
vi.mock('@/lib/email/outlook-webhook', () => ({ setupOutlookSubscription: vi.fn() }))
vi.mock('@/lib/work/import-mirror', () => ({ openEmailImport: vi.fn(), finishEmailImport: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => ({ token: 'tok', email: 'me@x.com' })),
  getValidTokenForAccount: vi.fn(async () => ({ token: 'tok', email: 'me@x.com' })),
}))

/** email_sync_state reads back a Gmail checkpoint; every write succeeds. */
const db = {
  from: (table: string) => {
    hoisted.tables.push(table)
    const api: Record<string, unknown> = {
      select: () => api,
      match: () => api,
      eq: () => api,
      in: () => api,
      update: () => api,
      delete: () => api,
      single: async () => ({ data: { gmail_history_id: 'h-1' }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    }
    return api
  },
}
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db }))

await import('@/lib/inngest/email-functions')

const SYNC = { data: { userId: 'u-1', workspaceId: 'ws-1', provider: 'google', accountId: 'acct-1' } }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.tables.length = 0
  hoisted.triageArrivals.mockResolvedValue({ draftable: ['t-1'], held: [], indexed: 3 })
})

describe('email-incremental-sync → index and triage on arrival', () => {
  it('reads which threads changed (ids only), indexes and triages them once, and hands on the draftable ones', async () => {
    const step = createStepMock()
    const result = await hoisted.handlers['email-incremental-sync']({ event: SYNC, step })

    // Every changed thread is indexed, MAX_ARRIVAL_THREADS (2 here) a step: none is lost past the checkpoint.
    expect(hoisted.triageArrivals.mock.calls.map((c) => (c[1] as { threadIds: string[] }).threadIds)).toEqual([['t-1', 't-3'], ['t-4']])
    expect(hoisted.triageArrivals).toHaveBeenCalledWith(db, {
      userId: 'u-1',
      provider: 'google',
      accountId: 'acct-1',
      workspaceId: 'ws-1',
      threadIds: ['t-1', 't-3'],
      accessToken: 'tok',
      mailboxEmail: 'me@x.com',
    })
    expect(step.sendEvent).toHaveBeenCalledWith('draft-replies', {
      name: 'email/draft-replies',
      data: { userId: 'u-1', workspaceId: 'ws-1', threadIds: ['t-1'], heldThreadIds: [], provider: 'google', accountId: 'acct-1', mailboxEmail: 'me@x.com' },
    })
    expect(result).toMatchObject({ drafting: 1 })
  })

  it('stores no mail: the push writes its sync state only (the index goes through triage)', async () => {
    await hoisted.handlers['email-incremental-sync']({ event: SYNC, step: createStepMock() })
    expect([...new Set(hoisted.tables)]).toEqual(['email_sync_state'])
  })

  it('every step returns ids and counts only (Inngest keeps them)', async () => {
    const step = createStepMock()
    await hoisted.handlers['email-incremental-sync']({ event: SYNC, step })
    const outputs = await Promise.all(step.run.mock.results.map((r) => r.value))
    expect(JSON.stringify(outputs)).not.toMatch(/subject|snippet|body/i)
  })

  it('hands held threads to the hold refresh even when nothing is draftable', async () => {
    hoisted.triageArrivals.mockResolvedValue({ draftable: [], held: ['t-3'], indexed: 3 })
    const step = createStepMock()
    await hoisted.handlers['email-incremental-sync']({ event: SYNC, step })
    expect(step.sendEvent).toHaveBeenCalledWith('draft-replies', expect.objectContaining({ data: expect.objectContaining({ threadIds: [], heldThreadIds: ['t-3'] }) }))
  })

  it('sends nothing when no thread needs a drafted reply and none is held', async () => {
    hoisted.triageArrivals.mockResolvedValue({ draftable: [], held: [], indexed: 1 })
    const step = createStepMock()
    await hoisted.handlers['email-incremental-sync']({ event: SYNC, step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('an expired Gmail history re-indexes the last 30 days instead of triaging', async () => {
    hoisted.history.mockRejectedValueOnce(new Error('HISTORY_EXPIRED'))
    const step = createStepMock()
    await hoisted.handlers['email-incremental-sync']({ event: SYNC, step })
    expect(hoisted.indexRecentThreads).toHaveBeenCalledTimes(1)
    expect(hoisted.triageArrivals).not.toHaveBeenCalled()
  })
})

describe('email-draft-replies', () => {
  const EVENT = { id: 'evt-1', data: { userId: 'u-1', workspaceId: 'ws-1', threadIds: ['t-1', 't-2'] } }
  const DRAFT = { id: 'd-1', email_thread_id: 'idx-1', created_at: '2026-10-15T09:00:00.000Z' }

  beforeEach(() => {
    hoisted.recordArrivalDrafts.mockClear()
    hoisted.recordDraftPassEvents.mockClear()
  })

  it('refreshes held threads through the same gates, and counts their re-drafts with the rest', async () => {
    const REDRAFT = { id: 'd-2', email_thread_id: 'idx-2', created_at: null }
    hoisted.refreshHeldThreads.mockResolvedValueOnce({ redrafted: [REDRAFT], staled: 1, released: 0 })
    hoisted.draftRepliesToNewMail.mockResolvedValueOnce({ drafts: [], blocked: null })
    const step = createStepMock()
    const event = { id: 'evt-2', data: { ...EVENT.data, heldThreadIds: ['t-9'], provider: 'google', accountId: 'acct-1', mailboxEmail: 'me@x.com' } }
    const result = await hoisted.handlers['email-draft-replies']({ event, step })
    expect(hoisted.refreshHeldThreads).toHaveBeenCalledWith(db, expect.objectContaining({
      userId: 'u-1', workspaceId: 'ws-1', accountId: 'acct-1', provider: 'google', providerThreadIds: ['t-9'], mailboxEmail: 'me@x.com', mayDraft: true,
    }))
    expect(result).toMatchObject({ drafted: 1, staled: 1, released: 0 })
  })

  it('a gated pass refreshes held threads without re-drafting (stale instead)', async () => {
    hoisted.arrivalGate.mockResolvedValueOnce({ blocked: 'paused', remaining: 0 })
    hoisted.refreshHeldThreads.mockResolvedValueOnce({ redrafted: [], staled: 1, released: 0 })
    hoisted.draftRepliesToNewMail.mockResolvedValueOnce({ drafts: [], blocked: 'paused' })
    const event = { id: 'evt-3', data: { ...EVENT.data, heldThreadIds: ['t-9'], provider: 'google', accountId: 'acct-1' } }
    await hoisted.handlers['email-draft-replies']({ event, step: createStepMock() })
    expect(hoisted.refreshHeldThreads).toHaveBeenCalledWith(db, expect.objectContaining({ mayDraft: false }))
  })

  it('drafts the threads, records one Activity row keyed on the event, and the agent events', async () => {
    hoisted.draftRepliesToNewMail.mockResolvedValueOnce({ drafts: [DRAFT], blocked: null })
    hoisted.recordDraftPassEvents.mockResolvedValueOnce(2)
    const step = createStepMock()
    const result = await hoisted.handlers['email-draft-replies']({ event: EVENT, step })

    expect(hoisted.draftRepliesToNewMail).toHaveBeenCalledWith(db, 'u-1', 'ws-1', ['t-1', 't-2'])
    expect(hoisted.recordArrivalDrafts).toHaveBeenCalledWith(db, {
      userId: 'u-1',
      workspaceId: 'ws-1',
      runKey: 'email-arrival-drafts:evt-1',
      drafts: [DRAFT],
    })
    // The cron's shape: the drafts, and these threads still waiting (reason 'not_drafted' by default).
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(db, {
      userId: 'u-1',
      workspaceId: 'ws-1',
      drafts: [DRAFT],
      providerThreadIds: ['t-1', 't-2'],
    })
    expect(result).toEqual({ drafted: 1, blocked: null, events: 2 })
  })

  it('a thread the gate asked about waits as unsure, so the agent asks the person first (E3)', async () => {
    hoisted.draftRepliesToNewMail.mockResolvedValueOnce({ drafts: [], blocked: null, asked: ['t-2'] })
    hoisted.recordDraftPassEvents.mockResolvedValueOnce(1)
    await hoisted.handlers['email-draft-replies']({ event: EVENT, step: createStepMock() })
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(db, {
      userId: 'u-1', workspaceId: 'ws-1', drafts: [], providerThreadIds: ['t-1', 't-2'], reasons: { 't-2': 'unsure' },
    })
  })

  it('a gated pass writes no Activity row but still tells the agent which threads wait, and why', async () => {
    for (const blocked of ['paused', 'dormant', 'usage', 'cap'] as const) {
      hoisted.draftRepliesToNewMail.mockResolvedValueOnce({ drafts: [], blocked })
      const step = createStepMock()
      expect(await hoisted.handlers['email-draft-replies']({ event: EVENT, step })).toMatchObject({ drafted: 0, blocked })
      expect(hoisted.recordDraftPassEvents).toHaveBeenLastCalledWith(db, {
        userId: 'u-1',
        workspaceId: 'ws-1',
        drafts: [],
        providerThreadIds: ['t-1', 't-2'],
        reason: blocked,
      })
    }
    expect(hoisted.recordArrivalDrafts).not.toHaveBeenCalled()
  })
})
