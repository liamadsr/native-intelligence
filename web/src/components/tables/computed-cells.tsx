'use client'

/**
 * Formula and rollup columns in the page (Tables, phase 6): how their cells
 * read (as a column of their result's type, read-only), and the form that
 * makes or changes one.
 *
 *   formula  an expression box, checked as it is typed (formula.ts), with
 *            the columns and functions to put in by a click;
 *   rollup   a relation column of this table, how to aggregate, and the
 *            linked records' field (another table's columns, or a record's
 *            name).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TARGET_NAMES } from '@/components/crm/custom-fields-group'
import { COLUMN_TYPE_LABELS, isRollupFn, planComputed, resultFieldType, ROLLUP_FN_LABELS, ROLLUP_FNS, rollupNeedsField, type RollupFn } from '@/lib/tables/computed'
import { FORMULA_FUNCTIONS, TITLE_REF, TITLE_REF_NAME, toDisplayFormula, toStoredFormula } from '@/lib/tables/formula'
import { isComputedType, type DataColumn, type DataRow, type DataTableWithColumns } from '@/lib/tables/types'
import type { CustomFieldConfig } from '@/lib/crm/custom-field-types'
import { CellDisplay, type CellColumn } from './cells'
import { fieldClass } from './column-forms'

/** A column as its cells read: a computed one as a column of its result's type. */
export function readColumn(c: DataColumn): CellColumn {
  if (!isComputedType(c.field_type)) return { key: c.key, label: c.label, field_type: c.field_type, options: c.options ?? [], config: c.config ?? {} }
  return { key: c.key, label: c.label, field_type: resultFieldType(c.computed?.result), options: [], config: {} }
}

/** A cell's value as it reads: a stored value, or a computed one (with its error). */
export function cellValueOf(c: DataColumn, row: Pick<DataRow, 'custom_fields' | 'computed'>): { value: unknown; error?: string } {
  if (!isComputedType(c.field_type)) return { value: row.custom_fields?.[c.key] ?? null }
  if (c.computed?.error) return { value: null, error: c.computed.error }
  const cell = row.computed?.[c.key]
  if (cell && 'error' in cell) return { value: null, error: cell.error }
  return { value: cell?.value ?? null }
}

/** A computed cell: its value as its result type reads, or its error. */
export function ComputedCell({ column, row, labels, compact }: { column: DataColumn; row: Pick<DataRow, 'custom_fields' | 'computed'>; labels: Readonly<Record<string, string>>; compact?: boolean }) {
  const { value, error } = cellValueOf(column, row)
  if (error) {
    return (
      <span className={cn('flex h-full min-w-0 items-center gap-1 text-xs text-destructive', !compact && 'px-2')} title={error} data-computed-error="">
        <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{column.computed?.error ? 'Needs a fix' : 'Error'}</span>
      </span>
    )
  }
  return <CellDisplay column={readColumn(column)} value={value} labels={labels} />
}

export interface ComputedShape {
  field_type: 'formula' | 'rollup'
  config: CustomFieldConfig
}

type TargetField = { key: string; label: string; field_type: string }

/** The linked records' fields a rollup may read: another table's stored columns, or a record's name. */
function useTargetFields(target: { kind: string; table_id?: string } | undefined) {
  const [fields, setFields] = useState<TargetField[] | null>(null)
  const tableId = target?.kind === 'data_row' ? target.table_id : undefined
  useEffect(() => {
    if (!tableId) return
    let live = true
    setFields(null)
    void fetch(`/api/account/tables/${encodeURIComponent(tableId)}`)
      .then((r) => (r.ok ? r.json() : { table: null }))
      .then((j: { table?: DataTableWithColumns | null }) => {
        if (!live) return
        setFields((j.table?.columns ?? []).filter((c) => !isComputedType(c.field_type)).map((c) => ({ key: c.key, label: c.label, field_type: c.field_type })))
      })
      .catch(() => live && setFields([]))
    return () => {
      live = false
    }
  }, [tableId])
  return tableId ? fields : []
}

const FIELD_FITS: Record<RollupFn, (t: string) => boolean> = {
  count: () => true,
  sum: (t) => t === 'number' || t === 'currency',
  avg: (t) => t === 'number' || t === 'currency',
  min: (t) => t === 'number' || t === 'currency' || t === 'date',
  max: (t) => t === 'number' || t === 'currency' || t === 'date',
  earliest: (t) => t === 'date',
  latest: (t) => t === 'date',
  list: (t) => t !== 'person' && t !== 'relation',
}

/** The form for a formula or a rollup: what it needs, checked as it is filled in. */
export function ComputedFields({ value, onChange, columns, self }: { value: ComputedShape; onChange: (v: ComputedShape) => void; columns: readonly DataColumn[]; self?: string }) {
  const others = useMemo(() => columns.filter((c) => c.key !== self && !c.deleted_at), [columns, self])
  return value.field_type === 'formula' ? (
    <FormulaFields value={value} onChange={onChange} columns={others} self={self} />
  ) : (
    <RollupFields value={value} onChange={onChange} columns={others} />
  )
}

