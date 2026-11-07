// @vitest-environment jsdom
/**
 * The board's stage-drag guards for `prospect_list_entry` (§10, "Dragging to
 * Dismissed opens the reason picker").
 *
 * WHY THIS ENTITY NEEDS A GUARD AND ACTIONS DO NOT. Board grouping normally
 * drags a card by PATCHing the group-by field, which is honest for a status or
 * a priority. Two of `stage`'s four columns are not a field write at all:
 *
 *   dismissed  — needs a REASON, and two of the seven reasons suppress the
 *                candidate in EVERY list in the workspace (decision 3). A drag
 *                that wrote `stage='dismissed'` bare would 400; one that
 *                chose a reason on the user's behalf would let one mouse
 *                gesture do something the row's own × makes them choose.
 *   saved      — asserts a CRM record EXISTS. Only /entries/save can make that
 *                true; the generic PATCH refuses the value outright.
 *
 * And `discovered` is refused outright, because it is where candidates start —
 * there is no un-save on this board, and a drag back would either fail
 * silently or look like it reversed a CRM write it cannot reverse.
 *
 * THE CANCEL-REVERTS GUARANTEE IS STRUCTURAL, and that is what the last test
 * pins: the guard returns BEFORE `moveItemBetweenGroups`, so a cancelled
 * dismissal has no optimistic move to roll back. The card was never moved. A
 * design that moved first and reverted on cancel would have a rollback path
 * that can itself fail, on the one board where a wrong column is a wrong claim
 * about the user's CRM.
 *
 * Harness: the same shape as unified-view-group-move-refetch.test.tsx — the
 * REAL component with data/picker hooks stubbed — plus a ViewBoard stub that
 * captures `onMoveItem` so a drop can be invoked directly rather than
 * simulated through dnd-kit.
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

// Board grouped by STAGE — the configuration PR 7 makes the default, and the
// only one these guards apply to.
const config = {
  filters: [],
  grouping: { field: 'stage', direction: 'asc' },
  layout: 'board',
  crm_scope: 'contacts',
  capture_scope: 'all',
} as unknown as import('../hooks/use-view').ViewConfig

const DATA = [
  {
    key: 'discovered',
    metadata: {},
    items: [
      { id: 'e1', title: 'Acme', stage: 'discovered' },
      { id: 'e2', title: 'Querylane', stage: 'discovered' },
    ],
  },
  { key: 'shortlisted', metadata: {}, items: [] },
  { key: 'saved', metadata: {}, items: [] },
  {
    key: 'dismissed',
    metadata: {},
    items: [
      // A WORKSPACE-WIDE dismissal (decision 3) and an ordinary list-relative
      // one, so the un-dismiss guard is tested on the distinction it makes
      // rather than on the column it happens to sit in.
      { id: 'd1', title: 'Rival', stage: 'dismissed', dismissed_reason: 'competitor' },
      { id: 'd2', title: 'Tiny', stage: 'dismissed', dismissed_reason: 'too_small' },
    ],
  },
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

/** Captures the drop handler the layout hands the board, so a test can invoke
 *  a drop directly instead of driving dnd-kit through jsdom. */
let onMoveItem: ((ids: string[], from: string, to: string) => void) | null = null
vi.mock('../view-board', () => ({
  ViewBoard: (props: { onMoveItem?: (ids: string[], from: string, to: string) => void }) => {
    onMoveItem = props.onMoveItem ?? null
    return null
  },
}))

import {
  PROSPECT_ENTRY_ACTION_EVENT,
  type ProspectEntryActionDetail,
} from '../list/entity-row'
import { UnifiedViewLayout } from '../unified-view-layout'

let container: HTMLDivElement
let root: Root
let seen: ProspectEntryActionDetail[]
let stopListening: () => void

function drop(to: string, ids: string[] = ['e1']) {
  if (!onMoveItem) throw new Error('board never received onMoveItem')
  act(() => {
    onMoveItem!(ids, 'discovered', to)
  })
}

beforeEach(() => {
  onMoveItem = null
  refetch.mockClear()
  moveItemBetweenGroups.mockClear()
  toastError.mockClear()

  seen = []
  const listener = (e: Event) => {
    seen.push((e as CustomEvent<ProspectEntryActionDetail>).detail)
  }
  window.addEventListener(PROSPECT_ENTRY_ACTION_EVENT, listener)
  stopListening = () => window.removeEventListener(PROSPECT_ENTRY_ACTION_EVENT, listener)

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(h(UnifiedViewLayout, { entityType: 'prospect_list_entry' as const }))
  })
})

