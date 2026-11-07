// @vitest-environment jsdom
/**
 * Opening Mail asks for the folder counts once, and its own channel's close
 * (React's dev double mount removes the first channel) is not a gap to
 * recover from: no extra counts call, no list refresh. Counts share one
 * in-flight request per URL (src/lib/email/inflight-get.ts).
 *
 * The REAL component is mounted; only the data/UI deps are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, StrictMode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refreshKeys: number[] = []

// Supabase: a channel that reports SUBSCRIBED when subscribed and CLOSED
// when removed, as realtime-js does, so React's dev double mount closes the
// first channel before the second subscribes.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    let onStatus: ((s: string) => void) | null = null
    ch.on = () => ch
    ch.subscribe = (cb: (s: string) => void) => {
      onStatus = cb
      cb('SUBSCRIBED')
      return ch
    }
    return { channel: () => ch, removeChannel: () => onStatus?.('CLOSED') }
  },
}))

// Child surfaces are irrelevant here — stub them to keep the tree cheap.
vi.mock('../email-thread-list', () => ({ EmailThreadList: ({ refreshKey }: { refreshKey?: number }) => { refreshKeys.push(refreshKey ?? 0); return null } }))
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
vi.mock('@/components/views/unified-view-layout', () => ({ useIsWindowFocused: () => true }))

import { EmailLayout } from '../email-layout'
import { __resetSelfRefetchMarks } from '@/lib/supabase/realtime-recovery'
import { resetInflightGets } from '@/lib/email/inflight-get'

let countsCalls = 0
const fetchMock = vi.fn(async (url: string) => {
  if (typeof url === 'string' && url.includes('/api/account/email/counts')) countsCalls++
  return { ok: true, json: async () => ({}) } as unknown as Response
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  countsCalls = 0
  refreshKeys.length = 0
  __resetSelfRefetchMarks()
  resetInflightGets()
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
  vi.useRealTimers()
})

describe('EmailLayout — opening Mail', () => {
  it('asks for the counts once and never refreshes the list for its own channel close, even under StrictMode', async () => {
    await act(async () => {
      root.render(h(StrictMode, null, h(EmailLayout, null)))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(countsCalls).toBe(1)
    expect(new Set(refreshKeys)).toEqual(new Set([0]))
  })
})
