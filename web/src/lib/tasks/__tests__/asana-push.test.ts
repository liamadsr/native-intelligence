import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Tests for src/lib/tasks/asana-push.ts — the shared push behind the panel
 * button, the AI tool and the MCP tool.
 *
 * Invariants locked in:
 *  - coded, NON-throwing gates: action_not_found / not_connected /
 *    not_configured / unauthorized.
 *  - an already-linked action returns the existing link and NEVER creates a
 *    second Asana task.
 *  - payload shape: html_notes wrapped in <body> with the deep link;
 *    due_on XOR due_at (never both) driven by all_day; memberships when the
 *    current bucket has a section mapped, plain projects when it doesn't.
 *  - an assignee-caused 4xx earns exactly ONE retry without the assignee.
 *  - a 23505 insert race returns the row that won, not an error, AND deletes
 *    the Asana task this call orphaned by losing (UNIQUE is (action_id,
 *    provider), so the winner's gid differs from ours).
 */

const hoistedApi = vi.hoisted(() => ({ createTask: vi.fn(), deleteTask: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly code = 'ASANA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'AsanaApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/asana-api', () => ({
  createTask: hoistedApi.createTask,
  deleteTask: hoistedApi.deleteTask,
  AsanaUnauthorizedError: FakeUnauthorized,
  AsanaApiError: FakeApiError,
}))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadAsanaSyncState: vi.fn() }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaSyncState: hoistedConfig.loadAsanaSyncState }
})

const hoistedAdmin = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ auth: { admin: { getUserById: hoistedAdmin.getUserById } } }),
}))

const { pushActionToAsana, buildHtmlNotes, dueFieldsFor } = await import('../asana-push')

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
  all_day: false,
  assignee_id: null,
  workflow_state: { category: 'started' },
}

const SYNC_STATE = {
  id: 'tss-1',
  accountId: 'acct-1',
  userId: 'u-1',
  config: {
    asana_workspace_gid: 'aw-1',
    asana_workspace_name: 'Acme',
    project_gid: 'proj-1',
    project_name: 'Engineering',
  },
}

function args(supabase: SupabaseClient) {
  return { actionId: 'act-1', workspaceId: 'ws-1', userId: 'u-1', supabase }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://dial8.ai'
  hoistedConfig.loadAsanaSyncState.mockResolvedValue(SYNC_STATE)
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.createTask.mockResolvedValue({
    gid: 'task-1',
    name: 'Ship the thing',
    completed: false,
    permalink_url: 'https://app.asana.com/0/1/task-1',
  })
  hoistedAdmin.getUserById.mockResolvedValue({ data: { user: { email: 'ada@example.com' } } })
})

// ---- Gates ---------------------------------------------------------------

describe('pushActionToAsana — coded gates', () => {
  it('returns action_not_found when the action is missing from the workspace', async () => {
    const db = makeDb({ action: null })
    const result = await pushActionToAsana(args(db.client))
    expect(result).toEqual({
      ok: false,
      code: 'action_not_found',
      error: 'Action not found',
    })
    expect(hoistedApi.createTask).not.toHaveBeenCalled()
  })

  it('returns not_connected when the workspace has no Asana sync state', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue(null)
    const db = makeDb({ action: ACTION })
    const result = await pushActionToAsana(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'not_connected' })
    expect(hoistedApi.createTask).not.toHaveBeenCalled()
  })

  it('returns not_configured when connected but no project was picked', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { asana_workspace_gid: 'aw-1' },
    })
    const db = makeDb({ action: ACTION })
    const result = await pushActionToAsana(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'not_configured' })
    expect(hoistedApi.createTask).not.toHaveBeenCalled()
  })

  it('returns unauthorized when no valid token can be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const db = makeDb({ action: ACTION })
    const result = await pushActionToAsana(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(hoistedApi.createTask).not.toHaveBeenCalled()
  })

  it('returns unauthorized (not a throw) when the create itself 401s', async () => {
    hoistedApi.createTask.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb({ action: ACTION })
    const result = await pushActionToAsana(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' })
  })
})

