/**
 * Tests for the lens PATCH handler added to all three link routes:
 *   PATCH /api/account/actions/[id]/{asana,jira,linear}/[linkId]
 *
 * One file for the three because the envelope is deliberately identical across
 * them — the panel sends `{ fields: {…} }` to every provider and only the inner
 * shape differs — so a divergence is easiest to see side by side. That is the same
 * reason push-overrides-routes.test.ts covers the three POSTs together.
 *
 * Invariants locked in:
 *  - The pre-existing DELETE is untouched and still answers `{ success: true }`.
 *  - The body is parsed BEFORE the link lookup: a malformed payload is the caller's
 *    to fix either way, and answering it without a database round trip keeps a buggy
 *    panel cheap.
 *  - The link lookup is pinned by linkId AND action AND provider AND workspace_id —
 *    the DELETE handler's `.eq` chain plus the URL's own id segment.
 *  - Asana rejects `priority_id` BY NAME (the field does not exist) while Jira and
 *    Linear accept it.
 *  - The response is the SAME normalized body the GET answers, and the failure
 *    codes map to the same statuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoistedWorkspace = vi.hoisted(() => ({ getCurrentWorkspaceId: vi.fn() }))
vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoistedWorkspace.getCurrentWorkspaceId,
}))

const hoistedLens = vi.hoisted(() => ({
  updateJiraTaskFields: vi.fn(),
  updateAsanaTaskFields: vi.fn(),
  updateLinearTaskFields: vi.fn(),
}))
vi.mock('@/lib/tasks/jira-lens', () => ({
  updateJiraTaskFields: hoistedLens.updateJiraTaskFields,
  readJiraTaskDetails: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-lens', () => ({
  updateAsanaTaskFields: hoistedLens.updateAsanaTaskFields,
  readAsanaTaskDetails: vi.fn(),
}))
vi.mock('@/lib/tasks/linear-lens', () => ({
  updateLinearTaskFields: hoistedLens.updateLinearTaskFields,
  readLinearTaskDetails: vi.fn(),
}))

const LINK_ROW = {
  id: 'link-1',
  external_id: 'ext-1',
  external_scope: null,
  external_url: 'https://x/1',
  external_title: 'Fix the thing',
}

const db = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  link: null as unknown,
  eqs: [] as Array<{ table: string; column: string; value: unknown }>,
  deleteError: null as { message: string } | null,
  deleted: false,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        delete: () => {
          db.deleted = true
          return chain
        },
        eq: (column: string, value: unknown) => {
          db.eqs.push({ table, column, value })
          // The DELETE chain is awaited directly (no maybeSingle), so the last
          // `.eq` in that chain has to be thenable.
          return Object.assign(chain, {
            then: (cb: (v: unknown) => unknown) =>
              Promise.resolve({ error: db.deleteError, data: null }).then(cb),
          })
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: db.link, error: null }),
      }
      return chain
    },
  }),
}))

const jira = await import('../jira/[linkId]/route')
const asana = await import('../asana/[linkId]/route')
const linear = await import('../linear/[linkId]/route')

/** A normalized lens body, as every provider's update function answers. */
function details(provider: string) {
  return {
    ok: true,
    provider,
    link_id: 'link-1',
    url: 'https://x/1',
    title: 'Fix the thing',
    status_name: 'In Progress',
    fields: {
      project: null,
      issue_type: null,
      team: null,
      section: null,
      assignee: { id: 'u-2', name: 'Sam' },
      priority: null,
      due_date: null,
      labels: [],
    },
    editable: { assignee: true, priority: true, due_date: true, labels: true },
    option_scope: {},
  }
}

