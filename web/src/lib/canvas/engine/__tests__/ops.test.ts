import { describe, expect, it } from 'vitest'
import type { ConnectorItem, PencilItem, TextItem } from '../../types'
import { resolveEnds, routePath } from '../connectors'
import { makePencil, makeText } from '../defaults'
import { aabb, centerOf } from '../geometry'
import { diffScenes, EMPTY_HISTORY, record, redo, undo } from '../history'
import {
  alignItems,
  deleteItems,
  distributeItems,
  duplicateItems,
  flipItems,
  groupItems,
  insertCopies,
  moveItems,
  reorderItems,
  resizeMany,
  resizeMap,
  resizeOne,
  rotateItems,
  rotationDelta,
  setPose,
  setStyle,
  ungroupItems,
} from '../ops'
import { boundsOf, painted, rootOf, selectionRoots } from '../scene'
import { connector, rect, sceneOf } from './helpers'

describe('move', () => {
  it('moves a group with what is in it, and shares what it did not touch', () => {
    const s0 = sceneOf(rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10), rect('c', 100, 100, 10, 10))
    const g = groupItems(s0, ['a', 'b'])
    const s1 = moveItems(g.scene, [g.id!], 5, 7)
    expect(s1.items.a).toMatchObject({ x: 5, y: 7 })
    expect(s1.items.b).toMatchObject({ x: 25, y: 7 })
    expect(s1.items.c).toBe(s0.items.c)
  })

  it('keeps a tied end on its shape and moves a free end with the connector', () => {
    const s0 = sceneOf(rect('a', 0, 0, 100, 100), connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'right' } }, { x: 300, y: 50 }))
    expect((s0.items.k as ConnectorItem).start).toMatchObject({ x: 100, y: 50 })
    // Move the shape: the tied end follows, the free end stays.
    const s1 = moveItems(s0, ['a'], 0, 40)
    expect((s1.items.k as ConnectorItem).start).toMatchObject({ x: 100, y: 90 })
    expect((s1.items.k as ConnectorItem).end).toMatchObject({ x: 300, y: 50 })
    // Move the connector: the free end moves, the tied end stays on the shape.
    const s2 = moveItems(s0, ['k'], 10, 10)
    expect((s2.items.k as ConnectorItem).start).toMatchObject({ x: 100, y: 50 })
    expect((s2.items.k as ConnectorItem).end).toMatchObject({ x: 310, y: 60 })
    // Its box is the path's.
    expect(aabb(s2.items.k)).toMatchObject({ x: 100, y: 50, w: 210, h: 10 })
  })

  it('a center tie meets the outline on the side facing the other end', () => {
    const s = sceneOf(
      rect('a', 0, 0, 100, 100),
      rect('b', 300, 0, 100, 100),
      connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'center' } }, { x: 0, y: 0, bind: { id: 'b', anchor: 'center' } }),
    )
    const ends = resolveEnds(s, s.items.k as ConnectorItem)
    expect(ends.start).toMatchObject({ x: 100, y: 50 })
    expect(ends.end).toMatchObject({ x: 300, y: 50 })
    const below = moveItems(s, ['b'], -300, 300)
    const e2 = resolveEnds(below, below.items.k as ConnectorItem)
    expect(e2.start).toMatchObject({ x: 50, y: 100 })
    expect(e2.end).toMatchObject({ x: 50, y: 300 })
  })

  it('leaves a connector where it was when its shape is deleted, and undo ties it again', () => {
    const s0 = sceneOf(rect('a', 0, 0, 100, 100), connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'right' } }, { x: 300, y: 50 }))
    const s1 = deleteItems(s0, ['a'])
    expect(s1.items.a).toBeUndefined()
    expect((s1.items.k as ConnectorItem).start).toMatchObject({ x: 100, y: 50, bind: { id: 'a' } })
    const h = record(EMPTY_HISTORY, diffScenes(s0, s1))
    const back = undo(h, s1)
    expect(back.scene.items.a).toEqual(s0.items.a)
    const moved = moveItems(back.scene, ['a'], 10, 0)
    expect((moved.items.k as ConnectorItem).start.x).toBe(110)
    expect(redo(back.history, back.scene).scene.items.a).toBeUndefined()
  })
})

