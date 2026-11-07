// @vitest-environment jsdom
/**
 * THE STAGE TABS AND THE CUSTOM VIEWS, wired into the list detail (Liam,
 * 2026-09-06: "combine the top-level filters — All, Saved, Dismissed — with the
 * filtered views; don't lose the logic that dismissed companies stay out of
 * the list that lands in the CRM, only Saved is the master list, and the
 * default view should be Saved once at least one is saved").
 *
 * The shared views toolbar draws the tabs; this page decides which tab is in
 * force and what it narrows to. Five things have to hold, and each is the kind
 * of thing that fails quietly:
 *
 *  - the OPENING tab: All on a list with nothing saved, Saved the moment it has
 *    anything — decided ONCE, so a first save does not yank the user off All;
 *  - while a custom view is open the tab stands down: no stage narrowing, so
 *    the view runs on the baseline (still on the list — the server's default);
 *  - a tab picked from the save story clears the open custom view through the
 *    layout's own selector, so a tab and a view never both read as selected;
 *  - "Enrich · N" under a custom view counts only the rows the view shows;
 *  - Scout hears the baseline, not a stale tab, while a view is open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

interface LayoutProps {
  scopeFilters?: Array<{ field: string; operator: string; value: unknown }>
  prospectStage?: string | null
  prospectStageCounts?: Record<string, number> | null
  onProspectStageChange?: (tab: string) => void
  onActiveViewChange?: (viewId: string | null) => void
  onViewSelectorReady?: (select: (viewId: string | null, opts?: { silent?: boolean }) => void) => void
  onVisibleItemsChange?: (items: Array<{ id: string; title: string; item: unknown }>) => void
  onBulkSelectionChange?: (info: unknown) => void
  toolbarActions?: React.ReactNode
  selectionActions?: React.ReactNode
}

/** The props the page last handed the (stubbed) shared layout. */
let layout: LayoutProps = {}
/** What the page asked the layout's selector to do. */
const selectorSpy = vi.fn()
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: LayoutProps) => {
    layout = props
    // The real layout hands its selector up and then reports the selection it
    // lands on; the stub does both, so the page sees what it would see.
    props.onViewSelectorReady?.((viewId, opts) => {
      selectorSpy(viewId, opts)
      props.onActiveViewChange?.(viewId)
    })
    return <>{props.toolbarActions}{props.selectionActions}</>
  },
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const fetchActiveRuns = vi.fn()
const saveEntries = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchActiveRuns: () => fetchActiveRuns(),
    fetchSequenced: () => Promise.resolve({}),
    saveEntries: (ids: string[], includeUnverified: boolean) => saveEntries(ids, includeUnverified),
  }
})

import { ListDetail } from '../list-detail'
import { publishScoutActivity, __resetScoutActivityStore } from '../scout-activity'
import { readProspectingSelection, __resetProspectingSelectionStore } from '../selection-context'
import { LIST, entry } from './fixtures'

/** Three unresearched companies — nothing saved, nothing dismissed. */
const ENTRIES = [
  entry({ id: 'c1', fit_score: null }),
  entry({ id: 'c2', fit_score: null }),
  entry({ id: 'c3', fit_score: null }),
]
const NOTHING_SAVED = { discovered: 3, shortlisted: 0, saved: 0, dismissed: 0, total: 3 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  __resetScoutActivityStore()
  __resetProspectingSelectionStore()
  layout = {}
  selectorSpy.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  saveEntries.mockReset()
  fetchRun.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  fetchActiveRuns.mockReset().mockResolvedValue([])
  fetchList.mockReset().mockResolvedValue({ list: LIST, entries: ENTRIES, entry_counts: NOTHING_SAVED })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
  })
  await act(async () => {})
}

function scope() {
  return layout.scopeFilters ?? []
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  )
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

/** The layout says a custom view is open (or closed) — what the real one
 *  reports on mount, on a restore, and on every pick. */
async function openView(viewId: string | null) {
  await act(async () => {
    layout.onActiveViewChange?.(viewId)
  })
}

async function pickStage(tab: string) {
  await act(async () => {
    layout.onProspectStageChange?.(tab)
  })
}

/** Scout wrote to the list — the page refetches (see list-detail-story). */
async function scoutDismissed(version: number) {
  await act(async () => {
    publishScoutActivity('chat-1', 'list-1', {
      listId: 'list-1',
      version,
      lastEventAt: Date.now(),
      touched: true,
      lastSave: null,
      lastEnroll: null,
      lastDismiss: { toolCallId: `call-${version}`, updated: 1 },
    })
  })
  await act(async () => {})
}

