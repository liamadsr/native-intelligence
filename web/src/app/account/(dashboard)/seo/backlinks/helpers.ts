/**
 * The Backlinks page's pure pieces, so the views and their tests read the
 * same strings and make the same requests: a typed site as a bare host, a
 * stored overview made whole again, the overview's tiles and trend, the
 * lists' sorts, and a linking URL split into its site and path.
 *
 * House style (../ui-helpers.ts): sentence case, plural-aware counts, a
 * clause whose number is zero dropped, ` · ` between clauses.
 */
import type { BacklinksOverview, BacklinksTab, BacklinksTrendPoint } from '@/lib/seo/backlinks/view'
import type { SeoLookupDetail } from '@/lib/seo/lookup-view'
import type { ResearchScope } from '@/lib/seo/shared/researchScope'
import type { StatTile } from '../shared/stat-tiles'
import { count } from '../ui-helpers'
import type { StoredOverview } from './api'

/** "https://www.Example.com/shop" → "example.com"; "" when nothing usable was typed. */
export function bareHost(input: string | null | undefined): string {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(withScheme).hostname.replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return raw.replace(/^www\./, '').replace(/[/?#].*$/, '')
  }
}

/** True when the two name the same site ("www." and scheme ignored). */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = bareHost(a)
  return !!x && x === bareHost(b)
}

/** The site or page a stored overview's label names ("example.com · backlinks overview" → "example.com"). */
export function siteOfLabel(label: string | null | undefined): string {
  return (label ?? '').split(' · ')[0]?.trim() ?? ''
}

/** A stored overview as the route would have answered it from storage. */
export function overviewFromLookup(detail: SeoLookupDetail<unknown, StoredOverview>): BacklinksOverview {
  const r = detail.result
  return {
    ...r,
    history: Array.isArray(r.history) ? r.history : [],
    scope_note: r.scope_note ?? null,
    lookup_id: detail.id,
    fetched_at: detail.fetched_at,
    from_cache: true,
  }
}

/** The own site's stored overview among the recent ones: a whole-site lookup of the same host. */
export function ownSiteLookup<T extends { label: string | null }>(lookups: readonly T[], ownHost: string | null): T | undefined {
  if (!ownHost) return undefined
  return lookups.find((l) => {
    const name = siteOfLabel(l.label)
    return !name.includes('/') && sameSite(name, ownHost)
  })
}

// ── The start control ────────────────────────────────────────────────────

/** How far a typed page address reaches, when it names a page. */
export const PAGE_SCOPES: ReadonlyArray<{ value: Extract<ResearchScope, 'exact_url' | 'subfolder'>; label: string }> = [
  { value: 'exact_url', label: 'This page only' },
  { value: 'subfolder', label: 'This page and the ones under it' },
]

/**
 * Whether a typed address names a page (it has a path), which is when the
 * scope choice shows. Whether the address can be used at all is the route's
 * to say (a free 400, in words for the person, shown beside the field).
 */
export function hasPagePath(input: string): boolean {
  const raw = input.trim()
  if (!raw) return false
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const path = new URL(withScheme).pathname.replace(/\/+$/, '')
    return path !== ''
  } catch {
    return false
  }
}

// ── The overview ─────────────────────────────────────────────────────────

/** 0.823 → "82%"; null stays null. */
export function percent(share: number | null): string | null {
  if (share === null || !Number.isFinite(share)) return null
  return `${Math.round(share * 100)}%`
}

