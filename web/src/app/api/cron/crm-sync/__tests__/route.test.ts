import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Tests for GET /api/cron/crm-sync — the HubSpot CRM freshness driver.
 *
 * Invariants locked in:
 *  - Cron auth gate: 503 without CRON_SECRET, 401 on a bad/missing bearer,
 *    neither touching the DB / dispatching events.
 *  - Dispatch matrix: complete+watermark → incremental; pending/failed/missing
 *    → initial import (state row created when missing); importing_* → skip.
 *  - Retroactive push sweep: fired ONLY for workspaces that opted in
 *    (workspace.settings.push_contacts_to_hubspot === true), read via one
 *    batched query over the touched workspace ids. Independent of the
 *    incremental/reimport/skip decision, one event per workspace (deduped), and
 *    never carrying includeFailed (routine ticks don't retry dead contacts).
 *  - JSON summary shape.
 */

// inngest.send is spied so we assert dispatch without a real Inngest call.
const hoisted = vi.hoisted(() => ({ send: vi.fn(async () => ({ ids: ['e'] })) }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.send },
}))

// getServiceClient returns a per-test fake.
let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

const { GET } = await import('@/app/api/cron/crm-sync/route')

type Account = {
  id: string
  user_id: string
  workspace_id: string
  provider: string
}
type State = {
  initial_import_status: string
  sync_watermark: string | null
  workspace_id?: string
} | null

// The push-sweep event fired for an opted-in workspace. The route prefers the
// state row's workspace_id, falling back to the account's.
const sweepEvent = (workspaceId: string) => ({
  name: 'crm/hubspot-push-sweep',
  data: { workspaceId },
})

// Settings map marking the given workspace ids as opted in to contact push.
const pushOn = (...ids: string[]): Record<string, Record<string, unknown>> =>
  Object.fromEntries(ids.map((id) => [id, { push_contacts_to_hubspot: true }]))

/**
 * Fake honoring the exact query shapes the route issues:
 *   connected_account: .select(..).eq('capability','crm').eq('is_enabled',true) → thenable
 *   crm_sync_state (read):  .select(..).eq('account_id', id).maybeSingle()
 *   crm_sync_state (write): .upsert(row, opts)  (awaited)
 *   workspace:          .select('id, settings').in('id', ids) → thenable
 * `stateFor` maps account id → its crm_sync_state row (or null = missing).
 * `settingsFor` maps workspace id → its settings jsonb (absent → {}).
 */
