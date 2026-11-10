import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/admin/users/[id]/grant-credits.
 *
 * After the billing rework this route writes the Postgres wallet via the
 * grant_credits RPC (no Stripe object). It must be admin-gated, validate the
 * amount, and pass a fresh idempotency key.
 */

const hoisted = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({
  requireAdmin: hoisted.requireAdmin,
  getAdminServiceClient: async () => ({ rpc: hoisted.rpc }),
}))

const { POST } = await import('@/app/api/admin/users/[id]/grant-credits/route')

function req(body: unknown): Request {
  return new Request('https://nativeintelligence.dev/api/admin/users/u2/grant-credits', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
const ctx = { params: Promise.resolve({ id: 'u2' }) }

beforeEach(() => {
  hoisted.requireAdmin.mockReset()
  hoisted.rpc.mockReset()
})

describe('POST grant-credits', () => {
  it('401s when not an admin', async () => {
    hoisted.requireAdmin.mockRejectedValueOnce(new Response('no', { status: 401 }))
    const res = await POST(req({ amount_usd: 10 }), ctx)
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('400s on a non-positive amount', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ email: 'a@dial8.ai' })
    const res = await POST(req({ amount_usd: 0 }), ctx)
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('grants via the grant_credits RPC with a fresh admin idempotency key', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ email: 'a@dial8.ai' })
    hoisted.rpc.mockResolvedValueOnce({ data: [{ applied: true, new_balance_usd: 10 }], error: null })
    const res = await POST(req({ amount_usd: 10, reason: 'goodwill' }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.new_balance_usd).toBe(10)
    expect(hoisted.rpc).toHaveBeenCalledWith('grant_credits', expect.objectContaining({
      p_user_id: 'u2',
      p_amount_usd: 10,
      p_kind: 'admin_grant',
    }))
    const call = hoisted.rpc.mock.calls[0][1]
    expect(String(call.p_idempotency_key)).toMatch(/^admin-/)
  })

  it('500s when the RPC errors', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ email: 'a@dial8.ai' })
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req({ amount_usd: 5 }), ctx)
    expect(res.status).toBe(500)
    spy.mockRestore()
  })
})
