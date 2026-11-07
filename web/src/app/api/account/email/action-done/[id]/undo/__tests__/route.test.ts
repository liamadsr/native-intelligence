/**
 * POST /api/account/email/action-done/[id]/undo: the Undo on a to-do mail
 * marked done. Workspace auth first; the close is undone for the caller in
 * their workspace (never one the URL alone names); one they don't have is a
 * 404; before migration 450 a 503.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => auth.result }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
const done = vi.hoisted(() => ({ undoActionDoneFromMail: vi.fn() }))
vi.mock('@/lib/email/action-done-from-mail', () => ({ undoActionDoneFromMail: done.undoActionDoneFromMail }))

const { POST } = await import('../route')

const ID = '0f8a2c9e-1b2c-4d5e-8f90-123456789abc'
const call = (id = ID) => POST(new Request(`http://x/api/account/email/action-done/${id}/undo`, { method: 'POST' }) as unknown as NextRequest, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { user: { id: 'user-1' }, workspaceId: 'ws-1', supabase: {} }
})

describe('POST /api/account/email/action-done/[id]/undo', () => {
  it('undoes the caller’s close in their workspace, and says what happened', async () => {
    for (const status of ['reopened', 'changed', 'gone', 'already']) {
      done.undoActionDoneFromMail.mockResolvedValueOnce({ ok: true, status })
      const res = await call()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status })
    }
    expect(done.undoActionDoneFromMail).toHaveBeenCalledWith({ service: true }, { workspaceId: 'ws-1', userId: 'user-1', recordId: ID })
  })

  it('not theirs: 404; not set up: 503; a failed read: 500; a bad id: 400', async () => {
    done.undoActionDoneFromMail.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await call()).status).toBe(404)
    done.undoActionDoneFromMail.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect((await call()).status).toBe(503)
    done.undoActionDoneFromMail.mockResolvedValueOnce({ ok: false, reason: 'read_failed' })
    expect((await call()).status).toBe(500)
    expect((await call('not-a-uuid')).status).toBe(400)
  })

  it('signed out: the auth response, nothing undone', async () => {
    auth.result = new Response('no', { status: 401 })
    expect((await call()).status).toBe(401)
    expect(done.undoActionDoneFromMail).not.toHaveBeenCalled()
  })
})
