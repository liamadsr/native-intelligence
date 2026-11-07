/**
 * Whether the app's sky reads light or dark where the chat's text sits, so
 * what sits right on it (the chat's day lines, a message's time, a reply's
 * hook: chat-day-line.tsx, thread-hook.tsx) takes an ink that shows on it
 * (Liam, 10-18: the hook's light line vanished on the light sky in dark mode;
 * the time's dark pill looked odd). The theme alone can't say: the app's sky
 * is the weather, light by day and deep blue at night in the light theme,
 * and in the dark theme the same weather exposed for the dark (scene.ts
 * darkExposure), deep by day too. Pure.
 *
 * The SkyController marks <html data-sky-tone="light|dark"> whenever its
 * scene changes; tailwind.css turns that into `--sky-ink`. No mark (no sky:
 * a test, a page without one) leaves the theme's muted foreground.
 */
import { luminance, mix, type Rgb } from './palette'
import type { SkyScene } from './scene'

export type SkyTone = 'light' | 'dark'

/** <html>'s attribute (`data-sky-tone`). */
export const SKY_TONE_ATTR = 'skyTone'

/**
 * The tone of the sky as shown mid-screen: halfway from the zenith to the
 * horizon, mixed over the surface at the scene's strength (as the shader
 * mixes it), dark under half luminance.
 */
export function skyTone(scene: Pick<SkyScene, 'top' | 'horizon' | 'strength'>, surface: Rgb): SkyTone {
  const shown = mix(surface, mix(scene.top, scene.horizon, 0.5), scene.strength)
  return luminance(shown) < 0.5 ? 'dark' : 'light'
}

/** Mark <html> with the tone (only when it changed: one attribute write, no layout). */
export function markSkyTone(tone: SkyTone | null): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (tone === null) {
    delete root.dataset[SKY_TONE_ATTR]
    return
  }
  if (root.dataset[SKY_TONE_ATTR] !== tone) root.dataset[SKY_TONE_ATTR] = tone
}
