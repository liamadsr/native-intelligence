/**
 * Merging two people's edits through the save path, without a live channel
 * (the lead's decision, phase 5: no Realtime, no new policies tonight). When a
 * save is refused because someone else saved first, the editor loads the newer
 * workbook and replays its own unsaved work onto it with the engine's change
 * sets, so nobody's edits are lost and others' arrive within a few seconds.
 *
 * What the engine's change sets carry, checked against the real runtime: cell
 * inputs, formulas (with their results), styles and number formats, sheet add,
 * rename and delete all travel and replay. Disjoint cells merge; the same cell
 * ends with the replayed (my) value — last writer wins. A change set is applied
 * at its ABSOLUTE address: if the other person inserted rows above a cell I
 * edited, my edit still lands on its original row number, not the row my value
 * logically followed. A change set aimed at a sheet the other person deleted
 * throws ("Invalid sheet index"); it is caught and that action is dropped, the
 * rest still replay, and the model stays usable.
 */
import type { Model } from '@ironcalc/wasm'
import { EXTRAS_VERSION, emptyExtras, type WorkbookExtras } from './extras'

export interface RebaseResult {
  /** `theirs`, now carrying my replayed work. The same object, mutated in place. */
  model: Model
  /** How many of my actions could not be replayed (e.g. they touched a deleted sheet). */
  dropped: number
}

/**
 * Replay my pending action-diffs (controller.pendingDiffs(), oldest first) onto
 * another editor's workbook. Each action is applied on its own, so one that
 * fails is dropped and the rest still land. `theirs` is mutated and returned.
 */
export function rebasePending(theirs: Model, pending: readonly Uint8Array[]): RebaseResult {
  let dropped = 0
  for (const diff of pending) {
    try {
      theirs.applyExternalDiffs(diff)
    } catch {
      // The action aimed at something that is no longer there (a deleted
      // sheet). Drop it; the engine model is still sound.
      dropped += 1
    }
  }
  theirs.evaluate()
  return { model: theirs, dropped }
}

/** A one-sentence note about dropped work, or null when nothing was dropped. */
export function droppedNote(dropped: number): string | null {
  if (dropped <= 0) return null
  return dropped === 1
    ? 'One of your changes was to a sheet someone else deleted, so it was dropped.'
    : `${dropped} of your changes were to a sheet someone else deleted, so they were dropped.`
}

/**
 * Merge the extras (the jsonb the engine does not hold: validations,
 * checkboxes, tables, charts, images) per top-level key. For each kind, keep
 * the other person's if I did not change it since I loaded, and mine if I did.
 * So if they added a chart while I edited a table, the merge has both.
 */
export function mergeExtras(base: WorkbookExtras, mine: WorkbookExtras, theirs: WorkbookExtras): WorkbookExtras {
  const result = emptyExtras()
  const mineRec = mine as unknown as Record<string, unknown>
  const baseRec = base as unknown as Record<string, unknown>
  const theirsRec = theirs as unknown as Record<string, unknown>
  const resultRec = result as unknown as Record<string, unknown>
  const keys = new Set<string>([...Object.keys(mineRec), ...Object.keys(theirsRec), ...Object.keys(resultRec)])
  for (const key of keys) {
    if (key === 'v') continue
    const changedByMe = !sameJson(mineRec[key], baseRec[key])
    const value = changedByMe ? mineRec[key] : theirsRec[key]
    if (value !== undefined) resultRec[key] = value
  }
  result.v = EXTRAS_VERSION
  return result
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  } catch {
    return false
  }
}
