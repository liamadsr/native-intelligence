'use client'

/**
 * A booking link's own hours in its dialog (booking insights, phase 3): the
 * week (each day on or off, its ranges) in one zone, and dated changes to it
 * (a date's own hours, or a day off; migration 705). The host's own dated
 * days off still apply on top (src/lib/booking-links/times.ts).
 */
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { DayRange } from '@/lib/availability/engine'
import { LINK_DATE_OVERRIDES_MAX } from '@/lib/booking-links/types'
import { cn } from '@/lib/utils'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Monday first, as the working-hours editor shows them. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const NEW_RANGE: DayRange = { start: '09:00', end: '17:00' }
const CARD = 'divide-y rounded-lg border border-border bg-muted/30'

/** Tomorrow as YYYY-MM-DD in the browser's zone: a new dated change's first guess. Pure over `now`. */
export function nextFreeDate(taken: Readonly<Record<string, unknown>>, now: number = Date.now()): string {
  for (let i = 1; i < 400; i++) {
    const d = new Date(now + i * 86_400_000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!(key in taken)) return key
  }
  return ''
}

function Ranges({ label, ranges, onChange }: { label: string; ranges: DayRange[]; onChange: (next: DayRange[]) => void }) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      {ranges.map((range, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <Input type="time" step={900} aria-label={`${label} start`} className="h-8 w-[7.5rem] bg-background" value={range.start} onChange={(e) => onChange(ranges.map((r, j) => (j === i ? { ...r, start: e.target.value } : r)))} />
          <span className="text-xs text-muted-foreground">–</span>
          <Input type="time" step={900} aria-label={`${label} end`} className="h-8 w-[7.5rem] bg-background" value={range.end === '24:00' ? '23:59' : range.end} onChange={(e) => onChange(ranges.map((r, j) => (j === i ? { ...r, end: e.target.value } : r)))} />
          {ranges.length > 1 && (
            <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${label} range`} className="size-7 shrink-0 text-muted-foreground shadow-none hover:text-foreground" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
              <X className="size-3.5" />
            </Button>
          )}
          {i === ranges.length - 1 && ranges.length < 6 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Add ${label} hours`}
              className="size-7 shrink-0 text-muted-foreground shadow-none hover:text-foreground"
              onClick={() => onChange([...ranges, { start: ranges[ranges.length - 1].end < '22:00' ? ranges[ranges.length - 1].end : '20:00', end: '23:00' }])}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

export function LinkHoursEditor({
  weekly,
  timeZone,
  dateOverrides,
  onChange,
}: {
  weekly: DayRange[][]
  timeZone: string
  dateOverrides: Record<string, DayRange[]>
  onChange: (patch: { weekly?: DayRange[][]; dateOverrides?: Record<string, DayRange[]> }) => void
}) {
  const setDay = (day: number, next: DayRange[]) => onChange({ weekly: weekly.map((d, i) => (i === day ? next : d)) })
  const dates = Object.keys(dateOverrides).sort()
  const setDate = (date: string, next: DayRange[]) => onChange({ dateOverrides: { ...dateOverrides, [date]: next } })
  const moveDate = (from: string, to: string) => {
    if (!to || to === from || to in dateOverrides) return
    const { [from]: ranges, ...rest } = dateOverrides
    onChange({ dateOverrides: { ...rest, [to]: ranges } })
  }
  const removeDate = (date: string) => {
    const { [date]: _gone, ...rest } = dateOverrides
    void _gone
    onChange({ dateOverrides: rest })
  }

  return (
    <div className="space-y-3" data-link-own-hours="">
      <p className="text-xs text-muted-foreground">In {timeZone}.</p>
      <div className={CARD}>
        {DAY_ORDER.map((day) => {
          const on = weekly[day].length > 0
          return (
            <div key={day} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2">
              <Switch aria-label={`Open on ${DAY_NAMES[day]}`} className="mt-1" checked={on} onCheckedChange={(next) => setDay(day, next ? [{ ...NEW_RANGE }] : [])} />
              <span className={cn('mt-1.5 w-24 shrink-0 text-sm', !on && 'text-muted-foreground')}>{DAY_NAMES[day]}</span>
              {on ? <Ranges label={DAY_NAMES[day]} ranges={weekly[day]} onChange={(next) => setDay(day, next)} /> : <p className="mt-1.5 text-sm text-muted-foreground">Closed</p>}
            </div>
          )
        })}
      </div>

      <div data-link-date-overrides="">
        <p className="text-xs font-medium">Dated changes</p>
        <p className="text-xs text-muted-foreground">Other hours on one date, or a day off. Your own days off apply too.</p>
        {dates.length > 0 && (
          <div className={cn(CARD, 'mt-2')}>
            {dates.map((date) => {
              const ranges = dateOverrides[date]
              const open = ranges.length > 0
              return (
                <div key={date} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2" data-link-date-override={date}>
                  <Input type="date" aria-label="Date" className="h-8 w-[9.5rem] bg-background" value={date} onChange={(e) => moveDate(date, e.target.value)} />
                  <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch aria-label={`Open on ${date}`} checked={open} onCheckedChange={(next) => setDate(date, next ? [{ ...NEW_RANGE }] : [])} />
                    {open ? 'Open' : 'Day off'}
                  </label>
                  {open && <Ranges label={date} ranges={ranges} onChange={(next) => setDate(date, next)} />}
                  <Button type="button" size="icon" variant="ghost" aria-label={`Remove the change on ${date}`} className="ml-auto size-7 shrink-0 text-muted-foreground shadow-none hover:text-foreground" onClick={() => removeDate(date)}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        {dates.length < LINK_DATE_OVERRIDES_MAX && (
          <Button type="button" variant="outline" size="sm" className="mt-2 -ml-3 gap-1" onClick={() => setDate(nextFreeDate(dateOverrides), [])}>
            <Plus className="size-3.5" />
            Add a date
          </Button>
        )}
      </div>
    </div>
  )
}
