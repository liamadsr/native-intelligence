// @vitest-environment jsdom
/**
 * Two Mail views on screen at once — a tab can show several windows, and both
 * of these can be Mail.
 *
 *   1. Keyboard shortcuts belong to the FOCUSED window only. Every mounted
 *      EmailLayout registers the same window keydown listener, so without the
 *      gate one keypress acted in every Mail view at once.
 *   2. Each view subscribes on its OWN realtime channel. realtime-js hands back
 *      the existing channel for a repeated topic, so on a shared name the first
 *      view to unmount removed the other's subscription with it.
 *
 * The REAL component is mounted; only the data/UI deps are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const channelNames: string[] = []
const removedNames: string[] = []
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      channelNames.push(name)
      const ch: Record<string, unknown> = { name }
      ch.on = () => ch
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: (ch: { name: string }) => {
      removedNames.push(ch.name)
    },
  }),
}))

vi.mock('../email-thread-list', () => ({ EmailThreadList: () => null }))
vi.mock('../email-thread-detail', () => ({ EmailThreadDetail: () => null }))
vi.mock('@/components/account-filter-dropdown', () => ({ AccountFilterDropdown: () => null }))
vi.mock('@/components/views/view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('@/components/views/hooks/use-view', () => ({
  useView: () => ({
    views: [],
    activeViewId: null,
    activeView: null,
    setActiveViewId: () => {},
    createView: () => {},
    updateView: () => {},
    deleteView: () => {},
    duplicateView: () => {},
  }),
  useViewConfig: () => ({
    config: { filters: [] },
    updateConfig: () => {},
    isDirty: false,
    overrides: null,
    saveOverrides: () => {},
    discardOverrides: () => {},
  }),
}))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))

// Both windows are VISIBLE (same active tab); only one is FOCUSED. The flag
// reaches each instance through a CONTEXT, like the real WindowFocusProvider —
// a module variable set during the parent's render would leak between the two
// instances the moment one of them re-rendered on its own.
vi.mock('@/components/views/unified-view-layout', async () => {
  const React = await import('react')
  const FocusCtx = React.createContext(true)
  return {
    useIsWindowFocused: () => React.useContext(FocusCtx),
    __FocusCtx: FocusCtx,
  }
})

import { EmailLayout } from '../email-layout'
import * as unifiedViewLayout from '@/components/views/unified-view-layout'

const FocusCtx = (unifiedViewLayout as unknown as { __FocusCtx: React.Context<boolean> }).__FocusCtx
let focusedById: Record<string, boolean> = {}

function Instance({ id }: { id: string }) {
  return h(FocusCtx.Provider, { value: focusedById[id] ?? true }, h(EmailLayout, null))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  channelNames.length = 0
  removedNames.length = 0
  focusedById = {}
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderPair(ids: string[]) {
  await act(async () => {
    root.render(h('div', null, ...ids.map((id) => h(Instance, { key: id, id }))))
  })
}

describe('EmailLayout — two Mail windows on screen', () => {
  it('only the FOCUSED one answers a keyboard shortcut', async () => {
    focusedById = { left: false, right: true }
    await renderPair(['left', 'right'])

    let composes = 0
    const onCompose = () => { composes++ }
    document.addEventListener('open-create-email', onCompose)
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
      })
    } finally {
      document.removeEventListener('open-create-email', onCompose)
    }

    // Before the gate this was 2 — one compose per mounted Mail view.
    expect(composes).toBe(1)
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    })
    const searches = container.querySelectorAll('input[aria-label="Search mail"]')
    expect(searches).toHaveLength(1)
    expect(document.activeElement).toBe(searches[0])
  })

  it('a background Mail view (not focused) ignores shortcuts entirely', async () => {
    focusedById = { only: false }
    await renderPair(['only'])

    let composes = 0
    const onCompose = () => { composes++ }
    document.addEventListener('open-create-email', onCompose)
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
      })
    } finally {
      document.removeEventListener('open-create-email', onCompose)
    }
    expect(composes).toBe(0)
  })

  it('each view subscribes on its own realtime channel', async () => {
    await renderPair(['left', 'right'])
    const threadChannels = channelNames.filter((n) => n.startsWith('email-threads-realtime'))
    expect(threadChannels).toHaveLength(2)
    expect(new Set(threadChannels).size).toBe(2)
  })

  it('unmounting one view removes only ITS channel', async () => {
    await renderPair(['left', 'right'])
    const [leftName, rightName] = channelNames.filter((n) => n.startsWith('email-threads-realtime'))
    await renderPair(['right'])
    expect(removedNames).toContain(leftName)
    expect(removedNames).not.toContain(rightName)
  })
})
