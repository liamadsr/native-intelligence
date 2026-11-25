// @vitest-environment jsdom
/**
 * "A coding chat needs you", after the Code tab's dot (docs/plans/one-home.md,
 * decision 1; Liam, 11-20: an orange dot on the Code tab while a coding
 * chat's work waits on your review). Pressing Code starts a new chat now, so
 * the dot is on the chat's own row in Recent (page-panel.test.tsx), and,
 * while Recent is not what the person is looking at, on the way back to it:
 * the switch's Recent side, and the panel's button while the panel is closed.
 * Never on the Code tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reviews = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../chat/for-you-column', () => ({
  useCodeForYouEntries: () => Array.from({ length: reviews.count }, (_, i) => ({ id: `review-${i}` })),
  useForYouEntries: () => [],
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return { useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState) }
})

import { __resetCodingAttentionForTests, setCodingRowsWaiting, useCodingNeedsYou } from '../coding-attention'
import { HomeSideSwitch } from '../home-recents'
import { PagePanelToggle } from '../page-panel-toggle'
import { __resetHomeSideForTests, setHomeSide } from '../home-side'
import { ComposerTabs } from '../../chat/composer-code-controls'
import { CODE_TAB_DOT } from '../../chat/one-home-decisions'
import * as store from '../../side-panels/side-panel-store'
import { __resetSelectedPlaceForTests } from '../../rail/selected-place'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reviews.count = 0
  window.localStorage.clear()
  __resetCodingAttentionForTests()
  __resetHomeSideForTests()
  __resetSelectedPlaceForTests()
  store.resetSidePanelStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('whether a coding chat needs the person', () => {
  function Says() {
    return <output>{useCodingNeedsYou() ? 'yes' : 'no'}</output>
  }
  const says = () => container.querySelector('output')!.textContent

  it('a review waiting (live, from the shell’s own source), or a row of Recent’s that waited at its last read', () => {
    act(() => root.render(<Says />))
    expect(says()).toBe('no')
    act(() => setCodingRowsWaiting(2))
    expect(says()).toBe('yes')
    act(() => setCodingRowsWaiting(0))
    expect(says()).toBe('no')
    reviews.count = 1
    act(() => root.render(<Says />))
    expect(says()).toBe('yes')
  })
})

describe('the way back to Recent carries the orange dot', () => {
  const recentSide = () => container.querySelector<HTMLElement>('[data-home-side-option="recent"]')!
  const incomingSide = () => container.querySelector<HTMLElement>('[data-home-side-option="inbox"]')!

  it('the switch’s Recent side, while Incoming shows: orange, in words; none while Recent itself shows (the row has it)', () => {
    act(() => setCodingRowsWaiting(1))
    act(() => root.render(<HomeSideSwitch />))
    expect(recentSide().querySelector('[data-panel-switch-dot]')).toBeNull()
    act(() => setHomeSide('inbox'))
    const dot = recentSide().querySelector('[data-panel-switch-dot]')!
    expect(dot.getAttribute('data-panel-switch-dot')).toBe('orange')
    expect(dot.getAttribute('class')).toContain('bg-orange-500')
    expect(dot.textContent).toBe(', a coding chat needs you')
    // Incoming's own dot is its own (nothing unread here: none).
    expect(incomingSide().querySelector('[data-panel-switch-dot]')).toBeNull()
    act(() => setCodingRowsWaiting(0))
    expect(recentSide().querySelector('[data-panel-switch-dot]')).toBeNull()
  })

  it('the panel’s button, while home’s panel is closed; none while it shows, or with nothing waiting', () => {
    act(() => {
      store.setPagePanelContent(true)
      store.setPagePanelShown(true)
      setCodingRowsWaiting(1)
    })
    act(() => root.render(<TooltipProvider><PagePanelToggle /></TooltipProvider>))
    const dot = () => container.querySelector('[data-page-panel-coding-dot]')
    expect(dot()).toBeNull()
    act(() => store.setPagePanelShown(false))
    expect(dot()!.getAttribute('class')).toContain('bg-orange-500')
    expect(dot()!.textContent).toBe(', a coding chat needs you')
    act(() => setCodingRowsWaiting(0))
    expect(dot()).toBeNull()
  })
})

describe('the Code tab', () => {
  it('wears no dot, whatever waits on a review: it starts a new chat, so a dot there would point at the wrong thing (decision 1)', () => {
    expect(CODE_TAB_DOT).toBe(false)
    reviews.count = 2
    act(() => root.render(<ComposerTabs tab="chat" onTab={() => {}} />))
    const code = container.querySelector<HTMLElement>('[data-composer-tab="code"]')!
    expect(code.querySelector('[data-composer-tab-attention]')).toBeNull()
    expect(code.textContent).toBe('Code')
    expect(code.getAttribute('title')).toBe('Work with a coding agent directly, in a folder on your Mac')
  })
})
