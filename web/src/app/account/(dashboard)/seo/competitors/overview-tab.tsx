'use client'

/**
 * A looked-up site's Overview tab: its estimated visits from search and how
 * many searches it ranks for, as tiles (the provider's estimates, said so in
 * their titles and in one caption under them), then its top searches and
 * top pages side by side on a wide card, stacked on a narrow one.
 *
 * DomainOverview carries no top-3 or top-10 counts (its 100 top keywords are
 * a sample, not the whole), so those tiles are not drawn.
 */
import * as React from 'react'
import { SearchX } from 'lucide-react'
import type { DomainOverview } from '@/lib/seo/domain/view'
import { partialNoteText } from '../shared/partial-note'
import { StatTiles } from '../shared/stat-tiles'
import { cn } from '@/lib/utils'
import { keywordPath, num } from './helpers'

const SHORT = 10
const ESTIMATE = 'An estimate from the search data provider’s own crawl of Google, not the site’s analytics'

const KW_GRID = 'grid grid-cols-[minmax(0,1fr)_3.5rem_5rem_4.5rem] items-start gap-2'
const PAGE_GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-start gap-2'

export function OverviewTab({ overview, onSeeKeywords }: { overview: DomainOverview; onSeeKeywords: () => void }) {
  const [allPages, setAllPages] = React.useState(false)
  if (!overview.has_data) {
    return (
      <div data-seo-no-data="" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <SearchX className="h-7 w-7 text-muted-foreground/60" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">No search data for this site</p>
          <p className="mt-1 text-sm text-muted-foreground">It may be new, or too small to be measured yet.</p>
        </div>
      </div>
    )
  }
  const tiles = [
    overview.organic_traffic !== null
      ? { key: 'traffic', label: 'Estimated monthly visits from search', value: overview.organic_traffic, title: ESTIMATE }
      : null,
    overview.organic_keywords !== null
      ? { key: 'keywords', label: 'Searches it ranks for', value: overview.organic_keywords, title: 'Searches where this site shows in Google’s results, in this country' }
      : null,
  ].filter((t): t is NonNullable<typeof t> => t !== null)
  // A partial overview's caveats repeat what is missing; the note above the tabs says that already.
  const note = partialNoteText(overview.partial)
  const caveats = note ? overview.caveats.filter((c) => !note.includes(c.trim())) : overview.caveats
  const keywords = overview.top_keywords.slice(0, SHORT)
  const pages = allPages ? overview.top_pages : overview.top_pages.slice(0, SHORT)
  return (
    <div data-seo-overview="" className="@container">
      <StatTiles tiles={tiles} />
      {caveats.length > 0 && (
        <p data-seo-caveats="" className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {caveats.join(' ')}
        </p>
      )}
      {(keywords.length > 0 || pages.length > 0) && (
        <div className="mt-5 grid gap-6 @3xl:grid-cols-2">
          {keywords.length > 0 && (
            <section data-seo-top-keywords="" className="min-w-0">
              <ListHead title="Top searches" seeAll={overview.top_keywords.length > SHORT || (overview.organic_keywords ?? 0) > keywords.length ? onSeeKeywords : undefined} />
              <div aria-hidden className={cn(KW_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
                <span>Search</span>
                <span className="text-right" title="Where the site shows in Google’s results">
                  Position
                </span>
                <span className="text-right" title="Average searches a month">
                  Searches
                </span>
                <span className="text-right" title={ESTIMATE}>
                  Visits
                </span>
              </div>
              <ul>
                {keywords.map((row) => (
                  <li key={row.keyword} data-seo-top-keyword={row.keyword} className={cn(KW_GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
                    <span className="min-w-0 truncate text-xs text-foreground" title={row.keyword}>
                      {row.keyword}
                    </span>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">{num(row.position)}</span>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">{num(row.search_volume)}</span>
                    <span className="text-right text-xs tabular-nums text-foreground" title={ESTIMATE}>
                      {num(row.traffic)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {pages.length > 0 && (
            <section data-seo-top-pages="" className="min-w-0">
              <ListHead
                title="Top pages"
                seeAll={!allPages && overview.top_pages.length > SHORT ? () => setAllPages(true) : undefined}
              />
              <div aria-hidden className={cn(PAGE_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
                <span>Page</span>
                <span className="text-right" title={ESTIMATE}>
                  Visits
                </span>
                <span className="text-right" title="Searches the page ranks for">
                  Searches
                </span>
              </div>
              <ul>
                {pages.map((page) => (
                  <li key={page.url} data-seo-top-page={page.url} className={cn(PAGE_GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
                    <a
                      href={page.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={page.url}
                      className="min-w-0 truncate text-xs text-foreground underline-offset-2 hover:underline"
                    >
                      {page.relative_path ?? keywordPath({ url: page.url, relative_url: null })}
                    </a>
                    <span className="text-right text-xs tabular-nums text-foreground" title={ESTIMATE}>
                      {num(page.organic_traffic)}
                    </span>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">{num(page.keywords)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function ListHead({ title, seeAll }: { title: string; seeAll?: () => void }) {
  return (
    <div className="mb-1 flex h-7 items-center justify-between gap-2 px-1">
      <h2 className="text-xs font-medium text-foreground">{title}</h2>
      {seeAll && (
        <button
          type="button"
          data-seo-see-all={title}
          onClick={seeAll}
          className="-mr-1 h-7 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          See all
        </button>
      )}
    </div>
  )
}
