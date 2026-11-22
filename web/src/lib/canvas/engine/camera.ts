/** The camera: where the view is on the canvas and how far in. screen = world * scale + (x, y). */
import { LIMITS } from './defaults'
import type { Box, Point } from './geometry'

export interface Camera {
  x: number
  y: number
  scale: number
}
export const INITIAL_CAMERA: Camera = { x: 0, y: 0, scale: 1 }
export const ZOOM_STEP = 1.2
export const ZOOM_PRESETS = [0.25, 0.5, 1, 2] as const

export const clampScale = (s: number): number => Math.min(LIMITS.maxScale, Math.max(LIMITS.minScale, s))

export const toWorld = (cam: Camera, screen: Point): Point => ({ x: (screen.x - cam.x) / cam.scale, y: (screen.y - cam.y) / cam.scale })
export const toScreen = (cam: Camera, world: Point): Point => ({ x: world.x * cam.scale + cam.x, y: world.y * cam.scale + cam.y })

/** Zoom to a scale, keeping the world point under a screen point where it is. */
export function zoomAt(cam: Camera, screen: Point, nextScale: number): Camera {
  const scale = clampScale(nextScale)
  const world = toWorld(cam, screen)
  return { scale, x: screen.x - world.x * scale, y: screen.y - world.y * scale }
}

/** A wheel's zoom: exponential in the wheel distance, capped per event so one notch is never a jump. */
export function wheelZoom(cam: Camera, screen: Point, deltaY: number): Camera {
  const exponent = Math.max(-0.6, Math.min(0.6, -deltaY * 0.01))
  return zoomAt(cam, screen, cam.scale * Math.exp(exponent))
}

export const panBy = (cam: Camera, dx: number, dy: number): Camera => ({ ...cam, x: cam.x + dx, y: cam.y + dy })

/** The part of the canvas a view of this size shows. */
export function viewBox(cam: Camera, width: number, height: number): Box {
  return { x: (0 - cam.x) / cam.scale + 0, y: (0 - cam.y) / cam.scale + 0, w: width / cam.scale, h: height / cam.scale }
}

/**
 * The camera that shows a box whole, centered. The margin is about 100 px a
 * side and never more than a quarter of the view. Never zooms in past 100%
 * unless `maxScale` says so.
 */
export function fitBox(box: Box | null, width: number, height: number, maxScale = 1): Camera {
  if (!box || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, scale: 1 }
  const mx = Math.min(100, width / 4)
  const my = Math.min(100, height / 4)
  const scale = clampScale(Math.min(maxScale, (width - mx * 2) / Math.max(box.w, 1), (height - my * 2) / Math.max(box.h, 1)))
  return { scale, x: width / 2 - (box.x + box.w / 2) * scale, y: height / 2 - (box.y + box.h / 2) * scale }
}

/**
 * The dot grid at a zoom: the spacing levels (1, 4, 16, 64… world units)
 * worth drawing, each with how strongly. A level whose dots would sit closer
 * than 4 px is left out; the next one up fades in as it opens out.
 */
export function gridLevels(scale: number): Array<{ step: number; opacity: number }> {
  const out: Array<{ step: number; opacity: number }> = []
  for (let step = 1; step <= 65536; step *= 4) {
    const px = step * scale
    if (px < 4) continue
    // Fully there from 16 px apart; fading in between 4 and 16.
    const opacity = Math.min(1, (px - 4) / 12)
    out.push({ step, opacity })
    if (out.length === 2) break
  }
  return out
}

/** The smallest grid step that shows at this zoom: what "auto" snapping snaps to. */
export function visibleGridStep(scale: number): number {
  return gridLevels(scale)[0]?.step ?? 1
}
