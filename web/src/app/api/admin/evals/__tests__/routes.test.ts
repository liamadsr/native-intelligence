/**
 * The evals flywheel's admin API (/admin/evals):
 *  - every route needs an admin (requireAdmin), and writes nothing otherwise;
 *  - GET candidates filters by status and source (unknown values are 400s,
 *    `all` is no filter), newest first, with workspace names, emails and the
 *    per-source counts;
 *  - PATCH promotes only with a case that passes validateCaseDraft, stores it
 *    as validated, stamps the reviewer, is fenced on the status it read, and
 *    reopens (or promotes again) an exported row, never dismisses one;
 *  - GET export returns the promoted, unexported cases as FlywheelCase[] and
 *    marks nothing; POST export marks exactly the given ids exported, only
 *    while promoted, and validates them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ requireAdmin: vi.fn() }))

type Call = { table: string; op: string; args: unknown[] }
let calls: Call[]
/** What each terminal read resolves to, by table and operation. */
let listResult: { data: unknown; error: { message: string } | null }
let countResult: number
let existingRow: { id: string; status: string } | null
let updateResult: { data: unknown; error: { message: string } | null }
let markResult: { data: unknown; error: { message: string } | null }
let exportRows: unknown[]

function makeSupabase() {
  return {
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: `${id}@example.com` } } }),
      },
    },
    from(table: string) {
      let op = 'select'
      let head = false
      const record = (name: string, args: unknown[]) => calls.push({ table, op: name, args })
      const chain: Record<string, unknown> = {}
      for (const name of ['eq', 'neq', 'is', 'in', 'order', 'limit']) {
        chain[name] = (...args: unknown[]) => {
          record(name, args)
          return chain
        }
      }
      chain.select = (...args: unknown[]) => {
        record('select', args)
        head = (args[1] as { head?: boolean } | undefined)?.head === true
        return chain
      }
      chain.update = (vals: unknown) => {
        op = 'update'
        record('update', [vals])
        return chain
      }
      chain.maybeSingle = async () => (op === 'update' ? updateResult : { data: existingRow, error: null })
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (op === 'update') return Promise.resolve(markResult).then(resolve)
        if (head) return Promise.resolve({ count: countResult, error: null }).then(resolve)
        const isExport = calls.some((c) => c.op === 'is')
        return Promise.resolve(isExport ? { data: exportRows, error: null } : listResult).then(resolve)
      }
      return chain
    },
  }
}

vi.mock('@/lib/admin', () => ({
  requireAdmin: hoisted.requireAdmin,
  getAdminServiceClient: async () => makeSupabase(),
}))

const { GET: listCandidates } = await import('../candidates/route')
const { PATCH } = await import('../candidates/[id]/route')
const { GET: exportCases, POST: markExported } = await import('../export/route')

const ctx = { params: Promise.resolve({ id: 'cand-1' }) }
const P1 = 'd1000000-0000-4000-8000-000000000001'
const P2 = 'd1000000-0000-4000-8000-000000000002'
const patch = (body: unknown) =>
  PATCH(new Request('https://nativeintelligence.dev/api/admin/evals/candidates/cand-1', { method: 'PATCH', body: JSON.stringify(body) }), ctx)

const validDraft = {
  skill: 'meeting-prep',
  case: { request: 'Prep me for my 3pm', loads: ['meeting-prep'], tools: ['get_meeting_prep'], noToolErrors: true },
}

beforeEach(() => {
  calls = []
  hoisted.requireAdmin.mockReset()
  hoisted.requireAdmin.mockResolvedValue({ id: 'admin-1', email: 'a@dial8.ai' })
  listResult = {
    data: [
      { id: 'c2', user_id: 'u1', workspace_id: 'w1', source: 'thumbs_down', workspace: { name: 'Acme' } },
      { id: 'c1', user_id: 'u2', workspace_id: 'w2', source: 'loop_failed', workspace: null },
    ],
    error: null,
  }
  countResult = 3
  existingRow = { id: 'cand-1', status: 'new' }
  updateResult = { data: { id: 'cand-1', status: 'promoted' }, error: null }
  markResult = { data: [], error: null }
  exportRows = []
})

