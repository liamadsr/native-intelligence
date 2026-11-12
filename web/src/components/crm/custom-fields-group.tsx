'use client'

/**
 * A record's custom fields (roadmap #8; every kind the entity registry marks
 * `customFields`, phase 6): every field the workspace defined for the
 * record's kind, each editable in place, and a small form to add one. Renders
 * nothing at all while the workspace has no fields for the kind and the
 * person has not opened the form (hide empty widgets). A record the person
 * may only view (the route's `editable: false`: a grant, an initiative that
 * isn't theirs) shows its values as text, with no form.
 *
 * One small editor per type (src/lib/crm/custom-field-types.ts): a select, a
 * row of option chips (multi-select), a checkbox, a member picker (person),
 * linked records with a search to add one (relation), and a text box for the
 * rest, which the server parses (a number, a date, a web address, an email,
 * a phone number, an amount with or without its currency).
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { PropertyGroup } from '@/components/views/property-group'
import { cn } from '@/lib/utils'
import { announceCustomFieldsChanged } from '@/lib/views/custom-field-columns'
import { emitEntityUpdated } from '@/lib/entity-events'
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  RELATION_TARGET_KINDS,
  fieldCurrency,
  formatFieldValue,
  hasOptions,
  relationIds,
  type CurrencyValue,
  type CustomFieldConfig,
  type CustomFieldType,
  type CustomFieldValue,
  type RelationTargetKind,
} from '@/lib/crm/custom-field-types'
import type { CustomFieldEntity } from '@/lib/crm/custom-fields'
import { isMenuSearchKind, menuRowTarget, type MenuSearchResponse } from '@/lib/search/menu-search'

interface FieldRow {
  key: string
  label: string
  field_type: CustomFieldType
  value: CustomFieldValue
}

interface Definition {
  key: string
  options: string[]
  config?: CustomFieldConfig
}

interface Member {
  id: string
  name: string
}

const inputClass =
  'h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-border focus:outline-none'

const chipClass = 'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px]'

/** What a relation's target is called in the add-a-field form. */
export const TARGET_NAMES: Partial<Record<RelationTargetKind, string>> = {
  contact: 'Contacts',
  company: 'Companies',
  action: 'Tasks',
  project: 'Projects',
  initiative: 'Initiatives',
  document: 'Documents',
  capture: 'Meetings',
  flow: 'Flows',
}

