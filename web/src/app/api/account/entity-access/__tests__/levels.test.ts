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
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/entity-access/store', () => ({
  addEntityGrant: hoisted.addEntityGrant,
  loadEntityAccess: vi.fn(),
  removeEntityGrant: vi.fn(),
  setEntityGrantLevel: hoisted.setEntityGrantLevel,
}))

import { POST } from '../route'
import { DELETE, PATCH } from '../[id]/route'

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

describe('the notice to whoever a record is shared with (688)', () => {
  it('POST tells the member a spreadsheet or canvas was shared with, at its level', async () => {
    const notify = await import('@/lib/entity-access/notify')
    const spy = vi.spyOn(notify, 'notifyRecordShared').mockResolvedValue(undefined)
    await POST(req({ type: 'canvas', id: DOC, grantee_kind: 'member', grantee_id: BEN, level: 'edit' }))
    expect(spy).toHaveBeenCalledWith({ session: true }, { workspaceId: 'ws-1', actorMemberId: 'm-ana', type: 'canvas', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'edit' })
    spy.mockClear()
    hoisted.addEntityGrant.mockResolvedValue({ error: 'forbidden', message: "This can't be shared yet" })
    expect((await POST(req({ type: 'canvas', id: DOC, grantee_kind: 'member', grantee_id: BEN }))).status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('PATCH tells them once a view grant becomes edit, and not on a change to view', async () => {
    const notify = await import('@/lib/entity-access/notify')
    const read = vi.spyOn(notify, 'readGrantForNotice').mockResolvedValue({ type: 'spreadsheet', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'view' })
    const spy = vi.spyOn(notify, 'notifyRecordShared').mockResolvedValue(undefined)
    expect((await PATCH(req({ level: 'edit' }), params(GRANT))).status).toBe(200)
    expect(spy).toHaveBeenCalledWith({ session: true }, { workspaceId: 'ws-1', actorMemberId: 'm-ana', type: 'spreadsheet', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'edit', raised: true })
    spy.mockClear()
    read.mockResolvedValue({ type: 'spreadsheet', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'edit' })
    await PATCH(req({ level: 'edit' }), params(GRANT))
    await PATCH(req({ level: 'view' }), params(GRANT))
    expect(spy).not.toHaveBeenCalled()
    read.mockRestore()
    spy.mockRestore()
  })
})

describe('a canvas grant removed or lowered: its open editors ask again (688)', () => {
  it('DELETE and a lower to view announce it; a raise, or another kind, does not', async () => {
    const notify = await import('@/lib/entity-access/notify')
    const notice = await import('@/lib/canvas/access-notice')
    const store = await import('@/lib/entity-access/store')
    const announce = vi.spyOn(notice, 'announceCanvasAccessChanged').mockResolvedValue(undefined)
    const read = vi.spyOn(notify, 'readGrantForNotice').mockResolvedValue({ type: 'canvas', id: DOC, granteeKind: 'team', granteeId: BEN, level: 'edit' })
    vi.mocked(store.removeEntityGrant).mockResolvedValue(true)
    expect((await DELETE(req({}), params(GRANT))).status).toBe(200)
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce.mock.calls[0][1]).toBe(DOC)
    await PATCH(req({ level: 'view' }), params(GRANT))
    expect(announce).toHaveBeenCalledTimes(2)
    read.mockResolvedValue({ type: 'canvas', id: DOC, granteeKind: 'team', granteeId: BEN, level: 'view' })
    await PATCH(req({ level: 'edit' }), params(GRANT))
    read.mockResolvedValue({ type: 'document', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'edit' })
    await DELETE(req({}), params(GRANT))
    expect(announce).toHaveBeenCalledTimes(2)
    // A spreadsheet's room hears it too, on its own topic.
    const any = vi.spyOn(notice, 'announceAccessChanged').mockResolvedValue(undefined)
    read.mockResolvedValue({ type: 'spreadsheet', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'view' })
    await DELETE(req({}), params(GRANT))
    expect(any).toHaveBeenCalledWith({ service: true }, `spreadsheet-presence:${DOC}`)
    any.mockRestore()
    // Nothing is announced for a grant that was not removed.
    read.mockResolvedValue({ type: 'canvas', id: DOC, granteeKind: 'member', granteeId: BEN, level: 'edit' })
    vi.mocked(store.removeEntityGrant).mockResolvedValue(false)
    expect((await DELETE(req({}), params(GRANT))).status).toBe(404)
    expect(announce).toHaveBeenCalledTimes(2)
    announce.mockRestore()
    read.mockRestore()
  })
})
