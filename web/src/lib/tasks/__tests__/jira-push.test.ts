import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Tests for src/lib/tasks/jira-push.ts — the shared push behind the panel
 * button, the AI tool and the MCP tool.
 *
 * Invariants locked in:
 *  - coded, NON-throwing gates: action_not_found / not_connected /
 *    not_configured / unauthorized.
 *  - an already-linked action returns the existing link and NEVER creates a
 *    second Jira issue.
 *  - payload shape: ADF description (not HTML, not a plain string), a single
 *    date-only `duedate`, and NO assignee on the create call at all.
 *  - a create rejected over the OPTIONAL fields we send (duedate, description)
 *    earns exactly ONE retry without them; a rejection naming anything else
 *    surfaces. The duedate case is one instance of that rule, driven
 *    by the FIELD KEY in Jira's error envelope rather than a message string.
 *  - the assignee is post-create and best-effort: an ambiguous or empty user
 *    search leaves the issue unassigned and the push succeeds regardless.
 *  - external_id is the issue ID (never the key), external_url is the /browse/
 *    permalink, and external_state_label carries the real Jira status name.
 *  - a 23505 insert race returns the row that won, not an error, AND deletes the
 *    Jira issue this call orphaned by losing.
 */

const hoistedApi = vi.hoisted(() => ({
  createIssue: vi.fn(),
  deleteIssue: vi.fn(),
  getIssue: vi.fn(),
  searchUsers: vi.fn(),
  assignIssue: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'JIRA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'JiraUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string>
  constructor(status: number, message = 'boom', fieldErrors: Record<string, string> = {}) {
    super(message)
    this.name = 'JiraApiError'
    this.status = status
    this.fieldErrors = fieldErrors
  }
}
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createIssue: hoistedApi.createIssue,
    deleteIssue: hoistedApi.deleteIssue,
    getIssue: hoistedApi.getIssue,
    searchUsers: hoistedApi.searchUsers,
    assignIssue: hoistedApi.assignIssue,
    JiraUnauthorizedError: FakeUnauthorized,
    JiraApiError: FakeApiError,
  }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadJiraSyncState: vi.fn() }))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadJiraSyncState: hoistedConfig.loadJiraSyncState }
})

const hoistedAdmin = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ auth: { admin: { getUserById: hoistedAdmin.getUserById } } }),
}))

const { pushActionToJira, buildAdfDescription, dueDateFor, issueBrowseUrl } =
  await import('../jira-push')

// ---- Supabase fake -------------------------------------------------------

interface DbRows {
  action?: Record<string, unknown> | null
  /** Existing link row found by the "already linked?" pre-check. */
  existingLink?: Record<string, unknown> | null
  member?: Record<string, unknown> | null
  /** Result of the link INSERT chain (`.select().single()`). */
  insertResult?: { data?: Record<string, unknown> | null; error?: { code?: string; message: string } | null }
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
      select: () =>
        isInsert
          ? Promise.resolve({}) // unreachable: insert terminates at .single()
          : api,
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
    cloud_id: 'cafe0001',
    site_name: 'Acme',
    site_url: 'https://acme.atlassian.net',
    project_id: '10000',
    project_key: 'ENG',
    project_name: 'Engineering',
    issue_type_id: '10001',
    issue_type_name: 'Task',
  },
}

function args(supabase: SupabaseClient) {
  return { actionId: 'act-1', workspaceId: 'ws-1', userId: 'u-1', supabase }
}

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks: `clear` wipes call history but leaves
  // queued `mockResolvedValueOnce` / `mockRejectedValueOnce` values in place, so
  // a test that failed before consuming its queued value leaked it into the NEXT
  // test — three tests failing where one broke, with an inexplicable `ok: true`
  // in the diff. Every mock this file uses is re-seeded immediately below, which
  // is what makes the stronger reset safe.
  vi.resetAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://nativeintelligence.dev'
  hoistedApi.deleteIssue.mockResolvedValue(undefined)
  hoistedConfig.loadJiraSyncState.mockResolvedValue(SYNC_STATE)
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.createIssue.mockResolvedValue({ id: '99001', key: 'ENG-7' })
  hoistedApi.getIssue.mockResolvedValue({
    id: '99001',
    fields: { status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } } },
  })
  hoistedApi.searchUsers.mockResolvedValue([])
  hoistedApi.assignIssue.mockResolvedValue(undefined)
  hoistedAdmin.getUserById.mockResolvedValue({ data: { user: { email: 'ada@example.com' } } })
})

