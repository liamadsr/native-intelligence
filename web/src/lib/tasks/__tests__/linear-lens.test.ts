import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/tasks/linear-lens.ts — the Linear half of the property lens.
 *
 * Invariants locked in:
 *  - NORMALIZATION: `priority` is an Int on a fixed 0-4 scale and 0 ("No priority")
 *    normalizes to null; `labels.nodes` become UUID refs; `team` is reported (it is
 *    the ONLY option scope Linear needs, since members/labels/projects are all
 *    team-scoped) while `issue_type` and `section` are always null.
 *  - ONE MUTATION, NO READ-BACK CALL: `issueUpdate` takes every field at once and
 *    returns the updated issue inline, which IS the read-through body. Jira needs a
 *    re-GET (204 PUT) and Asana needs one (tag calls land after the PUT); Linear
 *    needs neither, and that difference is asserted by call count.
 *  - A cleared priority becomes 0 — Linear cannot unset the field itself.
 *  - ERROR TAXONOMY: a null `issue(id:)` and a `trashed` issue both map to the
 *    RETRYABLE task_missing, never task_deleted — Linear returns null for THREE
 *    indistinguishable situations (deleted / invisible / never existed) and its
 *    delete is a 30-day trash, which is what linear-link-marker.ts already
 *    encodes. Rate limiting is DUAL-MODE (HTTP 429 or a 400 carrying
 *    extensions.code RATELIMITED) and both map to provider_error FAST.
 */

