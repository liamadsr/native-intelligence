/**
 * Choosing what the SEO area reads: the Search Console site and the Google
 * Analytics property, one each per workspace (./store.ts), and the status the
 * "Connect Google" card shows.
 *
 *   - Listing reads the CALLER's own connections: what they could choose.
 *   - Choosing needs the caller's own connection to read the site or
 *     property (checked against a fresh listing from Google; an unverified
 *     Search Console site is refused). The choice then names that connection,
 *     and every member's reads go through it (./token.ts).
 *   - Clearing a choice needs no connection: any member may.
 *   - When the workspace's own website (src/lib/seo/site.ts) matches exactly
 *     one Search Console property the caller can choose, it is suggested.
 *
 * Writes return `{ ok: true, … } | { ok: false, code, message }` with
 * sentences a person can read. Free: Google charges nothing.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { missingScopes } from '@/lib/oauth/scope-diff'
import { isFullMemberRole, memberRole } from '@/lib/seo/membership'
import { workspaceSiteUrl } from '@/lib/seo/site'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { canonicalPropertyId, createAnalyticsClient } from './analytics-client'
import {
  GoogleSeoError,
  isGoogleSeoError,
  notConnected,
  reconnectNeeded,
} from './errors'
import type { GoogleSeoDeps } from './search-console'
import { createSearchConsoleClient } from './search-console-client'
import {
  CLEAR_ANALYTICS,
  CLEAR_SEARCH_CONSOLE,
  readSource,
  writeSource,
  type SourceRow,
} from './store'
import { callerAccounts, memberName, type CallerAccount } from './token'
import {
  googleProductState,
  type AnalyticsPropertyOption,
  type AnalyticsSourceView,
  type GoogleAccountOption,
  type GoogleProduct,
  type GoogleProductStatus,
  type GoogleSeoErrorCode,
  type GoogleSeoStatus,
  type SearchConsoleSiteOption,
  type SearchConsoleSourceView,
} from './view'

type Who = { workspaceId: string; userId: string }

export type SourceWriteResult<T> =
  | { ok: true; source: T | null }
  | { ok: false; code: GoogleSeoErrorCode; message: string }

const UNVERIFIED = 'siteUnverifiedUser'

// ---------------------------------------------------------------------------
// What the caller could choose
// ---------------------------------------------------------------------------

interface Listed<T> {
  accounts: GoogleAccountOption[]
  options: T[]
}

function accountOption(
  a: CallerAccount,
  status?: GoogleAccountOption['status'],
): GoogleAccountOption {
  return { account_id: a.accountId, email: a.email, status: status ?? a.status }
}

/** The Search Console properties each of the caller's connections can see. Never throws for one account's failure. */
export async function listSearchConsoleSites(
  svc: SupabaseClient,
  who: { userId: string },
  deps: GoogleSeoDeps = {},
): Promise<Listed<SearchConsoleSiteOption>> {
  const accounts = await callerAccounts(svc, who, 'search_console', deps)
  const listed = await Promise.all(
    accounts.map(async (a) => {
      if (a.status !== 'ok' || !a.token)
        return {
          account: accountOption(a),
          sites: [] as SearchConsoleSiteOption[],
        }
      try {
        const sites = await createSearchConsoleClient(a.token, {
          fetchImpl: deps.fetchImpl,
        }).listSites()
        return {
          account: accountOption(a),
          sites: sites.map((s) => ({
            site_url: s.siteUrl,
            permission_level: s.permissionLevel,
            verified: s.permissionLevel !== UNVERIFIED,
            account_id: a.accountId,
            account_email: a.email,
          })),
        }
      } catch (err) {
        const reconnect =
          isGoogleSeoError(err) && err.code === 'RECONNECT_NEEDED'
        if (!reconnect)
          console.warn(
            '[seo-google] listing Search Console sites failed',
            isGoogleSeoError(err) ? (err.extra.detail ?? err.code) : err,
          )
        return {
          account: accountOption(
            a,
            reconnect ? 'needs_reconnect' : 'unavailable',
          ),
          sites: [],
        }
      }
    }),
  )
  return {
    accounts: listed.map((l) => l.account),
    options: listed.flatMap((l) => l.sites),
  }
}

