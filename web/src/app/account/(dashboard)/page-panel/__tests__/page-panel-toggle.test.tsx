// @vitest-environment jsdom
/**
 * The page panel's button (page-panel-toggle.tsx; Liam, 11-11: "we also need
 * a button for opening and closing the new panel lets put it to the right of
 * the search button"): there only while the panel has something to show, a
 * disclosure button lit while the panel is on screen; a press closes it on
 * screen, else opens it by hand (it may float), remembered per device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The side panel's module is the whole right panel: the button reads only the store.
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PagePanelToggle } from '../page-panel-toggle'
import { PAGE_PANEL_ID } from '../page-panel-types'
import * as store from '../../side-panels/side-panel-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  store.resetSidePanelStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = () =>
  act(() =>
    root.render(
      <TooltipProvider>
        <PagePanelToggle />
      </TooltipProvider>,
    ),
  )
const button = () => container.querySelector<HTMLButtonElement>('[data-page-panel-toggle]')

describe('the page panel’s button', () => {
  it('is there only while the panel has something to show (Liam’s “hide empty widgets”)', () => {
    render()
    expect(button()).toBeNull()
    act(() => store.setPagePanelContent(true))
    expect(button()).not.toBeNull()
    act(() => store.setPagePanelContent(false))
    expect(button()).toBeNull()
  })

  it('a disclosure button named Recent, for the panel, drawn as the header’s others: a flat 32px circle with PanelLeft at 18px', () => {
    act(() => store.setPagePanelContent(true))
    render()
    const b = button()!
    expect(b.getAttribute('aria-label')).toBe('Recent')
    expect(b.getAttribute('aria-controls')).toBe(PAGE_PANEL_ID)
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(b.className.split(' ')).toEqual(expect.arrayContaining(['size-8', 'rounded-full', 'text-sidebar-foreground/65', 'hover:bg-foreground/[0.05]']))
    const icon = b.querySelector('svg[data-page-panel-icon]')!
    expect(icon.getAttribute('class')).toContain('lucide-panel-left')
    expect(icon.getAttribute('class')).toContain('size-[18px]')
    expect(icon.getAttribute('stroke-width')).toBe('1.75')
  })

  it('aria-expanded and the tint follow what is on screen, not the saved state', () => {
    act(() => store.setPagePanelContent(true))
    render()
    // Open as saved, but not on screen (no room): not expanded.
    expect(store.getSidePanelState().pagePanelOpen).toBe(true)
    expect(button()!.getAttribute('aria-expanded')).toBe('false')
    expect(button()!.hasAttribute('data-lit')).toBe(false)
    act(() => store.setPagePanelShown(true))
    expect(button()!.getAttribute('aria-expanded')).toBe('true')
    expect(button()!.hasAttribute('data-lit')).toBe(true)
    expect(button()!.className.split(' ')).toContain('bg-foreground/[0.08]')
  })

  it('a press closes it on screen (remembered); another opens it by hand, so it may float', () => {
    act(() => store.setPagePanelContent(true))
    act(() => store.setPagePanelShown(true))
    render()
    act(() => button()!.click())
    expect(store.getSidePanelState()).toMatchObject({ pagePanelOpen: false, pagePanelFloatOk: false })
    expect(window.localStorage.getItem(store.PAGE_PANEL_OPEN_KEY)).toBe('0')
    act(() => store.setPagePanelShown(false))
    act(() => button()!.click())
    expect(store.getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: true })
    expect(window.localStorage.getItem(store.PAGE_PANEL_OPEN_KEY)).toBeNull()
  })

  it('open as remembered but off screen (no room): a press opens it by hand instead of closing it', () => {
    act(() => store.setPagePanelContent(true))
    render()
    act(() => button()!.click())
    expect(store.getSidePanelState()).toMatchObject({ pagePanelOpen: true, pagePanelFloatOk: true })
  })
})