// ---- Idempotency ---------------------------------------------------------

describe('pushActionToAsana — idempotency', () => {
  it('returns the existing link WITHOUT creating a second task', async () => {
    const existing = {
      id: 'link-existing',
      action_id: 'act-1',
      provider: 'asana',
      external_id: 'task-old',
      external_url: 'https://app.asana.com/0/1/task-old',
      external_title: 'Ship the thing',
      completed: false,
    }
    const db = makeDb({ action: ACTION, existingLink: existing })
    const result = await pushActionToAsana(args(db.client))

    expect(result).toEqual({ ok: true, link: existing, created: false })
    expect(hoistedApi.createTask).not.toHaveBeenCalled()
    // The destination isn't even resolved on this path.
    expect(hoistedConfig.loadAsanaSyncState).not.toHaveBeenCalled()
  })

  it('treats a 23505 insert race as already-linked and returns the winning row', async () => {
    const raced = {
      id: 'link-winner',
      action_id: 'act-1',
      provider: 'asana',
      external_id: 'task-1',
      external_url: 'https://app.asana.com/0/1/task-1',
      external_title: 'Ship the thing',
      completed: false,
    }
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: raced,
    })

    const result = await pushActionToAsana(args(db.client))
    expect(result).toEqual({ ok: true, link: raced, created: false })
    // The winner carries OUR gid (an Inngest/AI retry replaying a create that
    // already landed) — there is no orphan to clean up.
    expect(hoistedApi.deleteTask).not.toHaveBeenCalled()
  })

  it('DELETES the Asana task it just orphaned when it loses the race to a different gid', async () => {
    // UNIQUE is (action_id, provider): a concurrent push that got there first
    // holds a DIFFERENT gid, so our create is now unreferenced. Leaving it
    // behind puts a duplicate task in the user's project forever.
    const raced = {
      id: 'link-winner',
      action_id: 'act-1',
      provider: 'asana',
      external_id: 'task-winner',
      external_url: 'https://app.asana.com/0/1/task-winner',
      external_title: 'Ship the thing',
      completed: false,
    }
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: raced,
    })

    const result = await pushActionToAsana(args(db.client))

    expect(result).toEqual({ ok: true, link: raced, created: false })
    expect(hoistedApi.deleteTask).toHaveBeenCalledWith('tok', 'task-1')
  })

  it('rethrows a 23505 whose winning row cannot be read back', async () => {
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      racedLink: null,
    })
    await expect(pushActionToAsana(args(db.client))).rejects.toThrow('duplicate key')
  })

  it('rethrows a non-23505 insert failure', async () => {
    const db = makeDb({
      action: ACTION,
      insertResult: { error: { code: '23503', message: 'fk violation' } },
    })
    await expect(pushActionToAsana(args(db.client))).rejects.toThrow('fk violation')
  })
})

// ---- Payload -------------------------------------------------------------

