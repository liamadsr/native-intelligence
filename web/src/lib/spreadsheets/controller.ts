/**
 * One open workbook: the engine's model, plus what an editor needs around it
 * (which sheet, how far the grid reaches, the draft being typed, a history
 * where one action is one step). It has no React and no DOM in it, so the
 * grid, the toolbar and the tests drive the same object.
 *
 * Reads go straight to the model. Every change goes through `act`, which
 * counts the engine's own steps so Undo takes back the whole action, tells
 * the listeners, and marks the workbook as needing a save.
 */
import type { Area, BorderArea, CellStyle, CfRuleInput, ConditionalFormattingView, Model } from '@ironcalc/wasm'
import {
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_SHEETS,
  cellName,
  columnName,
  parseSheetRange,
  rangeCellCount,
  sheetNameProblem,
  type CellRange,
  type CellRef,
} from './a1'
import { DEFAULT_FONT_POINTS } from './cell-view'
import {
  addCheckboxes,
  clearValidationIn,
  describeValidation,
  emptyExtras,
  isCheckbox as extrasIsCheckbox,
  listChoiceValues,
  passesBound,
  putValidation,
  removeCheckboxesIn,
  shiftExtras,
  validationAt,
  type ExtrasChange,
  type Validation,
  type ValidationChoice,
  type ValidationSpec,
  type WorkbookExtras,
} from './extras'
import { GENERAL, PLAIN_TEXT, changeDecimals, clampFontSize } from './formats'
import { CELL_TYPE, listSheets, saveWorkbook, usedRange, type SheetInfo } from './workbook'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Which edges of the selection a border goes on (the engine's own names). */
export type BorderKind = 'All' | 'Inner' | 'Outer' | 'Top' | 'Right' | 'Bottom' | 'Left' | 'CenterH' | 'CenterV' | 'None'

const ARROW: Record<Direction, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }

/** A new sheet shows this much; it grows as cells past it are used or reached. */
export const START_ROWS = 200
export const START_COLUMNS = 26
const GROW_ROWS = 100
const GROW_COLUMNS = 10

export const MIN_COLUMN_WIDTH = 8
export const MAX_COLUMN_WIDTH = 640
export const MIN_ROW_HEIGHT = 8
export const MAX_ROW_HEIGHT = 640

export interface Selection {
  /** The active cell. */
  row: number
  column: number
  range: CellRange
}

export interface EditState {
  sheet: number
  row: number
  column: number
  draft: string
  /** Where the typing happens: the cell itself or the formula bar. */
  source: 'cell' | 'bar'
}

export interface SheetLayout {
  rows: number
  columns: number
  /** rowStarts[r - 1] is where row r begins; the last entry is the full height. */
  rowStarts: Float64Array
  columnStarts: Float64Array
}

export type ActionResult = { ok: true } | { ok: false; message: string }

/**
 * One entry on the undo stack: how many engine history steps the action took,
 * and, when the action also changed the extras (validation, checkboxes), the
 * extras before and after, so undo and redo restore both together.
 */
interface HistoryEntry {
  steps: number
  extrasBefore: WorkbookExtras | null
  extrasAfter: WorkbookExtras | null
}

/** What a cell's validation rule lets the grid draw: the choices, a chip, a warning. */
export interface ValidationView {
  rule: ValidationSpec
  /** For a list rule: its choices (from the typed list or read live from a source range). */
  choices: ValidationChoice[]
  /** True when the cell has a list rule (so the grid draws a dropdown arrow). */
  isList: boolean
  /** The palette color of the choice the cell's value matches, if any. */
  chipColor: string | null
  /** A non-rejecting rule the cell's current value breaks: draw a warning corner. */
  warn: boolean
}

const OK: ActionResult = { ok: true }
const no = (message: string): ActionResult => ({ ok: false, message })

function engineMessage(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return text ? text.replace(/^Error:\s*/, '') : fallback
}

function area(sheet: number, range: CellRange): Area {
  return { sheet, row: range.r1, column: range.c1, width: range.c2 - range.c1 + 1, height: range.r2 - range.r1 + 1 }
}

/** A number read out of a displayed value, ignoring currency symbols, separators and the like. NaN when there is none. */
function numericFrom(text: string): number {
  const cleaned = text.replace(/[^0-9.eE+-]/g, '')
  return cleaned === '' ? NaN : Number(cleaned)
}

