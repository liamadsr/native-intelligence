/**
 * Tests for the OVERRIDE half of src/lib/tasks/linear-push.ts.
 *
 * Kept apart from linear-push.test.ts, which pins the no-override behaviour and
 * must keep passing untouched.
 *
 * THE CROSS-TEAM STATE DERIVATION is the reason this file is the longest of the
 * three. `config.state_map` describes the CONFIGURED team's workflow states, and
 * a Linear workflow state belongs to exactly one team — so a team override must
 * re-derive from the new team's own states rather than carry the map across. The
 * tests below pin all three halves of that: the re-derive happens, it happens
 * ONLY when the team actually changed, and a failed re-derive costs placement
 * rather than the push.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoistedApi = vi.hoisted(() => ({
  createIssue: vi.fn(),
  deleteIssue: vi.fn(),
  findUserByEmail: vi.fn(),
  listTeamStates: vi.fn(),
}))
class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createIssue: hoistedApi.createIssue,
    deleteIssue: hoistedApi.deleteIssue,
    findUserByEmail: hoistedApi.findUserByEmail,
    listTeamStates: hoistedApi.listTeamStates,
    LinearUnauthorizedError: FakeUnauthorized,
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

const { pushActionToLinear } = await import('../linear-push')
// The REAL error class, pulled through the same mocked module the push sees:
// isLinearInputError gates on `instanceof LinearApiError`, so a hand-rolled
// stand-in would never be classified as an input rejection and the retry under
// test would never fire. Imported dynamically because a static import would be
// evaluated before the vi.mock factory's own bindings exist.
const { LinearApiError } = await import('@/lib/integrations/linear-api')
import type { LinearPushOverrides } from '../push-overrides'

function makeDb(action: Record<string, unknown> | null) {
  function builder(table: string) {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      order: () => api,
      limit: () => api,
      insert: (payload: Record<string, unknown>) => ({
        select: () => ({ single: async () => ({ data: { id: 'link-1', ...payload }, error: null }) }),
      }),
      maybeSingle: async () => {
        if (table === 'actions') return { data: action, error: null }
        if (table === 'member') return { data: { user_id: 'auth-1' }, error: null }
        return { data: null, error: null }
      },
    }
    return api
  }
  return { from: builder } as unknown as SupabaseClient
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
  organization_id: 'org-1',
  team_id: 'team-A',
  team_key: 'ENG',
  project_id: 'proj-A',
  state_map: {
    not_started: { id: 'state-A-todo', name: 'Todo' },
    in_progress: { id: 'state-A-doing', name: 'In Progress' },
  },
}

function push(overrides: LinearPushOverrides, action: Record<string, unknown> | null = ACTION) {
  return pushActionToLinear({
    actionId: 'act-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    supabase: makeDb(action),
    overrides,
  })
}

/** The `input` of the last issueCreate call. */
function sentInput(): Record<string, unknown> {
  return hoistedApi.createIssue.mock.calls.at(-1)?.[1] as Record<string, unknown>
}

