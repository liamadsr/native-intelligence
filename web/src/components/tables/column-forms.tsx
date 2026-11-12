'use client'

/**
 * A table's column forms (Tables, phase 3): add a column (the + header), and
 * change a column's type (a dialog that shows the database's answer when
 * values don't fit, the misfit count, and leaves the column as it was).
 * Both take a type and what it needs: options for a select, a currency's
 * code, and a relation's target: a kind, or another table's rows. A new
 * column may also be a formula or a rollup (phase 6, ./computed-cells.tsx);
 * one of those changes its formula or rollup, never its type.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TARGET_NAMES } from '@/components/crm/custom-fields-group'
import { cn } from '@/lib/utils'
import {
  CUSTOM_FIELD_TYPES,
  RELATION_TARGET_KINDS,
  hasOptions,
  type CustomFieldConfig,
  type RelationTargetKind,
} from '@/lib/crm/custom-field-types'
import { COLUMN_TYPE_LABELS } from '@/lib/tables/computed'
import { COMPUTED_COLUMN_TYPES, isComputedType, type DataColumn, type DataColumnType, type DataTable } from '@/lib/tables/types'
import { ComputedFields } from './computed-cells'

export const fieldClass = 'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-foreground/30'

export interface ColumnShape {
  field_type: DataColumnType
  options: string[]
  config: CustomFieldConfig
}

/** A relation target as one select value: a kind, or `data_row:<table id>`. */
const targetValue = (c: CustomFieldConfig) => (c.target?.kind === 'data_row' ? `data_row:${c.target.table_id ?? ''}` : c.target?.kind ?? 'contact')

