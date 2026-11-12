/**
 * Backlinks: who links to a domain or a page. Two paid lookups, both stored
 * as snapshots (../lookup-cache.ts) and answered from the snapshot for
 * BACKLINKS_MAX_AGE_MS; `refresh: true` buys again.
 *
 *   overview   the totals (backlinks, referring domains and pages, rank,
 *              broken links, spam scores, the share of dofollow links, new
 *              and lost) and a year of daily history. A page has no history
 *              (the provider keeps it per host); a subfolder has only its
 *              two totals, counted from filtered backlink lists.
 *   profile    one page of one list: the backlinks themselves (one per
 *              linking domain, or every link), the referring domains, or the
 *              target's pages that collect the most links; filtered and
 *              sorted.
 *
 * No target means the workspace's own site (../site.ts). Every buy goes
 * through paidSeoClient (../paid.ts): the access check, then the
 * workspace's metered client.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import {
  normalizeBacklinksTarget,
  type BacklinksHistoryItem,
  type BacklinksSummaryItem,
  type DataforseoClient,
} from '@/lib/seo/dataforseo'
import { assertFilterConditionBudget } from '@/lib/seo/dataforseo/filters'
import {
  buildBacklinksScopeFilter,
  countExpressionConditions,
  prependScopeClauses,
} from '@/lib/seo/dataforseo/researchScopeFilters'
import { isSeoError } from '@/lib/seo/errors'
import { SeoInputError } from '@/lib/seo/input-error'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import { normalizeDomain } from '@/lib/seo/shared/domain'
import { workspaceSiteUrl } from '@/lib/seo/site'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { getDomain } from 'tldts'
import {
  buildBacklinksRowsApiFilters,
  buildBacklinksRowsOrderBy,
  buildReferringDomainsApiFilters,
  buildReferringDomainsOrderBy,
  buildTopPagesApiFilters,
  buildTopPagesOrderBy,
} from './filters'
import {
  dayOf,
  type BacklinkRow,
  type BacklinksOverview,
  type BacklinksOverviewRequest,
  type BacklinksProfilePage,
  type BacklinksProfileRequest,
  type BacklinksSummary,
  type BacklinksTrendPoint,
  type ReferringDomainRow,
  type TopPageRow,
} from './view'

export const BACKLINKS_OVERVIEW_KIND = 'backlinks_overview'
export const BACKLINKS_PROFILE_KIND = 'backlinks_profile'
/** How long a stored backlinks lookup answers the same question. The provider's index moves daily. */
export const BACKLINKS_MAX_AGE_MS = 12 * HOUR_MS
/** Bump when a stored result's shape changes. */
const OVERVIEW_VERSION = 1
const PROFILE_VERSION = 1

export type NoSiteRefusal = { ok: false; code: 'NO_SITE'; message: string }
const NO_SITE: NoSiteRefusal = {
  ok: false,
  code: 'NO_SITE',
  message:
    'Which website? Give a domain or a page address (for example example.com).',
}

type BacklinksClient = Pick<DataforseoClient, 'backlinks'>
type Target = ReturnType<typeof normalizeBacklinksTarget>

async function resolveTarget(
  svc: SupabaseClient,
  workspaceId: string,
  input: { target?: string; scope?: BacklinksOverviewRequest['scope'] },
): Promise<Target | null> {
  const typed = input.target?.trim()
  if (typed)
    return ownWords(() =>
      normalizeBacklinksTarget(typed, { scope: input.scope }),
    )
  const site = await workspaceSiteUrl(svc, workspaceId)
  if (!site) return null
  // The workspace's own site is a domain, whatever path its address carries.
  return ownWords(() =>
    normalizeBacklinksTarget(normalizeDomain(site), { scope: input.scope }),
  )
}

/** Our own refusals of a target or a filter are written for the person: keep their words (SeoInputError). */
function ownWords<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (isSeoError(err) && err.code === 'VALIDATION_ERROR')
      throw new SeoInputError(err.message)
    throw err
  }
}

function targetKey(target: Target) {
  return {
    target: target.apiTarget,
    scope: target.scope,
    path: target.path,
    include_subdomains: target.includeSubdomains,
  }
}

function scopeNote(target: Target): string | null {
  if (target.scope === 'domain')
    return 'The totals leave subdomains out; the history includes them (the provider keeps history per host).'
  if (target.scope === 'subfolder')
    return 'For a subfolder only the backlink and referring-domain totals can be counted; rank, history and the referring-domains list are not available.'
  if (target.scope === 'exact_url')
    return 'History is kept per host, so a single page has none.'
  return null
}

