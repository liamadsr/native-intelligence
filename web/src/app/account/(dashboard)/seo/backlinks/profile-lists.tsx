'use client'

/**
 * A looked-up site's three lists, one profile page at a time (./use-profile.ts):
 *
 *   Links   the links themselves, the strongest one per linking site (every
 *           link when narrowed to one site): the linking page, its link
 *           text (another site's words: plain text only), the page it points
 *           at, Followed or not, when it was first seen, and quiet Lost and
 *           Broken chips. Sorts, Hide lost, Hide spammy, and "address
 *           contains".
 *   Sites   one row per linking site: how many links it sends, the
 *           provider's rank, first seen; "See its links" opens Links
 *           narrowed to it.
 *   Pages   this site's most-linked pages: sites linking, links.
 *
 * Each list waits for its "Load …" button (a page spends unless stored), and
 * says when a stored copy answered, with Refresh. On a narrow card the least
 * important columns drop (a container query), never a sideways scroll.
 */
import * as React from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BacklinkRow, BacklinksTab, ReferringDomainRow, TopPageRow } from '@/lib/seo/backlinks/view'
import { cn } from '@/lib/utils'
import { FilterChips } from '../shared/tab-pills'
import { count, pathOf, relativeWhen } from '../ui-helpers'
import { LIST_WORDS, SORTS, num, siteHref, splitUrl } from './helpers'
import { PAGE_SIZE, type ProfileState } from './use-profile'

const CHIP = '-my-0.5 inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap'
const NEUTRAL_CHIP = cn(CHIP, 'border-border bg-muted/40 text-muted-foreground')
const QUIET_BUTTON = 'h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50'
const SPENDS = 'a small charge, unless asked in the last 12 hours'

// ── The frame every list shares ──────────────────────────────────────────

