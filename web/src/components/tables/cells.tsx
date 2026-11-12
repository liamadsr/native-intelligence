'use client'

/**
 * A table cell, read and edited, for every field type (Tables, phase 3). The
 * grid (./table-grid.tsx) and the row's panel (./row-panel.tsx) both use
 * these. Values read as formatFieldValue reads them; an edit hands back what
 * the person gave (typed text, a picked option, a member, linked records),
 * and the caller coerces it to the stored form (coerceCustomValue), so the
 * cell then shows what was stored, not what was typed.
 *
 *   text, number, url, email, phone, currency   a text box in the cell
 *   date                                         a text box and a calendar
 *   select, multi-select, person, relation       a picker (relation searches
 *                                                the target kind, or another
 *                                                table's rows: findTargets)
 *   checkbox                                     toggles, no editor
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  AtSign,
  CalendarDays,
  Check,
  CircleChevronDown,
  Coins,
  Hash,
  Link,
  ListChecks,
  Phone,
  SquareCheck,
  Type,
  User,
  type LucideIcon,
} from 'lucide-react'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { findTargets } from '@/components/crm/custom-fields-group'
import { cn } from '@/lib/utils'
import {
  fieldCurrency,
  formatFieldValue,
  relationIds,
  type CurrencyValue,
  type CustomFieldConfig,
  type CustomFieldType,
} from '@/lib/crm/custom-field-types'
import { lenientDate } from '@/lib/tables/grid-edits'
import type { EditMove } from '@/components/grid/selection'

/** What a cell needs to know about its column (the title column is a text one). */
export interface CellColumn {
  key: string
  label: string
  field_type: CustomFieldType
  options: string[]
  config?: CustomFieldConfig
}

export interface Member {
  id: string
  name: string
}

export const TYPE_ICONS: Record<CustomFieldType, LucideIcon> = {
  text: Type,
  number: Hash,
  date: CalendarDays,
  select: CircleChevronDown,
  multi_select: ListChecks,
  checkbox: SquareCheck,
  url: Link,
  email: AtSign,
  phone: Phone,
  person: User,
  currency: Coins,
  relation: ArrowUpRight,
}

const chip = 'inline-flex max-w-full shrink-0 items-center truncate rounded-full border border-border/60 px-2 py-0.5 text-[11px] leading-4 text-foreground'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

const RIGHT_ALIGNED = new Set<CustomFieldType>(['number', 'currency'])