/** The newest calendar month in the history, with its new and lost sites and links summed. */
export function monthNewLost(history: readonly BacklinksTrendPoint[]): {
  newSites: number | null
  lostSites: number | null
  newLinks: number | null
  lostLinks: number | null
} | null {
  if (history.length === 0) return null
  const month = history[history.length - 1].date.slice(0, 7)
  const points = history.filter((p) => p.date.slice(0, 7) === month)
  const sum = (key: 'new_referring_domains' | 'lost_referring_domains' | 'new_backlinks' | 'lost_backlinks') => {
    const values = points.map((p) => p[key]).filter((v): v is number => v !== null)
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  const out = { newSites: sum('new_referring_domains'), lostSites: sum('lost_referring_domains'), newLinks: sum('new_backlinks'), lostLinks: sum('lost_backlinks') }
  return out.newSites === null && out.lostSites === null ? null : out
}

/** How much a series moved across the history (newest known minus oldest known), or null. */
export function historyChange(history: readonly BacklinksTrendPoint[], key: 'referring_domains' | 'backlinks'): number | null {
  const known = history.map((p) => p[key]).filter((v): v is number => v !== null)
  if (known.length < 2) return null
  return known[known.length - 1] - known[0]
}

/** "up 120 in a year", "down 4 in a year", "no change in a year". */
export function changeNote(change: number | null, span: string): { note: string; tone: 'up' | 'down' | 'flat' } | null {
  if (change === null) return null
  if (change === 0) return { note: `no change ${span}`, tone: 'flat' }
  return change > 0 ? { note: `up ${change.toLocaleString()} ${span}`, tone: 'up' } : { note: `down ${Math.abs(change).toLocaleString()} ${span}`, tone: 'down' }
}

/** What the history spans, in words ("in a year", "since Mar 4"). */
export function historySpan(history: readonly BacklinksTrendPoint[], now: Date = new Date()): string {
  if (history.length === 0) return ''
  const first = new Date(`${history[0].date}T00:00:00Z`)
  const days = (now.getTime() - first.getTime()) / 86_400_000
  if (days >= 330) return 'in a year'
  return `since ${first.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}

/**
 * The overview's tiles, only those the view carries a number for: sites
 * linking, links, the followed share, this month's new and lost sites (from
 * the history, whose newest month is "this month"), and the provider's rank
 * and spam score. Plain words in the label, the SEO term in the title.
 */
export function overviewTiles(overview: BacklinksOverview, own: boolean, now: Date = new Date()): StatTile[] {
  const s = overview.summary
  const span = historySpan(overview.history, now)
  const sitesChange = changeNote(historyChange(overview.history, 'referring_domains'), span)
  const linksChange = changeNote(historyChange(overview.history, 'backlinks'), span)
  const month = monthNewLost(overview.history)
  const tiles: Array<StatTile | null> = [
    s.referring_domains !== null
      ? {
          key: 'sites',
          label: own ? 'Sites linking to you' : 'Sites linking to it',
          value: s.referring_domains,
          title: 'Referring domains: separate websites with at least one link here',
          ...(sitesChange ? { note: sitesChange.note, noteTone: sitesChange.tone } : {}),
        }
      : null,
    s.backlinks !== null
      ? {
          key: 'links',
          label: 'Links',
          value: s.backlinks,
          title: 'Backlinks: every link from a page on another site',
          ...(linksChange ? { note: linksChange.note, noteTone: linksChange.tone } : {}),
        }
      : null,
    s.dofollow_share !== null
      ? {
          key: 'followed',
          label: 'Followed links',
          value: percent(s.dofollow_share),
          title: 'Dofollow: the share of links that don’t ask search engines to ignore them',
        }
      : null,
    month && month.newSites !== null
      ? {
          key: 'new',
          label: 'New this month',
          value: month.newSites,
          title: 'Sites that started linking here this month (new referring domains)',
          ...(month.newLinks ? { note: `${count(month.newLinks, 'new link')}`, noteTone: 'up' as const } : {}),
        }
      : null,
    month && month.lostSites !== null
      ? {
          key: 'lost',
          label: 'Lost this month',
          value: month.lostSites,
          title: 'Sites that stopped linking here this month (lost referring domains)',
          ...(month.lostLinks ? { note: `${count(month.lostLinks, 'lost link')}`, noteTone: 'down' as const } : {}),
        }
      : null,
    s.rank !== null ? { key: 'rank', label: 'Link rank', value: s.rank, title: 'The search data provider’s own rank of this site, worked out from its links' } : null,
    s.target_spam_score !== null
      ? { key: 'spam', label: 'Spam score', value: s.target_spam_score, title: 'The search data provider’s own spam score for this site' }
      : null,
  ]
  return tiles.filter((t): t is StatTile => t !== null)
}

/** The trend's sentence for assistive tech: where each line started and ended. */
export function trendSummary(history: readonly BacklinksTrendPoint[], key: 'referring_domains' | 'backlinks', what: string): string {
  const known = history.filter((p) => p[key] !== null)
  if (known.length < 2) return `${what}: not enough history yet.`
  const first = known[0]
  const last = known[known.length - 1]
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return `${what}: ${first[key]!.toLocaleString()} on ${day(first.date)}, ${last[key]!.toLocaleString()} on ${day(last.date)}.`
}

// ── The lists ────────────────────────────────────────────────────────────

/** Each list's sorts, in plain words (the view's sort fields, highest or newest first). */
export const SORTS: Record<BacklinksTab, ReadonlyArray<{ value: string; label: string; title: string }>> = {
  backlinks: [
    { value: 'firstSeen', label: 'Newest', title: 'The links found most recently first' },
    { value: 'rank', label: 'Strongest link', title: 'By the search data provider’s rank of each link, highest first' },
    { value: 'domainRank', label: 'Strongest site', title: 'By the search data provider’s rank of the linking site, highest first' },
    { value: 'spamScore', label: 'Most spammy', title: 'By the search data provider’s spam score, highest first' },
  ],
  domains: [
    { value: 'backlinks', label: 'Most links', title: 'The sites sending the most links first' },
    { value: 'rank', label: 'Strongest', title: 'By the search data provider’s rank of each site, highest first' },
    { value: 'firstSeen', label: 'Newest', title: 'The sites that started linking most recently first' },
  ],
  pages: [
    { value: 'backlinks', label: 'Most links', title: 'The pages with the most links first' },
    { value: 'referringDomains', label: 'Most sites', title: 'The pages linked from the most sites first' },
  ],
}

/** What each list's empty and loading words call its rows. */
export const LIST_WORDS: Record<BacklinksTab, { one: string; noun: string; load: string; failed: string; empty: string }> = {
  backlinks: { one: 'link', noun: 'links', load: 'Load links', failed: 'Could not load the links.', empty: 'No links found for this site yet' },
  domains: { one: 'site', noun: 'sites', load: 'Load sites', failed: 'Could not load the linking sites.', empty: 'No sites found linking here yet' },
  pages: { one: 'page', noun: 'pages', load: 'Load pages', failed: 'Could not load the pages.', empty: 'No linked pages found for this site yet' },
}

/** A linking URL as its site and the rest: "https://www.oak.example/blog/x?y" → { site: "www.oak.example", path: "/blog/x?y" }. */
export function splitUrl(url: string | null | undefined): { site: string; path: string } {
  if (!url) return { site: '', path: '' }
  try {
    const u = new URL(url)
    const path = `${u.pathname}${u.search}`
    return { site: u.hostname, path: path === '/' ? '' : path }
  } catch {
    return { site: url, path: '' }
  }
}

/** A site's address to link out to, from its bare name. */
export function siteHref(domain: string): string {
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
}

/** A number as a row shows it: "—" when not known. */
export function num(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString()
}
