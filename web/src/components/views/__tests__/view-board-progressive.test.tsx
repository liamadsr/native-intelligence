// @vitest-environment jsdom
/**
 * Rendering tests for ViewBoard's progressive per-column card rendering + the
 * multi-select drag payload — the perf treatment mirroring view-list's grouped
 * path (see view-list-grouped.test.tsx).
 *
 * What these lock in (the behavior the windowing/memo change must not break):
 *   1. Every card in a column renders when the column fits the initial window.
 *   2. A column LARGER than the initial window (COLUMN_INITIAL_CARDS = 60)
 *      mounts only the first window synchronously, with a tail sentinel present
 *      — the progressive-rendering fix that stops 500-card columns from mounting
 *      hundreds of DOM nodes on first paint.
 *   3. The drag `item()` factory resolves the multi-item payload from the live
 *      `checkedIds` for a mounted card: dragging a checked card carries ALL
 *      checked ids; dragging an unchecked card carries only its own id.
 *
 * react-dnd is stubbed minimally: `useDrag`/`useDrop` return `[collected, ref]`
 * without a real backend, and `DndProvider` is a passthrough. We capture each
 * card's `useDrag` spec so we can invoke its `item()` factory directly and
 * assert the multi-select payload — exercising the real ref-based factory in
 * BoardCard rather than a stub. The HTML5Backend import is stubbed to a noop
 * because the passthrough DndProvider never uses it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── react-dnd stub ────────────────────────────────────────
// Capture every useDrag spec keyed by the dragged card's id so a test can
// invoke the real `item()` factory. useDrag/useDrop return the same shape the
// component destructures ([collected, refCallback]); the ref is a noop.
const dragSpecsById = new Map<string, { item: () => { id: string; groupKey: string; ids: string[] } }>()
const noopRef = () => {}

vi.mock('react-dnd', () => ({
  DndProvider: ({ children }: { children: ReactNode }) => children,
  useDrag: (spec: unknown) => {
    // Board cards pass an object spec with an `item` factory; the column-reorder
    // drag passes a static `item`. Only record the card factories (functions).
    const s = typeof spec === 'function' ? (spec as () => Record<string, unknown>)() : (spec as Record<string, unknown>)
    if (typeof s.item === 'function' && s.type === 'BOARD_CARD') {
      // Resolve the card id by peeking at the factory once (cheap, pure).
      const factory = s.item as () => { id: string; groupKey: string; ids: string[] }
      try {
        const probed = factory()
        dragSpecsById.set(probed.id, { item: factory })
      } catch {
        /* ignore — factory reads refs that may be unset before mount */
      }
    }
    return [{ isDragging: false, isColumnDragging: false }, noopRef, noopRef]
  },
  useDrop: () => [{ isOver: false, canDrop: false, isColumnOver: false }, noopRef],
}))

vi.mock('react-dnd-html5-backend', () => ({ HTML5Backend: {} }))

// The shell's shared agent work (one tracked_job channel): null unless a test sets rows.
const agentWork = vi.hoisted(() => ({ rows: null as Array<Record<string, unknown>> | null }))
vi.mock('@/components/work/agent-work-provider', () => ({
  useOptionalAgentWork: () => (agentWork.rows ? { work: { rows: agentWork.rows }, counts: new Map() } : null),
}))

