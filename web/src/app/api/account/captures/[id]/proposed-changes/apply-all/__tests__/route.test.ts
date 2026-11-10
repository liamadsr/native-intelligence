import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/account/captures/[id]/proposed-changes/apply-all.
 *
 * Locks in that the route claims each row before applying it (claim-apply.ts),
 * and persists `applied_change_type` from the apply result — exactly like the
 * single-apply route. Without it, a normalized proposal (e.g. a
 * target-less update:decision applied as create:decision) keeps
 * change_type='update' on its row, so a later retract refuses to delete the
 * created entity (deleteAppliedEntity only deletes 'create' proposals) and
 * orphans it.
 */

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  applyChange: vi.fn(),
  proposedChangeUpdates: [] as Array<Record<string, unknown>>,
  pendingChanges: [] as Array<Record<string, unknown>>,
  /** Models a concurrent Accept winning every claim. */
  claimLost: false,
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
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.order = () => chain
      chain.maybeSingle = async () =>
        table === 'member' ? { data: { id: 'mem-1' }, error: null } : { data: null, error: null }
      // The pending-changes list select is awaited directly.
      let isUpdate = false
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          table !== 'proposed_change'
            ? { data: null, error: null }
            : isUpdate
              ? { data: hoisted.claimLost ? [] : [{ id: 'claimed' }], error: null }
              : { data: hoisted.pendingChanges, error: null },
        )
      chain.update = (payload: Record<string, unknown>) => {
        isUpdate = true
        if (table === 'proposed_change') hoisted.proposedChangeUpdates.push(payload)
        return chain
      }
      return chain
    },
  }),
}))

const { POST } = await import(
  '@/app/api/account/captures/[id]/proposed-changes/apply-all/route'
)

// The route ignores the request body (it types _request: NextRequest but never
// reads it) — a plain Request cast is sufficient for the handler call.
const req = new Request('https://nativeintelligence.dev/api/account/captures/cap-1/proposed-changes/apply-all', {
  method: 'POST',
}) as unknown as import('next/server').NextRequest
const params = Promise.resolve({ id: 'cap-1' })

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.applyChange.mockReset()
  hoisted.proposedChangeUpdates.length = 0
  hoisted.pendingChanges.length = 0
  hoisted.claimLost = false
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
})

describe('POST apply-all — applied_change_type persistence', () => {
  it('persists change_type when applyChange reports a normalization', async () => {
    hoisted.pendingChanges.push({
      id: 'pc-1',
      change_type: 'update',
      entity_type: 'decision',
      entity_id: null,
    })
    hoisted.applyChange.mockResolvedValueOnce({
      success: true,
      entity_id: 'dec-new',
      applied_change_type: 'create',
    })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: 1, failed: 0 })

    // The claim, then what the claim couldn't know.
    expect(hoisted.proposedChangeUpdates).toHaveLength(2)
    expect(hoisted.proposedChangeUpdates[0]).toMatchObject({ status: 'applied' })
    expect(hoisted.proposedChangeUpdates[1]).toMatchObject({
      result_entity_id: 'dec-new',
      change_type: 'create', // the normalization is persisted (retract stays sound)
    })
  })

  it('leaves change_type untouched when there was no normalization', async () => {
    hoisted.pendingChanges.push({
      id: 'pc-2',
      change_type: 'create',
      entity_type: 'action',
      entity_id: null,
    })
    hoisted.applyChange.mockResolvedValueOnce({ success: true, entity_id: 'act-new' })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)

    expect(hoisted.proposedChangeUpdates).toHaveLength(2)
    expect(hoisted.proposedChangeUpdates[0]).toMatchObject({ status: 'applied' })
    expect(hoisted.proposedChangeUpdates[1]).toMatchObject({ result_entity_id: 'act-new' })
    expect(hoisted.proposedChangeUpdates[1]).not.toHaveProperty('change_type')
  })

  it('nulls a stale error_message from a prior failed attempt on successful apply', async () => {
    // Model the exact prod artifact: a proposal that failed a pre-PR-#254 accept
    // (leaving error_message set) and is now retried and applies cleanly. The
    // applied-update must clear the stale error so the card / any query reading
    // error_message on the applied row no longer shows a misleading failure.
    hoisted.pendingChanges.push({
      id: 'pc-3',
      change_type: 'update',
      entity_type: 'decision',
      entity_id: null,
      error_message: 'Unsupported change: update:decision',
    })
    hoisted.applyChange.mockResolvedValueOnce({
      success: true,
      entity_id: 'dec-new',
      applied_change_type: 'create',
    })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: 1, failed: 0 })

    expect(hoisted.proposedChangeUpdates).toHaveLength(2)
    expect(hoisted.proposedChangeUpdates[0]).toMatchObject({
      status: 'applied',
      error_message: null, // the stale failure is cleared by the claim
    })
    expect(hoisted.proposedChangeUpdates[1]).toMatchObject({ result_entity_id: 'dec-new' })
  })
})

describe('POST apply-all — claim before apply', () => {
  it('skips a row another request already claimed, without applying it', async () => {
    hoisted.claimLost = true
    hoisted.pendingChanges.push({ id: 'pc-4', change_type: 'create', entity_type: 'action', entity_id: null })

    const res = await POST(req, { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      applied: 0,
      failed: 0,
      results: [{ id: 'pc-4', status: 'skipped' }],
    })
    expect(hoisted.applyChange).not.toHaveBeenCalled()
  })

  it('hands the claim back when the apply fails', async () => {
    hoisted.pendingChanges.push({ id: 'pc-5', change_type: 'create', entity_type: 'action', entity_id: null })
    hoisted.applyChange.mockResolvedValueOnce({ success: false, error: 'boom' })

    const res = await POST(req, { params })
    expect(await res.json()).toMatchObject({ applied: 0, failed: 1 })
    expect(hoisted.proposedChangeUpdates[1]).toMatchObject({ status: 'pending', error_message: 'boom' })
  })
})
