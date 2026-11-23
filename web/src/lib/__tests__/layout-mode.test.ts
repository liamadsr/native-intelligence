// @vitest-environment jsdom
/**
 * The app's layout (../layout-mode.ts, ../layout-mode-store.ts;
 * docs/plans/traditional-layout.md): a checked value, kept on the account
 * with a copy on this device, and on <html> as LAYOUT_ATTR while Traditional
 * is on. Switching changes nothing but that: no route, no other storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { LAYOUT_ATTR, LAYOUT_STORAGE_KEY, applyLayoutAttr, parseLayoutMode } from '../layout-mode'
import { LayoutModeSync, __resetLayoutModeForTests, getLayoutMode, saveLayoutMode } from '../layout-mode-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{"success":true}', { status: 200 }))

beforeEach(() => {
  localStorage.clear()
  __resetLayoutModeForTests()
  document.documentElement.removeAttribute(LAYOUT_ATTR)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('parseLayoutMode', () => {
  it('takes the two layouts and nothing else', () => {
    expect(parseLayoutMode('default')).toBe('default')
    expect(parseLayoutMode('traditional')).toBe('traditional')
    for (const bad of [null, undefined, '', 'Traditional', 'macro', 1, {}, ['traditional']]) expect(parseLayoutMode(bad)).toBeNull()
  })
})

describe('applyLayoutAttr', () => {
  it('marks <html> for Traditional only', () => {
    applyLayoutAttr('traditional')
    expect(document.documentElement.getAttribute(LAYOUT_ATTR)).toBe('traditional')
    applyLayoutAttr('default')
    expect(document.documentElement.hasAttribute(LAYOUT_ATTR)).toBe(false)
  })
})

describe('the layout setting', () => {
  it('is the default with nothing saved, and reads this device’s copy at once', () => {
    expect(getLayoutMode()).toBe('default')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify('traditional'))
    __resetLayoutModeForTests()
    expect(getLayoutMode()).toBe('traditional')
  })

  it('saves to the account (the profile PATCH, that key alone) and the device copy, changing nothing else', async () => {
    const before = { ...localStorage }
    const path = window.location.pathname
    expect(await saveLayoutMode('traditional')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/account/profile')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ layout: 'traditional' })
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('"traditional"')
    expect(Object.keys(localStorage).filter((k) => !(k in before) && k !== LAYOUT_STORAGE_KEY)).toEqual([])
    expect(window.location.pathname).toBe(path)
  })

  it('puts the old layout back when the account refuses the save', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    expect(await saveLayoutMode('traditional')).toBe(false)
    expect(getLayoutMode()).toBe('default')
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull()
  })

  it('LayoutModeSync keeps <html> on the layout, and takes the mark away when the shell goes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => root.render(h(LayoutModeSync)))
    expect(document.documentElement.hasAttribute(LAYOUT_ATTR)).toBe(false)
    await act(async () => {
      await saveLayoutMode('traditional')
    })
    expect(document.documentElement.getAttribute(LAYOUT_ATTR)).toBe('traditional')
    await act(async () => {
      await saveLayoutMode('default')
    })
    expect(document.documentElement.hasAttribute(LAYOUT_ATTR)).toBe(false)
    await act(async () => {
      await saveLayoutMode('traditional')
    })
    act(() => root.unmount())
    expect(document.documentElement.hasAttribute(LAYOUT_ATTR)).toBe(false)
    container.remove()
  })
})