const hoistedApi = vi.hoisted(() => ({ linearGraphQL: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly code = 'LINEAR_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly graphQLErrors: Array<{ extensions?: { code?: string } }>
  constructor(
    status: number,
    message = 'boom',
    graphQLErrors: Array<{ extensions?: { code?: string } }> = [],
  ) {
    super(message)
    this.name = 'LinearApiError'
    this.status = status
    this.graphQLErrors = graphQLErrors
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    linearGraphQL: hoistedApi.linearGraphQL,
    LinearUnauthorizedError: FakeUnauthorized,
    LinearApiError: FakeApiError,
    // Linear's limiter is dual-mode: a plain 429, OR a 400 whose GraphQL error
    // carries extensions.code === 'RATELIMITED'.
    isLinearRateLimited: (err: unknown) =>
      err instanceof FakeApiError &&
      (err.status === 429 ||
        err.graphQLErrors.some((e) => e?.extensions?.code === 'RATELIMITED')),
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

const {
  LINEAR_LENS_EDITABLE,
  linearLensFields,
  linearLensInput,
  readLinearTaskDetails,
  updateLinearTaskFields,
} = await import('../linear-lens')

const LINK = {
  id: 'link-1',
  external_id: 'uuid-issue-1',
  external_scope: null,
  external_url: 'https://linear.app/acme/issue/ENG-42',
  external_title: 'Stored title',
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'uuid-issue-1',
    identifier: 'ENG-42',
    title: 'Fix the thing',
    url: 'https://linear.app/acme/issue/ENG-42',
    trashed: false,
    dueDate: '2026-08-01',
    priority: 3,
    state: { id: 'st-1', name: 'In Progress', type: 'started' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: { id: 'proj-1', name: 'Platform' },
    assignee: { id: 'u-1', name: 'Jane Lee', displayName: 'jane', email: 'jane@acme.com' },
    labels: { nodes: [{ id: 'lb-1', name: 'backend' }] },
    ...overrides,
  }
}

/** The read query answers `{ issue }`; the mutation answers `{ issueUpdate }`. */
function mockRead(value: unknown) {
  hoistedApi.linearGraphQL.mockResolvedValue({ issue: value })
}
function mockUpdate(value: unknown, success = true) {
  hoistedApi.linearGraphQL.mockResolvedValue({ issueUpdate: { success, issue: value } })
}

/** The `input` variable of the last mutation call. */
function lastInput(): Record<string, unknown> {
  const calls = hoistedApi.linearGraphQL.mock.calls
  return calls[calls.length - 1][2].input
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadLinearSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: { team_id: 'team-CONFIG', organization_id: 'org-1' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({ token: 'tok', accountId: 'acct-1' })
  mockRead(issue())
})

// ---- Normalization --------------------------------------------------------

describe('linearLensFields', () => {
  it('normalizes every field into the lens shape', () => {
    expect(linearLensFields(issue())).toEqual({
      project: { id: 'proj-1', name: 'Platform' },
      issue_type: null,
      team: { id: 'team-1', name: 'Engineering' },
      section: null,
      // displayName wins over name — it is the nickname Linear itself shows.
      assignee: { id: 'u-1', name: 'jane' },
      priority: { id: '3', name: 'Medium' },
      due_date: '2026-08-01',
      labels: [{ id: 'lb-1', name: 'backend' }],
    })
  })

  it('reports issue_type and section as null — Linear has neither', () => {
    const fields = linearLensFields(issue())
    expect(fields.issue_type).toBeNull()
    expect(fields.section).toBeNull()
  })

  it.each([
    [1, 'Urgent'],
    [2, 'High'],
    [3, 'Medium'],
    [4, 'Low'],
  ])('maps priority %i to %s', (priority, name) => {
    expect(linearLensFields(issue({ priority })).priority).toEqual({
      id: String(priority),
      name,
    })
  })

  /**
   * 0 is a real value Linear stores, but as a chip it is indistinguishable from
   * unset — and the write path clears with 0 anyway — so it normalizes to null and
   * "no priority" stays ONE state in the UI.
   */
  it('normalizes priority 0 (No priority) to null', () => {
    expect(linearLensFields(issue({ priority: 0 })).priority).toBeNull()
  })

  it('reports nulls for an unassigned, unprojected, undated issue', () => {
    const fields = linearLensFields(
      issue({
        assignee: null,
        project: null,
        dueDate: null,
        priority: 0,
        labels: { nodes: [] },
      }),
    )
    expect(fields.assignee).toBeNull()
    expect(fields.project).toBeNull()
    expect(fields.due_date).toBeNull()
    expect(fields.priority).toBeNull()
    expect(fields.labels).toEqual([])
  })

  it('falls back through displayName → name → email for the assignee', () => {
    expect(
      linearLensFields(issue({ assignee: { id: 'u-1', name: 'Jane Lee' } })).assignee,
    ).toEqual({ id: 'u-1', name: 'Jane Lee' })
    expect(
      linearLensFields(issue({ assignee: { id: 'u-1', email: 'j@a.com' } })).assignee,
    ).toEqual({ id: 'u-1', name: 'j@a.com' })
  })

  it('falls back to the team KEY when the name is missing', () => {
    expect(linearLensFields(issue({ team: { id: 'team-1', key: 'ENG' } })).team).toEqual({
      id: 'team-1',
      name: 'ENG',
    })
  })

  it('drops a label with no id', () => {
    const fields = linearLensFields(
      issue({ labels: { nodes: [{ name: 'ghost' }, { id: 'lb-2', name: 'ok' }] } }),
    )
    expect(fields.labels).toEqual([{ id: 'lb-2', name: 'ok' }])
  })

  it('survives a missing labels connection', () => {
    expect(linearLensFields(issue({ labels: null })).labels).toEqual([])
    expect(linearLensFields({}).labels).toEqual([])
  })
})

describe('LINEAR_LENS_EDITABLE', () => {
  /** No per-issue field-permission model, and priority is a real field on every issue. */
  it('is all four fields', () => {
    expect(LINEAR_LENS_EDITABLE).toEqual({
      assignee: true,
      priority: true,
      due_date: true,
      labels: true,
    })
  })
})

// ---- The mutation input ---------------------------------------------------

describe('linearLensInput', () => {
  it('maps every lens field to its IssueUpdateInput key', () => {
    expect(
      linearLensInput({
        assignee_id: 'u-2',
        priority_id: '1',
        due_date: '2026-08-01',
        label_ids: ['lb-1'],
      }),
    ).toEqual({
      ok: true,
      value: {
        assigneeId: 'u-2',
        priority: 1,
        dueDate: '2026-08-01',
        labelIds: ['lb-1'],
      },
    })
  })

  it('sends explicit nulls for cleared assignee and due date', () => {
    expect(linearLensInput({ assignee_id: null, due_date: null })).toEqual({
      ok: true,
      value: { assigneeId: null, dueDate: null },
    })
  })

  /** Linear has no way to UNSET priority — a clear is priority 0. */
  it('maps a cleared priority to 0, not null', () => {
    expect(linearLensInput({ priority_id: null })).toEqual({
      ok: true,
      value: { priority: 0 },
    })
  })

  it('omits untouched fields', () => {
    expect(linearLensInput({ assignee_id: 'u-2' })).toEqual({
      ok: true,
      value: { assigneeId: 'u-2' },
    })
  })

  it('sends an empty labelIds array as the full-replacement clear', () => {
    expect(linearLensInput({ label_ids: [] })).toEqual({ ok: true, value: { labelIds: [] } })
  })

  it.each([['5'], ['-1'], ['high']])('rejects the out-of-scale priority "%s"', (id) => {
    expect(linearLensInput({ priority_id: id }).ok).toBe(false)
  })
})

// ---- readLinearTaskDetails ----------------------------------------------

describe('readLinearTaskDetails', () => {
  it('returns the normalized lens body in ONE query', async () => {
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({
      ok: true,
      provider: 'linear',
      link_id: 'link-1',
      url: 'https://linear.app/acme/issue/ENG-42',
      title: 'Fix the thing',
      status_name: 'In Progress',
      editable: LINEAR_LENS_EDITABLE,
    })
    expect(hoistedApi.linearGraphQL).toHaveBeenCalledTimes(1)
  })

  /**
   * The team is the ONLY scope Linear needs, and it comes from the ISSUE rather
   * than the config: members, labels and projects are all team-scoped, and an issue
   * moved to another team must populate its pickers from THAT team.
   */
  it('scopes the pickers to the ISSUE`s team, not the config`s', async () => {
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.option_scope).toEqual({ team_id: 'team-1' })
  })

  it('reports an empty scope when the issue carries no team', async () => {
    mockRead(issue({ team: null }))
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.option_scope).toEqual({})
  })

  it('addresses the issue by its permanent UUID', async () => {
    await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(hoistedApi.linearGraphQL.mock.calls[0][2]).toEqual({ id: 'uuid-issue-1' })
  })

  it('reports not_connected when the workspace has no Linear row', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'not_connected' })
    expect(hoistedApi.linearGraphQL).not.toHaveBeenCalled()
  })

  it('reports reconnect_required when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
    expect(hoistedApi.linearGraphQL).not.toHaveBeenCalled()
  })

  it('maps a rejected token FROM Linear to reconnect_required', async () => {
    hoistedApi.linearGraphQL.mockRejectedValue(new FakeUnauthorized())
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
  })

  /**
   * THE RETRYABLE READING. Linear answers a clean `{ data: { issue: null } }` with
   * NO errors entry for THREE indistinguishable situations — deleted, invisible to
   * this user, or never existed. linear-link-marker.ts refuses a terminal reading
   * for exactly that reason, and the lens keeps its stance.
   */
  it('maps a NULL issue to the RETRYABLE task_missing, never task_deleted', async () => {
    mockRead(null)
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })

  /** Linear's delete is a 30-day trash — gone-for-now, possibly back. Same code. */
  it('maps a TRASHED issue to task_missing too, not a code of its own', async () => {
    mockRead(issue({ trashed: true }))
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })

  /** An ARCHIVED issue is a perfectly real one — Linear auto-archives old completes. */
  it('renders an ARCHIVED issue normally', async () => {
    mockRead(issue({ archivedAt: '2026-01-01T00:00:00Z' }))
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok).toBe(true)
  })

  it('maps a plain 429 to provider_error', async () => {
    hoistedApi.linearGraphQL.mockRejectedValue(new FakeApiError(429, 'slow down'))
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    expect(res.ok === false && res.error).toMatch(/rate limiting/i)
  })

  /** DUAL-MODE: Linear also rate limits as a 400 carrying a GraphQL error code. */
  it('maps a 400 + extensions.code RATELIMITED to provider_error', async () => {
    hoistedApi.linearGraphQL.mockRejectedValue(
      new FakeApiError(400, 'rate limited', [{ extensions: { code: 'RATELIMITED' } }]),
    )
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    expect(res.ok === false && res.error).toMatch(/rate limiting/i)
  })

  it('maps any other failure to provider_error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedApi.linearGraphQL.mockRejectedValue(new FakeApiError(500, 'boom'))
    const res = await readLinearTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    errSpy.mockRestore()
  })
})

