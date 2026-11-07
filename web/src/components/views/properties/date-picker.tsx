'use client'

import * as React from 'react'
import { parseISO, startOfDay } from 'date-fns'
import { X } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { cn } from '@/lib/utils'

/**
 * A `date` column arrives as `YYYY-MM-DD`, which `new Date()` reads as UTC
 * midnight (the day before, west of UTC). parseISO reads it as local midnight;
 * a full timestamp is read as the instant it names either way.
 */
function parseDateValue(value: string): Date {
  return isDateOnly(value) ? parseISO(value) : new Date(value)
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Overdue: a timestamp once it has passed; a calendar day once the day has. */
function isOverdue(value: string, d: Date): boolean {
  return d < (isDateOnly(value) ? startOfDay(new Date()) : new Date())
}

// ── Cell trigger ───────────────────────────────────────────

interface DateCellTriggerProps {
  value: string | null | undefined
  /** If true, value < now shows the overdue dot */
  overdueSensitive?: boolean
  onChange: (iso: string | null) => void
  /** Granularity passed to the underlying DateTimePicker. Default: 'day'. */
  granularity?: 'day' | 'minute'
}

/**
 * Chip-style date picker for list rows. Wraps `DateTimePicker` with the same
 * compact styling used by `ProjectActionsList` (project-detail-panel.tsx:1196).
 */
export function DateCellTrigger({
  value, overdueSensitive = false, onChange, granularity = 'day',
}: DateCellTriggerProps) {
  const d = value ? parseDateValue(value) : undefined
  const overdue = !!(overdueSensitive && value && d && isOverdue(value, d))

  return (
    <div onClick={e => e.stopPropagation()}>
      <DateTimePicker
        value={d}
        onChange={(newDate) => onChange(newDate ? newDate.toISOString() : null)}
        granularity={granularity}
        placeholder=""
        displayFormat={{ hour24: 'MMM d' }}
        className={cn(
          'h-7 w-auto min-w-0 border-none shadow-none bg-transparent hover:bg-muted/50 px-1.5 text-[11px] text-muted-foreground justify-center gap-1.5',
          '[&>svg]:h-3 [&>svg]:w-3 [&>svg]:m-0 [&>svg]:shrink-0',
          overdue && 'text-red-500',
        )}
      />
    </div>
  )
}

// ── Panel field ────────────────────────────────────────────

interface DatePanelFieldProps {
  value: string | null | undefined
  onChange: (iso: string | null) => void
  placeholder?: string
  granularity?: 'day' | 'minute'
  overdueSensitive?: boolean
}

export function DatePanelField({
  value, onChange, placeholder = 'Set date', granularity = 'minute', overdueSensitive = false,
}: DatePanelFieldProps) {
  const d = value ? parseDateValue(value) : undefined
  const overdue = !!(overdueSensitive && value && d && isOverdue(value, d))

  return (
    <div className="flex h-8 items-center">
      <DateTimePicker
        value={d}
        onChange={(newDate) => onChange(newDate ? newDate.toISOString() : null)}
        granularity={granularity}
        hourCycle={12}
        displayFormat={granularity === 'day' ? { hour24: 'MMM d, yyyy' } : { hour12: 'MMM d, yyyy hh:mm a' }}
        placeholder={placeholder}
        className={cn(
          // `bg-transparent` overrides the Button outline variant's
          // `bg-background`, which reads as a filled block against the panel —
          // every other property row is transparent until hovered.
          'h-8 flex-1 border-none bg-transparent shadow-none px-2 text-sm hover:bg-muted/50',
          !d && 'text-muted-foreground',
          overdue && 'text-red-500',
        )}
      />
      {d && (
        <button
          type="button"
          className="mr-2 shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
          onClick={() => onChange(null)}
          aria-label="Clear date"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
