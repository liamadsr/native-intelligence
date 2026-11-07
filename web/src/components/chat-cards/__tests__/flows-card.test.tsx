// @vitest-environment jsdom
/**
 * The flows card draws the real FlowsView (the only place the page renders).
 * It never fires the old bridge's return trip. A row clicked inline takes the
 * card full screen with that flow open; the open canvas is an inner layer, so
 * Esc closes it before the card's full screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/views/flows/flow-canvas-editor', () => ({
  FlowCanvasEditor: ({ flowId, onClose }: { flowId: string | null; onClose: () => void }) =>
    React.createElement('button', { 'data-canvas': flowId ?? 'new', onClick: onClose }, 'close'),
}))

import FlowsCard from '../pages/flows-card'
import { WindowFocusProvider } from '@/components/views/unified-view-layout'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const spec: PageCardSpec = { kind: 'flows', title: 'Flows' }
const ROW = '00000000-0000-4000-8000-00000000abcd'

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('fetch', stubFetch({ paused_flows: [] }).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

function both(store: ReturnType<typeof makeStore>, fullScreen: boolean) {
  return React.createElement(
    'div',
    null,
    // A full-screen card is focused too (card-body's WindowFocusProvider).
    React.createElement(
      'section',
      { 'data-card-page': '' },
      React.createElement(WindowFocusProvider, { isFocused: fullScreen, children: React.createElement(FlowsCard, { toolCallId: 'call-1', spec, store, fullScreen }) }),
    ),
  )
}

describe('FlowsCard', () => {
  it('takes the card full screen to edit a row clicked inline, and closing it fires no bridge event', async () => {
    const store = makeStore('call-1', spec)
    const closed = vi.fn()
    window.addEventListener('dial8:flow-editor-closed', closed)
    await mount.render(both(store, false))
    await act(async () => (mount.container.querySelector('[data-card-page] [data-probe-open]') as HTMLElement).click())
    expect(store.fullScreen()).toBe('call-1')
    expect(store.state('call-1').editing).toBe(ROW)
    // Inline, the canvas never draws.
    expect(mount.container.querySelector('[data-card-page] [data-canvas]')).toBeNull()

    // Full screen (the card mounts again there): the canvas is open, as an inner layer.
    mount.unmount()
    mount = mountRoot()
    await mount.render(both(store, true))
    const canvas = mount.container.querySelector('[data-card-page] [data-canvas]') as HTMLElement
    expect(canvas.getAttribute('data-canvas')).toBe(ROW)
    expect(canvas.closest('[data-chat-card-layer]')).not.toBeNull()
    await act(async () => canvas.click())
    expect(mount.container.querySelector('[data-card-page] [data-canvas]')).toBeNull()
    expect(closed).not.toHaveBeenCalled()
    window.removeEventListener('dial8:flow-editor-closed', closed)
  })
})
