/**
 * App background preference for Native Intelligence.
 *
 * The dashboard shell can paint a photo behind the header + chat strip (see
 * `dashboard-shell.tsx`). The default is no photo (the flat `bg-sidebar`
 * surface); the user can upload their own image(s) — persisted in localStorage
 * and reflected onto `<html data-app-bg="...">` so plain CSS in the shell can
 * react to it without threading React state through the tree.
 *
 * The `custom` option is backed by `custom-background.ts`, which stores the
 * uploaded image(s) as data URLs in localStorage and exposes them to the shell
 * as CSS variables. Adding a built-in photo option = add an entry to
 * `backgrounds` with matching `light`/`dark` image paths in /public, plus a CSS
 * rule in tailwind.css keyed on `[data-app-bg='<id>']`. The early-apply script
 * in `theme-script.tsx` reads the same key, so new options need no changes there.
 */

import { getCustomBackground } from './custom-background'
import { desktopOS } from './platform'

export interface BackgroundDefinition {
  id: string
  name: string
  description: string
  /**
   * How the option gets its image:
   * - `{ light, dark }` — fixed asset paths in /public (built-in photos).
   * - `null` — no photo (flat surface).
   * - `'custom'` — user-uploaded images, read from CSS vars (see custom-background.ts).
   * - `'sky'` — the live sky (components/sky): time of day and weather where you are.
   * - `'window'` — no image: the desktop window itself turns see-through
   *   (Glass, window-backdrop.ts), so the page floats over the desktop.
   */
  images: { light: string; dark: string } | null | 'custom' | 'sky' | 'window'
  /** Only offered (and only honoured) inside the Mac app: the Windows app
   *  can't make its window see-through. */
  desktopOnly?: boolean
}

/** The id of the user-uploaded background option. */
export const CUSTOM_BACKGROUND_ID = 'custom'

/** The id of the live sky (components/sky/sky-canvas.tsx). */
export const SKY_BACKGROUND_ID = 'sky'

/** See-through window: macOS frosted glass behind the page, its strength on
 * the Opacity slider (window-backdrop.ts). Desktop only. */
export const GLASS_BACKGROUND_ID = 'glass'

/** Whether `id` is Glass, the background that makes the desktop window see-through. */
export function isGlassBackground(id: string | null | undefined): boolean {
  return id === GLASS_BACKGROUND_ID
}

export const backgrounds: BackgroundDefinition[] = [
  {
    id: SKY_BACKGROUND_ID,
    name: 'Sky',
    description: 'The sky where you are: time of day and live weather',
    images: 'sky',
  },
  {
    id: GLASS_BACKGROUND_ID,
    name: 'Glass',
    description: 'See through the window to what’s behind it',
    images: 'window',
    desktopOnly: true,
  },
  {
    id: 'none',
    name: 'None',
    description: 'Flat solid surface',
    images: null,
  },
  {
    id: CUSTOM_BACKGROUND_ID,
    name: 'Custom',
    description: 'Upload your own',
    images: 'custom',
  },
]

/** The options this platform can show: Glass only in the Mac app. */
export function availableBackgrounds(desktop: boolean = desktopOS() === 'macos'): BackgroundDefinition[] {
  return desktop ? backgrounds : backgrounds.filter((b) => !b.desktopOnly)
}

/** A known id this platform can honour (Glass only in the Mac app). */
function isUsableBackground(id: string): boolean {
  const bg = getBackgroundById(id)
  return !!bg && (!bg.desktopOnly || desktopOS() === 'macos')
}

export const BACKGROUND_STORAGE_KEY = 'ni-app-background'

/** The id used when nothing is stored yet. A stale stored id from a removed
 * option (e.g. the old built-in 'photo') fails `getBackgroundById` and falls
 * back here too. */
export const DEFAULT_BACKGROUND_ID = SKY_BACKGROUND_ID

export function getBackgroundById(id: string): BackgroundDefinition | undefined {
  return backgrounds.find((b) => b.id === id)
}

export function getStoredBackgroundId(): string {
  if (typeof window === 'undefined') return DEFAULT_BACKGROUND_ID
  const stored = localStorage.getItem(BACKGROUND_STORAGE_KEY)
  if (stored && isUsableBackground(stored)) return stored
  return DEFAULT_BACKGROUND_ID
}

/**
 * Apply a background choice: reflect it onto `<html data-app-bg>` and persist.
 * The shell's CSS keys off the attribute, so this is all that's needed.
 */
export function applyBackground(id: string) {
  const bg = isUsableBackground(id) ? id : DEFAULT_BACKGROUND_ID
  document.documentElement.setAttribute('data-app-bg', bg)

  if (bg === DEFAULT_BACKGROUND_ID) {
    localStorage.removeItem(BACKGROUND_STORAGE_KEY)
  } else {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, bg)
  }
}

/**
 * If the active background is `custom` but the user has cleared BOTH uploaded
 * images, fall back to the default so the shell doesn't render an empty custom
 * option. Returns the id that ended up active. Call after clearing an image.
 */
export function reconcileCustomBackground(): string {
  if (typeof window === 'undefined') return DEFAULT_BACKGROUND_ID
  const current = getStoredBackgroundId()
  if (current !== CUSTOM_BACKGROUND_ID) return current
  const hasAny =
    getCustomBackground('light') !== null || getCustomBackground('dark') !== null
  if (!hasAny) {
    applyBackground(DEFAULT_BACKGROUND_ID)
    return DEFAULT_BACKGROUND_ID
  }
  return current
}
