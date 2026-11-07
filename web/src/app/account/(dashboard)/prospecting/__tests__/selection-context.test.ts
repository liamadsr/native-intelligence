// @vitest-environment jsdom
/**
 * The prospect-list selection store (B6).
 *
 * The contract this pins is mostly about what the ABSENCE of a selection means,
 * because that's the distinction the agent acts on:
 *
 *   • a snapshot with `selectedEntryIds: []` = "on the list, nothing picked"
 *     → the model should ASK which rows;
 *   • no snapshot at all (null) = "not on a list" → no selection block.
 *
 * Collapsing those two would make an empty selection indistinguishable from
 * leaving the page, and the prompt would silently drop the block the moment the
 * user unchecks their last row.
 *
 * It also pins the 50-id cap against the untruncated count (so the prompt can
 * say "50 of 120") and the per-list keying (one tab's list can't read another's).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  publishProspectingSelection,
  readProspectingSelection,
  useProspectingSelection,
  __resetProspectingSelectionStore,
  type ProspectingSelectionSnapshot,
} from '../selection-context'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'

const BASE = {
  listName: 'Series A fintech',
  tab: 'company' as const,
  filter: 'all' as const,
}

beforeEach(() => {
  __resetProspectingSelectionStore()
})

describe('publish / read', () => {
  it('reads back what was published, with the list id folded in', () => {
    publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1', 'e2'] })
    expect(readProspectingSelection('list-1')).toEqual({
      listId: 'list-1',
      listName: 'Series A fintech',
      tab: 'company',
      filter: 'all',
      selectedEntryIds: ['e1', 'e2'],
      selectedCount: 2,
    })
  })

  it('an OPEN list with nothing selected still publishes a snapshot', () => {
    publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: [] })
    const snap = readProspectingSelection('list-1')
    expect(snap).not.toBeNull()
    expect(snap!.selectedEntryIds).toEqual([])
    expect(snap!.selectedCount).toBe(0)
  })

  it('null clears — that is what UNMOUNT publishes, and it is not the same as an empty selection', () => {
    publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1'] })
    publishProspectingSelection('list-1', null)
    expect(readProspectingSelection('list-1')).toBeNull()
  })

  it('keeps one snapshot per list — a background tab cannot read the active tab’s selection', () => {
    publishProspectingSelection('list-a', { ...BASE, listName: 'A', selectedEntryIds: ['a1'] })
    publishProspectingSelection('list-b', { ...BASE, listName: 'B', selectedEntryIds: ['b1', 'b2'] })
    expect(readProspectingSelection('list-a')!.selectedEntryIds).toEqual(['a1'])
    expect(readProspectingSelection('list-b')!.selectedEntryIds).toEqual(['b1', 'b2'])
    expect(readProspectingSelection('list-c')).toBeNull()
    expect(readProspectingSelection(null)).toBeNull()
  })

  it('caps the ids at the targeted-run ceiling but reports the UNTRUNCATED count', () => {
    const many = Array.from({ length: 120 }, (_, i) => `e${i}`)
    publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: many })
    const snap = readProspectingSelection('list-1')!
    expect(snap.selectedEntryIds).toHaveLength(MAX_ENTRIES_PER_TARGETED_RUN)
    expect(snap.selectedEntryIds[0]).toBe('e0')
    // The prompt needs the real number to say "50 of 120 listed".
    expect(snap.selectedCount).toBe(120)
  })

  it('an explicit selectedCount wins over the id length (the page counts before it truncates)', () => {
    publishProspectingSelection('list-1', {
      ...BASE,
      selectedEntryIds: ['e1', 'e2'],
      selectedCount: 87,
    })
    expect(readProspectingSelection('list-1')!.selectedCount).toBe(87)
  })
})

describe('useProspectingSelection', () => {
  let container: HTMLDivElement
  let root: Root
  let seen: Array<ProspectingSelectionSnapshot | null>
  let renders: number

  function Probe({ listId }: { listId: string | null }) {
    const snap = useProspectingSelection(listId)
    seen.push(snap)
    renders++
    return null
  }

  async function mount(listId: string | null) {
    seen = []
    renders = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(h(Probe, { listId }))
    })
  }

  async function unmount() {
    await act(async () => root.unmount())
    container.remove()
  }

  it('re-renders the subscriber when its list publishes', async () => {
    await mount('list-1')
    expect(seen.at(-1)).toBeNull()

    await act(async () => {
      publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1'] })
    })
    expect(seen.at(-1)!.selectedEntryIds).toEqual(['e1'])

    await act(async () => {
      publishProspectingSelection('list-1', null)
    })
    expect(seen.at(-1)).toBeNull()
    await unmount()
  })

  it('ignores publishes for OTHER lists', async () => {
    await mount('list-1')
    const before = renders
    await act(async () => {
      publishProspectingSelection('list-2', { ...BASE, selectedEntryIds: ['x'] })
    })
    expect(renders).toBe(before)
    expect(seen.at(-1)).toBeNull()
    await unmount()
  })

  it('a null listId (tab is not on a prospect list) always reads null', async () => {
    await mount(null)
    await act(async () => {
      publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1'] })
    })
    expect(seen.every((s) => s === null)).toBe(true)
    await unmount()
  })

  /**
   * The reader feeds the snapshot straight into a useMemo dep list in
   * TabChatPanel, so an identical re-publish must keep the SAME object — a new
   * one per keystroke elsewhere on the page would rebuild the tab's
   * systemContext (and its transport body) for no change at all.
   */
  it('a re-publish of identical state keeps snapshot identity (no needless re-render)', async () => {
    publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1'] })
    await mount('list-1')
    const first = seen.at(-1)
    const rendersAfterMount = renders

    await act(async () => {
      publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1'] })
    })
    expect(seen.at(-1)).toBe(first)
    expect(renders).toBe(rendersAfterMount)

    // A REAL change still propagates.
    await act(async () => {
      publishProspectingSelection('list-1', { ...BASE, selectedEntryIds: ['e1', 'e2'] })
    })
    expect(seen.at(-1)).not.toBe(first)
    expect(seen.at(-1)!.selectedEntryIds).toEqual(['e1', 'e2'])
    await unmount()
  })
})
