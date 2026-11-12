'use client'

import * as React from 'react'
import {
  Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import {
  FILTERABLE_FIELDS, FIELD_CATEGORIES,
  type ViewEntityType, type FilterFieldDefinition, type FilterFieldType, type FilterValue,
} from '@/lib/views/types'
import {
  CircleDot, User, Tag, Calendar, Hash, Type, ToggleLeft,
  FolderKanban, Users, Repeat, Milestone as MilestoneIcon,
  Target, BookOpen, Building2, Mail, Link2, ChevronRight, ListChecks,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { customFieldFilterFields } from '@/lib/views/custom-field-columns'
import { useCustomFieldDefinitions } from '../hooks/use-custom-field-definitions'

const FIELD_TYPE_ICONS: Record<FilterFieldType, React.ElementType> = {
  enum: CircleDot, member: User, label: Tag, tag: Tag,
  date: Calendar, number: Hash, text: Type, boolean: ToggleLeft,
  project: FolderKanban, team: Users, cycle: Repeat,
  milestone: MilestoneIcon, initiative: Target,
  capture: BookOpen, action: CircleDot, contact: User,
  company: Building2, contact_email: Mail, relation: Link2,
  prospect_list: ListChecks,
}

function hasStaticOptions(field: FilterFieldDefinition): boolean {
  return field.type === 'enum' && Array.isArray(field.options) && field.options.length > 0
}

interface FilterFieldPickerProps {
  entityType: ViewEntityType
  onSelect: (field: FilterFieldDefinition, value?: FilterValue) => void
}

export function FilterFieldPicker({ entityType, onSelect }: FilterFieldPickerProps) {
  const allFields = FILTERABLE_FIELDS[entityType]
  const categories = FIELD_CATEGORIES[entityType]

  // The workspace's own fields, last and under their own heading. Nothing
  // when the kind has none (or takes none): no empty "Custom fields" group.
  const customDefs = useCustomFieldDefinitions(entityType)
  const customFields = React.useMemo(() => customFieldFilterFields(customDefs), [customDefs])

  const groups = categories.map(cat => ({
    label: cat.label,
    fields: cat.fields
      .map(fieldName => allFields.find(f => f.field === fieldName))
      .filter(Boolean) as FilterFieldDefinition[],
  }))
  // A table's own columns lead its picker; a kind's custom fields follow its built-in ones.
  if (customFields.length && entityType === 'data_row') groups.unshift({ label: 'Columns', fields: customFields })
  else if (customFields.length) groups.push({ label: 'Custom fields', fields: customFields })

  return (
    <Command>
      <CommandInput placeholder="Add Filter..." />
      <CommandList className="max-h-72">
        <CommandEmpty>No matching fields.</CommandEmpty>
        {groups.map((group, i) => (
          <CommandGroup key={i} heading={group.label || undefined}>
            {group.fields.map(field => (
              <FieldItem
                key={field.field}
                field={field}
                onSelect={onSelect}
              />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}

/** Single field row — if it has static options, wraps in a sub-popover that opens to the side */
function FieldItem({
  field,
  onSelect,
}: {
  field: FilterFieldDefinition
  onSelect: (field: FilterFieldDefinition, value?: FilterValue) => void
}) {
  const Icon = FIELD_TYPE_ICONS[field.type] || CircleDot
  const showSub = hasStaticOptions(field)

  if (!showSub) {
    // No sub-menu — clicking adds filter directly
    return (
      <CommandItem
        // A custom field may share a built-in's label ("Status"): its path
        // keeps the two apart in the command list.
        value={field.custom ? `${field.label} ${field.field}` : field.label}
        onSelect={() => {
          if (field.type === 'boolean') onSelect(field, true)
          else onSelect(field)
        }}
        className="flex items-center gap-2"
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1">{field.label}</span>
      </CommandItem>
    )
  }

  // Has static options — render with a side popover
  return (
    <FieldWithSubMenu field={field} onSelect={onSelect} Icon={Icon} />
  )
}

/** Field row with a sub-popover showing options to the right */
function FieldWithSubMenu({
  field,
  onSelect,
  Icon,
}: {
  field: FilterFieldDefinition
  onSelect: (field: FilterFieldDefinition, value?: FilterValue) => void
  Icon: React.ElementType
}) {
  const [open, setOpen] = React.useState(false)
  const options = field.options as string[]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            open && 'bg-accent text-accent-foreground',
          )}
          onMouseEnter={() => setOpen(true)}
        >
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1">{field.label}</span>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-52 p-0"
        side="right"
        align="start"
        sideOffset={2}
        onMouseLeave={() => setOpen(false)}
      >
        <SubMenuOptions
          field={field}
          options={options}
          onSelect={(value) => {
            onSelect(field, value)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The sub-menu content showing filterable options with checkboxes */
function SubMenuOptions({
  field,
  options,
  onSelect,
}: {
  field: FilterFieldDefinition
  options: string[]
  onSelect: (value: FilterValue) => void
}) {
  const [selected, setSelected] = React.useState<string[]>([])

  const toggle = (opt: string) => {
    setSelected(prev => prev.includes(opt) ? prev.filter(v => v !== opt) : [...prev, opt])
  }

  // Apply multi-selection
  const apply = () => {
    if (selected.length === 1) onSelect(selected[0])
    else if (selected.length > 1) onSelect(selected)
  }

  return (
    <Command>
      <CommandInput placeholder={`Filter...`} className="h-8" />
      <CommandList className="max-h-56">
        <CommandEmpty>No options.</CommandEmpty>
        {options.map(opt => {
          const isChecked = selected.includes(opt)
          return (
            <CommandItem
              key={opt}
              value={opt}
              onSelect={() => {
                // Single click without existing selection → apply immediately
                if (selected.length === 0) {
                  onSelect(opt)
                } else {
                  toggle(opt)
                }
              }}
              className="flex items-center gap-2"
            >
              <Checkbox
                checked={isChecked}
                className="h-3.5 w-3.5"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(opt)
                }}
              />
              <span className="capitalize flex-1">{opt.replace(/_/g, ' ')}</span>
            </CommandItem>
          )
        })}
      </CommandList>
      {selected.length > 0 && (
        <div className="border-t px-2 py-1.5">
          <button
            onClick={apply}
            className="w-full text-center text-xs font-medium text-primary hover:text-primary/80 py-1"
          >
            Apply filter ({selected.length} selected)
          </button>
        </div>
      )}
    </Command>
  )
}
