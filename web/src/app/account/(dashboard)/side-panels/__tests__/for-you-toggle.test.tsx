// @vitest-environment jsdom
/**
 * For you's top-bar toggle (../side-panel-toggles.tsx): always there while
 * the bots have brought something, like the side panel's on the right (Liam,
 * 11-09), the column beside the chat or not; it folds the column away and
 * brings it back. With nothing brought, no toggle ("hide empty widgets").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { entries } = vi.hoisted(() => ({ entries: { count: 3 } }))
vi.mock('../../chat/for-you-column', () => ({ useForYouEntries: () => Array.from({ length: entries.count }, (_, i) => ({ id: `e${i}` })) }))
vi.mock('../../chat/use-live-capture-dock', () => ({ useActiveLiveCapture: () => null }))
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const render = () => act(() => root.render(h(TooltipProvider, null, h(ForYouToggle))))
const toggle = () => container.querySelector<HTMLButtonElement>('[data-for-you-panel-toggle]')

describe('For you’s toggle', () => {
  it('is there while the column shows beside the chat, and folds it away (remembered)', () => {
    act(() => store.reportSpacePlan(true))
    render()
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    // Plain while the column shows; lit once folded (Liam, 11-09: flipped).
    expect(toggle()?.hasAttribute('data-lit')).toBe(false)
    expect(toggle()?.textContent).toContain('3')
    act(() => toggle()!.click())
    expect(store.getSidePanelState().leftOpen).toBe(false)
    expect(window.localStorage.getItem(store.FOR_YOU_COLLAPSED_KEY)).toBe('1')
    act(() => store.reportSpacePlan(false))
    expect(toggle()?.hasAttribute('data-lit')).toBe(true)
    expect(toggle()?.className).toContain('bg-muted')
  })

  it('is there while the column is folded or has no room, and brings it back', () => {
    act(() => store.reportSpacePlan(false))
    render()
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    act(() => toggle()!.click())
    expect(store.getSidePanelState().leftOpen).toBe(true)
    expect(store.getSidePanelState().leftFloatOk).toBe(true)
  })

  it('a fold remembered before 11-09 (the old key) no longer hides the column', () => {
    window.localStorage.setItem('dial8:for-you-column:collapsed', '1')
    store.resetSidePanelStore()
    expect(store.getSidePanelState().leftOpen).toBe(true)
  })

  it('is an inbox tray, not a house (Home is the rail header’s)', () => {
    render()
    expect(toggle()?.querySelector('svg')?.getAttribute('class')).toContain('lucide-inbox')
    expect(toggle()?.querySelector('.lucide-house')).toBeNull()
  })

  it('in the app rail’s header: round and flat like its other buttons, tinted while the column shows (Liam: closed but highlighted was wrong)', () => {
    act(() => store.reportSpacePlan(true))
    act(() => root.render(<TooltipProvider><ForYouToggle variant="header" /></TooltipProvider>))
    expect(toggle()?.getAttribute('data-variant')).toBe('header')
    expect(toggle()?.hasAttribute('data-lit')).toBe(true)
    expect(toggle()!.className.split(' ')).toContain('bg-foreground/[0.08]')
    // Round, as the rail's buttons (Liam, 11-09), with no border of its own (the bar's pill has it).
    expect(toggle()!.className.split(' ')).toContain('rounded-full')
    expect(toggle()!.className.split(' ')).not.toContain('border')
    // Closed: plain.
    act(() => store.reportSpacePlan(false))
    expect(toggle()?.hasAttribute('data-lit')).toBe(false)
    expect(toggle()!.className.split(' ')).not.toContain('bg-foreground/[0.08]')
  })

  it('none with nothing brought', () => {
    entries.count = 0
    render()
    expect(toggle()).toBeNull()
  })
})

describe('the side panel’s toggle in the top bar’s right header', () => {
  const side = () => container.querySelector<HTMLButtonElement>('[data-side-panel-toggle]')
  it('is round and flat, tinted while the panel is open and plain while it’s closed (Liam, 11-09)', () => {
    act(() => root.render(<TooltipProvider><SidePanelToggle variant="header" /></TooltipProvider>))
    expect(side()?.getAttribute('data-variant')).toBe('header')
    expect(side()!.className.split(' ')).toContain('rounded-full')
    expect(side()?.getAttribute('aria-expanded')).toBe('false')
    expect(side()!.className.split(' ')).not.toContain('bg-foreground/[0.08]')
    act(() => side()!.click())
    expect(side()?.getAttribute('aria-expanded')).toBe('true')
    expect(side()!.className.split(' ')).toContain('bg-foreground/[0.08]')
  })
})
