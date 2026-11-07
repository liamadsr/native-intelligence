import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'

/**
 * Tests for src/lib/tasks/asana-config.ts — the ONLY module that reads or writes
 * `task_sync_state`.
 *
 * Every consumer of this file mocks it, which is exactly why it needs tests of
 * its own: the parts that matter here are not the return values (those are
 * trivially mockable) but the QUERY PREDICATES, and a mocked module proves
 * nothing about them. Two of them are load-bearing beyond ordinary correctness:
 *
 *  - claimAsanaWebhookSecret's WHERE clause IS the security boundary of the
 *    webhook receiver. It must be single-use (the claim NULLs the window it
 *    consumed) and time-boxed (an abandoned window ages out), while still
 *    deliberately overwriting a live secret — that overwrite is the atomic
 *    key-swap a re-registration depends on.
 *  - which columns each reader SELECTs. `webhook_secret` must be asked for by
 *    loadAsanaWebhookAuth and by nothing else, so the reconcile sweep can never
 *    hold a forging key it has no use for. That is asserted on the recorded
 *    select list, not on the returned object, so widening the query is caught
 *    even if the extra column is subsequently dropped.
 *
 * These run the REAL query chains against the filter-aware fake in
 * src/test/asana-remote-fake.ts, which applies eq/not/gt to actual rows.
 */

let dbFake: AsanaRemoteFake = createAsanaRemoteFake()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake.client }))

const {
  ASANA_PROVIDER,
  ASANA_WEBHOOK_PENDING_TTL_MS,
  claimAsanaWebhookSecret,
  clearAsanaWebhookRegistration,
  includesAsanaAttribution,
  listAsanaSyncStates,
  listAsanaWebhookGidsForAccount,
  loadAsanaReconcileState,
  loadAsanaSyncState,
  loadAsanaWebhookAuth,
  openAsanaWebhookPending,
  parseAsanaConfig,
  saveAsanaConfig,
  saveAsanaWebhookRegistration,
  sectionForBucket,
  stampAsanaReconciledAt,
} = await import('@/lib/tasks/asana-config')

// ---- Helpers ---------------------------------------------------------------

const SYNC_STATE_ID = 'tss-1'

const CONFIG = {
  asana_workspace_gid: 'aw-1',
  asana_workspace_name: 'Acme',
  project_gid: 'proj-1',
  project_name: 'Engineering',
  section_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
}

/** A single registered sync state, overridable per test. */
function setDb(row: Record<string, unknown> = {}, extra: Array<Record<string, unknown>> = []) {
  dbFake = createAsanaRemoteFake({
    syncStates: [
      {
        id: SYNC_STATE_ID,
        workspace_id: 'ws-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        provider: ASANA_PROVIDER,
        config: CONFIG,
        created_at: '2026-07-01T00:00:00.000Z',
        ...row,
      } as never,
      ...(extra as never[]),
    ],
  })
  return dbFake
}

/** Minutes ago, as an ISO timestamp. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString()
}

/** The row the fake is holding right now. */
function row(id = SYNC_STATE_ID) {
  return dbFake.syncStates.find((r) => r.id === id)!
}

/** Filters recorded on the Nth task_sync_state WRITE. */
function writeFilters(n = 0) {
  return dbFake.syncStateUpdates[n].filters
}

beforeEach(() => {
  vi.clearAllMocks()
  setDb()
})

// ---- parseAsanaConfig ------------------------------------------------------

describe('parseAsanaConfig', () => {
  it('degrades a junk row to "not configured" rather than throwing', () => {
    expect(parseAsanaConfig(null)).toEqual({})
    expect(parseAsanaConfig({ project_gid: 42, project_name: '' })).toEqual({})
    expect(parseAsanaConfig({ section_map: ['nope'] })).toEqual({})
  })

  it('normalizes a partial section_map to all four buckets', () => {
    expect(parseAsanaConfig({ section_map: { done: 's-done', canceled: 7 } })).toEqual({
      section_map: { not_started: null, in_progress: null, done: 's-done', canceled: null },
    })
  })

  it('sectionForBucket reads through, treating blanks as unmapped', () => {
    expect(sectionForBucket({ section_map: { done: 's-done' } }, 'done')).toBe('s-done')
    expect(sectionForBucket({ section_map: { done: '' } }, 'done')).toBeNull()
    expect(sectionForBucket({}, 'done')).toBeNull()
  })

  it('carries include_dial8_attribution through only as a real boolean', () => {
    expect(parseAsanaConfig({ include_dial8_attribution: false })).toEqual({
      include_dial8_attribution: false,
    })
    expect(parseAsanaConfig({ include_dial8_attribution: true })).toEqual({
      include_dial8_attribution: true,
    })
    // A hand-edited string is left ABSENT rather than coerced — "false" is
    // truthy, and coercing it would silently flip an opt-out into an opt-in.
    expect(parseAsanaConfig({ include_dial8_attribution: 'false' })).toEqual({})
    expect(parseAsanaConfig({ include_dial8_attribution: 0 })).toEqual({})
  })
})

