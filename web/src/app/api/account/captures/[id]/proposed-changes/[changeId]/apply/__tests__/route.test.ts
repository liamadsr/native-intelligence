import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/account/captures/[id]/proposed-changes/[changeId]/apply
 *
 * The thing under test is the CLAIM, not the apply. Accepting a proposal used to
 * be read status → applyChange → write status, which is a check-then-act: two
 * requests for the same row (the card's Accept racing the "Push to…" menu's
 * confirm, two tabs, a retry) both read 'pending' and both create an entity —
 * one proposal, two actions, and only the last writer's result_entity_id
 * recorded. The conditional UPDATE ... WHERE status='pending' is the arbiter, and
 * `.select()` is what makes losing visible (an unguarded update reports success
 * whether or not it matched anything).
 *
 * Which means the row store below has to model the guard for real: an update
 * applies only when EVERY .eq() filter matches the current row, and reports how
 * many rows it touched.
 */

interface Row extends Record<string, unknown> {
  id: string
  capture_id: string
  workspace_id: string
  status: string
}

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  applyChange: vi.fn(),
  row: null as (Record<string, unknown> & { id: string }) | null,
  updates: [] as Array<{
    payload: Record<string, unknown>
    filters: Record<string, unknown>
    matched: number
  }>,
  /** Runs right after the route READS the change — models another request
   *  winning the claim in the window between that read and our own write. */
  onChangeRead: null as null | (() => void),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: async () => 'ws-1',
}))

vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: hoisted.applyChange,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      let mode: 'select' | 'update' = 'select'
      let payload: Record<string, unknown> = {}
      let selected = false

      const matches = () => {
        const row = hoisted.row
        if (!row) return false
        return Object.entries(filters).every(([col, val]) => row[col] === val)
      }

      const run = () => {
        if (mode === 'update') {
          const matched = matches()
          if (matched && hoisted.row) Object.assign(hoisted.row, payload)
          hoisted.updates.push({ payload, filters: { ...filters }, matched: matched ? 1 : 0 })
          return {
            data: selected ? (matched ? [{ id: hoisted.row!.id }] : []) : null,
            error: null,
          }
        }
        const hit = matches() ? hoisted.row : null
        if (table === 'proposed_change' && hoisted.onChangeRead) hoisted.onChangeRead()
        return { data: hit, error: null }
      }

      const chain: Record<string, unknown> = {}
      chain.select = () => {
        selected = true
        return chain
      }
      chain.eq = (col: string, val: unknown) => {
        filters[col] = val
        return chain
      }
      chain.maybeSingle = async () =>
        table === 'member' ? { data: { id: 'mem-1' }, error: null } : run()
      chain.update = (next: Record<string, unknown>) => {
        mode = 'update'
        payload = next
        selected = false
        return chain
      }
      // The claim (`update(...).eq(...).select('id')`) is awaited directly.
      chain.then = (resolve: (v: unknown) => unknown) => resolve(run())
      return chain
    },
  }),
}))

const { POST } = await import(
  '@/app/api/account/captures/[id]/proposed-changes/[changeId]/apply/route'
)

const req = new Request(
  'https://nativeintelligence.dev/api/account/captures/cap-1/proposed-changes/pc-1/apply',
  { method: 'POST' },
) as unknown as import('next/server').NextRequest
const params = Promise.resolve({ id: 'cap-1', changeId: 'pc-1' })

function pendingRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'pc-1',
    capture_id: 'cap-1',
    workspace_id: 'ws-1',
    change_type: 'create',
    entity_type: 'action',
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    ...overrides,
  }
}

/** The conditional write that claims the row (the only one filtered on status). */
const claim = () => hoisted.updates.find((u) => u.filters.status === 'pending')

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.applyChange.mockReset()
  hoisted.updates.length = 0
  hoisted.onChangeRead = null
  hoisted.row = pendingRow()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
})