describe('admin required', () => {
  it('401s every route for a non-admin, and writes nothing', async () => {
    hoisted.requireAdmin.mockRejectedValue(new Response('no', { status: 401 }))
    expect((await listCandidates(new Request('https://nativeintelligence.dev/api/admin/evals/candidates'))).status).toBe(401)
    expect((await patch({ status: 'dismissed' })).status).toBe(401)
    expect((await exportCases()).status).toBe(401)
    expect((await markExported(new Request('https://nativeintelligence.dev/api/admin/evals/export', { method: 'POST', body: JSON.stringify({ candidateIds: [P1] }) }))).status).toBe(401)
    expect(calls).toEqual([])
  })
})

describe('GET /api/admin/evals/candidates', () => {
  it('filters by status and source, newest first, joined and counted', async () => {
    const res = await listCandidates(new Request('https://nativeintelligence.dev/api/admin/evals/candidates?status=new&source=thumbs_down&limit=50'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const listEqs = calls.filter((c) => c.op === 'eq').map((c) => c.args)
    expect(listEqs).toContainEqual(['status', 'new'])
    expect(listEqs).toContainEqual(['source', 'thumbs_down'])
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'order', args: ['created_at', { ascending: false }] })
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'limit', args: [50] })
    expect(body.candidates[0]).toMatchObject({ id: 'c2', workspace_name: 'Acme', user_email: 'u1@example.com' })
    expect(body.candidates[0]).not.toHaveProperty('workspace')
    expect(body.candidates[1].workspace_name).toBeUndefined()
    expect(body.counts).toEqual({ thumbs_down: 3, thumbs_up: 3, repeated_failure: 3, input_invalid: 3, draft_rewrite: 3, loop_failed: 3, draft_dismissed: 3 })
  })

  it('treats `all` as no filter and clamps the limit', async () => {
    await listCandidates(new Request('https://nativeintelligence.dev/api/admin/evals/candidates?status=all&source=all&limit=99999'))
    expect(calls.filter((c) => c.op === 'eq' && (c.args[0] === 'status'))).toEqual([])
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'limit', args: [500] })
  })

  it('400s an unknown status or source', async () => {
    expect((await listCandidates(new Request('https://nativeintelligence.dev/api/admin/evals/candidates?status=bogus'))).status).toBe(400)
    expect((await listCandidates(new Request('https://nativeintelligence.dev/api/admin/evals/candidates?source=bogus'))).status).toBe(400)
  })
})

