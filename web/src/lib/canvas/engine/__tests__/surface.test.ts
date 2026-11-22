import { describe, expect, it } from 'vitest'
import { fitBox, gridLevels, toScreen, toWorld, viewBox, visibleGridStep, wheelZoom, zoomAt } from '../camera'
import { makePencil } from '../defaults'
import { hitItem, itemsInBox, itemsOnSegment, pick, pickBox } from '../hit'
import { inkPath } from '../ink'
import { axisLock, gridStep, snap45, snapMove, snapPoint, snapTo } from '../snap'
import { connector, rect, sceneOf } from './helpers'

describe('camera', () => {
  it('zooms about the pointer and stays within 1% and 800%', () => {
    const cam = zoomAt({ x: 10, y: 20, scale: 1 }, { x: 110, y: 120 }, 2)
    expect(toWorld(cam, { x: 110, y: 120 })).toEqual({ x: 100, y: 100 })
    expect(zoomAt(cam, { x: 0, y: 0 }, 100).scale).toBe(8)
    expect(zoomAt(cam, { x: 0, y: 0 }, 0.0001).scale).toBe(0.01)
    expect(toScreen(cam, { x: 100, y: 100 })).toEqual({ x: 110, y: 120 })
  })

  it('caps one wheel event', () => {
    expect(wheelZoom({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, -10000).scale).toBeCloseTo(Math.exp(0.6))
    expect(wheelZoom({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 10).scale).toBeCloseTo(Math.exp(-0.1))
  })

  it('fits a box with a margin and never zooms in past 100%', () => {
    const cam = fitBox({ x: 0, y: 0, w: 2000, h: 1000 }, 1000, 800)
    expect(cam.scale).toBeCloseTo(0.4)
    expect(toScreen(cam, { x: 1000, y: 500 })).toEqual({ x: 500, y: 400 })
    expect(fitBox({ x: 0, y: 0, w: 10, h: 10 }, 1000, 800).scale).toBe(1)
    expect(fitBox(null, 1000, 800)).toEqual({ x: 500, y: 400, scale: 1 })
    expect(viewBox({ x: -100, y: 0, scale: 2 }, 200, 100)).toEqual({ x: 50, y: 0, w: 100, h: 50 })
  })

  it('shows coarser dots as it zooms out', () => {
    expect(visibleGridStep(8)).toBe(1)
    expect(visibleGridStep(1)).toBe(4)
    expect(visibleGridStep(0.25)).toBe(16)
    expect(visibleGridStep(0.02)).toBe(256)
    const levels = gridLevels(1)
    expect(levels.map((l) => l.step)).toEqual([4, 16])
    expect(levels[0].opacity).toBe(0)
    expect(levels[1].opacity).toBe(1)
  })
})

describe('picking', () => {
  it('picks an empty frame by its outline only, a filled one anywhere, the front one first', () => {
    const hollow = rect('a', 0, 0, 100, 100, { style: { fill: 'transparent', stroke: 'theme:ink', strokeWidth: 2 } })
    const s = sceneOf(rect('under', 20, 20, 30, 30), hollow)
    expect(pick(s, { x: 30, y: 30 }, 3)?.id).toBe('under')
    expect(pick(s, { x: 1, y: 50 }, 3)?.id).toBe('a')
    expect(pick(s, { x: 80, y: 80 }, 3)).toBeNull()
    expect(pickBox(s, { x: 80, y: 80 })?.id).toBe('a')
    const labelled = sceneOf({ ...hollow, label: { plain: 'Hi' } })
    expect(pick(labelled, { x: 50, y: 50 }, 3)?.id).toBe('a')
  })

  it('picks a turned box, an ellipse, ink and a connector by their real shape', () => {
    const turned = rect('a', 0, 0, 100, 10, { rotation: Math.PI / 2 })
    const s = sceneOf(turned)
    expect(hitItem(s, turned, { x: 50, y: 50 }, 1)).toBe(true)
    expect(hitItem(s, turned, { x: 90, y: 5 }, 1)).toBe(false)
    const round = { ...rect('e', 0, 0, 100, 100), kind: 'ellipse' as const }
    expect(hitItem(s, round, { x: 4, y: 4 }, 1)).toBe(false)
    expect(hitItem(s, round, { x: 50, y: 50 }, 1)).toBe(true)
    const ink = makePencil(
      [
        [0, 0, 0.5],
        [100, 0, 0.5],
        [100, 100, 0.5],
      ],
      'a1',
    )
    expect(hitItem(s, ink, { x: 50, y: 2 }, 2)).toBe(true)
    expect(hitItem(s, ink, { x: 50, y: 50 }, 2)).toBe(false)
    const k = connector('k', { x: 0, y: 0 }, { x: 100, y: 100 })
    const ks = sceneOf(k)
    expect(hitItem(ks, ks.items.k, { x: 50, y: 51 }, 3)).toBe(true)
    expect(hitItem(ks, ks.items.k, { x: 90, y: 10 }, 3)).toBe(false)
  })

  it('marquees what the box touches and erases what the stroke crosses', () => {
    const s = sceneOf(rect('a', 0, 0, 10, 10), rect('b', 50, 50, 10, 10), connector('k', { x: 0, y: 100 }, { x: 100, y: 200 }))
    expect(itemsInBox(s, { x: -5, y: -5, w: 20, h: 20 }).map((i) => i.id)).toEqual(['a'])
    // The connector's box covers this corner; its line does not.
    expect(itemsInBox(s, { x: 80, y: 100, w: 10, h: 10 })).toEqual([])
    expect(itemsInBox(s, { x: 40, y: 140, w: 20, h: 20 }).map((i) => i.id)).toEqual(['k'])
    expect(itemsOnSegment(s, { x: -5, y: 5 }, { x: 55, y: 55 }, 2).map((i) => i.id).sort()).toEqual(['a', 'b'])
  })

  it('makes ink once for the same stroke', () => {
    const ink = makePencil(
      [
        [0, 0, 0.5],
        [30, 10, 0.5],
        [60, 0, 0.5],
      ],
      'a1',
    )
    const d = inkPath(ink, 4)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(inkPath({ ...ink, x: 500 } as typeof ink, 4)).toBe(d)
    expect(inkPath({ ...ink, w: ink.w * 2 }, 4)).not.toBe(d)
  })
})

describe('snapping', () => {
  it('catches on a near edge and draws the line they share', () => {
    const others = [{ x: 100, y: 0, w: 50, h: 50 }]
    const r = snapMove({ x: 97, y: 200, w: 20, h: 20 }, others, 6)
    expect(r.dx).toBe(3)
    expect(r.dy).toBe(0)
    expect(r.guides).toEqual([{ axis: 'x', at: 100, from: 0, to: 220 }])
    expect(snapMove({ x: 80, y: 200, w: 10, h: 10 }, others, 6).guides).toEqual([])
    // Too far across the axis to count.
    expect(snapMove({ x: 97, y: 2000, w: 20, h: 20 }, others, 6, 160).dx).toBe(0)
  })

  it('snaps a handle, the grid, an axis and 45 degrees', () => {
    expect(snapPoint({ x: 148, y: 30 }, [{ x: 100, y: 0, w: 50, h: 50 }], 6).point).toEqual({ x: 150, y: 25 })
    expect(snapTo(13, 4)).toBe(12)
    expect(snapTo(13.4, 0)).toBe(13.4)
    expect(gridStep('auto', 16)).toBe(16)
    expect(gridStep('pixel', 16)).toBe(1)
    expect(gridStep('none', 16)).toBe(0)
    expect(axisLock(10, -3)).toEqual({ dx: 10, dy: 0 })
    const p = snap45({ x: 0, y: 0 }, { x: 100, y: 8 })
    expect(p.y).toBeCloseTo(0)
    const q = snap45({ x: 0, y: 0 }, { x: 100, y: 90 })
    expect(q.x).toBeCloseTo(q.y)
  })
})