beforeEach(() => {
  vi.resetAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://dial8.ai'
  hoistedConfig.loadLinearSyncState.mockResolvedValue({
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
  hoistedApi.createIssue.mockResolvedValue({
    id: 'issue-uuid',
    identifier: 'ENG-7',
    url: 'https://linear.app/acme/issue/ENG-7',
    state: { id: 'state-A-todo', name: 'Todo', type: 'unstarted' },
  })
  hoistedApi.deleteIssue.mockResolvedValue(undefined)
  hoistedApi.findUserByEmail.mockResolvedValue(null)
  // Team B's own states — deliberately named and typed so the derivation has a
  // real choice to make (unstarted beats backlog, lowest position wins).
  hoistedApi.listTeamStates.mockResolvedValue([
    { id: 'state-B-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 'state-B-ready', name: 'Ready', type: 'unstarted', position: 2 },
    { id: 'state-B-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 'state-B-done', name: 'Done', type: 'completed', position: 3 },
  ])
})

describe('pushActionToLinear — cross-team state derivation', () => {
  /**
   * The whole point. Team A's `state-A-todo` is not a legal target on team B, so
   * the push reads team B's states and folds them with the same pure function
   * the settings save uses — landing on Todo (unstarted, lowest position) rather
   * than Backlog.
   */
  it('re-derives the start state from the OVERRIDDEN team’s own states', async () => {
    await push({ team_id: 'team-B' })
    expect(hoistedApi.listTeamStates).toHaveBeenCalledWith('tok', 'team-B')
    expect(sentInput()).toMatchObject({ teamId: 'team-B', stateId: 'state-B-todo' })
  })

  it('NEVER carries the config’s state map across a team change', async () => {
    await push({ team_id: 'team-B' })
    expect(sentInput().stateId).not.toBe('state-A-todo')
  })

  /** An echo of the configured team must not pay for the extra read. */
  it('does NOT re-derive when the override names the configured team', async () => {
    await push({ team_id: 'team-A' })
    expect(hoistedApi.listTeamStates).not.toHaveBeenCalled()
    expect(sentInput().stateId).toBe('state-A-todo')
  })

  it('does NOT re-derive when no team is overridden', async () => {
    await push({ title: 'Renamed' })
    expect(hoistedApi.listTeamStates).not.toHaveBeenCalled()
    expect(sentInput().stateId).toBe('state-A-todo')
  })

  /**
   * BEST-EFFORT: omitting stateId lands the issue in the team's own default,
   * which is the same class of state this was trying to pick precisely.
   */
  it('omits stateId (and still pushes) when the re-derive fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.listTeamStates.mockRejectedValue(new Error('rate limited'))
    const result = await push({ team_id: 'team-B' })
    expect(result.ok).toBe(true)
    expect(sentInput().stateId).toBeUndefined()
  })

  it('omits stateId when the new team expresses no not_started state', async () => {
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'state-B-done', name: 'Done', type: 'completed', position: 0 },
    ])
    await push({ team_id: 'team-B' })
    expect(sentInput().stateId).toBeUndefined()
  })
})

describe('pushActionToLinear — project across a team change', () => {
  /**
   * Linear projects are many-to-many with teams, so the configured project need
   * not be associated with the overridden team at all — and `projectId` is one
   * of the fields whose rejection costs the whole create a retry.
   */
  it('DROPS the config project when the team changes', async () => {
    await push({ team_id: 'team-B' })
    expect(sentInput().projectId).toBeUndefined()
  })

  it('keeps the config project when the team does not change', async () => {
    await push({ title: 'Renamed' })
    expect(sentInput().projectId).toBe('proj-A')
  })

  it('uses an explicitly overridden project on the new team', async () => {
    await push({ team_id: 'team-B', project_id: 'proj-B' })
    expect(sentInput().projectId).toBe('proj-B')
  })
})

describe('pushActionToLinear — compose-only fields', () => {
  it('sends the overridden title', async () => {
    await push({ title: 'A different title' })
    expect(sentInput().title).toBe('A different title')
  })

  it('sends priority as a plain Int', async () => {
    await push({ priority: 2 })
    expect(sentInput().priority).toBe(2)
  })

  /**
   * 0 is "No priority" — a real, explicit choice. A truthiness check on the
   * override would silently drop it and land the issue on Linear's own default.
   */
  it('sends priority 0 rather than dropping it as falsy', async () => {
    await push({ priority: 0 })
    expect(sentInput()).toHaveProperty('priority', 0)
  })

  it('sends label_ids as `labelIds`', async () => {
    await push({ label_ids: ['lab-1', 'lab-2'] })
    expect(sentInput().labelIds).toEqual(['lab-1', 'lab-2'])
  })

  /**
   * REGRESSION (review finding: "Empty label arrays are sent to the provider").
   * The parser keeps `[]` distinguishable from absent on purpose; the MERGE is
   * where the two have to converge, so the create payload matches the parser's
   * documented "same payload today" promise. See the Jira sibling for the full
   * reasoning.
   */
  it('does NOT send an empty labelIds array', async () => {
    await push({ label_ids: [] })
    expect(sentInput().labelIds).toBeUndefined()
  })

  it('prefers the overridden due date over the action’s own', async () => {
    await push({ due_date: '2026-09-09' })
    expect(sentInput().dueDate).toBe('2026-09-09')
  })

  it('omits every compose-only field when the override does not carry it', async () => {
    await push({ title: 'Just a title' })
    const input = sentInput()
    expect(input.priority).toBeUndefined()
    expect(input.labelIds).toBeUndefined()
  })

  it('completes a destination the config never had', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { organization_id: 'org-1' },
    })
    const result = await push({ team_id: 'team-B' })
    expect(result.ok).toBe(true)
    expect(sentInput().teamId).toBe('team-B')
  })
})

