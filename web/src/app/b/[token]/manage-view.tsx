'use client'

import { useMemo, useState } from 'react'
import { CalendarClock, Globe, MapPin, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SchedulingNotice, SchedulingShell, TimeButton } from '@/components/scheduling/scheduling-shell'
import { useGuestTimeZone } from '@/components/scheduling/use-guest-time-zone'
import {
  bookingPhase,
  clockLabel,
  dayLabel,
  groupByDay,
  manageFailureView,
  movesLeftLabel,
  shortDayLabel,
  whenLabel,
  zoneShort,
  type PageLoad,
  type PublicBookingData,
  type PublicSlot,
} from '@/lib/time-offers/display'
import { RESCHEDULES_MAX } from '@/lib/time-offers/types'

type Mode = 'view' | 'cancel' | 'move'

function Final({ title, children, ...rest }: { title: string; children?: React.ReactNode } & Record<`data-${string}`, string>) {
  return (
    <SchedulingShell>
      <CardHeader {...rest}>
        <CardTitle>{title}</CardTitle>
        {children && <CardDescription className="space-y-2 pt-1">{children}</CardDescription>}
      </CardHeader>
    </SchedulingShell>
  )
}

/** Where the meeting is: its video link, or its place. */
function Place({ booking }: { booking: PublicBookingData }) {
  if (booking.conference_url) {
    return (
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <Video aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <a href={booking.conference_url} target="_blank" rel="noreferrer" className="truncate text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" data-manage-video>
          {booking.conference_url.replace(/^https?:\/\//, '')}
        </a>
      </p>
    )
  }
  if (booking.video) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Video aria-hidden className="size-4 shrink-0" />
        Video call: the link is in the invitation.
      </p>
    )
  }
  if (booking.location) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <MapPin aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {booking.location}
      </p>
    )
  }
  return null
}

type ApiBody = { booking?: PublicBookingData; error?: string; code?: string; time_zone?: string; slots?: PublicSlot[] } | null