function FormulaFields({ value, onChange, columns, self }: { value: ComputedShape; onChange: (v: ComputedShape) => void; columns: readonly DataColumn[]; self?: string }) {
  const [text, setText] = useState(() => toDisplayFormula(value.config.expression ?? '', columns))
  const box = useRef<HTMLTextAreaElement | null>(null)
  // What the formula gives, or what is wrong with it, as typed.
  const check = useMemo(() => {
    if (!text.trim()) return null
    const stored = toStoredFormula(text, columns)
    if (!stored.ok) return { error: stored.error }
    const key = self ?? '__new'
    const entry = planComputed([...columns, { key, label: 'This formula', field_type: 'formula', config: { expression: stored.text } }]).entries.get(key)
    if (!entry || entry.error) return { error: entry?.error ?? 'This formula can’t be worked out.' }
    return { result: entry.result }
  }, [text, columns, self])
  const set = (next: string) => {
    setText(next)
    onChange({ ...value, config: { expression: next } })
  }
  const insert = (snippet: string) => {
    const el = box.current
    const at = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    set(text.slice(0, at) + snippet + text.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + snippet.length, at + snippet.length)
    })
  }
  const refs = [{ key: TITLE_REF, label: TITLE_REF_NAME }, ...columns.filter((c) => c.field_type !== 'person' && c.field_type !== 'relation')]
  return (
    <div className="space-y-2">
      <textarea
        ref={box}
        aria-label="Formula"
        rows={3}
        spellCheck={false}
        className="w-full min-w-0 resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-foreground/30"
        placeholder="{Price} * {Qty}"
        value={text}
        onChange={(e) => set(e.target.value)}
      />
      {check && (
        <p className={cn('text-xs', 'error' in check ? 'text-destructive' : 'text-muted-foreground')} role={'error' in check ? 'alert' : undefined} data-formula-check="">
          {'error' in check ? check.error : check.result && check.result !== 'unknown' ? `Gives ${check.result === 'checkbox' ? 'a checkbox' : `a ${check.result}`}.` : 'Looks right.'}
        </p>
      )}
      <div className="max-h-28 space-y-1.5 overflow-y-auto">
        <div className="flex flex-wrap gap-1">
          {refs.map((c) => (
            <button key={c.key} type="button" className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/60" onClick={() => insert(`{${c.label}}`)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(FORMULA_FUNCTIONS) as Array<keyof typeof FORMULA_FUNCTIONS>).map((fn) => (
            <button
              key={fn}
              type="button"
              title={FORMULA_FUNCTIONS[fn]}
              className="rounded-full bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => insert(fn === 'today' ? 'today()' : `${fn}(`)}
            >
              {fn}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function RollupFields({ value, onChange, columns }: { value: ComputedShape; onChange: (v: ComputedShape) => void; columns: readonly DataColumn[] }) {
  const relations = columns.filter((c) => c.field_type === 'relation' && c.config?.target)
  const relation = relations.find((c) => c.key === value.config.relation) ?? null
  const fn: RollupFn = isRollupFn(value.config.fn) ? value.config.fn : 'count'
  const target = relation?.config?.target
  const fields = useTargetFields(target)
  const field = value.config.field ?? null
  const set = (patch: Partial<CustomFieldConfig>) => onChange({ ...value, config: { relation: value.config.relation, fn, field, ...patch } })
  // A relation picked first, so the form never sits on nothing.
  useEffect(() => {
    if (!relation && relations[0]) set({ relation: relations[0].key })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relation, relations.length])
  if (!relations.length) return <p className="text-xs text-muted-foreground">A rollup reads the records a relation column links. Add a relation column first.</p>
  const choices: TargetField[] = [{ key: TITLE_REF, label: 'Name', field_type: 'text' }, ...(fields ?? [])].filter((f) => FIELD_FITS[fn](f.field_type) && !(f.key === TITLE_REF && fn !== 'list' && fn !== 'count'))
  const needsField = rollupNeedsField(fn)
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Through</span>
        <select aria-label="Relation" className={cn(fieldClass, 'cursor-pointer')} value={relation?.key ?? ''} onChange={(e) => set({ relation: e.target.value, field: null })}>
          {relations.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label} ({r.config?.target?.kind === 'data_row' ? 'rows' : TARGET_NAMES[(r.config?.target?.kind ?? 'contact') as keyof typeof TARGET_NAMES] ?? r.config?.target?.kind})
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="block min-w-0 flex-1 space-y-1">
          <span className="text-xs text-muted-foreground">Show</span>
          <select
            aria-label="Aggregate"
            className={cn(fieldClass, 'cursor-pointer')}
            value={fn}
            onChange={(e) => {
              const next = e.target.value as RollupFn
              const keep = field !== null && choices.some((c) => c.key === field) && FIELD_FITS[next](choices.find((c) => c.key === field)!.field_type)
              set({ fn: next, field: next === 'count' ? null : keep ? field : next === 'list' ? TITLE_REF : null })
            }}
          >
            {ROLLUP_FNS.map((f) => (
              <option key={f} value={f}>{ROLLUP_FN_LABELS[f]}</option>
            ))}
          </select>
        </label>
        {fn !== 'count' && (
          <label className="block min-w-0 flex-1 space-y-1">
            <span className="text-xs text-muted-foreground">Of</span>
            <select aria-label="Field" className={cn(fieldClass, 'cursor-pointer')} value={field ?? ''} onChange={(e) => set({ field: e.target.value || null })}>
              {needsField && <option value="">Pick a field</option>}
              {choices.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {needsField && fields !== null && !choices.length && <p className="text-xs text-muted-foreground">The linked records have no field {ROLLUP_FN_LABELS[fn].toLowerCase()} can read.</p>}
    </div>
  )
}

/** What a computed column is, in a menu: "Formula", "Rollup". */
export const computedTypeLabel = (t: 'formula' | 'rollup') => COLUMN_TYPE_LABELS[t]
