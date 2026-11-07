import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JiraCreateMetaField, JiraIssue } from '@/lib/integrations/jira-api'

/**
 * Tests for src/lib/tasks/jira-lens.ts — the Jira half of the property lens.
 *
 * Invariants locked in:
 *  - NORMALIZATION: Jira's plain-string labels become refs with `id === name`;
 *    `duedate` is sliced to a date; `team` and `section` are always null (Jira has
 *    neither); a field with no usable id is dropped rather than rendered.
 *  - EDITMETA IS THE GATE, and ABSENCE MEANS NOT EDITABLE. Editmeta returns only
 *    the fields on THIS issue's edit screen that THIS user may set, so a missing
 *    key is Jira saying a PUT naming it would 400.
 *  - The write RE-CHECKS editmeta before writing, and a blocked field fails
 *    `field_not_editable` with NOTHING written — all-or-nothing, because a partial
 *    write leaves the panel reconciling against a state no gesture produced.
 *  - THE SITE COMES FROM THE LINK ROW's `external_scope`, never the config's
 *    current cloud_id: Jira issue ids are a per-site sequence starting at 10000, so
 *    reading (or EDITING) with the wrong site hits an unrelated issue.
 *  - ERROR TAXONOMY: 401 → reconnect_required; 404 → the RETRYABLE task_missing,
 *    never task_deleted (Jira's 404 is ambiguous between deleted and
 *    not-browsable); 429 → provider_error FAST rather than another sleep.
 */

const hoistedApi = vi.hoisted(() => ({ jiraFetch: vi.fn() }))
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
    jiraFetch: hoistedApi.jiraFetch,
    JiraUnauthorizedError: FakeUnauthorized,
    JiraApiError: FakeApiError,
    isJiraNotFound: (err: unknown) => err instanceof FakeApiError && err.status === 404,
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

const {
  editableFromEditMeta,
  jiraLensFields,
  jiraLensPayload,
  readJiraTaskDetails,
  updateJiraTaskFields,
} = await import('../jira-lens')

const LINK = {
  id: 'link-1',
  external_id: '10042',
  external_scope: 'cloud-abc',
  external_url: 'https://acme.atlassian.net/browse/ENG-42',
  external_title: 'Stored title',
}

/** A full issue as `GET /issue?fields=…` returns it. */
function issue(fields: Record<string, unknown> = {}): JiraIssue {
  return {
    id: '10042',
    key: 'ENG-42',
    fields: {
      summary: 'Fix the thing',
      status: { id: '3', name: 'In Progress' },
      assignee: { accountId: 'acc-1', displayName: 'Jane Lee', emailAddress: 'jane@acme.com' },
      priority: { id: '3', name: 'Medium' },
      duedate: '2026-08-01',
      labels: ['backend', 'urgent'],
      issuetype: { id: '10001', name: 'Task' },
      project: { id: '10000', key: 'ENG', name: 'Engineering' },
      ...fields,
    },
  }
}

/** Editmeta's envelope: `{ fields: { <fieldId>: {…} } }`, same shape as createmeta. */
interface EditMeta {
  fields?: Record<string, JiraCreateMetaField | undefined>
}

/**
 * An editmeta naming exactly these field ids.
 *
 * The VALUES are deliberately empty: presence is the whole test (see
 * editableFromEditMeta), so a fixture that populated `required`/`allowedValues`
 * would imply they matter to the edit gate when they only matter to the create one.
 */
function editMeta(...fieldIds: string[]): EditMeta {
  const fields: Record<string, JiraCreateMetaField> = {}
  for (const id of fieldIds) fields[id] = { fieldId: id }
  return { fields }
}

/** Editmeta with every lens field present — the fully-editable issue. */
const ALL_EDITABLE = editMeta('assignee', 'priority', 'duedate', 'labels')

/**
 * Route jiraFetch by URL so a test can answer the issue read and the editmeta read
 * differently — the read path fires both in parallel.
 */
