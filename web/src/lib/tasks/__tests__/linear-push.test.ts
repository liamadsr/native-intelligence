import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Tests for src/lib/tasks/linear-push.ts — the shared push behind the panel
 * button, the AI tool and the MCP tool.
 *
 * Invariants locked in:
 *  - coded, NON-throwing gates: action_not_found / not_connected /
 *    not_configured / unauthorized. `not_configured` needs only the TEAM to be
 *    missing — a project is optional, unlike Jira's triple.
 *  - an already-linked action returns the existing link and NEVER creates a
 *    second Linear issue.
 *  - payload shape: a MARKDOWN description string (not ADF, not HTML), a
 *    TimelessDate dueDate, the derived not_started stateId, and the assignee ON
 *    THE CREATE (Linear takes assigneeId in the create input, so there is no
 *    post-create call that could fail separately).
 *  - a create rejected as INVALID INPUT earns exactly ONE retry with every
 *    optional field dropped; a rejection that is not an input error (a throttle,
 *    a 5xx) is NOT "recovered" that way, because the fields were not at fault.
 *  - external_id is the issue UUID (never the identifier, which Linear rewrites
 *    on a team move), external_scope is NULL, and external_state_label carries
 *    the real workflow state name.
 *  - a 23505 insert race returns the row that won, not an error, AND deletes the
 *    Linear issue this call orphaned by losing.
 */

const hoistedApi = vi.hoisted(() => ({
  createIssue: vi.fn(),
  deleteIssue: vi.fn(),
  findUserByEmail: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'LINEAR_UNAUTHORIZED'
  readonly status: number
  constructor(status = 401) {
    super('401')
    this.name = 'LinearUnauthorizedError'
    this.status = status
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly graphQLErrors: Array<{ message?: string; extensions?: Record<string, unknown> }>
  constructor(
    status: number,
    message = 'boom',
    graphQLErrors: Array<{ message?: string; extensions?: Record<string, unknown> }> = [],
  ) {
    super(message)
    this.name = 'LinearApiError'
    this.status = status
    this.graphQLErrors = graphQLErrors
  }
}
/**
 * An input rejection — the ONLY shape that earns the strip-optionals retry.
 *
 * Linear's REAL entity-not-found payload, which is what a project or state id
 * that went stale since the destination was saved actually produces. Note the
 * code is 'INPUT_ERROR', not 'INVALID_INPUT': Linear's codes vary across error
 * families, so `type`/`userError` are the stable part of the contract.
 */
function inputError(message = 'Entity not found: Project - Could not find referenced Project.') {
  return new FakeApiError(200, message, [
    { message, extensions: { type: 'invalid input', code: 'INPUT_ERROR', userError: true } },
  ])
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createIssue: hoistedApi.createIssue,
    deleteIssue: hoistedApi.deleteIssue,
    findUserByEmail: hoistedApi.findUserByEmail,
    LinearUnauthorizedError: FakeUnauthorized,
    LinearApiError: FakeApiError,
    // The REAL predicate, handed a REAL error rebuilt from the fake one, rather
    // than re-expressed here: a local re-expression self-confirms whatever the
    // fixtures fabricate, which is exactly how the entity-not-found rejection
    // class went unclassified. The rebuild exists only because the fake class is
    // deliberately instanceof-distinct.
    isLinearInputError: (err: unknown) => {
      if (!(err instanceof FakeApiError)) return false
      const RealApiError = actual.LinearApiError as new (
        status: number,
        message: string,
        graphQLErrors: unknown[],
      ) => Error
      return (actual.isLinearInputError as (e: unknown) => boolean)(
        new RealApiError(err.status, err.message, err.graphQLErrors),
      )
    },
  }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadLinearSyncState: vi.fn() }))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadLinearSyncState: hoistedConfig.loadLinearSyncState }
})

const hoistedAdmin = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ auth: { admin: { getUserById: hoistedAdmin.getUserById } } }),
}))

const { pushActionToLinear, buildMarkdownDescription, dueDateFor } = await import(
  '../linear-push'
)

// ---- Supabase fake -------------------------------------------------------

interface DbRows {
  action?: Record<string, unknown> | null
  /** Existing link row found by the "already linked?" pre-check. */
  existingLink?: Record<string, unknown> | null
  member?: Record<string, unknown> | null
  /** Result of the link INSERT chain (`.select().single()`). */
  insertResult?: {
    data?: Record<string, unknown> | null
    error?: { code?: string; message: string } | null
  }
  /** Row returned by the post-23505 re-read. */
  racedLink?: Record<string, unknown> | null
}

