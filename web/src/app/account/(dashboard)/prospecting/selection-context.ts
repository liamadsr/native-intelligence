/**
 * What the user is LOOKING at on a prospect list — published by the list page,
 * read by the chat whose card shows it (B6; chat-panel.tsx turnSystemContext).
 *
 * The gap this closes: the user selects five rows, types "research these", and
 * Scout has no idea which rows "these" are. The card names the LIST but not
 * the SELECTION, so the model either asks or — worse — invents its own set and
 * spends money on it.
 *
 * Why an external store rather than context or a prop:
 *   • The publisher (list-detail.tsx, inside a card's body) and the reader
 *     (the chat's send path) need no common provider, and adding one would
 *     re-render the chat on every checkbox click.
 *   • Keyed by listId, so a card showing list A never hands over the
 *     selection of another chat's card showing list B.
 *   • useSyncExternalStore gives a reader a stable snapshot per render and
 *     tears correctly under concurrent React.
 *
 * Lifecycle contract (deliberate, and pinned by the tests):
 *   • An OPEN list with nothing selected still publishes a snapshot with
 *     `selectedEntryIds: []` — the agent must be able to tell "looking at the
 *     list, nothing selected" (→ ask which) apart from "not on a list at all".
 *   • `null` is published only on UNMOUNT (the user left the list).
 */
'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'
import type { ProspectEntryKind } from '@/lib/prospecting/types'
import type { ProspectStageTab } from '@/lib/views/prospect-stage-tabs'

/**
 * One list page's live view state. Rides on `systemContext.prospectingSelection`
 * with every turn from that tab's chat panel.
 */
export interface ProspectingSelectionSnapshot {
  listId: string
  listName: string
  /** Which tab of the list is showing — companies or people. */
  tab: ProspectEntryKind
  /** The stage tab in force (all / saved / needs_review / dismissed) —
   *  `all`, the baseline, while a custom view is open. */
  filter: ProspectStageTab
  /**
   * The selected entry ids, in selection order, capped at
   * {@link MAX_ENTRIES_PER_TARGETED_RUN} — the same ceiling a targeted run
   * accepts, so what the prompt lists is always something the tools can take.
   */
  selectedEntryIds: string[]
  /** The UNTRUNCATED count, so the prompt can say "50 of 120 listed". */
  selectedCount: number
}

type Listener = () => void

/** listId → the latest published snapshot (or absent once the page unmounts). */
const snapshots = new Map<string, ProspectingSelectionSnapshot>()
/** listId → the subscribed readers for that list. */
const listeners = new Map<string, Set<Listener>>()

function notify(listId: string) {
  const set = listeners.get(listId)
  if (!set) return
  for (const fn of [...set]) fn()
}

/**
 * Publish (or clear) the snapshot for one list.
 *
 * Pass `null` when the list page unmounts. Passing a snapshot with an empty
 * `selectedEntryIds` is NOT the same thing — see the module docblock.
 *
 * The id cap is applied here rather than at the call site so every publisher
 * (and every future one) obeys it.
 */
export function publishProspectingSelection(
  listId: string,
  /**
   * The list's view state. `listId` may be repeated here for readability at the
   * call site — the positional argument is what the store keys on either way,
   * and `selectedCount` defaults to the id count when the caller has already
   * truncated.
   */
  snapshot:
    | (Omit<ProspectingSelectionSnapshot, 'listId' | 'selectedCount'> & {
        listId?: string
        selectedCount?: number
      })
    | null,
): void {
  if (!listId) return
  if (snapshot === null) {
    if (!snapshots.has(listId)) return
    snapshots.delete(listId)
    notify(listId)
    return
  }
  const ids = snapshot.selectedEntryIds ?? []
  const next: ProspectingSelectionSnapshot = {
    listId,
    listName: snapshot.listName,
    tab: snapshot.tab,
    filter: snapshot.filter,
    selectedEntryIds: ids.slice(0, MAX_ENTRIES_PER_TARGETED_RUN),
    selectedCount: snapshot.selectedCount ?? ids.length,
  }
  const prev = snapshots.get(listId)
  // Identity stability matters: the reader feeds this straight into a useMemo
  // dependency list, and a fresh object every keystroke elsewhere on the page
  // would rebuild the tab's systemContext (and its transport body) for nothing.
  if (prev && sameSnapshot(prev, next)) return
  snapshots.set(listId, next)
  notify(listId)
}

function sameSnapshot(a: ProspectingSelectionSnapshot, b: ProspectingSelectionSnapshot): boolean {
  return (
    a.listName === b.listName &&
    a.tab === b.tab &&
    a.filter === b.filter &&
    a.selectedCount === b.selectedCount &&
    a.selectedEntryIds.length === b.selectedEntryIds.length &&
    a.selectedEntryIds.every((id, i) => id === b.selectedEntryIds[i])
  )
}

/** Read the current snapshot without subscribing (event handlers, tests). */
export function readProspectingSelection(listId: string | null): ProspectingSelectionSnapshot | null {
  if (!listId) return null
  return snapshots.get(listId) ?? null
}

/**
 * Subscribe a component to one list's snapshot. `null` listId (the tab isn't
 * showing a prospect list) subscribes to nothing and always reads `null`.
 */
export function useProspectingSelection(listId: string | null): ProspectingSelectionSnapshot | null {
  const subscribe = useCallback(
    (onChange: Listener) => {
      if (!listId) return () => {}
      let set = listeners.get(listId)
      if (!set) {
        set = new Set()
        listeners.set(listId, set)
      }
      set.add(onChange)
      return () => {
        set!.delete(onChange)
        if (set!.size === 0) listeners.delete(listId)
      }
    },
    [listId],
  )
  const getSnapshot = useCallback(() => readProspectingSelection(listId), [listId])
  // The server render has no page mounted, so there is never a selection there.
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/** Test-only reset so one spec's publishes can't leak into the next. */
export function __resetProspectingSelectionStore(): void {
  snapshots.clear()
  listeners.clear()
}
