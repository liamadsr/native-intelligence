'use client'

/**
 * Availability › Bookings (booking insights, phase 1): the bookings your
 * booking links made, the ones you organize or attend
 * (/api/account/link-bookings; src/lib/booking-links/bookings.ts).
 *
 *   Upcoming · Past · Cancelled   one view at a time, grouped by day.
 *   Search                        a guest's name or email, or the title.
 *   Link                          one of your links.
 *   Attended / No-show            on a past booking: tap again to clear.
 *
 * Guests move or cancel a booking from the link in their confirmation
 * (/b/<token>); nothing here sends them anything.
 */
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  Attendance,
  BookingView,
  LinkBookingView,
} from '@/lib/booking-links/bookings'
import { cn } from '@/lib/utils'
import { Check, Search, UserX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export interface LinkChoice {
  id: string
  title: string
  active: boolean
}

interface ListBody {
  bookings: LinkBookingView[]
  more: boolean
  links: LinkChoice[]
  error?: string
}

const VIEWS: Array<{ id: BookingView; label: string }> = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
]

const STATE_LABEL: Record<string, string> = {
  requested: 'Waiting on your yes',
  booking: 'Being booked',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  declined: 'Declined',
  expired: 'Lapsed',
  failed: 'Failed',
}

/** "Thursday, November 20" in the browser's zone. Pure. */
export function dayLabel(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/** "10:00 – 10:30 AM". Pure. */
export function timeRange(
  startIso: string,
  endIso: string,
  locale?: string,
): string {
  const f = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })
  return `${f(startIso)} – ${f(endIso)}`
}

/** The bookings in runs of one local day each, in their order. Pure. */
export function byDay(
  bookings: readonly LinkBookingView[],
): Array<{ day: string; bookings: LinkBookingView[] }> {
  const out: Array<{ day: string; bookings: LinkBookingView[] }> = []
  for (const b of bookings) {
    const day = new Date(b.starts_at).toDateString()
    const last = out[out.length - 1]
    if (last?.day === day) last.bookings.push(b)
    else out.push({ day, bookings: [b] })
  }
  return out
}

export function LinkBookingsPanel() {
  const [view, setView] = useState<BookingView>('upcoming')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [link, setLink] = useState('')
  const [rows, setRows] = useState<LinkBookingView[] | null>(null)
  const [links, setLinks] = useState<LinkChoice[]>([])
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const seq = useRef(0)

  // A search is sent once typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(
    async (offset: number) => {
      const mine = ++seq.current
      const params = new URLSearchParams({ view, offset: String(offset) })
      if (query) params.set('q', query)
      if (link) params.set('link', link)
      try {
        const res = await fetch(`/api/account/link-bookings?${params}`)
        const body = (await res.json().catch(() => ({}))) as ListBody
        if (mine !== seq.current) return
        if (!res.ok) {
          setError(body.error ?? 'Could not read your bookings')
          return
        }
        setError(null)
        setLinks(body.links ?? [])
        setMore(body.more)
        setRows((prev) =>
          offset ? [...(prev ?? []), ...body.bookings] : body.bookings,
        )
      } catch {
        if (mine === seq.current) setError('Network error')
      }
    },
    [view, query, link],
  )

  useEffect(() => {
    setRows(null)
    void load(0)
  }, [load])

  const mark = useCallback(
    async (booking: LinkBookingView, next: Attendance | null) => {
      const before = booking.attendance
      setRows(
        (prev) =>
          prev?.map((b) =>
            b.id === booking.id ? { ...b, attendance: next } : b,
          ) ?? prev,
      )
      try {
        const res = await fetch(
          `/api/account/link-bookings/${booking.id}/attendance`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attendance: next }),
          },
        )
        if (!res.ok)
          throw new Error(
            ((await res.json().catch(() => ({}))) as { error?: string })
              .error ?? 'Could not save',
          )
      } catch (err) {
        setRows(
          (prev) =>
            prev?.map((b) =>
              b.id === booking.id ? { ...b, attendance: before } : b,
            ) ?? prev,
        )
        toast.error(err instanceof Error ? err.message : 'Could not save')
      }
    },
    [],
  )

  const groups = useMemo(() => byDay(rows ?? []), [rows])
  const filtered = !!query || !!link

  return (
    <div data-link-bookings="">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Which bookings"
          className="inline-flex rounded-md border p-0.5"
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className={cn(
                'rounded px-2.5 py-1 text-xs',
                view === v.id
                  ? 'bg-muted text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search guest or title"
            aria-label="Search bookings"
            className="h-8 pl-7 text-sm"
            maxLength={100}
          />
        </div>
        {links.length > 0 && (
          <select
            aria-label="Link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            className="bg-background h-8 rounded-md border px-2 text-sm"
          >
            <option value="">All links</option>
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
                {l.active ? '' : ' (off)'}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="text-destructive mt-6 text-sm">{error}</p>}

      {!rows && !error && (
        <div className="mt-6 space-y-2" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <p className="text-muted-foreground mt-6 text-sm">
          {filtered
            ? 'No bookings match.'
            : view === 'upcoming'
              ? 'Nothing booked yet. When someone books one of your links, it shows here.'
              : view === 'past'
                ? 'No past bookings yet.'
                : 'Nothing cancelled.'}
        </p>
      )}

      {groups.map((g) => (
        <section key={g.day} className="mt-6">
          <h3 className="text-muted-foreground text-xs font-medium">
            {dayLabel(g.bookings[0].starts_at)}
          </h3>
          <ul className="mt-2 divide-y rounded-md border">
            {g.bookings.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
                data-booking-id={b.id}
              >
                <div className="w-32 shrink-0 text-sm tabular-nums">
                  {timeRange(b.starts_at, b.ends_at)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {b.guest_name}
                  </div>
                  <div className="text-muted-foreground truncate text-xs">
                    {[
                      b.link_title ?? b.title,
                      b.guest_email ?? b.guest_phone,
                      b.organizer ? null : `with ${b.host_name}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                {b.can_mark ? (
                  <div
                    className="flex gap-1"
                    role="group"
                    aria-label={`Did ${b.guest_name} come?`}
                  >
                    <Button
                      size="sm"
                      variant={
                        b.attendance === 'attended' ? 'secondary' : 'ghost'
                      }
                      aria-pressed={b.attendance === 'attended'}
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() =>
                        void mark(
                          b,
                          b.attendance === 'attended' ? null : 'attended',
                        )
                      }
                    >
                      <Check className="size-3.5" aria-hidden /> Attended
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        b.attendance === 'no_show' ? 'secondary' : 'ghost'
                      }
                      aria-pressed={b.attendance === 'no_show'}
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() =>
                        void mark(
                          b,
                          b.attendance === 'no_show' ? null : 'no_show',
                        )
                      }
                    >
                      <UserX className="size-3.5" aria-hidden /> No-show
                    </Button>
                  </div>
                ) : (
                  <span
                    className={cn(
                      'text-xs',
                      b.state === 'confirmed'
                        ? 'text-muted-foreground'
                        : 'text-foreground',
                    )}
                  >
                    {b.state === 'cancelled' && b.cancelled_by
                      ? `Cancelled by ${b.cancelled_by === 'guest' ? 'the guest' : 'a host'}`
                      : STATE_LABEL[b.state]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {more && (
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={async () => {
              setLoadingMore(true)
              await load(rows?.length ?? 0)
              setLoadingMore(false)
            }}
          >
            {loadingMore ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}
    </div>
  )
}