/**
 * Table-aware chainable fake. Reads terminate at `.maybeSingle()`; the link
 * insert terminates at `.select().single()`. `action_external_task` reads are
 * disambiguated by call order: the first is the pre-check, a later one (after an
 * insert) is the 23505 re-read.
 */
function makeDb(rows: DbRows) {
  const inserts: Array<Record<string, unknown>> = []
  let didInsert = false

  function builder(table: string) {
    let isInsert = false

    const api: Record<string, unknown> = {
      select: () => (isInsert ? Promise.resolve({}) : api),
      eq: () => api,
      order: () => api,
      limit: () => api,
      insert: (payload: Record<string, unknown>) => {
        isInsert = true
        didInsert = true
        inserts.push(payload)
        return {
          select: () => ({
            single: async () => ({
              data: rows.insertResult?.data ?? { id: 'link-1', ...payload },
              error: rows.insertResult?.error ?? null,
            }),
          }),
        }
      },
      maybeSingle: async () => {
        if (table === 'actions') return { data: rows.action ?? null, error: null }
        if (table === 'member') return { data: rows.member ?? null, error: null }
        if (table === 'action_external_task') {
          return {
            data: didInsert ? (rows.racedLink ?? null) : (rows.existingLink ?? null),
            error: null,
          }
        }
        return { data: null, error: null }
      },
    }
    return api
  }

  return {
    client: { from: (table: string) => builder(table) } as unknown as SupabaseClient,
    inserts,
  }
}

const ACTION = {
  id: 'act-1',
  identifier: 'ENG-42',
  title: 'Ship the thing',
  description: 'Do <the> work & ship it',
  due_at: '2026-07-30T17:00:00.000Z',
  assignee_id: null,
  workflow_state: { category: 'started' },
}

const SYNC_STATE = {
  id: 'tss-1',
  accountId: 'acct-1',
  userId: 'u-1',
  config: {
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
  },
}

const CREATED_ISSUE = {
  id: 'issue-uuid-1',
  identifier: 'ENG-7',
  title: 'Ship the thing',
  url: 'https://linear.app/acme/issue/ENG-7',
  state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
}

function args(supabase: SupabaseClient) {
  return { actionId: 'act-1', workspaceId: 'ws-1', userId: 'u-1', supabase }
}

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks: `clear` wipes call history but leaves
  // queued `mockResolvedValueOnce` values in place, so a test that failed before
  // consuming its queued value would leak it into the NEXT test.
  vi.resetAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://nativeintelligence.dev'
  hoistedApi.deleteIssue.mockResolvedValue(undefined)
  hoistedConfig.loadLinearSyncState.mockResolvedValue(SYNC_STATE)
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.createIssue.mockResolvedValue(CREATED_ISSUE)
  hoistedApi.findUserByEmail.mockResolvedValue(null)
  hoistedAdmin.getUserById.mockResolvedValue({ data: { user: { email: 'ada@example.com' } } })
})

// ---- Gates ---------------------------------------------------------------

describe('pushActionToLinear — coded gates', () => {
  it('returns action_not_found when the action is missing from the workspace', async () => {
    const db = makeDb({ action: null })
    expect(await pushActionToLinear(args(db.client))).toEqual({
      ok: false,
      code: 'action_not_found',
      error: 'Action not found',
    })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns not_connected when the workspace has no Linear sync state', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    const db = makeDb({ action: ACTION })
    expect(await pushActionToLinear(args(db.client))).toMatchObject({
      ok: false,
      code: 'not_connected',
    })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns not_configured when connected but no TEAM was picked', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { organization_id: 'org-uuid-1', organization_name: 'Acme' },
    })
    const db = makeDb({ action: ACTION })
    expect(await pushActionToLinear(args(db.client))).toMatchObject({
      ok: false,
      code: 'not_configured',
    })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  /**
   * The structural divergence from the Jira push, whose equivalent test asserts
   * the OPPOSITE (a project without an issue type is not configured). A Linear
   * issue belongs to a team; the project is a refinement, so a team-only config
   * pushes successfully.
   */
  it('PUSHES with a team and no project — the project is optional', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { team_id: 'team-uuid-1', team_key: 'ENG', team_name: 'Engineering' },
    })
    const db = makeDb({ action: ACTION })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('projectId')
  })

  it('PUSHES with a team and no state map — the team default is used', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { team_id: 'team-uuid-1' },
    })
    const db = makeDb({ action: ACTION })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('stateId')
  })

  it('returns unauthorized when no valid token can be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const db = makeDb({ action: ACTION })
    expect(await pushActionToLinear(args(db.client))).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns unauthorized (not a throw) when the create itself 401s', async () => {
    hoistedApi.createIssue.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb({ action: ACTION })
    expect(await pushActionToLinear(args(db.client))).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
  })

  it('returns unauthorized on a 403 too — one error, one fix', async () => {
    hoistedApi.createIssue.mockRejectedValue(new FakeUnauthorized(403))
    const db = makeDb({ action: ACTION })
    expect(await pushActionToLinear(args(db.client))).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
  })
})