function patch(body?: unknown): Request {
  return new Request('http://x/api/account/actions/act-1/jira/link-1', {
    method: 'PATCH',
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

function params() {
  return { params: Promise.resolve({ id: 'act-1', linkId: 'link-1' }) }
}

function linkEqs() {
  return db.eqs.filter((e) => e.table === 'action_external_task')
}

const PROVIDERS = [
  { name: 'jira', route: jira, mock: hoistedLens.updateJiraTaskFields },
  { name: 'asana', route: asana, mock: hoistedLens.updateAsanaTaskFields },
  { name: 'linear', route: linear, mock: hoistedLens.updateLinearTaskFields },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  db.eqs = []
  db.user = { id: 'u-1' }
  db.link = LINK_ROW
  db.deleteError = null
  db.deleted = false
  hoistedWorkspace.getCurrentWorkspaceId.mockResolvedValue('ws-1')
  for (const { name, mock } of PROVIDERS) mock.mockResolvedValue(details(name))
})

// ---- The pre-existing DELETE still works --------------------------------

describe.each(PROVIDERS)('DELETE …/$name/[linkId] — unchanged', ({ route }) => {
  it('still unlinks and answers { success: true }', async () => {
    const res = await route.DELETE(patch(), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.deleted).toBe(true)
  })

  it('still 500s on a database error', async () => {
    db.deleteError = { message: 'boom' }
    const res = await route.DELETE(patch(), params())
    expect(res.status).toBe(500)
  })
})

// ---- Auth --------------------------------------------------------------

describe.each(PROVIDERS)('PATCH …/$name/[linkId] — auth', ({ route, mock }) => {
  it('401s with no user', async () => {
    db.user = null
    const res = await route.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    expect(res.status).toBe(401)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s with no workspace', async () => {
    hoistedWorkspace.getCurrentWorkspaceId.mockResolvedValue(null)
    const res = await route.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    expect(res.status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })
})

// ---- Body validation, BEFORE the link lookup ---------------------------

describe.each(PROVIDERS)('PATCH …/$name/[linkId] — body', ({ route, mock }) => {
  it('400s a non-JSON body', async () => {
    const res = await route.PATCH(patch('not json'), params())
    expect(res.status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s a missing body', async () => {
    const res = await route.PATCH(patch(), params())
    expect(res.status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s an empty fields object — a PATCH that changes nothing is a bug', async () => {
    const res = await route.PATCH(patch({ fields: {} }), params())
    expect(res.status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s unknown field keys by NAME rather than dropping them', async () => {
    const res = await route.PATCH(
      patch({ fields: { assignee_account_id: 'acc-1' } }),
      params(),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('assignee_account_id')
    expect(mock).not.toHaveBeenCalled()
  })

  /**
   * The label cap, and the one parse failure that carries a CODE.
   *
   * A code is added only where the panel can act on it, and this is that case: a
   * user who bulk-selected a hundred tags should be told they picked too many, not
   * handed a validation sentence written for a network tab. The cap is enforced at
   * the parser because `label_ids` is the only field whose cost is linear in its own
   * length — Asana's tags are one HTTP call each, issued sequentially — so a
   * 500-tag body must be refused before any of that starts.
   */
  it('400s an oversized label set with the too_many_labels code, writing nothing', async () => {
    const res = await route.PATCH(
      patch({ fields: { label_ids: Array.from({ length: 200 }, (_, i) => `l-${i}`) } }),
      params(),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('too_many_labels')
    expect(body.error).toContain('200')
    expect(mock).not.toHaveBeenCalled()
  })

  /** Every other parse failure stays UNCODED — the body shape is otherwise unchanged. */
  it('leaves an ordinary parse failure without a code', async () => {
    const res = await route.PATCH(patch({ fields: { due_date: 'tomorrow' } }), params())
    expect(res.status).toBe(400)
    expect(await res.json()).not.toHaveProperty('code')
    expect(mock).not.toHaveBeenCalled()
  })

  /** Answering a malformed payload without a database round trip keeps a bug cheap. */
  it('validates the body BEFORE looking the link up', async () => {
    await route.PATCH(patch({ fields: {} }), params())
    expect(linkEqs()).toHaveLength(0)
  })
})

// ---- Provider-specific field rules -------------------------------------

describe('PATCH — priority is provider-specific', () => {
  /** Asana has NO native priority field — rejected by name, not sent and refused. */
  it('rejects priority_id for asana', async () => {
    const res = await asana.PATCH(patch({ fields: { priority_id: '3' } }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Asana has no priority field/)
    expect(hoistedLens.updateAsanaTaskFields).not.toHaveBeenCalled()
  })

  it.each([
    ['jira', jira, hoistedLens.updateJiraTaskFields],
    ['linear', linear, hoistedLens.updateLinearTaskFields],
  ])('accepts priority_id for %s', async (_name, route, mock) => {
    const res = await route.PATCH(patch({ fields: { priority_id: '3' } }), params())
    expect(res.status).toBe(200)
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ update: { priority_id: '3' } }),
    )
  })
})

// ---- Link lookup + dispatch -------------------------------------------

describe.each(PROVIDERS)('PATCH …/$name/[linkId] — dispatch', ({ name, route, mock }) => {
  it('pins the link by linkId AND action AND provider AND workspace', async () => {
    await route.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    expect(linkEqs()).toEqual([
      { table: 'action_external_task', column: 'action_id', value: 'act-1' },
      { table: 'action_external_task', column: 'provider', value: name },
      { table: 'action_external_task', column: 'workspace_id', value: 'ws-1' },
      { table: 'action_external_task', column: 'id', value: 'link-1' },
    ])
  })

  it('404s link_not_found when no row matches', async () => {
    db.link = null
    const res = await route.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('link_not_found')
    expect(mock).not.toHaveBeenCalled()
  })

  it('calls the provider update with the parsed field set and the link row', async () => {
    await route.PATCH(patch({ fields: { assignee_id: 'u-2', due_date: null } }), params())
    expect(mock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      link: LINK_ROW,
      update: { assignee_id: 'u-2', due_date: null },
    })
  })

  /** The read-through: the PATCH body is the same shape the GET answers. */
  it('answers the SAME normalized shape the GET does', async () => {
    const res = await route.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, provider: name, link_id: 'link-1' })
    // The reconciled value the panel writes back into its chip.
    expect(body.fields.assignee).toEqual({ id: 'u-2', name: 'Sam' })
    expect(body.editable).toBeDefined()
    expect(body.option_scope).toBeDefined()
  })
})

// ---- Clearable semantics through the route ----------------------------

describe('PATCH — the three-state reading survives the route', () => {
  it('passes an explicit null through as the CLEAR', async () => {
    await jira.PATCH(patch({ fields: { assignee_id: null } }), params())
    const update = hoistedLens.updateJiraTaskFields.mock.calls[0][0].update
    expect(update).toEqual({ assignee_id: null })
    expect('assignee_id' in update).toBe(true)
  })

  it('omits an untouched field entirely', async () => {
    await jira.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    const update = hoistedLens.updateJiraTaskFields.mock.calls[0][0].update
    expect('due_date' in update).toBe(false)
    expect('label_ids' in update).toBe(false)
  })

  it('passes an empty label_ids array through as the label clear', async () => {
    await linear.PATCH(patch({ fields: { label_ids: [] } }), params())
    expect(hoistedLens.updateLinearTaskFields.mock.calls[0][0].update).toEqual({
      label_ids: [],
    })
  })
})

// ---- Failure codes -----------------------------------------------------

describe.each(PROVIDERS)('PATCH …/$name/[linkId] — error taxonomy', ({ route, mock }) => {
  it.each([
    ['reconnect_required', 400],
    ['not_connected', 400],
    ['not_configured', 400],
    ['field_not_editable', 400],
    ['task_missing', 404],
    ['task_deleted', 404],
    ['provider_error', 502],
  ])('maps %s to %i with the code preserved', async (code, status) => {
    mock.mockResolvedValue({ ok: false, code, error: 'nope' })
    const res = await route.PATCH(patch({ fields: { assignee_id: 'u-2' } }), params())
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
  })
})