/** A cell's value as it reads. */
export function CellDisplay({
  column,
  value,
  labels,
  onToggle,
}: {
  column: CellColumn
  value: unknown
  labels: Readonly<Record<string, string>>
  /** A checkbox the reader may change: clicking it toggles. */
  onToggle?: () => void
}) {
  const t = column.field_type
  if (t === 'checkbox') {
    const on = value === true
    const box = (
      <span className={cn('flex h-4 w-4 items-center justify-center rounded-[4px] border', on ? 'border-foreground bg-foreground text-background' : 'border-border')}>
        {on && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
    )
    return (
      <span className="flex h-full w-full items-center px-2">
        {onToggle ? (
          <button type="button" role="checkbox" aria-checked={on} aria-label={column.label} onClick={onToggle} className="rounded-[4px]">
            {box}
          </button>
        ) : (
          <span role="img" aria-label={on ? 'Yes' : 'No'}>{box}</span>
        )}
      </span>
    )
  }
  if (t === 'select' && typeof value === 'string') {
    return (
      <span className="flex h-full min-w-0 items-center px-2">
        <span className={chip}>{value}</span>
      </span>
    )
  }
  if (t === 'multi_select' && Array.isArray(value)) {
    return (
      <span className="flex h-full min-w-0 items-center gap-1 overflow-hidden px-2">
        {value.map((v) => (
          <span key={String(v)} className={chip}>{String(v)}</span>
        ))}
      </span>
    )
  }
  if (t === 'person' && typeof value === 'string') {
    const name = labels[value] ?? 'Someone'
    return (
      <span className="flex h-full min-w-0 items-center gap-1.5 px-2 text-sm">
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground">{initials(name)}</span>
        <span className="truncate">{name}</span>
      </span>
    )
  }
  if (t === 'relation') {
    const ids = relationIds(value)
    if (!ids.length) return null
    return (
      <span className="flex h-full min-w-0 items-center gap-1 overflow-hidden px-2">
        {ids.map((id) => (
          <span key={id} className={cn(chip, 'gap-1')} data-linked-record={id}>
            <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{labels[id] ?? 'Linked record'}</span>
          </span>
        ))}
      </span>
    )
  }
  const text = formatFieldValue(t, value, { labels })
  if (!text) return null
  return (
    <span className={cn('block w-full truncate px-2 text-sm', RIGHT_ALIGNED.has(t) && 'text-right tabular-nums', (t === 'url' || t === 'email') && 'text-foreground/90 underline decoration-border underline-offset-2')}>
      {text}
    </span>
  )
}

/** A value as its text box starts: an amount without its code when it's the column's own. */
export function draftText(column: CellColumn, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (column.field_type === 'currency' && typeof value === 'object' && !Array.isArray(value)) {
    const c = value as CurrencyValue
    return c.currency === fieldCurrency(column.config) ? String(c.amount) : `${c.amount} ${c.currency}`
  }
  return typeof value === 'object' ? '' : String(value)
}

export interface EditorProps {
  column: CellColumn
  value: unknown
  /** The key that started the edit: it replaces the value. */
  initial?: string
  labels: Readonly<Record<string, string>>
  members: readonly Member[]
  /** The new value as given (the caller coerces it); `names` for records just linked. */
  onCommit: (raw: unknown, names?: Record<string, string>) => void
  done: (move?: EditMove) => void
  cancel: () => void
}

/** The editor for a cell's type. A checkbox has none (it toggles). */
export function CellEditor(props: EditorProps) {
  switch (props.column.field_type) {
    case 'select':
    case 'multi_select':
    case 'person':
    case 'relation':
      return <PickerEditor {...props} />
    case 'date':
      return <DateEditor {...props} />
    case 'checkbox':
      return null
    default:
      return <TextEditor {...props} />
  }
}

const moveFor = (e: React.KeyboardEvent): EditMove | 'none' => {
  if (e.key === 'Enter' && !e.altKey) return e.shiftKey ? 'up' : 'down'
  if (e.key === 'Tab') return e.shiftKey ? 'left' : 'right'
  return 'none'
}

function TextEditor({ column, value, initial, onCommit, done, cancel }: EditorProps) {
  const original = draftText(column, value)
  const [draft, setDraft] = useState(initial ?? original)
  const ref = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const finish = (move?: EditMove) => {
    if (finished.current) return
    finished.current = true
    if (draft !== original) onCommit(draft.trim() ? draft : null)
    done(move)
  }
  const numeric = column.field_type === 'number' || column.field_type === 'currency'
  return (
    <input
      ref={ref}
      aria-label={column.label}
      className={cn('h-full w-full min-w-0 bg-background px-2 text-sm outline-none', numeric && 'text-right tabular-nums')}
      inputMode={numeric ? 'decimal' : column.field_type === 'email' ? 'email' : column.field_type === 'phone' ? 'tel' : column.field_type === 'url' ? 'url' : undefined}
      placeholder={column.field_type === 'currency' ? fieldCurrency(column.config) : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish()}
      onKeyDown={(e) => {
        const move = moveFor(e)
        if (move !== 'none') {
          e.preventDefault()
          finish(move)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finished.current = true
          cancel()
        }
      }}
    />
  )
}

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function DateEditor({ column, value, initial, onCommit, done, cancel }: EditorProps) {
  const original = typeof value === 'string' ? value : ''
  const [draft, setDraft] = useState(initial ?? original)
  const finished = useRef(false)
  const finish = (next: string | null, move?: EditMove) => {
    if (finished.current) return
    finished.current = true
    if ((next ?? '') !== original) onCommit(next ? lenientDate(next) : null)
    done(move)
  }
  const selected = useMemo(() => {
    const iso = lenientDate(draft)
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
  }, [draft])
  return (
    <Popover open onOpenChange={(open) => !open && finish(draft.trim() || null)}>
      <PopoverAnchor asChild>
        <div className="flex h-full w-full items-center bg-background">
          <CellDisplay column={column} value={original || null} labels={{}} />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={2} className="w-auto rounded-xl p-1">
        <input
          autoFocus
          aria-label={column.label}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
          placeholder="YYYY-MM-DD"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            const move = moveFor(e)
            if (move !== 'none') {
              e.preventDefault()
              finish(draft.trim() || null, move)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              finished.current = true
              cancel()
            }
          }}
        />
        <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(d) => d && finish(isoOf(d), null)} />
      </PopoverContent>
    </Popover>
  )
}

interface Choice {
  id: string
  label: string
}

/**
 * A searchable list in a popover: a select's options, a multi-select's
 * (toggled, it stays open), the workspace's members, or records to link
 * (searched as you type, findTargets).
 */
