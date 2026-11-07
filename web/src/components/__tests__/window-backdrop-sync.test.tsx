// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => {})
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }))

import { WindowBackdropSync } from '../window-backdrop-sync'
import { GLASS_OPACITY_STORAGE_KEY, GLASS_WINDOW_ATTR, GLASS_WINDOW_UNSUPPORTED_ATTR, WINDOW_TINT_VAR, glassLayers, setGlassOpacity } from '@/lib/window-backdrop'
import { BACKGROUND_STORAGE_KEY } from '@/lib/app-background'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const html = () => document.documentElement
let host: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<WindowBackdropSync />))
  await flush()
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async () => {})
  window.__TAURI_INTERNALS__ = {}
  html().removeAttribute(GLASS_WINDOW_ATTR)
  html().removeAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)
  html().classList.remove('dark')
  html().setAttribute('data-app-bg', 'sky')
  window.localStorage.clear()
})
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  delete window.__TAURI_INTERNALS__
})

describe('WindowBackdropSync', () => {
  it('leaves an opaque window alone', async () => {
    await mount()
    expect(invoke).not.toHaveBeenCalled()
    expect(html().hasAttribute(GLASS_WINDOW_ATTR)).toBe(false)
  })

  it('turns the window see-through on Glass', async () => {
    html().setAttribute('data-app-bg', 'glass')
    await mount()
    expect(invoke).toHaveBeenCalledWith('set_window_backdrop', { mode: 'glass', blur: glassLayers(0).blur, dark: false })
    expect(html().hasAttribute(GLASS_WINDOW_ATTR)).toBe(true)
  })

  it('leaves the window alone while the Opacity slider moves (the tint is CSS)', async () => {
    html().setAttribute('data-app-bg', 'glass')
    await mount()
    invoke.mockClear()
    await act(async () => setGlassOpacity(60))
    await flush()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('goes opaque again when the background changes, and when the shell unmounts', async () => {
    html().setAttribute('data-app-bg', 'glass')
    await mount()
    expect(html().hasAttribute(GLASS_WINDOW_ATTR)).toBe(true)

    html().setAttribute('data-app-bg', 'none')
    await flush()
    expect(html().hasAttribute(GLASS_WINDOW_ATTR)).toBe(false)
    expect(invoke).toHaveBeenLastCalledWith('set_window_backdrop', { mode: 'off', blur: glassLayers(0).blur, dark: false })

    html().setAttribute('data-app-bg', 'glass')
    await flush()
    invoke.mockClear()
    await act(async () => root.unmount())
    expect(html().hasAttribute(GLASS_WINDOW_ATTR)).toBe(false)
    expect(invoke).toHaveBeenCalledWith('set_window_backdrop', { mode: 'off', blur: glassLayers(0).blur, dark: false })
  })

  it('tells the desktop the theme, for the HUD’s frosted layer', async () => {
    html().setAttribute('data-app-bg', 'glass')
    await mount()
    html().classList.add('dark')
    await flush()
    expect(invoke).toHaveBeenLastCalledWith('set_window_backdrop', { mode: 'glass', blur: glassLayers(0).blur, dark: true })
  })

  it('follows a change made in another window (the HUD follows Preferences)', async () => {
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, 'sky')
    html().setAttribute('data-app-bg', 'sky')
    await mount()
    expect(invoke).not.toHaveBeenCalled()

    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, 'glass')
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: BACKGROUND_STORAGE_KEY })))
    await flush()
    expect(html().getAttribute('data-app-bg')).toBe('glass')
    expect(invoke).toHaveBeenLastCalledWith('set_window_backdrop', { mode: 'glass', blur: glassLayers(0).blur, dark: false })

    window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, '100')
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: GLASS_OPACITY_STORAGE_KEY })))
    expect(html().style.getPropertyValue(WINDOW_TINT_VAR)).toBe(String(glassLayers(100).tint))
  })

  it('keeps the page opaque when the desktop refuses (an older build)', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('Command set_window_backdrop not found')
    })
    html().setAttribute('data-app-bg', 'glass')
    await mount()
    expect(html().hasAttribute(GLASS_WINDOW_ATTR)).toBe(false)
    expect(html().hasAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)).toBe(true)
  })
})
