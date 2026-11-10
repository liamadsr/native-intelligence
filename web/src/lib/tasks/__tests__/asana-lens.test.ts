import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/tasks/asana-lens.ts — the Asana half of the property lens.
 *
 * Invariants locked in:
 *  - NORMALIZATION: the FIRST membership supplies project+section (a task can be in
 *    many projects, and the push only ever puts it in one); tags become gid-bearing
 *    refs; `due_on` OR `due_at` becomes one date; `priority` is ALWAYS null because
 *    Asana has no such field.
 *  - TAG DIFFING: Asana does not accept a `tags` array on `PUT /tasks/{gid}` — only
 *    the dedicated addTag/removeTag endpoints — so a full-replacement `label_ids` is
 *    diffed against the current set and only the changes are issued. A tag on both
 *    sides is a NO-OP, not a remove-then-add (which would churn the activity feed
 *    with two events for a gesture that changed nothing).
 *  - A tags-only edit skips the PUT entirely; an untouched `label_ids` skips the
 *    current-tags read entirely.
 *  - ERROR TAXONOMY: 401 → reconnect_required; 404 → the TERMINAL `task_deleted`,
 *    which is where Asana correctly diverges from Jira and Linear (an Asana gid is
 *    globally unique and permanent, so a 404 really does mean gone —
 *    apply-remote-task-state already stamps task_deleted for exactly this);
 *    429 → provider_error FAST.
 */

const hoistedApi = vi.hoisted(() => ({ asanaFetch: vi.fn() }))
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
class FakeInvalidGid extends Error {
  readonly code = 'ASANA_INVALID_GID'
  readonly field: string
  constructor(field: string) {
    super(`Invalid Asana ${field}`)
    this.name = 'AsanaInvalidGidError'
    this.field = field
  }
}
vi.mock('@/lib/integrations/asana-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    asanaFetch: hoistedApi.asanaFetch,
    AsanaUnauthorizedError: FakeUnauthorized,
    AsanaApiError: FakeApiError,
    AsanaInvalidGidError: FakeInvalidGid,
  }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadAsanaSyncState: vi.fn() }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaSyncState: hoistedConfig.loadAsanaSyncState }
})

const {
  ASANA_LENS_EDITABLE,
  asanaLensFields,
  asanaLensPayload,
  diffTags,
  listWorkspaceTags,
  readAsanaTaskDetails,
  updateAsanaTaskFields,
} = await import('../asana-lens')

const LINK = {
  id: 'link-1',
  external_id: '777',
  external_scope: null,
  external_url: 'https://app.asana.com/0/1/777',
  external_title: 'Stored title',
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gid: '777',
    name: 'Fix the thing',
    completed: false,
    permalink_url: 'https://app.asana.com/0/1/777',
    due_on: '2026-08-01',
    due_at: null,
    assignee: { gid: 'u-1', name: 'Jane Lee', email: 'jane@acme.com' },
    projects: [{ gid: 'p-1', name: 'Engineering' }],
    memberships: [
      {
        project: { gid: 'p-1', name: 'Engineering' },
        section: { gid: 's-1', name: 'In Progress' },
      },
    ],
    tags: [{ gid: 't-1', name: 'urgent' }],
    ...overrides,
  }
}

/** Classify an asanaFetch call by path+method so a test can assert on the shape. */
function calls() {
  return hoistedApi.asanaFetch.mock.calls.map(([, path, init]) => ({
    path: path as string,
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: (init as RequestInit | undefined)?.body
      ? JSON.parse((init as RequestInit).body as string)
      : null,
  }))
}

function tagCalls() {
  return calls().filter((c) => c.path.includes('Tag'))
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadAsanaSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: { asana_workspace_gid: 'aw-1', project_gid: 'p-config' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({ token: 'tok', accountId: 'acct-1' })
  hoistedApi.asanaFetch.mockResolvedValue(task())
})

// ---- Normalization --------------------------------------------------------

