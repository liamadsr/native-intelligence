'use client'

/**
 * A tracker's Sources tab: the websites (or pages) the assistants cited in
 * the latest finished check, most cited first, from GET …/[id]/sources.
 * Each row links out, says whose it is (yours, a competitor's, someone
 * else's) and how many answers cited it; a site's row offers its pages (the
 * route's `domain` filter). "Show more" pages on `next_offset`.
 */
import * as React from 'react'
import { Loader2, X } from 'lucide-react'
import type { AiSourceRow, AiSourcesView } from '@/lib/seo/ai-visibility/view'
import { cn } from '@/lib/utils'
import { FilterChips } from '../shared/tab-pills'
import { count } from '../ui-helpers'
import { OWNERSHIP_CHIP, OWNERSHIP_LABEL, urlWords } from './ai-helpers'
import { fetchSources } from './api'

type GroupBy = 'domain' | 'page'
const GROUP_OPTIONS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: 'domain', label: 'Sites' },
  { value: 'page', label: 'Pages' },
]
const GRID = 'grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] items-center gap-2 @lg:grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_4.5rem]'

export function SourcesTab({ trackerId, runId, version }: { trackerId: string; runId: string | null; version: number }) {
  const [groupBy, setGroupBy] = React.useState<GroupBy>('domain')
  const [domain, setDomain] = React.useState<string | null>(null)
  const [view, setView] = React.useState<AiSourcesView | null>(null)
  const [rows, setRows] = React.useState<AiSourceRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const asked = React.useRef(0)

  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setLoading(true)
      setError(false)
      try {
        const next = await fetchSources(trackerId, { groupBy, domain: groupBy === 'page' ? domain : null, offset, runId })
        if (ask !== asked.current) return
        setView(next)
        setRows((r) => (offset ? [...r, ...next.rows] : next.rows))
      } catch {
        if (ask === asked.current) setError(true)
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [trackerId, groupBy, domain, runId],
  )

  React.useEffect(() => {
    if (!runId) return
    void load(0)
  }, [load, runId, version])

  if (!runId) return <Empty />

  const caption = (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      These are the pages the assistants leaned on. Being on them, or being one of them, is how you get named.
    </p>
  )

  return (
    <div data-seo-sources="" data-seo-group-by={groupBy} className="@container space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          label="Group by"
          options={GROUP_OPTIONS}
          value={groupBy}
          onChange={(v) => {
            setGroupBy(v)
            if (v === 'domain') setDomain(null)
          }}
        />
        {groupBy === 'page' && domain && (
          <span data-seo-domain-filter={domain} className="inline-flex h-7 items-center gap-1 rounded-lg bg-foreground/[0.08] pl-2.5 pr-1 text-xs text-foreground">
            Pages of {domain}
            <button
              type="button"
              aria-label="Show every page"
              title="Show every page"
              onClick={() => setDomain(null)}
              className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      {caption}

      {rows.length === 0 && loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading the sources" />
        </div>
      ) : rows.length === 0 && error ? (
        <p className="py-10 text-center text-xs text-muted-foreground">
          Could not load the sources.{' '}
          <button type="button" onClick={() => void load(0)} className="text-foreground underline-offset-2 hover:underline">
            Try again
          </button>
        </p>
      ) : rows.length === 0 ? (
        <Empty text={view && view.run_id ? 'The answers in the latest check cited no pages.' : undefined} />
      ) : (
        <div>
          <div aria-hidden className={cn(GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
            <span>{groupBy === 'page' ? 'Page' : 'Site'}</span>
            <span />
            <span className="text-right" title="How many answers cited it">
              Answers
            </span>
            <span className="hidden text-right @lg:block" title="How many of the questions got an answer citing it">
              Questions
            </span>
          </div>
          <ul>
            {rows.map((row) => (
              <SourceRow
                key={row.key}
                row={row}
                page={groupBy === 'page'}
                onPages={() => {
                  setDomain(row.domain)
                  setGroupBy('page')
                }}
              />
            ))}
          </ul>
          {view?.next_offset !== null && view?.next_offset !== undefined && (
            <div className="flex justify-center pt-3">
              <button
                type="button"
                data-seo-sources-more=""
                disabled={loading}
                onClick={() => void load(view.next_offset!)}
                className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Show more'}
              </button>
            </div>
          )}
          {error && rows.length > 0 && <p className="mt-1 text-center text-xs text-muted-foreground">Could not load more.</p>}
        </div>
      )}
    </div>
  )
}

function Empty({ text }: { text?: string }) {
  return (
    <div data-seo-sources-empty="" className="py-10 text-center">
      <p className="text-sm font-medium text-foreground">No sources yet</p>
      <p className="mt-1 text-xs text-muted-foreground">{text ?? 'They show after the first check.'}</p>
    </div>
  )
}

function SourceRow({ row, page, onPages }: { row: AiSourceRow; page: boolean; onPages: () => void }) {
  const href = page ? row.url : `https://${row.domain}`
  return (
    <li data-seo-source-row={row.key} className={cn(GRID, 'group rounded-md px-1 py-1 hover:bg-muted/40')}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              title={href}
              className="block min-w-0 truncate text-xs text-foreground underline-offset-2 hover:underline"
            >
              {page && row.url ? urlWords(row.url) : row.domain}
            </a>
          ) : (
            <span className="block truncate text-xs text-foreground">{row.domain}</span>
          )}
          {page && row.title && (
            <span className="block truncate text-[11px] text-muted-foreground" title={row.title}>
              {row.title}
            </span>
          )}
        </span>
        {!page && (
          <button
            type="button"
            data-seo-see-pages={row.domain}
            onClick={onPages}
            className="ml-auto shrink-0 rounded-lg px-2 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            See its pages
          </button>
        )}
      </span>
      <span className="flex justify-end">
        <span data-seo-ownership={row.ownership} className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap', OWNERSHIP_CHIP[row.ownership])}>
          {OWNERSHIP_LABEL[row.ownership]}
        </span>
      </span>
      <span className="text-right text-xs font-medium tabular-nums text-foreground" title={`Cited in ${count(row.answer_count, 'answer')}`}>
        {row.answer_count.toLocaleString()}
      </span>
      <span className="hidden text-right text-xs tabular-nums text-muted-foreground @lg:block" title={`Cited for ${count(row.prompt_count, 'question')}`}>
        {row.prompt_count.toLocaleString()}
      </span>
    </li>
  )
}