/** The last entry at or before `offset` (a binary search over starts). */
export function indexAt(starts: Float64Array, offset: number): number {
  let lo = 0
  let hi = starts.length - 2
  if (hi < 0) return 0
  if (offset <= 0) return 0
  if (offset >= starts[hi + 1]) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

export class WorkbookController {
  readonly model: Model
  readOnly: boolean

  /** What the engine does not hold (validation, checkboxes); changed only through `act`, one undo step with the engine. */
  extras: WorkbookExtras

  /** Moves on any change a view should redraw for (a selection too). */
  version = 0
  /** Moves when cells, formats, layout or sheets changed: what is saved. */
  dataVersion = 0
  /** The dataVersion the last save carried. */
  savedVersion = 0

  editing: EditState | null = null

  private listeners = new Set<() => void>()
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private steps = 0
  private savedExtras: WorkbookExtras
  private extents = new Map<number, { rows: number; columns: number }>()
  private layouts = new Map<number, { at: number; layout: SheetLayout }>()
  private layoutVersion = 0

  constructor(model: Model, options: { readOnly?: boolean; extras?: WorkbookExtras } = {}) {
    this.model = model
    this.readOnly = options.readOnly ?? false
    this.extras = options.extras ?? emptyExtras()
    this.savedExtras = this.extras
    // A workbook saved while a hidden sheet was selected opens on a sheet a person can see.
    const sheets = listSheets(model)
    const selected = model.getSelectedSheet()
    if (sheets[selected]?.hidden) {
      const visible = sheets.find((s) => !s.hidden)
      if (visible) model.setSelectedSheet(visible.index)
    }
    model.evaluate()
  }

  // ── Listening ────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  get dirty(): boolean {
    return this.dataVersion !== this.savedVersion
  }

  /** Whether the extras have changed since the last save (so the editor sends them). */
  get extrasDirty(): boolean {
    return this.extras !== this.savedExtras
  }

  /** The workbook and its extras as they are saved, and the version that save will have covered. */
  snapshot(): { workbook: string; extras: WorkbookExtras; version: number } {
    return { workbook: saveWorkbook(this.model), extras: this.extras, version: this.dataVersion }
  }

  markSaved(version: number, extras?: WorkbookExtras) {
    this.savedVersion = version
    if (extras) this.savedExtras = extras
    this.emit()
  }

  // ── Sheets ───────────────────────────────────────────────────────────────

  get sheet(): number {
    return this.model.getSelectedSheet()
  }

  sheets(): SheetInfo[] {
    return listSheets(this.model)
  }

  /** The stable id of a sheet by its index (extras refer to sheets by id, never index). */
  sheetIdAt(index = this.sheet): number {
    return this.sheets()[index]?.id ?? index
  }

  selectSheet(index: number): void {
    const sheets = this.sheets()
    if (!sheets[index] || sheets[index].hidden) return
    this.model.setSelectedSheet(index)
    this.emit()
  }

  addSheet(): ActionResult {
    if (this.sheets().length >= MAX_SHEETS) return no(`A workbook holds ${MAX_SHEETS} sheets at most.`)
    return this.act(() => {
      this.mut(() => this.model.newSheet())
      this.model.setSelectedSheet(this.sheets().length - 1)
    }, { structure: true })
  }

  renameSheet(index: number, name: string): ActionResult {
    const sheets = this.sheets()
    const target = sheets[index]
    if (!target) return no('That sheet is gone.')
    const next = name.trim()
    if (next === target.name) return OK
    const problem = sheetNameProblem(next, sheets.filter((s) => s.index !== index).map((s) => s.name))
    if (problem) return no(problem)
    return this.act(() => this.mut(() => this.model.renameSheet(index, next)), { structure: true })
  }

  deleteSheet(index: number): ActionResult {
    const sheets = this.sheets()
    if (!sheets[index]) return no('That sheet is gone.')
    if (sheets.filter((s) => !s.hidden && s.index !== index).length === 0) {
      return no('A workbook keeps at least one sheet.')
    }
    const sheetId = this.sheetIdAt(index)
    return this.act(() => {
      this.mut(() => this.model.deleteSheet(index))
      this.extras = shiftExtras(this.extras, { type: 'deleteSheet', sheetId })
      const left = this.sheets()
      const stay = Math.min(index, left.length - 1)
      const visible = left[stay] && !left[stay].hidden ? stay : (left.find((s) => !s.hidden)?.index ?? 0)
      this.model.setSelectedSheet(visible)
    }, { structure: true })
  }

  duplicateSheet(index: number): ActionResult {
    const sheets = this.sheets()
    if (!sheets[index]) return no('That sheet is gone.')
    if (sheets.length >= MAX_SHEETS) return no(`A workbook holds ${MAX_SHEETS} sheets at most.`)
    const fromId = this.sheetIdAt(index)
    return this.act(() => {
      this.mut(() => this.model.duplicateSheet(index))
      const copy = Math.min(index + 1, this.sheets().length - 1)
      const toId = this.sheetIdAt(copy)
      this.extras = shiftExtras(this.extras, { type: 'duplicateSheet', fromId, toId })
      this.model.setSelectedSheet(copy)
    }, { structure: true })
  }

  /** Move a sheet to another place in the tab strip (0-based). */
  moveSheet(index: number, to: number): ActionResult {
    const count = this.sheets().length
    const target = Math.max(0, Math.min(count - 1, to))
    if (index < 0 || index >= count || target === index) return OK
    const selectedId = this.sheets()[this.sheet]?.id
    return this.act(() => {
      this.mut(() => this.model.moveSheet(index, target))
      const again = this.sheets().find((s) => s.id === selectedId)
      if (again) this.model.setSelectedSheet(again.index)
    }, { structure: true })
  }

  // ── How far the grid reaches ─────────────────────────────────────────────

  private extent(sheet: number): { rows: number; columns: number } {
    let extent = this.extents.get(sheet)
    if (!extent) {
      const used = usedRange(this.model, sheet)
      extent = {
        rows: Math.min(MAX_ROWS, Math.max(START_ROWS, (used?.r2 ?? 0) + 50)),
        columns: Math.min(MAX_COLUMNS, Math.max(START_COLUMNS, (used?.c2 ?? 0) + 5)),
      }
      this.extents.set(sheet, extent)
    }
    return extent
  }

  /** Make the grid reach a cell (typing or moving past the end grows it). */
  private reach(sheet: number, row: number, column: number): boolean {
    const extent = this.extent(sheet)
    let grew = false
    if (row > extent.rows - 2 && extent.rows < MAX_ROWS) {
      extent.rows = Math.min(MAX_ROWS, Math.max(row + 2, extent.rows) + GROW_ROWS)
      grew = true
    }
    if (column > extent.columns - 1 && extent.columns < MAX_COLUMNS) {
      extent.columns = Math.min(MAX_COLUMNS, Math.max(column + 1, extent.columns) + GROW_COLUMNS)
      grew = true
    }
    if (grew) this.layoutVersion += 1
    return grew
  }

  /** Scrolling to the bottom or the right edge asks for more grid. */
  growBy(rows: number, columns: number): void {
    const extent = this.extent(this.sheet)
    const before = `${extent.rows}:${extent.columns}`
    extent.rows = Math.min(MAX_ROWS, extent.rows + Math.max(0, rows))
    extent.columns = Math.min(MAX_COLUMNS, extent.columns + Math.max(0, columns))
    if (before !== `${extent.rows}:${extent.columns}`) {
      this.layoutVersion += 1
      this.emit()
    }
  }

  layout(sheet = this.sheet): SheetLayout {
    const cached = this.layouts.get(sheet)
    if (cached && cached.at === this.layoutVersion) return cached.layout
    const { rows, columns } = this.extent(sheet)
    const rowStarts = new Float64Array(rows + 1)
    for (let r = 1; r <= rows; r++) rowStarts[r] = rowStarts[r - 1] + this.model.getRowHeight(sheet, r)
    const columnStarts = new Float64Array(columns + 1)
    for (let c = 1; c <= columns; c++) columnStarts[c] = columnStarts[c - 1] + this.model.getColumnWidth(sheet, c)
    const layout = { rows, columns, rowStarts, columnStarts }
    this.layouts.set(sheet, { at: this.layoutVersion, layout })
    return layout
  }

  // ── Selection ────────────────────────────────────────────────────────────

  selection(): Selection {
    const view = this.model.getSelectedView()
    const [a, b, c, d] = view.range
    return {
      row: view.row,
      column: view.column,
      range: { r1: Math.min(a, c), c1: Math.min(b, d), r2: Math.max(a, c), c2: Math.max(b, d) },
    }
  }

  private clampCell(row: number, column: number): CellRef {
    return {
      row: Math.max(1, Math.min(MAX_ROWS, Math.round(row))),
      column: Math.max(1, Math.min(MAX_COLUMNS, Math.round(column))),
    }
  }

  select(row: number, column: number): void {
    const cell = this.clampCell(row, column)
    this.reach(this.sheet, cell.row, cell.column)
    this.model.setSelectedCell(cell.row, cell.column)
    this.emit()
  }

  /** Stretch the selection from the active cell to this one (shift-click, a drag). */
  extendTo(row: number, column: number): void {
    const cell = this.clampCell(row, column)
    this.reach(this.sheet, cell.row, cell.column)
    this.model.onAreaSelecting(cell.row, cell.column)
    this.emit()
  }

  selectRange(range: CellRange, active?: CellRef): void {
    const r1 = Math.max(1, Math.min(MAX_ROWS, range.r1))
    const r2 = Math.max(1, Math.min(MAX_ROWS, range.r2))
    const c1 = Math.max(1, Math.min(MAX_COLUMNS, range.c1))
    const c2 = Math.max(1, Math.min(MAX_COLUMNS, range.c2))
    const cell = active ?? { row: r1, column: c1 }
    this.model.setSelectedCell(cell.row, cell.column)
    this.model.setSelectedRange(r1, c1, r2, c2)
    this.emit()
  }

  selectRows(from: number, to = from): void {
    const { columns } = this.extent(this.sheet)
    this.selectRange({ r1: Math.min(from, to), c1: 1, r2: Math.max(from, to), c2: Math.max(columns, 1) }, { row: from, column: 1 })
  }

  selectColumns(from: number, to = from): void {
    const { rows } = this.extent(this.sheet)
    this.selectRange({ r1: 1, c1: Math.min(from, to), r2: Math.max(rows, 1), c2: Math.max(from, to) }, { row: 1, column: from })
  }

  selectAll(): void {
    const { rows, columns } = this.extent(this.sheet)
    const { row, column } = this.selection()
    this.selectRange({ r1: 1, c1: 1, r2: rows, c2: columns }, { row, column })
  }

  /** Whole rows (or columns) are selected when the range spans the grid's width (or height). */
  selectedBand(): { rows: boolean; columns: boolean } {
    const { range } = this.selection()
    const { rows, columns } = this.extent(this.sheet)
    return { rows: range.c1 === 1 && range.c2 >= columns, columns: range.r1 === 1 && range.r2 >= rows }
  }

  /**
   * An arrow key. `extend` stretches the selection (Shift), `edge` jumps to
   * the edge of the filled block (Ctrl or Cmd), as in Excel.
   */
  move(direction: Direction, options: { extend?: boolean; edge?: boolean } = {}): void {
    const key = ARROW[direction]
    const before = this.selection()
    try {
      if (options.extend && options.edge) {
        // The engine has no "extend to the edge": find the edge, then stretch to it.
        const anchor = this.anchorOf(before)
        const focus = this.focusOf(before)
        this.model.setSelectedCell(focus.row, focus.column)
        this.model.onNavigateToEdgeInDirection(key)
        const edge = this.clampToExtent(this.selection())
        this.model.setSelectedCell(anchor.row, anchor.column)
        this.model.onAreaSelecting(edge.row, edge.column)
      } else if (options.extend) {
        this.model.onExpandSelectedRange(key)
      } else if (options.edge) {
        this.model.onNavigateToEdgeInDirection(key)
        const at = this.clampToExtent(this.selection())
        this.model.setSelectedCell(at.row, at.column)
      } else if (direction === 'up') this.model.onArrowUp()
      else if (direction === 'down') this.model.onArrowDown()
      else if (direction === 'left') this.model.onArrowLeft()
      else this.model.onArrowRight()
    } catch {
      // At the grid's edge the engine refuses; the selection stays.
    }
    const after = this.selection()
    if (after.row > MAX_ROWS || after.range.r2 > MAX_ROWS) {
      this.model.setSelectedCell(Math.min(after.row, MAX_ROWS), after.column)
    }
    const focus = this.focusOf(this.selection())
    this.reach(this.sheet, focus.row, focus.column)
    this.emit()
  }

  /** A jump to the edge of an empty run lands on the last cell the grid shows, not row 1,048,576. */
  private clampToExtent(at: Selection): CellRef {
    const { rows, columns } = this.extent(this.sheet)
    return { row: Math.min(at.row, rows), column: Math.min(at.column, columns) }
  }

  /** The corner of the range that is the active cell. */
  private anchorOf(selection: Selection): CellRef {
    return { row: selection.row, column: selection.column }
  }

  /** The corner opposite the active cell: the one Shift+arrow moves. */
  focusOf(selection: Selection): CellRef {
    const { range, row, column } = selection
    return { row: row === range.r1 ? range.r2 : range.r1, column: column === range.c1 ? range.c2 : range.c1 }
  }

  // ── Reading cells ────────────────────────────────────────────────────────

  input(row: number, column: number, sheet = this.sheet): string {
    return this.model.getCellContent(sheet, row, column)
  }

  text(row: number, column: number, sheet = this.sheet): string {
    return this.model.getFormattedCellValue(sheet, row, column)
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  /**
   * Start typing in the active cell. `initial` (the key that was pressed)
   * replaces what is there; without it the cell's own input is the draft.
   */
  startEdit(options: { initial?: string; source?: 'cell' | 'bar' } = {}): boolean {
    if (this.readOnly) return false
    if (this.editing) return true
    const { row, column } = this.selection()
    const sheet = this.sheet
    this.editing = {
      sheet,
      row,
      column,
      draft: options.initial ?? this.input(row, column, sheet),
      source: options.source ?? 'cell',
    }
    this.emit()
    return true
  }

  setDraft(draft: string, source?: 'cell' | 'bar'): void {
    if (!this.editing) return
    this.editing = { ...this.editing, draft: draft.slice(0, MAX_CELL_CHARS), source: source ?? this.editing.source }
    this.emit()
  }

  cancelEdit(): void {
    if (!this.editing) return
    const { sheet } = this.editing
    this.editing = null
    // Pointing at another sheet mid-formula leaves the view there; go back.
    if (this.sheet !== sheet) this.model.setSelectedSheet(sheet)
    this.emit()
  }

  /** Write the draft into its cell, then move (Enter: down, Tab: right). */
  commitEdit(move: Direction | null = null): ActionResult {
    const edit = this.editing
    if (!edit) return OK
    this.editing = null
    if (this.sheet !== edit.sheet) this.model.setSelectedSheet(edit.sheet)
    const unchanged = edit.draft === this.input(edit.row, edit.column, edit.sheet)
    const result = unchanged ? OK : this.setCell(edit.row, edit.column, edit.draft, edit.sheet)
    this.model.setSelectedCell(edit.row, edit.column)
    if (move) this.move(move)
    else this.emit()
    return result
  }

  setCell(row: number, column: number, input: string, sheet = this.sheet): ActionResult {
    if (input.length > MAX_CELL_CHARS) return no(`A cell holds ${MAX_CELL_CHARS.toLocaleString('en-US')} characters at most.`)
    if (row > MAX_ROWS || column > MAX_COLUMNS) return no('That cell is past the edge of the sheet.')
    // A rejecting validation rule refuses a typed value that is not allowed; the cell keeps what it had.
    const refusal = this.typedValueRefusal(sheet, row, column, input)
    if (refusal) return no(refusal)
    this.reach(sheet, row, column)
    // A cell formatted as plain text keeps what is typed as text: a formula stays a formula's
    // words and 007 keeps its zeros (the engine's quote prefix, which a person can also type).
    const plain = input !== '' && !input.startsWith("'") && this.model.getCellStyle(sheet, row, column).style.num_fmt === PLAIN_TEXT
    const typed = plain ? `'${input}` : input
    return this.act(() => this.mut(() => this.model.setUserInput(sheet, row, column, typed)))
  }

  /** Delete or Backspace: the values go, the formats stay. */
  clearSelection(): ActionResult {
    const { range } = this.selection()
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.rangeClearContents(sheet, range.r1, range.c1, range.r2, range.c2)))
  }

  clearFormatting(): ActionResult {
    const { range } = this.selection()
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.rangeClearFormatting(sheet, range.r1, range.c1, range.r2, range.c2)), {
      layout: true,
    })
  }

  // ── History ──────────────────────────────────────────────────────────────

  canUndo(): boolean {
    return !this.readOnly && this.undoStack.length > 0
  }

  canRedo(): boolean {
    return !this.readOnly && this.redoStack.length > 0
  }

  undo(): ActionResult {
    if (!this.canUndo()) return OK
    const entry = this.undoStack.pop() as HistoryEntry
    for (let i = 0; i < entry.steps && this.model.canUndo(); i++) this.model.undo()
    if (entry.extrasBefore) this.extras = entry.extrasBefore
    this.redoStack.push(entry)
    this.afterHistory()
    return OK
  }

  redo(): ActionResult {
    if (!this.canRedo()) return OK
    const entry = this.redoStack.pop() as HistoryEntry
    for (let i = 0; i < entry.steps && this.model.canRedo(); i++) this.model.redo()
    if (entry.extrasAfter) this.extras = entry.extrasAfter
    this.undoStack.push(entry)
    this.afterHistory()
    return OK
  }

  private afterHistory() {
    this.model.evaluate()
    const sheets = this.sheets()
    if (!sheets[this.sheet] || sheets[this.sheet].hidden) {
      this.model.setSelectedSheet(sheets.find((s) => !s.hidden)?.index ?? 0)
    }
    this.extents.clear()
    this.layoutVersion += 1
    this.dataVersion += 1
    this.emit()
  }

  /** One engine call that changes the workbook: one step of its history. */
  private mut(change: () => void) {
    change()
    this.steps += 1
  }

  /**
   * One action of a person's: everything in `run` is one step of Undo. A
   * failure part-way takes back what was done, so an action is all or nothing.
   */
  private act(run: () => void, options: { layout?: boolean; structure?: boolean } = {}): ActionResult {
    if (this.readOnly) return no('You can view this spreadsheet but not change it.')
    const outer = this.steps
    this.steps = 0
    const extrasBefore = this.extras
    let failure: string | null = null
    this.model.pauseEvaluation()
    try {
      run()
    } catch (error) {
      failure = engineMessage(error, 'That change could not be made.')
      for (let i = 0; i < this.steps && this.model.canUndo(); i++) this.model.undo()
      this.steps = 0
      this.extras = extrasBefore
    } finally {
      this.model.resumeEvaluation()
    }
    const made = this.steps
    this.steps = outer
    if (failure !== null) {
      this.model.evaluate()
      this.emit()
      return no(failure)
    }
    const extrasChanged = this.extras !== extrasBefore
    if (made > 0 || extrasChanged) {
      this.undoStack.push({ steps: made, extrasBefore: extrasChanged ? extrasBefore : null, extrasAfter: extrasChanged ? this.extras : null })
      this.redoStack = []
      this.dataVersion += 1
    }
    this.model.evaluate()
    if (options.structure) this.extents.clear()
    // Any edit can change a row's height (wrapped text) or a column's width.
    this.layoutVersion += 1
    this.emit()
    return OK
  }

  // ── Rows and columns ─────────────────────────────────────────────────────

  insertRows(at: number, count = 1): ActionResult {
    if (count < 1) return OK
    const extent = this.extent(this.sheet)
    if (extent.rows + count > MAX_ROWS) return no(`A sheet holds ${MAX_ROWS.toLocaleString('en-US')} rows at most.`)
    const sheet = this.sheet
    const sheetId = this.sheetIdAt(sheet)
    return this.act(() => {
      this.mut(() => this.model.insertRows(sheet, at, count))
      this.extras = shiftExtras(this.extras, { type: 'insertRows', sheetId, at, count })
    }, { structure: true })
  }

  insertColumns(at: number, count = 1): ActionResult {
    if (count < 1) return OK
    const extent = this.extent(this.sheet)
    if (extent.columns + count > MAX_COLUMNS) return no(`A sheet holds ${MAX_COLUMNS.toLocaleString('en-US')} columns at most.`)
    const sheet = this.sheet
    const sheetId = this.sheetIdAt(sheet)
    return this.act(() => {
      this.mut(() => this.model.insertColumns(sheet, at, count))
      this.extras = shiftExtras(this.extras, { type: 'insertColumns', sheetId, at, count })
    }, { structure: true })
  }

  deleteRows(at: number, count = 1): ActionResult {
    if (count < 1) return OK
    const sheet = this.sheet
    const sheetId = this.sheetIdAt(sheet)
    return this.act(() => {
      this.mut(() => this.model.deleteRows(sheet, at, count))
      this.extras = shiftExtras(this.extras, { type: 'deleteRows', sheetId, at, count })
    }, { structure: true })
  }

  deleteColumns(at: number, count = 1): ActionResult {
    if (count < 1) return OK
    const sheet = this.sheet
    const sheetId = this.sheetIdAt(sheet)
    return this.act(() => {
      this.mut(() => this.model.deleteColumns(sheet, at, count))
      this.extras = shiftExtras(this.extras, { type: 'deleteColumns', sheetId, at, count })
    }, { structure: true })
  }

  setColumnWidth(from: number, to: number, width: number): ActionResult {
    const px = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)))
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.setColumnsWidth(sheet, Math.min(from, to), Math.max(from, to), px)))
  }

  setRowHeight(from: number, to: number, height: number): ActionResult {
    const px = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(height)))
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.setRowsHeight(sheet, Math.min(from, to), Math.max(from, to), px)))
  }

  hideRows(from: number, to = from): ActionResult {
    const sheet = this.sheet
    const layout = this.layout(sheet)
    let visible = 0
    for (let r = 1; r <= layout.rows; r++) {
      if ((r < from || r > to) && layout.rowStarts[r] > layout.rowStarts[r - 1]) visible += 1
    }
    if (!visible) return no('A sheet keeps at least one row in view.')
    return this.act(() => {
      this.mut(() => this.model.setRowsHidden(sheet, from, to, true))
      const next = to + 1 <= layout.rows ? to + 1 : Math.max(1, from - 1)
      this.model.setSelectedCell(next, this.selection().column)
    })
  }

  hideColumns(from: number, to = from): ActionResult {
    const sheet = this.sheet
    const layout = this.layout(sheet)
    let visible = 0
    for (let c = 1; c <= layout.columns; c++) {
      if ((c < from || c > to) && layout.columnStarts[c] > layout.columnStarts[c - 1]) visible += 1
    }
    if (!visible) return no('A sheet keeps at least one column in view.')
    return this.act(() => {
      this.mut(() => this.model.setColumnsHidden(sheet, from, to, true))
      const next = to + 1 <= layout.columns ? to + 1 : Math.max(1, from - 1)
      this.model.setSelectedCell(this.selection().row, next)
    })
  }

  hiddenRows(sheet = this.sheet): number[] {
    const layout = this.layout(sheet)
    const out: number[] = []
    for (let r = 1; r <= layout.rows; r++) if (layout.rowStarts[r] === layout.rowStarts[r - 1]) out.push(r)
    return out
  }

  hiddenColumns(sheet = this.sheet): number[] {
    const layout = this.layout(sheet)
    const out: number[] = []
    for (let c = 1; c <= layout.columns; c++) if (layout.columnStarts[c] === layout.columnStarts[c - 1]) out.push(c)
    return out
  }

  unhideAllRows(): ActionResult {
    const sheet = this.sheet
    const { rows } = this.extent(sheet)
    if (!this.hiddenRows(sheet).length) return OK
    return this.act(() => this.mut(() => this.model.setRowsHidden(sheet, 1, rows, false)))
  }

  unhideAllColumns(): ActionResult {
    const sheet = this.sheet
    const { columns } = this.extent(sheet)
    if (!this.hiddenColumns(sheet).length) return OK
    return this.act(() => this.mut(() => this.model.setColumnsHidden(sheet, 1, columns, false)))
  }

  /**
   * Fit columns to what they hold. `measure` says how wide a cell's text
   * draws (the grid measures with the cell's own font); only filled cells
   * are looked at, and a column with nothing in it is left as it is.
   */
  fitColumns(from: number, to: number, measure: (text: string, row: number, column: number) => number): ActionResult {
    const sheet = this.sheet
    const used = usedRange(this.model, sheet)
    if (!used) return OK
    const widths = new Map<number, number>()
    for (let row = used.r1; row <= used.r2; row++) {
      for (const column of this.model.getColumnsWithData(sheet, row)) {
        if (column < from || column > to) continue
        const text = this.model.getFormattedCellValue(sheet, row, column)
        if (!text) continue
        const width = measure(text, row, column)
        if (width > (widths.get(column) ?? 0)) widths.set(column, width)
      }
    }
    if (!widths.size) return OK
    return this.act(() => {
      for (const [column, width] of widths) {
        const px = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.ceil(width)))
        this.mut(() => this.model.setColumnsWidth(sheet, column, column, px))
      }
    })
  }

  // ── Fill ─────────────────────────────────────────────────────────────────

  /**
   * Drag the fill handle from the selection to `target`: down or up when the
   * target is further off vertically, right or left otherwise. Formulas shift;
   * a run of numbers or dates continues.
   */
  fillTo(target: CellRef): ActionResult {
    const { range, row, column } = this.selection()
    const sheet = this.sheet
    const down = target.row > range.r2 ? target.row - range.r2 : 0
    const up = target.row < range.r1 ? range.r1 - target.row : 0
    const right = target.column > range.c2 ? target.column - range.c2 : 0
    const left = target.column < range.c1 ? range.c1 - target.column : 0
    const vertical = Math.max(down, up)
    const horizontal = Math.max(right, left)
    if (!vertical && !horizontal) return OK
    const source = area(sheet, range)
    if (vertical >= horizontal) {
      const to = Math.max(1, Math.min(MAX_ROWS, target.row))
      this.reach(sheet, to, range.c2)
      return this.act(() => {
        this.mut(() => this.model.autoFillRows(source, to))
        const refusal = this.rangeValueRefusal(sheet, { r1: Math.min(range.r1, to), c1: range.c1, r2: Math.max(range.r2, to), c2: range.c2 })
        if (refusal) throw new Error(refusal)
        this.model.setSelectedCell(row, column)
        this.model.setSelectedRange(Math.min(range.r1, to), range.c1, Math.max(range.r2, to), range.c2)
      })
    }
    const to = Math.max(1, Math.min(MAX_COLUMNS, target.column))
    this.reach(sheet, range.r2, to)
    return this.act(() => {
      this.mut(() => this.model.autoFillColumns(source, to))
      const refusal = this.rangeValueRefusal(sheet, { r1: range.r1, c1: Math.min(range.c1, to), r2: range.r2, c2: Math.max(range.c2, to) })
      if (refusal) throw new Error(refusal)
      this.model.setSelectedCell(row, column)
      this.model.setSelectedRange(range.r1, Math.min(range.c1, to), range.r2, Math.max(range.c2, to))
    })
  }

  /** Ctrl/Cmd+D: the selection's top row, repeated down it. */
  fillDown(): ActionResult {
    const { range, row, column } = this.selection()
    if (range.r1 === range.r2) return OK
    const sheet = this.sheet
    return this.act(() => {
      this.mut(() => this.model.autoFillRows(area(sheet, { ...range, r2: range.r1 }), range.r2))
      this.model.setSelectedCell(row, column)
      this.model.setSelectedRange(range.r1, range.c1, range.r2, range.c2)
    })
  }

  /** Ctrl/Cmd+R: the selection's left column, repeated across it. */
  fillRight(): ActionResult {
    const { range, row, column } = this.selection()
    if (range.c1 === range.c2) return OK
    const sheet = this.sheet
    return this.act(() => {
      this.mut(() => this.model.autoFillColumns(area(sheet, { ...range, c2: range.c1 }), range.c2))
      this.model.setSelectedCell(row, column)
      this.model.setSelectedRange(range.r1, range.c1, range.r2, range.c2)
    })
  }

  // ── Clipboard ────────────────────────────────────────────────────────────

  /**
   * What Copy puts on the clipboard: tab-separated text (what Excel and
   * Google Sheets read) and the engine's own copy, which Paste in this app
   * uses to keep formats and shift formulas.
   */
  copy(): { text: string; internal: InternalClipboard } {
    const sheet = this.sheet
    const clip = this.model.copyToClipboard()
    return { text: clip.csv, internal: { sheet, range: clip.range, data: clip.data, text: clip.csv } }
  }

  /** Paste this app's own copy at the active cell. `cut` empties where it came from. */
  pasteInternal(clip: InternalClipboard, options: { cut?: boolean } = {}): ActionResult {
    const { row, column } = this.selection()
    const [r1, c1, r2, c2] = clip.range
    const height = Math.abs(r2 - r1) + 1
    const width = Math.abs(c2 - c1) + 1
    if (row + height - 1 > MAX_ROWS || column + width - 1 > MAX_COLUMNS) return no('That does not fit: it runs past the edge of the sheet.')
    this.reach(this.sheet, row + height - 1, column + width - 1)
    const sheet = this.sheet
    return this.act(() => {
      this.mut(() => this.model.pasteFromClipboard(clip.sheet, clip.range, clip.data, options.cut ?? false))
      const refusal = this.rangeValueRefusal(sheet, { r1: row, c1: column, r2: row + height - 1, c2: column + width - 1 })
      if (refusal) throw new Error(refusal)
      this.model.setSelectedCell(row, column)
      this.model.setSelectedRange(row, column, row + height - 1, column + width - 1)
    }, { layout: true })
  }

  /**
   * Paste rows of plain values at the active cell (from another app, or
   * "Paste values only"). One row or one cell pasted over a larger selection
   * repeats to fill it, as spreadsheets do.
   */
  pasteValues(block: readonly (readonly string[])[]): ActionResult {
    const rows = block.length
    const columns = rows ? Math.max(...block.map((r) => r.length)) : 0
    if (!rows || !columns) return OK
    const { range, row, column } = this.selection()
    const sheet = this.sheet
    // A 1 x 1 or 1 x n block tiles across a selection that is a multiple of it.
    const selRows = range.r2 - range.r1 + 1
    const selColumns = range.c2 - range.c1 + 1
    const tile = selRows % rows === 0 && selColumns % columns === 0 && (selRows > rows || selColumns > columns)
    const outRows = tile ? selRows : rows
    const outColumns = tile ? selColumns : columns
    const top = tile ? range.r1 : row
    const left = tile ? range.c1 : column
    if (top + outRows - 1 > MAX_ROWS || left + outColumns - 1 > MAX_COLUMNS) return no('That does not fit: it runs past the edge of the sheet.')
    if (outRows * outColumns > 500_000) return no('That is more than can be pasted at once.')
    for (const line of block) for (const value of line) if (value.length > MAX_CELL_CHARS) return no(`A cell holds ${MAX_CELL_CHARS.toLocaleString('en-US')} characters at most.`)
    // A rejecting rule refuses the whole paste, naming the first bad cell.
    for (let r = 0; r < outRows; r++) {
      for (let c = 0; c < outColumns; c++) {
        const value = block[r % rows][c % columns] ?? ''
        if (value === '') continue
        const refusal = this.typedValueRefusal(sheet, top + r, left + c, value)
        if (refusal) return no(refusal)
      }
    }
    this.reach(sheet, top + outRows - 1, left + outColumns - 1)
    return this.act(() => {
      for (let r = 0; r < outRows; r++) {
        const line = block[r % rows]
        for (let c = 0; c < outColumns; c++) {
          const value = line[c % columns] ?? ''
          const at = { row: top + r, column: left + c }
          if (value === '' && this.model.getCellContent(sheet, at.row, at.column) === '') continue
          this.mut(() => this.model.setUserInput(sheet, at.row, at.column, value))
        }
      }
      this.model.setSelectedCell(top, left)
      this.model.setSelectedRange(top, left, top + outRows - 1, left + outColumns - 1)
    })
  }

  /** The selection's shown values as rows of text (Copy for other apps, "values only"). */
  selectionValues(limit = 500_000): string[][] | null {
    const { range } = this.selection()
    const sheet = this.sheet
    const used = usedRange(this.model, sheet)
    const r2 = Math.min(range.r2, Math.max(used?.r2 ?? range.r1, range.r1))
    const c2 = Math.min(range.c2, Math.max(used?.c2 ?? range.c1, range.c1))
    if (rangeCellCount({ ...range, r2, c2 }) > limit) return null
    const out: string[][] = []
    for (let r = range.r1; r <= r2; r++) {
      const line: string[] = []
      for (let c = range.c1; c <= c2; c++) line.push(this.model.getFormattedCellValue(sheet, r, c))
      out.push(line)
    }
    return out
  }

  // ── Formats ──────────────────────────────────────────────────────────────

  style(row: number, column: number, sheet = this.sheet): CellStyle {
    return this.model.getCellStyle(sheet, row, column).style
  }

  /** Set one part of the style on the whole selection (the engine's paths: `font.b`, `num_fmt`, `fill.fg_color`…). */
  setStyle(path: string, value: string): ActionResult {
    const { range } = this.selection()
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.updateRangeStyle(area(sheet, range), path, value)), { layout: true })
  }

  /** The format code of the active cell: what the toolbar shows and steps from. */
  numberFormat(): string {
    const { row, column } = this.selection()
    return this.style(row, column).num_fmt || GENERAL
  }

  setNumberFormat(code: string): ActionResult {
    return this.setStyle('num_fmt', code || GENERAL)
  }

  /** More or fewer decimal places, from the active cell's format, on the whole selection. */
  changeDecimals(delta: number): ActionResult {
    const { row, column } = this.selection()
    const next = changeDecimals(this.numberFormat(), delta, this.text(row, column))
    return next === this.numberFormat() ? OK : this.setStyle('num_fmt', next)
  }

  setFontSize(points: number): ActionResult {
    return this.setStyle('font.size', String(clampFontSize(points)))
  }

  /** One step larger or smaller, from the active cell's size. */
  stepFontSize(direction: 1 | -1): ActionResult {
    const { row, column } = this.selection()
    const now = this.style(row, column).font?.sz ?? DEFAULT_FONT_POINTS
    return this.setFontSize(clampFontSize(now + direction))
  }

  /**
   * The font of the selection. The engine has no path for a font's name, so
   * each cell's whole style is read, given the name and written back in one
   * step; a selection is cut to what the sheet uses, and to 50,000 cells.
   */
  setFontFamily(name: string): ActionResult {
    const sheet = this.sheet
    const { range, row, column } = this.selection()
    const used = usedRange(this.model, sheet)
    const r2 = Math.min(range.r2, Math.max(used?.r2 ?? range.r1, range.r1))
    const c2 = Math.min(range.c2, Math.max(used?.c2 ?? range.c1, range.c1))
    if (rangeCellCount({ ...range, r2, c2 }) > 50_000) return no('That is too many cells to restyle at once.')
    const styles: CellStyle[][] = []
    for (let r = range.r1; r <= r2; r++) {
      const line: CellStyle[] = []
      for (let c = range.c1; c <= c2; c++) {
        const style = this.model.getCellStyle(sheet, r, c).style
        line.push({ ...style, font: { ...style.font, name } })
      }
      styles.push(line)
    }
    return this.act(() => {
      this.model.setSelectedCell(range.r1, range.c1)
      this.model.setSelectedRange(range.r1, range.c1, r2, c2)
      this.mut(() => this.model.onPasteStyles(styles))
      this.model.setSelectedCell(row, column)
      this.model.setSelectedRange(range.r1, range.c1, range.r2, range.c2)
    })
  }

  /** Borders on the selection: all, inner, outer, one edge, or none. */
  setBorders(type: BorderKind, options: { style?: 'thin' | 'medium' | 'thick' | 'dotted' | 'double'; color?: string } = {}): ActionResult {
    const { range } = this.selection()
    const sheet = this.sheet
    const border = { item: { style: options.style ?? 'thin', color: options.color ?? '#000000' }, type } as unknown as BorderArea
    return this.act(() => this.mut(() => this.model.setAreaWithBorder(area(sheet, range), border)))
  }

  /** Whether the sheet's grid lines are drawn (kept with the workbook). */
  showGridLines(sheet = this.sheet): boolean {
    return this.model.getShowGridLines(sheet)
  }

  setShowGridLines(show: boolean): ActionResult {
    const sheet = this.sheet
    if (this.showGridLines(sheet) === show) return OK
    return this.act(() => this.mut(() => this.model.setShowGridLines(sheet, show)))
  }

  /** Spaces at the ends of the selection's text cells go, and runs of spaces inside become one. Formulas are left alone. */
  trimWhitespace(): ActionResult & { trimmed?: number } {
    const sheet = this.sheet
    const { range } = this.selection()
    const used = usedRange(this.model, sheet)
    if (!used) return { ok: true, trimmed: 0 }
    let trimmed = 0
    const result = this.act(() => {
      for (let row = Math.max(range.r1, used.r1); row <= Math.min(range.r2, used.r2); row++) {
        for (const column of this.model.getColumnsWithData(sheet, row)) {
          if (column < range.c1 || column > range.c2) continue
          const before = this.model.getCellContent(sheet, row, column)
          if (before.startsWith('=')) continue
          const after = before.replace(/[ \t ]+/g, ' ').trim()
          if (after === before) continue
          this.mut(() => this.model.setUserInput(sheet, row, column, after))
          trimmed += 1
        }
      }
    })
    return result.ok ? { ok: true, trimmed } : result
  }

  /** Put a function over the selection's numbers into the cell under them (or beside a single row). */
  insertFunction(name: string): ActionResult {
    const { range, row, column } = this.selection()
    const single = range.r1 === range.r2 && range.c1 === range.c2
    if (single) {
      // On one cell: start the formula and let the person point at its range.
      if (!this.startEdit({ initial: `=${name}(` })) return no('You can view this spreadsheet but not change it.')
      return OK
    }
    const sheet = this.sheet
    const across = range.r1 === range.r2
    return this.act(() => {
      if (across) {
        const target = range.c2 + 1
        this.mut(() => this.model.setUserInput(sheet, range.r1, target, `=${name}(${cellName(range.r1, range.c1)}:${cellName(range.r1, range.c2)})`))
      } else {
        for (let c = range.c1; c <= range.c2; c++) {
          this.mut(() => this.model.setUserInput(sheet, range.r2 + 1, c, `=${name}(${cellName(range.r1, c)}:${cellName(range.r2, c)})`))
        }
      }
      this.model.setSelectedCell(row, column)
      this.model.setSelectedRange(range.r1, range.c1, range.r2, range.c2)
    })
  }

  // ── Sort ─────────────────────────────────────────────────────────────────

  /**
   * Sort the selection's rows by one of its columns. Whole rows of the
   * selection move together; numbers come before text, blanks last, as in
   * Excel. Formulas are moved as typed (their references are not rewritten).
   */
  sortRange(byColumn: number, descending = false): ActionResult {
    const { range } = this.selection()
    const sheet = this.sheet
    if (range.r1 === range.r2) return OK
    const used = usedRange(this.model, sheet)
    if (!used) return OK
    const r2 = Math.min(range.r2, used.r2)
    if (r2 <= range.r1) return OK
    const c2 = Math.min(range.c2, Math.max(used.c2, range.c1))
    const key = Math.max(range.c1, Math.min(c2, byColumn))
    type Line = { inputs: string[]; kind: number; number: number; text: string }
    const lines: Line[] = []
    for (let r = range.r1; r <= r2; r++) {
      const inputs: string[] = []
      for (let c = range.c1; c <= c2; c++) inputs.push(this.model.getCellContent(sheet, r, c))
      const shown = this.model.getFormattedCellValue(sheet, r, key)
      const type = this.model.getCellType(sheet, r, key)
      const raw = this.model.getCellContent(sheet, r, key)
      const blank = shown === '' && raw === ''
      const numeric = !blank && type === CELL_TYPE.number
      const value = numeric ? Number(raw.startsWith('=') ? shown.replace(/[^0-9.eE+-]/g, '') : raw) : NaN
      lines.push({
        inputs,
        kind: blank ? 3 : numeric && Number.isFinite(value) ? 0 : type === CELL_TYPE.boolean ? 2 : 1,
        number: value,
        text: shown.toLowerCase(),
      })
    }
    const sign = descending ? -1 : 1
    const sorted = lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) => {
        // Blanks stay at the bottom whichever way the sort runs.
        if (a.line.kind === 3 || b.line.kind === 3) return a.line.kind === b.line.kind ? a.index - b.index : a.line.kind === 3 ? 1 : -1
        if (a.line.kind !== b.line.kind) return sign * (a.line.kind - b.line.kind)
        const order = a.line.kind === 0 ? a.line.number - b.line.number : a.line.text < b.line.text ? -1 : a.line.text > b.line.text ? 1 : 0
        return order ? sign * order : a.index - b.index
      })
    if (sorted.every((entry, index) => entry.index === index)) return OK
    return this.act(() => {
      sorted.forEach((entry, offset) => {
        if (entry.index === offset) return
        entry.line.inputs.forEach((input, i) => {
          const row = range.r1 + offset
          const column = range.c1 + i
          if (this.model.getCellContent(sheet, row, column) === input) return
          this.mut(() => this.model.setUserInput(sheet, row, column, input))
        })
      })
    })
  }

  // ── Find ─────────────────────────────────────────────────────────────────

  /** Every cell of the sheet whose shown text (or formula, with `formulas`) holds `query`, in reading order. */
  find(query: string, options: { matchCase?: boolean; formulas?: boolean; wholeCell?: boolean } = {}, sheet = this.sheet): CellRef[] {
    if (!query) return []
    const used = usedRange(this.model, sheet)
    if (!used) return []
    const needle = options.matchCase ? query : query.toLowerCase()
    const out: CellRef[] = []
    for (let row = used.r1; row <= used.r2; row++) {
      for (const column of this.model.getColumnsWithData(sheet, row)) {
        const raw = options.formulas ? this.model.getCellContent(sheet, row, column) : this.model.getFormattedCellValue(sheet, row, column)
        const hay = options.matchCase ? raw : raw.toLowerCase()
        if (options.wholeCell ? hay === needle : hay.includes(needle)) out.push({ row, column })
        if (out.length >= 10_000) return out
      }
    }
    return out
  }

  /** Replace `query` in what was typed into these cells (a formula's text too). One step. */
  replace(cells: readonly CellRef[], query: string, replacement: string, options: { matchCase?: boolean; wholeCell?: boolean } = {}): ActionResult & { replaced?: number } {
    if (!query || !cells.length) return { ok: true, replaced: 0 }
    const sheet = this.sheet
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(options.wholeCell ? `^${escaped}$` : escaped, options.matchCase ? 'g' : 'gi')
    let replaced = 0
    const result = this.act(() => {
      for (const { row, column } of cells) {
        const before = this.model.getCellContent(sheet, row, column)
        const after = before.replace(pattern, () => replacement)
        if (after === before) continue
        if (after.length > MAX_CELL_CHARS) throw new Error(`A cell holds ${MAX_CELL_CHARS.toLocaleString('en-US')} characters at most.`)
        this.mut(() => this.model.setUserInput(sheet, row, column, after))
        replaced += 1
      }
    })
    return result.ok ? { ok: true, replaced } : result
  }

  /** The name of a range as the Go to box shows it: `B4`, or `B4:D9`. */
  selectionName(): string {
    const { row, column } = this.selection()
    return `${columnName(column)}${row}`
  }

  // ── Data validation ────────────────────────────────────────────────────────

  /** Every validation rule on a sheet (for an import, a test, or a panel). */
  validations(sheet = this.sheet): Validation[] {
    const id = this.sheetIdAt(sheet)
    return this.extras.validations.filter((v) => v.sheetId === id)
  }

  /** The values a list rule allows: its typed choices, or the live values of its source range. */
  private ruleChoices(rule: ValidationSpec): ValidationChoice[] {
    if (rule.type !== 'list') return []
    if (!rule.source) return rule.choices
    return this.sourceValues(rule.source).map((value) => ({ value }))
  }

  /** The distinct, non-empty values a source range (`Sheet1!A2:A20`) shows, in order. */
  private sourceValues(source: string): string[] {
    const parsed = parseSheetRange(source)
    if (!parsed) return []
    const sheets = this.sheets()
    const target = parsed.sheet ? sheets.find((s) => s.name.toLowerCase() === parsed.sheet!.toLowerCase()) : sheets[this.sheet]
    if (!target) return []
    const range = parsed.range
    const out: string[] = []
    const seen = new Set<string>()
    for (let r = range.r1; r <= Math.min(range.r2, range.r1 + 5000); r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        const text = this.model.getFormattedCellValue(target.index, r, c)
        if (text !== '' && !seen.has(text)) {
          seen.add(text)
          out.push(text)
        }
      }
    }
    return out
  }

  /** What a cell's validation lets a view draw (choices, a chip, a warning), or null. */
  validationView(row: number, column: number, sheet = this.sheet): ValidationView | null {
    const id = this.sheetIdAt(sheet)
    const found = validationAt(this.extras, id, row, column)
    if (!found) return null
    const choices = this.ruleChoices(found.rule)
    const value = this.text(row, column, sheet)
    const valid = this.valuePasses(found.rule, choices, value)
    const chip = found.rule.type === 'list' ? found.rule.choices.find((c) => c.color && c.value === value)?.color ?? null : null
    return { rule: found.rule, choices, isList: found.rule.type === 'list', chipColor: chip, warn: !found.rule.reject && value !== '' && !valid }
  }

  /** The choices for a cell's dropdown (value and chip color). Empty when the cell has no list rule. */
  listChoicesAt(row: number, column: number, sheet = this.sheet): ValidationChoice[] {
    const id = this.sheetIdAt(sheet)
    const found = validationAt(this.extras, id, row, column)
    return found && found.rule.type === 'list' ? this.ruleChoices(found.rule) : []
  }

  /** Whether a displayed value is allowed by a rule (an empty cell always is). */
  private valuePasses(rule: ValidationSpec, choices: ValidationChoice[], value: string): boolean {
    if (value === '') return true
    if (rule.type === 'list') return choices.some((c) => c.value === value)
    const quantity = rule.type === 'textLength' ? value.length : numericFrom(value)
    if (!Number.isFinite(quantity)) return false
    return passesBound(quantity, rule)
  }

  /** A refusal for a value TYPED into a cell under a rejecting rule, or null. Formulas are not pre-checked. */
  private typedValueRefusal(sheet: number, row: number, column: number, input: string): string | null {
    if (input === '' || input.startsWith('=') || input.startsWith("'")) return null
    const id = this.sheetIdAt(sheet)
    const found = validationAt(this.extras, id, row, column)
    if (!found || !found.rule.reject) return null
    const quantity = found.rule.type === 'textLength' ? input.length : found.rule.type !== 'list' ? numericFrom(input) : 0
    const ok = found.rule.type === 'list' ? this.ruleChoices(found.rule).some((c) => c.value === input) : Number.isFinite(quantity) && passesBound(quantity, found.rule)
    return ok ? null : `${cellName(row, column)} only takes ${describeValidation(found.rule)}.`
  }

  /** The first cell in a range whose current value a rejecting rule forbids (for a paste or a fill), or null. */
  private rangeValueRefusal(sheet: number, range: CellRange): string | null {
    const id = this.sheetIdAt(sheet)
    if (!this.extras.validations.some((v) => v.sheetId === id && v.rule.reject)) return null
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        const found = validationAt(this.extras, id, r, c)
        if (!found || !found.rule.reject) continue
        const value = this.text(r, c, sheet)
        if (!this.valuePasses(found.rule, this.ruleChoices(found.rule), value)) {
          return `${cellName(r, c)} only takes ${describeValidation(found.rule)}.`
        }
      }
    }
    return null
  }

  /** A list ("Dropdown…") rule on a range, carving it out of any rule it overlaps. */
  setListValidation(options: { range?: CellRange; choices?: ValidationChoice[]; source?: string; reject?: boolean }): ActionResult {
    const source = options.source?.trim()
    const choices = (options.choices ?? []).filter((c) => c.value.trim() !== '').map((c) => ({ value: c.value, ...(c.color ? { color: c.color } : {}) }))
    if (!source && choices.length === 0) return no('Type at least one choice, or give a source range.')
    if (source && !parseSheetRange(source)) return no(`"${source}" is not a range (e.g. Sheet1!A2:A20).`)
    const rule: ValidationSpec = { type: 'list', choices: source ? [] : choices, ...(source ? { source } : {}), reject: options.reject !== false }
    return this.setValidationRule(options.range ?? this.selection().range, rule)
  }

  /** Any validation rule on a range (list, number, date, text length). One undo step. */
  setValidationRule(range: CellRange, rule: ValidationSpec): ActionResult {
    const id = this.sheetIdAt(this.sheet)
    return this.act(() => {
      this.extras = putValidation(this.extras, id, { ...range }, rule)
    })
  }

  /** Remove validation from a range (Remove dropdown / clear validation). */
  clearValidation(range = this.selection().range): ActionResult {
    const id = this.sheetIdAt(this.sheet)
    if (!this.extras.validations.some((v) => v.sheetId === id && rangeCellCount({ r1: Math.max(v.range.r1, range.r1), c1: Math.max(v.range.c1, range.c1), r2: Math.min(v.range.r2, range.r2), c2: Math.min(v.range.c2, range.c2) }) > 0)) {
      return OK
    }
    return this.act(() => {
      this.extras = clearValidationIn(this.extras, id, range)
    })
  }

  /** Write a chosen value into a cell as one undo step (from the dropdown listbox). */
  chooseValue(row: number, column: number, value: string): ActionResult {
    return this.setCell(row, column, value)
  }

  // ── Checkboxes ───────────────────────────────────────────────────────────

  isCheckboxCell(row: number, column: number, sheet = this.sheet): boolean {
    return extrasIsCheckbox(this.extras, this.sheetIdAt(sheet), row, column)
  }

  /** Whether a checkbox cell shows as checked (its value is TRUE). */
  checkboxChecked(row: number, column: number, sheet = this.sheet): boolean {
    return this.model.getFormattedCellValue(sheet, row, column).toUpperCase() === 'TRUE'
  }

  /** Make the range's cells checkboxes; a blank becomes FALSE. One undo step. */
  insertCheckboxes(range = this.selection().range): ActionResult {
    if (rangeCellCount(range) > 50_000) return no('That is too many cells for checkboxes at once.')
    const sheet = this.sheet
    const id = this.sheetIdAt(sheet)
    return this.act(() => {
      for (let r = range.r1; r <= range.r2; r++) {
        for (let c = range.c1; c <= range.c2; c++) {
          if (this.model.getCellContent(sheet, r, c) === '') this.mut(() => this.model.setUserInput(sheet, r, c, 'FALSE'))
        }
      }
      this.extras = addCheckboxes(this.extras, id, { ...range })
    })
  }

  /** Stop the range's cells being checkboxes; their values stay. */
  removeCheckboxes(range = this.selection().range): ActionResult {
    const id = this.sheetIdAt(this.sheet)
    return this.act(() => {
      this.extras = removeCheckboxesIn(this.extras, id, range)
    })
  }

  /** Flip a checkbox between TRUE and FALSE as one undo step (a click, or Space). */
  toggleCheckbox(row: number, column: number): ActionResult {
    const sheet = this.sheet
    const now = this.checkboxChecked(row, column, sheet)
    return this.act(() => this.mut(() => this.model.setUserInput(sheet, row, column, now ? 'FALSE' : 'TRUE')))
  }

  // ── Conditional formatting ─────────────────────────────────────────────────
  // The engine evaluates these; the controller only wraps its calls so each is
  // one undo step. The winning rule's format is already in getCellStyle (drawn
  // by the grid); data bars and icon sets come back on getCellStyle too.

  /** The sheet's rules, in the engine's priority order; `index` addresses one in the other calls. */
  conditionalRules(sheet = this.sheet): ConditionalFormattingView[] {
    return this.model.getConditionalFormattingList(sheet)
  }

  addConditionalRule(range: CellRange, rule: CfRuleInput): ActionResult {
    const sheet = this.sheet
    const text = this.rangeAddress(range)
    return this.act(() => this.mut(() => this.model.addConditionalFormatting(sheet, text, rule)), { layout: true })
  }

  updateConditionalRule(index: number, range: CellRange, rule: CfRuleInput): ActionResult {
    const sheet = this.sheet
    const text = this.rangeAddress(range)
    return this.act(() => this.mut(() => this.model.updateConditionalFormatting(sheet, index, text, rule)), { layout: true })
  }

  deleteConditionalRule(index: number): ActionResult {
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.deleteConditionalFormatting(sheet, index)), { layout: true })
  }

  raiseConditionalRule(index: number): ActionResult {
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.raiseConditionalFormattingPriority(sheet, index)), { layout: true })
  }

  lowerConditionalRule(index: number): ActionResult {
    const sheet = this.sheet
    return this.act(() => this.mut(() => this.model.lowerConditionalFormattingPriority(sheet, index)), { layout: true })
  }

  /** `A1:C9`, or `A1` for a single cell (the string the engine's CF calls take). */
  private rangeAddress(range: CellRange): string {
    const a = cellName(range.r1, range.c1)
    const b = cellName(range.r2, range.c2)
    return a === b ? a : `${a}:${b}`
  }

  disposed = false

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.model.free()
  }
}

/** This app's own copy of a range: what Paste uses to keep formats and shift formulas. */
export interface InternalClipboard {
  sheet: number
  range: [number, number, number, number]
  data: ReturnType<Model['copyToClipboard']>['data']
  /** The text that went to the system clipboard with it: a paste whose text differs came from somewhere else. */
  text: string
}
