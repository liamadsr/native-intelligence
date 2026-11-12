'use client'

/**
 * An audit's Pages tab: every crawled page, narrowed by a filter (All,
 * Errors, Redirects, Not indexed, Not in sitemap → the route's `show`), a
 * page at a time from GET …/audits/[id]/pages.
 *
 * A row: the answer (2xx muted, 3xx sky, an error or a failed fetch red; a
 * blocked or rate-limited fetch says so), the path with the page's title
 * under it, then its words, its links to other pages on the site and its
 * depth in clicks. On a narrow card the numbers drop (a container query,
 * as evals/run-page.tsx's tiles), never a sideways scroll.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { SiteAuditPageRow } from '@/lib/seo/audit/view'
import { cn } from '@/lib/utils'
import { fetchAuditPages, type AuditPageFilter } from './api'
import { PAGE_FILTERS, PAGE_STATUS_TONE, pageStatus, pathOf } from './ui-helpers'

const GRID = 'grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 @lg:grid-cols-[4.5rem_minmax(0,1fr)_4rem_4rem_3.5rem]'

export function AuditPages({ auditId, version }: { auditId: string; version: number }) {
  const [show, setShow] = React.useState<AuditPageFilter>('all')
  const [rows, setRows] = React.useState<SiteAuditPageRow[]>([])
  const [next, setNext] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setLoading(true)
      setError(false)
      if (!offset) setRows([])
      try {
        const page = await fetchAuditPages(auditId, { show, offset })
        if (ask !== asked.current) return
        setRows((r) => (offset ? [...r, ...page.rows] : page.rows))
        setNext(page.next_offset)
      } catch {
        if (ask === asked.current) setError(true)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [auditId, show],
  )

  React.useEffect(() => {
    void load(0)
  }, [load, version])

  return (
    <div data-seo-pages="" className="@container">
      <div role="radiogroup" aria-label="Show pages" className="flex flex-wrap items-center gap-1">
        {PAGE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={show === f.value}
            data-seo-pages-filter={f.value}
            onClick={() => setShow(f.value)}
            className={cn(
              'h-7 rounded-lg px-2.5 text-xs transition-colors',
              show === f.value ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 && loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 && error ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">Could not load the pages.</p>
          <button type="button" onClick={() => void load(0)} className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p data-seo-pages-empty="" className="py-10 text-center text-sm text-muted-foreground">
          {show === 'all' ? 'No pages checked yet.' : 'No pages match.'}
        </p>
      ) : (
        <div className="mt-3">
          <div aria-hidden className={cn(GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>Status</span>
            <span>Page</span>
            <span className="hidden text-right @lg:block">Words</span>
            <span className="hidden text-right @lg:block" title="Links to other pages on the site">
              Links
            </span>
            <span className="hidden text-right @lg:block" title="Clicks from the home page">
              Depth
            </span>
          </div>
          <ul>
            {rows.map((page) => (
              <PageRow key={page.id} page={page} />
            ))}
          </ul>
          {next !== null && (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                data-seo-pages-more=""
                disabled={loading}
                onClick={() => void load(next)}
                className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PageRow({ page }: { page: SiteAuditPageRow }) {
  const status = pageStatus(page)
  const path = pathOf(page.url)
  return (
    <li data-seo-page-row={page.id} className={cn(GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      <span
        data-seo-page-status={status.tone}
        className={cn('pt-px text-xs tabular-nums', PAGE_STATUS_TONE[status.tone])}
        title={page.redirect_url ? `Redirects to ${page.redirect_url}` : undefined}
      >
        {status.text}
      </span>
      <span className="min-w-0">
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer noopener"
          title={page.url}
          className="block truncate text-xs text-foreground underline-offset-2 hover:underline"
        >
          {path}
        </a>
        {page.title && (
          <span className="block truncate text-xs text-muted-foreground" title={page.title}>
            {page.title}
          </span>
        )}
      </span>
      <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{page.word_count.toLocaleString()}</span>
      <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{page.internal_link_count.toLocaleString()}</span>
      <span className="hidden pt-px text-right text-xs tabular-nums text-muted-foreground @lg:block">{page.crawl_depth ?? '—'}</span>
    </li>
  )
}
