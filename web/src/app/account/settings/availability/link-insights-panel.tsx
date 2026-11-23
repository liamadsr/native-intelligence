'use client'

/**
 * Availability › Insights (booking insights, phase 2): your link bookings
 * counted over the last 7, 30 or 90 days or a range you pick
 * (/api/account/link-bookings/insights; src/lib/booking-links/insights.ts),
 * in your browser's zone.
 *
 *   Tiles        bookings, meeting hours, no-shows (and their share of those
 *                marked), cancelled.
 *   Over time    bookings and cancellations per day (per week past 92 days):
 *                columns, hover for the day's numbers.
 *   Top links    bookings per link, direct-labelled bars.
 *   Export CSV   the range's bookings, one row each.
 *
 * Charts are our own SVG (as the spreadsheet charts are: niceTicks,
 * compactNumber); the two series' colours were checked for colour-blind
 * separation in light and dark. A table under each chart says the same for a
 * screen reader.
 */
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  BookingInsights,
  InsightBucket,
} from '@/lib/booking-links/insights'
import { compactNumber, niceTicks } from '@/lib/spreadsheets/charts'
import { cn } from '@/lib/utils'
import { Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LinkChoice } from './link-bookings-panel'

type Range =
  | { kind: 'days'; days: 7 | 30 | 90 }
  | { kind: 'custom'; from: string; to: string }

/** Booked and cancelled: blue and orange, a pair that stays apart for colour-blind readers in both themes. */
const BOOKED = 'fill-[#2563EB] dark:fill-[#3B82F6]'
const CANCELLED = 'fill-[#EA580C]'
const BOOKED_BG = 'bg-[#2563EB] dark:bg-[#3B82F6]'
const CANCELLED_BG = 'bg-[#EA580C]'

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The query a range asks with. Pure. */
export function rangeQuery(range: Range, tz: string, link: string): string {
  const p = new URLSearchParams(
    range.kind === 'days'
      ? { days: String(range.days) }
      : { from: range.from, to: range.to },
  )
  p.set('tz', tz)
  if (link) p.set('link', link)
  return p.toString()
}