function makeSupabase(opts: {
  accounts: Account[]
  stateFor: Record<string, State>
  settingsFor?: Record<string, Record<string, unknown>>
  accountsError?: { message: string }
  settingsError?: { message: string }
}) {
  const upserts: Array<Record<string, unknown>> = []
  // Workspace ids the batched settings query was asked for.
  let settingsQueriedIds: string[] | null = null

  function accountBuilder() {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: opts.accountsError ? null : opts.accounts,
          error: opts.accountsError ?? null,
        }).then(resolve),
    }
    return api
  }

  function workspaceBuilder() {
    let ids: string[] = []
    const api: Record<string, unknown> = {
      select: () => api,
      in: (_col: string, values: string[]) => {
        ids = values
        settingsQueriedIds = values
        return api
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: opts.settingsError
            ? null
            : ids.map((id) => ({ id, settings: opts.settingsFor?.[id] ?? {} })),
          error: opts.settingsError ?? null,
        }).then(resolve),
    }
    return api
  }

  function stateBuilder() {
    let accountId = ''
    let mode: 'select' | 'upsert' = 'select'
    const api: Record<string, unknown> = {
      select: () => api,
      upsert: (row: Record<string, unknown>) => {
        mode = 'upsert'
        upserts.push(row)
        return api
      },
      eq: (k: string, v: string) => {
        if (k === 'account_id') accountId = v
        return api
      },
      maybeSingle: async () => ({ data: opts.stateFor[accountId] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        // upsert path awaited directly.
        void mode
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return api
  }

  return {
    client: {
      from: (table: string) => {
        if (table === 'connected_account') return accountBuilder()
        if (table === 'workspace') return workspaceBuilder()
        return stateBuilder()
      },
    } as never,
    upserts,
    get settingsQueriedIds() {
      return settingsQueriedIds
    },
  }
}

function request(bearer?: string): NextRequest {
  return new NextRequest('https://dial8.ai/api/cron/crm-sync', {
    headers: bearer !== undefined ? { authorization: bearer } : {},
  })
}

const ACCT = (id: string, workspaceId?: string): Account => ({
  id,
  user_id: `u-${id}`,
  workspace_id: workspaceId ?? `ws-${id}`,
  provider: 'hubspot',
})

beforeEach(() => {
  hoisted.send.mockClear()
  hoisted.send.mockImplementation(async () => ({ ids: ['e'] }))
  vi.stubEnv('CRON_SECRET', 'test-secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  dbFake = null
})
afterEach(() => {
  vi.unstubAllEnvs()
  dbFake = null
})

describe('GET /api/cron/crm-sync — cron auth gate', () => {
  it('returns 503 when CRON_SECRET is unset (no DB, no dispatch)', async () => {
    vi.stubEnv('CRON_SECRET', '')
    dbFake = makeSupabase({ accounts: [], stateFor: {} }).client
    const res = await GET(request('Bearer whatever'))
    expect(res.status).toBe(503)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('returns 401 with a missing bearer', async () => {
    dbFake = makeSupabase({ accounts: [], stateFor: {} }).client
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('returns 401 with a wrong bearer', async () => {
    dbFake = makeSupabase({ accounts: [], stateFor: {} }).client
    const res = await GET(request('Bearer nope'))
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/crm-sync — dispatch matrix', () => {
  it('complete + watermark → incremental sync', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'complete', sync_watermark: '2026-07-24T00:00:00Z' } },
      settingsFor: pushOn('ws-a'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      accounts: 1,
      incremental_synced: 1,
      reimport_triggered: 0,
      push_sweep_triggered: 1,
    })
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'crm/hubspot-incremental-sync',
      data: { accountId: 'a', userId: 'u-a', workspaceId: 'ws-a' },
    })
    // The opted-in workspace also gets the push sweep.
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-a'))
  })

  it('complete but NO watermark → treated as needing initial import', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'complete', sync_watermark: null } },
      settingsFor: pushOn('ws-a'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    // complete-without-watermark falls through the incremental gate; status is
    // not pending/failed/missing so it is neither incremental nor reimport.
    expect(body).toMatchObject({
      incremental_synced: 0,
      reimport_triggered: 0,
      push_sweep_triggered: 1,
    })
    // No sync/reimport dispatch — but the push sweep still fires for the account.
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-a'))
  })

  it('pending → (re)fire initial import', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'pending', sync_watermark: null } },
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ incremental_synced: 0, reimport_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'crm/hubspot-initial-import',
      data: { accountId: 'a', userId: 'u-a', workspaceId: 'ws-a' },
    })
  })

  it('failed → (re)fire initial import', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'failed', sync_watermark: null } },
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ reimport_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crm/hubspot-initial-import' }),
    )
  })

  it('missing state → creates the state row AND fires initial import', async () => {
    const db = makeSupabase({ accounts: [ACCT('a')], stateFor: { a: null } })
    dbFake = db.client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ reimport_triggered: 1 })
    // The state row was created (upsert) before dispatch.
    expect(db.upserts).toHaveLength(1)
    expect(db.upserts[0]).toMatchObject({
      account_id: 'a',
      provider: 'hubspot',
      initial_import_status: 'pending',
    })
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crm/hubspot-initial-import' }),
    )
  })

  it('importing_companies → skip (already running)', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'importing_companies', sync_watermark: null } },
      settingsFor: pushOn('ws-a'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({
      incremental_synced: 0,
      reimport_triggered: 0,
      push_sweep_triggered: 1,
    })
    // Skipped for import, but the push sweep still fires.
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-a'))
  })

  it('importing_contacts → skip (already running)', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'importing_contacts', sync_watermark: '2026-07-24T00:00:00Z' } },
      settingsFor: pushOn('ws-a'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({
      incremental_synced: 0,
      reimport_triggered: 0,
      push_sweep_triggered: 1,
    })
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-a'))
  })

  it('prefers the state row workspace_id for the sweep, else the account', async () => {
    // State row carries a workspace_id that differs from the account's — the
    // sweep must use the (canonical) state row value, and the opt-in must be
    // read for THAT workspace.
    const db = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: {
        a: {
          initial_import_status: 'complete',
          sync_watermark: '2026-07-24T00:00:00Z',
          workspace_id: 'ws-canonical',
        },
      },
      settingsFor: pushOn('ws-canonical'),
    })
    dbFake = db.client
    await GET(request('Bearer test-secret'))
    expect(db.settingsQueriedIds).toEqual(['ws-canonical'])
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-canonical'))
    expect(hoisted.send).not.toHaveBeenCalledWith(sweepEvent('ws-a'))
  })

  it('mixed fleet: one incremental, one reimport, one skip — each also swept', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('inc'), ACCT('re'), ACCT('skip')],
      stateFor: {
        inc: { initial_import_status: 'complete', sync_watermark: '2026-07-24T00:00:00Z' },
        re: { initial_import_status: 'failed', sync_watermark: null },
        skip: { initial_import_status: 'importing_companies', sync_watermark: null },
      },
      settingsFor: pushOn('ws-inc', 'ws-re', 'ws-skip'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({
      accounts: 3,
      incremental_synced: 1,
      reimport_triggered: 1,
      push_sweep_triggered: 3,
    })
    // 2 import-related dispatches + 3 sweeps = 5.
    expect(hoisted.send).toHaveBeenCalledTimes(5)
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-inc'))
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-re'))
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-skip'))
  })

  it('returns 500 when the account query errors', async () => {
    dbFake = makeSupabase({ accounts: [], stateFor: {}, accountsError: { message: 'db down' } }).client
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})