describe('pushActionToAsana — payload shape', () => {
  it('uses plain `projects` when the current bucket has no section mapped', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.projects).toEqual(['proj-1'])
    expect(payload.memberships).toBeUndefined()
  })

  it('uses `memberships` with the section mapped to the action\'s CURRENT bucket', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: {
        ...SYNC_STATE.config,
        // The action is category 'started' → bucket in_progress.
        section_map: { not_started: 's-todo', in_progress: 's-doing', done: null, canceled: null },
      },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.memberships).toEqual([{ project: 'proj-1', section: 's-doing' }])
    expect(payload.projects).toBeUndefined()
  })

  it('sends due_at (not due_on) for a timed action', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.due_at).toBe('2026-07-30T17:00:00.000Z')
    expect(payload.due_on).toBeUndefined()
  })

  it('sends due_on (not due_at) for an all-day action', async () => {
    const db = makeDb({ action: { ...ACTION, all_day: true } })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.due_on).toBe('2026-07-30')
    expect(payload.due_at).toBeUndefined()
  })

  it('sends NEITHER due field when the action has no due date', async () => {
    const db = makeDb({ action: { ...ACTION, due_at: null } })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.due_on).toBeUndefined()
    expect(payload.due_at).toBeUndefined()
  })

  it('wraps html_notes in <body> and embeds the escaped deep link', async () => {
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.html_notes.startsWith('<body>')).toBe(true)
    expect(payload.html_notes.endsWith('</body>')).toBe(true)
    expect(payload.html_notes).toContain('https://dial8.ai/account?action=act-1')
    expect(payload.html_notes).toContain('ENG-42')
    // The description's angle brackets/ampersand are escaped, not injected.
    expect(payload.html_notes).toContain('Do &lt;the&gt; work &amp; ship it')
    // notes and html_notes are mutually exclusive — only one goes out.
    expect(payload.notes).toBeUndefined()
  })

  it('falls back to the identifier when the action has no title', async () => {
    const db = makeDb({ action: { ...ACTION, title: '   ' } })
    await pushActionToAsana(args(db.client))
    expect(hoistedApi.createTask.mock.calls[0][1].name).toBe('ENG-42')
  })

  /**
   * The flag lives in task_sync_state.config and has to reach the builder — the
   * one seam every push surface (panel menu, capture row, AI tool, MCP tool)
   * shares, which is why threading it here covers all four at once.
   */
  it('strips attribution from html_notes when the config opts out', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, include_dial8_attribution: false },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.html_notes).toBe('<body>Do &lt;the&gt; work &amp; ship it</body>')
    expect(payload.html_notes).not.toContain('Pushed from Dial8')
    expect(payload.html_notes).not.toContain('dial8.ai')
    expect(payload.html_notes).not.toContain('ENG-42')
  })

  it('keeps attribution when the config says so explicitly', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      ...SYNC_STATE,
      config: { ...SYNC_STATE.config, include_dial8_attribution: true },
    })
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    expect(hoistedApi.createTask.mock.calls[0][1].html_notes).toContain('Pushed from Dial8')
  })

  it('keeps attribution when the key is ABSENT — every existing connection', async () => {
    // SYNC_STATE carries no such key, exactly like every row written before this
    // setting existed. Nothing about their pushes may change.
    const db = makeDb({ action: ACTION })
    await pushActionToAsana(args(db.client))

    const payload = hoistedApi.createTask.mock.calls[0][1]
    expect(payload.html_notes).toBe(
      '<body><strong>ENG-42</strong>\n\nDo &lt;the&gt; work &amp; ship it\n\n' +
        'Pushed from Dial8: <a href="https://dial8.ai/account?action=act-1">ENG-42</a></body>',
    )
  })
})

// ---- Assignee ------------------------------------------------------------