describe('routes', () => {
  it('draws an elbow between two side anchors through a shared middle', () => {
    const s = sceneOf(
      rect('a', 0, 0, 100, 100),
      rect('b', 300, 200, 100, 100),
      connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'right' } }, { x: 0, y: 0, bind: { id: 'b', anchor: 'left' } }, { route: 'elbow' }),
    )
    const path = routePath(s, s.items.k as ConnectorItem)
    expect(path.points).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
      { x: 200, y: 250 },
      { x: 300, y: 250 },
    ])
    expect(path.mid).toEqual({ x: 200, y: 150 })
    expect(path.endAngle).toBeCloseTo(0)
  })

  it('draws a smooth route that leaves each side anchor square on', () => {
    const s = sceneOf(
      rect('a', 0, 0, 100, 100),
      rect('b', 300, 200, 100, 100),
      connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'bottom' } }, { x: 0, y: 0, bind: { id: 'b', anchor: 'top' } }, { route: 'smooth' }),
    )
    const path = routePath(s, s.items.k as ConnectorItem)
    expect(path.d.startsWith('M50,100 C50,')).toBe(true)
    expect(path.endAngle).toBeCloseTo(Math.PI / 2)
    expect(path.poly).toHaveLength(25)
  })
})

describe('resize', () => {
  it('scales from the opposite corner, keeps proportions with Shift, grows both ways with Alt', () => {
    const from = { x: 0, y: 0, w: 100, h: 50 }
    expect(resizeMap(from, { hx: 1, hy: 1 }, { x: 200, y: 75 })).toMatchObject({ ax: 0, ay: 0, sx: 2, sy: 1.5 })
    expect(resizeMap(from, { hx: 1, hy: 1 }, { x: 200, y: 75 }, { proportional: true })).toMatchObject({ sx: 2, sy: 2 })
    expect(resizeMap(from, { hx: 1, hy: 0 }, { x: 150, y: 0 }, { fromCenter: true })).toMatchObject({ ax: 50, sx: 2, sy: 1 })
    expect(resizeMap(from, { hx: -1, hy: -1 }, { x: 150, y: 25 })).toMatchObject({ ax: 100, ay: 50, sx: -0.5, sy: 0.5 })
  })

  it('keeps the far corner of a turned box where it is', () => {
    const s0 = sceneOf(rect('a', 0, 0, 100, 50, { rotation: Math.PI / 2 }))
    const far = { x: 75, y: -25 } // the box's own top-left after a quarter turn
    const s1 = resizeOne(s0, 'a', { hx: 1, hy: 1 }, { x: 25, y: 175 })
    const a = s1.items.a
    expect(a.w).toBeCloseTo(200)
    expect(a.h).toBeCloseTo(50)
    const c = centerOf(a)
    // Top-left in its own frame, turned: center + rot(-w/2, -h/2).
    expect(c.x + 25).toBeCloseTo(far.x)
    expect(c.y - 100).toBeCloseTo(far.y)
  })

  it('flips ink when a pencil is dragged through itself', () => {
    const p = makePencil(
      [
        [0, 0, 0.5],
        [10, 0, 0.5],
        [40, 20, 0.5],
      ],
      'a1',
    )
    const s1 = resizeOne(sceneOf(p), p.id, { hx: 1, hy: 0 }, { x: -40, y: 0 })
    const q = s1.items[p.id] as PencilItem
    expect(q).toMatchObject({ x: -40, w: 40 })
    expect(q.points.map((pt) => pt[0])).toEqual([40, 30, 0])
  })

  it('scales text size from a corner and reflows it from a side', () => {
    const t = { ...makeText({ x: 0, y: 0 }, 'a1', { plain: 'Hello' }), w: 100, h: 28 }
    const corner = resizeOne(sceneOf(t), t.id, { hx: 1, hy: 1 }, { x: 200, y: 56 }).items[t.id] as TextItem
    expect(corner.text.fontSize).toBe(40)
    expect(corner.autoWidth).toBe(true)
    const side = resizeOne(sceneOf(t), t.id, { hx: 1, hy: 0 }, { x: 60, y: 0 }).items[t.id] as TextItem
    expect(side).toMatchObject({ w: 60, autoWidth: false })
    expect(side.text.fontSize).toBe(20)
  })

  it('stretches upright boxes apart and scales turned ones evenly', () => {
    const s0 = sceneOf(rect('a', 0, 0, 10, 10), rect('b', 90, 40, 10, 10))
    const s1 = resizeMany(s0, ['a', 'b'], { hx: 1, hy: 1 }, { x: 200, y: 50 })
    expect(s1.items.a).toMatchObject({ x: 0, y: 0, w: 20, h: 10 })
    expect(s1.items.b).toMatchObject({ x: 180, y: 40, w: 20, h: 10 })
    const t0 = sceneOf(rect('a', 0, 0, 10, 10, { rotation: 0.3 }), rect('b', 90, 40, 10, 10))
    const box = boundsOf(t0, ['a', 'b'])!
    const t1 = resizeMany(t0, ['a', 'b'], { hx: 1, hy: 1 }, { x: box.x + box.w * 2, y: box.y + box.h })
    expect(t1.items.a.w).toBeCloseTo(20)
    expect(t1.items.a.h).toBeCloseTo(20)
  })

  it('mirrors a turned box across the middle', () => {
    const s0 = sceneOf(rect('a', 0, 0, 40, 10, { rotation: 0.5 }), rect('b', 100, 0, 10, 10))
    const s1 = flipItems(s0, ['a', 'b'], 'x')
    expect(s1.items.a.rotation).toBeCloseTo(-0.5)
    expect(boundsOf(s1, ['a', 'b'])!.w).toBeCloseTo(boundsOf(s0, ['a', 'b'])!.w)
    expect(s1.items.b.x).toBeLessThan(s1.items.a.x)
  })

  it('sets a typed size and position', () => {
    const s0 = sceneOf(rect('a', 10, 10, 40, 20))
    expect(setPose(s0, ['a'], { w: 80 }).items.a).toMatchObject({ x: 10, y: 10, w: 80, h: 20 })
    expect(setPose(s0, ['a'], { x: 0, y: 5 }).items.a).toMatchObject({ x: 0, y: 5 })
    expect(setPose(s0, ['a'], { rotation: Math.PI / 2 }).items.a.rotation).toBeCloseTo(Math.PI / 2)
  })
})