// ---- Gates ---------------------------------------------------------------

describe('pushActionToJira — coded gates', () => {
  it('returns action_not_found when the action is missing from the workspace', async () => {
    const db = makeDb({ action: null })
    const result = await pushActionToJira(args(db.client))
    expect(result).toEqual({
      ok: false,
      code: 'action_not_found',
      error: 'Action not found',
    })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns not_connected when the workspace has no Jira sync state', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)
    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'not_connected' })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns not_configured when connected but no project was picked', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { cloud_id: 'cafe0001', site_name: 'Acme' },
    })
    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'not_configured' })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns not_configured when the project is picked but the ISSUE TYPE is not', async () => {
    // The state you land in the instant an admin switches project — the settings
    // PATCH clears the issue type on purpose, and a create is unbuildable
    // without one.
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, issue_type_id: undefined },
    })
    const db = makeDb({ action: ACTION })
    expect(await pushActionToJira(args(db.client))).toMatchObject({
      ok: false,
      code: 'not_configured',
    })
  })

  it('returns unauthorized when no valid token can be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('returns unauthorized (not a throw) when the create itself 401s', async () => {
    hoistedApi.createIssue.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' })
  })
})

// ---- Idempotency ---------------------------------------------------------

describe('pushActionToJira — idempotency', () => {
  const existing = {
    id: 'link-existing',
    action_id: 'act-1',
    provider: 'jira',
    external_id: '99000',
    external_url: 'https://acme.atlassian.net/browse/ENG-1',
    external_title: 'Ship the thing',
    external_state_label: 'To Do',
    completed: false,
  }

  it('returns the existing link WITHOUT creating a second issue', async () => {
    const db = makeDb({ action: ACTION, existingLink: existing })
    const result = await pushActionToJira(args(db.client))

    expect(result).toEqual({ ok: true, link: existing, created: false })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
    // The destination isn't even resolved on this path.
    expect(hoistedConfig.loadJiraSyncState).not.toHaveBeenCalled()
  })

  it('treats a 23505 insert race as already-linked and returns the winning row', async () => {
    const raced = { ...existing, id: 'link-winner', external_id: '99001' }
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: raced,
    })

    const result = await pushActionToJira(args(db.client))
    expect(result).toEqual({ ok: true, link: raced, created: false })
    // The winner carries OUR issue id (an Inngest/AI retry replaying a create
    // that already landed) — there is no orphan to clean up.
    expect(hoistedApi.deleteIssue).not.toHaveBeenCalled()
  })

  it('DELETES the Jira issue it just orphaned when it loses to a different id', async () => {
    // UNIQUE is (action_id, provider): a concurrent push that got there first
    // holds a DIFFERENT issue id, so our create is now unreferenced.
    const raced = { ...existing, id: 'link-winner', external_id: '99777' }
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: raced,
    })

    const result = await pushActionToJira(args(db.client))

    expect(result).toEqual({ ok: true, link: raced, created: false })
    expect(hoistedApi.deleteIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001')
  })

  it('rethrows a 23505 whose winning row cannot be read back', async () => {
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: null,
    })
    await expect(pushActionToJira(args(db.client))).rejects.toThrow('duplicate key')
  })

  it('rethrows a non-23505 insert failure', async () => {
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23503', message: 'fk violation' } },
    })
    await expect(pushActionToJira(args(db.client))).rejects.toThrow('fk violation')
  })
})

// ---- Payload -------------------------------------------------------------

