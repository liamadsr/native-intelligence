/**
 * Tests for the OVERRIDE half of src/lib/tasks/jira-push.ts.
 *
 * Kept apart from jira-push.test.ts on purpose: that file pins the behaviour a
 * push has with NO overrides, and it must keep passing untouched — it is the
 * executable statement of the byte-compatibility rule. This file only ever calls
 * the push WITH an override, so the two can never be confused for one another.
 *
 * What is locked in here:
 *  - every override lands in the create payload in Jira's own shape (a priority
 *    is `{ id }`, a custom field is spread at the TOP of `fields` keyed by
 *    fieldId, labels are a bare string array).
 *  - an overridden project+type replaces the config's pair rather than merging
 *    with it, and can COMPLETE a destination the config left half-picked.
 *  - the SITE is never overridable: no cloud_id is still not_configured.
 *  - an overridden assignee is set by accountId with NO user search at all, and
 *    a failure to assign still leaves the push successful.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

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

const { pushActionToJira } = await import('../jira-push')
import type { JiraPushOverrides } from '../push-overrides'

/** Minimal chainable Supabase fake: one action, no existing link, insert echoes. */
function makeDb(action: Record<string, unknown> | null) {
  const inserts: Array<Record<string, unknown>> = []
  function builder(table: string) {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      order: () => api,
      limit: () => api,
      insert: (payload: Record<string, unknown>) => {
        inserts.push(payload)
        return {
          select: () => ({ single: async () => ({ data: { id: 'link-1', ...payload }, error: null }) }),
        }
      },
      maybeSingle: async () => {
        if (table === 'actions') return { data: action, error: null }
        if (table === 'member') return { data: { user_id: 'auth-1' }, error: null }
        return { data: null, error: null }
      },
    }
    return api
  }
  return { client: { from: builder } as unknown as SupabaseClient, inserts }
}

const ACTION = {
  id: 'act-1',
  identifier: 'ENG-42',
  title: 'Ship the thing',
  description: 'Do the work',
  due_at: '2026-07-30T17:00:00.000Z',
  assignee_id: null,
  workflow_state: { category: 'started' },
}

const CONFIG = {
  cloud_id: 'cafe0001',
  site_name: 'Acme',
  site_url: 'https://acme.atlassian.net',
  project_id: '10000',
  project_key: 'ENG',
  project_name: 'Engineering',
  issue_type_id: '10001',
  issue_type_name: 'Task',
}

function push(overrides: JiraPushOverrides, action: Record<string, unknown> | null = ACTION) {
  const db = makeDb(action)
  return {
    db,
    result: pushActionToJira({
      actionId: 'act-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      supabase: db.client,
      overrides,
    }),
  }
}

/** The `fields` object of the last create call. */
function sentFields(): Record<string, unknown> {
  const call = hoistedApi.createIssue.mock.calls.at(-1)
  return (call?.[2] as { fields: Record<string, unknown> }).fields
}

beforeEach(() => {
  vi.resetAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://dial8.ai'
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: CONFIG,
  })
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
  hoistedApi.assignIssue.mockResolvedValue(undefined)
  hoistedApi.searchUsers.mockResolvedValue([])
})

describe('pushActionToJira — destination overrides', () => {
  it('sends the OVERRIDDEN project and issue type, not the config pair', async () => {
    await push({ project_id: '20000', issue_type_id: '20001' }).result
    expect(sentFields()).toMatchObject({
      project: { id: '20000' },
      issuetype: { id: '20001' },
    })
  })

  it('overrides the issue type alone, keeping the config project', async () => {
    await push({ issue_type_id: '20001' }).result
    expect(sentFields()).toMatchObject({
      project: { id: '10000' },
      issuetype: { id: '20001' },
    })
  })

  it('replaces the summary with the overridden title', async () => {
    await push({ title: 'A different summary' }).result
    expect(sentFields().summary).toBe('A different summary')
  })

  /**
   * COMPLETING a half-picked config. A workspace that connected Jira and chose a
   * site but never a project is `not_configured` for a plain push, and must
   * still be pushable from the compose panel — that is most of the point.
   */
  it('completes a destination the config left half-picked', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { cloud_id: 'cafe0001', site_url: 'https://acme.atlassian.net' },
    })
    const result = await push({ project_id: '20000', issue_type_id: '20001' }).result
    expect(result.ok).toBe(true)
    expect(sentFields()).toMatchObject({ project: { id: '20000' } })
  })

  /**
   * The site is NOT overridable in v1: external_scope on the link row is the
   * config cloudId and every option route addresses one site. A workspace with
   * no site is not_configured no matter what the panel sent.
   */
  it('still refuses when the config has no SITE, override or not', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: {},
    })
    const result = await push({ project_id: '20000', issue_type_id: '20001' }).result
    expect(result).toMatchObject({ ok: false, code: 'not_configured' })
    expect(hoistedApi.createIssue).not.toHaveBeenCalled()
  })

  it('sends priority in Jira’s `{ id }` shape', async () => {
    await push({ priority_id: '3' }).result
    expect(sentFields().priority).toEqual({ id: '3' })
  })

  it('sends labels as a bare string array', async () => {
    await push({ labels: ['infra', 'p1'] }).result
    expect(sentFields().labels).toEqual(['infra', 'p1'])
  })

  it('prefers the overridden due date over the action’s own', async () => {
    await push({ due_date: '2026-09-09' }).result
    expect(sentFields().duedate).toBe('2026-09-09')
  })

  /**
   * The required-custom-field wall's payload half: each answered field is
   * spread at the TOP level of `fields`, keyed by its fieldId, exactly as Jira
   * expects — NOT nested under a `custom_fields` envelope of our own.
   */
  it('spreads custom_fields into `fields` keyed by fieldId', async () => {
    await push({
      custom_fields: {
        customfield_10041: { id: 'opt-9' },
        customfield_10050: { id: 'opt-2' },
      },
    }).result
    const fields = sentFields()
    expect(fields.customfield_10041).toEqual({ id: 'opt-9' })
    expect(fields.customfield_10050).toEqual({ id: 'opt-2' })
    expect(fields.custom_fields).toBeUndefined()
  })

  it('omits every compose-only field when the override does not carry it', async () => {
    await push({ title: 'Just a title' }).result
    const fields = sentFields()
    expect(fields.priority).toBeUndefined()
    expect(fields.labels).toBeUndefined()
  })

  /**
   * REGRESSION (review finding: "Empty label arrays are sent to the provider,
   * contradicting the parser's documented equivalence").
   *
   * The parser deliberately PRESERVES `[]` rather than folding it to absent, so
   * a future "clear the labels" gesture stays expressible, and its comment
   * promises the two "produce the same create payload today". They did not: the
   * merge tested truthiness and `[]` is truthy, so `labels: []` reached the
   * create. Jira rejects any field absent from the project's create screen
   * REGARDLESS of value, so an AI-tool caller expressing "no labels" as `[]`
   * bought a 400 and a wasted strip-retry round trip on a push that should have
   * been one clean call. Emptiness is decided at the MERGE so the parser keeps
   * its distinction.
   */
  it('does NOT send an empty labels array — absent and [] make the same payload', async () => {
    await push({ labels: [] }).result
    expect(sentFields().labels).toBeUndefined()
  })
})

