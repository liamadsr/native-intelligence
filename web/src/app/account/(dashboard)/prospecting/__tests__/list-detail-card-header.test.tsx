// @vitest-environment jsdom
/**
 * A prospect list in a card (Liam, 11-22: "the back button should just be the
 * breadcrumb"): the list is a place in the card's header, "Prospecting ›
 * Customers like us", the card's title the way back to the lists, the name
 * still renamed in place, and the list's controls at the header's end. The
 * page draws no header row of its own.
 *
 * The entry pop-up is a frame of its own: its breadcrumb and arrows stay in
 * it, not in the card's header behind its backdrop, where they could not be
 * reached.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardHeaderSlotsProvider, type CardHeaderBack } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const { openEntryRow } = vi.hoisted(() => ({ openEntryRow: { current: null as null | (() => void) } }))
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: ({ onItemSelect }: { onItemSelect?: (id: string, title: string, e: undefined, item: unknown) => void }) => {
    openEntryRow.current = () => onItemSelect?.('entry-1', 'Acme', undefined, ENTRY_ITEM.current)
    return <div data-testid="entries-list">ENTRIES_LIST</div>
  },
}))
vi.mock('../../views/company-detail-panel', () => ({
  CompanyDetailPanel: ({ companyId }: { companyId: string }) => <div data-testid="company-panel">COMPANY_PANEL:{companyId}</div>,
}))

const fetchList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, fetchList: (id: string) => fetchList(id) }
})

import { ListDetail } from '../list-detail'
import { EMPTY_COUNTS, LIST, entry } from './fixtures'

const ENTRY_ITEM = { current: entry() as ReturnType<typeof entry> }

let container: HTMLDivElement
let right: HTMLDivElement
let trail: HTMLDivElement
let root: Root
let back: CardHeaderBack | null

beforeEach(() => {
  openEntryRow.current = null
  ENTRY_ITEM.current = entry()
  fetchList.mockReset().mockResolvedValue({ list: LIST, entries: [entry()], entry_counts: EMPTY_COUNTS })
  container = document.createElement('div')
  right = document.createElement('div')
  trail = document.createElement('div')
  document.body.append(right, trail, container)
  root = createRoot(container)
  back = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  trail.remove()
})

async function renderInCard(onBack = () => {}) {
  await act(async () => {
    root.render(
      <CardHeaderSlotsProvider value={{ left: null, right, trail, setBack: (b) => (back = b) }}>
        <ListDetail listId="list-1" onBack={onBack} />
      </CardHeaderSlotsProvider>,
    )
  })
  await act(async () => {})
}

describe('a prospect list in a card', () => {
  it('its name is the header’s breadcrumb, the title back to the lists, its controls at the header’s end', async () => {
    const onBack = vi.fn()
    await renderInCard(onBack)
    const name = trail.querySelector<HTMLButtonElement>('[data-prospect-list-name]')!
    expect(name.textContent).toBe(LIST.name)
    expect(container.querySelector('[data-prospect-list-name]')).toBeNull()
    expect(back!.label).toBe('Back to lists')
    back!.go()
    expect(onBack).toHaveBeenCalled()
    expect(right.querySelector('button[aria-label="List settings"]')).not.toBeNull()
    expect(right.querySelector('[data-prospect-find-people-header]')).not.toBeNull()
    expect(right.querySelector('[data-prospect-publish]')).not.toBeNull()
  })

  it('renames in place in the breadcrumb', async () => {
    await renderInCard()
    await act(async () => trail.querySelector<HTMLButtonElement>('[data-prospect-list-name]')!.click())
    const input = trail.querySelector<HTMLInputElement>('[data-prospect-list-name-input]')!
    expect(input.value).toBe(LIST.name)
    expect(document.activeElement).toBe(input)
  })

  it('an entry’s pop-up keeps its own breadcrumb and arrows, not the card header’s', async () => {
    await renderInCard()
    await act(async () => openEntryRow.current!())
    const header = document.body.querySelector('[data-testid="prospect-detail-header"]')!
    expect(header.textContent).toContain(LIST.name)
    expect(header.textContent).toContain('Acme')
    expect(header.querySelectorAll('button').length).toBeGreaterThanOrEqual(3)
    // The card's breadcrumb is still the list, and nothing of the entry's went there.
    expect(trail.textContent).toBe(LIST.name)
    expect(trail.textContent).not.toContain('Acme')
  })
})
