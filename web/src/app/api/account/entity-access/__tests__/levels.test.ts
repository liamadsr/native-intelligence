/**
 * The share dialog's level API (migration 512): POST takes `level` (view
 * unless it says edit, anything else refused), and PATCH /[id] changes a
 * grant's level as someone who may share its record (RLS decides; a grant
 * that is not theirs to change is a 404, never a 500).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  addEntityGrant: vi.fn(),
  setEntityGrantLevel: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: { session: true }, workspaceId: 'ws-1', member: { id: 'm-ana' }, user: { id: 'u-ana' } }),
}))
vi.mock('@/lib/entity-access/store', () => ({
  addEntityGrant: hoisted.addEntityGrant,
  loadEntityAccess: vi.fn(),
  removeEntityGrant: vi.fn(),
  setEntityGrantLevel: hoisted.setEntityGrantLevel,
}))

import { POST } from '../route'
import { PATCH } from '../[id]/route'

const DOC = '11111111-1111-4111-8111-111111111111'
const BEN = '22222222-2222-4222-8222-222222222222'
const GRANT = '33333333-3333-4333-8333-333333333333'

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  hoisted.addEntityGrant.mockReset().mockResolvedValue({ id: 'g-new' })
  hoisted.setEntityGrantLevel.mockReset().mockResolvedValue(true)
})

describe('POST /api/account/entity-access with a level', () => {
  it('passes edit through, and defaults to view', async () => {
    const base = { type: 'document', id: DOC, grantee_kind: 'member', grantee_id: BEN }
    expect((await POST(req({ ...base, level: 'edit' }))).status).toBe(201)
    expect(hoisted.addEntityGrant.mock.calls[0][5]).toBe('edit')
    expect((await POST(req(base))).status).toBe(201)
    expect(hoisted.addEntityGrant.mock.calls[1][5]).toBe('view')
  })

  it('refuses a level that is neither', async () => {
    const res = await POST(req({ type: 'document', id: DOC, grantee_kind: 'member', grantee_id: BEN, level: 'owner' }))
    expect(res.status).toBe(400)
    expect(hoisted.addEntityGrant).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/account/entity-access/[id]', () => {
  it('changes the level as the person', async () => {
    const res = await PATCH(req({ level: 'edit' }), params(GRANT))
    expect(res.status).toBe(200)
    expect(hoisted.setEntityGrantLevel).toHaveBeenCalledWith({ session: true }, 'ws-1', GRANT, 'edit')
  })

  it('a grant that is not theirs to change is a 404', async () => {
    hoisted.setEntityGrantLevel.mockResolvedValue(false)
    expect((await PATCH(req({ level: 'view' }), params(GRANT))).status).toBe(404)
  })

  it('refuses a bad level and a bad id without asking the database', async () => {
    expect((await PATCH(req({ level: 'admin' }), params(GRANT))).status).toBe(400)
    expect((await PATCH(req({ level: 'edit' }), params('not-a-uuid'))).status).toBe(404)
    expect(hoisted.setEntityGrantLevel).not.toHaveBeenCalled()
  })
})
