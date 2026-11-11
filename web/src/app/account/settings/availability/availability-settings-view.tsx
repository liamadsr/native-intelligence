'use client'

/**
 * Settings → Availability: what decides the times Native Intelligence offers
 * for you (find_times, Copy availability, a teammate finding a time with
 * you). Nothing to set up: weekdays 9 to 6, your own calendars counting and
 * busy times shared with teammates are the defaults, and they already work.
 *
 *   Working hours   each weekday's ranges (/api/account/availability), and
 *                   the dated changes the agent saved (a day off, other
 *                   hours on one date), each removable.
 *   Calendars       which of your calendars make you busy
 *                   (/api/account/availability/calendars).
 *   Teammates       whether this workspace's members may see when you are
 *                   busy (busy times only, never what an event is).
 *
 * Read once when the page opens; nothing polls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export interface DayRange {
  start: string
  end: string
}

interface HoursBody {
  time_zone: string
  follows_you: boolean
  weekly: DayRange[][]
  overrides: Record<string, DayRange[]>
  saved: boolean
}

type Sharing = 'busy_only' | 'none'

interface CalendarRow {
  id: string
  name: string
  color: string | null
  primary: boolean
  counts: boolean
  counts_by_default: boolean
}

interface AccountRow {
  id: string
  provider: string
  account_email: string | null
  error: string | null
  calendars: CalendarRow[]
}

/** Monday first, as people read a week; the stored week is Sunday first. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const NEW_RANGE: DayRange = { start: '09:00', end: '17:00' }

async function call<T>(url: string, init: RequestInit = {}): Promise<{ ok: boolean; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T & { error?: string } }
  } catch {
    return { ok: false, data: { error: 'Network error' } as T & { error?: string } }
  }
}

/** "9:00 AM" from "09:00" (24:00 is midnight). Pure. */
export function clockLabel(clock: string): string {
  const [h, m] = clock.split(':').map(Number)
  const hour = h % 24
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(m).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

/** A dated change as one line: "Fri, Nov 27 · Day off". Pure. */
export function datedChangeLabel(date: string, ranges: readonly DayRange[]): string {
  const [y, mo, d] = date.split('-').map(Number)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, mo - 1, d)))
  const hours = ranges.length ? ranges.map((r) => `${clockLabel(r.start)} – ${clockLabel(r.end)}`).join(', ') : 'Day off'
  return `${day} · ${hours}`
}

/** The first problem with a week, or null: each range ends after it starts and none overlap. Pure. */
export function weekProblem(weekly: readonly (readonly DayRange[])[]): string | null {
  for (let i = 0; i < 7; i++) {
    const ranges = [...weekly[i]].sort((a, b) => a.start.localeCompare(b.start))
    for (let j = 0; j < ranges.length; j++) {
      if (!ranges[j].start || !ranges[j].end) return `${DAY_NAMES[i]}: fill in both times.`
      if (ranges[j].end <= ranges[j].start) return `${DAY_NAMES[i]}: each range ends after it starts.`
      if (j > 0 && ranges[j].start < ranges[j - 1].end) return `${DAY_NAMES[i]}: the ranges overlap.`
    }
  }
  return null
}

