'use client'

/**
 * A table's column menu (sort, filter, type, insert/delete/rename, group by) and
 * its options panel (rename, range, color, toggles, convert to range, delete).
 * Every action runs through the controller, each one undo step.
 */
import { useMemo, useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createPortal } from 'react-dom'
import { fixedMenuStyle, MENU_COLLISION_PADDING } from '@/components/ui/menu-fit'
import { Button } from '@/components/ui/button'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { parseRange, rangeName } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import {
  TABLE_COLORS,
  TABLE_COLUMN_TYPES,
  TOTAL_KINDS,
  type FilterOp,
  type TableColumnType,
  type TotalKind,
  type WorkbookTable,
} from '@/lib/spreadsheets/extras'

const result = (r: { ok: boolean; message?: string }, onMessage: (m: string) => void) => {
  if (!r.ok && r.message) onMessage(r.message)
}

const TYPE_LABELS: Record<TableColumnType, string> = {
  text: 'Text', number: 'Number', percent: 'Percent', currency: 'Currency', date: 'Date', datetime: 'Date-time', time: 'Time', checkbox: 'Checkbox', dropdown: 'Dropdown', people: 'People',
}
const TOTAL_LABELS: Record<TotalKind, string> = {
  none: 'None', sum: 'Sum', average: 'Average', count: 'Count numbers', filled: 'Count filled', empty: 'Count empty', unique: 'Count unique', min: 'Min', max: 'Max',
}
const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: 'equals', label: 'Equals' },
  { op: 'notEquals', label: 'Does not equal' },
  { op: 'contains', label: 'Contains' },
  { op: 'greaterThan', label: 'Greater than' },
  { op: 'lessThan', label: 'Less than' },
  { op: 'isEmpty', label: 'Is empty' },
  { op: 'isNotEmpty', label: 'Is not empty' },
]

export interface ColumnMenuState {
  table: WorkbookTable
  offset: number
  x: number
  y: number
}

