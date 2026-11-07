// @vitest-environment jsdom
/**
 * A `mod` shortcut's label follows the person's platform (lib/hotkeys.ts):
 * ⌘ on a Mac (any browser there, or the Mac app), Ctrl everywhere else (a
 * Windows or Linux browser, the Windows app). The hook renders the Mac label
 * on the server and the first client render, so hydration never mismatches.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h } from 'react'
import { isMacPlatform, modKeyLabel, useModKeyLabel } from '../hotkeys'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function setPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  delete (navigator as { platform?: string }).platform
})

describe('modKeyLabel', () => {
  it('is ⌘ on a Mac, Ctrl elsewhere', () => {
    expect(modKeyLabel('K', true)).toBe('⌘K')
    expect(modKeyLabel('', true)).toBe('⌘')
    expect(modKeyLabel('K', false)).toBe('Ctrl+K')
    expect(modKeyLabel('', false)).toBe('Ctrl')
  })

  it('reads the platform', () => {
    setPlatform('MacIntel')
    expect(isMacPlatform()).toBe(true)
    expect(modKeyLabel('N')).toBe('⌘N')
    setPlatform('Win32')
    expect(isMacPlatform()).toBe(false)
    expect(modKeyLabel('N')).toBe('Ctrl+N')
  })
})

describe('useModKeyLabel', () => {
  function Label() {
    return h('kbd', null, useModKeyLabel('K'))
  }

  it('renders the Mac label on the server, then Ctrl+K once hydrated on Windows', async () => {
    setPlatform('Win32')
    const html = renderToString(h(Label))
    expect(html).toContain('⌘K')

    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    const errors: unknown[] = []
    let root: ReturnType<typeof hydrateRoot> | undefined
    await act(async () => {
      root = hydrateRoot(container, h(Label), { onRecoverableError: (e) => errors.push(e) })
    })
    expect(errors).toEqual([])
    expect(container.textContent).toBe('Ctrl+K')
    act(() => root?.unmount())
    container.remove()
  })

  it('stays ⌘K on a Mac', () => {
    setPlatform('MacIntel')
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(h(Label)))
    expect(container.textContent).toBe('⌘K')
    act(() => root.unmount())
  })
})