/** The Google Analytics properties each of the caller's connections can see. Never throws for one account's failure. */
export async function listAnalyticsProperties(
  svc: SupabaseClient,
  who: { userId: string },
  deps: GoogleSeoDeps = {},
): Promise<Listed<AnalyticsPropertyOption>> {
  const accounts = await callerAccounts(svc, who, 'analytics', deps)
  const listed = await Promise.all(
    accounts.map(async (a) => {
      if (a.status !== 'ok' || !a.token)
        return {
          account: accountOption(a),
          properties: [] as AnalyticsPropertyOption[],
        }
      try {
        const properties = await createAnalyticsClient(a.token, {
          fetchImpl: deps.fetchImpl,
        }).listProperties()
        return {
          account: accountOption(a),
          properties: properties.map((p) => ({
            property_id: p.propertyId,
            display_name: p.displayName,
            account_display_name: p.accountDisplayName,
            account_id: a.accountId,
            account_email: a.email,
          })),
        }
      } catch (err) {
        const reconnect =
          isGoogleSeoError(err) && err.code === 'RECONNECT_NEEDED'
        if (!reconnect)
          console.warn(
            '[seo-google] listing Analytics properties failed',
            isGoogleSeoError(err) ? (err.extra.detail ?? err.code) : err,
          )
        return {
          account: accountOption(
            a,
            reconnect ? 'needs_reconnect' : 'unavailable',
          ),
          properties: [],
        }
      }
    }),
  )
  return {
    accounts: listed.map((l) => l.account),
    options: listed.flatMap((l) => l.properties),
  }
}

