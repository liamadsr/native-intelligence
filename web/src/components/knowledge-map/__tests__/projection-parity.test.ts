/**
 * THE GUARD THAT WAS MISSING.
 *
 * The Knowledge Map projects world → screen twice, in two languages:
 *
 *   • on the GPU, by `projectLocal` in shaders.ts (GLSL), which is what the
 *     user actually SEES;
 *   • on the CPU, by `camera.worldToScreen`, which is what picking, label
 *     placement and every screen-space decision believe.
 *
 * Both halves were once internally consistent and disagreed with each other by
 * a y flip, so the map was painted MIRRORED about the viewport's horizontal
 * centre line relative to its own hit-testing: hovering a visible hub hit
 * nothing, and the hub was pickable at its mirror image. Every unit test
 * passed, because each half only ever tested itself.
 *
 * `shaders.projectToClip` is a line-for-line TypeScript mirror of the GLSL
 * function (the GLSL carries a comment saying so). This file asserts the two
 * halves land on the SAME CSS PIXEL across a grid of world points, cameras and
 * viewports — which is only true while the whole system agrees that world +y
 * is screen DOWN. If someone reintroduces a flip on either side, this fails.
 */

import { describe, expect, it } from 'vitest'

import { worldToScreen } from '../camera'
import { projectToClip } from '../shaders'
import type { CameraState, Viewport } from '../types'

/**
 * Clip space → CSS pixel, i.e. what the GPU's viewport transform does to
 * `gl_Position` after the vertex shader. Clip y points UP, screen y points
 * DOWN, which is why the y term is `1 - clip.y`.
 */
function clipToPixel(
  clip: { x: number; y: number },
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x: ((clip.x + 1) / 2) * viewport.width,
    y: ((1 - clip.y) / 2) * viewport.height,
  }
}

const VIEWPORTS: Viewport[] = [
  { width: 1200, height: 800, dpr: 2 },
  { width: 375, height: 812, dpr: 3 },
  { width: 1920, height: 1080, dpr: 1 },
]

const CAMERAS: CameraState[] = [
  { x: 0, y: 0, k: 1 },
  { x: 512, y: 512, k: 0.37 },
  { x: -9012.5, y: 33.125, k: 12 },
  { x: 1e5, y: -7e4, k: 0.05 },
]

/** Tile origins, including one far from the world origin (the float64 case). */
const TILE_ORIGINS = [
  { ox: 0, oy: 0 },
  { ox: -256, oy: 768 },
  { ox: 1e5, oy: -7e4 },
]

describe('shaders.projectToClip mirrors camera.worldToScreen', () => {
  it('lands on the same CSS pixel for a grid of world points, cameras and viewports', () => {
    let checked = 0
    for (const viewport of VIEWPORTS) {
      for (const camera of CAMERAS) {
        for (const { ox, oy } of TILE_ORIGINS) {
          // What the renderer narrows to Float32 and uploads as uTileOffset.
          const tileOffsetX = ox - camera.x
          const tileOffsetY = oy - camera.y

          for (let gx = -2; gx <= 2; gx++) {
            for (let gy = -2; gy <= 2; gy++) {
              // Tile-local position; the world point is origin + local.
              const localX = gx * 37.5
              const localY = gy * 37.5
              const worldX = ox + localX
              const worldY = oy + localY

              const gpu = clipToPixel(
                projectToClip(
                  localX,
                  localY,
                  tileOffsetX,
                  tileOffsetY,
                  camera.k,
                  viewport.width,
                  viewport.height,
                ),
                viewport,
              )
              const cpu = worldToScreen(camera, viewport, worldX, worldY)

              expect(gpu.x).toBeCloseTo(cpu.x, 6)
              expect(gpu.y).toBeCloseTo(cpu.y, 6)
              checked++
            }
          }
        }
      }
    }
    expect(checked).toBe(VIEWPORTS.length * CAMERAS.length * TILE_ORIGINS.length * 25)
  })

  it('puts a larger world y FURTHER DOWN the screen on both sides', () => {
    // The one statement the whole defect came down to. Asserted on both halves
    // so neither can be flipped back on its own and still look self-consistent.
    const viewport: Viewport = { width: 800, height: 600, dpr: 1 }
    const camera: CameraState = { x: 0, y: 0, k: 2 }

    const above = worldToScreen(camera, viewport, 0, -50)
    const below = worldToScreen(camera, viewport, 0, 50)
    expect(above.y).toBeLessThan(viewport.height / 2)
    expect(below.y).toBeGreaterThan(viewport.height / 2)

    // Same two points through the GLSL mirror (camera at the origin, so the
    // tile offset is zero and local y IS world y).
    const gpuAbove = clipToPixel(
      projectToClip(0, -50, 0, 0, camera.k, viewport.width, viewport.height),
      viewport,
    )
    const gpuBelow = clipToPixel(
      projectToClip(0, 50, 0, 0, camera.k, viewport.width, viewport.height),
      viewport,
    )
    expect(gpuAbove.y).toBeLessThan(viewport.height / 2)
    expect(gpuBelow.y).toBeGreaterThan(viewport.height / 2)
    expect(gpuAbove.y).toBeCloseTo(above.y, 6)
    expect(gpuBelow.y).toBeCloseTo(below.y, 6)
  })

  it('maps the camera centre to the viewport centre', () => {
    for (const viewport of VIEWPORTS) {
      for (const camera of CAMERAS) {
        const clip = projectToClip(
          camera.x,
          camera.y,
          -camera.x,
          -camera.y,
          camera.k,
          viewport.width,
          viewport.height,
        )
        expect(clip.x).toBeCloseTo(0, 9)
        expect(clip.y).toBeCloseTo(0, 9)
        const px = clipToPixel(clip, viewport)
        expect(px.x).toBeCloseTo(viewport.width / 2, 6)
        expect(px.y).toBeCloseTo(viewport.height / 2, 6)
      }
    }
  })
})
