'use client'

/**
 * One table as an editable grid (Tables, phase 3): the general cell grid
 * (src/components/grid) with a cell for every field type (./cells.tsx), the
 * Name column (the row's title) sticky on the left, a + New row under the
 * last, a + header to add a column, and each column's menu: rename, change
 * type, sort, hide, delete. The columns shown, their order and widths, and
 * the sort are the open view's (phase 4): the rows come sorted from the
 * server, and a change here is the view's draft. A row opens as a record (the
 * page's row panel), and archives from there or from the right-click menu.
 * ⌘Z takes back this visit's latest change.
 *
 * A viewer who can't change the table gets the same grid read-only: select,
 * copy, sort and hide, nothing that writes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, EyeOff, Maximize2, Pencil, Plus, Shapes, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CellGrid, type CellGridApi, type GridColumn, type PasteTarget } from '@/components/grid/cell-grid'
import { selectionRange, type CellPos, type CellRange } from '@/components/grid/selection'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { CUSTOM_FIELD_TYPE_LABELS, type CustomFieldType } from '@/lib/crm/custom-field-types'
import { clipboardText, pastedValue, TITLE_KEY, type CellEdit } from '@/lib/tables/grid-edits'
import type { DataColumn, DataRow } from '@/lib/tables/types'
import { CellDisplay, CellEditor, ColumnLabel, type CellColumn } from './cells'
import { AddColumnForm, RenameDialog, TypeChangeDialog, type ColumnShape } from './column-forms'
import { cellId, type TableData } from './use-table-data'

export interface TableSort {
  key: string
  dir: 'asc' | 'desc'
}

const TITLE_COLUMN: CellColumn = { key: TITLE_KEY, label: 'Name', field_type: 'text', options: [] }

export const DEFAULT_WIDTH: Record<CustomFieldType, number> = {
  text: 200,
  number: 120,
  date: 130,
  select: 150,
  multi_select: 200,
  checkbox: 96,
  url: 200,
  email: 200,
  phone: 150,
  person: 160,
  currency: 130,
  relation: 200,
}

export const asCell = (c: DataColumn): CellColumn => ({ key: c.key, label: c.label, field_type: c.field_type, options: c.options ?? [], config: c.config ?? {} })

/** Whether the server can order a column's values (a person, a relation and a multi-select hold ids and lists). */
export const isSortable = (t: CustomFieldType) => t !== 'person' && t !== 'relation' && t !== 'multi_select'

/** Archives rows, with an Undo on the toast. */
export async function archiveRows(data: TableData, ids: readonly string[]) {
  if (!ids.length) return
  data.archiveRows(ids)
  const changeId = await data.lastChangeId()
  toast(ids.length === 1 ? 'Archived the row' : `Archived ${ids.length} rows`, changeId ? { action: { label: 'Undo', onClick: () => void data.undo(changeId) } } : undefined)
}

export const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)

