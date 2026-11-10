import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/admin/signup-invites — the admin-only door past the work-email
 * gate. Must be admin-gated, validate the address, upsert through the shared
 * helper, and never fail the request just because the email did not send
 * (the link still works and the admin can copy it).
 */

const hoisted = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  upsert: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({
  requireAdmin: hoisted.requireAdmin,
  getAdminServiceClient: async () => ({}),
}))

vi.mock('@/lib/admin/signup-invites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/signup-invites')>()
  return {
    ...actual,
    upsertSignupInvite: hoisted.upsert,
    sendSignupInviteEmail: hoisted.send,
  }
})

const { POST } = await import('@/app/api/admin/signup-invites/route')

function req(body: unknown): Request {
  return new Request('https://nativeintelligence.dev/api/admin/signup-invites', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

const invite = {
  id: 'inv-1',
  email: 'jane@gmail.com',
  token: 'a'.repeat(64),
  invited_by: 'admin-1',
  note: null,
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  used_at: null,
  used_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

beforeEach(() => {
  hoisted.requireAdmin.mockReset()
  hoisted.upsert.mockReset()
  hoisted.send.mockReset()
})

describe('POST signup-invites', () => {
  it('401s when not an admin', async () => {
    hoisted.requireAdmin.mockRejectedValueOnce(new Response('no', { status: 401 }))
    const res = await POST(req({ email: 'jane@gmail.com' }))
    expect(res.status).toBe(401)
    expect(hoisted.upsert).not.toHaveBeenCalled()
  })

  it('400s on a missing or malformed address', async () => {
    hoisted.requireAdmin.mockResolvedValue({ id: 'admin-1', email: 'a@dial8.ai' })
    for (const body of [{}, { email: 'nope' }, { email: 'a@b' }, { email: 42 }]) {
      const res = await POST(req(body))
      expect(res.status).toBe(400)
    }
    expect(hoisted.upsert).not.toHaveBeenCalled()
  })

  it('normalises the address, saves, and emails the link', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ id: 'admin-1', email: 'a@dial8.ai' })
    hoisted.upsert.mockResolvedValueOnce({ ok: true, invite, refreshed: false })
    hoisted.send.mockResolvedValueOnce(undefined)
    const res = await POST(req({ email: '  Jane@Gmail.com ', note: '  hi  ' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.email_sent).toBe(true)
    expect(body.url).toContain(`/login?invite=${invite.token}`)
    expect(hoisted.upsert).toHaveBeenCalledWith(expect.anything(), {
      email: 'jane@gmail.com',
      invitedBy: 'admin-1',
      note: 'hi',
      skipPayment: true,
    })
    expect(hoisted.send).toHaveBeenCalledWith(invite)
  })

  it('passes skip_payment=false through (email gate only, card still required)', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ id: 'admin-1', email: 'a@dial8.ai' })
    hoisted.upsert.mockResolvedValueOnce({ ok: true, invite: { ...invite, skip_payment: false }, refreshed: false })
    hoisted.send.mockResolvedValueOnce(undefined)
    const res = await POST(req({ email: 'jane@gmail.com', skip_payment: false }))
    expect(res.status).toBe(201)
    expect(hoisted.upsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ skipPayment: false }))
  })

  it('reports a refresh with 200 and skips email when send=false', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ id: 'admin-1', email: 'a@dial8.ai' })
    hoisted.upsert.mockResolvedValueOnce({ ok: true, invite, refreshed: true })
    const res = await POST(req({ email: 'jane@gmail.com', send: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.refreshed).toBe(true)
    expect(body.email_sent).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('keeps the invite and surfaces the error when the email fails', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ id: 'admin-1', email: 'a@dial8.ai' })
    hoisted.upsert.mockResolvedValueOnce({ ok: true, invite, refreshed: false })
    hoisted.send.mockRejectedValueOnce(new Error('resend down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req({ email: 'jane@gmail.com' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.email_sent).toBe(false)
    expect(body.email_error).toBe('resend down')
    expect(body.url).toBeTruthy()
    spy.mockRestore()
  })

  it('409s when the address already used its invite', async () => {
    hoisted.requireAdmin.mockResolvedValueOnce({ id: 'admin-1', email: 'a@dial8.ai' })
    hoisted.upsert.mockResolvedValueOnce({ ok: false, reason: 'already_used', invite })
    const res = await POST(req({ email: 'jane@gmail.com' }))
    expect(res.status).toBe(409)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})