/** A site's host for matching ("www." dropped): 'sc-domain:example.com' → example.com. */
function siteHost(siteUrl: string): string | null {
  if (siteUrl.startsWith('sc-domain:'))
    return (
      siteUrl
        .slice('sc-domain:'.length)
        .toLowerCase()
        .replace(/^www\./, '') || null
    )
  try {
    return new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The one verified property that covers `website` (a domain property covers its subdomains), or null when none or several do. Pure. */
export function suggestSite(
  website: string | null,
  options: readonly SearchConsoleSiteOption[],
): string | null {
  if (!website) return null
  let host: string
  try {
    host = new URL(
      /^https?:\/\//i.test(website) ? website : `https://${website}`,
    ).hostname
      .toLowerCase()
      .replace(/^www\./, '')
  } catch {
    return null
  }
  const matches = new Set(
    options
      .filter((o) => o.verified)
      .filter((o) => {
        const h = siteHost(o.site_url)
        if (!h) return false
        return o.site_url.startsWith('sc-domain:')
          ? host === h || host.endsWith(`.${h}`)
          : host === h
      })
      .map((o) => o.site_url),
  )
  return matches.size === 1 ? [...matches][0] : null
}

/**
 * What a person typed, matched to a property: the exact name Google uses,
 * else a bare domain or URL that only one verified property covers. Pure.
 */
export function matchSite(
  asked: string,
  options: readonly SearchConsoleSiteOption[],
):
  | { ok: true; option: SearchConsoleSiteOption }
  | { ok: false; code: GoogleSeoErrorCode; message: string } {
  const exact = options.filter((o) => o.site_url === asked.trim())
  if (!exact.length) {
    const covering = [
      ...new Set(
        options
          .filter((o) => o.verified && suggestSite(asked, [o]) === o.site_url)
          .map((o) => o.site_url),
      ),
    ]
    if (covering.length > 1)
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        message: `Several Search Console sites cover that: ${covering.join(', ')}. Name one exactly.`,
      }
  }
  const pool = exact.length
    ? exact
    : options.filter((o) => o.site_url === suggestSite(asked, options))
  const verified = pool.find((o) => o.verified)
  if (verified) return { ok: true, option: verified }
  if (pool.length)
    return {
      ok: false,
      code: 'NO_ACCESS',
      message:
        'Your Google account isn’t a verified owner or user of that Search Console site, so it can’t be chosen.',
    }
  return {
    ok: false,
    code: 'NO_ACCESS',
    message: options.length
      ? 'Your connected Google account can’t see that site in Search Console. Pick one it lists.'
      : 'Your connected Google account has no Search Console sites.',
  }
}

// ---------------------------------------------------------------------------
// Choosing and clearing
// ---------------------------------------------------------------------------

function failure<T>(err: unknown): SourceWriteResult<T> {
  if (isGoogleSeoError(err))
    return { ok: false, code: err.code, message: err.message }
  throw err
}

/**
 * Choosing what the workspace reads is a full member's act: every member
 * then reads through the chooser's own Google connection, and a guest's
 * choice would not be read at all (./token.ts). Throws NO_ACCESS for a guest.
 */
async function assertMayChoose(
  svc: SupabaseClient,
  who: Who,
  product: GoogleProduct,
): Promise<void> {
  if (!isFullMemberRole(await memberRole(svc, who.workspaceId, who.userId)))
    throw new GoogleSeoError(
      'NO_ACCESS',
      product,
      'Choosing what the workspace reads from Google is for its members. Ask a member to choose it.',
    )
}

/** The caller's usable accounts, or the error to answer with. */
function usable(
  accounts: CallerAccount[],
  product: GoogleProduct,
  accountId?: string,
): CallerAccount[] {
  const mine = accountId
    ? accounts.filter((a) => a.accountId === accountId)
    : accounts
  if (accountId && !mine.length)
    throw new GoogleSeoError(
      'NO_ACCESS',
      product,
      'That isn’t one of your Google connections.',
    )
  if (!mine.length) throw notConnected(product)
  const ok = mine.filter((a) => a.status === 'ok' && a.token)
  if (!ok.length)
    throw reconnectNeeded(product, { user_id: null, name: null, is_you: true })
  return ok
}

/** Choose the workspace's Search Console site through the caller's own connection. */
export async function setSearchConsoleSite(
  svc: SupabaseClient,
  who: Who,
  input: { site_url: string; account_id?: string },
  deps: GoogleSeoDeps = {},
): Promise<SourceWriteResult<SearchConsoleSourceView>> {
  try {
    if (
      typeof input.site_url !== 'string' ||
      !input.site_url.trim() ||
      input.site_url.length > 2048
    ) {
      throw new GoogleSeoError(
        'INVALID_REQUEST',
        'search_console',
        'Which site? Give its Search Console name, like sc-domain:example.com.',
      )
    }
    await assertMayChoose(svc, who, 'search_console')
    const accounts = usable(
      await callerAccounts(svc, who, 'search_console', deps),
      'search_console',
      input.account_id,
    )
    const options: SearchConsoleSiteOption[] = []
    let lastError: unknown = null
    for (const a of accounts) {
      try {
        const sites = await createSearchConsoleClient(a.token!, {
          fetchImpl: deps.fetchImpl,
        }).listSites()
        options.push(
          ...sites.map((s) => ({
            site_url: s.siteUrl,
            permission_level: s.permissionLevel,
            verified: s.permissionLevel !== UNVERIFIED,
            account_id: a.accountId,
            account_email: a.email,
          })),
        )
      } catch (err) {
        lastError = err
      }
    }
    if (!options.length && lastError) throw lastError
    const match = matchSite(input.site_url, options)
    if (!match.ok) return match
    const row = await writeSource(svc, who.workspaceId, {
      sc_site_url: match.option.site_url,
      sc_account_id: match.option.account_id,
      sc_chosen_by: who.userId,
      sc_chosen_at: (deps.now ?? new Date()).toISOString(),
    })
    return {
      ok: true,
      source: await searchConsoleView(svc, who.workspaceId, row),
    }
  } catch (err) {
    return failure(err)
  }
}

/** Choose the workspace's Google Analytics property through the caller's own connection. */
export async function setAnalyticsProperty(
  svc: SupabaseClient,
  who: Who,
  input: { property_id: string; account_id?: string },
  deps: GoogleSeoDeps = {},
): Promise<SourceWriteResult<AnalyticsSourceView>> {
  try {
    const propertyId =
      typeof input.property_id === 'string'
        ? canonicalPropertyId(input.property_id)
        : null
    if (!propertyId)
      throw new GoogleSeoError(
        'INVALID_REQUEST',
        'analytics',
        'Which property? Give its id, like properties/123456.',
      )
    await assertMayChoose(svc, who, 'analytics')
    const accounts = usable(
      await callerAccounts(svc, who, 'analytics', deps),
      'analytics',
      input.account_id,
    )
    let lastError: unknown = null
    for (const a of accounts) {
      const client = createAnalyticsClient(a.token!, {
        fetchImpl: deps.fetchImpl,
      })
      try {
        const properties = await client.listProperties()
        if (!properties.some((p) => p.propertyId === propertyId)) continue
        const property = await client.getProperty(propertyId)
        const row = await writeSource(svc, who.workspaceId, {
          ga4_property_id: property.name,
          ga4_property_name: property.displayName.slice(0, 300) || null,
          ga4_time_zone: property.timeZone.slice(0, 64),
          ga4_currency_code: property.currencyCode.slice(0, 8) || null,
          ga4_account_id: a.accountId,
          ga4_chosen_by: who.userId,
          ga4_chosen_at: (deps.now ?? new Date()).toISOString(),
        })
        return {
          ok: true,
          source: await analyticsView(svc, who.workspaceId, row),
        }
      } catch (err) {
        lastError = err
      }
    }
    if (lastError) throw lastError
    return {
      ok: false,
      code: 'NO_ACCESS',
      message:
        'Your connected Google account can’t see that Google Analytics property. Pick one it lists.',
    }
  } catch (err) {
    return failure(err)
  }
}

/** Stop reading Search Console for this workspace (any full member; a guest can't stop everyone's reads). */
export async function clearSearchConsoleSite(
  svc: SupabaseClient,
  who: Who,
): Promise<SourceWriteResult<SearchConsoleSourceView>> {
  try {
    await assertMayChoose(svc, who, 'search_console')
    if (await readSource(svc, who.workspaceId))
      await writeSource(svc, who.workspaceId, CLEAR_SEARCH_CONSOLE)
    return { ok: true, source: null }
  } catch (err) {
    return failure(err)
  }
}

/** Stop reading Google Analytics for this workspace (any full member; a guest can't stop everyone's reads). */
export async function clearAnalyticsProperty(
  svc: SupabaseClient,
  who: Who,
): Promise<SourceWriteResult<AnalyticsSourceView>> {
  try {
    await assertMayChoose(svc, who, 'analytics')
    if (await readSource(svc, who.workspaceId))
      await writeSource(svc, who.workspaceId, CLEAR_ANALYTICS)
    return { ok: true, source: null }
  } catch (err) {
    return failure(err)
  }
}

// ---------------------------------------------------------------------------
// The choice as the page shows it
// ---------------------------------------------------------------------------

/** Whether the connection a choice names can still be read through, without asking Google. */
async function connectionHealth(
  svc: SupabaseClient,
  workspaceId: string,
  accountId: string | null,
  chosenBy: string | null,
  product: GoogleProduct,
): Promise<{ health: 'ok' | 'needs_reconnect'; email: string | null }> {
  if (!accountId) return { health: 'needs_reconnect', email: null }
  // A choice whose chooser left the workspace (or is now a guest) is no longer read (./token.ts resolveReadToken).
  const stillMember = chosenBy
    ? await memberRole(svc, workspaceId, chosenBy)
        .then(isFullMemberRole)
        .catch(() => false)
    : false
  const { data } = await svc
    .from('connected_account')
    .select(
      'id, user_id, provider, capability, account_email, is_enabled, reauth_required_at',
    )
    .eq('id', accountId)
    .maybeSingle()
  const a = data as {
    user_id: string
    provider: string
    capability: string
    account_email: string | null
    is_enabled: boolean | null
    reauth_required_at: string | null
  } | null
  if (!a || !stillMember || a.user_id !== chosenBy)
    return { health: 'needs_reconnect', email: a?.account_email ?? null }
  const { data: tokens } = await svc
    .from('user_oauth_tokens')
    .select('account_id, scopes, updated_at')
    .eq('user_id', a.user_id)
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false })
    .limit(1)
  const scopes =
    ((tokens ?? []) as Array<{ scopes: string[] | null }>)[0]?.scopes ?? []
  const bad =
    a.provider !== 'google' ||
    a.capability !== product ||
    a.is_enabled === false ||
    Boolean(a.reauth_required_at) ||
    missingScopes('google', product, scopes).length > 0
  return { health: bad ? 'needs_reconnect' : 'ok', email: a.account_email }
}

