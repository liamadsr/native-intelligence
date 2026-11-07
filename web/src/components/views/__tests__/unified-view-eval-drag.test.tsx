// @vitest-environment jsdom
/**
 * The board's drag guards for `eval_suite`.
 *
 * The default group-by is `last_outcome`, and that board is DISPLAY-ONLY. The
 * three summary columns — `last_outcome`, `last_run_mode`, `case_count` — are
 * denormalized values owned by migration 255's triggers on eval_case and
 * eval_run. Dragging a card between them is not a field write in any sense: the
 * suites PATCH route does not accept those keys, so the drop would 400, roll
 * back, and toast something generic; and even if it wrote, the next case or run
 * change would silently revert it. Refusing up front is the honest behaviour,
 * and the message has to name the real path — running the suite.
 *
 * `target_kind` is refused for a different reason. It IS a real column, but
 * UpdateSuiteSchema deliberately omits it: it is what the suite grades, and
 * repointing it would invalidate every run already recorded against it.
 *
 * `suite_kind` is the one column a drag may write — capability ↔ regression is
 * an authoring choice with nothing derived behind it, and the route takes it.
 * It must fall through, or the board reads as "nothing here works".
 *
 * Harness: the same shape as unified-view-prospect-drag.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refetch = vi.fn()
const updateItem = vi.fn()
const removeItem = vi.fn()
const moveItemBetweenGroups = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}))

/** Mutable so each test can point the board at a different group-by. */
const config = {
  filters: [],
  grouping: { field: 'last_outcome', direction: 'asc' },
  layout: 'board',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig & { grouping: { field: string } }

const DATA = [
  { key: 'passed', metadata: {}, items: [{ id: 's1', name: 'Sales Discovery', last_outcome: 'passed' }] },
  { key: 'scored', metadata: {}, items: [] },
  { key: 'failed', metadata: {}, items: [{ id: 's2', name: 'Standup', last_outcome: 'failed' }] },
  { key: 'errored', metadata: {}, items: [] },
]

vi.mock('../hooks/use-view', () => ({
  useView: () => ({
    views: [], activeViewId: 'v1', activeView: null, setActiveViewId: vi.fn(),
    createView: vi.fn(), updateView: vi.fn(), deleteView: vi.fn(), duplicateView: vi.fn(),
  }),
  useViewConfig: () => ({
    config, updateConfig: vi.fn(), resetConfig: vi.fn(), isDirty: false,
    saveOverrides: vi.fn(), discardOverrides: vi.fn(), overrides: {},
  }),
  useViewResults: () => ({
    data: DATA,
    loading: false, loadingMore: false, totalCount: 2, hasMore: false,
    loadMore: vi.fn(), refetch, updateItem, moveItemBetweenGroups, removeItem,
  }),
}))

vi.mock('../hooks/use-picker-context', () => ({
  usePickerContext: () => ({ workflowStatesByTeam: {} }),
}))
vi.mock('../hooks/use-flow-status-ids', () => ({ useFlowStatusIds: () => ({}) }))
vi.mock('../hooks/use-bulk-selection', () => ({
  useBulkSelection: () => ({
    selectedIds: new Set<string>(), count: 0, hasSelection: false,
    clear: vi.fn(), toggle: vi.fn(), selectAll: vi.fn(),
  }),
}))
vi.mock('../bulk-actions/use-bulk-actions', () => ({
  useBulkActions: () => ({ execute: vi.fn() }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws1',
  useCurrentMemberId: () => 'm1',
}))

vi.mock('../view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('../view-list', () => ({ ViewList: () => null }))

let onMoveItem: ((ids: string[], from: string, to: string) => void) | null = null
vi.mock('../view-board', () => ({
  ViewBoard: (props: { onMoveItem?: (ids: string[], from: string, to: string) => void }) => {
    onMoveItem = props.onMoveItem ?? null
    return null
  },
}))

import { UnifiedViewLayout } from '../unified-view-layout'

let container: HTMLDivElement
let root: Root

function mount(
  groupField: string,
  entityType: 'eval_suite' | 'eval_case' | 'eval_run' = 'eval_suite',
) {
  config.grouping = { field: groupField, direction: 'asc' } as typeof config.grouping
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(h(UnifiedViewLayout, { entityType }))
  })
}

function drop(from: string, to: string, ids: string[] = ['s1']) {
  if (!onMoveItem) throw new Error('board never received onMoveItem')
  act(() => {
    onMoveItem!(ids, from, to)
  })
}

beforeEach(() => {
  // Allowed moves finish locally; an unmocked relative PATCH otherwise
  // rejects after the next test has started and leaks its rollback refetch.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  onMoveItem = null
  refetch.mockClear()
  moveItemBetweenGroups.mockClear()
  toastError.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('eval_suite board drag guards', () => {
  it('refuses an outcome drag and names the real path — running the suite', () => {
    mount('last_outcome')
    drop('passed', 'failed')

    expect(toastError).toHaveBeenCalledWith(
      'Outcome comes from the last run — run the suite to change it',
    )
    // Refused BEFORE the optimistic move, so there is no rollback to get wrong.
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
  })

  it('refuses a drag onto the never-run column too', () => {
    mount('last_outcome')
    drop('passed', '__none__')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('refuses last_run_mode — the runs fill it in, not the user', () => {
    mount('last_run_mode')
    drop('batch', 'live')

    expect(toastError).toHaveBeenCalledWith(
      "This column is filled in by the suite's runs, not by hand",
    )
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('refuses case_count — dragging a card cannot add a case', () => {
    mount('case_count')
    drop('1', '7')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('refuses target_kind — a suite grades one recipe, and its runs assume it', () => {
    mount('target_kind')
    drop('agent', 'skill')

    expect(toastError).toHaveBeenCalledWith(
      'A suite grades one agent or skill — change it on the suite itself',
    )
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('lets suite_kind through — the one authoring choice the PATCH route takes', () => {
    mount('suite_kind')
    drop('capability', 'regression')

    expect(toastError).not.toHaveBeenCalled()
    expect(moveItemBetweenGroups).toHaveBeenCalled()
  })
})

/**
 * The same board, for the two CHILDREN the suite detail page now embeds.
 *
 * `eval_case` mirrors the suite exactly: one field a drag may write
 * (`polarity` — an authoring choice with nothing derived behind it, and
 * UpdateCaseSchema accepts it), everything else refused up front with the
 * reason rather than left to 400 and roll back.
 *
 * `eval_run` is the categorical one. A run is the immutable record of what one
 * prompt scored at one moment: ENTITY_ENDPOINTS.eval_run returns null, so
 * there is no PATCH endpoint for a drop to reach at all. Every column is
 * refused, whichever field the board is grouped by — which is why the test
 * below walks several rather than naming one.
 */
describe('eval_case board drag guards', () => {
  it('refuses an outcome drag and names the real path — running the suite', () => {
    mount('last_outcome', 'eval_case')
    drop('passed', 'failed')

    expect(toastError).toHaveBeenCalledWith(
      'Outcome comes from the last run — run the suite to change it',
    )
    // Refused BEFORE the optimistic move, so there is no rollback to get wrong.
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
  })

  it('refuses last_run_at — a trigger owns it (migration 257)', () => {
    mount('last_run_at', 'eval_case')
    drop('2026-09-01', '2026-09-08')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('refuses modes — a board drop carries ONE value and a case can have both', () => {
    // The subtle one. UpdateCaseSchema DOES accept `modes`, so the schema
    // alone would let this through; what refuses it is the shape. Dropping a
    // batch+live case into the "Live" column would write ['live'] and silently
    // stop it running in batch.
    mount('modes', 'eval_case')
    drop('batch', 'live')

    expect(toastError).toHaveBeenCalledWith(
      'A case can run in both modes — set them on the case itself',
    )
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('refuses visibility — UpdateCaseSchema does not accept it at all', () => {
    mount('visibility', 'eval_case')
    drop('workspace', 'private')

    expect(toastError).toHaveBeenCalledWith(
      'Visibility follows the capture the case was seeded from',
    )
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('lets polarity through — the one authoring choice the PATCH route takes', () => {
    mount('polarity', 'eval_case')
    drop('positive', 'negative')

    expect(toastError).not.toHaveBeenCalled()
    expect(moveItemBetweenGroups).toHaveBeenCalled()
  })
})

describe('eval_run board drag guards', () => {
  // Not parameterized over a loop: `afterEach` owns the unmount, so each
  // grouping needs its own case rather than a re-mount inside one.
  for (const groupField of ['outcome', 'status', 'mode', 'speed']) {
    it(`refuses a drag on the ${groupField} board`, () => {
      mount(groupField, 'eval_run')
      drop('a', 'b')

      expect(toastError).toHaveBeenCalledWith(
        'A run records what happened — it cannot be edited',
      )
      // Refused BEFORE the optimistic move — and there is no PATCH endpoint
      // behind it either (ENTITY_ENDPOINTS.eval_run is null), so a drop that
      // got past this guard would fail silently rather than roll back.
      expect(moveItemBetweenGroups).not.toHaveBeenCalled()
      expect(refetch).not.toHaveBeenCalled()
    })
  }

  it('refuses a drag onto the no-verdict column too', () => {
    mount('outcome', 'eval_run')
    drop('passed', '__none__')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })
})
