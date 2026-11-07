'use client'

import * as React from 'react'
import { Flag } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { PRIORITY_OPTIONS, getPriorityOption, cellTriggerClass } from '@/lib/views/property-options'

// ── Headless content (shared by cell + panel) ──────────────

interface PriorityPickerContentProps {
  value: string | null | undefined
  onChange: (value: string) => void
  /** Called after the user picks an item — consumers close the popover here */
  onSelected?: () => void
}

function PriorityPickerContent({ value, onChange, onSelected }: PriorityPickerContentProps) {
  return (
    <Command>
      <CommandList>
        <CommandGroup>
          {PRIORITY_OPTIONS.map(opt => (
            <CommandItem
              key={opt.value}
              value={opt.value}
              onSelect={() => {
                onChange(opt.value)
                onSelected?.()
              }}
              className={cn(value === opt.value && 'bg-accent')}
            >
              <Flag className={cn('mr-2 h-3.5 w-3.5', opt.color)} />
              {opt.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

// ── Cell trigger (row) ─────────────────────────────────────

interface PriorityCellTriggerProps {
  value: string | null | undefined
  onChange: (value: string) => void
  /** Render nothing when value is 'none'/null (read-only rows omit empty priorities). */
  hideWhenNone?: boolean
}

export function PriorityCellTrigger({ value, onChange, hideWhenNone = true }: PriorityCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const opt = getPriorityOption(value)

  if (hideWhenNone && opt.value === 'none' && !open) {
    // Empty state: invisible clickable target so the row still exposes the affordance on hover.
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center"
            aria-label="Set priority"
          >
            <Flag className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start" onClick={e => e.stopPropagation()}>
          <PriorityPickerContent value={value} onChange={onChange} onSelected={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => e.stopPropagation()}
          className={cn(cellTriggerClass, 'capitalize')}
        >
          <Flag className={cn('h-3 w-3 shrink-0', opt.color)} />
          {opt.label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start" onClick={e => e.stopPropagation()}>
        <PriorityPickerContent value={value} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field (side panel) ───────────────────────────────

interface PriorityPanelFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
}

export function PriorityPanelField({ value, onChange }: PriorityPanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const opt = getPriorityOption(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
          <Flag className={cn('h-4 w-4 shrink-0', opt.color)} />
          <span className={cn(opt.value === 'none' && 'text-muted-foreground')}>
            {opt.value === 'none' ? 'Set priority' : opt.label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <PriorityPickerContent value={value} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