// ---- Idempotency ---------------------------------------------------------

describe('pushActionToLinear — idempotency', () => {
  const existing = {
    id: 'link-existing',
    action_id: 'act-1',
    provider: 'linear',
    external_id: 'issue-uuid-0',
    external_url: 'https://linear.app/acme/issue/ENG-1',
    external_title: 'Ship the thing',
    external_state_label: 'Todo',
    completed: false,
  }

  it('returns the existing link WITHOUT creating a second issue', async () => {
    const db = makeDb({ action: ACTION, existingLink: existing })
    expect(await pushActionToLinear(args(db.client))).toEqual({
      ok: true,
      link: existing,
      created: false,
    })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
    // The destination isn't even resolved on this path.
    expect(hoistedConfig.loadLinearSyncState).not.toHaveBeenCalled()
  })

  it('treats a 23505 insert race as already-linked and returns the winning row', async () => {
    const raced = { ...existing, id: 'link-winner', external_id: 'issue-uuid-1' }
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: raced,
    })

    expect(await pushActionToLinear(args(db.client))).toEqual({
      ok: true,
      link: raced,
      created: false,
    })
    // The winner carries OUR issue id (a retry replaying a create that already
    // landed) — there is no orphan to clean up.
    expect(hoistedApi.deleteIssue).not.toHaveBeenCalled()
  })

  it('DELETES the Linear issue it just orphaned when it loses to a different id', async () => {
    // UNIQUE is (action_id, provider): a concurrent push that got there first
    // holds a DIFFERENT issue id, so our create is now unreferenced.
    const raced = { ...existing, id: 'link-winner', external_id: 'issue-uuid-999' }
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: raced,
    })

    expect(await pushActionToLinear(args(db.client))).toEqual({
      ok: true,
      link: raced,
      created: false,
    })
    expect(hoistedApi.deleteIssue).toHaveBeenCalledWith('tok', 'issue-uuid-1')
  })

  it('rethrows a 23505 whose winning row cannot be read back', async () => {
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: null,
    })
    await expect(pushActionToLinear(args(db.client))).rejects.toThrow('duplicate key')
  })

  it('rethrows a non-23505 insert failure', async () => {
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23503', message: 'fk violation' } },
    })
    await expect(pushActionToLinear(args(db.client))).rejects.toThrow('fk violation')
  })
})

// ---- Payload -------------------------------------------------------------

