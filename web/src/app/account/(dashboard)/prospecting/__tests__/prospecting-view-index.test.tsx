// @vitest-environment jsdom
/**
 * The lists INDEX (§10, Page 1) — now the views system, not a card grid.
 *
 * WHAT CHANGED AND WHY THIS SUITE MOVED WITH IT. The index used to be a
 * hand-built grid of cards, each fetching its own newest run. That is fine for
 * three lists and unusable for thirty: no sorting, no filtering, no saved
 * views, and N requests per page load. It is now
 * `<UnifiedViewLayout entityType="prospect_list">`, which brings the whole
 * toolbar for free — so this page's remaining job is small and precisely
 * testable:
 *
 *   1. choose between the EMPTY STATE and the layout (the layout cannot make
 *      that call from inside itself: the empty state is the whole pre-fill
 *      wedge and must replace the toolbar, not sit under it);
 *   2. hand a row click to `onOpenList`, unchanged, so the existing tab
 *      navigation into a list keeps working;
 *   3. tell the mounted list when a list is created, since `loadLists` only
 *      refreshes THIS page's empty/non-empty decision and never touches the
 *      layout's own query;
 *   4. publish the live-run ids the rows read for their pulsing telescope, and
 *      clear them on unmount so a finished run cannot leave a dot behind.
 *
 * The row's own rendering — the chips, the run line, the dot — is pinned by
 * `src/components/views/__tests__/prospect-list-row.test.tsx`, which is why
 * the layout is MOCKED here: this suite is about the page's decisions, not
 * about re-testing the shared list one level down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../list-detail', () => ({ ListDetail: () => null }))

/**
 * The layout, reduced to what the page's contract is about: which entity it
 * was asked for, and what a click on a row does. Rendering the real one would
 * drag in the query engine, the virtualizer and a network layer to assert two
 * props.
 */
const layoutProps = vi.fn()
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: Record<string, unknown>) => {
    layoutProps(props)
    return (
      <button
        type="button"
        data-testid="fake-row"
        onClick={() =>
          (props.onItemSelect as (id: string, title: string) => void)?.(
            'list-1',
            'Customers like us',
          )
        }
      >
        prospect list rows
      </button>
    )
  },
  // The page's research poll gates on this (useDrawnPollGate) — same module.
  useIsWindowDrawn: () => true,
}))

const publishProspectListLive = vi.fn()
vi.mock('@/components/views/list/entity-row', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/views/list/entity-row')>(
      '@/components/views/list/entity-row',
    )
  return {
    ...actual,
    publishProspectListLive: (ids: ReadonlySet<string>) => publishProspectListLive(ids),
  }
})

const fetchLists = vi.fn(async () => [] as unknown[])
const fetchSource = vi.fn()
const researchSource = vi.fn()
const fetchRuns = vi.fn(async (_id: string, _limit?: number) => [] as unknown[])
const fetchActiveRuns = vi.fn(async () => [] as unknown[])
const createList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchLists: () => fetchLists(),
    fetchSource: () => fetchSource(),
    researchSource: () => researchSource(),
    fetchRuns: (id: string, limit?: number) => fetchRuns(id, limit),
    fetchActiveRuns: () => fetchActiveRuns(),
    createList: (body: unknown) => createList(body),
  }
})

import { ProspectingView } from '../prospecting-view'
import { CARDED_COMPANY, sourcePayload } from './fixtures'

let container: HTMLDivElement
let root: Root

const LIST_ROW = {
  id: 'list-1',
  name: 'Customers like us',
  purpose: 'buyers',
  updated_at: new Date().toISOString(),
  entry_counts: { discovered: 8, shortlisted: 0, saved: 2, dismissed: 1, total: 11 },
}

beforeEach(() => {
  layoutProps.mockClear()
  publishProspectListLive.mockClear()
  fetchLists.mockReset().mockResolvedValue([])
  fetchSource.mockReset().mockResolvedValue(sourcePayload(CARDED_COMPANY))
  researchSource.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  fetchActiveRuns.mockReset().mockResolvedValue([])
  createList.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const onOpenList = vi.fn()

async function render() {
  onOpenList.mockClear()
  await act(async () => {
    root.render(
      <ProspectingView listId={null} onOpenList={onOpenList} onCloseDetail={() => {}} />,
    )
  })
  // Lists, source and the active-run feed each settle on their own promise.
  await act(async () => {})
  await act(async () => {})
}

function text() {
  return container.textContent ?? ''
}

function fakeRow(): HTMLElement | null {
  return container.querySelector('[data-testid="fake-row"]')
}

function lastLayoutProps(): Record<string, unknown> {
  return layoutProps.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

describe('Prospecting index — empty state versus the list', () => {
  /** The wedge is what earns the whole pre-fill flow (§4); a workspace with no
   *  lists must NEVER be shown an empty views table with a toolbar on it. */
  it('renders the empty state and no layout at all when there are no lists', async () => {
    await render()
    expect(fakeRow()).toBeNull()
    expect(layoutProps).not.toHaveBeenCalled()
    // The wedge's own copy, from the carded-company fixture.
    expect(text()).toContain('Who should we find?')
  })

  it('mounts the views layout for the prospect_list entity once a list exists', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    expect(fakeRow()).not.toBeNull()
    expect(lastLayoutProps().entityType).toBe('prospect_list')
  })

  /** UNSCOPED: these are the workspace's lists, not the entries of one. A
   *  `viewScope` here would filter the index down to a single list. */
  it('mounts it unscoped', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    expect(lastLayoutProps().viewScope).toBeUndefined()
    expect(lastLayoutProps().scopeFilters).toBeUndefined()
  })

  it('shows a spinner, not the empty state, before the lists are known', async () => {
    let resolve: (value: unknown[]) => void = () => {}
    fetchLists.mockReturnValue(new Promise<unknown[]>((r) => { resolve = r }))
    await act(async () => {
      root.render(
        <ProspectingView listId={null} onOpenList={onOpenList} onCloseDetail={() => {}} />,
      )
    })
    expect(text()).not.toContain('Who should we find?')
    expect(fakeRow()).toBeNull()
    await act(async () => { resolve([LIST_ROW]) })
    await act(async () => {})
    expect(fakeRow()).not.toBeNull()
  })
})

describe('Prospecting index — opening a list', () => {
  /** The tab navigation into a list (a real history step, with the name riding
   *  along for the tab label) is UNCHANGED by the move to the views system —
   *  the layout just replaces the card as the thing that reports the click. */
  it('hands a row click straight to onOpenList with the id and the name', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    await act(async () => {
      fakeRow()!.click()
    })
    expect(onOpenList).toHaveBeenCalledWith('list-1', 'Customers like us')
  })
})

