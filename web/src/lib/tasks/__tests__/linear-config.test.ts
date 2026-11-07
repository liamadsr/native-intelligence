import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'

/**
 * Tests for src/lib/tasks/linear-config.ts — the linear half of
 * `task_sync_state`.
 *
 * Every consumer of this file mocks it, which is exactly why it needs tests of
 * its own: what matters here is not the return values (trivially mockable) but
 * the QUERY PREDICATES, and a mocked module proves nothing about them. Two are
 * load-bearing:
 *
 *  - Every read/write is scoped `.eq('provider', 'linear')`. Three providers now
 *    share one table AND one UNIQUE(account_id), so an unscoped read in a
 *    workspace with more than one connected would hand a Linear push someone
 *    else's destination — a silent cross-provider corruption, not an error.
 *  - The reader never SELECTs a webhook column. For linear every one of them is
 *    permanently NULL (its webhooks are app-level, so there is no registration
 *    and no per-row secret), but the column boundary is asserted anyway so a
 *    later refactor can't widen this query and leak the Asana secret of a
 *    co-resident row through a shared reader.
 *
 * Runs the REAL query chains against the filter-aware fake in
 * src/test/asana-remote-fake.ts — provider-agnostic Supabase plumbing despite
 * the name, since it applies eq/not/gt against actual rows.
 */

let dbFake: AsanaRemoteFake = createAsanaRemoteFake()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake.client }))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedApi = vi.hoisted(() => ({ revokeToken: vi.fn() }))
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, revokeToken: hoistedApi.revokeToken }
})

const {
  LINEAR_PROVIDER,
  includesLinearAttribution,
  isLinearDestinationConfigured,
  listLinearSyncStates,
  loadLinearReconcileState,
  loadLinearSyncState,
  parseLinearConfig,
  revokeLinearTokenForAccount,
  saveLinearConfig,
  stampLinearReconciledAt,
  stateForBucket,
} = await import('@/lib/tasks/linear-config')

// ---- Helpers ---------------------------------------------------------------

const SYNC_STATE_ID = 'tss-linear-1'

const CONFIG = {
  organization_id: 'org-uuid-1',
  organization_name: 'Acme',
  team_id: 'team-uuid-1',
  team_key: 'ENG',
  team_name: 'Engineering',
  project_id: 'proj-uuid-1',
  project_name: 'Q3 Launch',
  state_map: {
    not_started: { id: 's-todo', name: 'Todo' },
    in_progress: { id: 's-doing', name: 'In Progress' },
    done: { id: 's-done', name: 'Done' },
    canceled: { id: 's-cancelled', name: 'Canceled' },
  },
}

function setDb(row: Record<string, unknown> = {}, extra: Array<Record<string, unknown>> = []) {
  dbFake = createAsanaRemoteFake({
    syncStates: [
      {
        id: SYNC_STATE_ID,
        workspace_id: 'ws-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        provider: LINEAR_PROVIDER,
        config: CONFIG,
        created_at: '2026-07-01T00:00:00.000Z',
        ...row,
      } as never,
      ...(extra as never[]),
    ],
  })
  return dbFake
}

beforeEach(() => {
  vi.clearAllMocks()
  setDb()
})

// ---- parseLinearConfig -----------------------------------------------------

