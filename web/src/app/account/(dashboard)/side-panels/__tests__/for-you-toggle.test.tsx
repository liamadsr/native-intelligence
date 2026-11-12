// @vitest-environment jsdom
/**
 * The side panel's two buttons (../side-panel-toggles.tsx), one per view of
 * the one panel (Liam, 11-11: "move the for you cards to the right hand side
 * panel… you can't see both at the same time"):
 *
 *   • For you's: there while the bots have brought something, with how many
 *     ("hide empty widgets": none with nothing brought, a live capture or
 *     not); it opens the panel on For you, swaps to it from the sections, or
 *     closes the panel while For you shows; aria-controls the panel;
 *   • the side panel's: opens it on the sections, swaps to them, or closes
 *     it while they show;
 *   • each lit only while its own view is on screen: never both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { entries } = vi.hoisted(() => ({ entries: { count: 3 } }))
vi.mock('../../chat/for-you-column', () => ({ useForYouEntries: () => Array.from({ length: entries.count }, (_, i) => ({ id: `e${i}` })) }))
vi.mock('../../chat/chat-widgets', () => ({ useAgentsSummary: () => ({ running: 0 }) }))
vi.mock('../side-panels', async () => {
  const React = await import('react')
  const store = await import('../side-panel-store')
  return {
    RIGHT_PANEL_ID: 'side-panel',
    useSidePanelState: () => React.useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { ForYouToggle, SidePanelToggle } from '../side-panel-toggles'
import * as store from '../side-panel-store'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  window.localStorage.clear()
  store.resetSidePanelStore()
  entries.count = 3
  // The panel tells the store For you has cards (side-panels.tsx); here, by hand.
  store.setForYouContent(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const render = () => act(() => root.render(h(TooltipProvider, null, h(ForYouToggle))))
/** Both, as the top bar's right header holds them: For you, then the side panel. */
const renderHeader = () =>
  act(() => root.render(<TooltipProvider><ForYouToggle variant="header" /><SidePanelToggle variant="header" /></TooltipProvider>))
const toggle = () => container.querySelector<HTMLButtonElement>('[data-for-you-panel-toggle]')
const side = () => container.querySelector<HTMLButtonElement>('[data-side-panel-toggle]')
const tinted = (el: HTMLElement | null) => el!.className.split(' ').includes('bg-foreground/[0.08]')

describe('For you’s button', () => {
  it('opens the panel on For you, remembered, and closes it again', () => {
    render()
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle()?.getAttribute('aria-controls')).toBe('side-panel')
    expect(toggle()?.textContent).toContain('3')
    // The phone's pill: lit (shaded) while For you is off screen.
    expect(toggle()?.hasAttribute('data-lit')).toBe(true)
    expect(toggle()?.className).toContain('bg-muted')
    act(() => toggle()!.click())
    expect(store.getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou' })
    expect(window.localStorage.getItem(store.VIEW_KEY)).toBe('for-you')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle()?.hasAttribute('data-lit')).toBe(false)
    act(() => toggle()!.click())
    expect(store.getSidePanelState()).toMatchObject({ rightOpen: false, view: 'forYou' })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('is an inbox tray, not a house (Home is the rail header’s)', () => {
    render()
    expect(toggle()?.querySelector('svg')?.getAttribute('class')).toContain('lucide-inbox')
    expect(toggle()?.querySelector('.lucide-house')).toBeNull()
  })

  it('none with nothing brought', () => {
    entries.count = 0
    render()
    expect(toggle()).toBeNull()
  })
})

describe('the two buttons in the top bar’s right header', () => {
  it('each lit only while its own view is on screen: swapping views moves the tint, never both', () => {
    renderHeader()
    expect(toggle()?.getAttribute('data-variant')).toBe('header')
    expect(side()?.getAttribute('data-variant')).toBe('header')
    // Round, as the rail's buttons (Liam, 11-09), with no border of their own (the header's pill has it).
    for (const b of [toggle()!, side()!]) {
      expect(b.className.split(' ')).toContain('rounded-full')
      expect(b.className.split(' ')).not.toContain('border')
    }
    // Closed: neither lit.
    expect([tinted(toggle()), tinted(side())]).toEqual([false, false])

    // The side panel: on its sections.
    act(() => side()!.click())
    expect(store.getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
    expect([tinted(toggle()), tinted(side())]).toEqual([false, true])
    expect([toggle()!.getAttribute('aria-expanded'), side()!.getAttribute('aria-expanded')]).toEqual(['false', 'true'])

    // For you: swapped in place, the panel still open.
    act(() => toggle()!.click())
    expect(store.getSidePanelState()).toMatchObject({ rightOpen: true, view: 'forYou' })
    expect([tinted(toggle()), tinted(side())]).toEqual([true, false])
    expect([toggle()!.getAttribute('aria-expanded'), side()!.getAttribute('aria-expanded')]).toEqual(['true', 'false'])

    // The side panel again: back on the sections.
    act(() => side()!.click())
    expect(store.getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
    expect([tinted(toggle()), tinted(side())]).toEqual([false, true])

    // Its own view showing: closes the panel.
    act(() => side()!.click())
    expect(store.getSidePanelState().rightOpen).toBe(false)
    expect([tinted(toggle()), tinted(side())]).toEqual([false, false])
  })

  it('the panel saved on For you with no cards: no For you button, and the side panel’s unlit (nothing on screen)', () => {
    store.setSidePanelView('forYou')
    store.setRightPanelOpen(true)
    store.setForYouContent(false)
    entries.count = 0
    renderHeader()
    expect(toggle()).toBeNull()
    expect(tinted(side())).toBe(false)
    expect(side()?.getAttribute('aria-expanded')).toBe('false')
    // The side panel's click shows the sections.
    act(() => side()!.click())
    expect(store.getSidePanelState()).toMatchObject({ rightOpen: true, view: 'panel' })
    expect(tinted(side())).toBe(true)
  })
})

describe('the side panel’s button', () => {
  it('the phone’s pill: shaded while the sections are off screen, plain while they show', () => {
    act(() => root.render(h(TooltipProvider, null, h(SidePanelToggle))))
    expect(side()?.getAttribute('aria-expanded')).toBe('false')
    expect(side()?.hasAttribute('data-lit')).toBe(true)
    expect(side()!.className.split(' ')).toContain('bg-muted')
    act(() => side()!.click())
    expect(side()?.getAttribute('aria-expanded')).toBe('true')
    expect(side()?.hasAttribute('data-lit')).toBe(false)
    expect(side()!.className.split(' ')).not.toContain('bg-muted')
    // For you on screen instead: the sections' pill is shaded again.
    act(() => store.toggleSidePanelView('forYou'))
    expect(side()?.hasAttribute('data-lit')).toBe(true)
  })

  it('in the header, a 32px circle with nothing running (not a 34×32 oval)', () => {
    act(() => root.render(<TooltipProvider><SidePanelToggle variant="header" /></TooltipProvider>))
    expect(side()!.className.split(' ')).toContain('w-8')
  })
})
