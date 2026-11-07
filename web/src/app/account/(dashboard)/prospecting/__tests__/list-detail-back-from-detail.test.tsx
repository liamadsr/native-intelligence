// @vitest-environment jsdom
/**
 * The way back out of an entry / company detail (§10, Page 4).
 *
 * THE BUG THIS PINS. The detail was a bare `absolute inset-0 z-20` box painted
 * over the list — over the list header and its "Lists" crumb included — and
 * `CompanyDetailPanel` draws no header of its own. So after "Add to CRM"
 * succeeded there was no back button, no breadcrumb and no Escape: the user was
 * parked on a company page with the whole app's navigation hidden underneath
 * and no gesture that returned them to the list.
 *
 * The fix is the shape every other detail in the app already has — the SHARED
 * `DetailBreadcrumbHeader` above the panel body — so what is pinned here is:
 *
 *  - a breadcrumb whose PARENT CRUMB IS THE LIST, not "Prospecting". The list
 *    is where the user was; sending them to the index would lose the list they
 *    are working in.
 *  - the crumb names the CANDIDATE, and after a save it still names the
 *    candidate that was saved rather than a bare "Company" — this is the one
 *    screen where the user most needs to know which record they just created.
 *  - Back returns to the list, and the list is still THERE.
 *  - ESCAPE does the same thing. It did nothing at all before.
 *  - the pre-save EntryPanel gets the identical treatment, and does NOT also
 *    carry a second X of its own.
 *
 * WHAT MOVED, AND WHY THESE ASSERTIONS CHANGED. The detail is now a MODAL
 * POP-UP over the list, which is the fourth shape this page has had (bare
 * overlay → Mail-style split → full-width sheet → modal) and the one Liam asked
 * for. Two consequences run through every test below:
 *
 *  - the modal is PORTALED, so it is not inside `container`. Assertions about
 *    what the detail shows read `document.body`, and `container` is now the
 *    thing that proves the LIST is still there.
 *  - the list stays VISIBLE behind the backdrop — no `invisible`, no `inert`.
 *    The sheet needed both to keep its money-spending buttons out of the tab
 *    order under an opaque cover; Radix's focus trap and outside-`aria-hidden`
 *    do that job for the modal, and hiding the list would make this a page
 *    navigation again rather than a pop-up.
 *
 * `listVisible()` asks the state ("the list is there and nothing is hiding it")
 * rather than naming a class, so it survives the page's wrappers being
 * reshuffled. Modal size is not asserted: jsdom measures every element as zero.
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

/**
 * The views layout is stubbed with a button that reports an item select, which
 * is exactly the seam the real one uses (`onItemSelect(id, title, event, item)`)
 * — so clicking a row is reproduced without mounting the whole views/realtime
 * stack. The marker element is what proves the list is still mounted UNDER the
 * sheet rather than swapped out for it.
 */
const { openEntryRow } = vi.hoisted(() => ({ openEntryRow: { current: null as null | (() => void) } }))
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: ({
    onItemSelect,
  }: {
    onItemSelect?: (id: string, title: string, e: undefined, item: unknown) => void
  }) => {
    openEntryRow.current = () =>
      onItemSelect?.('entry-1', 'Acme', undefined, ENTRY_ITEM.current)
    return <div data-testid="entries-list">ENTRIES_LIST</div>
  },
}))

// The CRM panel pulls in the whole enrichment stack; this suite is about the
// chrome AROUND it, so it is stubbed down to an identifying marker.
vi.mock('../../views/company-detail-panel', () => ({
  CompanyDetailPanel: ({ companyId }: { companyId: string }) => (
    <div data-testid="company-panel">COMPANY_PANEL:{companyId}</div>
  ),
}))

const fetchList = vi.fn()
const saveEntries = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    saveEntries: (ids: string[]) => saveEntries(ids),
  }
})

import { ListDetail } from '../list-detail'
import { EMPTY_COUNTS, LIST, entry } from './fixtures'

const ENTRY_ITEM = { current: entry() as ReturnType<typeof entry> }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  saveEntries.mockReset()
  openEntryRow.current = null
  ENTRY_ITEM.current = entry()
  fetchList.mockReset().mockResolvedValue({
    list: LIST,
    entries: [entry()],
    entry_counts: EMPTY_COUNTS,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render(onBack = noop) {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={onBack} />)
  })
  await act(async () => {})
}

async function openRow() {
  await act(async () => {
    openEntryRow.current!()
  })
}

/** Buttons are looked up across the whole document: the modal is portaled out
 *  of `container`, so its own controls are not in there. */
function buttonWithText(needle: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) =>
      (b.textContent ?? '').trim() === needle &&
      // The header's list name is a button too now (click to rename); the
      // crumb this suite is about is the one inside the detail.
      !b.hasAttribute('data-prospect-list-name'),
  )
}

