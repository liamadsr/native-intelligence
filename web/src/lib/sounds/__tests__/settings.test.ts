// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import {
  SOUND_EFFECTS_KEY,
  getSoundEffectsEnabled,
  setSoundEffectsEnabled,
  useSoundEffectsEnabled,
} from '../settings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Sound effects setting', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('is on by default and stores nothing until turned off', () => {
    expect(getSoundEffectsEnabled()).toBe(true)
    setSoundEffectsEnabled(false)
    expect(window.localStorage.getItem(SOUND_EFFECTS_KEY)).toBe('0')
    expect(getSoundEffectsEnabled()).toBe(false)
    setSoundEffectsEnabled(true)
    expect(window.localStorage.getItem(SOUND_EFFECTS_KEY)).toBeNull()
    expect(getSoundEffectsEnabled()).toBe(true)
  })

  it('reads as on when storage throws, and a failing write does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(getSoundEffectsEnabled()).toBe(true)
    expect(() => setSoundEffectsEnabled(false)).not.toThrow()
  })

  it('the hook follows this window and other windows (storage event)', () => {
    const seen: boolean[] = []
    function Probe() {
      seen.push(useSoundEffectsEnabled())
      return null
    }
    const el = document.createElement('div')
    let root: Root
    act(() => {
      root = createRoot(el)
      root.render(h(Probe))
    })
    expect(seen.at(-1)).toBe(true)
    act(() => setSoundEffectsEnabled(false))
    expect(seen.at(-1)).toBe(false)
    // Another window turns it back on.
    window.localStorage.removeItem(SOUND_EFFECTS_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SOUND_EFFECTS_KEY }))
    })
    expect(seen.at(-1)).toBe(true)
    act(() => root.unmount())
  })
})