describe('parseLinearConfig', () => {
  it('reads the full destination plus the derived state map', () => {
    expect(parseLinearConfig(CONFIG)).toEqual(CONFIG)
  })

  it('degrades a junk row to "not configured" rather than throwing', () => {
    expect(parseLinearConfig(null)).toEqual({})
    expect(parseLinearConfig(undefined)).toEqual({})
    expect(parseLinearConfig({ team_id: 42, team_name: '' })).toEqual({})
    expect(parseLinearConfig({ state_map: ['nope'] })).toEqual({})
    expect(parseLinearConfig({ state_map: 'done' })).toEqual({})
  })

  it('drops unknown keys instead of round-tripping them', () => {
    // The config is an untrusted jsonb blob; only the fields this build knows
    // about survive a read-modify-write through the settings PATCH.
    expect(parseLinearConfig({ team_id: 't-1', sneaky: 'value' })).toEqual({ team_id: 't-1' })
  })

  /**
   * The structural difference from parseJiraConfig's status_map, whose buckets
   * are normalized to null. Here ABSENT is meaningful — it says "this team has
   * no state of that type" and drives the echo's decline — so a half-written
   * entry is DROPPED rather than kept as a broken pair.
   */
  it('keeps only complete {id,name} entries and OMITS the rest', () => {
    expect(
      parseLinearConfig({
        state_map: {
          done: { id: 's-done', name: 'Done' },
          canceled: { id: 's-cancelled' }, // no name → dropped
          in_progress: { name: 'Doing' }, // no id → dropped
          not_started: { id: '', name: 'Blank' }, // empty id → dropped
        },
      }),
    ).toEqual({ state_map: { done: { id: 's-done', name: 'Done' } } })
  })

  it('records an EMPTY state_map — "derived, and this team expresses nothing"', () => {
    // Distinct from an absent state_map ("never derived"), which is what a
    // freshly-connected row carries.
    expect(parseLinearConfig({ state_map: {} })).toEqual({ state_map: {} })
    expect(parseLinearConfig({})).not.toHaveProperty('state_map')
  })

  it('ignores an unknown bucket inside state_map', () => {
    expect(
      parseLinearConfig({
        state_map: { done: { id: 's-done', name: 'Done' }, blocked: { id: 'x', name: 'X' } },
      }),
    ).toEqual({ state_map: { done: { id: 's-done', name: 'Done' } } })
  })

  it('ignores a non-object state_map entry', () => {
    expect(parseLinearConfig({ state_map: { done: 's-done', canceled: null } })).toEqual({
      state_map: {},
    })
  })

  it('carries include_dial8_attribution through only as a real boolean', () => {
    expect(parseLinearConfig({ include_dial8_attribution: false })).toEqual({
      include_dial8_attribution: false,
    })
    expect(parseLinearConfig({ include_dial8_attribution: true })).toEqual({
      include_dial8_attribution: true,
    })
    // A hand-edited string is left ABSENT rather than coerced — "false" is
    // truthy, and coercing it would silently flip an opt-out into an opt-in.
    expect(parseLinearConfig({ include_dial8_attribution: 'false' })).toEqual({})
    expect(parseLinearConfig({ include_dial8_attribution: 0 })).toEqual({})
  })
})

describe('includesLinearAttribution', () => {
  it('defaults to ON when the key is absent — every pre-existing connection', () => {
    expect(includesLinearAttribution({})).toBe(true)
    expect(includesLinearAttribution({ team_id: 't-1' })).toBe(true)
  })

  it('is off ONLY for an explicit false', () => {
    expect(includesLinearAttribution({ include_dial8_attribution: false })).toBe(false)
    expect(includesLinearAttribution({ include_dial8_attribution: true })).toBe(true)
  })
})

describe('stateForBucket', () => {
  it('reads the {id,name} pair through', () => {
    expect(stateForBucket(CONFIG, 'done')).toEqual({ id: 's-done', name: 'Done' })
  })

  it('returns null for an absent bucket or an absent map', () => {
    expect(stateForBucket({ state_map: {} }, 'canceled')).toBeNull()
    expect(stateForBucket({}, 'done')).toBeNull()
  })

  it('treats a blank id as unmapped', () => {
    expect(stateForBucket({ state_map: { done: { id: '', name: 'Done' } } }, 'done')).toBeNull()
  })
})

