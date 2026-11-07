import { describe, it, expect } from 'vitest'
import { isMailShortcutHandleable } from '../email-layout'

/**
 * GEN-83: keyboard shortcut guard
 *
 * `isMailShortcutHandleable` is the guard added to the keydown handler in
 * email-layout.tsx.  When any modifier key is held the handler must bail out
 * so that OS/browser shortcuts (Cmd+C, Ctrl+C, Cmd+/, etc.) are never
 * intercepted by the mail page.
 */
describe('isMailShortcutHandleable', () => {
  // Happy path – bare key press with no modifier should be handled
  it('returns true for a plain key press (no modifiers)', () => {
    expect(isMailShortcutHandleable({ metaKey: false, ctrlKey: false, altKey: false })).toBe(true)
  })

  // Bug-fix cases – modifier combos must NOT be handled
  it('returns false when metaKey is held (e.g. Cmd+C on macOS)', () => {
    expect(isMailShortcutHandleable({ metaKey: true, ctrlKey: false, altKey: false })).toBe(false)
  })

  it('returns false when ctrlKey is held (e.g. Ctrl+C on Windows/Linux)', () => {
    expect(isMailShortcutHandleable({ metaKey: false, ctrlKey: true, altKey: false })).toBe(false)
  })

  it('returns false when altKey is held', () => {
    expect(isMailShortcutHandleable({ metaKey: false, ctrlKey: false, altKey: true })).toBe(false)
  })

  it('returns false when multiple modifiers are held simultaneously', () => {
    expect(isMailShortcutHandleable({ metaKey: true, ctrlKey: true, altKey: false })).toBe(false)
  })
})
