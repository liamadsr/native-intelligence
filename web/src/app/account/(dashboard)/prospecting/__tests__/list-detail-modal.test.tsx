// @vitest-environment jsdom
/**
 * The prospect detail is a MODAL POP-UP over the list.
 *
 * WHAT THIS REPLACES, AND WHY IT KEEPS MOVING. This page has now had four
 * shapes. First a bare `absolute inset-0` box with the list `hidden` underneath:
 * no crumb, no back, no Escape, and a remount every time you closed it. Then a
 * Mail-style 45/55 resizable split, on the theory that triage wants the list
 * beside what you are reading — which did not survive the shell, because this
 * page lives in the dashboard's CONTENT column that the chat strip already caps
 * at roughly half the viewport, so 55% of a half is a ~400px reading pane and
 * every panel inside it spent its width wrapping. Third a full-width SHEET over
 * the whole column: readable, but it read as a page navigation — the list
 * vanished, so clicking a prospect felt like leaving the list.
 *
 * Liam asked for a POP-UP, and a pop-up is the honest shape: the list stays on
 * screen behind the backdrop, so the modal reads as "this row, expanded", and
 * closing it is visibly a return to something that never went away.
 *
 * WHAT THIS SUITE PINS, and what changed from the sheet's suite:
 *
 *  1. the detail is a portaled Radix dialog — it is NOT inside the page's own
 *     container, which is how it escapes the chat column's z-index and the
 *     content column's width;
 *  2. the list stays MOUNTED **and VISIBLE** while it is open, and is NOT
 *     `inert`. That is the inversion: the sheet had to hide and inert the whole
 *     page by hand to keep its money-spending buttons out of the tab order, and
 *     the modal gets focus trapping, outside-`aria-hidden` and click-blocking
 *     from Radix instead;
 *  3. the list is still TOLD which row is open (`selectedItemId`), so the row
 *     stays highlighted BEHIND the backdrop and after the modal closes;
 *  4. prev/next step through the rows the list reported, in that order, and are
 *     disabled at the ends rather than absent;
 *  5. a panel opened by a SAVE — which clears the open entry, because the
 *     candidate it named is now a CRM record — still marks the row it came
 *     from, and a subsequent click REPLACES that panel rather than only moving
 *     the highlight;
 *  6. Escape closes it, because Radix owns the key — and Escape while a NESTED
 *     dialog is up (the dismiss picker) closes only that one. There is
 *     deliberately no document-level keydown listener any more; two handlers
 *     would both fire on the same key;
 *  7. exactly ONE close control. The breadcrumb's back crumb is a crumb; the
 *     dialog's X is the close.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { VisibleItem } from '@/components/views/detail-nav-utils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

/**
 * The layout stub RECORDS the props the page hands it, which is the seam this
 * suite is about: `selectedItemId` is what survives the modal, and
 * `onVisibleItemsChange` is where the neighbours for prev/next come from.
 */
const { layoutProps, openRowFn, reportVisible } = vi.hoisted(() => ({
  layoutProps: { current: null as null | { selectedItemId?: string | null } },
  openRowFn: { current: null as null | ((item: unknown) => void) },
  reportVisible: { current: null as null | ((items: unknown[]) => void) },
}))
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: {
    selectedItemId?: string | null
    onItemSelect?: (id: string, title: string, e: undefined, item: unknown) => void
    onVisibleItemsChange?: (items: unknown[]) => void
  }) => {
    layoutProps.current = props
    openRowFn.current = (item) => {
      const row = item as { id: string }
      props.onItemSelect?.(row.id, 'row', undefined, item)
    }
    reportVisible.current = (items) => props.onVisibleItemsChange?.(items)
    return <div data-testid="entries-list">ENTRIES_LIST</div>
  },
}))

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

