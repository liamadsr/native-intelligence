// @vitest-environment jsdom
/**
 * The prospecting card opens on the list the agent named, gives its list page
 * the card's own target for row intents (so the real page never handles them
 * too), and Back moves the card to the lists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/prospecting/list-detail', async () => {
  const { useProspectEntryActionTarget } = await import('@/components/views/list/entity-row')
  return {
    ListDetail: ({ listId, onBack }: { listId: string; onBack: () => void }) => {
      const target = useProspectEntryActionTarget()
      return React.createElement('button', { 'data-list-detail': listId, 'data-own-target': String(target !== null), onClick: onBack }, 'back')
    },
  }
})

import ProspectingCard from '../pages/prospecting-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const LIST = '00000000-0000-4000-8000-000000000301'
const spec: PageCardSpec = { kind: 'prospecting', title: 'Fintech', target: { type: 'prospect_list', id: LIST, label: 'Fintech CFOs' } }

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('fetch', stubFetch({ lists: [], runs: [] }).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('ProspectingCard', () => {
  it("opens on the agent's list with its own row-intent target, and Back goes to the lists", async () => {
    const store = makeStore('call-1', spec)
    await mount.render(React.createElement(ProspectingCard, { toolCallId: 'call-1', spec, store, fullScreen: false }))
    const detail = mount.container.querySelector('[data-list-detail]') as HTMLElement
    expect(detail.getAttribute('data-list-detail')).toBe(LIST)
    expect(detail.getAttribute('data-own-target')).toBe('true')
    expect(store.contextEntries()[0]).toMatchObject({ at: { type: 'prospect_list', id: LIST } })
    expect(store.contextEntries()[0].moved).toBeUndefined()

    await act(async () => detail.click())
    expect(mount.container.querySelector('[data-list-detail]')).toBeNull()
    expect(store.contextEntries()[0]).toMatchObject({ moved: true })
    expect(store.contextEntries()[0].at).toBeUndefined()
  })
})