describe('pushActionToJira — payload shape', () => {
  it('sends project + issuetype BY ID from the destination config', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))

    const [token, cloudId, payload] = hoistedApi.createIssue.mock.calls[0]
    expect(token).toBe('tok')
    expect(cloudId).toBe('cafe0001')
    expect(payload.fields.project).toEqual({ id: '10000' })
    expect(payload.fields.issuetype).toEqual({ id: '10001' })
    expect(payload.fields.summary).toBe('Ship the thing')
  })

  it('sends a single date-only duedate', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][2].fields.duedate).toBe('2026-07-30')
  })

  it('OMITS duedate entirely when the action has no due date', async () => {
    const db = makeDb({ action: { ...ACTION, due_at: null } })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][2].fields).not.toHaveProperty('duedate')
  })

  it('sends the description as ADF, never as a string', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))

    const description = hoistedApi.createIssue.mock.calls[0][2].fields.description
    expect(typeof description).toBe('object')
    expect(description).toMatchObject({ version: 1, type: 'doc' })
    expect(JSON.stringify(description)).toContain('https://nativeintelligence.dev/account?action=act-1')
  })

  it('sends NO assignee field on the create — assignment is post-create only', async () => {
    // Jira needs an accountId, resolving one over 3LO is unreliable, and an
    // assignee failure must never cost us the issue.
    const db = makeDb({ action: { ...ACTION, assignee_id: 'mem-1' }, member: { user_id: 'u-9' } })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][2].fields).not.toHaveProperty('assignee')
  })

  it('falls back to the identifier when the action has no title', async () => {
    const db = makeDb({ action: { ...ACTION, title: '   ' } })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.createIssue.mock.calls[0][2].fields.summary).toBe('ENG-42')
  })

  /**
   * The flag lives in task_sync_state.config and has to reach the builder — the
   * one seam every push surface (panel menu, capture row, AI tool, MCP tool)
   * shares, which is why threading it here covers all four at once.
   */
  it('strips attribution from the ADF description when the config opts out', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, include_dial8_attribution: false },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))

    const description = hoistedApi.createIssue.mock.calls[0][2].fields.description
    expect(description).toEqual({
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Do <the> work & ship it' }] },
      ],
    })
    expect(JSON.stringify(description)).not.toContain('Pushed from Native Intelligence')
    expect(JSON.stringify(description)).not.toMatch(/nativeintelligence\.dev|dial8\.ai/)
  })

  it('OMITS description entirely when attribution is off and there is none', async () => {
    // The builder returns null, and the caller already spreads conditionally —
    // Jira is inconsistent with an empty-but-valid doc, so send nothing.
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, include_dial8_attribution: false },
    })
    const db = makeDb({ action: { ...ACTION, description: null } })
    await pushActionToJira(args(db.client))

    expect(hoistedApi.createIssue.mock.calls[0][2].fields).not.toHaveProperty('description')
  })

  it('keeps attribution when the key is ABSENT — every existing connection', async () => {
    // SYNC_STATE carries no such key, exactly like every row written before this
    // setting existed. Nothing about their pushes may change.
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))

    const description = hoistedApi.createIssue.mock.calls[0][2].fields.description
    expect(description).toEqual({
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'ENG-42', marks: [{ type: 'strong' }] }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Do <the> work & ship it' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Pushed from Native Intelligence: ' },
            {
              type: 'text',
              text: 'ENG-42',
              marks: [
                { type: 'link', attrs: { href: 'https://nativeintelligence.dev/account?action=act-1' } },
              ],
            },
          ],
        },
      ],
    })
  })
})

// ---- create-screen retry --------------------------------------------------

