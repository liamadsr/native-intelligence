/**
 * Merging two people's edits through the save path, without a live channel
 * (the lead's decision, phase 5: no Realtime, no new policies tonight). When a
 * save is refused because someone else saved first, the editor loads the newer
 * workbook and replays its own unsaved work onto it, so nobody's edits are lost
 * and others' arrive within a few seconds.
 *
 * The engine replays a change set at its ABSOLUTE row/column/sheet-index, so a
 * naive replay lands a late edit on the wrong cell when the other person
 * inserted or deleted rows/columns above it, or on the wrong sheet when a sheet
 * was added, deleted or moved before it. `rebaseWithLog` closes that: each
 * pending action carries what it is (see `PendingAction`), and the newer
 * workbook's extras carry a structural-edit log; a plain cell edit is moved
 * through the relevant log entries and re-applied by the engine's input setter
 * on the sheet resolved by its stable id, and anything that cannot be moved
 * provably stops the merge instead of guessing.
 */
import type { Model } from '@ironcalc/wasm'
import { EXTRAS_VERSION, emptyExtras, type StructureEntry, type WorkbookExtras } from './extras'
import type { ExtrasChange } from './extras'
import { listSheets, type SheetInfo } from './workbook'

/**
 * What a pending action is, recorded by the controller alongside the engine's
 * change set so a rebase can re-express it on the newer layout:
 *  - `cells`: typed inputs (a value, a formula, a clear) at known cells on one
 *    sheet; these can be moved through structural changes and re-applied.
 *  - `structure`: my own row/column insert or delete.
 *  - `opaque`: anything else (styles, sorts, sheet ops, fills, undo/redo,
 *    multi-effect actions); it can only be replayed at its absolute address,
 *    with its sheet noted when the action is clearly single-sheet.
 */
export type PendingAction =
  | { kind: 'cells'; sheetId: number; cells: Array<{ row: number; column: number; input: string }> }
  | { kind: 'structure'; change: ExtrasChange }
  | { kind: 'opaque'; sheetId?: number }

/** One pending action and the engine's change set for it (the change set is the opaque fallback). */
export interface PendingEntry {
  diff: Uint8Array
  action: PendingAction
}

export interface RebaseResult {
  /** `theirs`, now carrying my replayed work. The same object, mutated in place. */
  model: Model
  /** How many of my actions could not be replayed (e.g. they touched a deleted sheet). */
  dropped: number
}

/**
 * Replay my pending change sets (controller.pendingDiffs(), oldest first) onto
 * another editor's workbook at their absolute address. Each action is applied
 * on its own, so one that fails is dropped and the rest still land. `theirs` is
 * mutated and returned. This is the pre-log behaviour, kept for replaying an
 * opaque action and for callers that do not carry a log.
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
    ? 'One of your changes could not be placed — a row, column or sheet it was on had been removed — so it was dropped.'
    : `${dropped} of your changes could not be placed — the rows, columns or sheets they were on had been removed — so they were dropped.`
}

// ── Rebase with the structural log ───────────────────────────────────────────

export interface RebaseWithLogInput {
  /** The newer workbook, mutated in place on a merge (left untouched on a stop). */
  theirs: Model
  /** The newer workbook's extras, carrying its structure log. */
  theirsExtras: WorkbookExtras
  /** The revision my pending work was made over. */
  myBaseRevision: number
  /** My base workbook's sheets (id → index), to resolve a pending action's sheet by its stable id. */
  mySheets: readonly SheetInfo[]
  /** My unsaved actions, oldest first. */
  pending: readonly PendingEntry[]
}

export type RebaseWithLogResult =
  | {
      status: 'merged'
      model: Model
      dropped: number
      /**
       * My pending work as it now stands in the merged workbook: moved cells at
       * their new addresses, dropped actions gone. It is still unsaved, so the
       * editor keeps THIS list; a save refused again must not replay the old
       * addresses onto a log that no longer mentions what moved them.
       */
      pending: PendingEntry[]
    }
  /** A late edit could not be placed with certainty: keep the person's own version, do not adopt. */
  | { status: 'stop' }

const ROW_COL: ReadonlySet<string> = new Set(['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns'])

