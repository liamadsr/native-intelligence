'use client'

/**
 * A table's rows on a calendar (Tables, phase 4), by one date column (the
 * view's pick, else the table's first): a month of whole weeks, or one week.
 * A card dropped on another day writes that day through the table's batch
 * route, shown at once (409s caught up by the write queue). The rows with no
 * date wait in a side list, there only while there are some; a card dropped
 * there loses its date.
 */
import { useMemo, useState, type Ref } from 'react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { addMonths, addWeeks, format, isSameMonth, parseISO } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { calendarMoveEdit, cardColumns, dayKey, monthWeeks, rowsByDay, weekDays } from '@/lib/tables/views'
import type { DataColumn, DataRow } from '@/lib/tables/types'
import { RowCard } from './row-card'
import type { TableData } from './use-table-data'

const CARD = 'TABLE_CALENDAR_CARD'
/** Cards a month's day shows before "N more". */
const DAY_CARDS = 3
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface DragRow {
  id: string
  day: string | null
}

export function TableCalendar({
  data,
  column,
  shown,
  onOpenRow,
}: {
  data: TableData
  column: DataColumn
  shown: readonly DataColumn[]
  onOpenRow: (rowId: string) => void
}) {
  const { rows, labels, canEdit } = data
  const [mode, setMode] = useState<'month' | 'week'>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [openDay, setOpenDay] = useState<string | null>(null)
  const { days, undated } = useMemo(() => rowsByDay(rows, column), [rows, column])
  const fields = useMemo(() => cardColumns(shown, [column.key]), [shown, column.key])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  const today = dayKey(new Date())
  const weeks = useMemo(() => (mode === 'month' ? monthWeeks(anchor) : [weekDays(anchor)]), [mode, anchor])

  const move = (rowId: string, day: string | null) => {
    const row = byId.get(rowId)
    const e = row ? calendarMoveEdit(row, column, day) : null
    if (!e) return
    const errors = data.edit([e])
    if (errors.length) toast.error(errors[0].error)
  }
  const step = (n: number) => setAnchor((a) => (mode === 'month' ? addMonths(a, n) : addWeeks(a, n)))
  const title = mode === 'month' ? format(anchor, 'MMMM yyyy') : `Week of ${format(parseISO(weeks[0][0]), 'MMM d, yyyy')}`

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border" data-table-calendar={column.key}>
        <div className="flex h-11 shrink-0 items-center gap-1 px-4">
          <h2 className="mr-2 text-sm font-medium">{title}</h2>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={mode === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={mode === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">By {column.label}</span>
          <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as 'month' | 'week')} className="ml-2">
            <ToggleGroupItem value="month" className="h-7 px-2.5 text-xs">Month</ToggleGroupItem>
            <ToggleGroupItem value="week" className="h-7 px-2.5 text-xs">Week</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-4">
            <div className="grid shrink-0 grid-cols-7 border-b border-border">
              {WEEKDAYS.map((d) => (
                <div key={d} className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{d}</div>
              ))}
            </div>
            <div className={cn('grid min-h-0 flex-1 grid-cols-7 border-l border-border', mode === 'month' ? 'auto-rows-fr' : 'grid-rows-1')}>
              {weeks.flat().map((day) => (
                <Day
                  key={day}
                  day={day}
                  rows={days.get(day) ?? []}
                  muted={mode === 'month' && !isSameMonth(parseISO(day), anchor)}
                  today={day === today}
                  limit={mode === 'month' && openDay !== day ? DAY_CARDS : Infinity}
                  onMore={() => setOpenDay(day)}
                  fields={mode === 'week' ? fields : []}
                  labels={labels}
                  canEdit={canEdit}
                  onDrop={move}
                  onOpenRow={onOpenRow}
                />
              ))}
            </div>
          </div>
          {undated.length > 0 && <Undated rows={undated} fields={fields} labels={labels} canEdit={canEdit} onDrop={move} onOpenRow={onOpenRow} />}
        </div>
      </div>
    </DndProvider>
  )
}

function Day({
  day,
  rows,
  muted,
  today,
  limit,
  onMore,
  fields,
  labels,
  canEdit,
  onDrop,
  onOpenRow,
}: {
  day: string
  rows: readonly DataRow[]
  muted: boolean
  today: boolean
  limit: number
  onMore: () => void
  fields: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  canEdit: boolean
  onDrop: (rowId: string, day: string | null) => void
  onOpenRow: (rowId: string) => void
}) {
  const [{ over }, dropRef] = useDrop<DragRow, void, { over: boolean }>({
    accept: CARD,
    canDrop: (item) => item.day !== day,
    drop: (item) => onDrop(item.id, day),
    collect: (m) => ({ over: m.isOver() && m.canDrop() }),
  })
  const extra = rows.length - limit
  return (
    <div
      ref={dropRef as unknown as Ref<HTMLDivElement>}
      data-day={day}
      className={cn('flex min-h-0 min-w-0 flex-col gap-1 overflow-hidden border-b border-r border-border p-1', muted && 'bg-muted/30', over && 'bg-primary/5')}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center self-end rounded-full text-[11px] tabular-nums',
          today ? 'bg-foreground font-medium text-background' : muted ? 'text-muted-foreground/60' : 'text-muted-foreground',
        )}
      >
        {Number(day.slice(8))}
      </span>
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {rows.slice(0, limit).map((r) => (
          <DraggableCard key={r.id} row={r} day={day} fields={fields} labels={labels} canDrag={canEdit} onOpen={onOpenRow} compact={!fields.length} />
        ))}
        {extra > 0 && (
          <button type="button" onClick={onMore} className="rounded px-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
            {extra} more
          </button>
        )}
      </div>
    </div>
  )
}

function Undated({
  rows,
  fields,
  labels,
  canEdit,
  onDrop,
  onOpenRow,
}: {
  rows: readonly DataRow[]
  fields: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  canEdit: boolean
  onDrop: (rowId: string, day: string | null) => void
  onOpenRow: (rowId: string) => void
}) {
  const [{ over }, dropRef] = useDrop<DragRow, void, { over: boolean }>({
    accept: CARD,
    canDrop: (item) => item.day !== null,
    drop: (item) => onDrop(item.id, null),
    collect: (m) => ({ over: m.isOver() && m.canDrop() }),
  })
  return (
    <aside
      ref={dropRef as unknown as Ref<HTMLElement>}
      aria-label="No date"
      className={cn('flex w-60 shrink-0 flex-col border-l border-border', over && 'bg-primary/5')}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <span className="text-xs font-medium">No date</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{rows.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {rows.slice(0, 200).map((r) => (
          <DraggableCard key={r.id} row={r} day={null} fields={fields} labels={labels} canDrag={canEdit} onOpen={onOpenRow} />
        ))}
        {rows.length > 200 && <p className="px-1 text-[11px] text-muted-foreground">and {rows.length - 200} more</p>}
      </div>
    </aside>
  )
}

function DraggableCard({
  row,
  day,
  fields,
  labels,
  canDrag,
  onOpen,
  compact,
}: {
  row: DataRow
  day: string | null
  fields: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  canDrag: boolean
  onOpen: (rowId: string) => void
  compact?: boolean
}) {
  const [{ dragging }, dragRef] = useDrag<DragRow, void, { dragging: boolean }>({
    type: CARD,
    item: { id: row.id, day },
    canDrag,
    collect: (m) => ({ dragging: m.isDragging() }),
  })
  return <RowCard row={row} fields={fields} labels={labels} onOpen={onOpen} cardRef={dragRef as unknown as Ref<HTMLDivElement>} dragging={dragging} compact={compact} />
}