describe('pushActionToJira — duedate screen rejection', () => {
  const rejection = () =>
    new FakeApiError(400, "Jira request failed (400): duedate: Field 'duedate' cannot be set.", {
      duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown.",
    })

  it('retries ONCE without duedate when the field key names it', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(rejection())
      .mockResolvedValueOnce({ id: '99001', key: 'ENG-7' })

    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))

    expect(result.ok).toBe(true)
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(2)
    expect(hoistedApi.createIssue.mock.calls[0][2].fields.duedate).toBe('2026-07-30')
    expect(hoistedApi.createIssue.mock.calls[1][2].fields).not.toHaveProperty('duedate')
    // Everything else survives the retry.
    expect(hoistedApi.createIssue.mock.calls[1][2].fields.project).toEqual({ id: '10000' })
    expect(hoistedApi.createIssue.mock.calls[1][2].fields.summary).toBe('Ship the thing')
  })

  it('does NOT retry a 400 that has nothing to do with duedate', async () => {
    hoistedApi.createIssue.mockRejectedValue(
      new FakeApiError(400, 'summary: is required', { summary: 'is required' }),
    )
    const db = makeDb({ action: ACTION })

    const result = await pushActionToJira(args(db.client))

    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  /**
   * REGRESSION (review finding: "only duedate rejections are recovered; any
   * other create-screen field 400 surfaces as a raw 500"). `duedate` was never
   * special — it was just the field this was first seen on. Jira rejects ANY
   * field that isn't on the issue type's create screen with the same
   * `errors: { <key>: "…not on the appropriate screen…" }` shape, and locking
   * `description` off the screen is an ordinary admin choice. The rule is
   * therefore "every key Jira named is a field we sent AND one we can live
   * without" — never a subset, and never project/issuetype/summary.
   */
  it('retries without DESCRIPTION when the screen rejects that instead', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(
        new FakeApiError(400, "description: Field 'description' cannot be set.", {
          description: "Field 'description' cannot be set. It is not on the appropriate screen.",
        }),
      )
      .mockResolvedValueOnce({ id: '99001', key: 'ENG-7' })

    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))

    expect(result.ok).toBe(true)
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(2)
    expect(hoistedApi.createIssue.mock.calls[1][2].fields).not.toHaveProperty('description')
    // …and the due date, which was never the problem, is still sent.
    expect(hoistedApi.createIssue.mock.calls[1][2].fields.duedate).toBe('2026-07-30')
  })

  it('strips SEVERAL optional fields at once when the screen rejects both', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(
        new FakeApiError(400, 'two fields', {
          duedate: "Field 'duedate' cannot be set.",
          description: "Field 'description' cannot be set.",
        }),
      )
      .mockResolvedValueOnce({ id: '99001', key: 'ENG-7' })

    const db = makeDb({ action: ACTION })
    expect((await pushActionToJira(args(db.client))).ok).toBe(true)
    const retried = hoistedApi.createIssue.mock.calls[1][2].fields
    expect(retried).not.toHaveProperty('duedate')
    expect(retried).not.toHaveProperty('description')
    expect(retried.summary).toBe('Ship the thing')
  })

  /**
   * REGRESSION (round-1 audit, api-edges issue 0). "Surfaced" used to mean
   * "rethrown": the route's catch-all turned it into an uncoded 500 whose body
   * was the raw `Jira request failed (400) https://api.atlassian.com/ex/jira/…`
   * string, so the user got a toast containing an internal gateway URL, no
   * indication of WHICH field was missing, and no affordance — while
   * task-destinations kept reporting the destination as configured.
   *
   * It is a destination problem, so it is a CODED push failure like every other
   * one, and the field keys (the stable half of Jira's error envelope, and the
   * only actionable part) travel in the message.
   */
  it('reports a required custom field we never sent as a coded push_failed', async () => {
    // The single most common reason a well-formed create is rejected in a real
    // instance. There is nothing to strip — we never sent it.
    hoistedApi.createIssue.mockRejectedValue(
      new FakeApiError(400, 'customfield_10014: Epic Link is required.', {
        customfield_10014: 'Epic Link is required.',
      }),
    )
    const db = makeDb({ action: ACTION })

    const result = await pushActionToJira(args(db.client))

    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    // The field key is what the user has to act on, so it has to be in there.
    expect((result as { error: string }).error).toContain('customfield_10014')
    // …and the internal gateway URL is not.
    expect((result as { error: string }).error).not.toContain('api.atlassian.com')
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  it('refuses to strip when the rejection ALSO names a field we cannot drop', async () => {
    // A mixed error map is not a screen problem; retrying without the droppable
    // half would just fail again while hiding the real cause.
    hoistedApi.createIssue.mockRejectedValue(
      new FakeApiError(400, 'mixed', {
        duedate: "Field 'duedate' cannot be set.",
        issuetype: 'valid issue type is required',
      }),
    )
    const db = makeDb({ action: ACTION })

    const result = await pushActionToJira(args(db.client))

    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect((result as { error: string }).error).toContain('issuetype')
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  it('still THROWS a 4xx that names no field at all — nothing to report', async () => {
    // Without a field map there is no user-actionable content, so the honest
    // answer is the generic failure path (and Inngest/route retries), not a
    // coded failure implying we know what to fix.
    hoistedApi.createIssue.mockRejectedValue(new FakeApiError(403, 'no create permission'))
    const db = makeDb({ action: ACTION })
    await expect(pushActionToJira(args(db.client))).rejects.toThrow('no create permission')
  })

  it('still THROWS a 5xx rather than blaming the destination', async () => {
    hoistedApi.createIssue.mockRejectedValue(
      new FakeApiError(503, 'unavailable', { customfield_1: 'x' }),
    )
    const db = makeDb({ action: ACTION })
    await expect(pushActionToJira(args(db.client))).rejects.toThrow('unavailable')
  })

  it('does NOT retry when there was no duedate to blame', async () => {
    // Jira named `duedate` but we never sent one, so there is nothing to strip
    // — and nothing to retry. Reported, not thrown.
    hoistedApi.createIssue.mockRejectedValue(rejection())
    const db = makeDb({ action: { ...ACTION, due_at: null } })

    const result = await pushActionToJira(args(db.client))

    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 5xx (transient, not the field)', async () => {
    hoistedApi.createIssue.mockRejectedValue(new FakeApiError(500, 'server error'))
    const db = makeDb({ action: ACTION })
    await expect(pushActionToJira(args(db.client))).rejects.toThrow('server error')
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  it('returns unauthorized when the RETRY 401s', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(rejection())
      .mockRejectedValueOnce(new FakeUnauthorized())
    const db = makeDb({ action: ACTION })
    expect(await pushActionToJira(args(db.client))).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
  })
})

// ---- Assignee ------------------------------------------------------------

describe('pushActionToJira — best-effort assignee', () => {
  const ASSIGNED = { ...ACTION, assignee_id: 'mem-1' }

  it('assigns on an UNAMBIGUOUS single match', async () => {
    hoistedApi.searchUsers.mockResolvedValue([{ accountId: 'acc-1', displayName: 'Ada' }])
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    const result = await pushActionToJira(args(db.client))

    expect(result.ok).toBe(true)
    expect(hoistedApi.searchUsers).toHaveBeenCalledWith('tok', 'cafe0001', 'ada@example.com')
    expect(hoistedApi.assignIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', 'acc-1')
  })

  it('leaves the issue unassigned on the documented EMPTY-over-3LO result', async () => {
    hoistedApi.searchUsers.mockResolvedValue([])
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    const result = await pushActionToJira(args(db.client))
    expect(result.ok).toBe(true)
    expect(hoistedApi.assignIssue).not.toHaveBeenCalled()
  })

  it('refuses to GUESS when the search is ambiguous', async () => {
    // Assigning someone else's colleague to their work is worse than leaving it
    // unassigned.
    hoistedApi.searchUsers.mockResolvedValue([{ accountId: 'acc-1' }, { accountId: 'acc-2' }])
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    await pushActionToJira(args(db.client))
    expect(hoistedApi.assignIssue).not.toHaveBeenCalled()
  })

  it('ignores a match with no accountId', async () => {
    hoistedApi.searchUsers.mockResolvedValue([{ displayName: 'Ada' }])
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.assignIssue).not.toHaveBeenCalled()
  })

  it('SUCCEEDS even when the assign call itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.searchUsers.mockResolvedValue([{ accountId: 'acc-1' }])
    hoistedApi.assignIssue.mockRejectedValue(new FakeApiError(403, 'no permission'))
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    const result = await pushActionToJira(args(db.client))
    expect(result.ok).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it('SUCCEEDS even when the user search itself throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.searchUsers.mockRejectedValue(new FakeApiError(403, 'browse users denied'))
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    expect((await pushActionToJira(args(db.client))).ok).toBe(true)
  })

  it('never searches when the action has no assignee', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.searchUsers).not.toHaveBeenCalled()
  })

  it('never searches when the member has no resolvable email', async () => {
    hoistedAdmin.getUserById.mockResolvedValue({ data: { user: null } })
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.searchUsers).not.toHaveBeenCalled()
  })
})