// ---- updateLinearTaskFields --------------------------------------------

describe('updateLinearTaskFields', () => {
  /**
   * THE LINEAR SIMPLIFICATION IN ONE ASSERTION: one call total. The mutation
   * returns the updated issue with the lens's whole field set inline, so its
   * response IS the read-through body — no re-GET the way Jira's 204 PUT forces.
   */
  it('writes and reads back in ONE mutation', async () => {
    mockUpdate(issue({ priority: 1 }))
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { priority_id: '1' },
    })
    expect(hoistedApi.linearGraphQL).toHaveBeenCalledTimes(1)
    expect(lastInput()).toEqual({ priority: 1 })
    expect(res).toMatchObject({ ok: true, provider: 'linear' })
    expect(res.ok && res.fields.priority).toEqual({ id: '1', name: 'Urgent' })
  })

  it('sends every touched field in the SAME mutation', async () => {
    mockUpdate(issue())
    await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: {
        assignee_id: 'u-2',
        priority_id: '2',
        due_date: '2026-09-01',
        label_ids: ['lb-9'],
      },
    })
    expect(hoistedApi.linearGraphQL).toHaveBeenCalledTimes(1)
    expect(lastInput()).toEqual({
      assigneeId: 'u-2',
      priority: 2,
      dueDate: '2026-09-01',
      labelIds: ['lb-9'],
    })
  })

  it('clears the assignee and due date with explicit nulls', async () => {
    mockUpdate(issue({ assignee: null, dueDate: null }))
    await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: null, due_date: null },
    })
    expect(lastInput()).toEqual({ assigneeId: null, dueDate: null })
  })

  it('clears the priority as 0', async () => {
    mockUpdate(issue({ priority: 0 }))
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { priority_id: null },
    })
    expect(lastInput()).toEqual({ priority: 0 })
    expect(res.ok && res.fields.priority).toBeNull()
  })

  /** Nothing is sent — so this is a field-level rejection, not a provider failure. */
  it('rejects an out-of-scale priority WITHOUT calling Linear', async () => {
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { priority_id: '9' },
    })
    expect(res).toMatchObject({ ok: false, code: 'field_not_editable' })
    expect(hoistedApi.linearGraphQL).not.toHaveBeenCalled()
  })

  /** `success: false` with no errors entry would otherwise store a link to nothing. */
  it('treats success:false as a failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockUpdate(issue(), false)
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    errSpy.mockRestore()
  })

  it('treats a mutation with no issue as a failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockUpdate(null)
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    errSpy.mockRestore()
  })

  it('reports task_missing when the write lands on a trashed issue', async () => {
    mockUpdate(issue({ trashed: true }))
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })

  it('maps a rejected token during the write to reconnect_required', async () => {
    hoistedApi.linearGraphQL.mockRejectedValue(new FakeUnauthorized())
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
  })

  it('maps a rate limit during the write to provider_error', async () => {
    hoistedApi.linearGraphQL.mockRejectedValue(new FakeApiError(429, 'slow down'))
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
  })

  it('does not write when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await updateLinearTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
    expect(hoistedApi.linearGraphQL).not.toHaveBeenCalled()
  })
})
