// @vitest-environment jsdom
/**
 * `useEnrichment`'s 3s status poll while a web enrichment is pending: every
 * 3s until it settles, and never past its two-minute cap. (It no longer pauses
 * for a background tab: there are no tabs, one-chat plan.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useEnrichment, type EnrichableRow } from '../enrichment'

const DETAIL_URL = '/api/account/contacts/c-1'
const POLL_MS = 3000

let status: 'pending' | 'enriched' = 'pending'
let fetchMock: ReturnType<typeof vi.fn>
const onRefreshed = vi.fn()

function detailCalls() {
  return fetchMock.mock.calls.filter((c) => String(c[0]) === DETAIL_URL).length
}

function Panel() {
  const [row, setRow] = useState<EnrichableRow>({ enrichment_status: 'pending' })
  useEnrichment({
    endpoint: 'contacts',
    id: 'c-1',
    row,
    onRefreshed: (fresh) => {
      onRefreshed(fresh)
      setRow(fresh)
    },
    responseKey: 'contact',
  })
  return null
}

let container: HTMLDivElement
let root: Root

function render() {
  act(() => {
    root.render(h(Panel))
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  status = 'pending'
  onRefreshed.mockReset()
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ contact: { id: 'c-1', enrichment_status: status } }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useEnrichment — its status poll', () => {
  it('polls every 3s while pending', async () => {
    render()
    await advance(POLL_MS)
    expect(detailCalls()).toBe(1)
    await advance(POLL_MS)
    expect(detailCalls()).toBe(2)
  })

  it('stops once the enrichment settles', async () => {
    render()
    status = 'enriched'
    await advance(POLL_MS)
    expect(detailCalls()).toBe(1)
    expect(onRefreshed).toHaveBeenCalledWith(expect.objectContaining({ enrichment_status: 'enriched' }))
    await advance(POLL_MS * 3)
    expect(detailCalls()).toBe(1)
  })

  it('gives up at its two-minute cap', async () => {
    render()
    await advance(120_000 + POLL_MS * 2)
    const at = detailCalls()
    await advance(POLL_MS * 3)
    expect(detailCalls()).toBe(at)
  })
})