describe('Prospecting index — a newly created list', () => {
  /**
   * `loadLists` refreshes this page's empty/non-empty DECISION; it does not
   * touch the layout's own query. `dial8:entity-created` is the seam that list
   * already listens on, and without it a list created from the sheet or the
   * Custom card would not appear until a reload.
   */
  it('announces the creation on the entity-created seam', async () => {
    fetchLists.mockResolvedValue([])
    createList.mockResolvedValue({ id: 'list-new', name: 'companies with a revops team' })
    const events: string[] = []
    const onCreated = (e: Event) => {
      events.push(((e as CustomEvent).detail as { entityType: string }).entityType)
    }
    window.addEventListener('dial8:entity-created', onCreated)
    try {
      await render()
      // The Custom starter card's inline box — the one create path reachable
      // without opening the sheet.
      const box = container.querySelector('#prospecting-custom-target') as HTMLInputElement
      expect(box).not.toBeNull()
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!
        setter.call(box, 'companies with a revops team')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        box.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
      })
      await act(async () => {})
      expect(createList).toHaveBeenCalled()
      expect(events).toContain('prospect_list')
    } finally {
      window.removeEventListener('dial8:entity-created', onCreated)
    }
  })

  /** The page still navigates into the new list — the announcement is in
   *  ADDITION to that, so coming back finds the index current. */
  it('still opens the list it just created', async () => {
    fetchLists.mockResolvedValue([])
    createList.mockResolvedValue({ id: 'list-new', name: 'companies with a revops team' })
    await render()
    const box = container.querySelector('#prospecting-custom-target') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(box, 'companies with a revops team')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {})
    expect(onOpenList).toHaveBeenCalledWith('list-new', 'companies with a revops team')
  })
})

describe('Prospecting index — live runs reach the rows', () => {
  /**
   * The rows are mounted deep inside the shared views system, which hands a
   * row only its item and the view's display properties. So the page publishes
   * and the rows subscribe — without this a row would only learn a run started
   * when its own query happened to refetch, which for a run Scout begins
   * beside this very screen is "never".
   */
  it('publishes the live list ids from the active-run feed', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    fetchActiveRuns.mockResolvedValue([
      { id: 'run-1', list_id: 'list-1', list_name: 'Customers like us', status: 'running', is_live: true },
    ])
    await render()
    const published = publishProspectListLive.mock.calls.at(-1)?.[0] as Set<string>
    expect(published.has('list-1')).toBe(true)
  })

  it('publishes an empty set while nothing is running', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    const published = publishProspectListLive.mock.calls.at(-1)?.[0] as Set<string>
    expect(published.size).toBe(0)
  })

  /** A stale id would light a telescope on a list whose run finished while the
   *  user was on another tab. */
  it('clears the store on unmount', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    fetchActiveRuns.mockResolvedValue([
      { id: 'run-1', list_id: 'list-1', list_name: 'Customers like us', status: 'running', is_live: true },
    ])
    await render()
    publishProspectListLive.mockClear()
    await act(async () => root.unmount())
    const published = publishProspectListLive.mock.calls.at(-1)?.[0] as Set<string>
    expect(published.size).toBe(0)
    // Re-mount so the shared afterEach can unmount without throwing.
    root = createRoot(container)
  })
})

describe('Prospecting index — the header survives the move', () => {
  /**
   * The beta pill is a promise to the user that this page may misbehave, so it
   * has to be ON the page. Asserted through the header rather than by a bare
   * text match, because "Beta" appearing anywhere would satisfy a looser check
   * while the header stayed bare.
   */
  it('labels the index header as beta, immediately right of the title', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    const header = container.querySelector('h1, .font-semibold')
    const pill = container.querySelector('[data-beta-pill]')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toBe('Beta')
    expect(pill?.getAttribute('title')).toContain('beta')
    expect(header?.textContent).toContain('Prospecting')
    expect(header?.contains(pill!)).toBe(true)
  })

  /** The "+" is the only way to reach the sheet once the wedge is gone. */
  it('offers New list beside the header once lists exist', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    expect(container.querySelector('[aria-label="New list"]')).not.toBeNull()
  })

  /** On an EMPTY workspace the starter cards are the create affordance; a "+"
   *  beside them would be a second, worse door into the same sheet. */
  it('hides New list while the wedge is on screen', async () => {
    await render()
    expect(container.querySelector('[aria-label="New list"]')).toBeNull()
  })

  /** The per-card `fetchRuns` probe went away with the cards: the run now
   *  rides on the views query as an embedded relation, and liveness comes from
   *  the one active-run poll. */
  it('makes no per-list run request at all', async () => {
    fetchLists.mockResolvedValue([LIST_ROW])
    await render()
    expect(fetchRuns).not.toHaveBeenCalled()
  })
})