describe('rotate', () => {
  it('turns a pair about their shared middle', () => {
    const s0 = sceneOf(rect('a', 0, 0, 10, 10), rect('b', 90, 0, 10, 10))
    const s1 = rotateItems(s0, ['a', 'b'], Math.PI / 2)
    expect(centerOf(s1.items.a)).toMatchObject({ x: 50, y: -40 })
    expect(centerOf(s1.items.b)).toMatchObject({ x: 50, y: 50 })
    expect(s1.items.a.rotation).toBeCloseTo(Math.PI / 2)
  })

  it('steps by 15 degrees with Shift', () => {
    const d = rotationDelta({ x: 0, y: 0 }, { x: 0, y: -10 }, { x: 3, y: -10 }, true)
    expect((d * 180) / Math.PI).toBeCloseTo(15)
    expect(rotationDelta({ x: 0, y: 0 }, { x: 0, y: -10 }, { x: 10, y: 0 }, false)).toBeCloseTo(Math.PI / 2)
  })
})

describe('groups, copies, order', () => {
  it('groups, selects the group, and ungroups back', () => {
    const s0 = sceneOf(rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10))
    const g = groupItems(s0, ['a', 'b'])
    expect(rootOf(g.scene, 'a')).toBe(g.id)
    expect(selectionRoots(g.scene, ['a', g.id!])).toEqual([g.id])
    const u = ungroupItems(g.scene, [g.id!])
    expect(u.ids.sort()).toEqual(['a', 'b'])
    expect(u.scene.items[g.id!]).toBeUndefined()
    expect(groupItems(s0, ['a']).id).toBeNull()
  })

  it('styles everything in a group and removes a group with its last item', () => {
    const g = groupItems(sceneOf(rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)), ['a', 'b'])
    const styled = setStyle(g.scene, [g.id!], { fill: '#ff0000' })
    expect(styled.items.a.style.fill).toBe('#ff0000')
    expect(styled.items.b.style.fill).toBe('#ff0000')
    const gone = deleteItems(deleteItems(g.scene, ['a']), ['b'])
    expect(Object.keys(gone.items)).toEqual([])
  })

  it('duplicates in front with fresh ids, and ties between copies follow the copies', () => {
    const s0 = sceneOf(
      rect('a', 0, 0, 100, 100),
      rect('b', 300, 0, 100, 100),
      connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'right' } }, { x: 0, y: 0, bind: { id: 'b', anchor: 'left' } }),
    )
    const d = duplicateItems(s0, ['a', 'k'])
    expect(d.ids).toHaveLength(2)
    const copyA = d.scene.items[d.ids[0]]
    const copyK = d.scene.items[d.ids[1]] as ConnectorItem
    expect(copyA).toMatchObject({ x: 24, y: 24 })
    expect(copyK.start.bind?.id).toBe(copyA.id)
    // b was not copied: the copy stays tied to the original b.
    expect(copyK.end.bind?.id).toBe('b')
    const order = painted(d.scene).map((it) => it.id)
    expect(order.slice(-2)).toEqual([copyA.id, copyK.id])
  })

  it('pastes a fragment from another canvas with no ties to things that are not here', () => {
    const source = sceneOf(rect('a', 0, 0, 100, 100), connector('k', { x: 0, y: 0, bind: { id: 'a', anchor: 'right' } }, { x: 300, y: 50 }))
    const target = sceneOf(rect('z', 0, 0, 10, 10))
    const pasted = insertCopies(target, source, ['k'], { x: 10, y: 0 })
    const k = pasted.scene.items[pasted.ids[0]] as ConnectorItem
    expect(k.start.bind).toBeUndefined()
    expect(k.start).toMatchObject({ x: 110, y: 50 })
  })

  it('restacks', () => {
    const s0 = sceneOf(rect('a', 0, 0, 1, 1), rect('b', 0, 0, 1, 1), rect('c', 0, 0, 1, 1), rect('d', 0, 0, 1, 1))
    const ids = (s: typeof s0) => painted(s).map((it) => it.id)
    expect(ids(reorderItems(s0, ['a'], 'front'))).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(reorderItems(s0, ['d'], 'back'))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(reorderItems(s0, ['a'], 'forward'))).toEqual(['b', 'a', 'c', 'd'])
    expect(ids(reorderItems(s0, ['c'], 'backward'))).toEqual(['a', 'c', 'b', 'd'])
    expect(ids(reorderItems(s0, ['a', 'c'], 'forward'))).toEqual(['b', 'd', 'a', 'c'])
    expect(reorderItems(s0, ['d'], 'front')).toBe(s0)
    expect(reorderItems(s0, ['a'], 'backward')).toBe(s0)
  })

  it('aligns and distributes', () => {
    const s0 = sceneOf(rect('a', 0, 0, 10, 10), rect('b', 30, 20, 20, 20), rect('c', 100, 50, 10, 10))
    const left = alignItems(s0, ['a', 'b', 'c'], 'left')
    expect([left.items.a.x, left.items.b.x, left.items.c.x]).toEqual([0, 0, 0])
    const mid = alignItems(s0, ['a', 'b', 'c'], 'middle')
    expect(centerOf(mid.items.a).y).toBe(30)
    const spread = distributeItems(s0, ['a', 'b', 'c'], 'x')
    // Gaps: (110 - 0 - 40) / 2 = 35.
    expect(spread.items.b.x).toBe(45)
    expect(spread.items.a.x).toBe(0)
    expect(spread.items.c.x).toBe(100)
    expect(distributeItems(s0, ['a', 'b'], 'x')).toBe(s0)
  })
})