describe('asanaLensFields', () => {
  it('normalizes every field into the lens shape', () => {
    expect(asanaLensFields(task())).toEqual({
      project: { id: 'p-1', name: 'Engineering' },
      issue_type: null,
      team: null,
      section: { id: 's-1', name: 'In Progress' },
      assignee: { id: 'u-1', name: 'Jane Lee' },
      priority: null,
      due_date: '2026-08-01',
      labels: [{ id: 't-1', name: 'urgent' }],
    })
  })

  /**
   * Asana has NO native priority field — it exists only as a per-project enum
   * custom field Native Intelligence has no schema knowledge of. Always null, never a guess.
   */
  it('ALWAYS reports priority as null', () => {
    expect(asanaLensFields(task()).priority).toBeNull()
    expect(asanaLensFields(task({ priority: { gid: 'x', name: 'High' } })).priority).toBeNull()
  })

  it('reports issue_type and team as null — Asana has neither', () => {
    const fields = asanaLensFields(task())
    expect(fields.issue_type).toBeNull()
    expect(fields.team).toBeNull()
  })

  /** A task can be in MANY projects; the push only ever puts it in one. */
  it('takes project+section from the FIRST membership', () => {
    const fields = asanaLensFields(
      task({
        memberships: [
          { project: { gid: 'p-A', name: 'Alpha' }, section: { gid: 's-A', name: 'Doing' } },
          { project: { gid: 'p-B', name: 'Beta' }, section: { gid: 's-B', name: 'Later' } },
        ],
      }),
    )
    expect(fields.project).toEqual({ id: 'p-A', name: 'Alpha' })
    expect(fields.section).toEqual({ id: 's-A', name: 'Doing' })
  })

  /** `memberships` carries the section but `projects` is the always-populated one. */
  it('falls back to `projects` when there are no memberships', () => {
    const fields = asanaLensFields(task({ memberships: [] }))
    expect(fields.project).toEqual({ id: 'p-1', name: 'Engineering' })
    expect(fields.section).toBeNull()
  })

  it('reports a project with no section', () => {
    const fields = asanaLensFields(
      task({ memberships: [{ project: { gid: 'p-1', name: 'Eng' }, section: null }] }),
    )
    expect(fields.project).toEqual({ id: 'p-1', name: 'Eng' })
    expect(fields.section).toBeNull()
  })

  /** `due_on` and `due_at` are mutually exclusive — either can be the populated one. */
  it('reads the date from due_at when due_on is empty', () => {
    expect(asanaLensFields(task({ due_on: null, due_at: '2026-09-15T17:00:00Z' })).due_date).toBe(
      '2026-09-15',
    )
  })

  it('prefers due_on when both somehow arrive', () => {
    expect(
      asanaLensFields(task({ due_on: '2026-08-01', due_at: '2026-09-15T17:00:00Z' })).due_date,
    ).toBe('2026-08-01')
  })

  it('reports nulls for an unassigned, undated, untagged task', () => {
    const fields = asanaLensFields(
      task({ assignee: null, due_on: null, due_at: null, tags: [] }),
    )
    expect(fields.assignee).toBeNull()
    expect(fields.due_date).toBeNull()
    expect(fields.labels).toEqual([])
  })

  it('falls back to the assignee email when the name is missing', () => {
    expect(asanaLensFields(task({ assignee: { gid: 'u-1', email: 'j@a.com' } })).assignee).toEqual(
      { id: 'u-1', name: 'j@a.com' },
    )
  })

  it('drops a tag with no gid rather than rendering an unselectable chip', () => {
    const fields = asanaLensFields(task({ tags: [{ name: 'ghost' }, { gid: 't-2', name: 'ok' }] }))
    expect(fields.labels).toEqual([{ id: 't-2', name: 'ok' }])
  })

  it('survives null/undefined task shapes', () => {
    for (const value of [null, undefined, {}]) {
      const fields = asanaLensFields(value as null)
      expect(fields.labels).toEqual([])
      expect(fields.project).toBeNull()
    }
  })
})