/** Three rows, in the order the list shows them. */
const ROWS = [
  entry({ id: 'entry-1', candidate: { name: 'Acme', domain: 'acme.com' } }),
  entry({ id: 'entry-2', candidate: { name: 'Globex', domain: 'globex.com' } }),
  entry({ id: 'entry-3', candidate: { name: 'Initech', domain: 'initech.com' } }),
]

function visibleItems(): VisibleItem[] {
  return ROWS.map((row) => ({
    id: row.id,
    title: (row.candidate as { name: string }).name,
    item: row as unknown as Record<string, unknown>,
  }))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  saveEntries.mockReset()
  layoutProps.current = null
  openRowFn.current = null
  reportVisible.current = null
  fetchList.mockReset().mockResolvedValue({
    list: LIST,
    entries: ROWS,
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

async function render() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={() => {}} />)
  })
  await act(async () => {})
}

/** The list reports its visible rows the way the real layout does — after the
 *  first render and on every change. */
async function reportRows() {
  await act(async () => {
    reportVisible.current!(visibleItems())
  })
}

async function openRow(index: number) {
  await act(async () => {
    openRowFn.current!(ROWS[index])
  })
}

/**
 * The modal. Read off `document.body`, not `container`: the whole point of a
 * Radix dialog here is that it PORTALS out of the page's own subtree, which is
 * how it escapes the content column's width and the chat strip's z-index.
 */
function detailPane(): HTMLElement | null {
  return document.body.querySelector('[data-testid="prospect-detail-pane"]')
}

function entriesList(): HTMLElement | null {
  return container.querySelector('[data-testid="entries-list"]')
}

/**
 * Whether anything between the entries list and the page root is hiding it.
 *
 * The sheet used to set `invisible` + `inert` + `aria-hidden` on a wrapper
 * around the whole page. The modal must set NONE of it — the list is meant to
 * be seen behind the backdrop. Walked as a chain rather than checked on one
 * known node so the assertion is "nothing in the page hides it", which holds
 * however the page's wrappers are reshuffled.
 *
 * Radix marks the *body's other children* `aria-hidden` while a modal is open,
 * which is a different mechanism at a different level and is exactly what
 * should happen — so this walk stops at `container`.
 */
function pageHiding(): { invisible: boolean; inert: boolean; displayNone: boolean } {
  const out = { invisible: false, inert: false, displayNone: false }
  const list = entriesList()
  expect(list, 'the entries list must stay MOUNTED').toBeTruthy()
  let el: HTMLElement | null = list
  while (el && el !== container) {
    const classes = el.className.split(/\s+/)
    if (classes.includes('invisible')) out.invisible = true
    if (classes.includes('hidden')) out.displayNone = true
    if (el.hasAttribute('inert')) out.inert = true
    el = el.parentElement
  }
  return out
}

/**
 * The breadcrumb's prev/next.
 *
 * Scoped to the modal's HEADER, not the whole modal: the panel below has its
 * own Save/Dismiss footer, and taking "the last two buttons" would pick those
 * up instead. Within the header the arrows are always the trailing pair — the
 * crumb's back button is the only thing before them. The header is the first
 * element that is not the sr-only title.
 */
function navButtons(): { prev: HTMLButtonElement; next: HTMLButtonElement } {
  const header = detailPane()!.querySelector('.h-12') as HTMLElement
  expect(header, 'the modal must render the breadcrumb header').toBeTruthy()
  const headerButtons = Array.from(header.querySelectorAll('button'))
  const [prev, next] = headerButtons.slice(-2) as HTMLButtonElement[]
  expect(prev, 'the breadcrumb header must render both arrows').toBeTruthy()
  expect(next).toBeTruthy()
  return { prev, next }
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

async function pressEscape(target: EventTarget = document) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  await act(async () => {})
}

