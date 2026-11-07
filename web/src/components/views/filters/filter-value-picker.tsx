'use client'

import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandInput, CommandList, CommandItem, CommandEmpty,
} from '@/components/ui/command'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { format, parseISO } from 'date-fns'
import type {
  FilterFieldDefinition, FilterOperator, FilterValue, RangeValue, RelativeDateValue, ViewEntityType,
} from '@/lib/views/types'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { groupLabelsByGroupName, type LabelScope } from '@/lib/labels/utils'
import { CommandGroup } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { numberUnitFor, percentToStored, storedToPercent, type NumberUnit } from './field-traits'

const ENTITY_TYPE_TO_LABEL_SCOPE: Partial<Record<ViewEntityType, LabelScope>> = {
  action: 'action',
  capture: 'capture',
  email_thread: 'email_thread',
  project: 'project',
  initiative: 'initiative',
}

interface FilterValuePickerProps {
  fieldDef: FilterFieldDefinition
  operator: FilterOperator
  value: FilterValue
  onChange: (value: FilterValue) => void
  entityType?: ViewEntityType
}

// Entity type → { endpoint, nameKey, label }
const ENTITY_PICKER_CONFIG: Record<string, { endpoint: string; nameKey: string; label: string }> = {
  project: { endpoint: '/api/account/projects', nameKey: 'name', label: 'Project' },
  team: { endpoint: '/api/account/teams', nameKey: 'name', label: 'Team' },
  member: { endpoint: '/api/account/workspace/members', nameKey: 'display_name', label: 'Member' },
  initiative: { endpoint: '/api/account/initiatives', nameKey: 'name', label: 'Initiative' },
  cycle: { endpoint: '/api/account/cycles', nameKey: 'name', label: 'Cycle' },
  milestone: { endpoint: '/api/account/milestones', nameKey: 'name', label: 'Milestone' },
  capture: { endpoint: '/api/account/captures', nameKey: 'title', label: 'Capture' },
  action: { endpoint: '/api/account/actions', nameKey: 'title', label: 'Action' },
  contact: { endpoint: '/api/account/contacts', nameKey: 'full_name', label: 'Contact' },
  company: { endpoint: '/api/account/companies', nameKey: 'name', label: 'Company' },
  // The CRM's "From list" filter (migration 259): a contact or company carries
  // the ids of the prospect lists it was published from.
  prospect_list: { endpoint: '/api/account/prospecting/lists', nameKey: 'name', label: 'List' },
}

/**
 * Does the editor this (field, operator) pair renders take FREE TYPING?
 *
 * Mirrors the switch in `FilterValuePicker` below and has to keep mirroring it.
 * `FilterChip` reads this to decide whether a change is buffered on a trailing
 * timer or pushed up the instant it arrives, and the two ways of getting it
 * wrong are both visible: a typed field classified as a selection costs a query
 * per keystroke, and a selection classified as typed puts 300 ms of lag between
 * a click and the list redrawing.
 */
export function isFreeTypedValue(fieldDef: FilterFieldDefinition, operator: FilterOperator): boolean {
  // Presence operators render no editor at all, so there is nothing to buffer.
  if (operator === 'is_empty' || operator === 'is_not_empty') return false

  switch (fieldDef.type) {
    case 'text':
    case 'contact_email':
    case 'tag':
    case 'number':
      return true
    // A relative window is a COUNT typed into a box between two selects. The
    // whole value is buffered, selects included — they redraw from the buffer,
    // so they still answer a click instantly and it is only the query that
    // waits, which is the point. An absolute date is a click in a calendar and
    // stays immediate.
    case 'date':
      return operator === 'is_relative'
    default:
      return false
  }
}