describe('PATCH /api/admin/evals/candidates/[id]', () => {
  const updates = () => calls.filter((c) => c.op === 'update').map((c) => c.args[0] as Record<string, unknown>)

  it('dismisses and stamps the reviewer', async () => {
    expect((await patch({ status: 'dismissed' })).status).toBe(200)
    expect(updates()[0]).toMatchObject({ status: 'dismissed', reviewed_by: 'admin-1' })
    expect(typeof updates()[0].reviewed_at).toBe('string')
    expect(updates()[0]).not.toHaveProperty('case_draft')
  })

  it('reopens', async () => {
    existingRow = { id: 'cand-1', status: 'dismissed' }
    expect((await patch({ status: 'new' })).status).toBe(200)
    expect(updates()[0]).toMatchObject({ status: 'new', reviewed_by: 'admin-1' })
  })

  it('promoting needs a case that validates', async () => {
    expect((await patch({ status: 'promoted' })).status).toBe(400)
    const bad = await patch({ status: 'promoted', case_draft: { skill: 'Not A Slug', case: { request: '', loads: [], tools: [] } } })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/skill|request/)
    const extra = await patch({ status: 'promoted', case_draft: { ...validDraft, case: { ...validDraft.case, surprise: 1 } } })
    expect(extra.status).toBe(400)
    expect(updates()).toEqual([])
  })

  it('promotes with a valid case, stored as validated', async () => {
    const res = await patch({ status: 'promoted', case_draft: validDraft })
    expect(res.status).toBe(200)
    expect(updates()[0]).toMatchObject({ status: 'promoted', case_draft: validDraft, reviewed_by: 'admin-1' })
    // Fenced on the status it read: an export that marked the row in between wins.
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'eq', args: ['status', 'new'] })
  })

  it('409s when the row changed since the read (the fenced write matched nothing)', async () => {
    updateResult = { data: null, error: null }
    const res = await patch({ status: 'dismissed' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('CONFLICT')
  })

  it('400s an unsettable status', async () => {
    expect((await patch({ status: 'exported' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
  })

  it('404s a missing row', async () => {
    existingRow = null
    expect((await patch({ status: 'dismissed' })).status).toBe(404)
    expect(updates()).toEqual([])
  })

  it('reopens or promotes again an exported row (clearing exported_at), but never dismisses one', async () => {
    existingRow = { id: 'cand-1', status: 'exported' }
    const locked = await patch({ status: 'dismissed' })
    expect(locked.status).toBe(409)
    expect((await locked.json()).code).toBe('LOCKED')
    expect(updates()).toEqual([])

    expect((await patch({ status: 'new' })).status).toBe(200)
    expect(updates()[0]).toMatchObject({ status: 'new', exported_at: null, reviewed_by: 'admin-1' })
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'eq', args: ['status', 'exported'] })

    expect((await patch({ status: 'promoted', case_draft: validDraft })).status).toBe(200)
    expect(updates()[1]).toMatchObject({ status: 'promoted', exported_at: null, case_draft: validDraft })
  })

  it('a dismissal leaves exported_at alone', async () => {
    await patch({ status: 'dismissed' })
    expect(updates()[0]).not.toHaveProperty('exported_at')
  })
})

describe('GET /api/admin/evals/export', () => {
  beforeEach(() => {
    exportRows = [
      { id: 'p1', source: 'input_invalid', polarity: 'bad', case_draft: validDraft, reviewed_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z' },
      // A stored case that no longer validates stays out (and stays promoted).
      { id: 'p2', source: 'thumbs_down', polarity: 'bad', case_draft: { skill: 'x' }, reviewed_at: '2026-10-16T11:00:00Z', updated_at: '2026-10-16T11:00:00Z' },
    ]
  })

  it('downloads the promoted, unexported cases and marks nothing', async () => {
    const res = await exportCases()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="flywheel-cases-\d{4}-\d{2}-\d{2}\.json"$/)
    expect(await res.json()).toEqual([
      { candidateId: 'p1', skill: 'meeting-prep', source: 'input_invalid', polarity: 'bad', promotedAt: '2026-10-16T10:00:00Z', case: validDraft.case },
    ])
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'eq', args: ['status', 'promoted'] })
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'is', args: ['exported_at', null] })
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })
})

describe('POST /api/admin/evals/export', () => {
  const mark = (body: unknown) =>
    markExported(new Request('https://nativeintelligence.dev/api/admin/evals/export', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

  it('marks exactly the given ids exported, only while promoted', async () => {
    markResult = { data: [{ id: P1 }], error: null }
    const res = await mark({ candidateIds: [P1, P2, P1] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ marked: [P1] })
    const update = calls.find((c) => c.op === 'update')!.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'exported' })
    expect(typeof update.exported_at).toBe('string')
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'in', args: ['id', [P1, P2]] })
    expect(calls).toContainEqual({ table: 'eval_candidate', op: 'eq', args: ['status', 'promoted'] })
  })

  it('400s bad ids and writes nothing', async () => {
    expect((await mark('not json')).status).toBe(400)
    expect((await mark({})).status).toBe(400)
    expect((await mark({ candidateIds: [] })).status).toBe(400)
    expect((await mark({ candidateIds: ['p1'] })).status).toBe(400)
    expect((await mark({ candidateIds: [P1, 7] })).status).toBe(400)
    expect((await mark({ candidateIds: Array.from({ length: 501 }, () => P1) })).status).toBe(400)
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('500s a failed write', async () => {
    markResult = { data: null, error: { message: 'down' } }
    expect((await mark({ candidateIds: [P1] })).status).toBe(500)
  })
})