function PickerEditor({ column, value, initial, labels, members, onCommit, done, cancel }: EditorProps) {
  const t = column.field_type
  const multi = t === 'multi_select' || (t === 'relation' && column.config?.multiple === true)
  const chosen = useMemo<string[]>(() => {
    if (t === 'relation') return relationIds(value)
    if (Array.isArray(value)) return value.map(String)
    return typeof value === 'string' ? [value] : []
  }, [t, value])
  const [picked, setPicked] = useState<string[]>(chosen)
  const [query, setQuery] = useState(initial ?? '')
  const [found, setFound] = useState<Choice[] | null>(null)
  const [hi, setHi] = useState(0)
  const finished = useRef(false)

  // Records to link come from a search; the rest are lists in hand.
  useEffect(() => {
    if (t !== 'relation') return
    let live = true
    const timer = setTimeout(() => {
      void findTargets({ config: column.config }, query).then((rows) => {
        if (live) setFound(rows.filter((r) => r.id).map((r) => ({ id: r.id, label: r.title })))
      })
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [t, column.config, query])

  const choices = useMemo<Choice[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (c: Choice) => !q || c.label.toLowerCase().includes(q)
    if (t === 'select' || t === 'multi_select') return column.options.map((o) => ({ id: o, label: o })).filter(match)
    if (t === 'person') return members.map((m) => ({ id: m.id, label: m.name })).filter(match)
    // Linked ones first, then what the search found.
    const linked = picked.map((id) => ({ id, label: labels[id] ?? 'Linked record' })).filter(match)
    return [...linked, ...(found ?? []).filter((r) => !picked.includes(r.id))]
  }, [t, column.options, members, picked, labels, found, query])

  useEffect(() => setHi(0), [query])

  const close = (move?: EditMove) => {
    if (finished.current) return
    finished.current = true
    done(move)
  }
  const pick = (c: Choice) => {
    const on = picked.includes(c.id)
    const names = t === 'relation' ? { [c.id]: c.label } : undefined
    if (!multi) {
      finished.current = true
      if (!on || picked.length !== 1) onCommit(t === 'relation' ? [c.id] : c.id, names)
      done(null)
      return
    }
    const next = on ? picked.filter((x) => x !== c.id) : t === 'multi_select' ? column.options.filter((o) => o === c.id || picked.includes(o)) : [...picked, c.id]
    setPicked(next)
    onCommit(next.length ? next : null, names)
  }
  const clear = () => {
    finished.current = true
    if (picked.length) onCommit(null)
    done(null)
  }

  // The cell keeps showing its value while the picker is open.
  const shown = t === 'relation' ? picked : t === 'multi_select' ? picked : picked[0] ?? null
  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      <PopoverAnchor asChild>
        <div className="flex h-full w-full items-center bg-background">
          <CellDisplay column={column} value={Array.isArray(shown) && !shown.length ? null : shown} labels={labels} />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={2} className="w-64 rounded-xl p-1" data-cell-picker="">
        <input
          autoFocus
          aria-label={column.label}
          role="combobox"
          aria-expanded
          aria-controls={`${column.key}-choices`}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
          placeholder={t === 'relation' ? 'Search' : t === 'person' ? 'Find someone' : 'Find an option'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHi((h) => Math.min(h + 1, Math.max(0, choices.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(0, h - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const c = choices[hi]
              if (c) pick(c)
              else close(null)
            } else if (e.key === 'Tab') {
              e.preventDefault()
              close(e.shiftKey ? 'left' : 'right')
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (multi) close(null)
              else {
                finished.current = true
                cancel()
              }
            }
          }}
        />
        <div id={`${column.key}-choices`} role="listbox" aria-multiselectable={multi || undefined} className="mt-1 max-h-60 overflow-y-auto">
          {choices.map((c, i) => {
            const on = picked.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={on}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm', i === hi ? 'bg-muted' : 'hover:bg-muted/60')}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(c)}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{on && <Check className="h-3.5 w-3.5" />}</span>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
              </button>
            )
          })}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t === 'relation' && found === null ? 'Searching…' : 'Nothing matches'}</p>
          )}
          {!multi && picked.length > 0 && (
            <button type="button" className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60" onMouseDown={(e) => e.preventDefault()} onClick={clear}>
              Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A column's header: its type's icon and its name. */
export function ColumnLabel({ type, label, children }: { type: CustomFieldType; label: string; children?: ReactNode }) {
  const Icon = TYPE_ICONS[type]
  return (
    <span className="flex h-full min-w-0 items-center gap-1.5 px-2">
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </span>
  )
}