describe('ListDetail — the detail is a modal over the list', () => {
  it('opens as a portaled dialog naming the list and the candidate', async () => {
    await render()
    await reportRows()
    expect(detailPane(), 'nothing is open yet').toBeNull()

    await openRow(1)

    const pane = detailPane()
    expect(pane, 'the modal is open').toBeTruthy()
    // PORTALED: the modal is not inside the page's own container. That is what
    // lets it be wider than the content column and paint over the chat strip.
    expect(container.contains(pane!), 'the modal must portal out of the page').toBe(false)

    // The crumb reads "<list name> › <candidate>".
    expect(pane!.textContent).toContain('Customers like us')
    expect(pane!.textContent).toContain('Globex')
  })

  it('leaves the list visible and reachable-by-nothing behind the backdrop', async () => {
    // THE INVERSION FROM THE SHEET. The sheet painted over the page, so the
    // page had to be hidden AND inerted by hand or its "Find companies ·
    // ≈$0.24" and manual-pick buttons stayed tabbable under an opaque cover.
    // The modal wants the opposite: the list is SEEN — that is what makes this
    // a pop-up — and Radix, not this page, is what keeps it unreachable.
    await render()
    await reportRows()

    expect(pageHiding()).toEqual({ invisible: false, inert: false, displayNone: false })

    await openRow(1)
    expect(detailPane()).toBeTruthy()
    expect(entriesList(), 'the list stays mounted').toBeTruthy()
    expect(
      pageHiding(),
      'the list must stay VISIBLE behind the backdrop — hiding it would make this a page, not a pop-up',
    ).toEqual({ invisible: false, inert: false, displayNone: false })
  })

  it('carries exactly one close control', async () => {
    await render()
    await reportRows()
    await openRow(1)

    // The dialog primitive draws the X (labelled by an sr-only "Close"). The
    // breadcrumb's back crumb is a CRUMB, not a close button, and the panels
    // below must not add one of their own — two Xs on one surface is the bug
    // the shared header exists to prevent.
    const closes = Array.from(detailPane()!.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').trim() === 'Close',
    )
    expect(closes, 'exactly one close control').toHaveLength(1)
    expect(
      document.body.querySelectorAll('[aria-label="Close"]'),
      'and no second one under a different label',
    ).toHaveLength(0)

    await click(closes[0])
    expect(detailPane()).toBeNull()
  })

  it('keeps the nav arrows out from under the dialog Close', async () => {
    await render()
    await reportRows()
    await openRow(1)

    // The one close control is absolutely positioned in the top-right corner by
    // the dialog primitive, and the breadcrumb header puts its prev/next arrows
    // in exactly that corner. Overlapping them makes a band of "next prospect"
    // close the pop-up instead of stepping, and the absolutely-positioned X
    // wins that hit test because it is the later sibling. The header therefore
    // reserves the corner with right padding. jsdom has no layout, so the
    // reserved padding IS the assertion.
    const header = detailPane()!.querySelector('[data-testid="prospect-detail-header"]')
    expect(header, 'the breadcrumb header is wrapped so it can reserve the corner').toBeTruthy()
    expect(
      header!.className,
      'the header must reserve room for the dialog Close, or the Next arrow sits under it',
    ).toContain('pr-8')

    // And the arrows still work through the wrapper.
    expect(detailPane()!.textContent).toContain('Globex')
    await click(navButtons().next)
    expect(detailPane()!.textContent).toContain('Initech')
  })

  it('tells the list which row the modal belongs to, behind the backdrop and after', async () => {
    await render()
    await reportRows()
    expect(layoutProps.current?.selectedItemId ?? null).toBeNull()

    await openRow(1)
    // The highlight is visible THROUGH the backdrop — and it is what makes
    // closing the modal land the user back on the row they were reading.
    expect(layoutProps.current?.selectedItemId).toBe('entry-2')

    await pressEscape()
    // Closing clears it — a selected row with no modal would claim something is
    // open that is not.
    expect(detailPane()).toBeNull()
    expect(layoutProps.current?.selectedItemId ?? null).toBeNull()
  })

  it('steps prev/next through the rows the list reported', async () => {
    await render()
    await reportRows()
    await openRow(1)
    expect(detailPane()!.textContent).toContain('Globex')

    await click(navButtons().next)
    expect(layoutProps.current?.selectedItemId).toBe('entry-3')
    expect(detailPane()!.textContent).toContain('Initech')

    await click(navButtons().prev)
    expect(layoutProps.current?.selectedItemId).toBe('entry-2')

    await click(navButtons().prev)
    expect(layoutProps.current?.selectedItemId).toBe('entry-1')
    expect(detailPane()!.textContent).toContain('Acme')

    // And the list was mounted, and visible, underneath for every step of it.
    expect(entriesList()).toBeTruthy()
    expect(pageHiding().invisible).toBe(false)
  })

  it('disables the arrows at the ends rather than removing them', async () => {
    await render()
    await reportRows()

    // First row: nothing before it.
    await openRow(0)
    expect(navButtons().prev.disabled, 'no previous row').toBe(true)
    expect(navButtons().next.disabled).toBe(false)

    // Last row: nothing after it. The buttons must still BE there — the header
    // reflowing as the user steps is what the disabled state exists to avoid.
    await openRow(2)
    expect(navButtons().prev.disabled).toBe(false)
    expect(navButtons().next.disabled, 'no next row').toBe(true)
  })

  it('offers no stepping when the list has reported no rows', async () => {
    // The modal can open before the layout has reported anything (a ledger
    // link, a row opened straight after a remount). Both arrows are then dead
    // rather than stepping into a stale order.
    await render()
    await openRow(1)
    expect(navButtons().prev.disabled).toBe(true)
    expect(navButtons().next.disabled).toBe(true)
  })

  it('Save keeps the row on the list and closes the panel — the CRM has nothing to show yet', async () => {
    // Save is curation (migration 259): no CRM record exists after it, so
    // there is no panel to open. The entry panel closes and the list is what
    // the user sees again.
    saveEntries.mockResolvedValue({
      saved: [{ entry_id: 'entry-2', list_id: 'list-1', kind: 'company' }],
      skipped: [],
    })
    await render()
    await reportRows()
    await openRow(1)

    const save = Array.from(detailPane()!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Save to list',
    )!
    await click(save)

    expect(document.body.textContent).not.toContain('COMPANY_PANEL')
    expect(detailPane()).toBeNull()
    expect(entriesList()).toBeTruthy()
  })

  it('closes on Escape', async () => {
    await render()
    await reportRows()
    await openRow(1)
    expect(detailPane()).toBeTruthy()

    await pressEscape()
    expect(detailPane()).toBeNull()
    expect(entriesList()).toBeTruthy()
    expect(pageHiding()).toEqual({ invisible: false, inert: false, displayNone: false })
  })

  it('Escape with the dismiss dialog open closes only the dismiss dialog', async () => {
    // NESTED DIALOGS. The dismiss picker opens from INSIDE the detail, and it
    // owns Escape while it is up: closing the detail underneath it would leave
    // the user staring at a reason picker over the bare list, having lost the
    // candidate they were about to reject.
    //
    // Under the sheet this was a hand-written guard on a document listener.
    // Under the modal it is Radix's own stack PLUS `onEscapeKeyDown`'s refusal,
    // and the document listener is gone — with both, one Escape would have
    // closed two things.
    await render()
    await reportRows()
    await openRow(1)

    const dismiss = Array.from(detailPane()!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Dismiss',
    )!
    expect(dismiss, 'the entry panel offers Dismiss').toBeTruthy()
    await click(dismiss)

    // The picker is up, over the detail.
    expect(document.body.textContent).toContain('Not a fit')

    await pressEscape()
    expect(document.body.textContent, 'the picker closed').not.toContain('Not a fit')
    expect(detailPane(), 'and the detail underneath it did NOT').toBeTruthy()

    // A second Escape, with nothing nested, closes the detail.
    await pressEscape()
    expect(detailPane()).toBeNull()
  })
})
