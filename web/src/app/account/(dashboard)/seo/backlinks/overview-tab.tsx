'use client'

/**
 * A looked-up site's Overview tab: the totals the overview carries, as tiles
 * in plain words with the SEO term in their titles (sites linking, links,
 * the followed share, this month's new and lost sites, the provider's rank
 * and spam score; a tile with no number is not drawn), then the year's
 * history as two small charts, sites linking and links. They are two charts,
 * not two lines on one: links run to many times the sites, and on a shared
 * scale the sites' line would lie flat along the bottom. No history (a page
 * or a folder: the scope note under the result says why) draws no chart.
 */
import { Link2Off } from 'lucide-react'
import type { BacklinksOverview } from '@/lib/seo/backlinks/view'
import { StatTiles } from '../shared/stat-tiles'
import { TREND_TONES, TrendChart } from '../shared/trend-chart'
import { overviewTiles, trendSummary } from './helpers'

export function OverviewTab({ overview, own }: { overview: BacklinksOverview; own: boolean }) {
  const s = overview.summary
  if (!s.backlinks && !s.referring_domains) {
    return (
      <div data-seo-no-links="" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Link2Off className="h-7 w-7 text-muted-foreground/60" aria-hidden />
        <p className="text-sm text-muted-foreground">No links found for this site yet</p>
      </div>
    )
  }
  const history = overview.history
  const dates = history.map((p) => p.date)
  const charted = history.length >= 2
  return (
    <div data-seo-overview="" className="@container">
      <StatTiles tiles={overviewTiles(overview, own)} />
      {charted && (
        <div className="mt-6 grid gap-6 @3xl:grid-cols-2">
          <section data-seo-trend-sites="" className="min-w-0">
            <h2 className="mb-2 text-[11px] font-medium text-muted-foreground">{own ? 'Sites linking to you' : 'Sites linking to it'}</h2>
            <TrendChart
              dates={dates}
              series={[{ key: 'sites', label: 'Sites', values: history.map((p) => p.referring_domains), tone: TREND_TONES[0] }]}
              summary={trendSummary(history, 'referring_domains', 'Sites linking')}
            />
          </section>
          <section data-seo-trend-links="" className="min-w-0">
            <h2 className="mb-2 text-[11px] font-medium text-muted-foreground">Links</h2>
            <TrendChart
              dates={dates}
              series={[{ key: 'links', label: 'Links', values: history.map((p) => p.backlinks), tone: TREND_TONES[1] }]}
              summary={trendSummary(history, 'backlinks', 'Links')}
            />
          </section>
        </div>
      )}
    </div>
  )
}
