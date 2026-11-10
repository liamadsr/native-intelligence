/**
 * POST /api/account/workspace/merge/preflight: the gate (session, owner of
 * both, the destination pinned), the exact RPC call (service client, actor
 * passed), and the errcode mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SRC = '11111111-1111-4111-8111-111111111111'
const DST = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: hoisted.requireWorkspaceMember }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    rpc: hoisted.rpc,
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: hoisted.maybeSingle }) }) }) }),
  }),
}))

import { POST } from '../route'

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/workspace/merge/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const PLAN = { teams: [{ source_team_id: 't1', mode: 'own' }] }
const RESULT = { ok: true, blockers: [], source: { id: SRC, name: 'Coherix' }, destination: { id: DST, name: 'Native Intelligence' }, plan: PLAN }
const GOOD = { source_workspace_id: SRC, destination_workspace_id: DST }

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset().mockResolvedValue({
    supabase: {},
    user: { id: USER },
    workspaceId: DST,
    member: { id: 'm-dst', role: 'owner' },
  })
  hoisted.maybeSingle.mockReset().mockResolvedValue({ data: { id: 'm-src', role: 'owner' }, error: null })
  hoisted.rpc.mockReset().mockResolvedValue({ data: RESULT, error: null })
})

describe('POST /api/account/workspace/merge/preflight', () => {
  it('passes an auth refusal straight through', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(new Response(null, { status: 401 }))
    expect((await POST(req(GOOD))).status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('a device token may not even look (it could read the name it would have to type)', async () => {
    const res = await POST(req(GOOD, { authorization: 'Bearer nid_devicetoken' }))
    expect(res.status).toBe(403)
    expect(hoisted.requireWorkspaceMember).not.toHaveBeenCalled()
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('rejects a body that is not JSON or a plan that is not an object', async () => {
    expect((await POST(req('{nope'))).status).toBe(400)
    expect((await POST(req({ ...GOOD, plan: [] }))).status).toBe(400)
    expect((await POST(req({ ...GOOD, plan: null }))).status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('the destination must be the one this request resolved to', async () => {
    const res = await POST(req({ source_workspace_id: SRC, destination_workspace_id: '44444444-4444-4444-8444-444444444444' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'DESTINATION_MISMATCH' })
    expect((await POST(req({ source_workspace_id: SRC }))).status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('a destination admin may not even look', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce({ supabase: {}, user: { id: USER }, workspaceId: DST, member: { id: 'm', role: 'admin' } })
    expect((await POST(req(GOOD))).status).toBe(403)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('a source the caller is not in is not found', async () => {
    hoisted.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    expect((await POST(req(GOOD))).status).toBe(404)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('calls merge_workspace_preflight as the service with the actor, no plan → null, and returns its answer', async () => {
    const res = await POST(req(GOOD))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(RESULT)
    expect(hoisted.rpc).toHaveBeenCalledWith('merge_workspace_preflight', { p_source: SRC, p_destination: DST, p_actor: USER, p_plan: null })
  })

  it('forwards the person’s edited plan', async () => {
    await POST(req({ ...GOOD, plan: PLAN }))
    expect(hoisted.rpc).toHaveBeenCalledWith('merge_workspace_preflight', expect.objectContaining({ p_plan: PLAN }))
  })

  it('maps the engine’s refusals: busy and drift are 409s with a code, an invalid plan says why, a stale cache is a 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0007', message: `workspace ${SRC} is busy` } })
    let res = await POST(req(GOOD))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'SOURCE_BUSY' })

    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0009', message: 'drift' } })
    res = await POST(req(GOOD))
    expect(await res.json()).toMatchObject({ code: 'DRIFT' })

    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0006', message: 'team slug "eng" is already taken in the destination' } })
    res = await POST(req(GOOD))
    expect(await res.json()).toMatchObject({ code: 'PLAN_INVALID', details: { reason: 'team slug "eng" is already taken in the destination' } })

    hoisted.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.merge_workspace_preflight in the schema cache' },
    })
    res = await POST(req(GOOD))
    expect(res.status).toBe(503)
  })
})
