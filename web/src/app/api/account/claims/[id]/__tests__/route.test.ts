/**
 * Tests for PATCH /api/account/claims/[id] — the views system's per-row patch
 * endpoint for claims (ENTITY_ENDPOINTS.claim).
 *
 * What is locked in here is mostly what the route REFUSES. A row editor sends
 * whatever field the cell it rendered is bound to, so the route is the only
 * thing standing between an inline edit and a rewritten extraction output:
 *   - `confirmation` is the sole writable field; anything else is a 400, not a
 *     silent partial update
 *   - the value is checked against the DB's CHECK constraint domain, so a bad
 *     value is a 400 rather than a 500 from Postgres
 *   - confirming stamps last_verified_at; un-confirming does NOT clear it
 *   - the update is workspace-scoped as well as RLS-scoped, and a row that
 *     matches nothing is a 404 rather than a success with a null body
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

/** Captures the chained call so assertions can read the patch and the scoping. */
function supabaseStub() {
  const eqCalls: Array<[string, unknown]> = []
  const builder = {
    update: (patch: Record<string, unknown>) => {
      hoisted.update(patch)
      return builder
    },
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val])
      return builder
    },
    select: () => builder,
    maybeSingle: () => hoisted.maybeSingle(),
  }
  return {
    client: { from: (table: string) => { hoisted.from(table); return builder } },
    eqCalls,
  }
}

function authContext(supabase: unknown, workspaceId = 'ws-1') {
  return { supabase, user: { id: 'user-1' }, workspaceId }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function req(body: unknown, raw?: string) {
  return {
    json: async () => {
      if (raw !== undefined) return JSON.parse(raw)
      return body
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.maybeSingle.mockResolvedValue({
    data: { id: 'c1', confirmation: 'confirmed', last_verified_at: '2026-09-21T00:00:00Z' },
    error: null,
  })
})

describe('PATCH /api/account/claims/[id]', () => {
  it('returns the auth Response untouched when the caller is not authed', async () => {
    const unauthed = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    hoisted.requireWorkspace.mockResolvedValue(unauthed)
    const { PATCH } = await import('@/app/api/account/claims/[id]/route')
    const res = await PATCH(req({ confirmation: 'confirmed' }), params('c1'))
    expect(res.status).toBe(401)
    expect(hoisted.from).not.toHaveBeenCalled()
  })

  it('confirms a claim and stamps last_verified_at', async () => {
    const { client, eqCalls } = supabaseStub()
    hoisted.requireWorkspace.mockResolvedValue(authContext(client))
    const { PATCH } = await import('@/app/api/account/claims/[id]/route')

    const res = await PATCH(req({ confirmation: 'confirmed' }), params('c1'))

    expect(res.status).toBe(200)
    expect(hoisted.from).toHaveBeenCalledWith('claim')
    const patch = hoisted.update.mock.calls[0][0]
    expect(patch.confirmation).toBe('confirmed')
    expect(typeof patch.last_verified_at).toBe('string')
    // Scoped by id AND workspace — a foreign id must match nothing, not 500.
    expect(eqCalls).toEqual([
      ['id', 'c1'],
      ['workspace_id', 'ws-1'],
    ])
  })

  it('does NOT clear last_verified_at when un-confirming', async () => {
    const { client } = supabaseStub()
    hoisted.requireWorkspace.mockResolvedValue(authContext(client))
    const { PATCH } = await import('@/app/api/account/claims/[id]/route')

    await PATCH(req({ confirmation: 'suggested' }), params('c1'))

    const patch = hoisted.update.mock.calls[0][0]
    expect(patch).toEqual({ confirmation: 'suggested' })
    expect('last_verified_at' in patch).toBe(false)
  })

  it.each(['text', 'type', 'confidence', 'status'])(
    'refuses to write %s — extraction output is not a row-editable field',
    async (field) => {
      const { client } = supabaseStub()
      hoisted.requireWorkspace.mockResolvedValue(authContext(client))
      const { PATCH } = await import('@/app/api/account/claims/[id]/route')

      const res = await PATCH(req({ [field]: 'anything' }), params('c1'))

      expect(res.status).toBe(400)
      expect(hoisted.update).not.toHaveBeenCalled()
    },
  )

  it('rejects a confirmation outside the CHECK constraint domain', async () => {
    const { client } = supabaseStub()
    hoisted.requireWorkspace.mockResolvedValue(authContext(client))
    const { PATCH } = await import('@/app/api/account/claims/[id]/route')

    const res = await PATCH(req({ confirmation: 'archived' }), params('c1'))

    expect(res.status).toBe(400)
    expect(hoisted.update).not.toHaveBeenCalled()
  })

  it('404s when the id matches no claim in this workspace', async () => {
    const { client } = supabaseStub()
    hoisted.requireWorkspace.mockResolvedValue(authContext(client))
    hoisted.maybeSingle.mockResolvedValue({ data: null, error: null })
    const { PATCH } = await import('@/app/api/account/claims/[id]/route')

    const res = await PATCH(req({ confirmation: 'confirmed' }), params('other-ws-claim'))

    expect(res.status).toBe(404)
  })

  it('500s on a query error rather than reporting success', async () => {
    const { client } = supabaseStub()
    hoisted.requireWorkspace.mockResolvedValue(authContext(client))
    hoisted.maybeSingle.mockResolvedValue({ data: null, error: { message: 'deadlock detected' } })
    const { PATCH } = await import('@/app/api/account/claims/[id]/route')

    const res = await PATCH(req({ confirmation: 'confirmed' }), params('c1'))

    expect(res.status).toBe(500)
  })
})
