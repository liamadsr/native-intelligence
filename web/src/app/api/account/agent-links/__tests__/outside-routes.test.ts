/**
 * The outside-workspace routes of agent links (phase E): redeeming a connect
 * link, and the workspaces that could answer. Each acts for the signed-in
 * user only and words the store's refusals as the /link page reads them.
 * outside.ts is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const outside = vi.hoisted(() => ({
  redeemConnectToken: vi.fn(),
  listAnswerWorkspaces: vi.fn(),
}))
const USER = { id: 'u-dana', email: 'dana@northwind.com', email_confirmed_at: '2026-10-25T00:00:00Z' }
vi.mock('@/lib/api-auth', () => ({ requireUser: async () => ({ supabase: {}, user: USER }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/agent-links/outside', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-links/outside')>('@/lib/agent-links/outside')
  return { ...actual, ...outside }
})

const redeem = await import('../redeem/route')
const workspaces = await import('../answer-workspaces/route')
const TOKEN = 'A'.repeat(32)
const post = (body: unknown) => new Request('https://nativeintelligence.dev/api/account/agent-links/redeem', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  outside.redeemConnectToken.mockReset()
  outside.listAnswerWorkspaces.mockReset()
})

describe('POST /api/account/agent-links/redeem', () => {
  it('binds the request to the signed-in user', async () => {
    outside.redeemConnectToken.mockResolvedValue({ ok: true, linkId: 'l1' })
    const res = await redeem.POST(post({ token: TOKEN }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ linkId: 'l1' })
    expect(outside.redeemConnectToken).toHaveBeenCalledWith({ service: true }, { token: TOKEN, user: USER })
  })

  it('refuses a malformed token without a lookup', async () => {
    const res = await redeem.POST(post({ token: '../x' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('invalid')
    expect(outside.redeemConnectToken).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 404],
    ['self', 400],
    ['wrong_account', 403],
    ['already_linked', 409],
    ['failed', 500],
  ])('words %s as %i', async (reason, status) => {
    outside.redeemConnectToken.mockResolvedValue({ ok: false, reason })
    const res = await redeem.POST(post({ token: TOKEN }))
    expect(res.status).toBe(status)
    if (reason !== 'failed') expect((await res.json()).code).toBe(reason)
  })
})

describe('GET /api/account/agent-links/answer-workspaces', () => {
  it('lists my workspaces with their switch', async () => {
    outside.listAnswerWorkspaces.mockResolvedValue([{ id: 'w1', name: 'Northwind', outsideAllowed: true }])
    const res = await workspaces.GET()
    expect(await res.json()).toEqual({ workspaces: [{ id: 'w1', name: 'Northwind', outsideAllowed: true }] })
    expect(outside.listAnswerWorkspaces).toHaveBeenCalledWith({ service: true }, 'u-dana')
  })

  it('is a 500 when they can’t be read', async () => {
    outside.listAnswerWorkspaces.mockResolvedValue(null)
    expect((await workspaces.GET()).status).toBe(500)
  })
})