/** A cell moved through the relevant row/column entries; null when its own row or column was deleted. */
function moveCell(row: number, column: number, entries: readonly StructureEntry[]): { row: number; column: number } | null {
  let r = row
  let c = column
  for (const e of entries) {
    const at = e.at ?? 0
    const count = e.count ?? 0
    if (e.type === 'insertRows') {
      if (r >= at) r += count
    } else if (e.type === 'deleteRows') {
      if (r >= at && r <= at + count - 1) return null
      if (r > at + count - 1) r -= count
    } else if (e.type === 'insertColumns') {
      if (c >= at) c += count
    } else if (e.type === 'deleteColumns') {
      if (c >= at && c <= at + count - 1) return null
      if (c > at + count - 1) c -= count
    }
  }
  return { row: r, column: c }
}

/** True when any sheet shared by both maps sits at a different index, or a sheet was added or removed. */
function sheetMapChanged(mine: Map<number, number>, theirs: Map<number, number>): boolean {
  if (mine.size !== theirs.size) return true
  for (const [id, index] of mine) {
    if (theirs.get(id) !== index) return true
  }
  return false
}

/**
 * Replay my pending work onto the newer workbook, using its structure log to
 * move plain cell edits and the sheet id → index maps to keep every action on
 * its own sheet. The rule, chosen to be provably right over clever:
 *  - `cells`: move each cell through the newer workbook's relevant row/column
 *    entries for that sheet (an insert at/above shifts it down/right; a delete
 *    of its own row/column drops it, counted), then set the input on the sheet
 *    found by its stable id. A formula I typed is set as typed — the engine
 *    parses it against the new layout; its references are not rewritten.
 *  - `structure` (my own insert/delete): if the other side also changed
 *    structure on that same sheet, stop (do not try to be clever about two
 *    structural edits on one sheet); otherwise apply it on that sheet.
 *  - `opaque`: replay at its absolute address only when its sheet is present at
 *    the same index and no logged structural change touched it; otherwise stop
 *    (or drop, counted, when its sheet is gone).
 *  - a `reset` entry, or a floor above my base, means the log cannot be trusted:
 *    stop.
 * On stop, `theirs` is left untouched so the editor can keep the person's own
 * version on screen; nothing is ever placed on a guessed row.
 */
