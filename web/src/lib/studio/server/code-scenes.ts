// The one switch for code scenes on the app's side (scenes.ts, scene-place.ts, ops.ts, the editor's bootstrap), kept
// apart from the compiler so reading it loads nothing heavy. The Studio worker reads the same setting the same way.
import { StudioError } from './errors'

/**
 * Whether code scenes are on here: STUDIO_CODE_SCENES `on` or `off` (also 1/0, true/false, yes/no); anything else,
 * or unset, is on outside production and off with NODE_ENV=production. The Studio worker reads the same setting the
 * same way for its renders. Off, nothing writes a scene or puts one on a video, and the editor draws code layers as
 * labelled boxes without loading their code; reading scenes, and opening, saving or trimming a video that has one,
 * still work. Pure over the env.
 */
export function codeScenesOn(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.STUDIO_CODE_SCENES ?? '').trim().toLowerCase()
  if (['on', '1', 'true', 'yes'].includes(value)) return true
  if (['off', '0', 'false', 'no'].includes(value)) return false
  return env.NODE_ENV !== 'production'
}

/** What a write of a scene answers where code scenes are off (403 NOT_SET_UP, as a provider not set up does). */
export const CODE_SCENES_OFF = 'Code scenes are off on this server.'

/** Refuse (403 NOT_SET_UP) where code scenes are off. */
export function requireCodeScenes(env: Record<string, string | undefined> = process.env): void {
  if (!codeScenesOn(env)) throw new StudioError(CODE_SCENES_OFF, 403, 'NOT_SET_UP')
}
