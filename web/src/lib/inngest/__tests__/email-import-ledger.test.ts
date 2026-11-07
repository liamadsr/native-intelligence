import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

/**
 * The Gmail / Outlook initial import's Activity row (Sequence row 11,
 * src/lib/work/import-mirror.ts), via the createFunction-capture pattern: the
 * import opens its run keyed on the start it stamps and, with no backfill,
 * finishes it once the last 30 days are in.
 */

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  ledger: {
    openEmailImport: vi.fn(async () => {}),
    finishEmailImport: vi.fn(async () => {}),
  },
  gmail: {
    fetchGmailHistory: vi.fn(),
    fetchGmailProfile: vi.fn(async () => ({ historyId: 'h-1' })),
  },
  indexRecentThreads: vi.fn(async (..._a: unknown[]) => ({ synced: 0 })),
  tables: [] as string[],
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, fn: Handler) => {
      hoisted.handlers[config.id] = fn
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/work/import-mirror', () => hoisted.ledger)
vi.mock('@/lib/email/gmail-api', () => hoisted.gmail)
vi.mock('@/lib/email/outlook-api', () => ({
  fetchOutlookDelta: vi.fn(),
  getOutlookDeltaLink: vi.fn(),
}))
vi.mock('@/lib/crm/email-sync', () => ({ indexRecentThreads: hoisted.indexRecentThreads }))
vi.mock('@/lib/email/gmail-watch', () => ({ setupGmailWatch: vi.fn(async () => {}) }))
vi.mock('@/lib/email/outlook-webhook', () => ({ setupOutlookSubscription: vi.fn(async () => {}) }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => ({ token: 'tok' })),
  getValidTokenForAccount: vi.fn(async () => ({ token: 'tok' })),
}))

/** One email_sync_state row; every builder reads and patches it. */
let syncRow: Record<string, unknown> | null = null
const inserts: Array<Record<string, unknown>> = []
function makeDb() {
  function builder() {
    let patch: Record<string, unknown> | null = null
    let insert: Record<string, unknown> | null = null
    const api: Record<string, unknown> = {
      select: () => api,
      match: () => api,
      eq: () => api,
      update: (p: Record<string, unknown>) => {
        patch = p
        return api
      },
      insert: (row: Record<string, unknown>) => {
        insert = row
        return api
      },
      maybeSingle: async () => ({ data: syncRow, error: null }),
      single: async () => ({ data: syncRow, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (patch) syncRow = { ...(syncRow ?? {}), ...patch }
        if (insert) {
          inserts.push(insert)
          syncRow = { id: 'ss-1', ...insert }
        }
        patch = insert = null
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return api
  }
  return { from: (table: string) => { hoisted.tables.push(table); return builder() } }
}
const db = makeDb()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db }))

await import('@/lib/inngest/email-functions')

const EVENT = { data: { userId: 'u-1', workspaceId: 'ws-1', provider: 'google', accountId: 'acct-1' } }
const REF = { workspaceId: 'ws-1', userId: 'u-1', provider: 'google', accountId: 'acct-1' }

beforeEach(() => {
  vi.clearAllMocks()
  syncRow = null
  inserts.length = 0
  hoisted.tables.length = 0
})

describe('email initial import — the Activity row', () => {
  it('opens the run keyed on the start it stamps, then finishes once the recent mail is in', async () => {
    hoisted.indexRecentThreads.mockResolvedValueOnce({ synced: 42 })
    const step = createStepMock()

    await hoisted.handlers['email-initial-import']({ event: EVENT, step })

    const startedAt = inserts[0].initial_import_started_at
    expect(startedAt).toBeTruthy()
    expect(hoisted.ledger.openEmailImport).toHaveBeenCalledWith(db, REF, startedAt)
    expect(hoisted.ledger.finishEmailImport).toHaveBeenCalledWith(db, REF, 42)
    // Opened before any mail is fetched; finished after the webhook is set up.
    const ids = step.run.mock.calls.map((c) => c[0])
    expect(ids.indexOf('ledger-open')).toBeLessThan(ids.indexOf('index-recent-threads'))
    expect(ids.indexOf('ledger-finish')).toBeGreaterThan(ids.indexOf('setup-webhook'))
  })

  it('completes with the checkpoint in one write and starts no backfill', async () => {
    hoisted.indexRecentThreads.mockResolvedValueOnce({ synced: 42 })
    const step = createStepMock()

    await hoisted.handlers['email-initial-import']({ event: EVENT, step })

    expect(syncRow).toMatchObject({
      gmail_history_id: 'h-1',
      initial_import_status: 'complete',
      total_messages_synced: 42,
    })
    expect(syncRow?.initial_import_completed_at).toBeTruthy()
    // Only the last 30 days, indexed from metadata once, and nothing handed on to a backfill.
    expect(hoisted.indexRecentThreads).toHaveBeenCalledTimes(1)
    expect(hoisted.indexRecentThreads.mock.calls[0][0]).toMatchObject({ userId: 'u-1', workspaceId: 'ws-1', provider: 'google', accountId: 'acct-1' })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(hoisted.handlers['email-backfill-older']).toBeUndefined()
  })

  it('stores no mail: the import writes only its sync state (the index is metadata, via indexRecentThreads)', async () => {
    await hoisted.handlers['email-initial-import']({ event: EVENT, step: createStepMock() })
    expect([...new Set(hoisted.tables)]).toEqual(['email_sync_state'])
  })

  it('a legacy user+provider account carries no account id into the run', async () => {
    const step = createStepMock()
    await hoisted.handlers['email-initial-import']({
      event: { data: { userId: 'u-1', workspaceId: 'ws-1', provider: 'google' } },
      step,
    })
    expect(hoisted.ledger.openEmailImport).toHaveBeenCalledWith(db, { ...REF, accountId: null }, expect.any(String))
  })
})