describe('ASANA_LENS_EDITABLE', () => {
  /** Static, not probed: Asana has no per-task field-permission model. */
  it('is the three real fields, with priority false because the field does not exist', () => {
    expect(ASANA_LENS_EDITABLE).toEqual({
      assignee: true,
      priority: false,
      due_date: true,
      labels: true,
    })
  })
})

// ---- The PUT payload ------------------------------------------------------

describe('asanaLensPayload', () => {
  it('sets assignee and due_on', () => {
    expect(asanaLensPayload({ assignee_id: 'u-2', due_date: '2026-08-01' })).toEqual({
      assignee: 'u-2',
      due_on: '2026-08-01',
    })
  })

  it('sends explicit nulls for cleared fields', () => {
    expect(asanaLensPayload({ assignee_id: null, due_date: null })).toEqual({
      assignee: null,
      due_on: null,
    })
  })

  it('omits untouched fields', () => {
    expect(asanaLensPayload({ assignee_id: 'u-2' })).toEqual({ assignee: 'u-2' })
  })

  /** Asana does not accept a `tags` array on the task PUT at all. */
  it('NEVER puts tags in the PUT payload', () => {
    expect(asanaLensPayload({ label_ids: ['t-1'], assignee_id: 'u-2' })).toEqual({
      assignee: 'u-2',
    })
  })

  /** Sending `due_on` alone clears `due_at` for free — they are mutually exclusive. */
  it('never sends due_at', () => {
    expect('due_at' in asanaLensPayload({ due_date: '2026-08-01' })).toBe(false)
  })
})

// ---- Tag diffing ----------------------------------------------------------

describe('diffTags', () => {
  it('adds what is new and removes what is gone', () => {
    expect(diffTags([{ id: 'a' }, { id: 'b' }], ['b', 'c'])).toEqual({
      add: ['c'],
      remove: ['a'],
    })
  })

  /**
   * A tag on BOTH sides is a no-op. A remove-then-add would churn the task's
   * activity feed with two events for a gesture that changed nothing.
   */
  it('leaves an unchanged tag alone', () => {
    expect(diffTags([{ id: 'a' }], ['a'])).toEqual({ add: [], remove: [] })
  })

  it('removes everything for an empty desired set — the clear', () => {
    expect(diffTags([{ id: 'a' }, { id: 'b' }], [])).toEqual({
      add: [],
      remove: ['a', 'b'],
    })
  })

  it('adds everything when the task has no tags', () => {
    expect(diffTags([], ['a', 'b'])).toEqual({ add: ['a', 'b'], remove: [] })
  })

  it('is order-insensitive', () => {
    expect(diffTags([{ id: 'a' }, { id: 'b' }], ['b', 'a'])).toEqual({ add: [], remove: [] })
  })

  it('deduplicates a desired set that repeats an id', () => {
    expect(diffTags([], ['a', 'a', 'b'])).toEqual({ add: ['a', 'b'], remove: [] })
  })
})

// ---- listWorkspaceTags ----------------------------------------------------

describe('listWorkspaceTags', () => {
  it('reads the WORKSPACE`s tags — a tag belongs to a workspace, not a project', async () => {
    hoistedApi.asanaFetch.mockResolvedValue([{ gid: 't-1', name: 'urgent' }])
    const tags = await listWorkspaceTags('tok', 'aw-1')
    expect(tags).toEqual([{ gid: 't-1', name: 'urgent' }])
    expect(hoistedApi.asanaFetch.mock.calls[0][1]).toContain('/workspaces/aw-1/tags')
  })

  it('returns [] for an empty body rather than throwing', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(null)
    expect(await listWorkspaceTags('tok', 'aw-1')).toEqual([])
  })

  /** The gid is VALIDATED, not encoded — an unvalidated one re-points the request. */
  it('refuses a gid that could re-point the request path', async () => {
    await expect(listWorkspaceTags('tok', '../../users/me')).rejects.toThrow()
    expect(hoistedApi.asanaFetch).not.toHaveBeenCalled()
  })
})