/** The year of history the overview reads: yesterday and the 365 days before (UTC). */
export function backlinksHistoryRange(now: Date): {
  dateFrom: string
  dateTo: string
} {
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  )
  const from = new Date(to)
  from.setUTCFullYear(from.getUTCFullYear() - 1)
  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Dofollow share from the summary's link attributes (nofollow count over all backlinks), when the provider gave both. */
export function dofollowShare(summary: BacklinksSummaryItem): number | null {
  const total = num(summary.backlinks)
  const attrs = (summary as Record<string, unknown>).referring_links_attributes
  const nofollow =
    attrs && typeof attrs === 'object'
      ? num((attrs as Record<string, unknown>).nofollow)
      : null
  if (total === null || total <= 0 || nofollow === null) return null
  return (
    Math.round(Math.min(1, Math.max(0, (total - nofollow) / total)) * 1000) /
    1000
  )
}

export function shapeSummary(summary: BacklinksSummaryItem): BacklinksSummary {
  return {
    rank: num(summary.rank),
    backlinks: num(summary.backlinks),
    referring_pages: num(summary.referring_pages),
    referring_domains: num(summary.referring_domains),
    broken_backlinks: num(summary.broken_backlinks),
    broken_pages: num(summary.broken_pages),
    dofollow_share: dofollowShare(summary),
    backlinks_spam_score: num(summary.backlinks_spam_score),
    target_spam_score: num(summary.info?.target_spam_score),
    new_backlinks: num(summary.new_backlinks),
    lost_backlinks: num(summary.lost_backlinks),
    new_referring_domains: num(
      summary.new_referring_domains ?? summary.new_reffering_domains,
    ),
    lost_referring_domains: num(
      summary.lost_referring_domains ?? summary.lost_reffering_domains,
    ),
  }
}

