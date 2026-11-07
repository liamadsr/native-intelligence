/**
 * Custom user-uploaded backgrounds for the app shell.
 *
 * Users can upload their own light and/or dark background image (each optional)
 * in Preferences → Background. This is a LOCAL preference — like theme, style,
 * and the built-in background choice, it lives entirely in the browser with no
 * server involvement, so it does not sync across devices.
 *
 * Storage model
 * -------------
 * The uploaded image is downscaled + re-encoded (see `processBackgroundFile`)
 * to a compact data URL, then stored in localStorage. We use a data URL (not an
 * object URL or IndexedDB blob) for one reason: the pre-hydration inline script
 * in `theme-script.tsx` must apply the background SYNCHRONOUSLY before first
 * paint to avoid a flash, and only localStorage is readable synchronously there.
 *
 * localStorage has a ~5 MB per-origin budget, so raw multi-megabyte photos will
 * not fit. `processBackgroundFile` resizes to `MAX_DIMENSION` and encodes as
 * JPEG at `JPEG_QUALITY`, which keeps a full-screen photo comfortably under
 * ~600 KB — both a light and a dark image fit together with room to spare.
 *
 * The stored data URLs are surfaced to the shell as CSS custom properties
 * (`--app-bg-custom-light` / `--app-bg-custom-dark`) on <html>, which the
 * shell's `custom` background layers reference. See `app-background.ts` for the
 * choice/apply layer and `dashboard-shell.tsx` for the layers.
 */

export const CUSTOM_BG_LIGHT_KEY = 'dial8-app-background-custom-light'
export const CUSTOM_BG_DARK_KEY = 'dial8-app-background-custom-dark'

/** CSS custom properties the shell reads for the custom background image. */
export const CUSTOM_BG_LIGHT_VAR = '--app-bg-custom-light'
export const CUSTOM_BG_DARK_VAR = '--app-bg-custom-dark'

export type BackgroundMode = 'light' | 'dark'

/** Longest edge (px) the uploaded image is resized down to before encoding.
 *  Large enough to look crisp full-bleed on a hi-dpi display, small enough to
 *  keep the encoded data URL within the localStorage budget. */
export const MAX_DIMENSION = 2560

/** JPEG quality for the re-encode. 0.82 is visually near-lossless for a photo
 *  backdrop while cutting size dramatically vs. the original PNG. */
const JPEG_QUALITY = 0.82

/** Reject files larger than this up front (before decode) — a guardrail against
 *  someone selecting a huge raw image that would be slow to decode. The output
 *  is always re-compressed regardless, so this only bounds the input. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024 // 20 MB

/** Hard ceiling on the ENCODED data URL we're willing to persist. If the
 *  re-encoded image still exceeds this, we refuse rather than risk blowing the
 *  localStorage quota (which throws and could wedge other preferences). */
const MAX_ENCODED_BYTES = 2 * 1024 * 1024 // ~2 MB of data-URL string

const ACCEPTED_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export class BackgroundImageError extends Error {}

function storageKeyFor(mode: BackgroundMode): string {
  return mode === 'dark' ? CUSTOM_BG_DARK_KEY : CUSTOM_BG_LIGHT_KEY
}

export function cssVarFor(mode: BackgroundMode): string {
  return mode === 'dark' ? CUSTOM_BG_DARK_VAR : CUSTOM_BG_LIGHT_VAR
}

/** Read the stored data URL for a mode, or null if none is set. */
export function getCustomBackground(mode: BackgroundMode): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(storageKeyFor(mode)) || null
  } catch {
    return null
  }
}

/** True if the user has uploaded at least one custom image (light or dark). */
export function hasAnyCustomBackground(): boolean {
  return getCustomBackground('light') !== null || getCustomBackground('dark') !== null
}

