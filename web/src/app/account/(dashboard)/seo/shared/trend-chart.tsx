'use client'

/**
 * A small line chart for the SEO pages (a keyword's position over time,
 * clicks per day, referring domains per month). Hand-drawn SVG: the app has
 * no chart library, and a few lines over a date axis do not need one.
 *
 *   - Lines take the theme's colours through `currentColor` (each series
 *     names a Tailwind text colour with its dark pair), so there is no raw
 *     hex and dark mode just works.
 *   - `invert` puts 1 at the top, for rank positions where lower is better.
 *   - A gap in the data (null) is a gap in the line, never a line to zero:
 *     "not found" is not position 0.
 *   - Hovering (or moving along it with the keyboard) reads one date out in
 *     the line above the chart; the readout is real text, not a tooltip.
 *   - The picture has a sentence for assistive tech (`summary`), and the
 *     numbers themselves belong in the table beside it.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TrendSeries {
  key: string
  label: string
  /** One value per entry of `dates`; null where there is none. */
  values: ReadonlyArray<number | null>
  /** Tailwind text colour classes, with a dark pair ("text-sky-600 dark:text-sky-400"). */
  tone: string
}

export const TREND_TONES = [
  'text-sky-600 dark:text-sky-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-violet-600 dark:text-violet-400',
  'text-rose-600 dark:text-rose-400',
] as const

const W = 600
const PAD_Y = 6

function bounds(series: readonly TrendSeries[]): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const s of series) {
    for (const v of s.values) {
      if (v === null || !Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (min === Infinity) return null
  // A flat line still needs a band to sit in.
  if (min === max) return { min: min - 1, max: max + 1 }
  return { min, max }
}

/** The SVG path of one series: a new sub-path after every gap. */
export function trendPath(values: ReadonlyArray<number | null>, range: { min: number; max: number }, height: number, invert: boolean): string {
  const n = values.length
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => {
    const t = (v - range.min) / (range.max - range.min)
    const up = invert ? t : 1 - t
    return PAD_Y + up * (height - PAD_Y * 2)
  }
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
    pen = true
  })
  return d.trim()
}

const shortDate = (iso: string, withYear = false) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

/** A range that crosses a year's end, or is about a year long, names the year: "Nov 1" at both ends says nothing. */
export function trendSpansYears(dates: readonly string[]): boolean {
  if (dates.length < 2) return false
  const first = new Date(dates[0])
  const last = new Date(dates[dates.length - 1])
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return false
  return first.getUTCFullYear() !== last.getUTCFullYear() || Math.abs(last.getTime() - first.getTime()) >= 330 * 86_400_000
}

export function TrendChart({
  dates,
  series,
  summary,
  invert = false,
  height = 120,
  format = (v: number) => v.toLocaleString(),
  emptyText = 'Not enough history yet',
  className,
}: {
  /** ISO dates, oldest first: the shared x axis. */
  dates: readonly string[]
  series: readonly TrendSeries[]
  /** One sentence saying what the chart shows, for assistive tech. */
  summary: string
  /** Lower is better (rank positions): the smallest value sits at the top. */
  invert?: boolean
  height?: number
  format?: (value: number) => string
  emptyText?: string
  className?: string
}) {
  const [at, setAt] = React.useState<number | null>(null)
  const range = bounds(series)
  const n = dates.length

  if (!range || n < 2) {
    return (
      <p data-seo-trend-empty="" className={cn('py-6 text-center text-xs text-muted-foreground', className)}>
        {emptyText}
      </p>
    )
  }

  const index = at === null ? n - 1 : Math.min(Math.max(at, 0), n - 1)
  const fromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width <= 0) return
    setAt(Math.round(((event.clientX - box.left) / box.width) * (n - 1)))
  }
  const onKey = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'ArrowLeft') setAt(Math.max(0, index - 1))
    else if (event.key === 'ArrowRight') setAt(Math.min(n - 1, index + 1))
    else return
    event.preventDefault()
  }
  const top = invert ? range.min : range.max
  const bottom = invert ? range.max : range.min
  const withYear = trendSpansYears(dates)

  return (
    <div data-seo-trend="" className={cn('min-w-0', className)}>
      {/* The readout: the date under the pointer (the newest when there is none) and each line's value there. */}
      <p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" aria-live="off">
        <span className="tabular-nums">{shortDate(dates[index], withYear)}</span>
        {series.map((s) => {
          const v = s.values[index]
          return (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span aria-hidden className={cn('inline-block h-1.5 w-1.5 rounded-full bg-current', s.tone)} />
              <span>{s.label}</span>
              <span className="tabular-nums text-foreground">{v === null || v === undefined ? '—' : format(v)}</span>
            </span>
          )
        })}
      </p>
      {/* A grid, so the value column is as wide as its longest label ("12,480") and the dates sit under the plot, not under the labels. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div className="flex min-w-8 flex-col justify-between whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground/70" aria-hidden>
          <span>{format(top)}</span>
          <span>{format(bottom)}</span>
        </div>
        <svg
          role="img"
          aria-label={summary}
          tabIndex={0}
          viewBox={`0 0 ${W} ${height}`}
          preserveAspectRatio="none"
          className="block w-full min-w-0 touch-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ height }}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={() => setAt(null)}
          onKeyDown={onKey}
        >
          {/* The band's edges and middle, quietly. */}
          {[PAD_Y, height / 2, height - PAD_Y].map((y) => (
            <line key={y} x1={0} x2={W} y1={y} y2={y} className="text-border" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {at !== null && (
            <line
              x1={(index / (n - 1)) * W}
              x2={(index / (n - 1)) * W}
              y1={0}
              y2={height}
              className="text-muted-foreground/50"
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {series.map((s) => (
            <path
              key={s.key}
              data-seo-trend-line={s.key}
              d={trendPath(s.values, range, height, invert)}
              className={s.tone}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <span aria-hidden />
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground/70" aria-hidden>
          <span>{shortDate(dates[0], withYear)}</span>
          <span>{shortDate(dates[n - 1], withYear)}</span>
        </div>
      </div>
    </div>
  )
}

/** A word-sized trend with no axes, for a table cell: the last few values of one series. */
export function Sparkline({ values, invert = false, tone = TREND_TONES[0], label, className }: { values: ReadonlyArray<number | null>; invert?: boolean; tone?: string; label: string; className?: string }) {
  const range = bounds([{ key: 's', label, values, tone }])
  if (!range || values.filter((v) => v !== null).length < 2) return null
  const height = 20
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={cn('block h-5 w-16', tone, className)}>
      <path d={trendPath(values, range, height, invert)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