describe('pushActionToLinear — overridden assignee', () => {
  it('sends the picked user id and never looks up an email', async () => {
    await push({ assignee_id: 'user-9' }, { ...ACTION, assignee_id: 'mem-1' })
    expect(sentInput().assigneeId).toBe('user-9')
    expect(hoistedAdmin.getUserById).not.toHaveBeenCalled()
    expect(hoistedApi.findUserByEmail).not.toHaveBeenCalled()
  })
})

// ---- The strip-optionals retry, meeting explicit compose picks --------------

/**
 * REGRESSION (review finding: "Linear strip-optionals retry silently discards
 * explicit compose choices and reports success").
 *
 * The retry exists so a stale CONFIG-derived id (a deleted project, a state that
 * moved) costs placement instead of the whole issue — "a far smaller loss than
 * losing the issue", as linear-push puts it. That reasoning holds only for
 * fields the user never chose. Once the compose panel threads EXPLICIT picks
 * into the same input, an indiscriminate strip throws away the assignee, project
 * and labels the user deliberately selected and still answers `created: true`,
 * so the UI shows a success chip for an issue nobody is working and no project
 * contains.
 *
 * The rule these tests pin: keep what the user chose, strip only what the config
 * supplied, and when EVERY optional field sent was explicit, do not silently
 * degrade at all — report push_failed so the user (still in the panel) can
 * re-pick. This mirrors the Jira sibling, which already protects explicit
 * priority and custom fields from its own strip.
 *
 * The no-override path is unchanged and stays pinned by linear-push.test.ts.
 */