export function FilterValuePicker({ fieldDef, operator, value, onChange, entityType }: FilterValuePickerProps) {
  if (operator === 'is_empty' || operator === 'is_not_empty') return null

  const isMulti = ['is_any_of', 'is_none_of'].includes(operator)

  switch (fieldDef.type) {
    case 'enum':
      if (typeof fieldDef.options === 'string') {
        // Dynamic enum — fetch options from API (e.g., 'workflow_states')
        return <DynamicEnumPicker source={fieldDef.options} isMulti={isMulti} value={value} onChange={onChange} />
      }
      return <EnumPicker fieldDef={fieldDef} isMulti={isMulti} value={value} onChange={onChange} />
    case 'boolean':
      return (
        <button
          className="px-2 font-medium text-foreground hover:text-primary text-xs"
          onClick={() => onChange(value === true ? false : true)}
        >
          {value === true ? 'Yes' : value === false ? 'No' : 'Select...'}
        </button>
      )
    case 'text':
    case 'contact_email':
      return (
        <Input
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          className="w-28 h-6 text-xs border-0 bg-transparent p-0 px-2 focus-visible:ring-0"
          placeholder="Type..."
        />
      )
    case 'number': {
      // A number field may be stored in a unit nobody reads it in — see
      // `numberUnitFor`. The unit belongs to the FIELD, so both editors below
      // take it and neither knows which field it is looking at.
      const unit = numberUnitFor(fieldDef)
      // `between` is a RANGE — the query engine reads `{ from, to }` — so it
      // gets two fields. One field under "between" was a filter that could
      // never be satisfied.
      if (operator === 'between') return <NumberRangePicker value={value} onChange={onChange} unit={unit} />
      return <NumberInput value={value} onChange={onChange} unit={unit} />
    }
    case 'date': {
      if (operator === 'is_relative') return <RelativeDatePicker value={value as RelativeDateValue} onChange={onChange} />
      const dayOnly = isDayOnlyDateField(fieldDef)
      if (operator === 'between') return <DateRangePicker value={value} onChange={onChange} dayOnly={dayOnly} />
      return <DatePicker value={value as string} onChange={onChange} dayOnly={dayOnly} />
    }
    case 'label':
      return <LabelPicker value={value} onChange={onChange} isMulti={['includes', 'excludes'].includes(operator)} scope={entityType ? ENTITY_TYPE_TO_LABEL_SCOPE[entityType] : undefined} />
    case 'tag':
      return (
        <Input
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          className="w-28 h-6 text-xs border-0 bg-transparent p-0 px-2 focus-visible:ring-0"
          placeholder="Tag..."
        />
      )
    case 'relation':
      // Relations only support is_empty/is_not_empty (handled above)
      return null
    default: {
      // All remaining entity-reference types use EntityPicker
      const pickerConfig = ENTITY_PICKER_CONFIG[fieldDef.type]
      if (pickerConfig) {
        return (
          <EntityPicker
            value={value}
            onChange={onChange}
            isMulti={isMulti}
            endpoint={pickerConfig.endpoint}
            nameKey={pickerConfig.nameKey}
            label={pickerConfig.label}
          />
        )
      }
      return <span className="px-2 text-muted-foreground text-xs">—</span>
    }
  }
}