// IntersectionObserver isn't implemented in jsdom. Inert stub so the sentinel
// effect can construct/observe/disconnect without revealing more cards (we
// assert the INITIAL window, before any intersection fires). We record the
// `root` option of every construction so a test can assert the sentinel is
// wired to observe against the COLUMN's card-area scroll container (not the
// horizontally-scrolling viewport / null) — broken root wiring would otherwise
// go uncaught because the stub does nothing.
const ioConstructions: { root: Element | Document | null | undefined }[] = []
class IOStub {
  constructor(_cb: unknown, opts?: { root?: Element | Document | null }) {
    ioConstructions.push({ root: opts?.root })
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IOStub

import { ViewBoard } from '../view-board'
import type { ViewConfig } from '../hooks/use-view'
import type { GroupedResults } from '@/lib/views/types'

function baseConfig(): ViewConfig {
  return {
    filters: [],
    grouping: { field: 'status_id', direction: 'asc' },
    sub_grouping: null,
    ordering: [],
    display_properties: [],
    layout: 'board',
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  dragSpecsById.clear()
  ioConstructions.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  agentWork.rows = null
})

function renderBoard(
  data: GroupedResults[],
  extra?: Partial<{ checkedIds: Set<string>; selectionActive: boolean }>,
) {
  act(() => {
    root.render(
      h(ViewBoard, {
        entityType: 'action',
        data,
        loading: false,
        config: baseConfig(),
        selectedItemId: null,
        onItemSelect: () => {},
        onMoveItem: () => {},
        checkedIds: extra?.checkedIds,
        selectionActive: extra?.selectionActive,
        onToggleCheck: () => {},
      }),
    )
  })
}

/** Count mounted cards by their line-clamped title nodes' data via the DOM. */
function mountedCardIds(): string[] {
  // Each card renders its title; we count via the identifier-free title node.
  // Simpler: query the draggable card wrappers by their unique title text isn't
  // stable, so we rely on the drag-spec registry which records one entry per
  // mounted card (its item() factory was probed at mount).
  //
  // NB: this reflects every card WHOSE useDrag RAN — accurate on a single
  // render, but across a re-render (same root) memoized cards that don't
  // re-render won't re-probe, so the registry is a stale union. Tests that
  // re-render (tail-append / refetch) must count via the DOM instead —
  // `mountedCardCount()` / `cardTitles()` below.
  return Array.from(dragSpecsById.keys())
}

/** Number of BoardCards actually in the DOM (one `.line-clamp-2` title per card). */
function mountedCardCount(): number {
  return container.querySelectorAll('.line-clamp-2').length
}

/** The set of card title texts currently mounted in the DOM. */
function cardTitles(): Set<string> {
  return new Set(
    Array.from(container.querySelectorAll('.line-clamp-2')).map(n => (n.textContent || '').trim()),
  )
}

describe('ViewBoard progressive card rendering', () => {
  it('renders every column header and all cards when columns fit the initial window', () => {
    const data = [
      makeGroup('todo', 'Todo', 10, 0),
      makeGroup('doing', 'In Progress', 8, 100),
      makeGroup('done', 'Done', 5, 200),
    ]
    renderBoard(data)

    const text = container.textContent || ''
    expect(text).toContain('Todo')
    expect(text).toContain('In Progress')
    expect(text).toContain('Done')

    // All 23 cards mount (each column is under COLUMN_INITIAL_CARDS = 60).
    expect(mountedCardIds()).toHaveLength(23)
    expect(container.querySelector('[data-card-sentinel]')).toBeNull() // no tail sentinel
  })

  it('windows a large column: only the initial slice mounts, with a tail sentinel', () => {
    // One column of 150 cards — exceeds COLUMN_INITIAL_CARDS (60).
    const data = [makeGroup('todo', 'Todo', 150, 0)]
    renderBoard(data)

    expect((container.textContent || '')).toContain('Todo')

    const ids = mountedCardIds()
    expect(ids.length).toBe(60)
    expect(ids.length).toBeLessThan(150)

    // First and 60th cards mounted; the 61st is deferred behind the sentinel.
    expect(ids).toContain('todo-0')
    expect(ids).toContain('todo-59')
    expect(ids).not.toContain('todo-60')

    // A tail sentinel div is present for the IntersectionObserver to watch.
    expect(container.querySelector('[data-card-sentinel]')).not.toBeNull()

    // The observer must be rooted on the COLUMN's card-area scroll container —
    // the same div that carries the react-dnd drop ref — NOT null/the viewport
    // (which scrolls horizontally). The card area is the vertical scroll root
    // (overflow-y-auto). Broken root wiring would silently break progressive
    // reveal; the inert stub can't catch it, so we assert the construction arg.
    const cardArea = container.querySelector('.overflow-y-auto') as HTMLDivElement
    expect(cardArea).not.toBeNull()
    const rootedIO = ioConstructions.find(c => c.root === cardArea)
    expect(rootedIO).toBeTruthy()
    // And nothing wired an observer against null/undefined (the viewport).
    expect(ioConstructions.every(c => c.root != null)).toBe(true)
  })

  it('mounts an optimistically appended card in an oversized column (drag-drop tail append)', () => {
    // A column larger than the window: 100 cards, 60 mounted. (These re-render
    // tests count via the DOM — the drag-spec registry is a stale union across
    // re-renders because memoized cards that don't re-render don't re-probe.)
    const initial = [makeGroup('todo', 'Todo', 100, 0)]
    renderBoard(initial)
    expect(mountedCardCount()).toBe(60)
    expect(cardTitles().has('Todo item 100')).toBe(false) // todo-99 not mounted

    // Simulate moveItemBetweenGroups appending ONE moved card to the END of the
    // target group (the existing 100 cards are an unchanged prefix). A fresh
    // group object + fresh items array mirrors the real optimistic setData.
    const appended: GroupedResults[] = [
      {
        key: 'todo',
        label: 'Todo',
        items: [
          ...initial[0].items,
          { id: 'moved-1', title: 'Dropped card' },
        ],
      },
    ]
    renderBoard(appended)

    // Case A fires: visibleCount jumps to items.length, so the appended card is
    // mounted immediately (matches the old pre-windowing tail behavior).
    expect(cardTitles().has('Dropped card')).toBe(true)
    expect(mountedCardCount()).toBe(101)
  })

  it('mounts multiple optimistically appended cards (multi-card drop)', () => {
    const initial = [makeGroup('todo', 'Todo', 100, 0)]
    renderBoard(initial)
    expect(mountedCardCount()).toBe(60)

    // Multi-select drop: several cards appended at once. The same prefix check
    // covers this — the previous last id (todo-99) is still parked at index 99.
    const appended: GroupedResults[] = [
      {
        key: 'todo',
        label: 'Todo',
        items: [
          ...initial[0].items,
          { id: 'moved-1', title: 'Dropped A' },
          { id: 'moved-2', title: 'Dropped B' },
          { id: 'moved-3', title: 'Dropped C' },
        ],
      },
    ]
    renderBoard(appended)

    const titles = cardTitles()
    expect(titles.has('Dropped A')).toBe(true)
    expect(titles.has('Dropped B')).toBe(true)
    expect(titles.has('Dropped C')).toBe(true)
    expect(mountedCardCount()).toBe(103)
  })

  it('preserves windowing on a wholesale refetch that changes the prefix (NOT a tail append)', () => {
    const initial = [makeGroup('todo', 'Todo', 100, 0)]
    renderBoard(initial)
    expect(mountedCardCount()).toBe(60)

    // A refetch replaces the array in server sort order: 20 NEW cards inserted
    // at the FRONT (prefix changed → previous last id no longer at its old
    // index). This must NOT trigger a full mount — only the growth-delta
    // widening (60 + 20 = 80), and the new tail stays windowed.
    const front = Array.from({ length: 20 }, (_, i) => ({ id: `front-${i}`, title: `Front ${i}` }))
    const refetched: GroupedResults[] = [
      {
        key: 'todo',
        label: 'Todo',
        items: [...front, ...initial[0].items], // 120 total
      },
    ]
    renderBoard(refetched)

    // Growth-delta widening: prev 60 + growth 20 = 80 mounted, NOT all 120.
    expect(mountedCardCount()).toBe(80)
    expect(mountedCardCount()).toBeLessThan(120)
    // The original tail (todo-99, "Todo item 100", now at index 119) stays
    // behind the sentinel — a full mount did NOT happen.
    expect(cardTitles().has('Todo item 100')).toBe(false)
    // Tail sentinel still present — the column is still windowed.
    expect(container.querySelector('[data-card-sentinel]')).not.toBeNull()
  })

  it('drag item() factory carries all checked ids for a checked card, only its own for an unchecked one', () => {
    const data = [makeGroup('todo', 'Todo', 5, 0)]
    // Two of the five cards are checked (multi-select).
    const checkedIds = new Set(['todo-1', 'todo-3'])
    renderBoard(data, { checkedIds, selectionActive: true })

    // Checked card → payload carries the full selection set.
    const checkedSpec = dragSpecsById.get('todo-1')
    expect(checkedSpec).toBeTruthy()
    const checkedPayload = checkedSpec!.item()
    expect(checkedPayload.id).toBe('todo-1')
    expect(checkedPayload.groupKey).toBe('todo')
    expect(new Set(checkedPayload.ids)).toEqual(new Set(['todo-1', 'todo-3']))

    // Unchecked card → payload carries only its own id.
    const uncheckedSpec = dragSpecsById.get('todo-0')
    expect(uncheckedSpec).toBeTruthy()
    const uncheckedPayload = uncheckedSpec!.item()
    expect(uncheckedPayload.id).toBe('todo-0')
    expect(uncheckedPayload.ids).toEqual(['todo-0'])
  })
})

describe('ViewBoard cards: the delegate’s run, as a list row shows it', () => {
  const card = (over: Record<string, unknown>) => ({ id: 'act-1', title: 'Fix the export', ...over })

  it('a card an agent is working shows its status; the person’s own coding agent is named', () => {
    agentWork.rows = [{ status: 'running', source: { local_agent_action_id: 'act-1', worker: 'claude-code' } }]
    renderBoard([
      {
        key: 'doing',
        label: 'In Progress',
        items: [
          card({ assignee_ai_member_id: 'ai-1', agent_run_status: 'working' }),
          card({ id: 'act-2', title: 'Tidy the README', assignee_ai_member_id: 'ai-1', agent_run_status: 'working' }),
          card({ id: 'act-3', title: 'Nobody on it' }),
        ],
      },
    ])
    const badges = [...container.querySelectorAll('[data-delegate-work]')].map((el) => el.textContent)
    expect(badges).toEqual(['Claude Code · working', 'working'])
  })

  it('nothing running: no badge, and the card is as it was', () => {
    renderBoard([{ key: 'todo', label: 'Todo', items: [card({ assignee_ai_member_id: 'ai-1', agent_run_status: 'idle' })] }])
    expect(container.querySelector('[data-delegate-work]')).toBeNull()
  })
})
