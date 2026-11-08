// The roadmap's Now / Next / Later columns and its Shipped list. Presentational
// only (no hooks, no fetch): /roadmap and the docs page pass in the data from
// `getRoadmap()`, and tests render it straight to HTML.

import { ArrowUpRight, ThumbsDown, ThumbsUp } from 'lucide-react'
import { clsx } from 'clsx'
import { ROADMAP_ISSUES_URL } from '@/lib/roadmap/constants'
import { ROADMAP_HORIZONS, type RoadmapData, type RoadmapHorizon, type RoadmapItem } from '@/lib/roadmap/parse'

const HORIZON_COPY: Record<RoadmapHorizon, { title: string; blurb: string }> = {
  now: { title: 'Now', blurb: 'What we are building this quarter.' },
  next: { title: 'Next', blurb: 'What we plan to start after that.' },
  later: { title: 'Later', blurb: 'Further out. Likely to change.' },
}

function Votes({ item }: { item: RoadmapItem }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1" title="Votes for">
        <ThumbsUp className="size-3.5" aria-hidden />
        <span className="tabular-nums">{item.up}</span>
        <span className="sr-only">votes for</span>
      </span>
      <span className="inline-flex items-center gap-1" title="Votes against">
        <ThumbsDown className="size-3.5" aria-hidden />
        <span className="tabular-nums">{item.down}</span>
        <span className="sr-only">votes against</span>
      </span>
    </div>
  )
}

function RoadmapCard({ item }: { item: RoadmapItem }) {
  return (
    <li className="flex flex-col rounded-2xl border border-border bg-background/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{item.title}</h3>
        {item.status === 'in_progress' && (
          <span className="shrink-0 rounded-full border border-foreground/20 bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-foreground">
            In progress
          </span>
        )}
      </div>
      {item.summary && (
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{item.summary}</p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 pt-1">
        <Votes item={item} />
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Vote on “${item.title}” on GitHub`}
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          Vote
          <ArrowUpRight className="size-3" aria-hidden />
        </a>
      </div>
    </li>
  )
}

function HorizonColumn({ horizon, items, quarter }: { horizon: RoadmapHorizon; items: RoadmapItem[]; quarter: string | null }) {
  const copy = HORIZON_COPY[horizon]
  return (
    <section aria-labelledby={`roadmap-${horizon}`} className="flex flex-col">
      <div className="border-b border-border pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={`roadmap-${horizon}`} className="text-lg font-medium tracking-tight text-foreground">
            {copy.title}
          </h2>
          {quarter && <span className="font-mono text-xs text-muted-foreground">{quarter}</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{copy.blurb}</p>
      </div>
      {items.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((item) => (
            <RoadmapCard key={item.number} item={item} />
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          Nothing here yet.
        </p>
      )}
    </section>
  )
}

function ShippedList({ items }: { items: RoadmapItem[] }) {
  return (
    <section aria-labelledby="roadmap-shipped" className="mt-16">
      <div className="border-b border-border pb-3">
        <h2 id="roadmap-shipped" className="text-lg font-medium tracking-tight text-foreground">
          Shipped
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">Done and in your hands.</p>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {items.map((item) => (
          <li key={item.number} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-foreground hover:underline"
              >
                {item.title}
              </a>
              {item.summary && <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>}
            </div>
            {item.quarter && <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.quarter}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function RoadmapFallback({ className }: { className?: string }) {
  return (
    <div className={clsx('rounded-2xl border border-border p-8 text-center', className)}>
      <p className="text-sm text-muted-foreground">The roadmap could not be loaded right now.</p>
      <a
        href={ROADMAP_ISSUES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        See the roadmap on GitHub
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
    </div>
  )
}

export function RoadmapTimeline({ data, className }: { data: RoadmapData; className?: string }) {
  if (!data.ok) return <RoadmapFallback className={className} />
  return (
    // A container query, not a viewport one: the docs column is narrower than
    // the marketing page, so the columns stack there until they have room.
    <div className={clsx('@container', className)}>
      <div className="grid gap-10 @3xl:grid-cols-3 @3xl:gap-6">
        {ROADMAP_HORIZONS.map((horizon) => (
          <HorizonColumn
            key={horizon}
            horizon={horizon}
            items={data.horizons[horizon]}
            quarter={data.quarters[horizon]}
          />
        ))}
      </div>
      {data.shipped.length > 0 && <ShippedList items={data.shipped} />}
    </div>
  )
}
