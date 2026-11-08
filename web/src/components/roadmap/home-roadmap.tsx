// The homepage's "What we're building" section: the roadmap's Now items as
// compact cards, a count of what comes after, and links to /roadmap and the
// feature request form.
//
// A server component with no client JS. `page.tsx` renders `HomeRoadmapSlot`
// and hands it to the (client) landing page as a prop, so GitHub is only ever
// read on the server, through the same five-minute cache as /roadmap.

import { Suspense } from 'react'
import { ArrowUpRight, ThumbsUp } from 'lucide-react'
import { ROADMAP_SUGGEST_URL } from '@/lib/roadmap/constants'
import { getRoadmap } from '@/lib/roadmap/fetch'
import type { RoadmapData } from '@/lib/roadmap/parse'

const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors'

/**
 * Pure: renders `data` as-is. Nothing to show (GitHub unreadable, or no Now
 * items) renders nothing at all, not an empty section.
 */
export function HomeRoadmap({ data }: { data: RoadmapData }) {
  const now = data.horizons.now
  if (!data.ok || now.length === 0) return null

  const more = data.horizons.next.length + data.horizons.later.length

  return (
    <section id="roadmap" className="py-24 lg:py-32 relative">
      <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
        <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
      </div>
      <div className="w-full px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
              What we’re building
            </h2>
            <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
              Our roadmap is public. Vote on what matters to you, and suggest what’s missing.
            </p>
          </div>

          <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {now.map((item) => (
              <li key={item.number}>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-full flex-col justify-between gap-4 rounded-2xl border border-border bg-secondary/30 p-6 text-left transition-colors hover:bg-secondary/60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-medium text-foreground">{item.title}</h3>
                    {item.status === 'in_progress' && (
                      <span className="shrink-0 rounded-full border border-foreground/20 bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-foreground">
                        In progress
                      </span>
                    )}
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Votes for">
                    <ThumbsUp className="size-3.5" aria-hidden />
                    <span className="tabular-nums">{item.up}</span>
                    <span className="sr-only">votes for</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>

          {more > 0 && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              <a href="/roadmap" className="underline-offset-4 hover:text-foreground hover:underline">
                and {more} more up next
              </a>
            </p>
          )}

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
