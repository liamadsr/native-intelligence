/**
 * Camera math. The zoom-to-cursor invariant is the one that users feel
 * immediately when it drifts, so it is asserted to 1e-9 across the whole
 * zoom range rather than at one comfortable scale.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_K,
  MIN_K_FACTOR,
  cameraLimits,
  clampCamera,
  clampK,
  easeInOutCubic,
  fitWorld,
  normalizeWheelDeltaY,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '@/components/knowledge-map/camera'
import type { CameraState, Viewport } from '@/components/knowledge-map/types'

const VIEWPORT: Viewport = { width: 1200, height: 800, dpr: 2 }
const LIMITS = { minK: 0.001, maxK: MAX_K }

describe('screenToWorld / worldToScreen', () => {
  it('maps the viewport centre to the camera centre', () => {
    const cam: CameraState = { x: 137.5, y: -42.25, k: 3 }
    const w = screenToWorld(cam, VIEWPORT, VIEWPORT.width / 2, VIEWPORT.height / 2)
    expect(w.x).toBeCloseTo(cam.x, 12)
    expect(w.y).toBeCloseTo(cam.y, 12)
  })

  it('does NOT flip the y axis: world +y is screen DOWN', () => {
    // The RENDERER owns this convention: shaders.ts projectLocal works in a
    // y-down pixel space and negates only when converting px → clip. So the
    // CPU side must flip nothing, or picking lands at the mirror image of what
    // is painted (see __tests__/projection-parity.test.ts for the guard).
    const cam: CameraState = { x: 0, y: 0, k: 2 }
    const above = screenToWorld(cam, VIEWPORT, VIEWPORT.width / 2, VIEWPORT.height / 2 - 100)
    expect(above.y).toBeLessThan(0)
    const below = screenToWorld(cam, VIEWPORT, VIEWPORT.width / 2, VIEWPORT.height / 2 + 100)
    expect(below.y).toBeGreaterThan(0)
    // 100 CSS px below the centre at k = 2 is exactly +50 world units.
    expect(below.y).toBeCloseTo(50, 12)
  })

  it('round-trips screen → world → screen', () => {
    const cam: CameraState = { x: -9012.5, y: 33.125, k: 0.37 }
    for (const [sx, sy] of [
      [0, 0],
      [1200, 800],
      [137, 642],
      [-50, 900],
    ]) {
      const w = screenToWorld(cam, VIEWPORT, sx, sy)
      const s = worldToScreen(cam, VIEWPORT, w.x, w.y)
      expect(s.x).toBeCloseTo(sx, 9)
      expect(s.y).toBeCloseTo(sy, 9)
    }
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed to 1e-9', () => {
    const cases: Array<[CameraState, number, number, number]> = [
      [{ x: 0, y: 0, k: 1 }, 10, 10, 1.2],
      [{ x: 512.25, y: -128.75, k: 0.05 }, 1199, 0, 4],
      [{ x: -1e5, y: 7e4, k: 8 }, 300, 700, 0.25],
      [{ x: 3, y: 3, k: 30 }, 600, 400, 1 / 1.35],
    ]
    for (const [cam, sx, sy, factor] of cases) {
      const before = screenToWorld(cam, VIEWPORT, sx, sy)
      const next = zoomAt(cam, VIEWPORT, sx, sy, factor, LIMITS)
      const after = screenToWorld(next, VIEWPORT, sx, sy)
      expect(Math.abs(after.x - before.x)).toBeLessThan(1e-9 * Math.max(1, Math.abs(before.x)))
      expect(Math.abs(after.y - before.y)).toBeLessThan(1e-9 * Math.max(1, Math.abs(before.y)))
    }
  })

  it('holds the invariant across a long chain of wheel ticks', () => {
    // Drift only shows up after many events; a single tick hides it.
    let cam: CameraState = { x: 1234.5, y: -987.25, k: 0.3 }
    const sx = 811
    const sy = 219
    const anchor = screenToWorld(cam, VIEWPORT, sx, sy)
    for (let i = 0; i < 200; i++) {
      cam = zoomAt(cam, VIEWPORT, sx, sy, i % 2 ? 1.06 : 1 / 1.03, LIMITS)
    }
    const after = screenToWorld(cam, VIEWPORT, sx, sy)
    expect(after.x).toBeCloseTo(anchor.x, 6)
    expect(after.y).toBeCloseTo(anchor.y, 6)
  })

  it('clamps at the limits and returns the same object when the scale cannot change', () => {
    const cam: CameraState = { x: 0, y: 0, k: MAX_K }
    const same = zoomAt(cam, VIEWPORT, 100, 100, 4, LIMITS)
    expect(same).toBe(cam)

    const zoomedOut = zoomAt({ x: 0, y: 0, k: 0.002 }, VIEWPORT, 0, 0, 0.001, LIMITS)
    expect(zoomedOut.k).toBe(LIMITS.minK)
  })
})

describe('fitWorld', () => {
  it('centres the world square and fits it with padding', () => {
    const world = { minX: -500, minY: -500, size: 1000 }
    const cam = fitWorld(world, VIEWPORT, 40)
    expect(cam.x).toBe(0)
    expect(cam.y).toBe(0)
    // Height is the binding dimension: (800 - 80) / 1000.
    expect(cam.k).toBeCloseTo(0.72, 12)

    // World +y is screen DOWN, so (minX, minY) is the TOP-left on screen and
    // both padded edges are at least `padPx` from the viewport's own corner.
    const topLeft = worldToScreen(cam, VIEWPORT, world.minX, world.minY)
    expect(topLeft.x).toBeGreaterThanOrEqual(40 - 1e-9)
    expect(topLeft.y).toBeGreaterThanOrEqual(40 - 1e-9)

    const bottomRight = worldToScreen(
      cam,
      VIEWPORT,
      world.minX + world.size,
      world.minY + world.size,
    )
    expect(bottomRight.x).toBeLessThanOrEqual(VIEWPORT.width - 40 + 1e-9)
    expect(bottomRight.y).toBeLessThanOrEqual(VIEWPORT.height - 40 + 1e-9)
  })

  it('handles a degenerate world without dividing by zero', () => {
    const cam = fitWorld({ minX: 5, minY: 5, size: 0 }, VIEWPORT, 0)
    expect(Number.isFinite(cam.k)).toBe(true)
    expect(cam.k).toBeGreaterThan(0)
  })
})

describe('limits', () => {
  it('derives minK from the fit scale and MIN_K_FACTOR', () => {
    const world = { minX: 0, minY: 0, size: 2000 }
    const limits = cameraLimits(world, VIEWPORT)
    const fit = fitWorld(world, VIEWPORT, 0).k
    expect(limits.minK).toBeCloseTo(fit * MIN_K_FACTOR, 12)
    expect(limits.maxK).toBe(MAX_K)
  })

  it('never inverts the range for a tiny world', () => {
    // A tiny world fits at a huge scale, which would push minK above MAX_K.
    const limits = cameraLimits({ minX: 0, minY: 0, size: 0.0001 }, VIEWPORT)
    expect(limits.maxK).toBeGreaterThanOrEqual(limits.minK)
  })

  it('clamps a camera and leaves an in-range one untouched', () => {
    const cam: CameraState = { x: 1, y: 2, k: 4 }
    expect(clampCamera(cam, LIMITS)).toBe(cam)
    expect(clampCamera({ ...cam, k: 1e6 }, LIMITS).k).toBe(MAX_K)
    expect(clampK(Number.NaN, LIMITS)).toBe(LIMITS.minK)
  })
})

describe('wheel + easing helpers', () => {
  it('normalises line and page delta modes to approximate pixels', () => {
    expect(normalizeWheelDeltaY({ deltaY: 3, deltaMode: 0 })).toBe(3)
    expect(normalizeWheelDeltaY({ deltaY: 3, deltaMode: 1 })).toBe(48)
    expect(normalizeWheelDeltaY({ deltaY: 1, deltaMode: 2 })).toBe(400)
    expect(normalizeWheelDeltaY({ deltaY: 5 })).toBe(5)
  })

  it('eases from 0 to 1 monotonically', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12)
    let prev = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeInOutCubic(Math.min(1, t))
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})