// ---- Link row ------------------------------------------------------------

describe('pushActionToJira — link row', () => {
  it('stores the issue ID (not the key), the browse permalink and the status name', async () => {
    const db = makeDb({ action: ACTION })
    const result = await pushActionToJira(args(db.client))

    expect(result.ok).toBe(true)
    const insert = db.inserts[0]
    expect(insert).toMatchObject({
      workspace_id: 'ws-1',
      action_id: 'act-1',
      provider: 'jira',
      // The ID survives a key rename / project move; the key does not.
      external_id: '99001',
      // The SITE the id belongs to: Jira ids are per-site sequences that every
      // site starts at 10000, so the id alone identifies nothing.
      external_scope: 'cafe0001',
      external_url: 'https://acme.atlassian.net/browse/ENG-7',
      external_title: 'Ship the thing',
      external_state_label: 'To Do',
      completed: false,
      created_by: 'u-1',
    })
    expect(insert.last_synced_at).toBeTruthy()
  })

  /**
   * REGRESSION (review finding: "site_url falls back to the API gateway,
   * storing an unusable /browse permalink on every link"). `external_url` is
   * copied onto the row, so a wrong permalink outlives the config that produced
   * it — fixing the site later cannot repair links already created. Null is the
   * honest value, and the UI already renders link rows without one.
   */
  it('stores NO permalink when the site reported no browsable url', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, site_url: undefined },
    })
    const db = makeDb({ action: ACTION })

    expect((await pushActionToJira(args(db.client))).ok).toBe(true)
    expect(db.inserts[0].external_url).toBeNull()
    // …and the link is still fully usable for syncing.
    expect(db.inserts[0]).toMatchObject({ external_id: '99001', external_scope: 'cafe0001' })
  })

  it('reads the landing status back with fields=status', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))
    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', 'status')
  })

  it('folds a done-category landing status to completed:true', async () => {
    // Rare but real: a project whose initial status is in the done category.
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))

    expect(db.inserts[0]).toMatchObject({ completed: true, external_state_label: 'Done' })
  })

  it('still links (with a null label) when the status read-back fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.getIssue.mockRejectedValue(new FakeApiError(500, 'boom'))
    const db = makeDb({ action: ACTION })

    const result = await pushActionToJira(args(db.client))
    expect(result.ok).toBe(true)
    expect(db.inserts[0]).toMatchObject({ external_state_label: null, completed: false })
    expect(warn).toHaveBeenCalled()
  })

  it('stores a null url when the site_url is missing from the config', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, site_url: undefined },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToJira(args(db.client))
    expect(db.inserts[0].external_url).toBeNull()
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

