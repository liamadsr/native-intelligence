'use client'

/**
 * The stack calculator: pick the apps a team pays for today, set the number
 * of seats, and read the yearly bill beside Native Intelligence's. The
 * homepage shows it under "One app instead of twenty" and /replace-apps is
 * built round it.
 *
 * HOW IT WORKS. A row of app tiles that scrolls sideways (arrows and a
 * scrubber under it, or drag and swipe): a tile is a toggle, ticked when it
 * is in the sum. Under the row, a short ledger: the picked apps per seat, the
 * seats with a stepper and what the apps cost a year, what we cost a year,
 * and the difference.
 *
 * THE SUM IS SHOWN AS IT COMES OUT. The apps' prices are their vendors'
 * published list prices (lib/marketing/replace-apps.ts, each with the page it
 * was read from and the day it was read), ours is the pricing page's, and
 * when the apps picked cost less than we do the last row says so in the same
 * place it would have shown a saving.
 *
 * An app's mark is its official one where the icon set we already ship has
 * it, drawn in the page's ink; otherwise the tile shows its initial. No mark
 * is approximated.
 */
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Minus, Plus } from 'lucide-react'
import { clsx } from 'clsx'
import {
  SiAirtable,
  SiAsana,
  SiCaldotcom,
  SiCalendly,
  SiClickup,
  SiConfluence,
  SiHubspot,
  SiJira,
  SiLinear,
  SiNotion,
} from '@icons-pack/react-simple-icons'
import { SlackIcon } from '@/components/brand-icons'
import { DEFAULT_SELECTION, NI_PRICE_PER_SEAT, PRICES_READ_ON, REPLACED_APPS, stackCost } from '@/lib/marketing/replace-apps'

const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const cents = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const MARK = 'h-7 w-7'
const mono = { color: 'currentColor', className: MARK } as const

/** The official mark for an app, where we ship one. */
const MARKS: Record<string, React.ReactNode> = {
  Slack: <SlackIcon className={MARK} />,
  Calendly: <SiCalendly {...mono} />,
  'Cal.com': <SiCaldotcom {...mono} />,
  Linear: <SiLinear {...mono} />,
  Jira: <SiJira {...mono} />,
  Asana: <SiAsana {...mono} />,
  ClickUp: <SiClickup {...mono} />,
  Notion: <SiNotion {...mono} />,
  Confluence: <SiConfluence {...mono} />,
  Airtable: <SiAirtable {...mono} />,
  HubSpot: <SiHubspot {...mono} />,
}

function LedgerRow({ label, value, unit, strong = false, children }: { label: React.ReactNode; value: string; unit: string; strong?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-b-0">
      <span className={clsx('flex items-center gap-4', strong ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {label}
        {children}
      </span>
      <span className="whitespace-nowrap">
        <span className={clsx('tabular-nums text-foreground', strong ? 'border-b-2 border-foreground/40 pb-1 text-lg font-medium' : 'font-medium')}>{value}</span>
        <span className="ml-1 text-xs text-muted-foreground">{unit}</span>
      </span>
    </div>
  )
}

export function StackCalculator() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_SELECTION))
  const [seats, setSeats] = useState(5)
  const cost = useMemo(() => stackCost(selected, seats), [selected, seats])

  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  // The row's scroll position, as the scrubber shows it: where the window
  // starts and how wide it is, each a share of the whole row.
  const rowRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ start: 0, size: 1 })
  const measure = useCallback(() => {
    const row = rowRef.current
    if (!row || row.scrollWidth === 0) return
    setView({ start: row.scrollLeft / row.scrollWidth, size: Math.min(1, row.clientWidth / row.scrollWidth) })
  }, [])
  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const scrollBy = (direction: 1 | -1) => {
    const row = rowRef.current
    if (row) row.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: 'smooth' })
  }
  const atStart = view.start <= 0.001
  const atEnd = view.start + view.size >= 0.999

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div
        ref={rowRef}
        onScroll={measure}
        className="flex snap-x gap-2 overflow-x-auto pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {REPLACED_APPS.map((app) => {
          const on = selected.has(app.name)
          return (
            <button
              key={app.name}
              type="button"
              aria-pressed={on}
              aria-label={`${app.name}, ${cents(app.price)} per seat per month`}
              title={`${app.name} ${app.plan} · ${cents(app.price)}`}
              onClick={() => toggle(app.name)}
              className="group flex w-[6.5rem] shrink-0 snap-start flex-col items-center gap-3 rounded-2xl py-2 text-center"
            >
              <span
                className={clsx(
                  'relative flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-2xl border transition-colors',
                  on ? 'border-emerald-500 bg-emerald-500/10 text-foreground' : 'border-border bg-foreground/[0.05] text-muted-foreground group-hover:border-foreground/30 group-hover:text-foreground'
                )}
              >
                {MARKS[app.name] ?? <span className="text-2xl font-medium">{app.name[0]}</span>}
                <span
                  aria-hidden
                  className={clsx(
                    'absolute -bottom-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
                    on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border bg-background text-muted-foreground'
                  )}
                >
                  {on ? <Check className="h-3 w-3" strokeWidth={3} /> : <Plus className="h-3 w-3" strokeWidth={2.5} />}
                </span>
              </span>
              <span className={clsx('text-xs transition-colors', on ? 'font-medium text-foreground' : 'text-muted-foreground')}>{app.name}</span>
            </button>
          )
        })}
      </div>

      {/* Where you are in the row, and the way along it. */}
      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          aria-label="Scroll apps left"
          onClick={() => scrollBy(-1)}
          disabled={atStart}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground transition-opacity hover:bg-accent disabled:opacity-30"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div aria-hidden className="relative h-px flex-1 bg-border">
          <span
            className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/60"
            style={{ left: `${(view.start * 100).toFixed(2)}%`, width: `${(view.size * 100).toFixed(2)}%` }}
          />
        </div>
        <button
          type="button"
          aria-label="Scroll apps right"
          onClick={() => scrollBy(1)}
          disabled={atEnd}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground transition-opacity hover:bg-accent disabled:opacity-30"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mx-auto mt-8 max-w-md text-left">
        <LedgerRow label="Selected apps / seat" value={cents(cost.appsPerSeat)} unit="/ month" />
        <LedgerRow label="Seats" value={dollars(cost.appsPerYear)} unit="/ year">
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              aria-label="Remove a seat"
              onClick={() => setSeats((n) => Math.max(1, n - 1))}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span aria-live="polite" className="w-8 text-center tabular-nums text-foreground">
              {seats}
            </span>
            <button
              type="button"
              aria-label="Add a seat"
              onClick={() => setSeats((n) => Math.min(500, n + 1))}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </span>
        </LedgerRow>
        <LedgerRow label="Native Intelligence cost" value={dollars(cost.niPerYear)} unit="/ year" />
        {cost.savingPerYear >= 0 ? (
          <LedgerRow strong label="Estimated savings" value={dollars(cost.savingPerYear)} unit="/ year" />
        ) : (
          <LedgerRow strong label="Costs more than these apps by" value={dollars(-cost.savingPerYear)} unit="/ year" />
        )}
      </div>

      <p className="mx-auto mt-6 max-w-md text-center text-xs/5 text-muted-foreground">
        Estimates use each vendor’s published plan, read on {PRICES_READ_ON}. Native Intelligence is {dollars(NI_PRICE_PER_SEAT)} per seat per month.
      </p>
      <p className="mt-4 text-center">
        <Link href="/pricing" className="group inline-flex items-center gap-1.5 text-sm text-foreground/90 transition-colors hover:text-foreground">
          See pricing
          <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </p>
    </div>
  )
}