// Enum picker using Command + Popover with checkboxes (static options)
function EnumPicker({
  fieldDef, isMulti, value, onChange,
}: {
  fieldDef: FilterFieldDefinition
  isMulti: boolean
  value: FilterValue
  onChange: (value: FilterValue) => void
}) {
  const [open, setOpen] = React.useState(false)
  const options = Array.isArray(fieldDef.options) ? fieldDef.options : []
  const selected = isMulti ? (Array.isArray(value) ? value : []) : []

  const toggleOption = (opt: string) => {
    if (isMulti) {
      const arr = Array.isArray(value) ? [...(value as string[])] : []
      const idx = arr.indexOf(opt)
      if (idx >= 0) arr.splice(idx, 1); else arr.push(opt)
      onChange(arr)
    } else {
      onChange(opt)
      setOpen(false)
    }
  }

  const displayValue = isMulti
    ? selected.length > 0 ? `${selected.length} selected` : 'Select...'
    : (value as string) ? String(value).replace(/_/g, ' ') : 'Select...'

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button className="px-2 font-medium text-foreground hover:text-primary text-xs truncate max-w-[150px] capitalize">
          {displayValue}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start" onOpenAutoFocus={e => e.preventDefault()}>
        <Command>
          <CommandInput placeholder="Search..." className="h-8" />
          <CommandList>
            <CommandEmpty>No options found.</CommandEmpty>
            {options.map(opt => {
              const isSelected = isMulti ? selected.includes(opt) : value === opt
              return (
                <CommandItem key={opt} value={opt} onSelect={() => toggleOption(opt)} className="flex items-center gap-2">
                  {isMulti && <Checkbox checked={isSelected} className="h-3.5 w-3.5" />}
                  <span className="capitalize">{opt.replace(/_/g, ' ')}</span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Dynamic enum picker — fetches options from an API endpoint (e.g., workflow_states)
function DynamicEnumPicker({
  source, isMulti, value, onChange,
}: {
  source: string
  isMulti: boolean
  value: FilterValue
  onChange: (value: FilterValue) => void
}) {
  const [open, setOpen] = React.useState(false)
  // `ids`: every id behind the option. Workflow states are per team, so one
  // name ("Todo") is a row in each team; picking it must match all of them.
  const [options, setOptions] = React.useState<{ id: string; name: string; color?: string; ids: string[] }[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const selected = isMulti ? (Array.isArray(value) ? value : []) : []

  React.useEffect(() => {
    if (loaded) return
    if (source === 'workflow_states') {
      // Fetch all teams, then all workflow states across them
      fetch('/api/account/teams')
        .then(r => r.ok ? r.json() : null)
        .then(async (json) => {
          if (!json?.teams?.length) { setLoaded(true); return }
          const byName = new Map<string, { id: string; name: string; color?: string; ids: string[] }>()
          for (const team of json.teams as { id: string }[]) {
            const res = await fetch(`/api/account/workflow-states?team_id=${team.id}`)
            if (!res.ok) continue
            const statesJson = await res.json()
            for (const s of (statesJson.states || []) as { id: string; name: string; color?: string; category?: string }[]) {
              // One option per name, holding every team's id for it.
              const opt = byName.get(s.name)
              if (opt) opt.ids.push(s.id)
              else byName.set(s.name, { id: s.id, name: s.name, color: s.color, ids: [s.id] })
            }
          }
          setOptions(Array.from(byName.values()))
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    } else {
      setLoaded(true)
    }
  }, [loaded, source])

  const toggleOption = (opt: { id: string; ids: string[] }) => {
    if (isMulti) {
      // A multi pick takes (or drops) every team's id for the name.
      const arr = Array.isArray(value) ? (value as string[]) : []
      const on = opt.ids.some(id => arr.includes(id))
      onChange(on ? arr.filter(id => !opt.ids.includes(id)) : [...arr, ...opt.ids.filter(id => !arr.includes(id))])
    } else {
      // A single value holds one id (the engine compares one uuid).
      onChange(opt.id)
      setOpen(false)
    }
  }

  const displayValue = React.useMemo(() => {
    if (isMulti) {
      if (selected.length === 0) return 'Select...'
      const picked = options.filter(o => o.ids.some(id => selected.includes(id))).length
      return `${picked || selected.length} selected`
    }
    const match = options.find(o => o.ids.includes(value as string))
    return match?.name || (value ? 'Loading...' : 'Select...')
  }, [value, options, isMulti, selected])

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button className="px-2 font-medium text-foreground hover:text-primary text-xs truncate max-w-[150px]">
          {displayValue}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start" onOpenAutoFocus={e => e.preventDefault()}>
        <Command>
          <CommandInput placeholder="Search..." className="h-8" />
          <CommandList>
            <CommandEmpty>{loaded ? 'No options found.' : 'Loading...'}</CommandEmpty>
            {options.map(opt => {
              const isSelected = isMulti ? opt.ids.some(id => selected.includes(id)) : opt.ids.includes(value as string)
              return (
                <CommandItem key={opt.id} value={opt.name} onSelect={() => toggleOption(opt)} className="flex items-center gap-2">
                  {isMulti && <Checkbox checked={isSelected} className="h-3.5 w-3.5" />}
                  {opt.color && <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: opt.color }} />}
                  <span className="truncate">{opt.name}</span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Label picker — fetches workspace labels (scoped) and shows colored dots with group headers
function LabelPicker({
  value, onChange, isMulti, scope,
}: {
  value: FilterValue
  onChange: (value: FilterValue) => void
  isMulti: boolean
  scope?: LabelScope
}) {
  const [open, setOpen] = React.useState(false)
  const { labels: options, grouped, loading } = useScopedLabels(scope)
  const selected = isMulti ? (Array.isArray(value) ? value : []) : []

  const toggleOption = (id: string) => {
    if (isMulti) {
      const arr = Array.isArray(value) ? [...(value as string[])] : []
      const idx = arr.indexOf(id)
      if (idx >= 0) arr.splice(idx, 1); else arr.push(id)
      onChange(arr)
    } else {
      onChange(id)
      setOpen(false)
    }
  }

  const displayValue = React.useMemo(() => {
    if (isMulti) {
      return selected.length > 0 ? `${selected.length} selected` : 'Select...'
    }
    const match = options.find(o => o.id === value)
    return match?.name || (value ? 'Loading...' : 'Select...')
  }, [value, options, isMulti, selected])

  const hasNamedGroups = grouped.some(g => g.groupName !== null)

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button className="px-2 font-medium text-foreground hover:text-primary text-xs truncate max-w-[150px]">
          {displayValue}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start" onOpenAutoFocus={e => e.preventDefault()}>
        <Command>
          <CommandInput placeholder="Search labels..." className="h-8" />
          <CommandList>
            <CommandEmpty>{loading ? 'Loading...' : 'No labels found.'}</CommandEmpty>
            {grouped.map(group => (
              <CommandGroup
                key={group.groupName ?? '__ungrouped'}
                heading={hasNamedGroups ? (group.groupName ?? 'Other') : undefined}
              >
                {group.labels.map(opt => {
                  const isSelected = isMulti ? selected.includes(opt.id) : value === opt.id
                  return (
                    <CommandItem key={opt.id} value={opt.name} onSelect={() => toggleOption(opt.id)} className="flex items-center gap-2">
                      {isMulti && <Checkbox checked={isSelected} className="h-3.5 w-3.5" />}
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: opt.color }} />
                      <span className="truncate">{opt.name}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Date picker using DateTimePicker
/** A `{ from, to }` out of whatever the filter currently holds — a half-built
 *  range, or a scalar left over from switching operators. */
function asRange(value: FilterValue): Partial<RangeValue> {
  if (value && typeof value === 'object' && !Array.isArray(value) && ('from' in value || 'to' in value)) {
    return value as Partial<RangeValue>
  }
  return {}
}

// ─── Numbers, in whatever unit the reader uses ────────────────────────────────

/** What the input SHOWS for a stored value: the number itself, or its percent
 *  face. Empty stays empty — a number field with no value yet is not zero. */
function numberDisplay(stored: FilterValue | undefined, unit: NumberUnit | undefined): number | string {
  if (stored === '' || stored === null || stored === undefined) return ''
  const n = typeof stored === 'number' ? stored : Number(stored)
  if (!Number.isFinite(n)) return ''
  return unit === 'percent' ? storedToPercent(n) : n
}

/** What a typed input STORES. The empty string is preserved rather than
 *  coerced: `Number('')` is 0, and a cleared box that silently means "0" is a
 *  filter the user never wrote. */
function numberValue(raw: string, unit: NumberUnit | undefined): number | string {
  if (raw === '') return ''
  const n = Number(raw)
  if (!Number.isFinite(n)) return ''
  return unit === 'percent' ? percentToStored(n) : n
}

/** The `%` sign is an AFFORDANCE, not decoration: without it the box shows a
 *  bare 70 against a column whose values run 0..1, and there is nothing on
 *  screen to say which of the two the reader is looking at. */
function PercentSuffix() {
  return <span className="pr-2 text-muted-foreground text-xs">%</span>
}

function NumberInput({
  value, onChange, unit,
}: {
  value: FilterValue
  onChange: (v: FilterValue) => void
  unit?: NumberUnit
}) {
  const isPercent = unit === 'percent'
  return (
    <span className="flex items-center">
      <Input
        type="number"
        min={isPercent ? 0 : undefined}
        max={isPercent ? 100 : undefined}
        value={numberDisplay(value, unit)}
        onChange={e => onChange(numberValue(e.target.value, unit))}
        className={cn(
          'h-6 text-xs border-0 bg-transparent p-0 px-2 focus-visible:ring-0',
          isPercent ? 'w-14 pr-0' : 'w-16',
        )}
      />
      {isPercent && <PercentSuffix />}
    </span>
  )
}

// Two numbers — the `between` editor for a number field.
function NumberRangePicker({
  value, onChange, unit,
}: {
  value: FilterValue
  onChange: (v: FilterValue) => void
  unit?: NumberUnit
}) {
  const isPercent = unit === 'percent'
  const range = asRange(value)
  const update = (partial: Partial<RangeValue>) => onChange({ ...range, ...partial } as RangeValue)
  const field = (key: 'from' | 'to', placeholder: string) => (
    <Input
      type="number"
      min={isPercent ? 0 : undefined}
      max={isPercent ? 100 : undefined}
      aria-label={key === 'from' ? 'From' : 'To'}
      placeholder={placeholder}
      value={numberDisplay(range[key], unit)}
      onChange={e => update({ [key]: numberValue(e.target.value, unit) } as Partial<RangeValue>)}
      className={cn(
        'h-6 text-xs border-0 bg-transparent p-0 px-2 focus-visible:ring-0',
        isPercent ? 'w-12 pr-0' : 'w-14',
      )}
    />
  )
  return (
    <span className="flex items-center">
      {field('from', 'min')}
      {isPercent && <PercentSuffix />}
      <span className="text-muted-foreground text-xs">–</span>
      {field('to', 'max')}
      {isPercent && <PercentSuffix />}
    </span>
  )
}

/**
 * Fields stored in a Postgres `date` column (a calendar day, no time, no zone)
 * rather than `timestamptz`. The query engine compares the filter value with
 * the column as-is, so a picked day has to go out as that day.
 */
const DAY_ONLY_DATE_FIELDS = new Set(['target_date', 'start_date'])

export function isDayOnlyDateField(fieldDef: FilterFieldDefinition): boolean {
  return fieldDef.type === 'date' && DAY_ONLY_DATE_FIELDS.has(fieldDef.field)
}

/**
 * The value a picked day is stored as. A `date` column gets the bare local day
 * (`2026-10-21`): local midnight as an ISO instant is the PREVIOUS day in UTC
 * anywhere east of it, and Postgres casts that instant to the wrong date. A
 * timestamp column keeps the instant (local midnight), as before.
 */
export function dateFilterValue(d: Date, dayOnly: boolean): string {
  return dayOnly ? format(d, 'yyyy-MM-dd') : d.toISOString()
}

/** Reads a stored value back; a bare day is that LOCAL day, not UTC midnight. */
function parseDateFilterValue(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseISO(value) : new Date(value)
}

// Two dates — the `between` editor for a date field.
function DateRangePicker({ value, onChange, dayOnly }: { value: FilterValue; onChange: (v: FilterValue) => void; dayOnly: boolean }) {
  const range = asRange(value)
  const update = (partial: Partial<RangeValue>) => onChange({ ...range, ...partial } as RangeValue)
  return (
    <span className="flex items-center">
      <DatePicker value={(range.from as string | undefined) ?? ''} onChange={v => update({ from: v as string })} dayOnly={dayOnly} />
      <span className="text-muted-foreground text-xs">–</span>
      <DatePicker value={(range.to as string | undefined) ?? ''} onChange={v => update({ to: v as string })} dayOnly={dayOnly} />
    </span>
  )
}

function DatePicker({ value, onChange, dayOnly }: { value: string; onChange: (v: FilterValue) => void; dayOnly: boolean }) {
  const date = value ? parseDateFilterValue(value) : undefined
  return (
    <DateTimePicker
      value={date}
      onChange={(d) => { if (d) onChange(dateFilterValue(d, dayOnly)) }}
      granularity="day"
      placeholder="Pick date"
      displayFormat={{ hour24: 'MMM d, yyyy' }}
      className="h-6 gap-1.5 text-xs px-2 border-none shadow-none"
    />
  )
}

/** What a fresh "is relative" chip holds (and shows): the last 7 days. */
export const DEFAULT_RELATIVE_DATE: RelativeDateValue = { direction: 'past', count: 7, unit: 'day' }

// Relative date picker
function RelativeDatePicker({ value, onChange }: { value: RelativeDateValue | undefined; onChange: (v: FilterValue) => void }) {
  const current: RelativeDateValue = value || DEFAULT_RELATIVE_DATE
  const update = (partial: Partial<RelativeDateValue>) => onChange({ ...current, ...partial })

  return (
    <div className="flex items-center gap-1 px-1">
      <Select value={current.direction} onValueChange={v => update({ direction: v as RelativeDateValue['direction'] })}>
        <SelectTrigger className="w-14 h-6 text-xs border-0 bg-transparent"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="past">Last</SelectItem>
          <SelectItem value="this">This</SelectItem>
          <SelectItem value="future">Next</SelectItem>
        </SelectContent>
      </Select>
      {current.direction !== 'this' && (
        <Input
          type="number" min={1} value={current.count ?? 7}
          onChange={e => update({ count: Number(e.target.value) || 1 })}
          className="w-10 h-6 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 px-1"
        />
      )}
      <Select value={current.unit} onValueChange={v => update({ unit: v as RelativeDateValue['unit'] })}>
        <SelectTrigger className="w-18 h-6 text-xs border-0 bg-transparent"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="day">days</SelectItem>
          <SelectItem value="week">weeks</SelectItem>
          <SelectItem value="month">months</SelectItem>
          <SelectItem value="quarter">quarters</SelectItem>
          <SelectItem value="year">years</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

// Entity picker — fetches entities from an API endpoint and shows a searchable dropdown
function EntityPicker({
  value, onChange, isMulti, endpoint, nameKey, label,
}: {
  value: FilterValue
  onChange: (value: FilterValue) => void
  isMulti: boolean
  endpoint: string
  nameKey: string
  label: string
}) {
  const [open, setOpen] = React.useState(false)
  const [options, setOptions] = React.useState<{ id: string; name: string }[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const selected = isMulti ? (Array.isArray(value) ? value : []) : []

  // Fetch options eagerly on mount (to resolve pre-selected value names)
  React.useEffect(() => {
    if (loaded) return
    fetch(endpoint)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (!json) return
        // Handle all known API response shapes
        const items = json.projects || json.teams || json.members
          || json.initiatives || json.contacts || json.companies
          || json.captures || json.documents || json.actions
          || json.cycles || json.milestones || json.recipes
          || json.labels || json.states || json.lists
          || json.data || []
        setOptions(
          (items as Record<string, unknown>[])
            .filter((i) => (i[nameKey] as string) && (i[nameKey] as string) !== '__default__')
            .map((i) => ({ id: i.id as string, name: (i[nameKey] as string) || '' }))
        )
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [loaded, endpoint, nameKey])

  // Support @me as a special "current user" value
  const isMemberType = label === 'Member'

  // Find display name for current value
  const selectedName = React.useMemo(() => {
    if (isMulti) {
      return selected.length > 0 ? `${selected.length} selected` : 'Select...'
    }
    if (value === '@me') return 'Me'
    const match = options.find(o => o.id === value)
    return match?.name || (value ? 'Loading...' : 'Select...')
  }, [value, options, isMulti, selected])

  const toggleOption = (id: string) => {
    if (isMulti) {
      const arr = Array.isArray(value) ? [...(value as string[])] : []
      const idx = arr.indexOf(id)
      if (idx >= 0) arr.splice(idx, 1); else arr.push(id)
      onChange(arr)
    } else {
      onChange(id)
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button className="px-2 font-medium text-foreground hover:text-primary text-xs truncate max-w-[150px]">
          {selectedName}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start" onOpenAutoFocus={e => e.preventDefault()}>
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}...`} className="h-8" />
          <CommandList>
            <CommandEmpty>{loaded ? `No ${label.toLowerCase()} found.` : 'Loading...'}</CommandEmpty>
            {isMemberType && (
              <CommandItem
                value="@me"
                onSelect={() => toggleOption('@me')}
                className="flex items-center gap-2"
              >
                {isMulti && <Checkbox checked={value === '@me' || selected.includes('@me')} className="h-3.5 w-3.5" />}
                <span className="truncate font-medium">Me</span>
              </CommandItem>
            )}
            {options.map(opt => {
              const isSelected = isMulti ? selected.includes(opt.id) : value === opt.id
              return (
                <CommandItem key={opt.id} value={opt.name} onSelect={() => toggleOption(opt.id)} className="flex items-center gap-2">
                  {isMulti && <Checkbox checked={isSelected} className="h-3.5 w-3.5" />}
                  <span className="truncate">{opt.name}</span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