export function shapeHistory(
  items: BacklinksHistoryItem[],
): BacklinksTrendPoint[] {
  return items
    .map((item) => ({
      date: dayOf(item.date),
      backlinks: num(item.backlinks),
      referring_domains: num(item.referring_domains),
      rank: num(item.rank),
      new_backlinks: num(item.new_backlinks),
      lost_backlinks: num(item.lost_backlinks),
      new_referring_domains: num(
        item.new_referring_domains ?? item.new_reffering_domains,
      ),
      lost_referring_domains: num(
        item.lost_referring_domains ?? item.lost_reffering_domains,
      ),
    }))
    .filter((point): point is BacklinksTrendPoint => point.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function emptySummary(): BacklinksSummary {
  return {
    rank: null,
    backlinks: null,
    referring_pages: null,
    referring_domains: null,
    broken_backlinks: null,
    broken_pages: null,
    dofollow_share: null,
    backlinks_spam_score: null,
    target_spam_score: null,
    new_backlinks: null,
    lost_backlinks: null,
    new_referring_domains: null,
    lost_referring_domains: null,
  }
}

type StoredOverview = Omit<
  BacklinksOverview,
  'lookup_id' | 'fetched_at' | 'from_cache'
>

/** Buys an overview. Exposed for tests; callers use getBacklinksOverview. */
export async function fetchBacklinksOverview(
  client: BacklinksClient,
  target: Target,
  now: Date,
): Promise<StoredOverview> {
  const base = {
    target: target.apiTarget,
    display_target: target.displayTarget,
    scope: target.scope,
    scope_note: scopeNote(target),
  }
  if (target.scope === 'subfolder') {
    // The summary only takes a whole host: count the subfolder's links from
    // two filtered lists, every link and one per linking domain. One after
    // the other, so each is metered against what is left.
    const filters = buildBacklinksScopeFilter('url_to', target).clauses
    const common = {
      target: target.apiTarget,
      includeSubdomains: target.includeSubdomains,
      limit: 1,
      hideSpam: false,
      filters,
    }
    const allLinks = await client.backlinks.rows({ ...common, mode: 'as_is' })
    const perDomain = await client.backlinks.rows({
      ...common,
      mode: 'one_per_domain',
    })
    return {
      ...base,
      summary: {
        ...emptySummary(),
        backlinks: allLinks.totalCount,
        referring_domains: perDomain.totalCount,
      },
      history: [],
    }
  }
  const summary = await client.backlinks.summary({
    target: target.apiTarget,
    includeSubdomains: target.includeSubdomains,
  })
  let history: BacklinksHistoryItem[] = []
  if (target.scope !== 'exact_url') {
    try {
      history = await client.backlinks.history({
        target: target.apiTarget,
        ...backlinksHistoryRange(now),
      })
    } catch (err) {
      // History fails for some subdomains whose summary loads fine: show the
      // summary without it. For a registrable domain it is a real failure.
      if (getDomain(target.apiTarget) === target.apiTarget) throw err
      console.warn('[seo-backlinks] history unavailable', {
        target: target.apiTarget,
      })
    }
  }
  return {
    ...base,
    summary: shapeSummary(summary),
    history: shapeHistory(history),
  }
}

/**
 * The overview of a domain or page (default: the workspace's own site). A
 * fresh stored overview answers for free; otherwise the access check runs and
 * it is bought and stored. Answers the refusal when search data may not be
 * bought now; provider failures throw a SeoError.
 */
export async function getBacklinksOverview(
  svc: SupabaseClient,
  who: SeoWho,
  input: BacklinksOverviewRequest,
  deps: SeoPaidDeps = {},
): Promise<
  { ok: true; overview: BacklinksOverview } | SeoDataRefusal | NoSiteRefusal
> {
  const target = await resolveTarget(svc, who.workspaceId, input)
  if (!target) return NO_SITE
  const now = deps.now?.() ?? new Date()
  const request = { v: OVERVIEW_VERSION, ...targetKey(target) }
  if (!input.refresh) {
    const hit = await readLookup<StoredOverview>(
      svc,
      who.workspaceId,
      BACKLINKS_OVERVIEW_KIND,
      request,
      { maxAgeMs: BACKLINKS_MAX_AGE_MS, now },
    )
    if (hit && hit.result?.summary)
      return {
        ok: true,
        overview: {
          ...hit.result,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        },
      }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const body = await fetchBacklinksOverview(opened.client, target, now)
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: BACKLINKS_OVERVIEW_KIND,
      request,
      result: body,
      label: `${target.displayTarget} · backlinks overview`,
    },
    { now },
  )
  return {
    ok: true,
    overview: {
      ...body,
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    },
  }
}

function mapBacklinkRows(
  items: Awaited<ReturnType<DataforseoClient['backlinks']['rows']>>['items'],
): BacklinkRow[] {
  return items.map((item) => ({
    domain_from: item.domain_from ?? null,
    url_from: item.url_from ?? null,
    url_to: item.url_to ?? null,
    anchor: item.anchor ?? null,
    item_type: item.item_type ?? null,
    dofollow: item.dofollow ?? null,
    rel_attributes: item.rel_attributes ?? item.attributes ?? [],
    rank: num(item.rank),
    domain_from_rank: num(item.domain_from_rank),
    page_from_rank: num(item.page_from_rank),
    spam_score: num(item.backlink_spam_score ?? item.backlinks_spam_score),
    first_seen: dayOf(item.first_seen),
    last_seen: dayOf(item.lost_date ?? item.last_seen ?? item.last_visited),
    is_lost: item.is_lost ?? Boolean(item.lost_date),
    is_broken: item.is_broken ?? false,
    links_count: num(item.links_count),
  }))
}

function mapReferringDomains(
  items: Awaited<
    ReturnType<DataforseoClient['backlinks']['referringDomains']>
  >['items'],
): ReferringDomainRow[] {
  return items.map((item) => ({
    domain: item.domain ?? null,
    backlinks: num(item.backlinks),
    referring_pages: num(item.referring_pages),
    rank: num(item.rank),
    spam_score: num(item.backlinks_spam_score),
    first_seen: dayOf(item.first_seen),
    broken_backlinks: num(item.broken_backlinks),
    broken_pages: num(item.broken_pages),
  }))
}

function mapTopPages(
  items: Awaited<
    ReturnType<DataforseoClient['backlinks']['domainPages']>
  >['items'],
): TopPageRow[] {
  return items.map((item) => ({
    page: item.page ?? item.url ?? null,
    backlinks: num(item.backlinks),
    referring_domains: num(item.referring_domains),
    rank: num(item.rank),
    broken_backlinks: num(item.broken_backlinks),
  }))
}

type StoredProfile = Omit<
  BacklinksProfilePage,
  'lookup_id' | 'fetched_at' | 'from_cache'
>

function pageResult(
  input: { page: number; page_size: number },
  offset: number,
  count: number,
  totalCount: number | null,
) {
  return {
    page: input.page,
    page_size: input.page_size,
    total_count: totalCount,
    has_more:
      totalCount != null
        ? offset + count < totalCount
        : count === input.page_size,
  }
}

/** Buys one page of a profile. Exposed for tests; callers use getBacklinksProfile. */
export async function fetchBacklinksProfile(
  client: BacklinksClient,
  target: Target,
  input: BacklinksProfileRequest,
): Promise<StoredProfile> {
  const offset = (input.page - 1) * input.page_size
  const base = {
    target: target.apiTarget,
    display_target: target.displayTarget,
    scope: target.scope,
  }
  if (input.tab === 'backlinks') {
    const scope = buildBacklinksScopeFilter('url_to', target)
    const userFilters = ownWords(() =>
      buildBacklinksRowsApiFilters(input.filters),
    )
    // The scope group and the spam condition share the provider's budget with the filters.
    ownWords(() =>
      assertFilterConditionBudget(
        scope.conditionCount +
          countExpressionConditions(userFilters) +
          (input.hide_spam ? 2 : 0),
      ),
    )
    const filters = prependScopeClauses(scope, userFilters)
    const response = await client.backlinks.rows({
      target: target.apiTarget,
      includeSubdomains: target.includeSubdomains,
      limit: input.page_size,
      offset,
      orderBy: buildBacklinksRowsOrderBy(input.sort_field, input.sort_order),
      filters: filters.length ? filters : undefined,
      mode: input.mode,
      hideSpam: input.hide_spam,
    })
    const rows = mapBacklinkRows(response.items)
    return {
      ...base,
      tab: 'backlinks',
      rows,
      ...pageResult(input, offset, rows.length, response.totalCount ?? null),
    }
  }
  if (input.tab === 'domains') {
    if (target.scope === 'subfolder') {
      throw new SeoInputError(
        'Referring domains can’t be listed for a subfolder. Use the backlinks list, or look at the whole domain.',
      )
    }
    const filters = ownWords(() =>
      buildReferringDomainsApiFilters(input.filters),
    )
    const response = await client.backlinks.referringDomains({
      target: target.apiTarget,
      includeSubdomains: target.includeSubdomains,
      limit: input.page_size,
      offset,
      orderBy: buildReferringDomainsOrderBy(input.sort_field, input.sort_order),
      filters: filters.length ? filters : undefined,
      hideSpam: input.hide_spam,
    })
    const rows = mapReferringDomains(response.items)
    return {
      ...base,
      tab: 'domains',
      rows,
      ...pageResult(input, offset, rows.length, response.totalCount ?? null),
    }
  }
  const scope = buildBacklinksScopeFilter('url', target)
  const userFilters = ownWords(() => buildTopPagesApiFilters(input.filters))
  ownWords(() =>
    assertFilterConditionBudget(
      scope.conditionCount + countExpressionConditions(userFilters),
    ),
  )
  const filters = prependScopeClauses(scope, userFilters)
  const response = await client.backlinks.domainPages({
    target: target.apiTarget,
    includeSubdomains: target.includeSubdomains,
    limit: input.page_size,
    offset,
    orderBy: buildTopPagesOrderBy(input.sort_field, input.sort_order),
    filters: filters.length ? filters : undefined,
  })
  const rows = mapTopPages(response.items)
  return {
    ...base,
    tab: 'pages',
    rows,
    ...pageResult(input, offset, rows.length, response.totalCount ?? null),
  }
}

/** The stored-lookup key of a profile page: exactly what changes the answer. */
export function profileRequestKey(
  target: Target,
  input: BacklinksProfileRequest,
) {
  return {
    v: PROFILE_VERSION,
    ...targetKey(target),
    tab: input.tab,
    page: input.page,
    page_size: input.page_size,
    sort_field: input.sort_field,
    sort_order: input.sort_order,
    filters: input.filters,
    mode: input.tab === 'backlinks' ? input.mode : null,
    hide_spam: input.tab === 'pages' ? null : input.hide_spam,
  }
}

/** One page of a profile (default target: the workspace's own site), stored like the overview. */
export async function getBacklinksProfile(
  svc: SupabaseClient,
  who: SeoWho,
  input: BacklinksProfileRequest,
  deps: SeoPaidDeps = {},
): Promise<
  { ok: true; profile: BacklinksProfilePage } | SeoDataRefusal | NoSiteRefusal
> {
  const target = await resolveTarget(svc, who.workspaceId, input)
  if (!target) return NO_SITE
  const now = deps.now?.() ?? new Date()
  const request = profileRequestKey(target, input)
  if (!input.refresh) {
    const hit = await readLookup<StoredProfile>(
      svc,
      who.workspaceId,
      BACKLINKS_PROFILE_KIND,
      request,
      { maxAgeMs: BACKLINKS_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.rows)) {
      return {
        ok: true,
        profile: {
          ...hit.result,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        } as BacklinksProfilePage,
      }
    }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const body = await fetchBacklinksProfile(opened.client, target, input)
  const tabLabel =
    input.tab === 'backlinks'
      ? 'backlinks'
      : input.tab === 'domains'
        ? 'referring domains'
        : 'top pages'
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: BACKLINKS_PROFILE_KIND,
      request,
      result: body,
      label: `${target.displayTarget} · ${tabLabel} · page ${input.page}`,
    },
    { now },
  )
  return {
    ok: true,
    profile: {
      ...body,
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    } as BacklinksProfilePage,
  }
}
