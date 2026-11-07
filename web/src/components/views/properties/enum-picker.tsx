'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { cellTriggerClass } from '@/lib/views/property-options'
import type { EnumOption } from '@/lib/views/property-options'

// ── Shared content ─────────────────────────────────────────

interface EnumPickerContentProps {
  value: string | null | undefined
  options: EnumOption[]
  onChange: (value: string) => void
  onSelected?: () => void
}

function EnumPickerContent({ value, options, onChange, onSelected }: EnumPickerContentProps) {
  return (
    <Command>
      <CommandList>
        <CommandGroup>
          {options.map(opt => (
            <CommandItem
              key={opt.value}
              value={opt.value}
              onSelect={() => { onChange(opt.value); onSelected?.() }}
              className={cn(value === opt.value && 'bg-accent')}
            >
              {opt.dot && <span className={cn('mr-2 h-3.5 w-3.5 shrink-0 rounded-full', opt.dot)} />}
              {opt.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

// ── Cell trigger ───────────────────────────────────────────

interface EnumCellTriggerProps {
  value: string | null | undefined
  options: EnumOption[]
  onChange: (value: string) => void
  /** Optional per-option color mapping for label styling */
  colorMap?: Record<string, string>
}

export function EnumCellTrigger({ value, options, onChange, colorMap }: EnumCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const opt = options.find(o => o.value === value)
  const color = opt && colorMap?.[opt.value]

  if (!opt) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center"
            aria-label="Set value"
          >
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start" onClick={e => e.stopPropagation()}>
          <EnumPickerContent value={value} options={options} onChange={onChange} onSelected={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => e.stopPropagation()}
          className={cn(cellTriggerClass, 'capitalize', color)}
        >
          {opt.label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start" onClick={e => e.stopPropagation()}>
        <EnumPickerContent value={value} options={options} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface EnumPanelFieldProps {
  value: string | null | undefined
  options: EnumOption[]
  onChange: (value: string) => void
  placeholder?: string
  icon?: React.ReactNode
  /**
   * Horizontal padding of the row, so this field lines up with the sibling rows
   * of whichever panel mounts it — the same two conventions `ProjectPanelField`
   * carries: `px-3` (capture, eval suite) and `px-2` (action, contact).
   */
  padding?: 'px-2' | 'px-3'
}

export function EnumPanelField({ value, options, onChange, placeholder = 'Select', icon, padding = 'px-2' }: EnumPanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const opt = options.find(o => o.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn('flex h-8 w-full items-center gap-2 rounded-md text-sm transition-colors hover:bg-muted/50', padding)}>
          {opt?.dot ? <span className={cn('h-4 w-4 shrink-0 rounded-full', opt.dot)} /> : icon}
          <span className={cn('truncate', !opt && 'text-muted-foreground')}>
            {opt?.label ?? placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <EnumPickerContent value={value} options={options} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