describe('includesAsanaAttribution', () => {
  it('defaults to ON when the key is absent — every pre-existing connection', () => {
    expect(includesAsanaAttribution({})).toBe(true)
    expect(includesAsanaAttribution({ project_gid: 'proj-1' })).toBe(true)
  })

  it('is off ONLY for an explicit false', () => {
    expect(includesAsanaAttribution({ include_dial8_attribution: false })).toBe(false)
    expect(includesAsanaAttribution({ include_dial8_attribution: true })).toBe(true)
  })
})

// ---- Readers ---------------------------------------------------------------

describe('loadAsanaSyncState', () => {
  it('scopes to the workspace AND the asana provider', async () => {
    await loadAsanaSyncState('ws-1')

    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'workspace_id', val: 'ws-1' },
      { op: 'eq', col: 'provider', val: 'asana' },
    ])
  })

  it('NEVER selects a webhook column — this is what the settings GET returns', async () => {
    const state = await loadAsanaSyncState('ws-1')

    expect(dbFake.syncStateQueries[0].columns).toEqual(['id', 'account_id', 'user_id', 'config'])
    expect(JSON.stringify(state)).not.toContain('webhook')
    expect(state).toEqual({
      id: SYNC_STATE_ID,
      accountId: 'acct-1',
      userId: 'u-1',
      config: CONFIG,
    })
  })

  it('picks the OLDEST row when a workspace has two connected accounts', async () => {
    // Stable destination: it must not flip based on who connected most recently.
    setDb({ created_at: '2026-07-01T00:00:00.000Z' }, [
      {
        id: 'tss-newer',
        workspace_id: 'ws-1',
        account_id: 'acct-2',
        user_id: 'u-2',
        provider: ASANA_PROVIDER,
        config: {},
        created_at: '2026-07-09T00:00:00.000Z',
      },
    ])

    expect((await loadAsanaSyncState('ws-1'))?.id).toBe(SYNC_STATE_ID)
  })

  it('returns null for a workspace with no Asana row', async () => {
    expect(await loadAsanaSyncState('ws-OTHER')).toBeNull()
  })
})

describe('loadAsanaWebhookAuth', () => {
  it('is the ONE reader that asks for webhook_secret, and returns it', async () => {
    setDb({ webhook_gid: 'wh-1', webhook_secret: 'shh' })

    const auth = await loadAsanaWebhookAuth(SYNC_STATE_ID)

    expect(dbFake.syncStateQueries[0].columns).toContain('webhook_secret')
    expect(auth).toEqual({
      id: SYNC_STATE_ID,
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-1',
      webhookGid: 'wh-1',
      webhookSecret: 'shh',
      projectGid: 'proj-1',
    })
  })

  it('scopes to the id AND the provider', async () => {
    await loadAsanaWebhookAuth(SYNC_STATE_ID)
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
      { op: 'eq', col: 'provider', val: 'asana' },
    ])
  })

  it('nulls an unregistered row\'s webhook columns rather than omitting them', async () => {
    const auth = await loadAsanaWebhookAuth(SYNC_STATE_ID)
    expect(auth).toMatchObject({ webhookGid: null, webhookSecret: null })
  })

  it('returns null for an unknown id (the receiver 401s on it)', async () => {
    expect(await loadAsanaWebhookAuth('tss-UNKNOWN')).toBeNull()
  })
})

describe('loadAsanaReconcileState', () => {
  it('NEVER selects webhook_secret — the sweep has no use for a forging key', async () => {
    setDb({ webhook_secret: 'shh', last_reconcile_at: '2026-07-20T00:00:00.000Z' })

    const state = await loadAsanaReconcileState(SYNC_STATE_ID)

    const { columns } = dbFake.syncStateQueries[0]
    expect(columns).toEqual(['id', 'workspace_id', 'account_id', 'user_id', 'last_reconcile_at'])
    expect(columns).not.toContain('webhook_secret')
    expect(columns).not.toContain('webhook_gid')
    expect(JSON.stringify(state)).not.toContain('shh')
    expect(state).toEqual({
      id: SYNC_STATE_ID,
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-1',
      lastReconcileAt: '2026-07-20T00:00:00.000Z',
    })
  })

  it('scopes to the id AND the provider', async () => {
    await loadAsanaReconcileState(SYNC_STATE_ID)
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
      { op: 'eq', col: 'provider', val: 'asana' },
    ])
  })
})

