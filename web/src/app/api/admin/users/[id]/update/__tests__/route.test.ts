import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/admin/users/[id]/update: ban handling. In GoTrue
 * `ban_duration: 'none'` LIFTS a ban, so a ban needs a real duration, and the
 * admin panel sends `ban` on every save, so an unchanged flag must not touch
 * ban_duration at all.
 */

const hoisted = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  updateUserById: vi.fn(),
  getUserById: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({
  requireAdmin: hoisted.requireAdmin,
  getAdminServiceClient: async () => ({
    auth: { admin: { updateUserById: hoisted.updateUserById, getUserById: hoisted.getUserById } },
  }),
}))

const { POST } = await import('@/app/api/admin/users/[id]/update/route')

function req(body: unknown): Request {
  return new Request('https://dial8.ai/api/admin/users/u2/update', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
const ctx = { params: Promise.resolve({ id: 'u2' }) }
const future = new Date(Date.now() + 86_400_000).toISOString()

function userWith(banned_until: string | null) {
  return { data: { user: { id: 'u2', banned_until } }, error: null }
}

beforeEach(() => {
  hoisted.requireAdmin.mockReset().mockResolvedValue({ email: 'a@dial8.ai' })
  hoisted.updateUserById.mockReset().mockResolvedValue({ error: null })
  hoisted.getUserById.mockReset()
})

describe('POST admin user update: ban', () => {
  it('bans with a real long duration, not "none"', async () => {
    hoisted.getUserById.mockResolvedValue(userWith(null))
    const res = await POST(req({ ban: true }), ctx)
    expect(res.status).toBe(200)
    expect(hoisted.updateUserById).toHaveBeenCalledWith('u2', { ban_duration: '876000h' })
  })

  it('unbans with "none"', async () => {
    hoisted.getUserById.mockResolvedValue(userWith(future))
    await POST(req({ ban: false }), ctx)
    expect(hoisted.updateUserById).toHaveBeenCalledWith('u2', { ban_duration: 'none' })
  })

  it('leaves an existing ban alone on an unrelated save', async () => {
    hoisted.getUserById.mockResolvedValue(userWith(future))
    const res = await POST(req({ user_metadata: { admin_notes: 'hi' }, ban: true }), ctx)
    expect(res.status).toBe(200)
    expect(hoisted.updateUserById).toHaveBeenCalledWith('u2', { user_metadata: { admin_notes: 'hi' } })
  })
})
