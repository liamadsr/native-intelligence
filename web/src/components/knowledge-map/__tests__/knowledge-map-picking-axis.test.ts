/**
 * Picking must agree with painting about which way is up.
 *
 * THE RENDERER DEFINES THE CONVENTION: `shaders.ts` projectLocal computes
 * pixels in a y-DOWN space and negates y only when converting those pixels to
 * clip space, so WORLD +Y IS SCREEN DOWN. `camera.screenToWorld` /
 * `worldToScreen` therefore flip nothing, and `spatial-index.pick` calls them
 * instead of re-deriving the transform — one definition on the CPU side.
 *
 * When the two halves disagree, hover and click land MIRRORED about the
 * viewport's horizontal centre line: a node drawn 100 px above the middle is
 * only clickable 100 px below it. That is exactly what shipped once, and no
 * unit test caught it because each half was internally consistent and the
 * spatial-index suite picks symmetrically around the centre.
 *
 * This file pins the agreement from the outside: place a node, project it with
 * the camera, and require the pick to succeed at the projected point and fail
 * at its mirror image. `projection-parity.test.ts` pins the other half (that
 * the camera agrees with the GLSL).
 */
import { describe, expect, it } from 'vitest'
import { screenToWorld, worldToScreen } from '../camera'
import { SpatialIndex } from '../spatial-index'
import type { ResidentTile } from '../types'

const VP = { width: 800, height: 600, dpr: 1 }
const CAM = { x: 0, y: 0, k: 1 }

/** A 1024-unit tile centred on the node, so it is never outside its own box. */
function tileWithNodeAt(wx: number, wy: number): ResidentTile {
  const ox = wx - 512
  const oy = wy - 512
  return {
    id: '0.0.0',
    z: 0,
    x: 0,
    y: 0,
    ox,
    oy,
    size: 1024,
    slab: 0,
    nodeCount: 1,
    edgeCount: 0,
    nodeId: Uint32Array.from([1]),
    nodeX: Float32Array.from([wx - ox]),
    nodeY: Float32Array.from([wy - oy]),
    nodeR: Float32Array.from([5]),
    nodeImportance: Float32Array.from([1]),
    nodeDegree: new Uint32Array(1),
    nodeKind: new Uint8Array(1),
    nodeFlags: new Uint8Array(1),
    nodeEtype: Int16Array.from([-1]),
    keys: ['claim:x'],
    labels: ['X'],
    edgeSource: new Uint16Array(0),
    edgeTarget: new Uint32Array(0),
    edgeTX: new Float32Array(0),
    edgeTY: new Float32Array(0),
    edgeRel: new Uint8Array(0),
    loadedAt: 0,
    lastVisibleFrame: 0,
  }
}

describe('picking agrees with the camera projection', () => {
  it('screenToWorld does not flip y, so below the centre is a HIGHER world y', () => {
    expect(screenToWorld(CAM, VP, 400, 400).y).toBe(100)
    expect(screenToWorld(CAM, VP, 400, 200).y).toBe(-100)
  })

  it.each([
    ['above the centre', 0, -100],
    ['below the centre', 0, 100],
    ['up and to the left', -150, -80],
    ['down and to the right', 200, 60],
  ])('picks a node at %s exactly where it is painted', (_label, wx, wy) => {
    const screen = worldToScreen(CAM, VP, wx, wy)
    const index = new SpatialIndex()
    const tile = tileWithNodeAt(wx, wy)

    expect(index.pick([tile], CAM, VP, screen.x, screen.y, {})?.key).toBe('claim:x')

    // ...and NOT at the point mirrored about the viewport centre, which is
    // where an unflipped hit test would have put it.
    const mirroredY = VP.height - screen.y
    if (Math.abs(mirroredY - screen.y) > 40) {
      expect(index.pick([tile], CAM, VP, screen.x, mirroredY, {})).toBeNull()
    }
  })

  it('round-trips through screenToWorld for an off-centre camera and zoom', () => {
    const cam = { x: 1234.5, y: -987.25, k: 3.75 }
    const wx = 1300
    const wy = -900
    const screen = worldToScreen(cam, VP, wx, wy)
    const back = screenToWorld(cam, VP, screen.x, screen.y)
    expect(back.x).toBeCloseTo(wx, 9)
    expect(back.y).toBeCloseTo(wy, 9)

    const index = new SpatialIndex()
    expect(index.pick([tileWithNodeAt(wx, wy)], cam, VP, screen.x, screen.y, {})?.key).toBe(
      'claim:x',
    )
  })
})
