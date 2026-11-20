'use client'

/**
 * The Create dialog's type switcher ("New action ⌄"): every type the
 * workspace can create (lib/create/create-types.ts), grouped as the rail
 * groups its pages, with a search field on top. Typing filters by name and
 * keywords; ↑↓ and Enter pick. Kept readable as the list grows (Liam, 11-20:
 * "it supports every kind of thing the app can create now").
 */
import { useState, type ReactNode } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { CREATE_TYPE_GROUPS, type CreateTypeDef, type CreateTypeId } from '@/lib/create/create-types'

export interface CreateTypeOption extends CreateTypeDef {
  icon: ReactNode
}

export function CreateTypePicker({
  options,
  value,
  onChange,
}: {
  options: CreateTypeOption[]
  value: CreateTypeId
  onChange: (id: CreateTypeId) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.id === value) ?? options[0]
  const groups = CREATE_TYPE_GROUPS.map((g) => ({ ...g, options: options.filter((o) => o.group === g.id) })).filter((g) => g.options.length > 0)
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger
        data-create-type-trigger=""
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:shadow-none"
      >
        {current?.icon}
        <span className="max-w-[140px] truncate">New {current?.label.toLowerCase()}</span>
        <ChevronsUpDown className="h-3 w-3 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0" data-create-type-list="">
        <Command
          // Match on the label and keywords, not the id.
          filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Create…" />
          <CommandList className="max-h-[min(420px,var(--radix-popover-content-available-height,420px))]">
            <CommandEmpty>Nothing to create by that name</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.id} heading={g.label}>
                {g.options.map((opt) => (
                  <CommandItem
                    key={opt.id}
                    value={[opt.label, ...(opt.keywords ?? [])].join(' ')}
                    data-create-type={opt.id}
                    onSelect={() => {
                      onChange(opt.id)
                      setOpen(false)
                    }}
                    className="gap-2"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">{opt.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">{opt.label}</span>
                    {opt.opensPage && <span className="shrink-0 text-[10px] text-muted-foreground">Opens page</span>}
                    <Check className={cn('h-3.5 w-3.5 shrink-0', value === opt.id ? 'opacity-100' : 'opacity-0')} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