function useTables(enabled: boolean) {
  const [tables, setTables] = useState<Pick<DataTable, 'id' | 'name'>[]>([])
  useEffect(() => {
    if (!enabled) return
    let live = true
    void fetch('/api/account/tables')
      .then((r) => (r.ok ? r.json() : { tables: [] }))
      .then((j: { tables?: DataTable[] }) => live && setTables(j.tables ?? []))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [enabled])
  return tables
}

/** A type and what it needs. */
export function ColumnTypeFields({
  value,
  onChange,
  tableId,
  columns,
  self,
}: {
  value: ColumnShape
  onChange: (v: ColumnShape) => void
  tableId: string
  /** The table's columns: a new column may then be a formula or a rollup over them. */
  columns?: readonly DataColumn[]
  /** The column being changed (a formula can't name itself). */
  self?: string
}) {
  const t = value.field_type
  const types: readonly DataColumnType[] = columns ? [...CUSTOM_FIELD_TYPES, ...COMPUTED_COLUMN_TYPES] : CUSTOM_FIELD_TYPES
  const tables = useTables(t === 'relation')
  const [optionText, setOptionText] = useState(value.options.join(', '))
  const set = (patch: Partial<ColumnShape>) => onChange({ ...value, ...patch })
  return (
    <div className="space-y-2">
      <select aria-label="Type" className={cn(fieldClass, 'cursor-pointer')} value={t} onChange={(e) => {
        const next = e.target.value as DataColumnType
        set({
          field_type: next,
          config:
            next === 'currency'
              ? { currency: value.config.currency ?? 'USD' }
              : next === 'relation'
                ? { target: value.config.target ?? { kind: 'contact' }, multiple: value.config.multiple ?? false }
                : next === 'rollup'
                  ? { fn: 'count', field: null }
                  : {},
        })
      }}>
        {types.map((x) => (
          <option key={x} value={x}>{COLUMN_TYPE_LABELS[x]}</option>
        ))}
      </select>
      {isComputedType(t) && columns && <ComputedFields value={{ field_type: t, config: value.config }} onChange={(v) => set({ config: v.config })} columns={columns} self={self} />}
      {!isComputedType(t) && hasOptions(t) && (
        <Input
          aria-label="Options"
          className="h-8"
          placeholder="Options, comma-separated"
          value={optionText}
          onChange={(e) => {
            setOptionText(e.target.value)
            set({ options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })
          }}
        />
      )}
      {t === 'currency' && (
        <Input aria-label="Currency" className="h-8 w-24" maxLength={3} placeholder="USD" value={value.config.currency ?? ''} onChange={(e) => set({ config: { ...value.config, currency: e.target.value.toUpperCase() } })} />
      )}
      {t === 'relation' && (
        <div className="flex items-center gap-2">
          <select
            aria-label="Links to"
            className={cn(fieldClass, 'cursor-pointer')}
            value={targetValue(value.config)}
            onChange={(e) => {
              const v = e.target.value
              const target = v.startsWith('data_row:') ? { kind: 'data_row' as const, table_id: v.slice('data_row:'.length) } : { kind: v as RelationTargetKind }
              set({ config: { ...value.config, target } })
            }}
          >
            {RELATION_TARGET_KINDS.filter((k) => k !== 'data_row').map((k) => (
              <option key={k} value={k}>{TARGET_NAMES[k] ?? k}</option>
            ))}
            {tables.map((tb) => (
              <option key={tb.id} value={`data_row:${tb.id}`}>{tb.id === tableId ? `Rows of this table` : `Rows of ${tb.name}`}</option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={value.config.multiple === true} onChange={(e) => set({ config: { ...value.config, multiple: e.target.checked } })} /> Several
          </label>
        </div>
      )}
    </div>
  )
}

/** The + header's form: a name and a type. */
export function AddColumnForm({
  tableId,
  columns,
  onAdd,
  onCancel,
}: {
  tableId: string
  columns: readonly DataColumn[]
  onAdd: (label: string, shape: ColumnShape) => string | null
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [shape, setShape] = useState<ColumnShape>({ field_type: 'text', options: [], config: {} })
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    if (!label.trim()) return onCancel()
    const problem = onAdd(label.trim(), shape)
    if (problem) setError(problem)
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Input autoFocus aria-label="Column name" className="h-8" placeholder="Column name" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <ColumnTypeFields value={shape} onChange={setShape} tableId={tableId} columns={columns} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!label.trim()}>Add column</Button>
      </div>
    </form>
  )
}

/**
 * Change a column's type. Every value converts by the database's one cast
 * rule, or nothing changes and the dialog says how many don't fit (the
 * error the server answers). Undo comes after, from the toast or History.
 */
export function TypeChangeDialog({
  column,
  tableId,
  onClose,
  onChange,
}: {
  column: DataColumn
  tableId: string
  onClose: () => void
  onChange: (shape: ColumnShape) => Promise<string | null>
}) {
  const [shape, setShape] = useState<ColumnShape>({ field_type: column.field_type, options: column.options ?? [], config: column.config ?? {} })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const unchanged = shape.field_type === column.field_type && JSON.stringify(shape.options) === JSON.stringify(column.options ?? []) && JSON.stringify(shape.config) === JSON.stringify(column.config ?? {})
  const submit = async () => {
    setBusy(true)
    setError(null)
    const problem = await onChange(shape)
    setBusy(false)
    if (problem) setError(problem)
    else onClose()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Change the type of {column.label}</DialogTitle>
          <DialogDescription>Every value converts to the new type. If some don’t fit, nothing changes.</DialogDescription>
        </DialogHeader>
        <ColumnTypeFields value={shape} onChange={setShape} tableId={tableId} />
        {!isComputedType(shape.field_type) && hasOptions(shape.field_type) && !shape.options.length && (
          <p className="text-xs text-muted-foreground">With no options given, the column takes the values it has as its options.</p>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy || unchanged} onClick={() => void submit()}>{busy ? 'Changing…' : 'Change type'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Change a formula or a rollup (phase 6): its expression, or what it reads
 * and how. Saved as one change, with its undo.
 */
export function ComputedEditDialog({
  column,
  columns,
  onClose,
  onSave,
}: {
  column: DataColumn
  columns: readonly DataColumn[]
  onClose: () => void
  onSave: (config: CustomFieldConfig) => string | null
}) {
  const type = column.field_type as 'formula' | 'rollup'
  const [config, setConfig] = useState<CustomFieldConfig>(column.config ?? {})
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{type === 'formula' ? `Formula for ${column.label}` : `Rollup for ${column.label}`}</DialogTitle>
          <DialogDescription>{type === 'formula' ? 'Name columns in braces, like {Price} * {Qty}.' : 'What it reads in the linked records, and how.'}</DialogDescription>
        </DialogHeader>
        <ComputedFields value={{ field_type: type, config }} onChange={(v) => setConfig(v.config)} columns={columns} self={column.key} />
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => {
              const problem = onSave(config)
              if (problem) setError(problem)
              else onClose()
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Rename a column. */
export function RenameDialog({ label, onClose, onRename }: { label: string; onClose: () => void; onRename: (label: string) => string | null }) {
  const [value, setValue] = useState(label)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename column</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!value.trim() || value.trim() === label) return onClose()
            const problem = onRename(value.trim())
            if (problem) setError(problem)
            else onClose()
          }}
          className="space-y-3"
        >
          <Input autoFocus aria-label="Column name" value={value} maxLength={60} onChange={(e) => setValue(e.target.value)} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