export function TableGrid({
  data,
  shown,
  widths,
  onWidth,
  onHide,
  onMoveColumn,
  sort,
  onSort,
  onOpenRow,
}: {
  data: TableData
  /** The view's columns, in its order, less its hidden ones (lib/tables/views viewColumns). */
  shown: readonly DataColumn[]
  widths: Readonly<Record<string, number>>
  onWidth: (key: string, width: number) => void
  onHide: (key: string) => void
  /** A shown column dragged to another place among the shown ones. */
  onMoveColumn: (key: string, toIndex: number) => void
  sort: TableSort | null
  onSort: (next: TableSort | null) => void
  onOpenRow: (rowId: string) => void
}) {
  const { table, columns, rows, labels, members, cellErrors, canEdit, edit } = data
  const apiRef = useRef<CellGridApi | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<DataColumn | null>(null)
  const [retyping, setRetyping] = useState<DataColumn | null>(null)
  const [adding, setAdding] = useState(false)
  const [contextRow, setContextRow] = useState<number | null>(null)
  const focusNewRow = useRef<string | null>(null)

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns])
  const visible = shown
  const cellColumn = useCallback((key: string): CellColumn => (key === TITLE_KEY ? TITLE_COLUMN : asCell(byKey.get(key)!)), [byKey])
  // The rows come in the view's order from the server; an edited row stays where it is.
  const displayRows = rows

  // A row just added from + New: its Name cell opens for typing.
  useEffect(() => {
    const id = focusNewRow.current
    if (!id) return
    const i = displayRows.findIndex((r) => r.id === id)
    if (i < 0) return
    focusNewRow.current = null
    apiRef.current?.select({ row: i, col: 0 }, { edit: true })
  }, [displayRows])

  const addRow = useCallback(() => {
    const id = newId()
    focusNewRow.current = id
    data.edit([], [{ id, title: '' }])
  }, [data])

  const gridColumns = useMemo<GridColumn[]>(() => {
    const header = (col: CellColumn) => (
      <ColumnHeader
        column={col}
        open={menuFor === col.key}
        onOpenChange={(open) => setMenuFor(open ? col.key : null)}
        canEdit={canEdit}
        sorted={sort?.key === col.key ? sort.dir : null}
        onSort={col.key === TITLE_KEY || isSortable(col.field_type) ? (dir) => onSort({ key: col.key, dir }) : undefined}
        onRename={() => setRenaming(byKey.get(col.key) ?? null)}
        onRetype={() => setRetyping(byKey.get(col.key) ?? null)}
        onHide={() => onHide(col.key)}
        onDelete={() => void deleteColumn(col.key)}
        onFocusGrid={() => apiRef.current?.focus()}
      />
    )
    return [
      { id: TITLE_KEY, label: 'Name', width: widths[TITLE_KEY] ?? 260, minWidth: 120, movable: false, header: header(TITLE_COLUMN) },
      ...visible.map((c) => ({ id: c.key, label: c.label, width: widths[c.key] ?? DEFAULT_WIDTH[c.field_type], header: header(asCell(c)) })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, widths, menuFor, canEdit, sort, byKey])

  const deleteColumn = async (key: string) => {
    const col = byKey.get(key)
    const problem = data.columnOps([{ op: 'delete_column', key }])
    if (problem) return void toast.error(problem)
    const changeId = await data.lastChangeId()
    toast(`Deleted column “${col?.label ?? key}”`, changeId ? { action: { label: 'Undo', onClick: () => void data.undo(changeId) } } : undefined)
  }

  const renderCell = useCallback(
    (row: DataRow, gc: GridColumn) => {
      const error = cellErrors.get(cellId(row.id, gc.id))
      if (gc.id === TITLE_KEY) {
        return (
          <span className={cn('group/title relative flex h-full w-full min-w-0 items-center', error && 'ring-1 ring-inset ring-destructive')} title={error}>
            <span className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{row.title}</span>
            <button
              type="button"
              aria-label={`Open ${row.title || 'row'}`}
              className="invisible mr-1 flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-[11px] text-muted-foreground hover:text-foreground group-hover/title:visible"
              onClick={() => onOpenRow(row.id)}
            >
              <Maximize2 className="h-3 w-3" />
              Open
            </button>
          </span>
        )
      }
      const col = byKey.get(gc.id)
      if (!col) return null
      const value = row.custom_fields?.[gc.id] ?? null
      const toggle = canEdit && col.field_type === 'checkbox' ? () => edit([{ rowId: row.id, key: col.key, value: value !== true }]) : undefined
      return (
        <span className={cn('relative flex h-full w-full min-w-0 items-center', error && 'ring-1 ring-inset ring-destructive')} title={error} aria-invalid={error ? true : undefined}>
          <CellDisplay column={asCell(col)} value={value} labels={labels} onToggle={toggle} />
        </span>
      )
    },
    [byKey, labels, cellErrors, canEdit, edit, onOpenRow],
  )

  const renderEditor = useCallback(
    (row: DataRow, gc: GridColumn, _i: number, editor: { initial?: string; done: (m?: 'down' | 'up' | 'right' | 'left' | null) => void; cancel: () => void }) => {
      const col = cellColumn(gc.id)
      const value = gc.id === TITLE_KEY ? row.title : (row.custom_fields?.[gc.id] ?? null)
      return (
        <CellEditor
          column={col}
          value={value}
          initial={editor.initial}
          labels={labels}
          members={members}
          onCommit={(raw, names) => edit([{ rowId: row.id, key: gc.id, value: gc.id === TITLE_KEY ? (raw ?? '') : raw }], [], names)}
          done={editor.done}
          cancel={editor.cancel}
        />
      )
    },
    [cellColumn, labels, members, edit],
  )

  const onActivate = useCallback(
    (_pos: CellPos, row: DataRow, gc: GridColumn, initial?: string) => {
      const col = byKey.get(gc.id)
      if (col?.field_type !== 'checkbox') return false
      if (initial === undefined || initial === ' ') edit([{ rowId: row.id, key: col.key, value: row.custom_fields?.[col.key] !== true }])
      return true
    },
    [byKey, edit],
  )

  const copyText = useCallback(
    (row: DataRow, gc: GridColumn) => (gc.id === TITLE_KEY ? row.title ?? '' : clipboardText(byKey.get(gc.id)?.field_type ?? 'text', row.custom_fields?.[gc.id], labels)),
    [byKey, labels],
  )

  const onPaste = (targets: PasteTarget[]) => {
    const edits: CellEdit[] = []
    const fresh = new Map<number, { id: string; title?: string; values: Record<string, unknown> }>()
    for (const t of targets) {
      const key = gridColumns[t.col]?.id
      if (!key) continue
      const col = key === TITLE_KEY ? null : byKey.get(key)
      const value = col ? pastedValue(col, t.text, { members, labels }) : t.text
      if (t.row < displayRows.length) {
        edits.push({ rowId: displayRows[t.row].id, key, value })
      } else {
        const nr = fresh.get(t.row) ?? fresh.set(t.row, { id: newId(), values: {} }).get(t.row)!
        if (key === TITLE_KEY) nr.title = t.text
        else nr.values[key] = value
      }
    }
    const errors = data.edit(edits, [...fresh.values()])
    if (errors.length) toast.error(errors.length === 1 ? errors[0].error : `${errors.length} cells didn’t fit their columns. First: ${errors[0].error}`)
  }

  const clearRange = (range: CellRange) => {
    const edits: CellEdit[] = []
    for (let r = range.top; r <= Math.min(range.bottom, displayRows.length - 1); r++) {
      for (let c = range.left; c <= range.right; c++) {
        const key = gridColumns[c]?.id
        if (key) edits.push({ rowId: displayRows[r].id, key, value: key === TITLE_KEY ? '' : null })
      }
    }
    const errors = data.edit(edits)
    if (errors.length) toast.error(errors[0].error)
  }

  // The Name column is the grid's first; a moved column's place counts the shown ones after it.
  const onColumnMove = (id: string, toIndex: number) => onMoveColumn(id, toIndex - 1)

  const archive = (ids: string[]) => archiveRows(data, ids)
  const selectedRowIds = () => {
    const sel = apiRef.current?.selection()
    if (!sel) return []
    const r = selectionRange(sel)
    return displayRows.slice(r.top, r.bottom + 1).map((x) => x.id)
  }

  if (!table) return null
  return (
    <>
      <ContextMenu onOpenChange={(open) => !open && apiRef.current?.focus()}>
        <ContextMenuTrigger asChild>
          <div className="flex min-h-0 flex-1 flex-col border-t border-border">
            <CellGrid
              apiRef={apiRef}
              ariaLabel={table.name}
              rows={displayRows}
              getRowId={(r) => r.id}
              columns={gridColumns}
              renderCell={renderCell}
              renderEditor={renderEditor}
              copyText={copyText}
              readOnly={!canEdit}
              onActivate={onActivate}
              onPaste={onPaste}
              onClear={clearRange}
              onColumnResize={onWidth}
              onColumnMove={onColumnMove}
              onHeaderClick={(id) => setMenuFor(id)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
                  if (canEdit) void data.undo()
                  return true
                }
                return false
              }}
              onContextMenuCell={(pos) => setContextRow(pos.row)}
              onReachEnd={data.hasMore ? () => void data.loadMore() : undefined}
              headerTrailing={
                canEdit
                  ? {
                      width: 44,
                      node: (
                        <Popover open={adding} onOpenChange={setAdding}>
                          <PopoverTrigger asChild>
                            <button type="button" aria-label="Add a column" className="flex h-full w-full items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                              <Plus className="h-4 w-4" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="end" className="w-72 rounded-xl p-3">
                            <AddColumnForm
                              tableId={table.id}
                              onCancel={() => setAdding(false)}
                              onAdd={(label, shape: ColumnShape) => {
                                const problem = data.columnOps([{ op: 'create_column', label, field_type: shape.field_type, options: shape.options, config: shape.config }])
                                if (!problem) setAdding(false)
                                return problem
                              }}
                            />
                          </PopoverContent>
                        </Popover>
                      ),
                    }
                  : undefined
              }
              footer={
                canEdit ? (
                  <button type="button" onClick={addRow} className="flex h-full w-full items-center gap-1.5 px-3 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground">
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </button>
                ) : undefined
              }
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem disabled={contextRow === null || !displayRows[contextRow]} onSelect={() => contextRow !== null && displayRows[contextRow] && onOpenRow(displayRows[contextRow].id)}>
            <Maximize2 className="h-3.5 w-3.5" /> Open
          </ContextMenuItem>
          {canEdit && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => clearRange(selectionRange(apiRef.current!.selection()))}>Clear cells</ContextMenuItem>
              <ContextMenuItem onSelect={() => void archive(selectedRowIds())}>
                {selectedRowIds().length > 1 ? `Archive ${selectedRowIds().length} rows` : 'Archive row'}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {renaming && (
        <RenameDialog
          label={renaming.label}
          onClose={() => setRenaming(null)}
          onRename={(label) => data.columnOps([{ op: 'update_column', key: renaming.key, label }])}
        />
      )}
      {retyping && (
        <TypeChangeDialog
          column={retyping}
          tableId={table.id}
          onClose={() => setRetyping(null)}
          onChange={async (shape) => {
            const result = await data.sendNow([{ op: 'change_column_type', key: retyping.key, field_type: shape.field_type, options: shape.options, config: shape.config }])
            if (!result.ok) return result.error
            const changeId = result.changeId
            toast(`“${retyping.label}” is now ${CUSTOM_FIELD_TYPE_LABELS[shape.field_type]}`, changeId ? { action: { label: 'Undo', onClick: () => void data.undo(changeId) } } : undefined)
            return null
          }}
        />
      )}
    </>
  )
}