describe('listAsanaSyncStates', () => {
  it('filters on provider=asana — task_sync_state is not asana-only forever', async () => {
    setDb({}, [
      {
        id: 'tss-jira',
        workspace_id: 'ws-2',
        account_id: 'acct-9',
        user_id: 'u-9',
        provider: 'jira',
        config: {},
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ])

    const states = await listAsanaSyncStates()

    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'provider', val: 'asana' },
    ])
    expect(states).toEqual([{ id: SYNC_STATE_ID, workspaceId: 'ws-1' }])
  })

  it('THROWS on a DB error so the cron 500s instead of reporting an empty fleet', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    await expect(listAsanaSyncStates()).rejects.toThrow('db down')
  })
})

describe('listAsanaWebhookGidsForAccount', () => {
  it('returns only rows that actually carry a gid, scoped to the account', async () => {
    setDb({ webhook_gid: 'wh-1' })

    const gids = await listAsanaWebhookGidsForAccount('acct-1')

    expect(gids).toEqual(['wh-1'])
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'account_id', val: 'acct-1' },
      { op: 'eq', col: 'provider', val: 'asana' },
      { op: 'not', col: 'webhook_gid', val: null, notOp: 'is' },
    ])
  })

  it('is empty for an account that never completed a registration', async () => {
    setDb({ webhook_gid: null })
    expect(await listAsanaWebhookGidsForAccount('acct-1')).toEqual([])
  })
})

// ---- Plain writers ---------------------------------------------------------

describe('saveAsanaConfig', () => {
  it('writes the config and stamps updated_at, keyed on the row id', async () => {
    const next = { ...CONFIG, project_gid: 'proj-2' }

    expect(await saveAsanaConfig(SYNC_STATE_ID, next)).toEqual({ error: null })

    expect(row().config).toEqual(next)
    expect(dbFake.syncStateUpdates[0].patch.updated_at).toBeTruthy()
    expect(writeFilters()).toEqual([{ op: 'eq', col: 'id', val: SYNC_STATE_ID }])
  })

  it('reports a DB error rather than throwing (the route turns it into a 500)', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    expect(await saveAsanaConfig(SYNC_STATE_ID, {})).toEqual({ error: 'db down' })
  })
})

describe('saveAsanaWebhookRegistration', () => {
  it('stamps the gid and registered_at together', async () => {
    expect(await saveAsanaWebhookRegistration(SYNC_STATE_ID, 'wh-new')).toEqual({ error: null })

    expect(row()).toMatchObject({ webhook_gid: 'wh-new' })
    expect(row().webhook_registered_at).toBeTruthy()
    expect(writeFilters()).toEqual([{ op: 'eq', col: 'id', val: SYNC_STATE_ID }])
  })

  it('surfaces a write failure so the caller can roll the Asana create back', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    expect(await saveAsanaWebhookRegistration(SYNC_STATE_ID, 'wh-new')).toEqual({
      error: 'db down',
    })
  })
})

describe('clearAsanaWebhookRegistration', () => {
  it('nulls the gid, the secret, registered_at AND any open pending window', async () => {
    // All four together: a torn-down row must keep no verification key and no
    // standing invitation to plant one.
    setDb({
      webhook_gid: 'wh-1',
      webhook_secret: 'shh',
      webhook_registered_at: '2026-07-01T00:00:00.000Z',
      webhook_pending_at: minutesAgo(0),
    })

    expect(await clearAsanaWebhookRegistration(SYNC_STATE_ID)).toEqual({ error: null })

    expect(row()).toMatchObject({
      webhook_gid: null,
      webhook_secret: null,
      webhook_registered_at: null,
      webhook_pending_at: null,
    })
  })
})

describe('stampAsanaReconciledAt', () => {
  it('sets last_reconcile_at, which is what drives the 6-hour gate', async () => {
    expect(await stampAsanaReconciledAt(SYNC_STATE_ID)).toEqual({ error: null })
    expect(row().last_reconcile_at).toBeTruthy()
    expect(writeFilters()).toEqual([{ op: 'eq', col: 'id', val: SYNC_STATE_ID }])
  })
})

// ---- The handshake window --------------------------------------------------