describe('pushActionToLinear — payload shape', () => {
  it('sends teamId from the destination config', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))

    const [token, input] = hoistedApi.createIssue.mock.calls[0]
    expect(token).toBe('tok')
    expect(input.teamId).toBe('team-uuid-1')
    expect(input.title).toBe('Ship the thing')
  })

  it('sends the projectId when the destination has one', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1].projectId).toBe('proj-uuid-1')
  })

  /**
   * The derived not_started state, passed EXPLICITLY. Omitting it would land the
   * issue in whatever the team defaults to (backlog or triage), which may not be
   * where the workspace's not-started actually lives.
   */
  it('sends the derived not_started stateId on the create', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1].stateId).toBe('s-todo')
  })

  it('OMITS stateId when the team has no not_started state', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, state_map: { done: { id: 's-done', name: 'Done' } } },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('stateId')
  })

  it('sends a TimelessDate dueDate', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1].dueDate).toBe('2026-07-30')
  })

  it('OMITS dueDate entirely when the action has no due date', async () => {
    const db = makeDb({ action: { ...ACTION, due_at: null } })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('dueDate')
  })

  it('sends the description as a MARKDOWN STRING, never a tree or HTML', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))

    const description = hoistedApi.createIssue.mock.calls[0][1].description
    expect(typeof description).toBe('string')
    expect(description).toContain('https://nativeintelligence.dev/account?action=act-1')
    // Not ADF, and not the escaped HTML the Asana sibling builds.
    expect(description).not.toContain('"type":"doc"')
    expect(description).not.toContain('&lt;')
  })

  it('falls back to the identifier when the action has no title', async () => {
    const db = makeDb({ action: { ...ACTION, title: '   ' } })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1].title).toBe('ENG-42')
  })

  /**
   * The flag lives in task_sync_state.config and has to reach the builder — the
   * one seam every push surface (panel menu, capture row, AI tool, MCP tool)
   * shares, which is why threading it here covers all four at once.
   */
  it('strips attribution from the description when the config opts out', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, include_dial8_attribution: false },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))

    // Byte-exact: what remains is the action's own description and nothing else.
    expect(hoistedApi.createIssue.mock.calls[0][1].description).toBe('Do <the> work & ship it')
  })

  it('OMITS description entirely when attribution is off and there is none', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, include_dial8_attribution: false },
    })
    const db = makeDb({ action: { ...ACTION, description: null } })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('description')
  })

  it('keeps attribution when the key is ABSENT — every existing connection', async () => {
    // SYNC_STATE carries no such key, exactly like every row written before this
    // setting existed. Nothing about their pushes may change.
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))

    expect(hoistedApi.createIssue.mock.calls[0][1].description).toBe(
      '**ENG-42**\n\nDo <the> work & ship it\n\n' +
        'Pushed from Native Intelligence: [ENG-42](https://nativeintelligence.dev/account?action=act-1)',
    )
  })
})

// ---- Assignee ------------------------------------------------------------

describe('pushActionToLinear — best-effort assignee ON THE CREATE', () => {
  const ASSIGNED = { ...ACTION, assignee_id: 'mem-1' }

  /**
   * The divergence from the Jira push, where the assignee is a separate
   * post-create PUT. Linear's create input takes assigneeId, so there is no
   * second call that can fail after the issue exists.
   */
  it('resolves the assignee BEFORE the create and sends it in the input', async () => {
    hoistedApi.findUserByEmail.mockResolvedValue({ id: 'lin-u-9', name: 'Ada' })
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(hoistedApi.findUserByEmail).toHaveBeenCalledWith('tok', 'ada@example.com')
    expect(hoistedApi.createIssue.mock.calls[0][1].assigneeId).toBe('lin-u-9')
  })

  it('creates UNASSIGNED when the email matches nobody in Linear', async () => {
    // The expected case, not an edge one: the member's Native Intelligence email need not be
    // their address in the customer's Linear org.
    hoistedApi.findUserByEmail.mockResolvedValue(null)
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('assigneeId')
  })

  it('SUCCEEDS even when the user lookup itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.findUserByEmail.mockRejectedValue(new FakeApiError(500, 'boom'))
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(hoistedApi.createIssue.mock.calls[0][1]).not.toHaveProperty('assigneeId')
    expect(warn).toHaveBeenCalled()
  })

  it('never looks up when the action has no assignee', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.findUserByEmail).not.toHaveBeenCalled()
  })

  it('never looks up when the member has no resolvable email', async () => {
    hoistedAdmin.getUserById.mockResolvedValue({ data: { user: null } })
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    await pushActionToLinear(args(db.client))
    expect(hoistedApi.findUserByEmail).not.toHaveBeenCalled()
  })
})

// ---- Input-rejection retry ------------------------------------------------