describe('pushActionToLinear — strip retry protects explicit picks', () => {
  /** A real Linear input rejection — the only shape that earns the retry. */
  function inputError(message = 'Entity not found: Label - Could not find referenced Label.') {
    return new LinearApiError(200, message, [
      { message, extensions: { type: 'invalid input', code: 'INPUT_ERROR', userError: true } },
    ])
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  /**
   * The flagship scenario: config supplies the project, the panel supplies
   * assignee + priority + labels. One label went stale, Linear refuses the whole
   * create — the retry must keep every explicit pick and drop only the
   * config-derived project/state.
   */
  it('keeps override-supplied fields on the retry and drops only config-derived ones', async () => {
    hoistedApi.createIssue
      .mockRejectedValueOnce(inputError())
      .mockResolvedValueOnce({
        id: 'issue-uuid',
        identifier: 'ENG-7',
        url: 'https://linear.app/acme/issue/ENG-7',
        state: { id: 'state-A-todo', name: 'Todo', type: 'unstarted' },
      })

    const result = await push({
      assignee_id: 'user-9',
      priority: 1,
      label_ids: ['lab-1'],
      due_date: '2026-08-01',
    })

    expect(result.ok).toBe(true)
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(2)

    const retried = sentInput()
    // Everything the user picked survives…
    expect(retried.assigneeId).toBe('user-9')
    expect(retried.priority).toBe(1)
    expect(retried.labelIds).toEqual(['lab-1'])
    expect(retried.dueDate).toBe('2026-08-01')
    // …and only the config's own contributions are dropped.
    expect(retried).not.toHaveProperty('projectId')
    expect(retried).not.toHaveProperty('stateId')
    // The structural fields are untouched, as on the no-override path.
    expect(retried.teamId).toBe('team-A')
    expect(retried.title).toBe('Ship the thing')
  })

  /**
   * `priority: 0` is "No priority" — a real choice. A truthiness-based
   * re-add would silently drop it on the retry, reintroducing the very bug for
   * the one value most likely to be deliberate.
   */
  it('keeps an explicit priority of 0 on the retry', async () => {
    hoistedApi.createIssue.mockRejectedValueOnce(inputError()).mockResolvedValueOnce({
      id: 'issue-uuid',
      identifier: 'ENG-7',
      url: 'https://linear.app/acme/issue/ENG-7',
      state: { id: 'state-A-todo', name: 'Todo', type: 'unstarted' },
    })

    await push({ priority: 0, assignee_id: 'user-9' })
    expect(sentInput().priority).toBe(0)
  })

  /**
   * When every optional field sent came from the panel, the retry would have
   * nothing left to strip that the user did not choose — so degrading is not a
   * "smaller loss", it is the whole point of the push. Fail loudly instead:
   * Linear's message names the offending entity and the user is still looking
   * at the panel.
   */
  it('reports push_failed (no retry) when every sent optional was explicit', async () => {
    hoistedApi.createIssue.mockRejectedValue(inputError('Entity not found: Label'))
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      // No project and no state map: the config contributes NOTHING optional.
      config: { organization_id: 'org-1', team_id: 'team-A' },
    })

    const result = await push(
      { assignee_id: 'user-9', label_ids: ['lab-1'], priority: 2, due_date: '2026-08-01' },
      { ...ACTION, due_at: null },
    )

    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect((result as { error: string }).error).toContain('Entity not found: Label')
    // Never retried: there was nothing to give up that the user had not chosen.
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(1)
  })

  /**
   * The retry is still allowed to fail. When it does, the coded push_failed
   * already in place must survive the change — the user re-picks either way.
   */
  it('still reports push_failed when the retry is rejected too', async () => {
    hoistedApi.createIssue.mockRejectedValue(inputError('Title too long'))
    const result = await push({ assignee_id: 'user-9' })
    expect(result).toMatchObject({ ok: false, code: 'push_failed' })
    expect(hoistedApi.createIssue).toHaveBeenCalledTimes(2)
  })
})

/**
 * REGRESSION (review finding: "Explicit 'None'/cleared field choices silently
 * revert to config- or action-derived values").
 *
 * The panel is prefilled from the config, so "No project" is a CHANGE the user
 * made to a field that was showing P — and the push then resolved projectId back
 * to P because an absent override means "inherit". The issue landed in the
 * project the panel said it would not use. Same shape for the assignee, where
 * the fallback is the email bridge to the action's Dial8 assignee, and for the
 * due date.
 */
describe('pushActionToLinear — an explicitly CLEARED field is not re-inherited', () => {
  it('sends NO project when the user picked "No project" over a configured one', async () => {
    await push({ project_id: null })
    expect(sentInput().projectId).toBeUndefined()
  })

  it('still inherits the config project when the field was never touched', async () => {
    // The byte-compatible path: absent means inherit, exactly as before.
    await push({ title: 'Renamed' })
    expect(sentInput().projectId).toBe('proj-A')
  })

  it('pushes UNASSIGNED when the assignee was cleared, skipping the email bridge', async () => {
    await push({ assignee_id: null }, { ...ACTION, assignee_id: 'mem-1' })
    expect(sentInput().assigneeId).toBeUndefined()
    // The bridge is not merely overridden — it never runs.
    expect(hoistedAdmin.getUserById).not.toHaveBeenCalled()
    expect(hoistedApi.findUserByEmail).not.toHaveBeenCalled()
  })

  it('sends NO due date when the date input was cleared', async () => {
    await push({ due_date: null })
    expect(sentInput().dueDate).toBeUndefined()
  })

  it('still uses the action’s due date when the field was never touched', async () => {
    await push({ title: 'Renamed' })
    expect(sentInput().dueDate).toBe('2026-07-30')
  })
})