/** "1.5 h", "12 h". Pure. */
export function hoursLabel(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`
}

/** "Nov 20" for a YYYY-MM-DD. Pure. */
export function shortDay(date: string, locale?: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function LinkInsightsPanel() {
  const [range, setRange] = useState<Range>({ kind: 'days', days: 30 })
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [link, setLink] = useState('')
  const [links, setLinks] = useState<LinkChoice[]>([])
  const [data, setData] = useState<BookingInsights | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tz = useMemo(browserZone, [])
  const query = rangeQuery(range, tz, link)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    fetch(`/api/account/link-bookings/insights?${query}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          insights?: BookingInsights
          links?: LinkChoice[]
          error?: string
        }
        if (!live) return
        if (!res.ok || !body.insights)
          setError(body.error ?? 'Could not read the insights')
        else {
          setData(body.insights)
          setLinks(body.links ?? [])
        }
      })
      .catch(() => live && setError('Network error'))
    return () => {
      live = false
    }
  }, [query])

  const t = data?.totals
  const rate =
    t?.no_show_rate === null || t?.no_show_rate === undefined
      ? null
      : Math.round(t.no_show_rate * 100)

  return (
    <div data-link-insights="">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Range"
          className="inline-flex rounded-md border p-0.5"
        >
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              aria-pressed={range.kind === 'days' && range.days === d}
              onClick={() => setRange({ kind: 'days', days: d })}
              className={cn(
                'rounded px-2.5 py-1 text-xs',
                range.kind === 'days' && range.days === d
                  ? 'bg-muted text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {d} days
            </button>
          ))}
          <button
            aria-pressed={range.kind === 'custom'}
            onClick={() =>
              draft.from && draft.to && setRange({ kind: 'custom', ...draft })
            }
            className={cn(
              'rounded px-2.5 py-1 text-xs',
              range.kind === 'custom'
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Custom
          </button>
        </div>
        <Input
          type="date"
          aria-label="From"
          value={draft.from}
          onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          className="h-8 w-36 text-sm"
        />
        <Input
          type="date"
          aria-label="To"
          value={draft.to}
          onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          className="h-8 w-36 text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={!draft.from || !draft.to}
          onClick={() => setRange({ kind: 'custom', ...draft })}
        >
          Apply
        </Button>
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
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant="ghost" className="ml-auto h-8 gap-1" asChild>
          <a href={`/api/account/link-bookings/export?${query}`} download>
            <Download className="size-3.5" aria-hidden /> Export CSV
          </a>
        </Button>
      </div>

      {error && <p className="text-destructive mt-6 text-sm">{error}</p>}
      {!data && !error && (
        <div
          className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4"
          aria-label="Loading"
        >
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}

      {data && t && (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label="Bookings"
              value={String(t.booked)}
              note={t.requested ? `${t.requested} waiting on you` : null}
            />
            <Tile
              label="Meeting hours"
              value={hoursLabel(t.hours)}
              note={null}
            />
            <Tile
              label="No-shows"
              value={String(t.no_shows)}
              note={
                rate === null ? 'None marked yet' : `${rate}% of those marked`
              }
            />
            <Tile
              label="Cancelled"
              value={String(t.cancelled)}
              note={t.declined ? `${t.declined} declined or lapsed` : null}
            />
          </dl>
          {data.truncated && (
            <p className="text-muted-foreground mt-2 text-xs">
              Only the first 5,000 bookings in this range are counted.
            </p>
          )}

          <section className="mt-8" aria-labelledby="insights-over-time">
            <div className="flex items-center justify-between">
              <h3 id="insights-over-time" className="text-sm font-medium">
                Bookings over time
              </h3>
              <div
                className="text-muted-foreground flex gap-3 text-xs"
                aria-hidden
              >
                <span className="flex items-center gap-1">
                  <span
                    className={cn(
                      'inline-block size-2.5 rounded-sm',
                      BOOKED_BG,
                    )}
                  />{' '}
                  Booked
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className={cn(
                      'inline-block size-2.5 rounded-sm',
                      CANCELLED_BG,
                    )}
                  />{' '}
                  Cancelled
                </span>
              </div>
            </div>
            <OverTime series={data.series} bucket={data.bucket} />
          </section>

          <section className="mt-8" aria-labelledby="insights-top-links">
            <h3 id="insights-top-links" className="text-sm font-medium">
              Top links
            </h3>
            {data.top_links.length === 0 ? (
              <p className="text-muted-foreground mt-2 text-sm">
                No bookings in this range.
              </p>
            ) : (
              <TopLinks links={data.top_links} />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Tile({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string | null
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
      {note && <dd className="text-muted-foreground text-[11px]">{note}</dd>}
    </div>
  )
}

const W = 640
const H = 180
const PAD = { top: 8, right: 8, bottom: 22, left: 28 }

function OverTime({
  series,
  bucket,
}: {
  series: InsightBucket[]
  bucket: 'day' | 'week'
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...series.map((b) => b.booked + b.cancelled))
  const ticks = niceTicks(0, max, 4)
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const slot = innerW / Math.max(1, series.length)
  const barW = Math.max(2, Math.min(24, slot - 2))
  const y = (v: number) => PAD.top + innerH - (v / ticks.max) * innerH
  const labelEvery = Math.ceil(series.length / 8)
  const shown = hover === null ? null : series[hover]

  return (
    <div className="relative mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="text-foreground h-auto w-full"
        role="img"
        aria-label={`Bookings per ${bucket}`}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="currentColor"
              strokeOpacity={v === 0 ? 0.3 : 0.08}
            />
            <text
              x={PAD.left - 6}
              y={y(v)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {compactNumber(v)}
            </text>
          </g>
        ))}
        {series.map((b, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2
          const bookedTop = y(b.booked)
          const cancelledTop = y(b.booked + b.cancelled)
          // A 2px surface gap between the stacked parts.
          const gap = b.booked && b.cancelled ? 2 : 0
          return (
            <g key={b.date}>
              {b.booked > 0 && (
                <rect
                  x={x}
                  y={bookedTop}
                  width={barW}
                  height={y(0) - bookedTop}
                  rx={Math.min(3, barW / 2)}
                  className={BOOKED}
                />
              )}
              {b.cancelled > 0 && (
                <rect
                  x={x}
                  y={cancelledTop}
                  width={barW}
                  height={Math.max(1, bookedTop - cancelledTop - gap)}
                  rx={Math.min(3, barW / 2)}
                  className={CANCELLED}
                />
              )}
              {i % labelEvery === 0 && (
                <text
                  x={x + barW / 2}
                  y={H - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {shortDay(b.date)}
                </text>
              )}
              {/* The hover target is the whole column, taller and wider than the bar. */}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
              />
            </g>
          )
        })}
        {hover !== null && (
          <line
            x1={PAD.left + hover * slot + slot / 2}
            x2={PAD.left + hover * slot + slot / 2}
            y1={PAD.top}
            y2={y(0)}
            stroke="currentColor"
            strokeOpacity={0.15}
            pointerEvents="none"
          />
        )}
      </svg>
      {shown && (
        <div
          className="bg-popover pointer-events-none absolute top-0 right-0 rounded-md border px-2 py-1 text-xs shadow-sm"
          role="status"
        >
          <div className="font-medium">
            {bucket === 'week' ? 'Week of ' : ''}
            {shortDay(shown.date)}
          </div>
          <div className="tabular-nums">
            {shown.booked} booked · {shown.cancelled} cancelled
          </div>
        </div>
      )}
      <table className="sr-only">
        <caption>Bookings per {bucket}</caption>
        <thead>
          <tr>
            <th>{bucket === 'week' ? 'Week of' : 'Day'}</th>
            <th>Booked</th>
            <th>Cancelled</th>
          </tr>
        </thead>
        <tbody>
          {series.map((b) => (
            <tr key={b.date}>
              <td>{b.date}</td>
              <td>{b.booked}</td>
              <td>{b.cancelled}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TopLinks({ links }: { links: BookingInsights['top_links'] }) {
  const max = Math.max(1, ...links.map((l) => l.bookings))
  return (
    <ul className="mt-3 space-y-2">
      {links.map((l) => (
        <li
          key={l.link_id ?? 'deleted'}
          className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm"
          title={`${l.title}: ${l.bookings} bookings, ${hoursLabel(l.hours)}`}
        >
          <span className="truncate">{l.title}</span>
          <span className="bg-muted h-2.5 rounded-r-sm" aria-hidden>
            <span
              className={cn('block h-full rounded-r-sm', BOOKED_BG)}
              style={{ width: `${(l.bookings / max) * 100}%` }}
            />
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {l.bookings} · {hoursLabel(l.hours)}
          </span>
        </li>
      ))}
    </ul>
  )
}