export function ManageView({ token, load }: { token: string; load: PageLoad<PublicBookingData> }) {
  const [booking, setBooking] = useState<PublicBookingData | null>(load.kind === 'found' ? load.data : null)
  const [missing, setMissing] = useState(load.kind === 'missing')
  const [now] = useState(() => Date.now())
  const [mode, setMode] = useState<Mode>('view')
  const [times, setTimes] = useState<PublicSlot[] | null>(null)
  const [picked, setPicked] = useState<PublicSlot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [news, setNews] = useState('')
  const zone = useGuestTimeZone(booking?.time_zone ?? 'UTC')
  const days = useMemo(() => (times && booking ? groupByDay(times.filter((t) => t.start !== booking.start), zone) : []), [times, booking, zone])

  if (missing) {
    return (
      <Final title="This link doesn't work" data-manage-state="missing">
        It may have been mistyped. The link to manage your meeting is in its calendar invitation.
      </Final>
    )
  }
  if (!booking) {
    return (
      <Final title="This page isn't available right now" data-manage-state="error">
        Try again in a minute.
      </Final>
    )
  }

  const host = booking.host_name
  const when = whenLabel(booking.start, booking.end, zone)
  const phase = bookingPhase(booking, now)
  const base = `/api/public/bookings/${encodeURIComponent(token)}`

  if (phase === 'cancelled') {
    return (
      <Final title="This meeting is cancelled" data-manage-state="cancelled">
        <span className="block text-foreground/70 line-through decoration-muted-foreground/60">{booking.title}, {when}</span>
        <span className="block">{news || `To meet another time, reach out to ${host}.`}</span>
      </Final>
    )
  }
  if (phase === 'failed') {
    return (
      <Final title="This meeting couldn't be booked" data-manage-state="failed">
        It never made it onto {host}&apos;s calendar, so the time is free again. Reach out to {host} to find another.
      </Final>
    )
  }
  if (phase === 'past') {
    return (
      <Final title="This meeting has passed" data-manage-state="past">
        {booking.title} with {host}, {when}.
      </Final>
    )
  }

  async function reload() {
    try {
      const res = await fetch(base, { cache: 'no-store' })
      if (res.status === 404) return setMissing(true)
      const data = (await res.json().catch(() => null)) as ApiBody
      if (res.ok && data?.booking) setBooking(data.booking)
    } catch {
      /* the page keeps what it has */
    }
  }

  async function fail(res: Response | null, data: ApiBody) {
    const failure = manageFailureView(res?.status ?? 0, data)
    if (failure.kind === 'missing') return setMissing(true)
    if (failure.kind === 'reload') await reload()
    if (failure.kind === 'slot_taken') {
      setPicked(null)
      await loadTimes()
    }
    setError(failure.message)
  }

  async function loadTimes() {
    setTimes(null)
    try {
      const res = await fetch(`${base}/times`, { cache: 'no-store' })
      const data = (await res.json().catch(() => null)) as ApiBody
      if (!res.ok || !Array.isArray(data?.slots)) {
        setMode('view')
        return fail(res, data)
      }
      setTimes(data.slots)
    } catch {
      setMode('view')
      setError("That didn't go through. Try again in a moment.")
    }
  }

  async function post(path: 'cancel' | 'reschedule', body?: object): Promise<boolean> {
    setBusy(true)
    setError('')
    let ok = false
    try {
      const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      const data = (await res.json().catch(() => null)) as ApiBody
      if (res.ok && data?.booking) {
        setBooking(data.booking)
        ok = true
      } else await fail(res, data)
    } catch {
      setError("That didn't go through. Try again in a moment.")
    }
    setBusy(false)
    return ok
  }

  async function cancel() {
    if (await post('cancel')) setNews(`${host} has been told.`)
    setMode('view')
  }

  async function move() {
    if (!picked) return
    if (await post('reschedule', { start: picked.start })) {
      setNews(`Moved to ${dayLabel(picked.start, zone)}, ${clockLabel(picked.start, zone)}. The calendar sends the updated invitation.`)
      setMode('view')
      setPicked(null)
      setTimes(null)
    }
  }

  const live = phase === 'live'
  const movesLeft = movesLeftLabel(booking.reschedules_left, RESCHEDULES_MAX)
  const zoneName = zoneShort(zone, Date.parse(booking.start))

  return (
    <SchedulingShell>
      <CardHeader data-manage-state={live ? 'live' : phase}>
        <p className="text-sm font-medium text-muted-foreground">{host}</p>
        <CardTitle className="text-2xl">{booking.title}</CardTitle>
        <CardDescription>{live ? 'Happening now.' : `Booked for ${booking.guest_name}.`}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium" data-manage-when>
            <CalendarClock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {when}
          </p>
          <Place booking={booking} />
        </div>
        {phase === 'pending' && <SchedulingNotice tone="info">It&apos;s being put on {host}&apos;s calendar. The invitation follows in a minute.</SchedulingNotice>}
        {news && <SchedulingNotice tone="info" data-manage-news="">{news}</SchedulingNotice>}
        {error && <SchedulingNotice data-manage-error="">{error}</SchedulingNotice>}

        {mode === 'view' && !live && (booking.can_reschedule || booking.can_cancel) && (
          <div className="space-y-2 border-t pt-5">
            <div className="flex flex-wrap gap-2">
              {booking.can_reschedule && (
                <Button
                  variant="outline"
                  className="border"
                  onClick={() => {
                    setError('')
                    setNews('')
                    setMode('move')
                    void loadTimes()
                  }}
                  data-manage-move=""
                >
                  Pick another time
                </Button>
              )}
              {booking.can_cancel && (
                <Button
                  variant="ghost"
                  className="text-red-600 shadow-none hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/30 dark:hover:text-red-300"
                  onClick={() => {
                    setError('')
                    setNews('')
                    setMode('cancel')
                  }}
                  data-manage-cancel=""
                >
                  Cancel meeting
                </Button>
              )}
            </div>
            {booking.can_reschedule && movesLeft && <p className="text-xs text-muted-foreground">{movesLeft}</p>}
          </div>
        )}

        {mode === 'cancel' && (
          <div className="space-y-3 rounded-lg border p-4" data-manage-confirm-cancel>
            <p className="text-sm">
              Cancel this meeting? {host} will be told, and you can&apos;t undo it from here.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" onClick={cancel} disabled={busy}>
                {busy ? 'Cancelling…' : 'Yes, cancel it'}
              </Button>
              <Button variant="outline" className="border" onClick={() => setMode('view')} disabled={busy}>
                Keep it
              </Button>
            </div>
          </div>
        )}

        {mode === 'move' && (
          <div className="space-y-4 border-t pt-5" data-manage-pick>
            <div className="space-y-1">
              <p className="text-sm font-medium">Pick a new time</p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Globe aria-hidden className="size-3.5" />
                Times in {zoneName}
              </p>
            </div>
            {times === null ? (
              <p className="text-sm text-muted-foreground" data-manage-loading>
                Finding {host}&apos;s open times…
              </p>
            ) : days.length === 0 ? (
              <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground" data-manage-empty>
                No other times are open in the next two weeks. Reach out to {host} to find one.
              </p>
            ) : (
              <div className="max-h-96 space-y-4 overflow-y-auto pr-1" data-manage-slots>
                {days.map((d) => (
                  <div key={d.key}>
                    <p className="mb-2 text-sm font-medium">{d.label}</p>
                    <div className="flex flex-wrap gap-2">
                      {d.slots.map((slot) => {
                        const on = picked?.start === slot.start
                        return (
                          <TimeButton key={slot.start} on={on} onClick={() => setPicked(on ? null : slot)} disabled={busy}>
                            {slot.time}
                          </TimeButton>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {picked && (
                <Button onClick={move} disabled={busy} data-manage-confirm-move="">
                  {busy ? 'Moving…' : `Move to ${shortDayLabel(picked.start, zone)} at ${clockLabel(picked.start, zone)}`}
                </Button>
              )}
              <Button
                variant="outline"
                className="border"
                onClick={() => {
                  setMode('view')
                  setPicked(null)
                }}
                disabled={busy}
              >
                Keep the current time
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </SchedulingShell>
  )
}