afterEach(() => {
  stopListening()
  act(() => root.unmount())
  container.remove()
})

describe('prospect_list_entry board drag guards', () => {
  it('drag → Dismissed defers to the reason picker instead of writing the stage', () => {
    drop('dismissed')

    // The intent, on the SAME bridge the hover × and the selection bar use, so
    // all three gestures land on one handler that opens DismissReasonDialog.
    expect(seen).toEqual([{ action: 'dismiss', entryIds: ['e1'] }])
    // And nothing was written or moved: the dialog decides.
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('cancelling that dialog reverts the card — because it never moved', () => {
    drop('dismissed')

    // There is no rollback path to get wrong: the guard returns before the
    // optimistic move, so a cancel is simply the absence of a second event.
    // The card is still in `discovered` because nothing ever took it out.
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
  })

  it('carries every dragged id, so a multi-select dismissal asks once', () => {
    drop('dismissed', ['e1', 'e2'])
    expect(seen).toEqual([{ action: 'dismiss', entryIds: ['e1', 'e2'] }])
  })

  it('drag → Saved goes through the save route, not a stage PATCH', () => {
    // `saved` asserts a CRM record exists; only /entries/save can make it true,
    // and it returns per-entry outcomes a PATCH cannot express.
    drop('saved')
    expect(seen).toEqual([{ action: 'save', entryIds: ['e1'] }])
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('drag → Discovered is refused, and says what to do instead', () => {
    act(() => {
      onMoveItem!(['e1'], 'shortlisted', 'discovered')
    })

    expect(toastError).toHaveBeenCalledWith(
      'Use Dismiss or Save; discovery is where candidates start',
    )
    expect(seen).toEqual([])
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('drag OUT of Dismissed is refused when the dismissal was workspace-wide', () => {
    // `updateEntryStage` nulls the whole dismissal triple on any non-dismissed
    // stage, and `buildExclusionSet` keys `dismissed_global` on exactly
    // `stage === 'dismissed' && dismissed_reason`. So this drag would revoke a
    // suppression that spans every list in the workspace — including lists
    // that do not exist yet — with no confirm and nothing said. Refused for
    // the same reason ENTERING dismissal defers to the picker.
    act(() => {
      onMoveItem!(['d1'], 'dismissed', 'shortlisted')
    })

    expect(toastError).toHaveBeenCalledWith(
      'This dismissal hides the company across every list — undo it from the row',
    )
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('...and refuses the whole drag if any card in it is a global dismissal', () => {
    // A multi-select that mixes the two must not half-apply: partially
    // un-dismissing would leave the user with no way to tell which rows moved.
    act(() => {
      onMoveItem!(['d2', 'd1'], 'dismissed', 'shortlisted')
    })

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(moveItemBetweenGroups).not.toHaveBeenCalled()
  })

  it('but an ordinary list-relative dismissal stays draggable back', () => {
    // `too_small` suppresses in THIS list only, so un-dismissing it is an
    // honest field write and the board must not refuse it — a guard that
    // blocked the whole column would make Dismissed a one-way trip.
    act(() => {
      onMoveItem!(['d2'], 'dismissed', 'shortlisted')
    })

    expect(toastError).not.toHaveBeenCalled()
    expect(moveItemBetweenGroups).toHaveBeenCalled()
  })

  it('a global dismissal can still be re-dismissed (reason picker, not a write)', () => {
    // The guard is about LEAVING dismissal. Dropping back onto Dismissed —
    // e.g. to change the reason — still defers to the picker as normal.
    act(() => {
      onMoveItem!(['d1'], 'dismissed', 'dismissed')
    })

    expect(seen).toEqual([{ action: 'dismiss', entryIds: ['d1'] }])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('drag → Shortlisted falls through as an ordinary field write', () => {
    // The one honest PATCH of the four — it must NOT be intercepted, or the
    // board loses its only working column and the guards read as "nothing
    // works" rather than "two of these need a dialog".
    drop('shortlisted')

    expect(seen).toEqual([])
    expect(toastError).not.toHaveBeenCalled()
    expect(moveItemBetweenGroups).toHaveBeenCalled()
  })
})