/** The modal — present only while something is open, and PORTALED, which is
 *  how it escapes the content column's width and the chat strip's z-index. */
function detailPane(): HTMLElement | null {
  return document.body.querySelector('[data-testid="prospect-detail-pane"]')
}

/** What the modal is showing. Read separately from the page's own text so a
 *  test cannot pass on a string the LIST happens to render too. */
function paneText(): string {
  return detailPane()?.textContent ?? ''
}

/** The entries list itself. Never UNMOUNTED: the scroll position, the active
 *  saved view and the selection all live in there, and a remount would throw
 *  every one of them away. */
function entriesList(): HTMLElement | null {
  return container.querySelector('[data-testid="entries-list"]')
}

/**
 * Whether the list is there AND nothing in the page is hiding it.
 *
 * The sheet used to set `invisible` + `inert` on a wrapper around the whole
 * page, because it painted over money-spending controls that would otherwise
 * have stayed tabbable. The modal must set NEITHER — the list being seen behind
 * the backdrop is what makes this a pop-up — and Radix is what keeps it
 * unreachable, via focus trapping and `aria-hidden` on the body's other
 * children (a different mechanism at a different level, which is why this walk
 * stops at `container`).
 */
function listVisible(): boolean {
  const list = entriesList()
  expect(list, 'the entries list must stay mounted').toBeTruthy()
  let el: HTMLElement | null = list
  while (el && el !== container) {
    const classes = el.className.split(/\s+/)
    if (classes.includes('invisible') || classes.includes('hidden')) return false
    expect(
      el.hasAttribute('inert'),
      'nothing in the page may be inert while the modal is open — Radix owns reachability',
    ).toBe(false)
    el = el.parentElement
  }
  return true
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  await act(async () => {})
}

describe('ListDetail — getting back out of a detail', () => {
  it('gives the pre-save entry panel a breadcrumb back to THIS list', async () => {
    await render()
    expect(detailPane(), 'nothing is open yet').toBeNull()

    await openRow()

    // The crumb's parent is the list, not "Prospecting": the list is where the
    // user was, and the index would lose it.
    const back = buttonWithText('Customers like us')
    expect(back, 'the breadcrumb must name the list').toBeTruthy()
    // ...and the detail crumb names the candidate.
    expect(paneText()).toContain('Acme')

    // Exactly ONE close affordance, and it is the dialog's own X — the panel
    // must not also draw one under the crumb.
    expect(
      Array.from(detailPane()!.querySelectorAll('button')).filter(
        (b) => (b.textContent ?? '').trim() === 'Close',
      ),
      'exactly one close control',
    ).toHaveLength(1)
    expect(
      Array.from(document.body.querySelectorAll('[aria-label="Close"]')),
      'and no second one under a different label',
    ).toHaveLength(0)

    // The modal is up — and the list is still THERE, and still SEEN, behind it.
    expect(detailPane()).toBeTruthy()
    expect(entriesList(), 'the list stays mounted behind the modal').toBeTruthy()
    expect(listVisible(), 'and visible — that is what makes this a pop-up').toBe(true)

    await act(async () => {
      back!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})
    expect(detailPane()).toBeNull()
    expect(entriesList()).toBeTruthy()
    expect(listVisible()).toBe(true)
  })

  it('closes the entry panel on Escape', async () => {
    await render()
    await openRow()
    expect(detailPane()).toBeTruthy()

    await pressEscape()
    expect(detailPane()).toBeNull()
    expect(entriesList()).toBeTruthy()
    expect(listVisible()).toBe(true)
  })

  it('Save to list closes the entry panel and returns to the list — no CRM panel, nothing to exit', async () => {
    // Save is curation (migration 259). The path that used to open
    // CompanyDetailPanel with no way out no longer opens anything: the row is
    // on the list, and the list is what the user is looking at.
    saveEntries.mockResolvedValue({
      saved: [{ entry_id: 'entry-1', list_id: 'list-1', kind: 'company' }],
      skipped: [],
    })
    await render()
    await openRow()

    await act(async () => {
      buttonWithText('Save to list')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(document.body.textContent).not.toContain('COMPANY_PANEL')
    expect(detailPane()).toBeNull()
    expect(entriesList()).toBeTruthy()
    expect(listVisible()).toBe(true)
  })

  it('opens an already-saved entry straight into the company panel, with the crumb', async () => {
    // Clicking a row that was saved on an earlier visit takes the same path,
    // and had the same dead end.
    ENTRY_ITEM.current = entry({ company_id: 'company-4', stage: 'saved' })
    await render()
    await openRow()

    expect(paneText()).toContain('COMPANY_PANEL:company-4')
    expect(buttonWithText('Customers like us')).toBeTruthy()
    await pressEscape()
    expect(document.body.textContent).not.toContain('COMPANY_PANEL')
    expect(detailPane()).toBeNull()
  })
})