describe('pushActionToAsana — assignee', () => {
  const ASSIGNED = { ...ACTION, assignee_id: 'mem-1' }

  it('passes the assignee\'s email through (Asana resolves emails)', async () => {
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    await pushActionToAsana(args(db.client))
    expect(hoistedApi.createTask.mock.calls[0][1].assignee).toBe('ada@example.com')
  })

  it('retries ONCE without the assignee when a 4xx names it', async () => {
    hoistedApi.createTask
      .mockRejectedValueOnce(new FakeApiError(400, 'assignee: Not a member of this workspace'))
      .mockResolvedValueOnce({ gid: 'task-1', name: 'Ship the thing', completed: false })

    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    const result = await pushActionToAsana(args(db.client))

    expect(result.ok).toBe(true)
    expect(hoistedApi.createTask).toHaveBeenCalledTimes(2)
    expect(hoistedApi.createTask.mock.calls[0][1].assignee).toBe('ada@example.com')
    expect(hoistedApi.createTask.mock.calls[1][1].assignee).toBeUndefined()
    // Everything else survives the retry.
    expect(hoistedApi.createTask.mock.calls[1][1].projects).toEqual(['proj-1'])
  })

  /**
   * CHANGED by the review finding "Asana section/project mismatch does not 400
   * cleanly". The no-retry half is unchanged and still asserted; what changed is
   * the OUTCOME: a 4xx is Asana refusing the input, which is the user's to fix,
   * so it is now a coded push_failed the route renders as a 400 rather than a
   * throw the route's catch-all turned into a 500 carrying Asana's raw message.
   * The Jira and Linear pushes already reported this class this way.
   */
  it('does NOT retry a 4xx when there was no assignee to blame', async () => {
    hoistedApi.createTask.mockRejectedValue(new FakeApiError(400, 'name: is required'))
    const db = makeDb({ action: ACTION })
    const result = await pushActionToAsana(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect((result as { error: string }).error).toContain('name: is required')
    expect(hoistedApi.createTask).toHaveBeenCalledTimes(1)
  })

  /**
   * REGRESSION (same finding). A section that was deleted or belongs to another
   * project is the compose panel's most likely stale pick, and it has nothing to
   * do with the assignee — so the assignee retry must NOT fire (it would keep
   * the bad section, fail again, and cost a wasted round trip on a
   * misdiagnosis). Asana names the field in its message, which is what the
   * heuristic now reads.
   */
  it('does not blame the assignee for a section rejection, and reports push_failed', async () => {
    hoistedApi.createTask.mockRejectedValue(
      new FakeApiError(400, 'section: Not a section in the given project'),
    )
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })

    const result = await pushActionToAsana(args(db.client))
    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect((result as { error: string }).error).toContain('Not a section in the given project')
    // The whole point: one call, no unassigned retry.
    expect(hoistedApi.createTask).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 5xx even with an assignee (transient, not the assignee)', async () => {
    hoistedApi.createTask.mockRejectedValue(new FakeApiError(500, 'server error'))
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    await expect(pushActionToAsana(args(db.client))).rejects.toThrow('server error')
    expect(hoistedApi.createTask).toHaveBeenCalledTimes(1)
  })

  it('pushes unassigned when the email lookup finds nothing', async () => {
    hoistedAdmin.getUserById.mockResolvedValue({ data: { user: null } })
    const db = makeDb({ action: ASSIGNED, member: { user_id: 'u-9' } })
    const result = await pushActionToAsana(args(db.client))
    expect(result.ok).toBe(true)
    expect(hoistedApi.createTask.mock.calls[0][1].assignee).toBeUndefined()
  })
})

// ---- Link row ------------------------------------------------------------

describe('pushActionToAsana — link row', () => {
  it('persists the gid, permalink, title and completion from the created task', async () => {
    const db = makeDb({ action: ACTION })
    const result = await pushActionToAsana(args(db.client))

    expect(result.ok).toBe(true)
    const insert = db.inserts[0]
    expect(insert).toMatchObject({
      workspace_id: 'ws-1',
      action_id: 'act-1',
      provider: 'asana',
      external_id: 'task-1',
      external_url: 'https://app.asana.com/0/1/task-1',
      external_title: 'Ship the thing',
      completed: false,
      created_by: 'u-1',
    })
    expect(insert.last_synced_at).toBeTruthy()
  })
})

// ---- Pure helpers --------------------------------------------------------

describe('dueFieldsFor', () => {
  it('returns {} with no due date', () => {
    expect(dueFieldsFor(null, false)).toEqual({})
    expect(dueFieldsFor(undefined, true)).toEqual({})
  })

  it('slices the date off an ISO string rather than round-tripping through Date', () => {
    // A round-trip would shift this to the previous day in a negative-offset TZ.
    expect(dueFieldsFor('2026-07-30T00:00:00.000Z', true)).toEqual({ due_on: '2026-07-30' })
  })

  it('passes the full instant through for a timed due date', () => {
    expect(dueFieldsFor('2026-07-30T17:00:00.000Z', false)).toEqual({
      due_at: '2026-07-30T17:00:00.000Z',
    })
  })

  it('never returns both fields', () => {
    for (const allDay of [true, false]) {
      const fields = dueFieldsFor('2026-07-30T17:00:00.000Z', allDay)
      expect(Object.keys(fields)).toHaveLength(1)
    }
  })

  it('returns {} for an unparseable value', () => {
    expect(dueFieldsFor('soon', true)).toEqual({})
  })
})