function routeFetch(handlers: {
  issue?: unknown | (() => unknown)
  editmeta?: unknown | (() => unknown)
  put?: unknown | (() => unknown)
}) {
  hoistedApi.jiraFetch.mockImplementation(
    async (_token: string, _cloudId: string, path: string, init?: RequestInit) => {
      const resolve = (v: unknown) => (typeof v === 'function' ? (v as () => unknown)() : v)
      // KEY PRESENCE, not `??`: a test that stubs `issue: null` is asserting on a
      // 2xx-with-no-issue, and folding that to the default would silently test the
      // happy path instead.
      if (init?.method === 'PUT') return 'put' in handlers ? resolve(handlers.put) : null
      if (path.includes('/editmeta')) {
        return 'editmeta' in handlers ? resolve(handlers.editmeta) : ALL_EDITABLE
      }
      return 'issue' in handlers ? resolve(handlers.issue) : issue()
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: { cloud_id: 'cloud-CONFIG', site_url: 'https://acme.atlassian.net' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({ token: 'tok', accountId: 'acct-1' })
  routeFetch({})
})

// ---- Normalization --------------------------------------------------------

describe('jiraLensFields', () => {
  it('normalizes every field into the lens shape', () => {
    expect(jiraLensFields(issue())).toEqual({
      project: { id: '10000', name: 'Engineering' },
      issue_type: { id: '10001', name: 'Task' },
      team: null,
      section: null,
      assignee: { id: 'acc-1', name: 'Jane Lee' },
      priority: { id: '3', name: 'Medium' },
      due_date: '2026-08-01',
      labels: [
        { id: 'backend', name: 'backend' },
        { id: 'urgent', name: 'urgent' },
      ],
    })
  })

  /**
   * Jira labels are PLAIN STRINGS with no id of any kind. `id === name` is honest
   * rather than a fudge: a Jira label's identity IS its text, and the write submits
   * that same text back.
   */
  it('gives string labels id === name', () => {
    const fields = jiraLensFields(issue({ labels: ['one'] }))
    expect(fields.labels).toEqual([{ id: 'one', name: 'one' }])
  })

  it('drops non-string and blank labels rather than rendering empty chips', () => {
    const fields = jiraLensFields(issue({ labels: ['ok', '', '   ', null, 7] }))
    expect(fields.labels).toEqual([{ id: 'ok', name: 'ok' }])
  })

  it('handles a label field that is not an array at all', () => {
    expect(jiraLensFields(issue({ labels: 'backend' })).labels).toEqual([])
  })

  it('reports nulls for an unassigned, unprioritized, undated issue', () => {
    const fields = jiraLensFields(
      issue({ assignee: null, priority: null, duedate: null, labels: [] }),
    )
    expect(fields.assignee).toBeNull()
    expect(fields.priority).toBeNull()
    expect(fields.due_date).toBeNull()
    expect(fields.labels).toEqual([])
  })

  /** Jira's project analogue above a project is the SITE, not a team. */
  it('always reports team and section as null — Jira has neither', () => {
    const fields = jiraLensFields(issue())
    expect(fields.team).toBeNull()
    expect(fields.section).toBeNull()
  })

  it('falls back to the project KEY when the name is missing', () => {
    const fields = jiraLensFields(issue({ project: { id: '10000', key: 'ENG' } }))
    expect(fields.project).toEqual({ id: '10000', name: 'ENG' })
  })

  it('falls back to the assignee email when displayName is missing', () => {
    const fields = jiraLensFields(
      issue({ assignee: { accountId: 'acc-1', emailAddress: 'jane@acme.com' } }),
    )
    expect(fields.assignee).toEqual({ id: 'acc-1', name: 'jane@acme.com' })
  })

  it('slices a datetime duedate to a date', () => {
    expect(jiraLensFields(issue({ duedate: '2026-08-01T09:00:00Z' })).due_date).toBe('2026-08-01')
  })

  it('survives an issue with no fields object at all', () => {
    const fields = jiraLensFields({ id: '1' })
    expect(fields.assignee).toBeNull()
    expect(fields.labels).toEqual([])
  })
})

// ---- Editmeta gating ------------------------------------------------------

describe('editableFromEditMeta', () => {
  it('marks a field editable when editmeta names it', () => {
    expect(editableFromEditMeta(ALL_EDITABLE)).toEqual({
      assignee: true,
      priority: true,
      due_date: true,
      labels: true,
    })
  })

  /**
   * ABSENCE IS THE WHOLE CONTRACT: editmeta returns only the fields on this
   * issue's edit screen that this user may set, so a missing `duedate` key means a
   * PUT naming duedate would 400.
   */
  it('marks an ABSENT field NOT editable', () => {
    expect(editableFromEditMeta(editMeta('assignee'))).toEqual({
      assignee: true,
      priority: false,
      due_date: false,
      labels: false,
    })
  })

  it('maps due_date to Jira`s `duedate` field id', () => {
    expect(editableFromEditMeta(editMeta('duedate')).due_date).toBe(true)
    // `due_date` is the LENS name; Jira never uses it, so a payload keyed that way
    // must not be read as the field being present.
    expect(editableFromEditMeta(editMeta('due_date')).due_date).toBe(false)
  })

  const NOTHING_EDITABLE: Array<[string, EditMeta | null | undefined]> = [
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an empty field map', editMeta()],
  ]
  it.each(NOTHING_EDITABLE)('reports nothing editable for %s', (_label, meta) => {
    expect(editableFromEditMeta(meta)).toEqual({
      assignee: false,
      priority: false,
      due_date: false,
      labels: false,
    })
  })

  /** `required`/`allowedValues` gate the CREATE panel, not the edit — presence is all. */
  it('ignores required and allowedValues — presence is the whole test', () => {
    expect(
      editableFromEditMeta({
        fields: { priority: { fieldId: 'priority', required: false, allowedValues: [] } },
      }).priority,
    ).toBe(true)
  })
})

// ---- The write payload ----------------------------------------------------

describe('jiraLensPayload', () => {
  it('sets each field Jira`s own way', () => {
    expect(
      jiraLensPayload({
        assignee_id: 'acc-1',
        priority_id: '3',
        due_date: '2026-08-01',
        label_ids: ['a', 'b'],
      }),
    ).toEqual({
      assignee: { accountId: 'acc-1' },
      priority: { id: '3' },
      duedate: '2026-08-01',
      labels: ['a', 'b'],
    })
  })

  /** Explicit nulls must REACH Jira — a `??` here would drop every clear. */
  it('sends explicit nulls for cleared fields', () => {
    expect(
      jiraLensPayload({ assignee_id: null, priority_id: null, due_date: null }),
    ).toEqual({ assignee: null, priority: null, duedate: null })
  })

  it('omits untouched fields entirely', () => {
    expect(jiraLensPayload({ assignee_id: 'acc-1' })).toEqual({
      assignee: { accountId: 'acc-1' },
    })
  })

  /** A plain PUT REPLACES the whole array, which is what full-replacement wants. */
  it('sends an empty labels array as the full-replacement clear', () => {
    expect(jiraLensPayload({ label_ids: [] })).toEqual({ labels: [] })
  })
})

// ---- readJiraTaskDetails -------------------------------------------------

describe('readJiraTaskDetails', () => {
  it('returns the normalized lens body', async () => {
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({
      ok: true,
      provider: 'jira',
      link_id: 'link-1',
      url: 'https://acme.atlassian.net/browse/ENG-42',
      title: 'Fix the thing',
      status_name: 'In Progress',
      editable: { assignee: true, priority: true, due_date: true, labels: true },
    })
  })

  /**
   * THE SITE COMES FROM THE LINK ROW. Jira issue ids are a per-site sequence that
   * all start at 10000, so a workspace that re-pointed its destination would
   * otherwise read a completely unrelated issue sharing the id.
   */
  it('addresses the LINK ROW`s site, not the config`s current cloud_id', async () => {
    await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    for (const call of hoistedApi.jiraFetch.mock.calls) {
      expect(call[1]).toBe('cloud-abc')
    }
  })

  it('falls back to the config cloud_id only when the link has no scope', async () => {
    await readJiraTaskDetails({
      workspaceId: 'ws-1',
      link: { ...LINK, external_scope: null },
    })
    expect(hoistedApi.jiraFetch.mock.calls[0][1]).toBe('cloud-CONFIG')
  })

  it('reports the option scope the pickers need', async () => {
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.option_scope).toEqual({
      cloud_id: 'cloud-abc',
      site_url: 'https://acme.atlassian.net',
      project_id: '10000',
      // assignable-users takes a project KEY, not an id — carried so the panel
      // needn't spend a round trip deriving one from the other.
      project_key: 'ENG',
      issue_type_id: '10001',
    })
  })

  it('rebuilds the url from the LIVE key rather than the stored one', async () => {
    routeFetch({ issue: { ...issue(), key: 'PLAT-9' } })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    // Jira rewrites a key on a project move or a key rename; the stored url is
    // only ever what it was at push time.
    expect(res.ok && res.url).toBe('https://acme.atlassian.net/browse/PLAT-9')
  })

  it('falls back to the stored url when the site url is unknown', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { cloud_id: 'cloud-abc' },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok && res.url).toBe(LINK.external_url)
  })

  /**
   * Editmeta is BEST-EFFORT on the READ: showing the values as uneditable is
   * strictly better than showing nothing when the only thing that failed was the
   * permission probe.
   */
  it('renders a READ-ONLY lens when editmeta fails, rather than no lens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    routeFetch({
      editmeta: () => {
        throw new FakeApiError(403, 'no peeking')
      },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res.ok).toBe(true)
    expect(res.ok && res.editable).toEqual({
      assignee: false,
      priority: false,
      due_date: false,
      labels: false,
    })
    // The VALUES still arrive — that is the point of degrading rather than failing.
    expect(res.ok && res.fields.assignee).toEqual({ id: 'acc-1', name: 'Jane Lee' })
    warn.mockRestore()
  })

  it('asks for every lens field in one read', async () => {
    await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    const path = hoistedApi.jiraFetch.mock.calls.find((c) => !c[2].includes('/editmeta'))![2]
    for (const field of [
      'summary',
      'status',
      'assignee',
      'priority',
      'duedate',
      'labels',
      'issuetype',
      'project',
    ]) {
      expect(decodeURIComponent(path)).toContain(field)
    }
  })

  // ---- Gates --------------------------------------------------------------

  it('reports not_connected when the workspace has no Jira row', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'not_connected' })
    expect(hoistedApi.jiraFetch).not.toHaveBeenCalled()
  })

  it('reports not_configured when neither the link nor the config knows a site', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: {},
    })
    const res = await readJiraTaskDetails({
      workspaceId: 'ws-1',
      link: { ...LINK, external_scope: null },
    })
    expect(res).toMatchObject({ ok: false, code: 'not_configured' })
  })

  it('reports reconnect_required when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
    expect(hoistedApi.jiraFetch).not.toHaveBeenCalled()
  })

  // ---- Error taxonomy -----------------------------------------------------

  it('maps a 401 FROM Jira to reconnect_required', async () => {
    routeFetch({
      issue: () => {
        throw new FakeUnauthorized()
      },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
  })

  /**
   * THE RETRYABLE READING, and the one mapping most worth pinning: Jira answers
   * 404 both for "deleted" and for "you cannot browse it", and does not
   * distinguish them — so a permission scheme edited for an hour must not make the
   * panel say the ticket was deleted. Same stance jira-link-marker.ts takes.
   */
  it('maps a 404 to the RETRYABLE task_missing, never task_deleted', async () => {
    routeFetch({
      issue: () => {
        throw new FakeApiError(404, 'gone')
      },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })

  /**
   * FAST-FAIL. The shared transport already retried 3 times and may have slept up
   * to 60s; a panel is waiting, so the lens surfaces the limit immediately rather
   * than adding another wait on top.
   */
  it('maps a 429 to provider_error rather than sleeping again', async () => {
    routeFetch({
      issue: () => {
        throw new FakeApiError(429, 'rate limited')
      },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    expect(res.ok === false && res.error).toMatch(/rate limiting/i)
  })

  it('maps any other Jira failure to provider_error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    routeFetch({
      issue: () => {
        throw new FakeApiError(500, 'boom')
      },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'provider_error' })
    errSpy.mockRestore()
  })

  it('treats a 2xx with no issue as the retryable miss', async () => {
    routeFetch({ issue: null })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })
})

// ---- What the CLIENT is allowed to see -----------------------------------

/**
 * The failure MESSAGE, as distinct from the failure code.
 *
 * A JiraApiError's `message` is built by the shared transport as
 * `Jira request failed (<status>) <url>[: <body>]`, and that url is the internal
 * gateway form — `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/…`.
 * Returning it to the browser leaks the workspace's cloudId, the host we proxy
 * Atlassian through, and the raw provider error body, none of which a properties
 * panel can act on. So the message is REBUILT, and the raw error goes to the log
 * instead. jira-push made the same call for the create path; these tests keep the
 * lens from drifting back.
 */
describe('jiraLensFailure — the client never sees the gateway url', () => {
  /** A JiraApiError message shaped exactly the way the transport builds one. */
  const GATEWAY_MESSAGE =
    'Jira request failed (500) ' +
    'https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/issue/10042' +
    ': Internal server error'

  async function failedRead(err: Error) {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    routeFetch({
      issue: () => {
        throw err
      },
    })
    const res = await readJiraTaskDetails({ workspaceId: 'ws-1', link: LINK })
    return { res, errSpy }
  }

  it('does not put the gateway url, cloudId or api host in the response', async () => {
    const { res, errSpy } = await failedRead(new FakeApiError(500, GATEWAY_MESSAGE))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).not.toContain('api.atlassian.com')
      expect(res.error).not.toContain('cloud-abc')
      expect(res.error).not.toContain('/rest/api/3/')
      expect(res.error).not.toContain('Internal server error')
    }
    errSpy.mockRestore()
  })

  it('answers a generic, actionable sentence instead', async () => {
    const { res, errSpy } = await failedRead(new FakeApiError(500, GATEWAY_MESSAGE))
    expect(res).toMatchObject({
      ok: false,
      code: 'provider_error',
      error: 'Failed to read the Jira issue — Jira returned an error. Try again in a moment.',
    })
    errSpy.mockRestore()
  })

  /** The detail is not DISCARDED — it moves to where it is useful. */
  it('logs the whole error server-side', async () => {
    const { res, errSpy } = await failedRead(new FakeApiError(500, GATEWAY_MESSAGE))
    expect(res.ok).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[jira-lens]'),
      expect.objectContaining({ message: GATEWAY_MESSAGE }),
    )
    errSpy.mockRestore()
  })

  /**
   * The field KEYS survive, because they are the one actionable token in Jira's
   * error envelope: `customfield_10014` is what a user searches for in their
   * project's field configuration. The localizable SENTENCES do not.
   */
  it('reports the field keys Jira named, without their prose', async () => {
    const { res, errSpy } = await failedRead(
      new FakeApiError(400, GATEWAY_MESSAGE, {
        duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen.",
        customfield_10014: 'Epic Link is required.',
      }),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('duedate')
      expect(res.error).toContain('customfield_10014')
      expect(res.error).not.toContain('appropriate screen')
      expect(res.error).not.toContain('api.atlassian.com')
    }
    errSpy.mockRestore()
  })

  /** A non-JiraApiError (a TypeError off a bad response shape) leaks nothing either. */
  it('does not echo a plain Error`s message', async () => {
    const { res, errSpy } = await failedRead(
      new TypeError("Cannot read properties of undefined (reading 'fields') at /src/lib/…"),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).not.toContain('Cannot read properties')
      expect(res.error).toBe(
        'Failed to read the Jira issue — Jira returned an error. Try again in a moment.',
      )
    }
    errSpy.mockRestore()
  })

  /** The classified codes keep their own hand-written messages, unchanged. */
  it('leaves the 429 and 404 messages alone', async () => {
    const rate = await failedRead(new FakeApiError(429, GATEWAY_MESSAGE))
    expect(rate.res.ok === false && rate.res.error).toMatch(/rate limiting/i)
    rate.errSpy.mockRestore()
    const gone = await failedRead(new FakeApiError(404, GATEWAY_MESSAGE))
    expect(gone.res.ok === false && gone.res.error).toMatch(/could not be read/i)
    gone.errSpy.mockRestore()
  })

  /** Same guarantee on the WRITE path, which is where field errors actually occur. */
  it('sanitizes a failed WRITE too', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    routeFetch({
      put: () => {
        throw new FakeApiError(400, GATEWAY_MESSAGE, { priority: 'Invalid priority id.' })
      },
    })
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { priority_id: '99' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('provider_error')
      expect(res.error).toContain('priority')
      expect(res.error).not.toContain('api.atlassian.com')
      expect(res.error).not.toContain('cloud-abc')
    }
    errSpy.mockRestore()
  })
})