describe('apply route — atomic claim', () => {
  it('claims the row with a status-guarded update BEFORE applying', async () => {
    hoisted.applyChange.mockResolvedValueOnce({ success: true, entity_id: 'act-1' })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)

    // The guard is the whole fix: without `status='pending'` in the WHERE, a
    // second request's write succeeds just as happily as the first's.
    const claimWrite = claim()
    expect(claimWrite).toBeDefined()
    expect(claimWrite!.filters).toMatchObject({ id: 'pc-1', workspace_id: 'ws-1', status: 'pending' })
    expect(claimWrite!.payload).toMatchObject({
      status: 'applied',
      applied_by: 'mem-1',
      error_message: null,
    })
    expect(claimWrite!.payload.applied_at).toEqual(expect.any(String))

    // And it happens first — applyChange runs against a row already owned.
    expect(hoisted.updates[0]).toBe(claimWrite)
  })

  it('a lost race applies NOTHING and reports 409 already_applied', async () => {
    // Another request claims the row in the window between our read and our
    // write — exactly the interleaving the old read-then-write lost.
    hoisted.onChangeRead = () => {
      hoisted.row = pendingRow({ status: 'applied', result_entity_id: 'act-winner' })
      hoisted.onChangeRead = null
    }

    const res = await POST(req, { params })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already accepted', code: 'already_applied' })

    // The point of the 409: no second entity was created.
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(claim()!.matched).toBe(0)
    expect(hoisted.row).toMatchObject({ result_entity_id: 'act-winner' })
  })

  it('two concurrent requests: exactly one applies, the other gets 409', async () => {
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-1' })

    const [a, b] = await Promise.all([POST(req, { params }), POST(req, { params })])
    const statuses = [a.status, b.status].sort()

    expect(statuses).toEqual([200, 409])
    expect(hoisted.applyChange).toHaveBeenCalledTimes(1)
    // Both requests read 'pending'; only one write matched.
    expect(hoisted.updates.filter((u) => u.filters.status === 'pending')).toHaveLength(2)
    expect(
      hoisted.updates.filter((u) => u.filters.status === 'pending' && u.matched === 1),
    ).toHaveLength(1)
  })
})

describe('apply route — success path', () => {
  it('records the created entity and returns it', async () => {
    hoisted.applyChange.mockResolvedValueOnce({ success: true, entity_id: 'act-1' })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      entity_id: 'act-1',
      change: { id: 'pc-1', status: 'applied' },
    })

    // The post-apply write carries only what the claim couldn't know up front.
    const post = hoisted.updates[hoisted.updates.length - 1]
    expect(post.payload).toEqual({ result_entity_id: 'act-1' })
    expect(hoisted.row).toMatchObject({
      status: 'applied',
      applied_by: 'mem-1',
      result_entity_id: 'act-1',
      error_message: null,
    })
  })

  it('persists a normalized change_type and echoes it back', async () => {
    hoisted.row = pendingRow({ change_type: 'assign', entity_type: 'action' })
    hoisted.applyChange.mockResolvedValueOnce({
      success: true,
      entity_id: 'act-2',
      applied_change_type: 'create',
    })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ change: { change_type: 'create' } })
    expect(hoisted.row).toMatchObject({ change_type: 'create', result_entity_id: 'act-2' })
  })

  it('still refuses a row that is no longer pending', async () => {
    hoisted.row = pendingRow({ status: 'applied' })

    const res = await POST(req, { params })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Change is not pending' })
    expect(hoisted.applyChange).not.toHaveBeenCalled()
  })
})

describe('apply route — failed apply is retryable', () => {
  it('hands the claim back so the row can be accepted again', async () => {
    hoisted.applyChange.mockResolvedValueOnce({ success: false, error: 'Team not found' })

    const res = await POST(req, { params })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'Team not found' })

    // The claim is explicitly given back — wedged-as-applied would be the worst
    // outcome: nothing to open, nothing to undo, and every retry answered 409
    // forever. (Asserted on the WRITE, not just the resulting row: the row would
    // read 'pending' either way if the claim never happened.)
    const revert = hoisted.updates[hoisted.updates.length - 1]
    expect(revert.payload).toEqual({
      status: 'pending',
      applied_at: null,
      applied_by: null,
      error_message: 'Team not found',
    })
    expect(hoisted.row).toMatchObject({
      status: 'pending',
      applied_at: null,
      applied_by: null,
      error_message: 'Team not found',
    })
  })

  it('re-stages the row on an MCP token failure too, keeping the 401 envelope', async () => {
    hoisted.applyChange.mockResolvedValueOnce({
      success: false,
      error: 'Asana token expired',
      code: 'MCP_TOKEN_EXPIRED',
    })

    const res = await POST(req, { params })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: 'Asana token expired',
      code: 'MCP_TOKEN_EXPIRED',
    })
    expect(hoisted.updates[hoisted.updates.length - 1].payload).toMatchObject({
      status: 'pending',
      error_message: 'Asana token expired',
    })
    expect(hoisted.row).toMatchObject({ status: 'pending', error_message: 'Asana token expired' })
  })
})