async function searchConsoleView(
  svc: SupabaseClient,
  workspaceId: string,
  row: SourceRow | null,
): Promise<SearchConsoleSourceView | null> {
  if (!row?.sc_site_url) return null
  const [conn, name] = await Promise.all([
    connectionHealth(
      svc,
      workspaceId,
      row.sc_account_id,
      row.sc_chosen_by,
      'search_console',
    ),
    memberName(svc, workspaceId, row.sc_chosen_by),
  ])
  return {
    site_url: row.sc_site_url,
    account_id: row.sc_account_id,
    account_email: conn.email,
    chosen_by: row.sc_chosen_by,
    chosen_by_name: name,
    chosen_at: row.sc_chosen_at,
    health: conn.health,
  }
}

async function analyticsView(
  svc: SupabaseClient,
  workspaceId: string,
  row: SourceRow | null,
): Promise<AnalyticsSourceView | null> {
  if (!row?.ga4_property_id) return null
  const [conn, name] = await Promise.all([
    connectionHealth(
      svc,
      workspaceId,
      row.ga4_account_id,
      row.ga4_chosen_by,
      'analytics',
    ),
    memberName(svc, workspaceId, row.ga4_chosen_by),
  ])
  return {
    property_id: row.ga4_property_id,
    property_name: row.ga4_property_name,
    time_zone: row.ga4_time_zone,
    currency_code: row.ga4_currency_code,
    account_id: row.ga4_account_id,
    account_email: conn.email,
    chosen_by: row.ga4_chosen_by,
    chosen_by_name: name,
    chosen_at: row.ga4_chosen_at,
    health: conn.health,
  }
}

