// @vitest-environment jsdom
/**
 * A list page in a chat card (pages in the chat, P3) stays out of the page's
 * module stores: the Sequenced map the person rows read and the selection
 * Scout reads are one per app, and a card writing or clearing them would wipe
 * the real page's. The same page outside a card publishes as ever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
vi.mock('@/components/views/unified-view-layout', () => ({ UnifiedViewLayout: () => null }))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const stores = vi.hoisted(() => ({ sequenced: vi.fn(), selection: vi.fn() }))
vi.mock('@/components/views/list/entity-row', async () => {
  const actual = await vi.importActual<typeof import('@/components/views/list/entity-row')>('@/components/views/list/entity-row')
  return { ...actual, publishProspectSequenced: (m: unknown) => stores.sequenced(m) }
})
vi.mock('../selection-context', async () => {
  const actual = await vi.importActual<typeof import('../selection-context')>('../selection-context')
  return { ...actual, publishProspectingSelection: (id: string, s: unknown) => stores.selection(id, s) }
})
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  const { LIST } = await import('./fixtures')
  return {
    ...actual,
    fetchList: () => Promise.resolve({ list: LIST, entries: [], entry_counts: { discovered: 0, shortlisted: 0, saved: 0, dismissed: 0, total: 0 } }),
    fetchRuns: () => Promise.resolve([]),
    fetchAngles: () => Promise.resolve([]),
    fetchSequenced: () => Promise.resolve({}),
  }
})

import { ProspectEntryActionTargetContext } from '@/components/views/list/entity-row'
import { ListDetail } from '../list-detail'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  stores.sequenced.mockClear()
  stores.selection.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

describe('list detail stores', () => {
  it('a card publishes to neither store, and clears neither when it goes', async () => {
    await act(async () => {
      root.render(
        <ProspectEntryActionTargetContext.Provider value={new EventTarget()}>
          <ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />
        </ProspectEntryActionTargetContext.Provider>,
      )
    })
    await act(async () => {})
    await act(async () => root.render(<></>))
    expect(stores.sequenced).not.toHaveBeenCalled()
    expect(stores.selection).not.toHaveBeenCalled()
  })

  it('the page publishes to both, as ever', async () => {
    await act(async () => {
      root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
    })
    await act(async () => {})
    expect(stores.sequenced).toHaveBeenCalled()
    expect(stores.selection).toHaveBeenCalledWith('list-1', expect.objectContaining({ listId: 'list-1' }))
  })
})