/**
 * A column's header and its menu. The grid owns the header's pointer (a drag
 * moves the column), so the menu opens on its click (onHeaderClick), not
 * from its own trigger.
 */
function ColumnHeader({
  column,
  open,
  onOpenChange,
  canEdit,
  sorted,
  onSort,
  onRename,
  onRetype,
  onHide,
  onDelete,
  onFocusGrid,
}: {
  column: CellColumn
  open: boolean
  onOpenChange: (open: boolean) => void
  canEdit: boolean
  sorted: 'asc' | 'desc' | null
  /** Absent for a column whose values don't order (a person, a relation, a multi-select). */
  onSort?: (dir: 'asc' | 'desc') => void
  onRename: () => void
  onRetype: () => void
  onHide: () => void
  onDelete: () => void
  onFocusGrid: () => void
}) {
  const isTitle = column.key === TITLE_KEY
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild disabled>
        <span className="flex h-full w-full cursor-default items-center" data-column-header={column.key}>
          <ColumnLabel type={column.field_type} label={column.label}>
            {sorted && (sorted === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" aria-label="Sorted ascending" /> : <ArrowDown className="h-3 w-3 shrink-0" aria-label="Sorted descending" />)}
          </ColumnLabel>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-52"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onFocusGrid()
        }}
      >
        {canEdit && !isTitle && (
          <>
            <DropdownMenuItem onSelect={onRename}>
              <Pencil className="h-3.5 w-3.5" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRetype}>
              <Shapes className="h-3.5 w-3.5" /> Change type
              <span className="ml-auto text-xs text-muted-foreground">{CUSTOM_FIELD_TYPE_LABELS[column.field_type]}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {onSort && (
          <>
            <DropdownMenuItem onSelect={() => onSort('asc')}>
              <ArrowUp className="h-3.5 w-3.5" /> Sort ascending
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSort('desc')}>
              <ArrowDown className="h-3.5 w-3.5" /> Sort descending
            </DropdownMenuItem>
          </>
        )}
        {!isTitle && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onHide}>
              <EyeOff className="h-3.5 w-3.5" /> Hide
            </DropdownMenuItem>
            {canEdit && (
              <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