describe('isLinearDestinationConfigured', () => {
  /**
   * ONE id, deliberately narrower than the Jira gate's site+project+issue-type
   * triple. `issueCreate` needs a team and nothing else, so a team-only config
   * is a complete, pushable destination rather than a half-configured one.
   */
  it('requires ONLY team_id', () => {
    expect(isLinearDestinationConfigured(CONFIG)).toBe(true)
    expect(isLinearDestinationConfigured({ team_id: 'team-uuid-1' })).toBe(true)
  })

  it('accepts a team with NO project — a Linear issue may live under the team', () => {
    const { project_id: _p, project_name: _n, ...noProject } = CONFIG
    expect(isLinearDestinationConfigured(noProject)).toBe(true)
  })

  it('accepts a team with NO state map — the push uses the team default', () => {
    const { state_map: _m, ...noMap } = CONFIG
    expect(isLinearDestinationConfigured(noMap)).toBe(true)
  })

  it('rejects an empty config', () => {
    expect(isLinearDestinationConfigured({})).toBe(false)
  })

  it('rejects an org picked with no team', () => {
    expect(isLinearDestinationConfigured({ organization_id: 'org-1' })).toBe(false)
  })

  it('does NOT treat a lingering team_name/key as a destination', () => {
    expect(isLinearDestinationConfigured({ team_name: 'Engineering', team_key: 'ENG' })).toBe(
      false,
    )
  })

  it('does NOT treat a project alone as a destination', () => {
    expect(isLinearDestinationConfigured({ project_id: 'proj-1' })).toBe(false)
  })
})

// ---- loadLinearSyncState ---------------------------------------------------

describe('loadLinearSyncState', () => {
  it('scopes to the workspace AND the linear provider', async () => {
    await loadLinearSyncState('ws-1')

    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'workspace_id', val: 'ws-1' },
      { op: 'eq', col: 'provider', val: 'linear' },
    ])
  })

  it('IGNORES co-resident asana and jira rows in the same workspace', async () => {
    // The most dangerous cross-provider bug available in this table: all three
    // live in it, and an unscoped read would hand a Linear push another
    // provider's destination with no error anywhere.
    setDb({ id: 'tss-asana', provider: 'asana', config: { project_gid: 'proj-1' } }, [
      {
        id: 'tss-jira',
        workspace_id: 'ws-1',
        account_id: 'acct-3',
        user_id: 'u-1',
        provider: 'jira',
        config: { cloud_id: 'cafe0001', project_id: '10000' },
        created_at: '2026-07-01T12:00:00.000Z',
      },
      {
        id: SYNC_STATE_ID,
        workspace_id: 'ws-1',
        account_id: 'acct-2',
        user_id: 'u-1',
        provider: LINEAR_PROVIDER,
        config: CONFIG,
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ])

    const state = await loadLinearSyncState('ws-1')
    expect(state?.id).toBe(SYNC_STATE_ID)
    expect(state?.config.team_id).toBe('team-uuid-1')
  })

  it('NEVER selects a webhook column', async () => {
    const state = await loadLinearSyncState('ws-1')

    expect(dbFake.syncStateQueries[0].columns).toEqual(['id', 'account_id', 'user_id', 'config'])
    expect(JSON.stringify(state)).not.toContain('webhook')
    expect(state).toEqual({
      id: SYNC_STATE_ID,
      accountId: 'acct-1',
      userId: 'u-1',
      config: CONFIG,
    })
  })

  it('picks the OLDEST row when a workspace has two connected Linear accounts', async () => {
    // Stable destination: it must not flip based on who connected most recently.
    setDb({ created_at: '2026-07-01T00:00:00.000Z' }, [
      {
        id: 'tss-newer',
        workspace_id: 'ws-1',
        account_id: 'acct-2',
        user_id: 'u-2',
        provider: LINEAR_PROVIDER,
        config: {},
        created_at: '2026-07-09T00:00:00.000Z',
      },
    ])

    expect((await loadLinearSyncState('ws-1'))?.id).toBe(SYNC_STATE_ID)
  })

  it('returns null for a workspace with no Linear row', async () => {
    expect(await loadLinearSyncState('ws-OTHER')).toBeNull()
  })

  it('parses the stored config defensively on the way out', async () => {
    setDb({ config: { team_id: 42, state_map: { done: { id: 's-done', name: 'Done' } } } })
    const state = await loadLinearSyncState('ws-1')
    expect(state?.config).toEqual({ state_map: { done: { id: 's-done', name: 'Done' } } })
  })
})

