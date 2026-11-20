// @vitest-environment jsdom
/**
 * Two-key sequences in useHotkeys (lib/hotkeys.ts `after`): "G then M" fires
 * only when M follows a bare G within SEQUENCE_MS, never while typing, never
 * while a dialog or menu has the keyboard (`globalGuard`), and a bare key
 * pressed as a sequence's second key fires nothing else (G then C is not C).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { SEQUENCE_MS, resetSequence, useHotkeys } from '../hotkeys'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mail = vi.fn()
const create = vi.fn()
const palette = vi.fn()

function Shortcuts() {
  useHotkeys([
    { key: 'm', after: 'g', globalGuard: true, handler: mail },
    { key: 'c', globalGuard: true, handler: create },
    { key: 'k', mod: true, handler: palette },
  ])
  return null
}

let root: Root

beforeEach(() => {
  resetSequence()
  root = createRoot(document.createElement('div'))
  act(() => root.render(h(Shortcuts)))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.body.removeAttribute('data-scroll-locked')
  vi.clearAllMocks()
  vi.useRealTimers()
})

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

describe('useHotkeys sequences', () => {
  it('G then M fires; M alone does not', () => {
    press(document.body, 'm')
    expect(mail).not.toHaveBeenCalled()
    press(document.body, 'g')
    const e = press(document.body, 'm')
    expect(mail).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    // The sequence is spent: another M does nothing.
    press(document.body, 'm')
    expect(mail).toHaveBeenCalledTimes(1)
  })

  it('a bare key pressed second fires nothing else (G then C is not Create)', () => {
    press(document.body, 'g')
    press(document.body, 'c')
    expect(create).not.toHaveBeenCalled()
    press(document.body, 'c')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('a key with ⌘ still works after G', () => {
    press(document.body, 'g')
    press(document.body, 'k', { metaKey: true })
    expect(palette).toHaveBeenCalledTimes(1)
  })

  it('times out', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-05T10:00:00Z'))
    press(document.body, 'g')
    vi.setSystemTime(new Date(Date.now() + SEQUENCE_MS + 1))
    press(document.body, 'm')
    expect(mail).not.toHaveBeenCalled()
  })

  it('never while typing: G typed in a field arms nothing', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    press(input, 'g')
    press(document.body, 'm')
    expect(mail).not.toHaveBeenCalled()
    press(input, 'm')
    expect(mail).not.toHaveBeenCalled()
  })

  it('never while a dialog or menu has the keyboard, or under a modal', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.appendChild(dialog)
    press(document.body, 'g')
    press(document.body, 'm')
    expect(mail).not.toHaveBeenCalled()
    dialog.remove()
    document.body.setAttribute('data-scroll-locked', '1')
    press(document.body, 'g')
    press(document.body, 'm')
    expect(mail).not.toHaveBeenCalled()
  })

  it('an open tooltip is no layer', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const tip = document.createElement('div')
    tip.setAttribute('role', 'tooltip')
    wrapper.appendChild(tip)
    document.body.appendChild(wrapper)
    press(document.body, 'g')
    press(document.body, 'm')
    expect(mail).toHaveBeenCalledTimes(1)
  })
})