// ---- readAsanaTaskDetails ------------------------------------------------

describe('readAsanaTaskDetails', () => {
  it('returns the normalized lens body in ONE call', async () => {
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({
      ok: true,
      provider: 'asana',
      link_id: 'link-1',
      url: 'https://app.asana.com/0/1/777',
      title: 'Fix the thing',
      editable: ASANA_LENS_EDITABLE,
    })
    // Asana needs no meta probe (no per-task field permissions) and no second read.
    expect(hoistedApi.asanaFetch).toHaveBeenCalledTimes(1)
  })

  /** Asana has no status enum — completion is a boolean, placement is a section. */
  it('reports the completion boolean as the status line', async () => {
    let res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.status_name).toBe('Incomplete')
    hoistedApi.asanaFetch.mockResolvedValue(task({ completed: true }))
    res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.status_name).toBe('Completed')
  })

  it('asks for the nested names Asana omits from the compact form', async () => {
    await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    const path = decodeURIComponent(hoistedApi.asanaFetch.mock.calls[0][1])
    // `assignee` alone yields a gid with no name — each nested name must be named.
    for (const field of ['assignee.name', 'tags.name', 'memberships.section', 'due_on']) {
      expect(path).toContain(field)
    }
  })

  it('scopes the pickers to the config workspace and the TASK`s own project', async () => {
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.option_scope).toEqual({
      workspace_gid: 'aw-1',
      // The task's OWN project (p-1), never the config's (p-config): the sections
      // picker must offer the columns of the project this task actually lives in.
      project_id: 'p-1',
    })
  })

  it('reports not_connected when the workspace has no Asana row', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue(null)
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'not_connected' })
    expect(hoistedApi.asanaFetch).not.toHaveBeenCalled()
  })

  it('reports reconnect_required when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
    expect(hoistedApi.asanaFetch).not.toHaveBeenCalled()
  })

  it('maps a 401 FROM Asana to reconnect_required', async () => {
    hoistedApi.asanaFetch.mockRejectedValue(new FakeUnauthorized())
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
  })

  /**
   * THE TERMINAL READING, and where Asana correctly diverges from the other two: an
   * Asana gid is globally unique and permanent, so a 404 really does mean gone.
   * apply-remote-task-state.ts already stamps task_deleted for exactly this case.
   */
  it('maps a 404 to the TERMINAL task_deleted, not task_missing', async () => {
    hoistedApi.asanaFetch.mockRejectedValue(new FakeApiError(404, 'gone'))
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'task_deleted' })
  })

  it('maps a 429 to provider_error rather than sleeping again', async () => {
    hoistedApi.asanaFetch.mockRejectedValue(new FakeApiError(429, 'slow down'))
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    expect(res.ok === false && res.error).toMatch(/rate limiting/i)
  })

  it('maps a malformed gid to provider_error carrying the field name', async () => {
    hoistedApi.asanaFetch.mockRejectedValue(new FakeInvalidGid('taskGid'))
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    expect(res.ok === false && res.error).toContain('taskGid')
  })

  it('maps any other failure to provider_error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoistedApi.asanaFetch.mockRejectedValue(new FakeApiError(500, 'boom'))
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    errSpy.mockRestore()
  })

  it('treats a 2xx with no task as deleted', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(null)
    const res = await readAsanaTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'task_deleted' })
  })
})

// ---- updateAsanaTaskFields ----------------------------------------------