/** What the workspace reads, without asking Google (the tools' and the page's quick read). */
export async function readGoogleSources(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<{
  search_console: SearchConsoleSourceView | null
  analytics: AnalyticsSourceView | null
}> {
  const row = await readSource(svc, workspaceId)
  const [search_console, analytics] = await Promise.all([
    searchConsoleView(svc, workspaceId, row),
    analyticsView(svc, workspaceId, row),
  ])
  return { search_console, analytics }
}

function productStatus<O, S extends { health: 'ok' | 'needs_reconnect' }>(
  source: S | null,
  listed: Listed<O>,
  suggested: string | null,
): GoogleProductStatus<O, S> {
  return {
    state: googleProductState({ source, myAccounts: listed.accounts }),
    my_accounts: listed.accounts,
    source,
    options: listed.options,
    suggested,
  }
}

/**
 * The "Connect Google" card's read, for the caller and the workspace: each
 * product's state, the caller's own connections, what the workspace reads
 * and through whom, and what the caller could choose (read from Google, so
 * a few seconds at most; one account's failure only marks that account).
 */
export async function googleSeoStatus(
  svc: SupabaseClient,
  who: Who,
  deps: GoogleSeoDeps = {},
): Promise<GoogleSeoStatus> {
  const [sources, sites, properties, website] = await Promise.all([
    readGoogleSources(svc, who.workspaceId),
    listSearchConsoleSites(svc, who, deps),
    listAnalyticsProperties(svc, who, deps),
    workspaceSiteUrl(svc, who.workspaceId).catch(() => null),
  ])
  return {
    workspace_site_url: website,
    search_console: productStatus(
      sources.search_console,
      sites,
      suggestSite(website, sites.options),
    ),
    analytics: productStatus(
      sources.analytics,
      properties,
      properties.options.length === 1
        ? properties.options[0].property_id
        : null,
    ),
  }
}