describe('the opening tab', () => {
  it('is All on a list with nothing saved', async () => {
    await render()
    expect(layout.prospectStage).toBe('all')
    expect(scope().map((f) => f.field)).toEqual(['list_id', 'kind'])
    expect(layout.prospectStageCounts).toMatchObject({ all: 3, saved: 0, dismissed: 0 })
  })

  it('is Saved the moment the list has anything saved — the list itself, not the pool', async () => {
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [...ENTRIES, entry({ id: 'c4', fit_score: 80, stage: 'saved' })],
      entry_counts: { ...NOTHING_SAVED, saved: 1, total: 4 },
    })
    await render()
    expect(layout.prospectStage).toBe('saved')
    expect(scope().find((f) => f.field === 'stage')).toMatchObject({ operator: 'is', value: 'saved' })
  })

  it('is decided ONCE — a first save does not yank the user off All', async () => {
    await render()
    expect(layout.prospectStage).toBe('all')

    // The next read says one row is saved now. The page refetches (Scout
    // touched the list) and must stay where the user is.
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [...ENTRIES, entry({ id: 'c4', fit_score: 80, stage: 'saved' })],
      entry_counts: { ...NOTHING_SAVED, saved: 1, total: 4 },
    })
    const before = fetchList.mock.calls.length
    await scoutDismissed(1)
    expect(fetchList.mock.calls.length).toBeGreaterThan(before)

    expect(layout.prospectStage).toBe('all')
    expect(layout.prospectStageCounts?.saved).toBe(1)
  })

  it('draws the tabs bare on an empty list — no counts to show', async () => {
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [],
      entry_counts: { discovered: 0, shortlisted: 0, saved: 0, dismissed: 0, total: 0 },
    })
    await render()
    expect(layout.prospectStageCounts).toBeNull()
    expect(layout.prospectStage).toBe('all')
  })
})

describe('a tab and a custom view are mutually exclusive', () => {
  it('stands the tab down while a view is open — the view runs on the baseline — and brings it back after', async () => {
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [...ENTRIES, entry({ id: 'c4', fit_score: 80, stage: 'saved' })],
      entry_counts: { ...NOTHING_SAVED, saved: 1, total: 4 },
    })
    await render()
    expect(layout.prospectStage).toBe('saved')

    await openView('view-1')
    // No tab in force: no stage narrowing, companies as ever. "Still on the
    // list" is the server's default, so the view inherits it.
    expect(layout.prospectStage).toBeNull()
    expect(scope().map((f) => f.field)).toEqual(['list_id', 'kind'])
    expect(scope().find((f) => f.field === 'kind')?.value).toBe('company')

    await openView(null)
    expect(layout.prospectStage).toBe('saved')
    expect(scope().find((f) => f.field === 'stage')?.value).toBe('saved')
  })

  it('a tab picked from the save story clears the open view through the layout’s own selector', async () => {
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company', company_id: 'co-2' },
      ],
      skipped: [],
    })
    await render()
    await openView('view-1')

    // A bulk save from the selection bar puts the story up.
    await act(async () => {
      layout.onBulkSelectionChange?.({
        hasSelection: true,
        count: 2,
        selectedIds: ['c1', 'c2'],
        onClear: () => {},
      })
    })
    await click(document.body.querySelector('button[data-prospect-save-selection]')!)
    await click(button('2 companies saved to the list')!)

    expect(selectorSpy).toHaveBeenCalledWith(null, { silent: true })
    expect(layout.prospectStage).toBe('saved')
    expect(scope().find((f) => f.field === 'stage')?.value).toBe('saved')
  })

  it('a tab picked in the toolbar takes effect even while a view is open — the toolbar has cleared the view', async () => {
    await render()
    await openView('view-1')
    expect(layout.prospectStage).toBeNull()

    // The real toolbar clears the view (the layout then reports null) and
    // reports the tab; the page also clears through the selector, belt and
    // braces, so the order of the two cannot matter.
    await pickStage('dismissed')
    expect(selectorSpy).toHaveBeenCalledWith(null, { silent: true })
    expect(layout.prospectStage).toBe('dismissed')
    expect(scope().find((f) => f.field === 'stage')?.value).toBe('dismissed')
  })
})

describe('what the rest of the page reads off the tab', () => {
  it('"Enrich · N" under a custom view counts only the rows the view is showing', async () => {
    await render()
    // On All, every unprofiled company still on the list.
    expect(button('Enrich · 3')).toBeTruthy()

    await openView('view-1')
    await act(async () => {
      layout.onVisibleItemsChange?.([{ id: 'c2', title: 'Two', item: {} }])
    })
    expect(button('Enrich · 1')).toBeTruthy()
    expect(button('Enrich · 3')).toBeUndefined()

    await openView(null)
    expect(button('Enrich · 3')).toBeTruthy()
  })

  it('tells Scout the baseline, not a stale tab, while a view is open', async () => {
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [...ENTRIES, entry({ id: 'c4', fit_score: 80, stage: 'saved' })],
      entry_counts: { ...NOTHING_SAVED, saved: 1, total: 4 },
    })
    await render()
    expect(readProspectingSelection('list-1')?.filter).toBe('saved')

    await openView('view-1')
    expect(readProspectingSelection('list-1')?.filter).toBe('all')
  })
})