// ---- saveLinearConfig ------------------------------------------------------

describe('saveLinearConfig', () => {
  it('writes the config wholesale and stamps updated_at', async () => {
    const next = { ...CONFIG, team_id: 'team-uuid-2' }
    const result = await saveLinearConfig(SYNC_STATE_ID, next)

    expect(result).toEqual({ error: null })
    const write = dbFake.syncStateUpdates[0]
    expect(write.patch.config).toEqual(next)
    expect(write.patch.updated_at).toBeTruthy()
    expect(write.matchedIds).toEqual([SYNC_STATE_ID])
  })

  it('targets the row by id', async () => {
    await saveLinearConfig(SYNC_STATE_ID, {})
    expect(dbFake.syncStateUpdates[0].filters).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
    ])
  })

  it('NEVER writes a webhook column — linear has no registration to store', async () => {
    // Linear's webhooks are app-level: configured once in the OAuth app console
    // and auto-provisioned per authorizing organization. Writing any of these
    // would imply a per-account lifecycle this provider does not have.
    await saveLinearConfig(SYNC_STATE_ID, CONFIG)
    const patch = dbFake.syncStateUpdates[0].patch
    expect(patch).not.toHaveProperty('webhook_gid')
    expect(patch).not.toHaveProperty('webhook_secret')
    expect(patch).not.toHaveProperty('webhook_registered_at')
    expect(patch).not.toHaveProperty('webhook_pending_at')
  })

  it('surfaces a DB error rather than reporting success', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'permission denied' } })
    expect(await saveLinearConfig(SYNC_STATE_ID, {})).toEqual({ error: 'permission denied' })
  })
})

// ---- loadLinearReconcileState / listLinearSyncStates / stamp ---------------

describe('loadLinearReconcileState', () => {
  it('carries exactly what the sweep needs — and no organization id', async () => {
    // The Jira sibling's cloudId has a real consumer (it addresses every API
    // call and gates the destination); the Linear equivalent would have none.
    // The org check belongs to the webhook read-back, where a DELIVERY names an
    // organization that did not come from us — the sweep reads one row's own
    // links with that row's own token, so the same check would compare the row
    // against itself. Carrying the field anyway invited exactly that: a comment
    // and a test asserting a defence this build never implemented.
    setDb({ last_reconcile_at: '2026-07-25T00:00:00.000Z' })
    expect(await loadLinearReconcileState(SYNC_STATE_ID)).toEqual({
      id: SYNC_STATE_ID,
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-1',
      lastReconcileAt: '2026-07-25T00:00:00.000Z',
    })
  })

  it('NEVER selects a webhook column', async () => {
    await loadLinearReconcileState(SYNC_STATE_ID)
    expect(dbFake.syncStateQueries[0].columns).toEqual([
      'id',
      'workspace_id',
      'account_id',
      'user_id',
      'config',
      'last_reconcile_at',
    ])
  })

  it('scopes to the linear provider and returns null for a jira row', async () => {
    setDb({ provider: 'jira' })
    expect(await loadLinearReconcileState(SYNC_STATE_ID)).toBeNull()
  })

})

describe('listLinearSyncStates', () => {
  it('lists the fleet, scoped to linear', async () => {
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

    expect(await listLinearSyncStates()).toEqual([{ id: SYNC_STATE_ID, workspaceId: 'ws-1' }])
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'provider', val: 'linear' },
    ])
  })

  it('THROWS on a DB error rather than reporting an empty fleet', async () => {
    // The cron treats the return value as "everyone connected"; swallowing an
    // error here would silently stop every workspace's read-back.
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    await expect(listLinearSyncStates()).rejects.toThrow('db down')
  })
})