describe('openAsanaWebhookPending', () => {
  it('opens a fresh window, scoped to the id AND the provider', async () => {
    expect(await openAsanaWebhookPending(SYNC_STATE_ID)).toEqual({ error: null })

    const opened = row().webhook_pending_at as string
    expect(Date.now() - new Date(opened).getTime()).toBeLessThan(5_000)
    expect(writeFilters()).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
      { op: 'eq', col: 'provider', val: 'asana' },
    ])
  })

  it('does NOT disturb an existing registration — the swap has to stay covered', async () => {
    setDb({ webhook_gid: 'wh-1', webhook_secret: 'old-secret' })
    await openAsanaWebhookPending(SYNC_STATE_ID)
    expect(row()).toMatchObject({ webhook_gid: 'wh-1', webhook_secret: 'old-secret' })
  })
})

describe('claimAsanaWebhookSecret', () => {
  it('claims inside an open window, storing the secret and CLOSING the window', async () => {
    setDb({ webhook_pending_at: minutesAgo(0) })

    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'new-secret')).toBe(true)

    expect(row()).toMatchObject({ webhook_secret: 'new-secret', webhook_pending_at: null })
  })

  it('is SINGLE-USE: a second handshake against the same window is refused', async () => {
    // The stale-retry / racing-attacker case. Once Asana's challenge has been
    // answered the key is live, and a second claim must not clobber it.
    setDb({ webhook_pending_at: minutesAgo(0) })

    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'first')).toBe(true)
    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'attacker-chosen')).toBe(false)

    expect(row().webhook_secret).toBe('first')
  })

  it('refuses a STALE window — an abandoned attempt is not a standing invitation', async () => {
    setDb({ webhook_secret: 'live', webhook_pending_at: minutesAgo(3) })

    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'attacker-chosen')).toBe(false)
    expect(row().webhook_secret).toBe('live')
  })

  it('accepts a window right at the edge of the TTL', async () => {
    // Bounds check on the other side of the same predicate, so a sign error or
    // an off-by-a-thousand in the freshness bound can't pass both tests.
    setDb({ webhook_pending_at: new Date(Date.now() - ASANA_WEBHOOK_PENDING_TTL_MS + 5_000).toISOString() })
    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'new-secret')).toBe(true)
  })

  it('refuses when NO window is open at all', async () => {
    // The default state of every row: nothing is expecting a handshake, so this
    // endpoint is not an oracle for planting a verification key.
    setDb({ webhook_gid: 'wh-1', webhook_secret: 'live', webhook_pending_at: null })

    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'attacker-chosen')).toBe(false)
    expect(row().webhook_secret).toBe('live')
  })

  it('SWAPS a live secret when a window IS open — that is the re-registration', async () => {
    // Deliberate overwrite: during a re-point the old webhook keeps delivering
    // and verifying until this lands, so there is never a delivery with no key.
    setDb({
      webhook_gid: 'wh-OLD',
      webhook_secret: 'old-secret',
      webhook_pending_at: minutesAgo(0),
    })

    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'swapped-in')).toBe(true)

    expect(row()).toMatchObject({
      webhook_secret: 'swapped-in',
      webhook_pending_at: null,
      // The gid is untouched — asana-webhook re-points it after the create.
      webhook_gid: 'wh-OLD',
    })
  })

  it('carries the full gate in its WHERE clause, not in application code', async () => {
    setDb({ webhook_pending_at: minutesAgo(0) })
    await claimAsanaWebhookSecret(SYNC_STATE_ID, 'new-secret')

    const filters = writeFilters()
    expect(filters).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
      { op: 'eq', col: 'provider', val: 'asana' },
      { op: 'not', col: 'webhook_pending_at', val: null, notOp: 'is' },
      { op: 'gt', col: 'webhook_pending_at', val: expect.any(String) },
    ])
    // supabase-js can't express `now() - interval '2 minutes'`, so the bound is
    // computed here — it must actually be TTL-old, not "now" or the epoch.
    const bound = new Date(filters[3].val as string).getTime()
    expect(Date.now() - bound).toBeGreaterThanOrEqual(ASANA_WEBHOOK_PENDING_TTL_MS)
    expect(Date.now() - bound).toBeLessThan(ASANA_WEBHOOK_PENDING_TTL_MS + 5_000)
  })

  it('refuses an unknown sync state id', async () => {
    setDb({ webhook_pending_at: minutesAgo(0) })
    expect(await claimAsanaWebhookSecret('tss-UNKNOWN', 'x')).toBe(false)
  })

  it('reads a DB error as a REFUSAL (409), never as a silent success', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await claimAsanaWebhookSecret(SYNC_STATE_ID, 'x')).toBe(false)

    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
