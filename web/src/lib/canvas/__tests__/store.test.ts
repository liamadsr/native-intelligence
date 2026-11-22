/**
 * The canvas store (migration 676): list and read canvases, create one owned
 * by the caller, update (visibility only by the owner), archive/restore and
 * delete, and write a batch of items with one version bump. RLS is the fake's
 * rows and its `editable`.
 */
import { describe, expect, it } from 'vitest'
import { fakeCanvasDb } from './fake-canvas-db'
import { createCanvas, deleteCanvas, getCanvas, listCanvases, updateCanvas, writeItems } from '../store'
import { CANVAS_LIMITS } from '../types'

const WS = 'ws-1'
const USER = 'u-1'
const MEMBER = 'm-1'
const C = '33333333-3333-4333-8333-333333333333'

function canvasRow(over: Record<string, unknown> = {}) {
  return {
    id: C,
    workspace_id: WS,
    title: 'Plan',
    visibility: 'workspace',
    project_id: null,
    owner_member_id: MEMBER,
    settings: {},
    version: 2,
    archived_at: null,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

function seed(over: Record<string, unknown[]> = {}, opts?: Parameters<typeof fakeCanvasDb>[1]) {
  return fakeCanvasDb(
    {
      canvas: [canvasRow()],
      canvas_item: [{ canvas_id: C, id: 'a', workspace_id: WS, parent_id: null, sort_key: 'a0', kind: 'rectangle', data: { x: 0, y: 0, w: 10, h: 10, style: {}, rotation: 0 } }],
      member: [{ id: MEMBER, workspace_id: WS, user_id: USER }],
      ...over,
    },
    opts,
  )
}

describe('canvas store', () => {
  it('lists the workspace canvases, live by default', async () => {
    const f = seed({ canvas: [canvasRow(), canvasRow({ id: 'c2', archived_at: '2026-01-01' })] })
    const live = await listCanvases(f.client, WS)
    expect(live.map((c) => c.id)).toEqual([C])
    const archived = await listCanvases(f.client, WS, { archived: true })
    expect(archived.map((c) => c.id)).toEqual(['c2'])
  })

  it('reads a canvas with its items and can_edit', async () => {
    const f = seed()
    const got = await getCanvas(f.client, WS, C, { userId: USER })
    expect(got?.canvas.title).toBe('Plan')
    expect(got?.items.map((i) => i.id)).toEqual(['a'])
    expect(got?.can_edit).toBe(true)
  })

  it('reads every item of a big canvas, a thousand at a time, and deletes many in chunks', async () => {
    const many = Array.from({ length: 2350 }, (_, i) => ({
      canvas_id: C,
      id: `i${String(i).padStart(4, '0')}`,
      workspace_id: WS,
      parent_id: null,
      sort_key: `a${String(i).padStart(4, '0')}`,
      kind: 'rectangle',
      data: { x: i, y: 0, w: 10, h: 10, style: {}, rotation: 0 },
    }))
    const f = seed({ canvas_item: many })
    const got = await getCanvas(f.client, WS, C, { userId: USER })
    expect(got?.items).toHaveLength(2350)
    expect(got?.items[0].id).toBe('i0000')
    expect(got?.items[2349].id).toBe('i2349')
    const res = await writeItems(f.client, WS, C, { remove: many.slice(0, 450).map((r) => r.id) }, { userId: USER })
    expect(res.ok).toBe(true)
    expect(f.rows.canvas_item).toHaveLength(1900)
    expect(f.calls.filter((c) => c.table === 'canvas_item' && c.op === 'delete')).toHaveLength(3)
  })

  it('creates a canvas owned by the caller', async () => {
    const f = fakeCanvasDb({ canvas: [], member: [{ id: MEMBER, workspace_id: WS, user_id: USER }] })
    const res = await createCanvas(f.client, WS, { title: 'Sketch' }, { userId: USER, ownerMemberId: MEMBER })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.title).toBe('Sketch')
    expect(f.rows.canvas[0]).toMatchObject({ owner_member_id: MEMBER, visibility: 'workspace', title: 'Sketch' })
  })

  it('defaults an empty title and refuses a bad visibility', async () => {
    const f = fakeCanvasDb({ canvas: [], member: [] })
    const a = await createCanvas(f.client, WS, { title: '  ' }, { userId: USER, ownerMemberId: MEMBER })
    expect(a.ok && a.value.title).toBe('Untitled canvas')
    const b = await createCanvas(f.client, WS, { visibility: 'everyone' as never }, { userId: USER, ownerMemberId: MEMBER })
    expect(b.ok).toBe(false)
  })

  it('lets the owner change visibility but no one else', async () => {
    const owner = seed()
    const asOwner = await updateCanvas(owner.client, WS, C, { visibility: 'private' }, { userId: USER })
    expect(asOwner.ok && asOwner.value.visibility).toBe('private')

    const other = seed({ member: [{ id: 'm-2', workspace_id: WS, user_id: 'u-2' }] })
    const asOther = await updateCanvas(other.client, WS, C, { visibility: 'private' }, { userId: 'u-2' })
    expect(asOther.ok).toBe(false)
    if (!asOther.ok) expect(asOther.reason).toBe('forbidden')
  })

  it('archives and restores through update', async () => {
    const f = seed()
    const archived = await deleteCanvas(f.client, WS, C, { userId: USER })
    expect(archived.ok).toBe(true)
    expect(f.rows.canvas[0].archived_at).not.toBeNull()
    const restored = await updateCanvas(f.client, WS, C, { archived: false }, { userId: USER })
    expect(restored.ok && restored.value.archived_at).toBeNull()
  })

  it('deletes for good with permanent', async () => {
    const f = seed()
    const res = await deleteCanvas(f.client, WS, C, { userId: USER }, { permanent: true })
    expect(res.ok).toBe(true)
    expect(f.rows.canvas).toHaveLength(0)
  })

  it('writes a batch of items, removes ids, and bumps the version once', async () => {
    const f = seed()
    const res = await writeItems(
      f.client,
      WS,
      C,
      {
        upsert: [{ id: 'b', parent_id: null, sort_key: 'a1', kind: 'ellipse', data: { x: 1 } } as never],
        remove: ['a'],
      },
      { userId: USER },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.version).toBe(3)
    expect(f.rows.canvas_item.map((i) => i.id)).toEqual(['b'])
    // The upserted row carries the canvas's workspace (the policy checks the same).
    expect(f.rows.canvas_item[0]).toMatchObject({ workspace_id: WS, kind: 'ellipse' })
  })

  it('refuses an unknown item kind and an over-large batch', async () => {
    const f = seed()
    const bad = await writeItems(f.client, WS, C, { upsert: [{ id: 'z', parent_id: null, sort_key: 'a1', kind: 'star', data: {} } as never] }, { userId: USER })
    expect(bad.ok).toBe(false)
    const tooMany = await writeItems(
      f.client,
      WS,
      C,
      { upsert: Array.from({ length: CANVAS_LIMITS.batch + 1 }, (_, i) => ({ id: `i${i}`, parent_id: null, sort_key: 'a', kind: 'rectangle', data: {} }) as never) },
      { userId: USER },
    )
    expect(tooMany.ok).toBe(false)
  })

  it('404s a canvas the caller cannot read', async () => {
    const f = seed({ canvas: [] })
    expect(await getCanvas(f.client, WS, C, { userId: USER })).toBeNull()
    const res = await updateCanvas(f.client, WS, C, { title: 'x' }, { userId: USER })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_found')
  })
})
