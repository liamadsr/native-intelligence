// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  fitWithin,
  getCustomBackground,
  getEffectiveBackground,
  setCustomBackground,
  hasAnyCustomBackground,
  applyCustomBackgroundVars,
  cssVarFor,
  CUSTOM_BG_LIGHT_KEY,
  CUSTOM_BG_DARK_KEY,
  CUSTOM_BG_LIGHT_VAR,
  CUSTOM_BG_DARK_VAR,
  MAX_DIMENSION,
  BackgroundImageError,
} from '../custom-background'

const SAMPLE = 'data:image/jpeg;base64,AAAA'
const SAMPLE2 = 'data:image/jpeg;base64,BBBB'

describe('fitWithin — downscale math', () => {
  it('does not upscale images already within bounds', () => {
    expect(fitWithin(800, 600, MAX_DIMENSION)).toEqual({ width: 800, height: 600 })
  })

  it('scales a wide image so its longest edge equals max', () => {
    const { width, height } = fitWithin(5120, 2880, 2560)
    expect(width).toBe(2560)
    expect(height).toBe(1440)
  })

  it('scales a tall image so its longest edge equals max', () => {
    const { width, height } = fitWithin(1000, 4000, 2000)
    expect(height).toBe(2000)
    expect(width).toBe(500)
  })

  it('never returns a zero dimension for extreme aspect ratios', () => {
    const { width, height } = fitWithin(10000, 1, 2560)
    expect(width).toBe(2560)
    expect(height).toBeGreaterThanOrEqual(1)
  })

  it('falls back to a square for degenerate (0) input', () => {
    expect(fitWithin(0, 0, 2560)).toEqual({ width: 2560, height: 2560 })
  })
})

describe('cssVarFor', () => {
  it('maps modes to the right CSS variable', () => {
    expect(cssVarFor('light')).toBe(CUSTOM_BG_LIGHT_VAR)
    expect(cssVarFor('dark')).toBe(CUSTOM_BG_DARK_VAR)
  })
})

describe('getEffectiveBackground — cross-mode fallback', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('style')
  })

  it('returns null when nothing is uploaded', () => {
    expect(getEffectiveBackground('light')).toBeNull()
    expect(getEffectiveBackground('dark')).toBeNull()
  })

  it('uses the mode’s own image when present', () => {
    setCustomBackground('light', SAMPLE)
    setCustomBackground('dark', SAMPLE2)
    expect(getEffectiveBackground('light')).toBe(SAMPLE)
    expect(getEffectiveBackground('dark')).toBe(SAMPLE2)
  })

  it('borrows the other mode’s image when this mode has none', () => {
    setCustomBackground('light', SAMPLE)
    expect(getEffectiveBackground('dark')).toBe(SAMPLE)

    window.localStorage.clear()
    setCustomBackground('dark', SAMPLE2)
    expect(getEffectiveBackground('light')).toBe(SAMPLE2)
  })
})

describe('custom background persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('style')
  })

  it('returns null for a mode with nothing stored', () => {
    expect(getCustomBackground('light')).toBeNull()
    expect(getCustomBackground('dark')).toBeNull()
    expect(hasAnyCustomBackground()).toBe(false)
  })

  it('round-trips a stored data URL and applies it to BOTH mode vars (single-image fallback)', () => {
    setCustomBackground('light', SAMPLE)
    expect(getCustomBackground('light')).toBe(SAMPLE)
    expect(window.localStorage.getItem(CUSTOM_BG_LIGHT_KEY)).toBe(SAMPLE)
    // A single upload applies to both modes: light var is the image, and dark
    // borrows it via fallback. CSS var wraps the data URL in url("…").
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_LIGHT_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_DARK_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
  })

  it('keeps light and dark STORAGE independent (only the render falls back)', () => {
    setCustomBackground('dark', SAMPLE)
    expect(getCustomBackground('dark')).toBe(SAMPLE)
    // Stored light slot stays empty (UI shows an empty light slot)...
    expect(getCustomBackground('light')).toBeNull()
    expect(window.localStorage.getItem(CUSTOM_BG_DARK_KEY)).toBe(SAMPLE)
    // ...even though the effective/rendered light image falls back to dark's.
    expect(getEffectiveBackground('light')).toBe(SAMPLE)
    expect(hasAnyCustomBackground()).toBe(true)
  })

  it('a distinct image per mode overrides the fallback', () => {
    setCustomBackground('light', SAMPLE)
    setCustomBackground('dark', SAMPLE2)
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_LIGHT_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_DARK_VAR)).toBe(
      `url("${SAMPLE2}")`,
    )
  })

  it('clearing the only image removes the key and BOTH CSS vars', () => {
    setCustomBackground('light', SAMPLE)
    setCustomBackground('light', null)
    expect(getCustomBackground('light')).toBeNull()
    expect(window.localStorage.getItem(CUSTOM_BG_LIGHT_KEY)).toBeNull()
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_LIGHT_VAR)).toBe('')
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_DARK_VAR)).toBe('')
  })

  it('clearing one of two images reverts the cleared mode to the remaining image', () => {
    setCustomBackground('light', SAMPLE)
    setCustomBackground('dark', SAMPLE2)
    // Remove the dark override → dark should now borrow the light image.
    setCustomBackground('dark', null)
    expect(getCustomBackground('dark')).toBeNull()
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_DARK_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_LIGHT_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
  })

  it('applyCustomBackgroundVars applies a single stored image to both vars', () => {
    window.localStorage.setItem(CUSTOM_BG_DARK_KEY, SAMPLE)
    // A stale light var should be replaced by the fallback (dark's image).
    document.documentElement.style.setProperty(CUSTOM_BG_LIGHT_VAR, 'url("stale")')

    applyCustomBackgroundVars()

    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_DARK_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
    expect(document.documentElement.style.getPropertyValue(CUSTOM_BG_LIGHT_VAR)).toBe(
      `url("${SAMPLE}")`,
    )
  })

  it('surfaces a typed error when the quota is exceeded', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    try {
      expect(() => setCustomBackground('light', SAMPLE)).toThrow(BackgroundImageError)
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
