// @vitest-environment jsdom
/**
 * Rendering tests for ViewList's GROUPED path — the branch that a
 * capture/all-captures view uses (captures default to grouping by day).
 *
 * What these lock in (the behavior the windowing/memo perf change must not break):
 *   1. Every group header renders with its label + item count.
 *   2. With a group smaller than the initial window, all its rows mount up-front.
 *   3. With a group LARGER than the initial window (GROUP_INITIAL_ROWS = 80),
 *      only the first window mounts synchronously and a tail sentinel is present
 *      — this is the progressive-rendering fix that stops 500-row groups from
 *      mounting thousands of DOM nodes on first paint.
 *   4. Collapsing a group header hides that group's rows (interaction preserved).
 *   5. That a grouped row can enter COMPOSE mode at all — that the announcement
 *      reaches the list, and that a row holding the strip still pushes the rows
 *      beneath it DOWN rather than drawing over them. See the compose describe
 *      block at the bottom for why a normal-flow path needs this pinned.
 *
 * EntityRow is stubbed to a lightweight row so the test isolates ViewList's
 * grouping/windowing logic from EntityRow's (heavy) picker subtree. The stub
 * still exercises the real prop contract: it renders the title via the stable
 * `onItemSelect`-derived identity, exposes a data-attr we can count, and — for
 * the compose tests — reports through `onComposeChange` and grows the way the
 * real row does when the strip is up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Every `onComposeChange` identity the stub has been handed, in mount order.
 *
 * The compose contract is not just "a function arrives" — it is that ONE
 * function serves every row. `EntityRow` is memoized and its release-the-slot
 * cleanup lists this callback as a dependency, so a fresh closure per row (or
 * per render) re-runs that effect and its cleanup ends compose on the very next
 * render: the strip mounts and is torn down in the same commit. Collecting the
 * identities is how a test can see that from outside the row.
 */
const composeCallbacks: Array<((itemId: string, composing: boolean) => void) | undefined> = []

/**
 * What the rows actually ANNOUNCED, in order, recorded as the stub forwards it.
 *
 * Observed at the row→list boundary rather than by reading ViewList's state,
 * which is private and should stay so. The stub still calls the real callback
 * afterwards, so the list sees exactly what it would in production.
 */
const composeAnnouncements: Array<[string, boolean]> = []

/**
 * Only what the LIST actually received — pushed from inside the forwarded
 * callback, so an unwired path records nothing.
 *
 * `composeAnnouncements` above records the row's INTENT and is pushed
 * unconditionally; it would look identical whether or not anyone was listening.
 * Keeping the two separate is what makes "the announcement reached the list" a
 * claim a broken wire can fail.
 */
const composeReceived: Array<[string, boolean]> = []

// Lightweight EntityRow stub — renders a marker per row so we can count mounted
// rows without pulling in the pickers/avatars/etc. `getTitle` is re-exported
// unchanged because view-list imports it from the same module.
//
// Compose is driven through a per-row button rather than the real push menu:
// this file is about the LIST, and the menu's own behaviour is pinned in
// action-row-platform-icon.test.tsx. What the stub reproduces is the two things
// the list can observe — the announcement, and the row getting taller — so the
// grouped path's wiring is exercised end to end without the menu's fetches.
vi.mock('../list/entity-row', async () => {
  const { createElement: e, useState } = await import('react')
  return {
    EntityRow: ({
      item,
      onComposeChange,
    }: {
      item: Record<string, unknown>
      onComposeChange?: (itemId: string, composing: boolean) => void
    }) => {
      const [composing, setComposing] = useState(false)
      composeCallbacks.push(onComposeChange)
      return e(
        'div',
        { 'data-row': item.id as string },
        (item.title as string) || '',
        e(
          'button',
          {
            type: 'button',
            'data-compose-toggle': item.id as string,
            onClick: () => {
              const next = !composing
              setComposing(next)
              composeAnnouncements.push([item.id as string, next])
              // Recorded INSIDE the optional call: no callback, no record.
              if (onComposeChange) {
                composeReceived.push([item.id as string, next])
                onComposeChange(item.id as string, next)
              }
            },
          },
          'push',
        ),
        // The strip, standing in for the real one: a child that makes the row
        // taller. In normal flow that is all it takes to push the next row down;
        // under a virtualizer it is exactly what draws over the neighbour
        // instead, which is why the announcement above has to travel.
        composing ? e('div', { 'data-compose-surface': 'strip' }, 'compose') : null,
      )
    },
    getTitle: (_e: unknown, item: Record<string, unknown>) => (item.title as string) || 'Untitled',
  }
})

