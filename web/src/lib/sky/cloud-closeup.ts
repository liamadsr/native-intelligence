/**
 * Where the shader's clouds sit: close up, as if a camera looking ahead were
 * zoomed in on one part of a cloud (Liam, 10-18: the miles of distant cloud
 * on a receding layer read as a hue with no texture; up close you see the
 * cloud's own texture and how the light plays on it). No perspective: the
 * cloud fills the screen face on, in screen-height units, so its billows are
 * large enough to show their relief, and pieces of it drift across with the
 * wind.
 *
 * Two layers give it depth. The front one is the near cloud: large billows,
 * full contrast, drifting fastest. The back one is farther off: smaller,
 * slower (parallax) and softened toward the sky behind it, so the gaps in the
 * front cloud show more cloud beyond instead of a flat fill.
 *
 * Light comes from the sun's side of the screen (toward the sun's position,
 * off screen or not), broadly from above under a full deck, and once the sun
 * is down from below (the twilight glow, then the city's skyglow), so the
 * billows facing it are lit and the far sides fall into shade. The shader
 * gets that by summing the cloud's density at a few steps toward the light.
 * This module holds the shader's numbers and the same geometry in
 * TypeScript, so it can be checked without a GPU.
 */

import { smoothstep } from './palette'

/**
 * Layer units per unit of the controller's cloud offset (the offset itself
 * moves at the scene's wind, scene.ts cloudDriftSpeed). Kept at 1: the offset
 * is the drift, and each layer takes its own share of it below.
 */
export const CLOUD_DRIFT = 1.0
/**
 * How fast the clouds change shape: the finer noise octaves slide against the
 * coarser by this much per second of motion (the coarsest never moves), so a
 * billow visibly reshapes over a minute or so as it drifts.
 */
export const CLOUD_EVOLVE = 0.016

/**
 * Noise cells per screen height for each layer. The front cloud's largest
 * structures are about a screen tall and its finest billows a twentieth of
 * that; the back layer's are about half the size (farther away).
 */
export const CLOSEUP_FRONT_SCALE = 1.1
export const CLOSEUP_BACK_SCALE = 2.1
/**
 * Screen heights each layer moves per unit of the cloud offset: the front
 * cloud crosses a 16:10 window in a little over half a minute at the usual
 * speed (about what the distant clouds took), the back one at a little over
 * half that pace (parallax).
 */
export const CLOSEUP_FRONT_SPEED = 0.36
export const CLOSEUP_BACK_SPEED = 0.2
/** The domain warp's reach, in noise cells: the billows curl and tear instead of sitting as round blobs. */
export const CLOSEUP_WARP = 0.3
/**
 * Normalises the shader's fbm (gradient noise, from two to six octaves, a
 * standard deviation of about 0.1 at any of them) to a standard deviation of
 * about 1, so the coverage thresholds below read as fractions of the screen.
 */
export const CLOSEUP_FBM_NORM = 10
/**
 * The thin cloud every dry sky shows (scene.veil, BASE_VEIL in a clear sky) as
 * close-up cover: a clear sky's floor of 0.3 is a few translucent wisps over
 * roughly a tenth of the screen; a full veil of high cloud covers most of it,
 * thin and silky.
 */
export const WISP_COVER = 0.7

/**
 * The front cloud's cover for the forecast's cloud cover and the scene's thin
 * cloud: the larger of the two, so a clear sky still has its wisps and the
 * forecast's cloud always wins once there is more of it.
 */
export function closeUpAmount(cloudCover: number, veil: number): number {
  return Math.min(1, Math.max(cloudCover, veil * WISP_COVER, 0))
}

/**
 * The density threshold (in standard deviations of the normalised fbm) above
 * which the front cloud is solid, for a cover of `amount`: roughly the
 * inverse of the normal distribution, so about `amount` of the screen is
 * cloud (a little less at the thin end, so a clear sky stays sparse), and a
 * full deck closes without holes.
 */
export function closeUpThreshold(amount: number): number {
  const a = Math.min(1, Math.max(0, amount))
  return 1.9 * (1 - 2 * a) - 1.5 * smoothstep(0.85, 1, a)
}

/**
 * Seconds for the front cloud to drift across a window of this aspect
 * (width / height) at a cloud offset speed of `offsetPerSecond` (scene.ts
 * windX, cloudDriftSpeed).
 */
export function closeUpCrossingSeconds(offsetPerSecond: number, aspect: number): number {
  const screensPerSecond = Math.abs(offsetPerSecond) * CLOUD_DRIFT * CLOSEUP_FRONT_SPEED
  return screensPerSecond > 0 ? aspect / screensPerSecond : Infinity
}

/**
 * The light's direction on screen at a point (both in screen-height units,
 * y up), as the shader takes it: toward the sun, wherever it is (off screen
 * too); under a full deck (`cloudCover` toward 1) broadly from above; and
 * once the sun is down from below, the way the twilight glow and then the
 * city's skyglow light a cloud's underside. `night` is 0 by day and 1 once
 * the sun is well down.
 */
export function closeUpLightDir(point: [number, number], sun: [number, number], night: number, cloudCover = 0): [number, number] {
  const dx = sun[0] - point[0]
  const dy = sun[1] - point[1]
  const len = Math.hypot(dx, dy) || 1
  const n = Math.min(1, Math.max(0, night))
  let x = (dx / len) * (1 - n)
  let y = (dy / len) * (1 - n) - n
  const up = smoothstep(0.6, 1, cloudCover) * 0.85 * (1 - n)
  x *= 1 - up
  y = y * (1 - up) + up
  const l = Math.hypot(x, y) || 1
  return [x / l, y / l]
}
