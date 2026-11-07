'use client'

import { useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarIcon } from 'lucide-react'
import type { DateRange } from 'react-day-picker'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type PresetId =
  | 'this_month'
  | 'last_month'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'custom'

const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_90_days', label: 'Last 90 days' },
  { id: 'custom', label: 'Custom range' },
]

// The range travels as calendar days ('YYYY-MM-DD'), while the picker works
// in local dates: parse and print them with LOCAL fields, never via UTC
// (toISOString / new Date('YYYY-MM-DD')), or every date shifts by a day on
// one side of UTC.
function toISODate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fromISODate(value: string) {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatLabel(from: Date, to: Date) {
  const sameYear = from.getFullYear() === to.getFullYear()
  const fmt: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }
  return `${from.toLocaleDateString(undefined, fmt)} – ${to.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

export function AiUsageRangePicker({
  presetId,
  from,
  to,
}: {
  presetId: PresetId
  from: string
  to: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>({
    from: fromISODate(from),
    to: fromISODate(to),
  })

  function navigate(next: { preset: PresetId; from?: string; to?: string }) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('preset', next.preset)
    if (next.from) params.set('from', next.from)
    else params.delete('from')
    if (next.to) params.set('to', next.to)
    else params.delete('to')
    startTransition(() => {
      router.push(`?${params.toString()}`, { scroll: false })
    })
  }

  function handlePresetChange(value: string) {
    const preset = value as PresetId
    if (preset === 'custom') {
      setCustomOpen(true)
      return
    }
    navigate({ preset })
  }

  function applyCustom() {
    if (!draft?.from || !draft?.to) return
    navigate({
      preset: 'custom',
      from: toISODate(draft.from),
      to: toISODate(draft.to),
    })
    setCustomOpen(false)
  }

  const fromDate = fromISODate(from)
  const toDate = fromISODate(to)
  const customLabel = formatLabel(fromDate, toDate)

  return (
    <div className="flex items-center gap-2" data-pending={isPending || undefined}>
      <Select value={presetId} onValueChange={handlePresetChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Popover open={customOpen} onOpenChange={setCustomOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-9 min-w-[220px] justify-start font-normal"
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {customLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={draft}
            onSelect={setDraft}
            defaultMonth={draft?.from ?? fromDate}
          />
          <div className="flex items-center justify-end gap-2 border-t p-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft({ from: fromDate, to: toDate })
                setCustomOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={applyCustom}
              disabled={!draft?.from || !draft?.to}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