export function TableColumnMenu({
  workbook,
  state,
  onClose,
  onMessage,
  onOpenOptions,
}: {
  workbook: WorkbookController
  state: ColumnMenuState
  onClose: () => void
  onMessage: (message: string) => void
  onOpenOptions: (id: string) => void
}) {
  const { table, offset } = state
  const column = table.columns[offset]
  const [tab, setTab] = useState<'menu' | 'filter' | 'group'>('menu')
  const readOnly = workbook.readOnly

  const run = (r: { ok: boolean; message?: string }) => {
    result(r, onMessage)
    onClose()
  }

  if (typeof document === 'undefined') return null
  // At the pointer, opening upward when it sits low in the window, and never
  // taller than the room on that side. In <body>, so no transformed or
  // clipping ancestor holds it.
  const { style: fit } = fixedMenuStyle({ top: state.y, bottom: state.y }, { height: window.innerHeight }, { gap: 0, need: 320 })

  return createPortal(
    <>
      <div className="fixed inset-0 z-[70]" onPointerDown={onClose} />
      <div
        role="menu"
        aria-label={`Column ${column?.name ?? ''}`}
        className={cn(FLOATING_CARD_CLASS, 'fixed z-[71] w-60 overscroll-contain p-1 text-[13px] shadow-lg')}
        style={{ left: Math.max(MENU_COLLISION_PADDING, Math.min(state.x, window.innerWidth - 260)), ...fit }}
      >
        {tab === 'menu' && (
          <div className="flex flex-col">
            <MenuItem icon={<ArrowUpAZ className="h-3.5 w-3.5" />} disabled={readOnly} onClick={() => run(workbook.sortTableColumn(table.id, offset, false))}>Sort A to Z</MenuItem>
            <MenuItem icon={<ArrowDownAZ className="h-3.5 w-3.5" />} disabled={readOnly} onClick={() => run(workbook.sortTableColumn(table.id, offset, true))}>Sort Z to A</MenuItem>
            <Divider />
            <MenuItem disabled={readOnly} onClick={() => setTab('filter')}>Filter…</MenuItem>
            {table.filters[offset] && <MenuItem disabled={readOnly} onClick={() => run(workbook.setTableFilter(table.id, offset, null))}>Clear filter</MenuItem>}
            <MenuItem disabled={readOnly} onClick={() => setTab('group')}>Group by this column…</MenuItem>
            <Divider />
            <div className="px-2 py-1">
              <label className="text-[11px] text-muted-foreground">Column type</label>
              <select
                aria-label="Column type"
                value={column?.type ?? 'text'}
                disabled={readOnly}
                className="mt-1 h-7 w-full rounded-md border border-border bg-background px-1 text-[12px] outline-none focus:border-primary"
                onChange={(event) => run(workbook.setColumnType(table.id, offset, event.target.value as TableColumnType))}
              >
                {TABLE_COLUMN_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            {table.style.totalRow && (
              <div className="px-2 py-1">
                <label className="text-[11px] text-muted-foreground">Total</label>
                <select
                  aria-label="Column total"
                  value={column?.total ?? 'none'}
                  disabled={readOnly}
                  className="mt-1 h-7 w-full rounded-md border border-border bg-background px-1 text-[12px] outline-none focus:border-primary"
                  onChange={(event) => run(workbook.setColumnTotal(table.id, offset, event.target.value as TotalKind))}
                >
                  {TOTAL_KINDS.map((k) => <option key={k} value={k}>{TOTAL_LABELS[k]}</option>)}
                </select>
              </div>
            )}
            <Divider />
            <MenuItem disabled={readOnly} onClick={() => run(workbook.insertColumnAt(table.id, offset, 'left'))}>Insert column left</MenuItem>
            <MenuItem disabled={readOnly} onClick={() => run(workbook.insertColumnAt(table.id, offset, 'right'))}>Insert column right</MenuItem>
            <MenuItem disabled={readOnly} onClick={() => run(workbook.deleteColumnAt(table.id, offset))}>Delete column</MenuItem>
            <RenameItem disabled={readOnly} current={column?.name ?? ''} onRename={(name) => run(workbook.renameColumn(table.id, offset, name))} />
            <Divider />
            <MenuItem disabled={readOnly} onClick={() => { onClose(); onOpenOptions(table.id) }}>Table options…</MenuItem>
          </div>
        )}
        {tab === 'filter' && <FilterPanel workbook={workbook} table={table} offset={offset} onApply={run} onBack={() => setTab('menu')} />}
        {tab === 'group' && <GroupByPanel workbook={workbook} table={table} offset={offset} onBack={() => setTab('menu')} />}
      </div>
    </>,
    document.body,
  )
}

function MenuItem({ children, icon, disabled, onClick }: { children: React.ReactNode; icon?: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40" onClick={onClick}>
      {icon}
      {children}
    </button>
  )
}

const Divider = () => <div className="my-1 h-px bg-border/60" />

function RenameItem({ current, disabled, onRename }: { current: string; disabled?: boolean; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current)
  if (!editing) return <MenuItem disabled={disabled} onClick={() => { setValue(current); setEditing(true) }}>Rename column…</MenuItem>
  return (
    <form
      className="px-2 py-1"
      onSubmit={(event) => { event.preventDefault(); onRename(value) }}
    >
      <input autoFocus aria-label="Column name" value={value} className="h-7 w-full rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-primary" onChange={(event) => setValue(event.target.value)} />
    </form>
  )
}

function FilterPanel({ workbook, table, offset, onApply, onBack }: { workbook: WorkbookController; table: WorkbookTable; offset: number; onApply: (r: { ok: boolean; message?: string }) => void; onBack: () => void }) {
  const values = useMemo(() => workbook.tableColumnValues(table.id, offset), [workbook, table.id, offset])
  const existing = table.filters[offset]
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set(existing?.values ?? values))
  const [search, setSearch] = useState('')
  const [op, setOp] = useState<FilterOp | ''>(existing?.condition?.op ?? '')
  const [condValue, setCondValue] = useState(existing?.condition?.value ?? '')
  const shown = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))

  const apply = () => {
    const filter: { values?: string[]; condition?: { op: FilterOp; value: string } } = {}
    if (allowed.size !== values.length) filter.values = [...allowed]
    if (op) filter.condition = { op, value: condValue }
    onApply(workbook.setTableFilter(table.id, offset, filter.values || filter.condition ? filter : null))
  }

  return (
    <div className="p-1.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={onBack}>← Back</button>
        <span className="text-[12px] font-medium text-foreground">Filter</span>
      </div>
      <div className="mb-1.5">
        <select aria-label="Condition" value={op} className="h-7 w-full rounded-md border border-border bg-background px-1 text-[12px] outline-none focus:border-primary" onChange={(event) => setOp(event.target.value as FilterOp | '')}>
          <option value="">No condition</option>
          {FILTER_OPS.map((f) => <option key={f.op} value={f.op}>{f.label}</option>)}
        </select>
        {op && op !== 'isEmpty' && op !== 'isNotEmpty' && (
          <input aria-label="Condition value" value={condValue} className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-primary" onChange={(event) => setCondValue(event.target.value)} />
        )}
      </div>
      <input aria-label="Search values" placeholder="Search values" value={search} className="mb-1 h-7 w-full rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-primary" onChange={(event) => setSearch(event.target.value)} />
      <div className="mb-1 flex gap-2 px-1 text-[11px] text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={() => setAllowed(new Set(values))}>All</button>
        <button type="button" className="hover:text-foreground" onClick={() => setAllowed(new Set())}>None</button>
      </div>
      <ul className="max-h-40 overflow-y-auto">
        {shown.map((v) => (
          <li key={v}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-accent">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={allowed.has(v)}
                onChange={(event) => setAllowed((prev) => { const next = new Set(prev); if (event.target.checked) next.add(v); else next.delete(v); return next })}
              />
              <span className="truncate">{v === '' ? '(blank)' : v}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-end">
        <Button type="button" size="sm" onClick={apply}>Apply</Button>
      </div>
    </div>
  )
}

function GroupByPanel({ workbook, table, offset, onBack }: { workbook: WorkbookController; table: WorkbookTable; offset: number; onBack: () => void }) {
  const [valueCol, setValueCol] = useState(() => table.columns.findIndex((_, i) => i !== offset))
  const [agg, setAgg] = useState<'sum' | 'average' | 'count' | 'min' | 'max'>('sum')
  const rows = useMemo(() => workbook.groupBy(table.id, offset, valueCol, agg), [workbook, table.id, offset, valueCol, agg])
  return (
    <div className="p-1.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={onBack}>← Back</button>
        <span className="text-[12px] font-medium text-foreground">Group by {table.columns[offset]?.name}</span>
      </div>
      <div className="mb-2 flex gap-1.5">
        <select aria-label="Summarise column" value={valueCol} className="h-7 flex-1 rounded-md border border-border bg-background px-1 text-[12px] outline-none focus:border-primary" onChange={(event) => setValueCol(Number(event.target.value))}>
          {table.columns.map((c, i) => <option key={i} value={i} disabled={i === offset}>{c.name}</option>)}
        </select>
        <select aria-label="Aggregate" value={agg} className="h-7 rounded-md border border-border bg-background px-1 text-[12px] outline-none focus:border-primary" onChange={(event) => setAgg(event.target.value as typeof agg)}>
          <option value="sum">Sum</option>
          <option value="average">Average</option>
          <option value="count">Count</option>
          <option value="min">Min</option>
          <option value="max">Max</option>
        </select>
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map((row) => (
            <tr key={row.group} className="border-b border-border/40">
              <td className="truncate py-0.5 pr-2 text-foreground">{row.group === '' ? '(blank)' : row.group}</td>
              <td className="py-0.5 text-right tabular-nums text-muted-foreground">{Number(row.value.toPrecision(10)).toLocaleString('en-US')}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="py-1 text-muted-foreground">Nothing to summarise.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

export function TableOptionsPanel({ workbook, tableId, onClose, onMessage, focusGrid }: { workbook: WorkbookController; tableId: string; onClose: () => void; onMessage: (message: string) => void; focusGrid: () => void }) {
  const current = useMemo(() => workbook.extras.tables.find((t) => t.id === tableId), [workbook, tableId])
  const [name, setName] = useState(current?.name ?? '')
  const [range, setRange] = useState(current ? rangeName(current.range) : '')
  if (!current) return null
  const readOnly = workbook.readOnly
  const style = current.style

  const toggle = (key: keyof typeof style) => result(workbook.setTableStyle(tableId, { [key]: !style[key] }), onMessage)

  return (
    <aside aria-label="Table options" className={cn(FLOATING_CARD_CLASS, 'absolute bottom-3 right-3 top-3 z-40 flex w-[300px] max-w-[calc(100%-1.5rem)] flex-col shadow-lg')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <h2 className="flex-1 text-sm font-medium text-foreground">Table options</h2>
        <button type="button" aria-label="Close table options" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <input
          aria-label="Table name"
          value={name}
          disabled={readOnly}
          className="mb-3 mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => result(workbook.renameTable(tableId, name), onMessage)}
        />

        <label className="text-xs font-medium text-muted-foreground">Range</label>
        <input
          aria-label="Table range"
          value={range}
          disabled={readOnly}
          spellCheck={false}
          className="mb-3 mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm outline-none focus:border-primary"
          onChange={(event) => setRange(event.target.value)}
          onBlur={() => {
            const parsed = parseRange(range.trim())
            if (!parsed) { onMessage(`"${range}" is not a range (e.g. A1:C9).`); return }
            result(workbook.setTableRange(tableId, parsed), onMessage)
          }}
        />

        <label className="text-xs font-medium text-muted-foreground">Color</label>
        <div role="group" aria-label="Table color" className="mb-3 mt-1 grid grid-cols-5 gap-1.5">
          {TABLE_COLORS.map((c) => (
            <button
              key={c.hex}
              type="button"
              aria-label={c.name}
              title={c.name}
              disabled={readOnly}
              className={cn('h-6 w-6 rounded-md border border-border/60', style.color.toUpperCase() === c.hex.toUpperCase() && 'ring-2 ring-primary')}
              style={{ backgroundColor: c.hex }}
              onClick={() => result(workbook.setTableStyle(tableId, { color: c.hex }), onMessage)}
            />
          ))}
        </div>

        <div className="space-y-1.5">
          <Toggle label="Banded rows" checked={style.bandedRows} disabled={readOnly} onChange={() => toggle('bandedRows')} />
          <Toggle label="Banded columns" checked={style.bandedColumns} disabled={readOnly} onChange={() => toggle('bandedColumns')} />
          <Toggle label="Bold first column" checked={style.boldFirstColumn} disabled={readOnly} onChange={() => toggle('boldFirstColumn')} />
          <Toggle label="Bold last column" checked={style.boldLastColumn} disabled={readOnly} onChange={() => toggle('boldLastColumn')} />
          <Toggle label="Total row" checked={style.totalRow} disabled={readOnly} onChange={() => result(workbook.setTableStyle(tableId, { totalRow: !style.totalRow }), onMessage)} />
        </div>

        <div className="mt-4 space-y-1.5">
          <Button type="button" size="sm" variant="outline" className="w-full" disabled={readOnly || Object.keys(current.filters).length === 0} onClick={() => result(workbook.clearTableFilters(tableId), onMessage)}>Clear filters</Button>
          <Button type="button" size="sm" variant="outline" className="w-full" disabled={readOnly} onClick={() => { result(workbook.convertTableToRange(tableId), onMessage); onClose(); focusGrid() }}>Convert to range</Button>
          <Button type="button" size="sm" variant="outline" className="w-full text-destructive hover:text-destructive" disabled={readOnly} onClick={() => { result(workbook.deleteTable(tableId), onMessage); onClose(); focusGrid() }}>Delete table</Button>
        </div>
      </div>
    </aside>
  )
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-sm text-foreground">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="h-3.5 w-3.5 accent-primary" />
    </label>
  )
}