/**
 * The image a mode should actually RENDER, with cross-mode fallback: if this
 * mode has no upload, it borrows the other mode's image. So a single uploaded
 * image applies to both light and dark, while uploading a distinct image per
 * mode overrides per mode. Returns null only when nothing is uploaded at all.
 *
 * This is intentionally separate from `getCustomBackground` (which returns only
 * what's stored FOR that slot) so the preferences UI can still show an empty
 * slot for the mode the user hasn't set, even though it renders the shared image.
 */
export function getEffectiveBackground(mode: BackgroundMode): string | null {
  const own = getCustomBackground(mode)
  if (own) return own
  const other: BackgroundMode = mode === 'dark' ? 'light' : 'dark'
  return getCustomBackground(other)
}

/**
 * Sync BOTH custom CSS vars to the effective (fallback-aware) images. Idempotent;
 * this is the single place that maps stored uploads → rendered vars, so the
 * one-image-for-both-modes rule lives in exactly one spot. Safe to call on mount
 * to reconcile with whatever the pre-hydration script set.
 */
export function applyCustomBackgroundVars() {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  for (const mode of ['light', 'dark'] as BackgroundMode[]) {
    const dataUrl = getEffectiveBackground(mode)
    const cssVar = cssVarFor(mode)
    if (dataUrl) {
      // CSS url() needs the value quoted; data URLs contain no quotes so this is safe.
      root.style.setProperty(cssVar, `url("${dataUrl}")`)
    } else {
      root.style.removeProperty(cssVar)
    }
  }
}

/**
 * Persist a processed data URL for a mode (or clear it with null), then
 * re-derive both CSS vars so the cross-mode fallback stays correct — e.g.
 * uploading only light must also point the dark var at that light image.
 */
export function setCustomBackground(mode: BackgroundMode, dataUrl: string | null) {
  if (typeof window === 'undefined') return
  const key = storageKeyFor(mode)

  if (dataUrl) {
    try {
      localStorage.setItem(key, dataUrl)
    } catch {
      // Quota exceeded (or storage disabled). Surface a typed error so the UI
      // can tell the user rather than silently dropping the upload.
      throw new BackgroundImageError(
        "Couldn't save this image — it may be too large. Try a smaller file.",
      )
    }
  } else {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }

  // Re-derive both vars from the new stored state (handles fallback in one place).
  applyCustomBackgroundVars()
}

/**
 * Decode an uploaded image file, downscale it so its longest edge is at most
 * `MAX_DIMENSION`, re-encode as JPEG, and return a compact data URL suitable
 * for localStorage. Throws `BackgroundImageError` with a user-facing message on
 * any failure (bad type, too large, decode failure, still-too-big after encode).
 *
 * Browser-only (uses Image / canvas). Do not call on the server.
 */
export async function processBackgroundFile(file: File): Promise<string> {
  if (!file.type || !file.type.startsWith('image/')) {
    throw new BackgroundImageError('Please choose an image file.')
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new BackgroundImageError('That image is too large. Please choose one under 20 MB.')
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await loadImage(objectUrl)

    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, MAX_DIMENSION)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new BackgroundImageError("Couldn't process this image. Please try another.")
    }
    // Fill white behind the image so images with transparency (PNG/WebP/GIF)
    // don't come out with black boxes when flattened into an opaque JPEG.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    if (!dataUrl.startsWith('data:image/jpeg')) {
      // Some browsers fall back to PNG if JPEG encoding isn't supported for the
      // input; that's fine functionally, only the size guard below matters.
    }
    if (dataUrl.length > MAX_ENCODED_BYTES) {
      throw new BackgroundImageError(
        'That image is too detailed to save. Please try a smaller or simpler image.',
      )
    }
    return dataUrl
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () =>
      reject(new BackgroundImageError("Couldn't read this image. Please try another file."))
    img.src = src
  })
}

/**
 * Compute the largest width/height that fits `w`x`h` within a `max`-px square
 * without upscaling. Returns integer dimensions.
 */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: max, height: max }
  const scale = Math.min(1, max / Math.max(w, h))
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}
