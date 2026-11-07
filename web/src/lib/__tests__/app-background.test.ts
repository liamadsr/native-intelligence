// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  availableBackgrounds,
  backgrounds,
  getBackgroundById,
  getStoredBackgroundId,
  applyBackground,
  reconcileCustomBackground,
  BACKGROUND_STORAGE_KEY,
  DEFAULT_BACKGROUND_ID,
  CUSTOM_BACKGROUND_ID,
  GLASS_BACKGROUND_ID,
  isGlassBackground,
} from '../app-background'
import { setCustomBackground, CUSTOM_BG_LIGHT_KEY } from '../custom-background'

const SAMPLE = 'data:image/jpeg;base64,AAAA'

describe('background catalog', () => {
  it('includes custom and none options, with no built-in photo', () => {
    const ids = backgrounds.map((b) => b.id)
    expect(ids).toContain(CUSTOM_BACKGROUND_ID)
    expect(ids).toContain('none')
    expect(ids).not.toContain('photo')
  })

  it('marks the custom option with the "custom" image sentinel', () => {
    expect(getBackgroundById(CUSTOM_BACKGROUND_ID)?.images).toBe('custom')
  })
})

describe('applyBackground + getStoredBackgroundId', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-bg')
  })

  it('defaults to none when nothing is stored', () => {
    expect(getStoredBackgroundId()).toBe(DEFAULT_BACKGROUND_ID)
  })

  it('falls back to the default when a removed option id is stored', () => {
    // Users who had the retired built-in 'photo' background stored.
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, 'photo')
    expect(getStoredBackgroundId()).toBe(DEFAULT_BACKGROUND_ID)
  })

  it('reflects the choice onto data-app-bg', () => {
    applyBackground(CUSTOM_BACKGROUND_ID)
    expect(document.documentElement.getAttribute('data-app-bg')).toBe(CUSTOM_BACKGROUND_ID)
    expect(getStoredBackgroundId()).toBe(CUSTOM_BACKGROUND_ID)
  })

  it('does not persist the default (removes the key)', () => {
    applyBackground(CUSTOM_BACKGROUND_ID)
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe(CUSTOM_BACKGROUND_ID)
    applyBackground(DEFAULT_BACKGROUND_ID)
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
  })

  it('ignores unknown ids and falls back to default', () => {
    applyBackground('bogus')
    expect(document.documentElement.getAttribute('data-app-bg')).toBe(DEFAULT_BACKGROUND_ID)
  })
})

describe('reconcileCustomBackground', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-bg')
  })

  it('is a no-op when custom is not the active choice', () => {
    applyBackground('none')
    expect(reconcileCustomBackground()).toBe('none')
  })

  it('keeps custom active when at least one image exists', () => {
    setCustomBackground('light', SAMPLE)
    applyBackground(CUSTOM_BACKGROUND_ID)
    expect(reconcileCustomBackground()).toBe(CUSTOM_BACKGROUND_ID)
    expect(document.documentElement.getAttribute('data-app-bg')).toBe(CUSTOM_BACKGROUND_ID)
  })

  it('falls back to default when custom is active but both images are gone', () => {
    // Simulate: custom was chosen, then the user removed the last image.
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, CUSTOM_BACKGROUND_ID)
    window.localStorage.removeItem(CUSTOM_BG_LIGHT_KEY)
    expect(reconcileCustomBackground()).toBe(DEFAULT_BACKGROUND_ID)
    expect(document.documentElement.getAttribute('data-app-bg')).toBe(DEFAULT_BACKGROUND_ID)
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
  })
})

describe('Glass (desktop only)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-bg')
  })
  afterEach(() => {
    delete window.__TAURI_INTERNALS__
  })

  it('is offered only in the desktop app', () => {
    const web = availableBackgrounds(false).map((b) => b.id)
    const desktop = availableBackgrounds(true).map((b) => b.id)
    expect(web).not.toContain(GLASS_BACKGROUND_ID)
    expect(desktop).toContain(GLASS_BACKGROUND_ID)
    expect(desktop).toHaveLength(backgrounds.length)
  })

  it('falls back to the default in a browser, stored or applied', () => {
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, GLASS_BACKGROUND_ID)
    expect(getStoredBackgroundId()).toBe(DEFAULT_BACKGROUND_ID)
    applyBackground(GLASS_BACKGROUND_ID)
    expect(document.documentElement.getAttribute('data-app-bg')).toBe(DEFAULT_BACKGROUND_ID)
  })

  it('sticks in the desktop app', () => {
    window.__TAURI_INTERNALS__ = {}
    applyBackground(GLASS_BACKGROUND_ID)
    expect(document.documentElement.getAttribute('data-app-bg')).toBe(GLASS_BACKGROUND_ID)
    expect(getStoredBackgroundId()).toBe(GLASS_BACKGROUND_ID)
  })

  it('is not offered or honoured in the Windows app (its window can’t see through)', () => {
    window.__TAURI_INTERNALS__ = {}
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true })
    try {
      expect(availableBackgrounds().map((b) => b.id)).not.toContain(GLASS_BACKGROUND_ID)
      applyBackground(GLASS_BACKGROUND_ID)
      expect(document.documentElement.getAttribute('data-app-bg')).toBe(DEFAULT_BACKGROUND_ID)
    } finally {
      delete (navigator as { userAgent?: string }).userAgent
    }
  })

  it('sits next to the Sky', () => {
    const ids = availableBackgrounds(true).map((b) => b.id)
    expect(ids.indexOf(GLASS_BACKGROUND_ID)).toBe(ids.indexOf('sky') + 1)
  })

  it('is not the default, even in the desktop app: the Sky is', () => {
    window.__TAURI_INTERNALS__ = {}
    expect(getStoredBackgroundId()).toBe(DEFAULT_BACKGROUND_ID)
    expect(DEFAULT_BACKGROUND_ID).toBe('sky')
  })

  it('the retired Clear option falls back to the default', () => {
    window.__TAURI_INTERNALS__ = {}
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, 'clear')
    expect(getStoredBackgroundId()).toBe(DEFAULT_BACKGROUND_ID)
  })

  it('isGlassBackground names only Glass', () => {
    expect(isGlassBackground(GLASS_BACKGROUND_ID)).toBe(true)
    expect(isGlassBackground('clear')).toBe(false)
    expect(isGlassBackground('sky')).toBe(false)
    expect(isGlassBackground(null)).toBe(false)
  })
})
