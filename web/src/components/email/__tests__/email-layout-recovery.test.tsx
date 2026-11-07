// @vitest-environment jsdom
/**
 * Recovery catch-up behaviour for EmailLayout.
 *
 * Every Mail tab stays MOUNTED (display:none when inactive), so several
 * EmailLayouts share the module-scoped self-refetch dedup map. Two properties
 * have to hold on a socket repair:
 *
 *   1. The TAB GATE runs before the dedup. A hidden instance must record its
 *      dirty flag and defer — it cannot be short-circuited by a dedup mark,
 *      least of all one a SIBLING instance wrote, or it skips the gap entirely
 *      (no refresh now, and none on reactivation either).
 *   2. The active path fetches counts immediately alongside the debounced
 *      thread refresh. The badge is the visible half of the catch-up and must
 *      not wait 800ms behind scheduleRefresh.
 *
 * The REAL component is mounted; only the data/UI deps are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Supabase: capture nothing, just satisfy the channel builder.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = () => ch
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))

// Child surfaces are irrelevant here — stub them to keep the tree cheap.
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

// The tab gate this component reads. Driven per-instance by the test.
let tabActiveById: Record<string, boolean> = {}
let currentInstance = ''
vi.mock('@/components/views/unified-view-layout', () => ({
  useIsWindowFocused: () => tabActiveById[currentInstance] ?? true,
}))

import { EmailLayout } from '../email-layout'
import {
  __resetSelfRefetchMarks,
  markSelfRefetched,
} from '@/lib/supabase/realtime-recovery'

// Count only the calls this test cares about: the counts endpoint is the
// immediate half of the catch-up.
let countsCalls = 0
const fetchMock = vi.fn(async (url: string) => {
  if (typeof url === 'string' && url.includes('/api/account/email/counts')) countsCalls++
  return { ok: true, json: async () => ({}) } as unknown as Response
})

let container: HTMLDivElement
let root: Root

/** Renders one EmailLayout whose tab-active state the test controls by name. */
function Instance({ id }: { id: string }) {
  currentInstance = id
  return h(EmailLayout, null)
}

beforeEach(() => {
  countsCalls = 0
  tabActiveById = {}
  currentInstance = ''
  __resetSelfRefetchMarks()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function fireRecovered() {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('dial8:realtime-recovered', { detail: { repairId: 0 } }),
    )
    await Promise.resolve()
  })
}

describe('EmailLayout recovery catch-up', () => {
  it('fetches counts IMMEDIATELY on the active path (not only the debounced refresh)', async () => {
    tabActiveById.solo = true
    await act(async () => {
      root.render(h(Instance, { id: 'solo' }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = countsCalls

    await fireRecovered()

    // The badge must repaint now, not 800ms later behind scheduleRefresh.
    expect(countsCalls).toBe(afterMount + 1)
  })

})