// ---- Schema contract -----------------------------------------------------

/**
 * The lost-race handling above is only correct because the database refuses the
 * second link row. An external_id-bearing key would admit BOTH concurrent
 * pushes (different gids), the 23505 would never fire, and the action would end
 * up double-linked with a duplicate task in Asana — silently, since every code
 * path still "succeeds". Assert the constraint the code depends on, statically.
 */
describe('action_external_task uniqueness (migration 212)', () => {
  it('is keyed on (action_id, provider) — NOT on external_id', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/212_asana_tasks_integration.sql'),
      'utf8',
    )
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.action_external_task'))
    const unique = /UNIQUE\s*\(([^)]*)\)/.exec(table)
    expect(unique).toBeTruthy()
    const columns = unique![1].split(',').map((c) => c.trim())
    expect(columns).toEqual(['action_id', 'provider'])
  })
})

describe('buildHtmlNotes', () => {
  it('always carries the deep link, even with no identifier or description', () => {
    const notes = buildHtmlNotes({ actionId: 'act-9', identifier: null, description: null })
    expect(notes).toBe(
      '<body>Pushed from Dial8: <a href="https://dial8.ai/account?action=act-9">this action</a></body>',
    )
  })

  it('escapes HTML in the description so it cannot inject markup', () => {
    const notes = buildHtmlNotes({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: '<script>alert(1)</script>',
    })
    expect(notes).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(notes).not.toContain('<script>')
  })

  // ---- attribution opt-out -------------------------------------------------

  /**
   * `include_dial8_attribution: false` strips the identifier heading AND the
   * backlink as one unit, leaving the action's own description untouched. The
   * absent/true cases pin TODAY's exact bytes, so an existing connection (whose
   * config has no such key) is provably unchanged.
   */
  it('pins the attributed output byte-for-byte when the flag is absent', () => {
    const notes = buildHtmlNotes({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
    })
    expect(notes).toBe(
      '<body><strong>ENG-1</strong>\n\nDo the work\n\n' +
        'Pushed from Dial8: <a href="https://dial8.ai/account?action=act-9">ENG-1</a></body>',
    )
  })

  it('treats an explicit true identically to absent', () => {
    const withFlag = buildHtmlNotes({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
      attribution: true,
    })
    const withoutFlag = buildHtmlNotes({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
    })
    expect(withFlag).toBe(withoutFlag)
  })

  it('drops BOTH the identifier heading and the backlink when attribution is off', () => {
    const notes = buildHtmlNotes({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: 'Do the work',
      attribution: false,
    })
    // What remains is the description and nothing else — the true-case output
    // minus exactly the two attribution parts.
    expect(notes).toBe('<body>Do the work</body>')
    expect(notes).not.toContain('Pushed from Dial8')
    expect(notes).not.toContain('ENG-1')
    expect(notes).not.toContain('dial8.ai')
  })

  it('emits empty notes when attribution is off and the action has no description', () => {
    // `<body></body>` is what Asana wants for a task with no notes, and is what
    // an un-attributed action with no description honestly is.
    expect(
      buildHtmlNotes({
        actionId: 'act-9',
        identifier: 'ENG-1',
        description: null,
        attribution: false,
      }),
    ).toBe('<body></body>')
  })

  it('still escapes the description when attribution is off', () => {
    // Dropping the Dial8 parts must not drop the escaping of the user's own.
    const notes = buildHtmlNotes({
      actionId: 'act-9',
      identifier: 'ENG-1',
      description: '<script>alert(1)</script>',
      attribution: false,
    })
    expect(notes).toBe('<body>&lt;script&gt;alert(1)&lt;/script&gt;</body>')
  })
})