describe('updateAsanaTaskFields', () => {
  it('PUTs the flat fields and returns the read-back body', async () => {
    const res = await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    const put = calls().find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({ data: { assignee: 'u-2' } })
    expect(res).toMatchObject({ ok: true, provider: 'asana' })
  })

  /** The current-tags read costs a round trip, so it only happens when tags change. */
  it('does NOT read the current tags when label_ids is untouched', async () => {
    await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    // One PUT (which returns the task) and nothing else.
    expect(calls()).toHaveLength(1)
    expect(calls()[0].method).toBe('PUT')
    expect(tagCalls()).toHaveLength(0)
  })

  it('diffs the tags and issues only the changes', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(
      task({ tags: [{ gid: 't-1', name: 'keep' }, { gid: 't-2', name: 'drop' }] }),
    )
    await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { label_ids: ['t-1', 't-3'] },
    })
    const tags = tagCalls()
    expect(tags).toHaveLength(2)
    // Removes first, then adds.
    expect(tags[0].path).toContain('/removeTag')
    expect(tags[0].body).toEqual({ data: { tag: 't-2' } })
    expect(tags[1].path).toContain('/addTag')
    expect(tags[1].body).toEqual({ data: { tag: 't-3' } })
  })

  it('issues NO tag calls when the desired set already matches', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(task({ tags: [{ gid: 't-1', name: 'urgent' }] }))
    await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { label_ids: ['t-1'] },
    })
    expect(tagCalls()).toHaveLength(0)
  })

  it('removes every tag for an empty label_ids — the clear', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(
      task({ tags: [{ gid: 't-1', name: 'a' }, { gid: 't-2', name: 'b' }] }),
    )
    await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { label_ids: [] },
    })
    const tags = tagCalls()
    expect(tags).toHaveLength(2)
    expect(tags.every((c) => c.path.includes('/removeTag'))).toBe(true)
  })

  /** PUTting `{}` would be a wasted round trip that also bumps the modified stamp. */
  it('skips the PUT entirely for a tags-only edit', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(task({ tags: [] }))
    await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { label_ids: ['t-9'] },
    })
    expect(calls().some((c) => c.method === 'PUT')).toBe(false)
    expect(tagCalls()).toHaveLength(1)
  })

  /**
   * The PUT's response predates the tag calls, so it is discarded and the task
   * re-read — reconciling against a body that lacks the tags just added would flash
   * them away and back.
   */
  it('re-reads AFTER the tag calls rather than trusting the PUT response', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(task({ tags: [] }))
    await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2', label_ids: ['t-9'] },
    })
    const sequence = calls().map((c) => `${c.method} ${c.path.includes('Tag') ? 'tag' : 'task'}`)
    expect(sequence[0]).toBe('GET task') // current tags
    expect(sequence[1]).toBe('PUT task')
    expect(sequence[2]).toBe('POST tag')
    expect(sequence[3]).toBe('GET task') // read-back, after the tags landed
  })

  it('combines a flat-field edit and a tag edit in one call', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(task({ tags: [] }))
    const res = await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: null, due_date: '2026-12-01', label_ids: ['t-9'] },
    })
    const put = calls().find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({ data: { assignee: null, due_on: '2026-12-01' } })
    expect(tagCalls()).toHaveLength(1)
    expect(res.ok).toBe(true)
  })

  it('reports task_deleted when the pre-diff read finds nothing', async () => {
    hoistedApi.asanaFetch.mockResolvedValue(null)
    const res = await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { label_ids: ['t-1'] },
    })
    expect(res).toMatchObject({ ok: false, code: 'task_deleted' })
  })

  it('maps a 404 during the write to task_deleted', async () => {
    hoistedApi.asanaFetch.mockRejectedValue(new FakeApiError(404, 'gone'))
    const res = await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'task_deleted' })
  })

  it('maps a 401 during the write to reconnect_required', async () => {
    hoistedApi.asanaFetch.mockRejectedValue(new FakeUnauthorized())
    const res = await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
  })

  it('does not write when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await updateAsanaTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'u-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
    expect(hoistedApi.asanaFetch).not.toHaveBeenCalled()
  })
})
