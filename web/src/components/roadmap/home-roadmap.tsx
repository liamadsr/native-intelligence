// The homepage's "What we're building" section: the roadmap as a board (Now,
// Next, Later), and links to /roadmap and the feature request form.
//
// A server component with no client JS. `page.tsx` renders `HomeRoadmapSlot`
// and hands it to the (client) landing page as a prop, so GitHub is only ever
// read on the server, through the same five-minute cache as /roadmap.

import { Suspense } from 'react'
import { ArrowUpRight, ThumbsUp } from 'lucide-react'
import { ROADMAP_SUGGEST_URL } from '@/lib/roadmap/constants'
import { getRoadmap } from '@/lib/roadmap/fetch'
import type { RoadmapData, RoadmapHorizon, RoadmapItem } from '@/lib/roadmap/parse'

const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors'

/** How many items a column shows before it says how many more there are. */
const COLUMN_LIMIT = 4

const COLUMNS: readonly { horizon: RoadmapHorizon; label: string; note: string }[] = [
  { horizon: 'now', label: 'Now', note: 'Being built' },
  { horizon: 'next', label: 'Next', note: 'Up after that' },
  { horizon: 'later', label: 'Later', note: 'On the list' },
]

function Item({ item }: { item: RoadmapItem }) {
  const building = item.status === 'in_progress'
  return (
    <li>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex flex-col gap-1.5 rounded-xl border border-transparent px-3 py-3 text-left transition-colors hover:border-foreground/15 hover:bg-foreground/[0.05]"
      >
        <span className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-start gap-2.5">
            {/* Lit and beating while it is being built; a ring while it waits. */}
            <span className="relative mt-[0.45rem] flex h-2 w-2 shrink-0">
              {building && <span className="absolute inset-0 rounded-full bg-foreground/60 motion-safe:animate-ping" />}
              <span className={building ? 'relative h-2 w-2 rounded-full bg-foreground' : 'relative h-2 w-2 rounded-full border border-foreground/40'} />
            </span>
            <span className="font-medium text-foreground">{item.title}</span>
          </span>
          <ArrowUpRight
            aria-hidden
            className="mt-1 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </span>
        {item.summary && <span className="line-clamp-2 pl-[1.125rem] text-sm text-muted-foreground">{item.summary}</span>}
        <span className="flex items-center gap-3 pl-[1.125rem] text-xs text-muted-foreground">
          {building && <span className="font-medium text-foreground">In progress</span>}
          {item.quarter && <span>{item.quarter}</span>}
          {/* A count is shown once there is one: a row of zeros says nothing. */}
          {item.up > 0 && (
            <span className="inline-flex items-center gap-1" title="Votes for">
              <ThumbsUp className="size-3.5" aria-hidden />
              <span className="tabular-nums">{item.up}</span>
              <span className="sr-only">votes for</span>
            </span>
          )}
        </span>
      </a>
    </li>
  )
}

/**
 * Pure: renders `data` as-is. Nothing to show (GitHub unreadable, or no Now
 * items) renders nothing at all, not an empty section.
 *
 * The roadmap as the board it is: Now, Next and Later side by side, each a
 * pane of clear glass over the sky, each item a link to its issue with the
 * line that says what it is. A column shows its first few and says how many
 * more there are.
 */
export function HomeRoadmap({ data }: { data: RoadmapData }) {
  if (!data.ok || data.horizons.now.length === 0) return null
  const columns = COLUMNS.filter((column) => data.horizons[column.horizon].length > 0)

  return (
    <section id="roadmap" className="py-24 lg:py-32 relative">
      <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
        <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
      </div>
      <div className="w-full px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-4xl lg:text-5xl">
              What we’re building
            </h2>
            <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
              Our roadmap is public. Vote on what matters to you, and suggest what’s missing.
            </p>
          </div>

          <div className={columns.length > 1 ? 'mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3' : 'mx-auto mt-14 max-w-xl'}>
            {columns.map((column) => {
              const items = data.horizons[column.horizon]
              const more = items.length - COLUMN_LIMIT
              return (
                <div key={column.horizon} className="flex flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-2 backdrop-blur-md">
                  <div className="flex items-baseline justify-between px-3 pt-3 pb-2">
                    <h3 className="font-heading text-xl font-light text-foreground">{column.label}</h3>
                    <span className="text-xs text-muted-foreground">
                      {column.note} · <span className="tabular-nums">{items.length}</span>
                    </span>
                  </div>
                  <ul className="flex flex-1 flex-col">
                    {items.slice(0, COLUMN_LIMIT).map((item) => (
                      <Item key={item.number} item={item} />
                    ))}
                  </ul>
                  {more > 0 && (
                    <a href="/roadmap" className="px-3 pt-1 pb-3 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                      and {more} more
                    </a>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
            <a href="/roadmap" className={SECONDARY_BUTTON}>
              See the full roadmap
            </a>
            <a href={ROADMAP_SUGGEST_URL} target="_blank" rel="noopener noreferrer" className={SECONDARY_BUTTON}>
              Suggest a feature
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

async function HomeRoadmapLoader() {
  return <HomeRoadmap data={await getRoadmap()} />
}

/**
 * The section as the homepage renders it. The Suspense boundary lets the rest
 * of the page stream without waiting on GitHub: a warm cache answers at once,
 * and a cold or slow fetch only holds back this section, which shows nothing
 * until it resolves.
 */
export function HomeRoadmapSlot() {
  return (
    <Suspense fallback={null}>
      <HomeRoadmapLoader />
    </Suspense>
  )
}
