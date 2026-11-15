/**
 * POST /api/account/tables/<id>/ops: a person's own new rows start the
 * table's record_created loops (forms phase 2), about five minutes later;
 * a batch that adds no row, a refused one, and a workspace with no such
 * loop send nothing, and a failed send never fails the write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  applyOps: vi.fn(),
  hasFlows: vi.fn(async () => true),
  emit: vi.fn(async () => 1),
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: {}, user: { id: 'u-1' }, workspaceId: 'ws-1' }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/tables/store', () => ({ applyOps: h.applyOps }))
vi.mock('@/lib/flows/event-triggers', () => ({ workspaceHasEventFlows: h.hasFlows }))
vi.mock('@/lib/flows/emit-record-created', () => ({ emitRecordsCreated: h.emit }))

const { POST } = await import('../[id]/ops/route')

const TABLE = '33333333-3333-4333-8333-333333333333'
const post = () =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ base_version: 3, ops: [{ op: 'insert_rows', rows: [{}] }] }) }) as unknown as NextRequest, { params: Promise.resolve({ id: TABLE }) })
const applied = (ids: string[]) => ({ ok: true, value: { version: 4, change_id: 'ch-1', inserted_row_ids: ids, created_column_ids: {} } })

beforeEach(() => {
  vi.clearAllMocks()
  h.hasFlows.mockResolvedValue(true)
})

describe("a person's new rows", () => {
  it('emit once for the batch, as a person, written as that person', async () => {
    h.applyOps.mockResolvedValueOnce(applied(['r1', 'r2']))
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.applyOps.mock.calls[0][4]).toMatchObject({ userId: 'u-1', source: 'person' })
    // Only this table's loops: a paste into another table costs nothing.
    expect(h.hasFlows).toHaveBeenCalledWith({ service: true }, { workspaceId: 'ws-1', triggerType: 'record_created', tableId: TABLE })
    expect(h.emit).toHaveBeenCalledWith({ workspaceId: 'ws-1', tableId: TABLE, rowIds: ['r1', 'r2'], source: 'person' })
  })

  it('send nothing when the batch added no row, was refused, or the workspace has no such loop', async () => {
    h.applyOps.mockResolvedValueOnce(applied([]))
    await post()
    h.applyOps.mockResolvedValueOnce({ ok: false, reason: 'conflict', error: 'changed', version: 5 })
    expect((await post()).status).toBe(409)
    h.hasFlows.mockResolvedValueOnce(false)
    h.applyOps.mockResolvedValueOnce(applied(['r1']))
    await post()
    expect(h.emit).not.toHaveBeenCalled()
  })

  it('a send that fails never fails the write', async () => {
    h.applyOps.mockResolvedValueOnce(applied(['r1']))
    h.emit.mockRejectedValueOnce(new Error('inngest down'))
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).inserted_row_ids).toEqual(['r1'])
  })
})
