// @vitest-environment jsdom
/**
 * For you's top-bar toggle (../side-panel-toggles.tsx), with the app rail
 * (Liam, 11-09: For you shows all the time): from md up it shows only where
 * the column has no room to show by itself (to float it over the chat, and
 * fold it again); on a phone, as before, whenever the bots brought something.
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
    useForYouAlways: () => wide.on,
  }
})
const { wide } = vi.hoisted(() => ({ wide: { on: true } }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ForYouToggle } from '../side-panel-toggles'
import * as store from '../side-panel-store'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  store.resetSidePanelStore()
  entries.count = 3
  wide.on = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const render = () => act(() => root.render(h(TooltipProvider, null, h(ForYouToggle))))
const toggle = () => container.querySelector('[data-for-you-panel-toggle]')

describe('For you’s toggle', () => {
  it('from md up: none while the column shows beside the chat by itself', () => {
    act(() => store.reportSpacePlan('room'))
    render()
    expect(toggle()).toBeNull()
  })

  it('from md up: there where the column has no room, to float it; and while it floats, to fold it', () => {
    act(() => store.reportSpacePlan('off'))
    render()
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    act(() => store.reportSpacePlan('float'))
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
  })

  it('on a phone: there whenever the bots brought something, as before', () => {
    wide.on = false
    act(() => store.reportSpacePlan('room'))
    render()
    expect(toggle()).not.toBeNull()
  })

  it('none with nothing brought', () => {
    entries.count = 0
    wide.on = false
    render()
    expect(toggle()).toBeNull()
  })
})
