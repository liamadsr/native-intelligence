'use client'

/**
 * A table's rows as a board (Tables, phase 4), grouped by one select or
 * person column: a lane for every option (or member), the empty ones too, as
 * the deal board lays its stages out, then "No value" (lib/tables/views
 * boardLanes). A card dropped on another lane writes that lane's value
 * through the table's batch route, shown at once (useTableData's write
 * queue catches up and sends again on a 409; a refusal puts the card back).
 * A lane's header counts its cards and, when the view picks one, totals a
 * number or currency column.
 */
import { useMemo, useState, type Ref } from 'react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { boardLanes, boardMoveEdit, cardColumns, NO_VALUE, type BoardLane } from '@/lib/tables/views'
import type { DataColumn, DataRow } from '@/lib/tables/types'
import { formatTotals, RowCard } from './row-card'
import { newId } from './table-grid'
import type { TableData } from './use-table-data'

const CARD = 'TABLE_ROW_CARD'
/** Cards a lane mounts before "Show more". */
const LANE_CARDS = 50

interface DragRow {
  id: string
  lane: string
}

export function TableBoard({
  data,
  column,
  shown,
  totalColumn,
  onOpenRow,
}: {
  data: TableData
  /** The column the board groups by (a select or a person). */
  column: DataColumn
  /** The view's shown columns, in its order: a card's fields are the first ones. */
  shown: readonly DataColumn[]
  totalColumn: DataColumn | null
  onOpenRow: (rowId: string) => void
}) {
  const { rows, members, labels, canEdit } = data
  const lanes = useMemo(() => boardLanes(rows, column, { members, labels, totalColumn }), [rows, column, members, labels, totalColumn])
  const fields = useMemo(() => cardColumns(shown, [column.key]), [shown, column.key])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const move = (rowId: string, laneKey: string) => {
    const row = byId.get(rowId)
    const e = row ? boardMoveEdit(row, column, laneKey) : null
    if (!e) return
    const errors = data.edit([e])
    if (errors.length) toast.error(errors[0].error)
  }

  /**
   * A new row in a lane: that lane's value, its title typed in the row panel.
   * A lane whose value makes another column required (required-when) can't
   * take an empty row: it is added without the lane's value instead, opened
   * with the required column flagged, and the toast says what to fill in
   * before it can move there.
   */
  const addTo = (laneKey: string) => {
    const id = newId()
    const refused = data.edit([], [{ id, title: '', values: laneKey === NO_VALUE ? {} : { [column.key]: laneKey } }])
    if (refused.length) {
      data.edit([], [{ id, title: '' }])
      const lane = lanes.find((l) => l.key === laneKey)
      toast.error(`${refused[0].error} Added it without ${column.label}; fill that in, then move it to ${lane?.label ?? laneKey}.`)
    }
    onOpenRow(id)
  }

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto border-t border-border p-4" data-table-board={column.key}>
        {lanes.map((lane) => (
          <Lane
            key={lane.key}
            lane={lane}
            fields={fields}
            labels={labels}
            totalColumn={totalColumn}
            canEdit={canEdit}
            onDrop={move}
            onAdd={canEdit ? () => addTo(lane.key) : undefined}
            onOpenRow={onOpenRow}
          />
        ))}
      </div>
    </DndProvider>
  )
}

function Lane({
  lane,
  fields,
  labels,
  totalColumn,
  canEdit,
  onDrop,
  onAdd,
  onOpenRow,
}: {
  lane: BoardLane
  fields: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  totalColumn: DataColumn | null
  canEdit: boolean
  onDrop: (rowId: string, laneKey: string) => void
  onAdd?: () => void
  onOpenRow: (rowId: string) => void
}) {
  const [limit, setLimit] = useState(LANE_CARDS)
  const [{ over }, dropRef] = useDrop<DragRow, void, { over: boolean }>({
    accept: CARD,
    canDrop: (item) => item.lane !== lane.key,
    drop: (item) => onDrop(item.id, lane.key),
    collect: (m) => ({ over: m.isOver() && m.canDrop() }),
  })
  const total = lane.rows.length ? formatTotals(lane.totals, totalColumn) : ''
  return (
    <section
      aria-label={lane.label}
      data-lane={lane.key}
      className="flex max-h-full w-72 min-w-72 flex-col rounded-lg border border-border bg-muted/30"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-sm font-medium">{lane.label}</span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{lane.rows.length}</span>
        {total && (
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" data-lane-total="" title={totalColumn ? `Total ${totalColumn.label}` : undefined}>
            {total}
          </span>
        )}
      </header>
      <div
        ref={dropRef as unknown as Ref<HTMLDivElement>}
        className={cn('flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2 transition-colors', over && 'bg-primary/5')}
      >
        {lane.rows.slice(0, limit).map((row) => (
          <DraggableCard key={row.id} row={row} lane={lane.key} fields={fields} labels={labels} canDrag={canEdit} onOpen={onOpenRow} />
        ))}
        {lane.rows.length > limit && (
          <button type="button" className="rounded-md py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setLimit((n) => n + LANE_CARDS)}>
            Show {Math.min(LANE_CARDS, lane.rows.length - limit)} more
          </button>
        )}
        {onAdd && (
          <button type="button" onClick={onAdd} className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        )}
      </div>
    </section>
  )
}

function DraggableCard({
  row,
  lane,
  fields,
  labels,
  canDrag,
  onOpen,
}: {
  row: DataRow
  lane: string
  fields: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  canDrag: boolean
  onOpen: (rowId: string) => void
}) {
  const [{ dragging }, dragRef] = useDrag<DragRow, void, { dragging: boolean }>({
    type: CARD,
    item: { id: row.id, lane },
    canDrag,
    collect: (m) => ({ dragging: m.isDragging() }),
  })
  return <RowCard row={row} fields={fields} labels={labels} onOpen={onOpen} cardRef={dragRef as unknown as Ref<HTMLDivElement>} dragging={dragging} />
}