export function CustomFieldsGroup({
  entityType,
  recordId,
  title = 'Custom fields',
  showAddWhenEmpty = false,
  onChanged,
}: {
  entityType: CustomFieldEntity
  recordId: string
  title?: string
  /** Offer "Add a field" even before the workspace has any (the deal panel does). */
  showAddWhenEmpty?: boolean
  onChanged?: () => void
}) {
  const [fields, setFields] = useState<FieldRow[] | null>(null)
  const [defs, setDefs] = useState<Definition[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [members, setMembers] = useState<Member[]>([])
  const [editable, setEditable] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/account/custom-fields/values?entity_type=${entityType}&id=${recordId}`)
    if (!res.ok) return
    const json = await res.json()
    setFields(json.fields ?? [])
    setDefs(json.definitions ?? [])
    setLabels(json.labels ?? {})
    setMembers(json.members ?? [])
    setEditable(json.editable !== false)
  }, [entityType, recordId])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (key: string, value: unknown, names?: Record<string, string>) => {
    const res = await fetch('/api/account/custom-fields/values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: entityType, id: recordId, values: { [key]: value } }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      toast.error(json.error || 'Could not save the field')
      void load()
      return
    }
    if (names) setLabels((prev) => ({ ...prev, ...names }))
    // Lists and boards showing this record (a custom column, a board grouped
    // by the field) take the values as stored, without a refetch.
    const saved = (await res.json().catch(() => null)) as { custom_fields?: unknown } | null
    const stored = saved?.custom_fields
    const storedValue = stored && typeof stored === 'object' && !Array.isArray(stored) ? ((stored as Record<string, CustomFieldValue>)[key] ?? null) : (value as CustomFieldValue)
    setFields((prev) => prev?.map((f) => (f.key === key ? { ...f, value: storedValue } : f)) ?? prev)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      emitEntityUpdated({ entityType, id: recordId, fields: { custom_fields: stored } })
    }
    onChanged?.()
  }

  if (!fields) return null
  if (!fields.length && !(showAddWhenEmpty && editable) && !adding) return null

  return (
    <PropertyGroup title={title}>
      <div className="space-y-0.5">
        {fields.map((f) => {
          const def = defs.find((d) => d.key === f.key) ?? { key: f.key, options: [] }
          const text = formatFieldValue(f.field_type, f.value, { labels })
          return (
            <div key={f.key} className="grid grid-cols-[120px_1fr] items-center gap-2 px-3" data-custom-field={f.key}>
              <span className="truncate text-xs text-muted-foreground" title={f.label}>{f.label}</span>
              {editable ? (
                <FieldInput field={f} def={def} labels={labels} members={members} onSave={(v, names) => save(f.key, v, names)} />
              ) : (
                <span className={cn('truncate px-2 text-sm', !text && 'text-muted-foreground')}>{text || 'Empty'}</span>
              )}
            </div>
          )
        })}
      </div>
      {!editable ? null : adding ? (
        <AddFieldForm
          entityType={entityType}
          onDone={(added) => {
            setAdding(false)
            if (added) void load()
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1 flex items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> Add a field
        </button>
      )}
    </PropertyGroup>
  )
}

/** A value as its text box shows it: an amount without its code when it is the field's own. */
function draftOf(field: FieldRow, def: Definition): string {
  const v = field.value
  if (v === null || v === undefined) return ''
  if (field.field_type === 'currency' && typeof v === 'object' && !Array.isArray(v)) {
    const c = v as CurrencyValue
    return c.currency === fieldCurrency(def.config) ? String(c.amount) : `${c.amount} ${c.currency}`
  }
  return typeof v === 'object' ? '' : String(v)
}

const INPUT_TYPE: Partial<Record<CustomFieldType, string>> = { date: 'date', url: 'url', email: 'email', phone: 'tel' }

function FieldInput({
  field,
  def,
  labels,
  members,
  onSave,
}: {
  field: FieldRow
  def: Definition
  labels: Record<string, string>
  members: Member[]
  onSave: (v: unknown, names?: Record<string, string>) => void
}) {
  const initial = draftOf(field, def)
  const [draft, setDraft] = useState(initial)
  useEffect(() => setDraft(initial), [initial])

  switch (field.field_type) {
    case 'select':
      return (
        <select
          className={cn(inputClass, 'cursor-pointer')}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            onSave(e.target.value || null)
          }}
        >
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      )
    case 'multi_select': {
      const chosen = Array.isArray(field.value) ? (field.value as string[]) : []
      return (
        <div className="flex flex-wrap gap-1 px-2 py-0.5">
          {def.options.map((o) => {
            const on = chosen.includes(o)
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                className={cn(chipClass, on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
                onClick={() => {
                  const next = on ? chosen.filter((x) => x !== o) : def.options.filter((x) => x === o || chosen.includes(x))
                  onSave(next.length ? next : null)
                }}
              >
                {o}
              </button>
            )
          })}
        </div>
      )
    }
    case 'checkbox':
      return (
        <label className="flex h-7 items-center px-2">
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer" checked={field.value === true} onChange={(e) => onSave(e.target.checked)} />
        </label>
      )
    case 'person':
      return (
        <select
          className={cn(inputClass, 'cursor-pointer')}
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={(e) => onSave(e.target.value || null)}
        >
          <option value="">—</option>
          {typeof field.value === 'string' && !members.some((m) => m.id === field.value) ? (
            <option value={field.value}>{labels[field.value] ?? 'Someone else'}</option>
          ) : null}
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      )
    case 'relation':
      return <RelationInput field={field} def={def} labels={labels} onSave={onSave} />
  }

  const commit = () => {
    if (draft === initial) return
    if (!draft.trim()) return onSave(null)
    // The server checks and parses it (a number field refuses "12k" rather
    // than clearing the value), so it goes as typed.
    onSave(draft.trim())
  }
  return (
    <input
      className={inputClass}
      type={INPUT_TYPE[field.field_type] ?? 'text'}
      inputMode={field.field_type === 'number' || field.field_type === 'currency' ? 'decimal' : undefined}
      value={draft}
      placeholder={field.field_type === 'currency' ? `Empty (${fieldCurrency(def.config)})` : 'Empty'}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(initial)
      }}
    />
  )
}

/** Records to link: the search menu's for a kind, a table's rows by name (the table grid uses it too). */
export async function findTargets(def: Pick<Definition, 'config'>, query: string): Promise<Array<{ id: string; title: string }>> {
  const target = def.config?.target
  if (!target) return []
  if (target.kind === 'data_row') {
    if (!target.table_id) return []
    const res = await fetch(`/api/account/tables/${target.table_id}/rows?limit=200`)
    if (!res.ok) return []
    const json = (await res.json()) as { rows?: Array<{ id: string; title: string }> }
    const q = query.trim().toLowerCase()
    return (json.rows ?? []).filter((r) => !q || (r.title ?? '').toLowerCase().includes(q)).slice(0, 8).map((r) => ({ id: r.id, title: r.title || 'Untitled' }))
  }
  if (!isMenuSearchKind(target.kind)) return []
  const res = await fetch(`/api/account/search?types=${target.kind}&limit=8&q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const json = (await res.json()) as MenuSearchResponse
  return (json.results[target.kind] ?? []).map((row) => {
    const t = menuRowTarget(row) as { id?: string; title?: string | null }
    return { id: String(t.id ?? ''), title: t.title || 'Untitled' }
  })
}

function RelationInput({
  field,
  def,
  labels,
  onSave,
}: {
  field: FieldRow
  def: Definition
  labels: Record<string, string>
  onSave: (v: unknown, names?: Record<string, string>) => void
}) {
  const ids = relationIds(field.value)
  const multiple = def.config?.multiple === true
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<Array<{ id: string; title: string }>>([])

  useEffect(() => {
    if (!open) return
    let live = true
    const t = setTimeout(() => {
      void findTargets(def, query).then((rows) => live && setFound(rows.filter((r) => r.id && !ids.includes(r.id))))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
    // ids is derived from the value; the search reruns when the value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, def, field.value])

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-0.5">
      {ids.map((id) => (
        <span key={id} className={cn(chipClass, 'text-foreground')} data-linked-record={id}>
          <span className="max-w-[10rem] truncate">{labels[id] ?? 'Linked record'}</span>
          <button type="button" aria-label="Remove" className="text-muted-foreground hover:text-foreground" onClick={() => onSave(ids.filter((x) => x !== id))}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {(multiple || ids.length === 0) &&
        (open ? (
          <div className="relative w-full">
            <input
              autoFocus
              className={cn(inputClass, 'border-border')}
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            />
            {found.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover py-1 shadow-md">
                {found.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="block w-full truncate px-2 py-1 text-left text-sm hover:bg-muted"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setOpen(false)
                      setQuery('')
                      onSave(multiple ? [...ids, r.id] : [r.id], { [r.id]: r.title })
                    }}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
            {ids.length ? '+ Add' : 'Link a record'}
          </button>
        ))}
    </div>
  )
}

/** The kinds a new relation field can link to from this form (a table's rows are linked from the table). */
const FORM_TARGETS = RELATION_TARGET_KINDS.filter((k) => k !== 'data_row')

export function AddFieldForm({ entityType, onDone }: { entityType: CustomFieldEntity; onDone: (added: boolean) => void }) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<CustomFieldType>('text')
  const [options, setOptions] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [target, setTarget] = useState<RelationTargetKind>('contact')
  const [multiple, setMultiple] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!label.trim()) return onDone(false)
    setBusy(true)
    const config: CustomFieldConfig | undefined =
      type === 'currency' ? { currency: currency.trim().toUpperCase() } : type === 'relation' ? { target: { kind: target }, multiple } : undefined
    const res = await fetch('/api/account/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_type: entityType,
        label,
        field_type: type,
        options: hasOptions(type) ? options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
        config,
      }),
    })
    setBusy(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      toast.error(json.error || 'Could not add the field')
      return
    }
    // Views list it at once: as a filter, a sort, a grouping, a column.
    announceCustomFieldsChanged()
    onDone(true)
  }

  return (
    <div className="mt-1 space-y-1.5 px-3">
      <div className="flex gap-1.5">
        <input
          autoFocus
          className={cn(inputClass, 'border-border')}
          placeholder="Field name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onDone(false)
          }}
        />
        <select className={cn(inputClass, 'w-28 border-border')} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
          {CUSTOM_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>
      {hasOptions(type) && (
        <input className={cn(inputClass, 'border-border')} placeholder="Options, comma-separated" value={options} onChange={(e) => setOptions(e.target.value)} />
      )}
      {type === 'currency' && (
        <input className={cn(inputClass, 'w-24 border-border')} placeholder="USD" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency" />
      )}
      {type === 'relation' && (
        <div className="flex items-center gap-2">
          <select className={cn(inputClass, 'border-border')} value={target} onChange={(e) => setTarget(e.target.value as RelationTargetKind)} aria-label="Links to">
            {FORM_TARGETS.map((k) => (
              <option key={k} value={k}>{TARGET_NAMES[k] ?? k}</option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Several
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onDone(false)}>Cancel</button>
        <button type="button" disabled={busy} className="font-medium text-foreground disabled:opacity-50" onClick={() => void submit()}>Add</button>
      </div>
    </div>
  )
}
