'use client'

import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { cellTriggerClass } from '@/lib/views/property-options'

// ── Cell trigger ───────────────────────────────────────────

interface TextEditCellTriggerProps {
  value: string | null | undefined
  onChange: (value: string | null) => void
  /** Placeholder shown in the popover input */
  placeholder?: string
  /** Max characters displayed in the cell chip */
  maxDisplay?: number
}

/**
 * Inline text field for short strings (`job_title`, `industry`, `domain`).
 * Opens a small popover with a single text input — commits on blur or Enter.
 */
export function TextEditCellTrigger({
  value, onChange, placeholder = 'Enter value', maxDisplay = 20,
}: TextEditCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const display = value ? (value.length > maxDisplay ? value.slice(0, maxDisplay) + '…' : value) : null

  const commit = (next: string) => {
    const trimmed = next.trim()
    onChange(trimmed === '' ? null : trimmed)
    setOpen(false)
  }

  if (!display) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center text-muted-foreground text-[10px]"
            aria-label={placeholder}
          >
            +
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start" onClick={e => e.stopPropagation()}>
          <Input
            autoFocus
            defaultValue={value ?? ''}
            placeholder={placeholder}
            className="h-8 text-sm"
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit((e.currentTarget as HTMLInputElement).value)
              if (e.key === 'Escape') setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button onClick={e => e.stopPropagation()} className={cn(cellTriggerClass, 'max-w-[140px] truncate')}>
          {display}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start" onClick={e => e.stopPropagation()}>
        <Input
          autoFocus
          defaultValue={value ?? ''}
          placeholder={placeholder}
          className="h-8 text-sm"
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.currentTarget as HTMLInputElement).value)
            if (e.key === 'Escape') setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
