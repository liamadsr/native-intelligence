// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_GLASS_OPACITY,
  FULL_GLASS_BLUR,
  GLASS_OPACITY_EVENT,
  GLASS_OPACITY_STORAGE_KEY,
  GLASS_WINDOW_ATTR,
  GLASS_WINDOW_UNSUPPORTED_ATTR,
  WINDOW_TINT_VAR,
  getGlassOpacity,
  glassLayers,
  reflectWindowBackdrop,
  setGlassOpacity,
  setNativeWindowBackdrop,
} from '../window-backdrop'

const root = () => document.documentElement

beforeEach(() => {
  window.localStorage.clear()
  root().removeAttribute(GLASS_WINDOW_ATTR)
  root().removeAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)
  root().style.removeProperty(WINDOW_TINT_VAR)
})
afterEach(() => {
  delete window.__TAURI_INTERNALS__
})

describe('glassLayers', () => {
  it('keeps the blur full across the slider', () => {
    for (const o of [0, 50, 100]) expect(glassLayers(o).blur).toBe(FULL_GLASS_BLUR)
  })

  it('starts at frosted glass, never clearer', () => {
    const lightest = glassLayers(0)
    expect(lightest.tint > 0.4 && lightest.tint < 0.55).toBe(true)
    expect(glassLayers(-50)).toEqual(lightest)
    expect(DEFAULT_GLASS_OPACITY).toBe(30)
    expect(glassLayers(DEFAULT_GLASS_OPACITY).tint > lightest.tint).toBe(true)
  })

  it('only grows more solid, by small steps, up to near solid', () => {
    let prev = glassLayers(0)
    for (let o = 5; o <= 100; o += 5) {
      const cur = glassLayers(o)
      expect(cur.tint >= prev.tint && cur.tint - prev.tint <= 0.035).toBe(true)
      prev = cur
    }
    expect(prev.tint).toBe(0.9)
    expect(glassLayers(500)).toEqual(glassLayers(100))
  })
})

describe('Glass opacity', () => {
  it('defaults to the middle, keeps no key for it, and ignores garbage', () => {
    expect(getGlassOpacity()).toBe(DEFAULT_GLASS_OPACITY)
    setGlassOpacity(40)
    expect(window.localStorage.getItem(GLASS_OPACITY_STORAGE_KEY)).toBe('40')
    setGlassOpacity(DEFAULT_GLASS_OPACITY)
    expect(window.localStorage.getItem(GLASS_OPACITY_STORAGE_KEY)).toBeNull()
    window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, 'lots')
    expect(getGlassOpacity()).toBe(DEFAULT_GLASS_OPACITY)
  })

  it('applies the tint and tells the window', () => {
    const heard = vi.fn()
    window.addEventListener(GLASS_OPACITY_EVENT, heard)
    setGlassOpacity(100)
    window.removeEventListener(GLASS_OPACITY_EVENT, heard)
    expect(heard).toHaveBeenCalled()
    expect(root().style.getPropertyValue(WINDOW_TINT_VAR)).toBe(String(glassLayers(100).tint))
  })
})

describe('setNativeWindowBackdrop', () => {
  it('never calls outside the desktop app', async () => {
    const invoke = vi.fn(async () => {})
    expect(await setNativeWindowBackdrop('glass', 30, true, invoke)).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports the desktop taking it, or refusing it (an older build)', async () => {
    window.__TAURI_INTERNALS__ = {}
    const ok = vi.fn(async () => {})
    expect(await setNativeWindowBackdrop('glass', 12, true, ok)).toBe(true)
    expect(ok).toHaveBeenCalledWith('glass', 12, true)
    const refused = vi.fn(async () => {
      throw new Error('Command set_window_backdrop not found')
    })
    expect(await setNativeWindowBackdrop('glass', 30, false, refused)).toBe(false)
  })
})

describe('reflectWindowBackdrop', () => {
  it('marks the page see-through only once the desktop said yes', () => {
    setGlassOpacity(100)
    reflectWindowBackdrop(true, true)
    expect(root().hasAttribute(GLASS_WINDOW_ATTR)).toBe(true)
    expect(root().style.getPropertyValue(WINDOW_TINT_VAR)).toBe(String(glassLayers(100).tint))
    expect(root().hasAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)).toBe(false)
  })

  it('stays opaque and flags an unsupported desktop', () => {
    reflectWindowBackdrop(true, false)
    expect(root().hasAttribute(GLASS_WINDOW_ATTR)).toBe(false)
    expect(root().hasAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)).toBe(true)
  })

  it('clears both when turned off', () => {
    reflectWindowBackdrop(true, true)
    reflectWindowBackdrop(false, true)
    expect(root().hasAttribute(GLASS_WINDOW_ATTR)).toBe(false)
    expect(root().hasAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)).toBe(false)
  })
})