export function rebaseWithLog(input: RebaseWithLogInput): RebaseWithLogResult {
  const { theirs, theirsExtras, myBaseRevision, mySheets, pending } = input
  const log = theirsExtras.structure ?? []
  const floor = theirsExtras.structureFloor ?? 0
  const relevant = log.filter((e) => e.base >= myBaseRevision)
  const unknown = floor > myBaseRevision || relevant.some((e) => e.type === 'reset')

  const theirSheets = listSheets(theirs)
  const myIndexById = new Map(mySheets.map((s) => [s.id, s.index]))
  const theirIndexById = new Map(theirSheets.map((s) => [s.id, s.index]))

  type Op =
    | { kind: 'cell'; sheetIndex: number; row: number; column: number; input: string }
    | { kind: 'structure'; sheetIndex: number; change: ExtrasChange }
    | { kind: 'diff'; diff: Uint8Array }

  const ops: Op[] = []
  const rebased: PendingEntry[] = []
  let dropped = 0

  // First pass: plan every action, detecting a stop before anything is applied.
  for (const { action, diff } of pending) {
    if (action.kind === 'cells') {
      if (unknown) return { status: 'stop' }
      const theirIndex = theirIndexById.get(action.sheetId)
      if (theirIndex === undefined) {
        dropped += action.cells.length // the sheet is gone
        continue
      }
      const entries = relevant.filter((e) => e.sheetId === action.sheetId && ROW_COL.has(e.type))
      const kept: Array<{ row: number; column: number; input: string }> = []
      for (const cell of action.cells) {
        const moved = moveCell(cell.row, cell.column, entries)
        if (!moved) {
          dropped += 1 // its own row or column was deleted
          continue
        }
        ops.push({ kind: 'cell', sheetIndex: theirIndex, row: moved.row, column: moved.column, input: cell.input })
        kept.push({ row: moved.row, column: moved.column, input: cell.input })
      }
      if (kept.length) rebased.push({ diff, action: { kind: 'cells', sheetId: action.sheetId, cells: kept } })
      continue
    }
    if (action.kind === 'structure') {
      if (unknown) return { status: 'stop' }
      const change = action.change
      const sheetId = 'sheetId' in change ? change.sheetId : undefined
      if (sheetId === undefined || !ROW_COL.has(change.type)) return { status: 'stop' }
      const theirIndex = theirIndexById.get(sheetId)
      if (theirIndex === undefined) {
        dropped += 1 // my structural edit was to a sheet the other person deleted
        continue
      }
      const theyChangedStructure = relevant.some((e) => e.sheetId === sheetId && ROW_COL.has(e.type))
      if (theyChangedStructure) return { status: 'stop' } // both sides changed structure on one sheet
      ops.push({ kind: 'structure', sheetIndex: theirIndex, change })
      rebased.push({ diff, action })
      continue
    }
    // opaque
    if (unknown) return { status: 'stop' }
    const sheetId = action.sheetId
    if (sheetId === undefined) {
      // The action's sheet is unknown: safe only when nothing structural moved and no sheet was added, deleted or moved.
      if (relevant.length || sheetMapChanged(myIndexById, theirIndexById)) return { status: 'stop' }
      ops.push({ kind: 'diff', diff })
      rebased.push({ diff, action })
      continue
    }
    const theirIndex = theirIndexById.get(sheetId)
    if (theirIndex === undefined) {
      dropped += 1 // the sheet is gone: drop it, as a replayed diff would have thrown
      continue
    }
    if (relevant.some((e) => e.sheetId === sheetId)) return { status: 'stop' } // structure touched its sheet
    if (myIndexById.get(sheetId) !== theirIndex) return { status: 'stop' } // the sheet moved: its diff's index would miss
    ops.push({ kind: 'diff', diff })
    rebased.push({ diff, action })
  }

  // Second pass: apply, in order. Row/column inserts and deletes do not move
  // sheet indices, so the indices planned above stay valid.
  for (const op of ops) {
    if (op.kind === 'cell') {
      theirs.setUserInput(op.sheetIndex, op.row, op.column, op.input)
    } else if (op.kind === 'structure') {
      const { change, sheetIndex } = op
      const at = 'at' in change ? change.at : 0
      const count = 'count' in change ? change.count : 0
      if (change.type === 'insertRows') theirs.insertRows(sheetIndex, at, count)
      else if (change.type === 'deleteRows') theirs.deleteRows(sheetIndex, at, count)
      else if (change.type === 'insertColumns') theirs.insertColumns(sheetIndex, at, count)
      else if (change.type === 'deleteColumns') theirs.deleteColumns(sheetIndex, at, count)
    } else {
      try {
        theirs.applyExternalDiffs(op.diff)
      } catch {
        dropped += 1
      }
    }
  }
  theirs.evaluate()
  return { status: 'merged', model: theirs, dropped, pending: rebased }
}

/**
 * Merge the extras (the jsonb the engine does not hold: validations,
 * checkboxes, tables, charts, images) per top-level key. For each kind, keep
 * the other person's if I did not change it since I loaded, and mine if I did.
 * So if they added a chart while I edited a table, the merge has both.
 *
 * The structure log is special: theirs' log is the source of truth (it is
 * append-mostly and shared), plus any of my entries it does not already hold —
 * never "mine replaces theirs". My not-yet-saved structural edits are written
 * onto theirs' log again by the editor when the next save goes out.
 */
export function mergeExtras(base: WorkbookExtras, mine: WorkbookExtras, theirs: WorkbookExtras): WorkbookExtras {
  const result = emptyExtras()
  const mineRec = mine as unknown as Record<string, unknown>
  const baseRec = base as unknown as Record<string, unknown>
  const theirsRec = theirs as unknown as Record<string, unknown>
  const resultRec = result as unknown as Record<string, unknown>
  const keys = new Set<string>([...Object.keys(mineRec), ...Object.keys(theirsRec), ...Object.keys(resultRec)])
  for (const key of keys) {
    if (key === 'v' || key === 'structure' || key === 'structureFloor') continue
    const changedByMe = !sameJson(mineRec[key], baseRec[key])
    const value = changedByMe ? mineRec[key] : theirsRec[key]
    if (value !== undefined) resultRec[key] = value
  }
  result.v = EXTRAS_VERSION
  const theirLog = theirs.structure ?? []
  const seen = new Set(theirLog.map((e) => JSON.stringify(e)))
  const mineExtra = (mine.structure ?? []).filter((e) => !seen.has(JSON.stringify(e)))
  result.structure = [...theirLog, ...mineExtra]
  result.structureFloor = theirs.structureFloor ?? 0
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