// ---- updateJiraTaskFields ------------------------------------------------

describe('updateJiraTaskFields', () => {
  it('PUTs the fields and returns the READ-BACK body', async () => {
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2' },
    })
    const put = hoistedApi.jiraFetch.mock.calls.find((c) => c[3]?.method === 'PUT')!
    expect(JSON.parse(put[3].body)).toEqual({ fields: { assignee: { accountId: 'acc-2' } } })
    // Jira's PUT answers 204 with no body, so the only way to reconcile the panel
    // against real state is to ask again.
    expect(res).toMatchObject({ ok: true, provider: 'jira', link_id: 'link-1' })
  })

  it('writes to the LINK ROW`s site', async () => {
    await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { due_date: '2026-09-01' },
    })
    const put = hoistedApi.jiraFetch.mock.calls.find((c) => c[3]?.method === 'PUT')!
    expect(put[1]).toBe('cloud-abc')
  })

  /**
   * THE RE-CHECK IS NOT BELT-AND-BRACES. The panel gated its chips on the editmeta
   * it read at mount; between then and now the issue can have changed workflow
   * state, screen scheme or permissions. Without this the failure is a Jira 400
   * naming a field the user can see on screen.
   */
  it('refuses a field editmeta no longer allows, with NOTHING written', async () => {
    routeFetch({ editmeta: editMeta('assignee') })
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { due_date: '2026-09-01' },
    })
    expect(res).toMatchObject({ ok: false, code: 'field_not_editable' })
    expect(res.ok === false && res.error).toContain('due_date')
    expect(hoistedApi.jiraFetch.mock.calls.some((c) => c[3]?.method === 'PUT')).toBe(false)
  })

  /** ALL-OR-NOTHING: a partial write leaves the panel reconciling against nothing. */
  it('refuses the WHOLE update when only one touched field is blocked', async () => {
    routeFetch({ editmeta: editMeta('assignee', 'duedate') })
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2', priority_id: '1' },
    })
    expect(res).toMatchObject({ ok: false, code: 'field_not_editable' })
    expect(res.ok === false && res.error).toContain('priority')
    expect(hoistedApi.jiraFetch.mock.calls.some((c) => c[3]?.method === 'PUT')).toBe(false)
  })

  it('names EVERY blocked field, not just the first', async () => {
    routeFetch({ editmeta: editMeta() })
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2', due_date: null, label_ids: [] },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('assignee')
      expect(res.error).toContain('due_date')
      expect(res.error).toContain('labels')
    }
  })

  it('allows a CLEAR of an editable field', async () => {
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: null },
    })
    const put = hoistedApi.jiraFetch.mock.calls.find((c) => c[3]?.method === 'PUT')!
    expect(JSON.parse(put[3].body)).toEqual({ fields: { assignee: null } })
    expect(res.ok).toBe(true)
  })

  /**
   * The POST-WRITE editmeta, not the pre-write one: a Jira workflow can lock
   * fields on transition, so reporting the stale set would leave the panel
   * offering a chip the next write would refuse.
   */
  it('reports the POST-WRITE editable set', async () => {
    let seenPut = false
    hoistedApi.jiraFetch.mockImplementation(
      async (_t: string, _c: string, path: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          seenPut = true
          return null
        }
        if (path.includes('/editmeta')) {
          return seenPut ? editMeta('assignee') : ALL_EDITABLE
        }
        return issue()
      },
    )
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2' },
    })
    expect(res.ok && res.editable).toEqual({
      assignee: true,
      priority: false,
      due_date: false,
      labels: false,
    })
  })

  it('maps a 401 during the write to reconnect_required', async () => {
    routeFetch({
      put: () => {
        throw new FakeUnauthorized()
      },
    })
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
  })

  it('maps a 404 during the write to task_missing', async () => {
    routeFetch({
      put: () => {
        throw new FakeApiError(404, 'gone')
      },
    })
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })

  it('reports task_missing when the write lands but the read-back is empty', async () => {
    let seenPut = false
    hoistedApi.jiraFetch.mockImplementation(
      async (_t: string, _c: string, path: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          seenPut = true
          return null
        }
        if (path.includes('/editmeta')) return ALL_EDITABLE
        return seenPut ? null : issue()
      },
    )
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'task_missing' })
  })

  it('does not write when the token cannot be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await updateJiraTaskFields({
      workspaceId: 'ws-1',
      link: LINK,
      update: { assignee_id: 'acc-2' },
    })
    expect(res).toMatchObject({ ok: false, code: 'reconnect_required' })
    expect(hoistedApi.jiraFetch).not.toHaveBeenCalled()
  })
})