export function AvailabilitySettingsView() {
  const [hours, setHours] = useState<HoursBody | null>(null)
  const [week, setWeek] = useState<DayRange[][] | null>(null)
  const [sharing, setSharing] = useState<Sharing | null>(null)
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      const [main, cals] = await Promise.all([
        call<{ hours: HoursBody; sharing: Sharing }>('/api/account/availability'),
        call<{ accounts: AccountRow[] }>('/api/account/availability/calendars'),
      ])
      if (!main.ok) {
        setLoadError(main.data.error ?? 'Could not load your availability')
        return
      }
      setHours(main.data.hours)
      setWeek(main.data.hours.weekly.map((d) => d.map((r) => ({ ...r }))))
      setSharing(main.data.sharing)
      setAccounts(cals.ok ? (cals.data.accounts ?? []) : [])
    })()
  }, [])

  const dirty = useMemo(() => !!hours && !!week && JSON.stringify(week) !== JSON.stringify(hours.weekly), [hours, week])
  const problem = useMemo(() => (week ? weekProblem(week) : null), [week])

  const editDay = useCallback((day: number, next: (ranges: DayRange[]) => DayRange[]) => {
    setWeek((w) => (w ? w.map((ranges, i) => (i === day ? next(ranges) : ranges)) : w))
  }, [])

  const saveWeek = useCallback(async () => {
    if (!week || problem) return
    setSaving(true)
    const res = await call<{ hours: HoursBody }>('/api/account/availability', { method: 'PUT', body: JSON.stringify({ weekly: week }) })
    setSaving(false)
    if (!res.ok) {
      toast.error(res.data.error ?? 'Could not save your hours')
      return
    }
    setHours(res.data.hours)
    setWeek(res.data.hours.weekly.map((d) => d.map((r) => ({ ...r }))))
    toast.success('Working hours saved')
  }, [week, problem])

  const removeDate = useCallback(async (date: string) => {
    const res = await call<{ hours: HoursBody }>('/api/account/availability', { method: 'PUT', body: JSON.stringify({ clear_dates: [date] }) })
    if (!res.ok) {
      toast.error(res.data.error ?? 'Could not remove it')
      return
    }
    setHours((h) => (h ? { ...h, overrides: res.data.hours.overrides } : h))
  }, [])

  const setShare = useCallback(async (next: Sharing) => {
    setSharing(next)
    const res = await call<{ sharing: Sharing }>('/api/account/availability', { method: 'PUT', body: JSON.stringify({ sharing: next }) })
    if (!res.ok) {
      setSharing(next === 'none' ? 'busy_only' : 'none')
      toast.error(res.data.error ?? 'Could not save')
    }
  }, [])

  const setCounts = useCallback(async (accountId: string, calendarId: string, counts: boolean) => {
    const flip = (value: boolean) =>
      setAccounts((list) => list?.map((a) => (a.id !== accountId ? a : { ...a, calendars: a.calendars.map((c) => (c.id === calendarId ? { ...c, counts: value } : c)) })) ?? list)
    flip(counts)
    const res = await call('/api/account/availability/calendars', { method: 'PUT', body: JSON.stringify({ account_id: accountId, calendar_id: calendarId, counts }) })
    if (!res.ok) {
      flip(!counts)
      toast.error(res.data.error ?? 'Could not save')
    }
  }, [])

  const dated = useMemo(() => Object.entries(hours?.overrides ?? {}).sort(([a], [b]) => a.localeCompare(b)), [hours])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Availability</h1>
        <p className="mt-1 text-sm text-muted-foreground">When you can meet. Native Intelligence offers times inside your working hours and around everything busy on the calendars that count.</p>

        {loadError && <p className="mt-8 text-sm text-destructive">{loadError}</p>}

        {!hours && !loadError && (
          <div className="mt-8 space-y-2" aria-label="Loading">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {hours && week && (
          <>
            <section className="mt-8" aria-labelledby="availability-hours">
              <h2 id="availability-hours" className="text-sm font-medium">
                Working hours
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                In {hours.time_zone}
                {hours.follows_you ? ', the time zone you’re in' : ''}.
              </p>
              <div className="mt-3 divide-y rounded-lg border border-border bg-muted/30">
                {DAY_ORDER.map((day) => {
                  const ranges = week[day]
                  const on = ranges.length > 0
                  return (
                    <div key={day} data-testid="availability-day" className="flex items-start gap-3 px-4 py-2.5">
                      <Switch
                        aria-label={`Work on ${DAY_NAMES[day]}`}
                        className="mt-1"
                        checked={on}
                        onCheckedChange={(next) => editDay(day, () => (next ? [{ ...(hours.weekly[day][0] ?? NEW_RANGE) }] : []))}
                      />
                      <span className={cn('mt-1.5 w-24 shrink-0 text-sm', !on && 'text-muted-foreground')}>{DAY_NAMES[day]}</span>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        {!on && <p className="mt-1.5 text-sm text-muted-foreground">Off</p>}
                        {ranges.map((range, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <Input
                              type="time"
                              step={900}
                              aria-label={`${DAY_NAMES[day]} start`}
                              className="h-8 w-[7.5rem]"
                              value={range.start}
                              onChange={(e) => editDay(day, (rs) => rs.map((r, j) => (j === i ? { ...r, start: e.target.value } : r)))}
                            />
                            <span className="text-xs text-muted-foreground">–</span>
                            <Input
                              type="time"
                              step={900}
                              aria-label={`${DAY_NAMES[day]} end`}
                              className="h-8 w-[7.5rem]"
                              value={range.end === '24:00' ? '23:59' : range.end}
                              onChange={(e) => editDay(day, (rs) => rs.map((r, j) => (j === i ? { ...r, end: e.target.value } : r)))}
                            />
                            {ranges.length > 1 && (
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${DAY_NAMES[day]} range`}
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                                onClick={() => editDay(day, (rs) => rs.filter((_, j) => j !== i))}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {i === ranges.length - 1 && ranges.length < 6 && (
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Add ${DAY_NAMES[day]} hours`}
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                                onClick={() => editDay(day, (rs) => [...rs, { start: rs[rs.length - 1].end < '23:00' ? rs[rs.length - 1].end : '20:00', end: '23:00' }])}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              {dirty && (
                <div className="mt-3 flex items-center justify-end gap-2">
                  {problem && <p className="mr-auto text-xs text-destructive">{problem}</p>}
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setWeek(hours.weekly.map((d) => d.map((r) => ({ ...r }))))}>
                    Discard
                  </Button>
                  <Button size="sm" className="h-8" disabled={saving || !!problem} onClick={() => void saveWeek()}>
                    Save hours
                  </Button>
                </div>
              )}

              {dated.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-xs font-medium text-muted-foreground">Dated changes</h3>
                  <ul className="mt-2 divide-y rounded-md border">
                    {dated.map(([date, ranges]) => (
                      <li key={date} data-testid="availability-dated" className="group flex items-center gap-3 px-3 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{datedChangeLabel(date, ranges)}</span>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove the change on ${date}`}
                          className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => void removeDate(date)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="mt-8" aria-labelledby="availability-calendars">
              <h2 id="availability-calendars" className="text-sm font-medium">
                Calendars that make you busy
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Your own calendars count; ones you only follow, like a teammate’s or holidays, don’t.</p>
              {accounts === null ? (
                <Skeleton className="mt-3 h-9 w-full" />
              ) : accounts.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No calendar connected in this workspace.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {accounts.map((account) => (
                    <div key={account.id}>
                      <p className="mb-1 text-xs text-muted-foreground">{account.account_email ?? (account.provider === 'google' ? 'Google Calendar' : 'Outlook Calendar')}</p>
                      {account.error ? (
                        <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">{account.error}</p>
                      ) : (
                        <ul className="divide-y rounded-md border">
                          {account.calendars.map((c) => (
                            <li key={c.id} data-testid="availability-calendar" className="flex items-center gap-3 px-3 py-1.5 text-sm">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40" style={c.color ? { backgroundColor: c.color } : undefined} />
                              <span className="min-w-0 flex-1 truncate">{c.name}</span>
                              <Switch aria-label={`${c.name} counts as busy`} checked={c.counts} onCheckedChange={(next) => void setCounts(account.id, c.id, next)} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="mt-8" aria-labelledby="availability-sharing">
              <h2 id="availability-sharing" className="text-sm font-medium">
                Teammates
              </h2>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Label className="text-sm font-medium">Share when you’re busy</Label>
                    <p className="text-xs text-muted-foreground">People in this workspace can find a time with you. They see only when you’re busy, never what an event is.</p>
                  </div>
                  <Switch aria-label="Share when you’re busy" checked={sharing === 'busy_only'} onCheckedChange={(next) => void setShare(next ? 'busy_only' : 'none')} />
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