describe('stampLinearReconciledAt', () => {
  it('stamps the clock the 6-hour gate reads', async () => {
    await stampLinearReconciledAt(SYNC_STATE_ID)
    const write = dbFake.syncStateUpdates[0]
    expect(write.patch.last_reconcile_at).toBeTruthy()
    expect(write.filters).toEqual([{ op: 'eq', col: 'id', val: SYNC_STATE_ID }])
  })

  it('surfaces a DB error', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    expect(await stampLinearReconciledAt(SYNC_STATE_ID)).toEqual({ error: 'db down' })
  })
})

// ---- revokeLinearTokenForAccount -------------------------------------------

/**
 * The whole disconnect-side teardown for this provider. There is no webhook to
 * delete — Linear's are app-level and end with the AUTHORIZATION — so revoking
 * the token is both the teardown and the thing that stops a still-valid 24h
 * access token outliving the disconnect.
 */
describe('revokeLinearTokenForAccount', () => {
  it('revokes the account’s live token', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue({
      token: 'tok',
      email: null,
      accountId: 'acct-1',
    })
    await revokeLinearTokenForAccount('acct-1')
    expect(hoistedApi.revokeToken).toHaveBeenCalledWith('tok')
  })

  it('no-ops when no token can be minted — nothing left to revoke', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    await revokeLinearTokenForAccount('acct-1')
    expect(hoistedApi.revokeToken).not.toHaveBeenCalled()
  })

  it('NEVER throws — a disconnect must complete whatever Linear says', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedToken.getValidTokenForAccount.mockRejectedValue(new Error('token store down'))
    await expect(revokeLinearTokenForAccount('acct-1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

// ---- Schema contract -------------------------------------------------------

/**
 * The config shapes above are only storable because migration 217 lets a linear
 * row into these tables at all. Assert it statically — a missing CHECK widening
 * is a hard 500 on every connect and every push, and it is exactly the kind of
 * thing that passes review because the TypeScript is perfect.
 */
describe('migration 217 — the constraints this file depends on', () => {
  async function migration(): Promise<string> {
    const fs = await import('node:fs')
    const path = await import('node:path')
    return fs.readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/217_linear_tasks_integration.sql'),
      'utf8',
    )
  }

  it("widens task_sync_state's provider CHECK to accept 'linear'", async () => {
    const sql = await migration()
    expect(sql).toMatch(
      /task_sync_state[\s\S]*?CHECK \(provider IN \('asana', 'jira', 'linear'\)\)/,
    )
  })

  it("widens action_external_task's provider CHECK to accept 'linear'", async () => {
    const sql = await migration()
    expect(sql).toMatch(
      /action_external_task[\s\S]*?CHECK \(provider IN \('asana', 'jira', 'linear'\)\)/,
    )
  })

  it("widens both OAuth tables' provider CHECKs, keeping each one's own syntax", async () => {
    const sql = await migration()
    // user_oauth_tokens uses `= ANY (ARRAY[…])`, connected_account uses `IN (…)`.
    expect(sql).toContain(
      "CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github', 'hubspot', 'asana', 'jira', 'linear']))",
    )
    expect(sql).toContain(
      "CHECK (provider IN ('google', 'microsoft', 'github', 'hubspot', 'asana', 'jira', 'linear'))",
    )
  })

  it('preserves every EXISTING provider in all four widenings', async () => {
    const sql = await migration()
    // A re-ADD that forgot a value would not fail here — it would fail in
    // production, on someone else's provider, the next time they connected.
    for (const previous of ['asana', 'jira']) {
      expect(sql.match(new RegExp(`'${previous}'`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(4)
    }
  })

  it('creates NO tables and adds NO columns — 212 and 216 already suffice', async () => {
    const sql = await migration()
    expect(sql).not.toContain('CREATE TABLE')
    expect(sql).not.toContain('ADD COLUMN')
  })
})
