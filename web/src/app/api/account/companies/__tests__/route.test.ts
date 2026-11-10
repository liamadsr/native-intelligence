/**
 * Tests for GET /api/account/companies.
 *
 * Pins the one argument that silently broke this route for months: the
 * list_companies_with_stats RPC is a SECURITY DEFINER function called on the
 * SERVICE client (migration 193 revoked it from `authenticated`), where
 * auth.uid() is NULL. Its contact-visibility fence therefore needs the
 * requester passed EXPLICITLY as p_user_id (migration 236) — without it the
 * RPC returned zero rows for every user, and every consumer (the chat
 * @-mention picker, the contact panel's company dropdown, the create dialog)
 * rendered an empty list with no error.
 *
 * Same integration-test pattern as api/account/contacts/__tests__/route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
  }),
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ rpc: hoisted.rpc }),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

const { GET } = await import('@/app/api/account/companies/route')

function getReq(params: Record<string, string> = {}): NextRequest {
  const url = new URL('https://nativeintelligence.dev/api/account/companies')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const req = buildRequest({ url: url.toString(), method: 'GET' })
  Object.defineProperty(req, 'nextUrl', { value: url, writable: false })
  return req as unknown as NextRequest
}

describe('GET /api/account/companies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
    hoisted.rpc.mockResolvedValue({ data: [{ id: 'co-1', name: 'Ledgerline' }], error: null })
  })

  it('passes the server-verified user to the RPC as p_user_id', async () => {
    const res = await GET(getReq({ limit: '5', search: 'pw' }))
    expect(res.status).toBe(200)

    expect(hoisted.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = hoisted.rpc.mock.calls[0]
    expect(fn).toBe('list_companies_with_stats')
    expect(args).toMatchObject({
      p_workspace_id: 'ws-1',
      p_search: 'pw',
      p_limit: 5,
      p_offset: 0,
      // The load-bearing assertion: on the service client auth.uid() is NULL,
      // so omitting this returns zero rows for everyone.
      p_user_id: 'user-1',
    })
  })

  it('returns the RPC rows under `companies`', async () => {
    const res = await GET(getReq())
    const body = await res.json()
    expect(body).toEqual({ companies: [{ id: 'co-1', name: 'Ledgerline' }] })
  })

  it('passes a null search when none is given', async () => {
    await GET(getReq({ limit: '5' }))
    expect(hoisted.rpc.mock.calls[0][1]).toMatchObject({ p_search: null, p_user_id: 'user-1' })
  })

  it('401s without a user and never calls the RPC', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('surfaces an RPC error as 500', async () => {
    hoisted.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await GET(getReq())
    expect(res.status).toBe(500)
  })
})