describe('pushActionToLinear — invalid-input retry', () => {
  it('retries ONCE with every optional field dropped', async () => {
    hoistedApi.createIssue.mockRejectedValueOnce(inputError()).mockResolvedValueOnce(CREATED_ISSUE)
    const db = makeDb({ action: ACTION })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(2)

    const retried = hoistedApi.createIssue.mock.calls[1][1]
    // Everything optional is gone…
    expect(retried).not.toHaveProperty('dueDate')
    expect(retried).not.toHaveProperty('projectId')
    expect(retried).not.toHaveProperty('stateId')
    expect(retried).not.toHaveProperty('assigneeId')
    // …and the two structural fields plus the description survive.
    expect(retried.teamId).toBe('team-uuid-1')
    expect(retried.title).toBe('Ship the thing')
    expect(retried.description).toContain('ENG-42')
  })

  /**
   * The distinction the dual-mode rate limiting makes load-bearing: a throttle
   * arrives as an HTTP 400, and stripping fields cannot fix it. Retrying would
   * burn the recovery attempt on a request that was never malformed.
   */
  it('does NOT strip-retry an error that is not an input rejection', async () => {
    hoistedApi.createIssue.mockRejectedValue(
      new FakeApiError(400, 'Rate limit exceeded', [{ extensions: { code: 'RATELIMITED' } }]),
    )
    const db = makeDb({ action: ACTION })

    await expect(pushActionToLinear(args(db.client))).rejects.toThrow('Rate limit exceeded')
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  it('does NOT strip-retry a 5xx', async () => {
    hoistedApi.createIssue.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    const db = makeDb({ action: ACTION })
    await expect(pushActionToLinear(args(db.client))).rejects.toThrow('unavailable')
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  /**
   * Nothing optional was sent, so there is nothing to drop — the rejection is
   * about teamId or title, and it is reported as a CODED failure rather than
   * thrown into the route's catch-all, where it would become an uncoded 500.
   */
  it('reports push_failed when there is nothing optional left to strip', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { team_id: 'team-uuid-1' },
    })
    hoistedApi.createIssue.mockRejectedValue(inputError('Team not found'))
    const db = makeDb({ action: { ...ACTION, due_at: null } })

    const result = await pushActionToLinear(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect((result as { error: string }).error).toContain('Team not found')
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  it('reports push_failed when the RETRY is still rejected as invalid input', async () => {
    hoistedApi.createIssue.mockRejectedValue(inputError('Title too long'))
    const db = makeDb({ action: ACTION })

    const result = await pushActionToLinear(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(2)
  })

  it('rethrows when the RETRY fails for a non-input reason', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(inputError())
      .mockRejectedValueOnce(new FakeApiError(503, 'unavailable'))
    const db = makeDb({ action: ACTION })
    await expect(pushActionToLinear(args(db.client))).rejects.toThrow('unavailable')
  })

  it('returns unauthorized when the RETRY 401s', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(inputError())
      .mockRejectedValueOnce(new FakeUnauthorized())
    const db = makeDb({ action: ACTION })
    expect(await pushActionToLinear(args(db.client))).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
  })
})

// ---- Link row ------------------------------------------------------------

describe('pushActionToLinear — link row', () => {
  it('stores the issue UUID, a null scope, the url and the state name', async () => {
    const db = makeDb({ action: ACTION })
    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)

    const insert = db.inserts[0]
    expect(insert).toMatchObject({
      workspace_id: 'ws-1',
      action_id: 'act-1',
      provider: 'linear',
      // The UUID — permanent and globally unique.
      external_id: 'issue-uuid-1',
      // NULL for linear: a UUID needs no container, unlike a per-site Jira id.
      external_scope: null,
      external_url: 'https://linear.app/acme/issue/ENG-7',
      external_title: 'Ship the thing',
      external_state_label: 'Todo',
      completed: false,
      created_by: 'u-1',
    })
    expect(insert.last_synced_at).toBeTruthy()
  })

  /**
   * The identifier is DISPLAY-ONLY: Linear rewrites it when an issue moves to
   * another team, so storing it as the identity would silently break every read
   * after a team move.
   */
  it('NEVER stores the identifier as the external id', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(db.inserts[0].external_id).not.toBe('ENG-7')
  })

  it('needs NO status read-back — the create response carries the state', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    // Only the create; the Jira sibling's follow-up getIssue has no equivalent.
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
    expect(db.inserts[0].external_state_label).toBe('Todo')
  })

  it('folds a completed-type landing state to completed:true', async () => {
    // Rare but real: a team whose not_started mapping points at a done state,
    // or an automation that closes the issue instantly.
    hoistedApi.createIssue.mockResolvedValue({
      ...CREATED_ISSUE,
      state: { id: 's-done', name: 'Done', type: 'completed' },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))

    expect(db.inserts[0]).toMatchObject({ completed: true, external_state_label: 'Done' })
  })

  it('folds a duplicate-type landing state to completed:true as well', async () => {
    hoistedApi.createIssue.mockResolvedValue({
      ...CREATED_ISSUE,
      state: { id: 's-dupe', name: 'Duplicate', type: 'duplicate' },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(db.inserts[0].completed).toBe(true)
  })

  it('reads an UNKNOWN state type conservatively as not completed', async () => {
    // A brand-new Linear state type must never mark a just-created issue done.
    hoistedApi.createIssue.mockResolvedValue({
      ...CREATED_ISSUE,
      state: { id: 's-x', name: 'Shipped', type: 'shipped' },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToLinear(args(db.client))
    expect(db.inserts[0]).toMatchObject({ completed: false, external_state_label: 'Shipped' })
  })

  it('stores a null url and label when the create response omits them', async () => {
    hoistedApi.createIssue.mockResolvedValue({ id: 'issue-uuid-1' })
    const db = makeDb({ action: ACTION })

    expect((await pushActionToLinear(args(db.client))).ok).toBe(true)
    expect(db.inserts[0]).toMatchObject({
      external_url: null,
      external_state_label: null,
      completed: false,
    })
  })
})

// ---- Pure helpers --------------------------------------------------------

describe('dueDateFor', () => {
  it('returns undefined with no due date', () => {
    expect(dueDateFor(null)).toBeUndefined()
    expect(dueDateFor(undefined)).toBeUndefined()
  })

  it('slices the date off an ISO string rather than round-tripping through Date', () => {
    // A round-trip would shift this to the previous day in a negative-offset TZ.
    expect(dueDateFor('2026-07-30T00:00:00.000Z')).toBe('2026-07-30')
    expect(dueDateFor('2026-07-30T17:00:00.000Z')).toBe('2026-07-30')
  })

  it('parses a non-ISO-prefixed value it can still understand', () => {
    expect(dueDateFor('July 30, 2026 12:00:00 UTC')).toBe('2026-07-30')
  })

  it('returns undefined for an unparseable value', () => {
    expect(dueDateFor('soon')).toBeUndefined()
  })
})

describe('buildMarkdownDescription', () => {
  it('always carries the deep link, even with no identifier or description', () => {
    expect(
      buildMarkdownDescription({ actionId: 'act-9', identifier: null, description: null }),
    ).toBe('Pushed from Native Intelligence: [this action](https://nativeintelligence.dev/account?action=act-9)')
  })

  it('emits the identifier bold, the body, and the backlink, blank-line separated', () => {
    expect(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: 'Do the work',
      }),
    ).toBe(
      '**ENG-1**\n\nDo the work\n\n' +
        'Pushed from Native Intelligence: [ENG-1](https://nativeintelligence.dev/account?action=act-9)',
    )
  })

  /**
   * Nothing to escape, and deliberately so: Linear descriptions ARE markdown, so
   * markdown a user wrote in Native Intelligence rendering as markdown in Linear is the
   * desirable outcome — not the injection hazard the Asana HTML builder defends
   * against.
   */
  it('passes the body through verbatim — markdown is the intended format', () => {
    const doc = buildMarkdownDescription({
      actionId: 'act-9',
      identifier: null,
      description: '# Heading\n\n<script>alert(1)</script>',
    })
    expect(doc).toContain('# Heading')
    expect(doc).toContain('<script>alert(1)</script>')
  })

  it('treats an explicit true identically to absent', () => {
    expect(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: 'Do the work',
        attribution: true,
      }),
    ).toBe(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: 'Do the work',
      }),
    )
  })

  it('drops BOTH the identifier line and the backlink when off', () => {
    // What remains is the true-case output minus exactly the two attribution
    // blocks — the description, byte-identical.
    expect(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: 'Do the work',
        attribution: false,
      }),
    ).toBe('Do the work')
  })

  it('returns null when attribution is off and there is no description', () => {
    expect(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: null,
        attribution: false,
      }),
    ).toBeNull()
  })

  it('returns null when attribution is off and the description is whitespace', () => {
    expect(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: '   ',
        attribution: false,
      }),
    ).toBeNull()
  })

  it('omits the bold line when there is no identifier, keeping the backlink', () => {
    expect(
      buildMarkdownDescription({
        actionId: 'act-9',
        identifier: '   ',
        description: 'Body',
      }),
    ).toBe('Body\n\nPushed from Native Intelligence: [this action](https://nativeintelligence.dev/account?action=act-9)')
  })
})
