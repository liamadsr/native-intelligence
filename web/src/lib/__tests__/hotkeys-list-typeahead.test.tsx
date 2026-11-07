// @vitest-environment jsdom
/**
 * The shell's single-key shortcuts (lib/hotkeys.ts useHotkeys) leave a letter
 * typed in an open menu or list alone: it's that list's typeahead (every Radix
 * menu, select and combobox list), not a shortcut too. Before, typing in the
 * bots button's menu toggled the workspaces veil (W) and page windows (T, M,
 * D, P, B). Keys with a modifier still reach their shortcuts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { isListTypeahead, useHotkeys } from '../hotkeys'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const veil = vi.fn()
const palette = vi.fn()

function Shortcuts() {
  useHotkeys([
    { key: 'w', handler: veil },
    { key: 'k', mod: true, handler: palette },
  ])
  return null
}

let root: Root
let menu: HTMLElement
let item: HTMLElement

beforeEach(() => {
  root = createRoot(document.createElement('div'))
  act(() => root.render(h(Shortcuts)))
  menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  item = document.createElement('div')
  item.setAttribute('role', 'menuitem')
  menu.appendChild(item)
  document.body.appendChild(menu)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

describe('useHotkeys and a list’s typeahead', () => {
  it('a bare letter typed in a menu fires no shortcut, and is not prevented (the typeahead has it)', () => {
    const e = press(item, { key: 'w' })
    expect(veil).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('the same letter anywhere else is the shortcut', () => {
    press(document.body, { key: 'w' })
    expect(veil).toHaveBeenCalledTimes(1)
  })

  it('a listbox is a list too', () => {
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    const option = document.createElement('div')
    list.appendChild(option)
    document.body.appendChild(list)
    press(option, { key: 'w' })
    expect(veil).not.toHaveBeenCalled()
  })

  it('a key with a modifier in a menu still reaches its shortcut (⌘K)', () => {
    press(item, { key: 'k', metaKey: true })
    expect(palette).toHaveBeenCalledTimes(1)
  })

  it('isListTypeahead: bare printable keys inside a menu or listbox only', () => {
    const at = (target: Element, init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', init)
      Object.defineProperty(e, 'target', { value: target })
      return isListTypeahead(e)
    }
    expect(at(item, { key: 'w' })).toBe(true)
    expect(at(item, { key: 'W', shiftKey: true })).toBe(true)
    expect(at(item, { key: 'Escape' })).toBe(false)
    expect(at(item, { key: 'ArrowDown' })).toBe(false)
    expect(at(item, { key: 'k', ctrlKey: true })).toBe(false)
    expect(at(item, { key: 'k', altKey: true })).toBe(false)
    expect(at(document.body, { key: 'w' })).toBe(false)
  })
})