// ---- Push-sweep opt-in gate -------------------------------------------------

describe('GET /api/cron/crm-sync — push sweep fires only for opted-in workspaces', () => {
  it('does NOT sweep a workspace with the push flag absent (the default)', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'complete', sync_watermark: '2026-07-24T00:00:00Z' } },
      settingsFor: {}, // no push_contacts_to_hubspot key at all
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ incremental_synced: 1, push_sweep_triggered: 0 })
    // Only the incremental sync — no sweep event for a workspace that never
    // opted in (the whole point: don't burn a run per tick to learn that).
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).not.toHaveBeenCalledWith(sweepEvent('ws-a'))
  })

  it('does NOT sweep a workspace with the push flag explicitly false', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'importing_contacts', sync_watermark: null } },
      settingsFor: { 'ws-a': { push_contacts_to_hubspot: false, log_meetings_to_hubspot: true } },
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ push_sweep_triggered: 0 })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('treats a non-true (truthy) push flag as off', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'importing_contacts', sync_watermark: null } },
      settingsFor: { 'ws-a': { push_contacts_to_hubspot: 'yes' } },
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ push_sweep_triggered: 0 })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('sweeps only the opted-in workspaces in a mixed fleet', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('on'), ACCT('off')],
      stateFor: {
        on: { initial_import_status: 'importing_contacts', sync_watermark: null },
        off: { initial_import_status: 'importing_contacts', sync_watermark: null },
      },
      settingsFor: pushOn('ws-on'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ accounts: 2, push_sweep_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-on'))
    expect(hoisted.send).not.toHaveBeenCalledWith(sweepEvent('ws-off'))
  })

  it('reads the opt-in with ONE batched query over the touched workspace ids', async () => {
    const db = makeSupabase({
      accounts: [ACCT('a'), ACCT('b')],
      stateFor: {
        a: { initial_import_status: 'importing_contacts', sync_watermark: null },
        b: { initial_import_status: 'importing_contacts', sync_watermark: null },
      },
      settingsFor: pushOn('ws-a', 'ws-b'),
    })
    dbFake = db.client
    await GET(request('Bearer test-secret'))
    expect(db.settingsQueriedIds).toEqual(['ws-a', 'ws-b'])
  })

  it('sends ONE sweep for two accounts sharing a workspace (deduped)', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a', 'ws-shared'), ACCT('b', 'ws-shared')],
      stateFor: {
        a: { initial_import_status: 'importing_contacts', sync_watermark: null },
        b: { initial_import_status: 'importing_contacts', sync_watermark: null },
      },
      settingsFor: pushOn('ws-shared'),
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ accounts: 2, push_sweep_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith(sweepEvent('ws-shared'))
  })

  it('never sets includeFailed — routine ticks do not retry dead contacts', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'importing_contacts', sync_watermark: null } },
      settingsFor: pushOn('ws-a'),
    }).client
    await GET(request('Bearer test-secret'))
    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
    expect(payload.data).toEqual({ workspaceId: 'ws-a' })
    expect(payload.data.includeFailed).toBeUndefined()
  })

  it('skips no workspaces when there are no accounts (no settings query, no sweep)', async () => {
    const db = makeSupabase({ accounts: [], stateFor: {} })
    dbFake = db.client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ accounts: 0, push_sweep_triggered: 0 })
    expect(db.settingsQueriedIds).toBeNull()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('still 200s (imports dispatched) when the settings query errors — no sweeps', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a')],
      stateFor: { a: { initial_import_status: 'complete', sync_watermark: '2026-07-24T00:00:00Z' } },
      settingsError: { message: 'settings read failed' },
    }).client
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ incremental_synced: 1, push_sweep_triggered: 0 })
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crm/hubspot-incremental-sync' }),
    )
  })

  it('a failing sweep send does not fail the cron or block the next workspace', async () => {
    dbFake = makeSupabase({
      accounts: [ACCT('a'), ACCT('b')],
      stateFor: {
        a: { initial_import_status: 'importing_contacts', sync_watermark: null },
        b: { initial_import_status: 'importing_contacts', sync_watermark: null },
      },
      settingsFor: pushOn('ws-a', 'ws-b'),
    }).client
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    // First send threw (uncounted); the second still fired.
    expect(body).toMatchObject({ push_sweep_triggered: 1 })
    expect(hoisted.send).toHaveBeenCalledTimes(2)
  })
})
