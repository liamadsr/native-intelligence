// @vitest-environment jsdom
/**
 * A teammate changed here (lib/bots/teammates-changed.ts): the roster reloads
 * in this window (the event) and in the app's other windows (a storage ping
 * they hear, and this window doesn't), so a voice or face saved in one window
 * is heard and seen in every one, the desktop's main window (which relays the
 * overlay's bubble) included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEAMMATES_CHANGED_KEY, announceTeammatesChanged, onTeammatesChanged } from '../teammates-changed'

/** Another window's write to the shared storage, as this window hears it. */
function fromAnotherWindow(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('announceTeammatesChanged / onTeammatesChanged', () => {
  it('reaches a listener in this window once, and leaves a fresh ping for the others each time', () => {
    const heard = vi.fn()
    const off = onTeammatesChanged(heard)
    announceTeammatesChanged()
    expect(heard).toHaveBeenCalledTimes(1)
    const first = localStorage.getItem(TEAMMATES_CHANGED_KEY)
    expect(first).toBeTruthy()
    announceTeammatesChanged()
    expect(heard).toHaveBeenCalledTimes(2)
    // A new value each time, so another window hears every one.
    expect(localStorage.getItem(TEAMMATES_CHANGED_KEY)).not.toBe(first)
    off()
  })

  it('hears a change made in another window, and nothing else in storage', () => {
    const heard = vi.fn()
    const off = onTeammatesChanged(heard)
    fromAnotherWindow(TEAMMATES_CHANGED_KEY, '1700000000000:1')
    expect(heard).toHaveBeenCalledTimes(1)
    fromAnotherWindow('ni:bots:cast', '{}')
    // The key cleared (storage wiped) is no change to hear.
    fromAnotherWindow(TEAMMATES_CHANGED_KEY, null)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('hears nothing once unsubscribed', () => {
    const heard = vi.fn()
    onTeammatesChanged(heard)()
    announceTeammatesChanged()
    fromAnotherWindow(TEAMMATES_CHANGED_KEY, '1700000000000:2')
    expect(heard).not.toHaveBeenCalled()
  })

  it('still tells this window when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const heard = vi.fn()
    const off = onTeammatesChanged(heard)
    expect(() => announceTeammatesChanged()).not.toThrow()
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })
})