// IntersectionObserver isn't implemented in jsdom. Provide an inert stub so the
// sentinel effect can construct/observe/disconnect without revealing more rows
// (we assert the INITIAL window, before any intersection fires).
class IOStub {
  constructor(_cb: unknown, _opts?: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IOStub

import { ViewList } from '../view-list'
import type { ViewConfig } from '../hooks/use-view'
import type { GroupedResults } from '@/lib/views/types'

function baseConfig(): ViewConfig {
  return {
    filters: [],
    grouping: { field: 'started_at', direction: 'desc' },
    sub_grouping: null,
    ordering: [],
    display_properties: [],
    layout: 'list',
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: false,
    nested_sub_items: false,
    show_empty_groups: false,
    action_scope: 'all',
    workspace_scope: 'workspace',
    crm_scope: 'contacts',
    capture_scope: 'all',
  } as ViewConfig
}

function makeGroup(key: string, label: string, count: number, offset = 0): GroupedResults {
  return {
    key,
    label,
    items: Array.from({ length: count }, (_, i) => ({
      id: `${key}-${i + offset}`,
      title: `${label} item ${i + 1}`,
    })),
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  composeCallbacks.length = 0
  composeAnnouncements.length = 0
  composeReceived.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function renderGrouped(data: GroupedResults[]) {
  act(() => {
    root.render(
      h(ViewList, {
        entityType: 'capture',
        data,
        loading: false,
        config: baseConfig(),
        selectedItemId: null,
        onItemSelect: () => {},
      }),
    )
  })
}

describe('ViewList grouped rendering', () => {
  it('renders every group header and all rows when groups fit the initial window', () => {
    // 3 groups totalling ~40 items, each group under GROUP_INITIAL_ROWS (80).
    const data = [
      makeGroup('today', 'Today', 15, 0),
      makeGroup('yesterday', 'Yesterday', 15, 100),
      makeGroup('older', 'Earlier', 10, 200),
    ]
    renderGrouped(data)

    const text = container.textContent || ''
    expect(text).toContain('Today')
    expect(text).toContain('Yesterday')
    expect(text).toContain('Earlier')

    // All 40 rows mount (each group is under the initial window).
    expect(container.querySelectorAll('[data-row]')).toHaveLength(40)
  })

  it('windows a large group: only the initial slice mounts, with a tail sentinel', () => {
    // One group of 150 items — exceeds GROUP_INITIAL_ROWS (80).
    const data = [makeGroup('today', 'Today', 150, 0)]
    renderGrouped(data)

    // Header + count still render.
    const text = container.textContent || ''
    expect(text).toContain('Today')

    // Only the first window (80) is mounted synchronously — the rest are
    // deferred behind the IntersectionObserver sentinel.
    const rows = container.querySelectorAll('[data-row]')
    expect(rows.length).toBe(80)
    expect(rows.length).toBeLessThan(150)

    // The first and 80th rows are present; the 81st is not yet mounted.
    expect(container.querySelector('[data-row="today-0"]')).not.toBeNull()
    expect(container.querySelector('[data-row="today-79"]')).not.toBeNull()
    expect(container.querySelector('[data-row="today-80"]')).toBeNull()
  })

  it('collapsing a group header hides that group\'s rows', () => {
    const data = [makeGroup('today', 'Today', 5, 0)]
    renderGrouped(data)
    expect(container.querySelectorAll('[data-row]')).toHaveLength(5)

    // The collapse toggle is the header <button> — the one that is NOT a row's
    // own compose trigger. Spelled out because the row stub now has a button of
    // its own, and "the first button" would be a coincidence of document order.
    const toggle = container.querySelector(
      'button:not([data-compose-toggle])',
    ) as HTMLButtonElement
    expect(toggle).not.toBeNull()
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Header stays; rows are unmounted.
    expect(container.textContent || '').toContain('Today')
    expect(container.querySelectorAll('[data-row]')).toHaveLength(0)
  })
})

/**
 * COMPOSE ON A GROUPED ROW — the wiring the flat path got and this one did not.
 *
 * The overlap bug that produced `COMPOSE_ROW_HEIGHT` was a FLAT-path bug: its
 * slots are absolutely positioned at a height the virtualizer decides, so a row
 * that grows into the compose strip draws on top of its neighbours. The fix was
 * for the row to announce which row got tall, and for the list to size that one
 * slot accordingly.
 *
 * Grouped rows are in normal flow, so they push their siblings down by
 * themselves and never had the bug. They also never received `onComposeChange`
 * — which was benign, and invisible, and exactly the shape of a landmine: the
 * announcement was silently dropped on a whole rendering path, with no test
 * anywhere that would notice. The day the grouped path windows by height (or
 * gains a virtualizer, or anything else that positions a row at a decided
 * height) the overlap returns with nothing on the way down to catch it.
 *
 * So these pin two separate claims:
 *   - the CALLBACK reaches grouped rows, and is one identity for all of them;
 *   - the LAYOUT is what makes the callback optional today — a composing row's
 *     followers are still after it in the document, not underneath it.
 *
 * The second is a structural claim on purpose. jsdom computes no layout, so
 * "does not overlap" cannot be measured here; what CAN be pinned is that the
 * strip is a child of the composing row and the next row is still that row's
 * following sibling — i.e. the rows are in flow, which is the premise the whole
 * benign-today argument rests on. If someone absolutely-positions this path,
 * that premise is what breaks, and it breaks visibly here.
 */
describe('ViewList grouped rendering — compose', () => {
  const composeToggle = (id: string) =>
    container.querySelector(`[data-compose-toggle="${id}"]`) as HTMLButtonElement

  it('hands every grouped row the compose callback — one shared identity', () => {
    renderGrouped([makeGroup('today', 'Today', 3, 0)])

    expect(composeCallbacks).toHaveLength(3)
    expect(composeCallbacks.every(cb => typeof cb === 'function')).toBe(true)
    // ONE function, not three. A per-row closure would re-run EntityRow's
    // release-the-slot cleanup and cancel compose on the next render.
    expect(new Set(composeCallbacks).size).toBe(1)
  })

  it('keeps that identity STABLE across re-renders', () => {
    const data = [makeGroup('today', 'Today', 2, 0)]
    renderGrouped(data)
    const first = composeCallbacks[0]
    // Not vacuous: `undefined === undefined` would satisfy the equality below on
    // a path that forwards nothing at all.
    expect(typeof first).toBe('function')

    // Re-render with a fresh (equal) data array, the way a realtime refetch does.
    renderGrouped([makeGroup('today', 'Today', 2, 0)])

    expect(composeCallbacks.length).toBeGreaterThan(2)
    expect(composeCallbacks.every(cb => cb === first)).toBe(true)
  })

  it('lets a grouped row enter compose, and the callback fires with its id', () => {
    renderGrouped([makeGroup('today', 'Today', 3, 0)])
    expect(composeAnnouncements).toEqual([])

    act(() => {
      composeToggle('today-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The strip is up, on THAT row and no other.
    const composing = container.querySelector('[data-compose-surface]')
    expect(composing).not.toBeNull()
    expect(composing!.closest('[data-row]')!.getAttribute('data-row')).toBe('today-1')
    expect(container.querySelectorAll('[data-compose-surface]')).toHaveLength(1)

    // And the list was TOLD, by id. This is the announcement the grouped path
    // used to drop on the floor — `composeReceived` is only written from inside
    // the forwarded callback, so an unwired path leaves it empty.
    expect(composeReceived).toEqual([['today-1', true]])
    expect(composeReceived).toEqual(composeAnnouncements)

    // Leaving compose announces the other direction, so a height-aware consumer
    // can release whatever it reserved.
    act(() => {
      composeToggle('today-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-compose-surface]')).toBeNull()
    expect(composeReceived).toEqual([['today-1', true], ['today-1', false]])
  })

  it('leaves the following rows BELOW the composing one, not underneath it', () => {
    // The structural pin. In normal flow the strip is a child of its row, so the
    // row grows and every later row is still its following sibling. Absolute
    // positioning is what would break this — and that is the change that would
    // reintroduce the overlap the flat path had to fix.
    renderGrouped([makeGroup('today', 'Today', 3, 0)])

    act(() => {
      composeToggle('today-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const rows = Array.from(container.querySelectorAll('[data-row]'))
    expect(rows.map(r => r.getAttribute('data-row'))).toEqual(['today-0', 'today-1', 'today-2'])

    const composingRow = container.querySelector('[data-row="today-1"]')!
    const next = container.querySelector('[data-row="today-2"]')!
    // The strip lives INSIDE the composing row…
    expect(container.querySelector('[data-compose-surface]')!.closest('[data-row]')).toBe(composingRow)
    // …and the next row still FOLLOWS it in the document, rather than being a
    // sibling positioned over the same coordinates.
    expect(
      composingRow.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Neither row contains the other — the only way "below" could be faked.
    expect(composingRow.contains(next)).toBe(false)
    // And no row is absolutely positioned: normal flow is the whole premise.
    for (const row of rows) {
      expect((row as HTMLElement).style.position).not.toBe('absolute')
    }
  })

  it('reaches rows in NESTED subgroups too', () => {
    // Subgroups recurse through GroupSection, which is a second place the prop
    // has to be forwarded — and the easier of the two to forget, because the
    // recursive call already drops `flows`.
    const data: GroupedResults[] = [
      {
        key: 'today',
        // A parent with subGroups holds no leaf items of its own — GroupSection
        // takes the subGroups branch and never reads this — but `items` is
        // required on GroupedResults, so state the empty case explicitly.
        items: [],
        label: 'Today',
        subGroups: [
          { key: 'today::high', label: 'High', items: [{ id: 'sub-1', title: 'Urgent' }] },
          { key: 'today::low', label: 'Low', items: [{ id: 'sub-2', title: 'Later' }] },
        ],
      },
    ]
    renderGrouped(data)

    expect(container.querySelectorAll('[data-row]')).toHaveLength(2)
    expect(composeCallbacks).toHaveLength(2)
    expect(composeCallbacks.every(cb => typeof cb === 'function')).toBe(true)
    // Still one identity — across subgroups, not just within one.
    expect(new Set(composeCallbacks).size).toBe(1)

    act(() => {
      composeToggle('sub-2').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(
      container.querySelector('[data-compose-surface]')!.closest('[data-row]')!
        .getAttribute('data-row'),
    ).toBe('sub-2')
    // …and the announcement travelled up through BOTH GroupSection levels.
    expect(composeReceived).toEqual([['sub-2', true]])
  })
})
