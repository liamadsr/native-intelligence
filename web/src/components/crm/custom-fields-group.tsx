'use client'

/**
 * A record's custom fields (roadmap #8): every field the workspace defined for
 * deals, contacts or companies, each editable in place, and a small form to add
 * one. Renders nothing at all while the workspace has no fields and the person
 * has not opened the form (hide empty widgets).
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { PropertyGroup } from '@/components/views/property-group'
import { cn } from '@/lib/utils'
import type { CustomFieldEntity, CustomFieldType, CustomFieldValue } from '@/lib/crm/custom-fields'

interface FieldRow {
  key: string
  label: string
  field_type: CustomFieldType
  value: CustomFieldValue
}

interface Definition {
  key: string
  options: string[]
}

const inputClass =
  'h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-border focus:outline-none'

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
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/account/custom-fields/values?entity_type=${entityType}&id=${recordId}`)
    if (!res.ok) return
    const json = await res.json()
    setFields(json.fields ?? [])
    setDefs(json.definitions ?? [])
  }, [entityType, recordId])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (key: string, value: CustomFieldValue) => {
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
    setFields((prev) => prev?.map((f) => (f.key === key ? { ...f, value } : f)) ?? prev)
    onChanged?.()
  }

  if (!fields) return null
  if (!fields.length && !showAddWhenEmpty && !adding) return null

  return (
    <PropertyGroup title={title}>
      <div className="space-y-0.5">
        {fields.map((f) => (
          <div key={f.key} className="grid grid-cols-[120px_1fr] items-center gap-2 px-3" data-custom-field={f.key}>
            <span className="truncate text-xs text-muted-foreground" title={f.label}>{f.label}</span>
            <FieldInput field={f} options={defs.find((d) => d.key === f.key)?.options ?? []} onSave={(v) => save(f.key, v)} />
          </div>
        ))}
      </div>
      {adding ? (
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

function FieldInput({ field, options, onSave }: { field: FieldRow; options: string[]; onSave: (v: CustomFieldValue) => void }) {
  const [draft, setDraft] = useState(field.value === null ? '' : String(field.value))
  useEffect(() => setDraft(field.value === null ? '' : String(field.value)), [field.value])

  if (field.field_type === 'select') {
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
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    )
  }
  const commit = () => {
    const before = field.value === null ? '' : String(field.value)
    if (draft === before) return
    if (!draft.trim()) return onSave(null)
    onSave(field.field_type === 'number' ? Number(draft.replace(/[,\s]/g, '')) : draft.trim())
  }
  return (
    <input
      className={inputClass}
      type={field.field_type === 'date' ? 'date' : 'text'}
      inputMode={field.field_type === 'number' ? 'decimal' : undefined}
      value={draft}
      placeholder="Empty"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(field.value === null ? '' : String(field.value))
      }}
    />
  )
}

function AddFieldForm({ entityType, onDone }: { entityType: CustomFieldEntity; onDone: (added: boolean) => void }) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<CustomFieldType>('text')
  const [options, setOptions] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!label.trim()) return onDone(false)
    setBusy(true)
    const res = await fetch('/api/account/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_type: entityType,
        label,
        field_type: type,
        options: type === 'select' ? options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
      }),
    })
    setBusy(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      toast.error(json.error || 'Could not add the field')
      return
    }
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
        <select className={cn(inputClass, 'w-24 border-border')} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="date">Date</option>
          <option value="select">Select</option>
        </select>
      </div>
      {type === 'select' && (
        <input className={cn(inputClass, 'border-border')} placeholder="Options, comma-separated" value={options} onChange={(e) => setOptions(e.target.value)} />
      )}
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onDone(false)}>Cancel</button>
        <button type="button" disabled={busy} className="font-medium text-foreground disabled:opacity-50" onClick={() => void submit()}>Add</button>
      </div>
    </div>
  )
}