describe('pushActionToJira — overridden assignee', () => {
  it('assigns by accountId with NO user search', async () => {
    await push({ assignee_account_id: 'acc-42' }).result
    expect(hoistedApi.searchUsers).not.toHaveBeenCalled()
    expect(hoistedApi.assignIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', 'acc-42')
  })

  it('never puts the assignee on the CREATE call', async () => {
    await push({ assignee_account_id: 'acc-42' }).result
    expect(sentFields().assignee).toBeUndefined()
  })

  /** An issue that exists unassigned still beats a push reported as failed. */
  it('succeeds even when the assign call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.assignIssue.mockRejectedValue(new Error('no permission'))
    const result = await push({ assignee_account_id: 'acc-42' }).result
    expect(result.ok).toBe(true)
  })

  /**
   * The override WINS over the action's own assignee, and skips the email
   * bridge entirely rather than racing it.
   */
  it('takes precedence over the action’s Native Intelligence assignee', async () => {
    hoistedAdmin.getUserById.mockResolvedValue({ data: { user: { email: 'ada@example.com' } } })
    await push({ assignee_account_id: 'acc-42' }, { ...ACTION, assignee_id: 'mem-1' }).result
    expect(hoistedApi.searchUsers).not.toHaveBeenCalled()
    expect(hoistedApi.assignIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', 'acc-42')
  })
})

// ---- reporting a silent degradation ----------------------------------------

/**
 * REGRESSION (review finding: "Jira: explicitly overridden due_date/labels can
 * be silently stripped and an overridden assignee can silently fail, with
 * success reported").
 *
 * Dropping `duedate`/`labels` to keep the issue stays deliberate — that trade is
 * argued for at OPTIONAL_CREATE_FIELDS and is not being reversed here. What was
 * missing is any way to SAY SO: the ok arm carried only { link, created }, so a
 * user who typed a due date got a success chip and an issue without one, and the
 * jira-compose-meta cache comment justified its own staleness by claiming this
 * class surfaces as push_failed — which is false for exactly these fields.
 *
 * The reach is wider than a stale cache: the AI/MCP tool consults no compose-meta
 * gate at all, so a model-supplied due date on a screen without `duedate` is
 * dropped on EVERY push. Absent fields keep the no-override path byte-identical.
 */
describe('pushActionToJira — reporting what the retry gave up', () => {
  it('names the dropped fields on an otherwise successful push', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(
        new FakeApiError(400, 'bad request', {
          duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown.",
        }),
      )
      .mockResolvedValueOnce({ id: '99001', key: 'ENG-7' })

    const settled = await push({ due_date: '2026-09-09' }).result

    expect(settled.ok).toBe(true)
    expect(settled).toMatchObject({ created: true, dropped_fields: ['duedate'] })
  })

  it('says nothing about dropped fields when nothing was dropped', async () => {
    // The ordinary push must stay byte-compatible: no new key appears.
    const settled = await push({ due_date: '2026-09-09' }).result
    expect(settled.ok).toBe(true)
    expect(settled).not.toHaveProperty('dropped_fields')
  })

  it('reports an overridden assignee that could not be applied', async () => {
    hoistedApi.assignIssue.mockRejectedValue(new Error('no permission'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const settled = await push({ assignee_account_id: 'acc-42' }).result

    // The issue still exists and the push still succeeded — only the refinement
    // was lost, which is the trade this path deliberately makes.
    expect(settled.ok).toBe(true)
    expect(settled).toMatchObject({ assignee_set: false })
  })

  it('says nothing about the assignee when it was applied', async () => {
    const settled = await push({ assignee_account_id: 'acc-42' }).result
    expect(settled.ok).toBe(true)
    expect(settled).not.toHaveProperty('assignee_set')
  })
})