describe('issueBrowseUrl', () => {
  it('builds the /browse/ permalink from the site url and the KEY', () => {
    expect(issueBrowseUrl('https://acme.atlassian.net', 'ENG-42')).toBe(
      'https://acme.atlassian.net/browse/ENG-42',
    )
  })

  it('tolerates a trailing slash on the site url', () => {
    expect(issueBrowseUrl('https://acme.atlassian.net/', 'ENG-42')).toBe(
      'https://acme.atlassian.net/browse/ENG-42',
    )
  })

  it('returns null rather than a broken URL when either half is missing', () => {
    expect(issueBrowseUrl(null, 'ENG-42')).toBeNull()
    expect(issueBrowseUrl('https://acme.atlassian.net', null)).toBeNull()
    expect(issueBrowseUrl('', '')).toBeNull()
  })
})

describe('buildAdfDescription', () => {
  it('always carries the deep link, even with no identifier or description', () => {
    const doc = buildAdfDescription({ actionId: 'act-9', identifier: null, description: null })
    expect(doc).toEqual({
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Pushed from Native Intelligence: ' },
            {
              type: 'text',
              text: 'this action',
              marks: [
                { type: 'link', attrs: { href: 'https://nativeintelligence.dev/account?action=act-9' } },
              ],
            },
          ],
        },
      ],
    })
  })

  it('puts the identifier in a bold paragraph and the description in its own', () => {
    const doc = buildAdfDescription({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
    })!
    expect(doc.content).toHaveLength(3)
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'ENG-1', marks: [{ type: 'strong' }] }],
    })
    expect(doc.content[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Do the work' }],
    })
  })

  it('carries markup as LITERAL TEXT — ADF has no parser to inject into', () => {
    const doc = buildAdfDescription({
      actionId: 'act-9',
      identifier: null,
      description: '<script>alert(1)</script>',
    })!
    // Unlike Asana's html_notes there is nothing to escape: a text node is text.
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '<script>alert(1)</script>' }],
    })
  })

  it('NEVER emits an empty paragraph or an empty text node (ADF rejects both)', () => {
    const doc = buildAdfDescription({
      actionId: 'act-9',
      identifier: '   ',
      description: '   ',
    })!
    for (const node of doc.content) {
      expect(node.content?.length ?? 0).toBeGreaterThan(0)
      for (const child of node.content ?? []) {
        expect(child.text?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  it('puts `version` on the doc node ONLY', () => {
    const doc = buildAdfDescription({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'body',
    })!
    expect(doc.version).toBe(1)
    for (const node of doc.content) {
      expect(node).not.toHaveProperty('version')
      for (const child of node.content ?? []) expect(child).not.toHaveProperty('version')
    }
  })

  it('attaches the link as a MARK on the text node, not as its own node type', () => {
    const doc = buildAdfDescription({ actionId: 'act-9', identifier: 'ENG-1', description: null })!
    const provenance = doc.content[doc.content.length - 1]
    const linked = provenance.content!.find((n) => n.marks)
    expect(linked?.type).toBe('text')
    expect(linked?.marks?.[0].type).toBe('link')
  })

  // ---- attribution opt-out -------------------------------------------------

  /**
   * `include_dial8_attribution: false` strips the bold identifier paragraph AND
   * the provenance paragraph as one unit, leaving the action's own description
   * untouched. The absent/true cases pin TODAY's exact tree, so an existing
   * connection (whose config has no such key) is provably unchanged.
   */
  it('treats an explicit true identically to absent', () => {
    const withFlag = buildAdfDescription({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
      attribution: true,
    })
    const withoutFlag = buildAdfDescription({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
    })
    expect(withFlag).toEqual(withoutFlag)
  })

  it('drops BOTH the identifier paragraph and the provenance one when off', () => {
    const doc = buildAdfDescription({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
      attribution: false,
    })
    // What remains is the true-case tree minus exactly the two attribution
    // paragraphs — the description paragraph, byte-identical.
    expect(doc).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Do the work' }] }],
    })
  })

  it('returns null when attribution is off and there is no description', () => {
    // An empty `content` array is not a valid doc; "nothing to say" is expressed
    // by sending no description at all.
    expect(
      buildAdfDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: null,
        attribution: false,
      }),
    ).toBeNull()
  })

  it('returns null when attribution is off and the description is whitespace', () => {
    expect(
      buildAdfDescription({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: '   ',
        attribution: false,
      }),
    ).toBeNull()
  })

  it('never emits an empty paragraph or text node with attribution off either', () => {
    const doc = buildAdfDescription({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
      attribution: false,
    })!
    for (const node of doc.content) {
      expect(node.content?.length ?? 0).toBeGreaterThan(0)
      for (const child of node.content ?? []) {
        expect(child.text?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})

// ---- Schema contract -----------------------------------------------------

/**
 * The lost-race handling above is only correct because the database refuses the
 * second link row, and only reachable because migration 216 lets a jira row into
 * the table at all. Assert both statically — a missing CHECK widening is a hard
 * 500 on every push, and an external_id-bearing UNIQUE would let two concurrent
 * pushes both land and silently double-link the action.
 */
describe('migration 216 — the constraints this file depends on', () => {
  async function migration(): Promise<string> {
    const fs = await import('node:fs')
    const path = await import('node:path')
    return fs.readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/216_jira_tasks_integration.sql'),
      'utf8',
    )
  }

  it("widens action_external_task's provider CHECK to accept 'jira'", async () => {
    const sql = await migration()
    expect(sql).toMatch(
      /action_external_task[\s\S]*?CHECK \(provider IN \('asana', 'jira'\)\)/,
    )
  })

  it("widens task_sync_state's provider CHECK to accept 'jira'", async () => {
    const sql = await migration()
    expect(sql).toMatch(/task_sync_state[\s\S]*?CHECK \(provider IN \('asana', 'jira'\)\)/)
  })

  it("widens both OAuth tables' provider CHECKs, keeping each one's own syntax", async () => {
    const sql = await migration()
    // user_oauth_tokens uses `= ANY (ARRAY[…])`, connected_account uses `IN (…)`.
    expect(sql).toContain(
      "CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github', 'hubspot', 'asana', 'jira']))",
    )
    expect(sql).toContain(
      "CHECK (provider IN ('google', 'microsoft', 'github', 'hubspot', 'asana', 'jira'))",
    )
  })

  it('creates NO tables — the 212 schema is already provider-generic', async () => {
    const sql = await migration()
    expect(sql).not.toContain('CREATE TABLE')
  })

  it('leaves UNIQUE (action_id, provider) from 212 intact — NOT keyed on external_id', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/212_asana_tasks_integration.sql'),
      'utf8',
    )
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.action_external_task'))
    const unique = /UNIQUE\s*\(([^)]*)\)/.exec(table)
    expect(unique![1].split(',').map((c) => c.trim())).toEqual(['action_id', 'provider'])
  })
})
