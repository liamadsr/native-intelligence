/**
 * POST /api/account/email/auto-archive/[id]/undo: the Undo on the morning
 * tidy's message. Workspace auth first; the batch is undone for the caller in
 * their workspace (never one the URL alone names); a batch they don't have is
 * a 404; before migration 446 a 503.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => auth.result }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
const tidy = vi.hoisted(() => ({ undoAutoArchive: vi.fn() }))
vi.mock('@/lib/email/auto-archive', () => ({ undoAutoArchive: tidy.undoAutoArchive }))

const { POST } = await import('../route')

const ID = '0f8a2c9e-1b2c-4d5e-8f90-123456789abc'
const call = (id = ID) => POST(new Request(`http://x/api/account/email/auto-archive/${id}/undo`, { method: 'POST' }) as unknown as NextRequest, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { user: { id: 'user-1' }, workspaceId: 'ws-1', supabase: {} }
})

describe('POST /api/account/email/auto-archive/[id]/undo', () => {
  it('undoes the caller’s batch in their workspace', async () => {
    tidy.undoAutoArchive.mockResolvedValue({ ok: true, restored: 13, failed: 0, gone: 1 })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ restored: 13, failed: 0, gone: 1 })
    expect(tidy.undoAutoArchive).toHaveBeenCalledWith({ service: true }, { workspaceId: 'ws-1', userId: 'user-1', batchId: ID })
  })

  it('not theirs: 404; not set up: 503; a bad id: 400', async () => {
    tidy.undoAutoArchive.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await call()).status).toBe(404)
    tidy.undoAutoArchive.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect((await call()).status).toBe(503)
    tidy.undoAutoArchive.mockResolvedValueOnce({ ok: false, reason: 'read_failed' })
    expect((await call()).status).toBe(500)
    expect((await call('not-a-uuid')).status).toBe(400)
  })

  it('signed out: the auth response, nothing undone', async () => {
    auth.result = new Response('no', { status: 401 })
    expect((await call()).status).toBe(401)
    expect(tidy.undoAutoArchive).not.toHaveBeenCalled()
  })
})