function ListFrame<T extends BacklinksTab>({
  state,
  blockedReason,
  controls,
  filtered,
  head,
  children,
}: {
  state: ProfileState<T>
  blockedReason: string | null
  /** The sort and filters, drawn once the list has started. */
  controls: React.ReactNode
  /** A filter is narrowing the list (the empty line says "match"). */
  filtered: boolean
  /** The column labels. */
  head: React.ReactNode
  children: React.ReactNode
}) {
  const words = LIST_WORDS[state.tab]
  const off = !!blockedReason
  if (!state.started) {
    return (
      <div data-seo-load-gate={state.tab} className="flex flex-col items-center gap-2 py-12 text-center">
        <Button size="sm" className="h-8" data-seo-load={state.tab} disabled={off} title={blockedReason ?? `Reads the first ${PAGE_SIZE}: ${SPENDS}`} onClick={state.start}>
          {words.load}
        </Button>
        <p className="text-[11px] text-muted-foreground">Reads up to {PAGE_SIZE} rows</p>
      </div>
    )
  }
  const { rows, loading, problem } = state
  const fieldError = problem?.kind === 'field' ? problem.message : null
  return (
    <div data-seo-list={state.tab} className="@container">
      <div className={cn(off && 'pointer-events-none opacity-50')} title={blockedReason ?? `Sorting or filtering reads the list again: ${SPENDS}`} aria-disabled={off || undefined}>
        {controls}
      </div>
      {fieldError && (
        <p data-seo-list-error="" className="mt-1 text-xs text-destructive">
          {fieldError}
        </p>
      )}
      {problem?.kind === 'limit' && (
        <p data-seo-limit="" className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {problem.message}
        </p>
      )}

      {rows.length === 0 && loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 && problem?.kind === 'failed' ? (
        <div data-seo-list-failed="" className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">{problem.message}</p>
          <button type="button" disabled={off} onClick={state.retry} className={QUIET_BUTTON}>
            Try again
          </button>
        </div>
      ) : rows.length === 0 && !problem ? (
        <p data-seo-list-empty="" className="py-10 text-center text-sm text-muted-foreground">
          {filtered ? `No ${words.noun} match.` : words.empty}
        </p>
      ) : rows.length > 0 ? (
        <div className="mt-3">
          <StoredLine state={state} blockedReason={blockedReason} />
          {head}
          <ul>{children}</ul>
          {state.hasMore && (
            <div className="flex flex-col items-center gap-1 pt-3">
              <button
                type="button"
                data-seo-more={state.tab}
                disabled={loading || off}
                title={blockedReason ?? `Reads the next ${PAGE_SIZE}: ${SPENDS}`}
                onClick={state.more}
                className={QUIET_BUTTON}
              >
                {loading ? 'Loading…' : 'Show more'}
              </button>
              {problem?.kind === 'failed' && <p className="text-xs text-muted-foreground">{words.failed}</p>}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** "50 of 1,204 · Looked up 3 hours ago [Refresh]": how much is shown, and a stored copy's age. */
function StoredLine<T extends BacklinksTab>({ state, blockedReason }: { state: ProfileState<T>; blockedReason: string | null }) {
  const words = LIST_WORDS[state.tab]
  // One link per site: the total counts the linking sites, not every link.
  const perSite = state.tab === 'backlinks' && !state.controls.domainFrom
  const shown =
    state.total !== null && state.total > state.rows.length
      ? `${state.rows.length.toLocaleString()} of ${perSite ? count(state.total, 'site') : count(state.total, words.one, words.noun)}`
      : null
  const when = state.stored?.from_cache ? relativeWhen(state.stored.fetched_at) : ''
  const line = [shown, when ? `Looked up ${when}` : null].filter(Boolean).join(' · ')
  if (!line) return null
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-2 px-1">
      <p data-seo-list-meta="" className="text-[11px] tabular-nums text-muted-foreground">
        {line}
      </p>
      {state.stored?.from_cache && (
        <Button
          variant="ghost"
          size="sm"
          data-seo-list-refresh={state.tab}
          className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          disabled={state.loading || !!blockedReason}
          title={blockedReason ?? 'Read the list again with fresh data: a small charge'}
          onClick={state.refresh}
        >
          Refresh
        </Button>
      )}
    </div>
  )
}

/** An on/off filter in the FilterChips look. */
function Toggle({ on, onChange, id, children, title }: { on: boolean; onChange: (next: boolean) => void; id: string; children: React.ReactNode; title: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-seo-toggle={id}
      title={title}
      onClick={() => onChange(!on)}
      className={cn('h-7 rounded-lg px-2.5 text-xs transition-colors', on ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
    >
      {children}
    </button>
  )
}

/** "Linking address contains…": applied on Enter, cleared with its ×. */
function ContainsField({ value, onApply, placeholder, label }: { value: string; onApply: (next: string) => void; placeholder: string; label: string }) {
  const [text, setText] = React.useState(value)
  React.useEffect(() => setText(value), [value])
  return (
    <span className="relative inline-flex items-center">
      <Input
        data-seo-contains=""
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (text.trim() !== value) onApply(text.trim())
          }
        }}
        className="h-7 w-52 pr-7 text-xs"
      />
      {value && (
        <button
          type="button"
          data-seo-contains-clear=""
          aria-label="Clear"
          title="Show every address again"
          onClick={() => onApply('')}
          className="absolute right-1.5 rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

// ── Links ────────────────────────────────────────────────────────────────

const LINK_GRID =
  'grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] items-start gap-2 @3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_5.5rem_4.5rem]'

export function LinksList({ state, blockedReason }: { state: ProfileState<'backlinks'>; blockedReason: string | null }) {
  const { controls, change } = state
  return (
    <ListFrame
      state={state}
      blockedReason={blockedReason}
      filtered={!!controls.include || controls.hideLost || !!controls.domainFrom}
      controls={
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <FilterChips label="Sort links" options={SORTS.backlinks} value={controls.sort} onChange={(sort) => change({ sort })} />
            <span aria-hidden className="h-4 w-px bg-border" />
            <span className="flex items-center gap-1">
              <Toggle id="hide-lost" on={controls.hideLost} onChange={(hideLost) => change({ hideLost })} title="Leave out links that are no longer on the linking page">
                Hide lost
              </Toggle>
              <Toggle id="hide-spam" on={controls.hideSpam} onChange={(hideSpam) => change({ hideSpam })} title="Leave out links the search data provider scores as likely spam">
                Hide spammy
              </Toggle>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ContainsField value={controls.include} onApply={(include) => change({ include })} placeholder="Linking address contains…" label="Linking address contains" />
            {controls.domainFrom && (
              <span data-seo-domain-filter={controls.domainFrom} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                Every link from {controls.domainFrom}
                <button
                  type="button"
                  aria-label={`Show links from every site again`}
                  title="Show links from every site again"
                  onClick={() => change({ domainFrom: null })}
                  className="-mr-0.5 rounded-full hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {!controls.domainFrom && <span className="text-[11px] text-muted-foreground">The strongest link from each site</span>}
          </div>
        </div>
      }
      head={
        <div aria-hidden className={cn(LINK_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
          <span>Linking page</span>
          <span className="hidden @3xl:block">Link text</span>
          <span className="hidden @3xl:block">Points to</span>
          <span title="Whether the link asks search engines to ignore it (nofollow)">Followed</span>
          <span className="text-right">First seen</span>
        </div>
      }
    >
      {state.rows.map((row, i) => (
        <LinkRow key={`${row.url_from ?? ''}|${row.url_to ?? ''}|${i}`} row={row} />
      ))}
    </ListFrame>
  )
}

/** Another site's link text, as plain text; a link with none says so. */
function AnchorText({ anchor, className }: { anchor: string | null; className?: string }) {
  const text = anchor?.trim()
  if (!text) {
    return (
      <span className={cn(className, 'text-muted-foreground')} title="This link has no text">
        No link text
      </span>
    )
  }
  return (
    <span className={className} title={text}>
      {text}
    </span>
  )
}

function LinkRow({ row }: { row: BacklinkRow }) {
  const from = splitUrl(row.url_from)
  const site = from.site || row.domain_from || ''
  const to = pathOf(row.url_to) || '/'
  const rel = row.rel_attributes.length ? row.rel_attributes.join(', ') : null
  return (
    <li data-seo-link-row={row.url_from ?? ''} className={cn(LINK_GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          {row.url_from ? (
            <a href={row.url_from} target="_blank" rel="noreferrer noopener" title={row.url_from} className="min-w-0 truncate text-xs underline-offset-2 hover:underline">
              <span className="font-medium text-foreground">{site}</span>
              <span className="text-muted-foreground">{from.path}</span>
            </a>
          ) : (
            <span className="truncate text-xs font-medium text-foreground">{site || '—'}</span>
          )}
          {row.is_lost && (
            <span data-seo-lost="" className={NEUTRAL_CHIP} title={row.last_seen ? `No longer on the linking page since ${row.last_seen}` : 'No longer on the linking page'}>
              Lost
            </span>
          )}
          {row.is_broken && (
            <span data-seo-broken="" className={cn(CHIP, 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400')} title="It points at a page that doesn’t load">
              Broken
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground @3xl:hidden">
          <AnchorText anchor={row.anchor} className="min-w-0 truncate" />
          <span aria-hidden className="shrink-0">
            →
          </span>
          <span className="min-w-0 max-w-[55%] shrink-0 truncate" title={row.url_to ?? undefined}>
            {to}
          </span>
        </span>
      </span>
      <AnchorText anchor={row.anchor} className="hidden min-w-0 truncate text-xs text-foreground @3xl:block" />
      <span className="hidden min-w-0 @3xl:block">
        {row.url_to ? (
          <a href={row.url_to} target="_blank" rel="noreferrer noopener" title={row.url_to} className="block truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {to}
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </span>
      <span className="flex min-w-0">
        {row.dofollow === null ? (
          <span className="text-xs text-muted-foreground" title="Not known">
            —
          </span>
        ) : row.dofollow ? (
          <span data-seo-follow="followed" className={NEUTRAL_CHIP} title="Search engines may count this link (dofollow)">
            Followed
          </span>
        ) : (
          <span data-seo-follow="not-followed" className={NEUTRAL_CHIP} title={`The link asks search engines to ignore it${rel ? ` (${rel})` : ' (nofollow)'}`}>
            Not followed
          </span>
        )}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground" title={row.first_seen ?? 'Not known'}>
        {relativeWhen(row.first_seen) || '—'}
      </span>
    </li>
  )
}

// ── Sites ────────────────────────────────────────────────────────────────

const SITE_GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem] items-start gap-2 @lg:grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem]'

export function SitesList({
  state,
  blockedReason,
  folder,
  onSeeLinks,
}: {
  state: ProfileState<'domains'>
  blockedReason: string | null
  /** A folder's linking sites can't be listed (the route refuses): say so instead of a button. */
  folder: boolean
  onSeeLinks: (domain: string) => void
}) {
  if (folder) {
    return (
      <p data-seo-sites-folder="" className="py-10 text-center text-sm text-muted-foreground">
        Linking sites can’t be listed for part of a site. Look up the whole site to see them.
      </p>
    )
  }
  return (
    <ListFrame
      state={state}
      blockedReason={blockedReason}
      filtered={false}
      controls={<FilterChips label="Sort sites" options={SORTS.domains} value={state.controls.sort} onChange={(sort) => state.change({ sort })} />}
      head={
        <div aria-hidden className={cn(SITE_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
          <span>Linking site</span>
          <span className="text-right" title="Links from this site (backlinks)">
            Links
          </span>
          <span className="hidden text-right @lg:block" title="The search data provider’s own rank of the site">
            Rank
          </span>
          <span className="hidden text-right @lg:block">First seen</span>
        </div>
      }
    >
      {state.rows.map((row, i) => (
        <SiteRow key={`${row.domain ?? ''}|${i}`} row={row} blockedReason={blockedReason} onSeeLinks={onSeeLinks} />
      ))}
    </ListFrame>
  )
}

function SiteRow({ row, blockedReason, onSeeLinks }: { row: ReferringDomainRow; blockedReason: string | null; onSeeLinks: (domain: string) => void }) {
  const domain = row.domain ?? ''
  return (
    <li data-seo-site-row={domain} className={cn(SITE_GRID, 'group rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      <span className="flex min-w-0 items-center gap-2">
        {domain ? (
          <a href={siteHref(domain)} target="_blank" rel="noreferrer noopener" title={domain} className="min-w-0 truncate text-xs font-medium text-foreground underline-offset-2 hover:underline">
            {domain}
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        {domain && (
          <span className="-my-0.5 ml-auto hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
            <button
              type="button"
              data-seo-see-links={domain}
              disabled={!!blockedReason}
              title={blockedReason ?? `Every link from ${domain}: ${SPENDS}`}
              onClick={() => onSeeLinks(domain)}
              className="h-5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              See its links
            </button>
          </span>
        )}
      </span>
      <span className="text-right text-xs tabular-nums text-foreground">{num(row.backlinks)}</span>
      <span className="hidden text-right text-xs tabular-nums text-muted-foreground @lg:block">{num(row.rank)}</span>
      <span className="hidden text-right text-xs tabular-nums text-muted-foreground @lg:block" title={row.first_seen ?? 'Not known'}>
        {relativeWhen(row.first_seen) || '—'}
      </span>
    </li>
  )
}

// ── Pages ────────────────────────────────────────────────────────────────

const PAGE_GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-start gap-2'

export function PagesList({ state, blockedReason }: { state: ProfileState<'pages'>; blockedReason: string | null }) {
  return (
    <ListFrame
      state={state}
      blockedReason={blockedReason}
      filtered={false}
      controls={<FilterChips label="Sort pages" options={SORTS.pages} value={state.controls.sort} onChange={(sort) => state.change({ sort })} />}
      head={
        <div aria-hidden className={cn(PAGE_GRID, 'px-1 pb-1 text-[11px] text-muted-foreground')}>
          <span>Page</span>
          <span className="text-right" title="Separate sites linking to this page (referring domains)">
            Sites
          </span>
          <span className="text-right" title="Links to this page from other sites (backlinks)">
            Links
          </span>
        </div>
      }
    >
      {state.rows.map((row, i) => (
        <PageRow key={`${row.page ?? ''}|${i}`} row={row} />
      ))}
    </ListFrame>
  )
}

function PageRow({ row }: { row: TopPageRow }) {
  const path = pathOf(row.page) || '/'
  return (
    <li data-seo-page-row={row.page ?? ''} className={cn(PAGE_GRID, 'rounded-md px-1 py-1 transition-colors hover:bg-muted/40')}>
      {row.page ? (
        <a href={row.page} target="_blank" rel="noreferrer noopener" title={row.page} className="block min-w-0 truncate text-xs text-foreground underline-offset-2 hover:underline">
          {path}
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
      <span className="text-right text-xs tabular-nums text-foreground">{num(row.referring_domains)}</span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">{num(row.backlinks)}</span>
    </li>
  )
}
