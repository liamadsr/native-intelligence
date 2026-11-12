/**
 * Whose Google token a read uses.
 *
 * Connections are a person's (connected_account, capability 'search_console'
 * or 'analytics'); the SEO area is the workspace's. So:
 *
 *   - A READ goes through the connection the workspace's choice names
 *     (seo_google_source: the member who chose the site or property), so every
 *     member sees the same data. {@link resolveReadToken} is that one rule.
 *     When that connection is gone, switched off, refused by Google or missing
 *     the scope, the read fails RECONNECT_NEEDED naming who has to sign in
 *     again; with nothing chosen it is NO_SOURCE (the caller has a connection
 *     and can choose) or NOT_CONNECTED (they have none).
 *   - CHOOSING a site or property needs the CALLER's own connection to read
 *     it ({@link callerAccounts}, used by source.ts).
 *
 * Tokens come from the house token manager (src/lib/oauth/token-manager.ts),
 * which refreshes them and only ever hands out the account owner's own token.
 * No token is stored or returned anywhere else.
 */
import { missingScopes } from '@/lib/oauth/scope-diff'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { isFullMemberRole, memberStanding } from '@/lib/seo/membership'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  chooserGone,
  GoogleSeoError,
  noSource,
  notConnected,
  reconnectNeeded,
} from './errors'
import { readSource, type SourceRow } from './store'
import type { GoogleProduct } from './view'

export interface TokenDeps {
  /** A fresh access token for one connection (default: the token manager's). */
  tokenForAccount?: (accountId: string) => Promise<{ token: string } | null>
}

interface AccountRow {
  id: string
  user_id: string
  provider: string
  capability: string
  account_email: string | null
  is_enabled: boolean | null
  reauth_required_at: string | null
  is_primary: boolean | null
}

const ACCOUNT_FIELDS =
  'id, user_id, provider, capability, account_email, is_enabled, reauth_required_at, is_primary'

const defaultTokenForAccount = async (accountId: string) => {
  const result = await getValidTokenForAccount(accountId)
  return result ? { token: result.token } : null
}

/** The scopes Google granted each of these connections (the newest token row per account). */
async function grantedScopes(
  svc: SupabaseClient,
  userId: string,
  accountIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!accountIds.length) return out
  const { data } = await svc
    .from('user_oauth_tokens')
    .select('account_id, scopes, updated_at')
    .eq('user_id', userId)
    .in('account_id', accountIds)
    .order('updated_at', { ascending: false })
  for (const row of (data ?? []) as Array<{
    account_id: string | null
    scopes: string[] | null
  }>) {
    if (row.account_id && !out.has(row.account_id))
      out.set(row.account_id, row.scopes ?? [])
  }
  return out
}

/** Why this connection can't be used without a fresh sign-in (null: it can). Pure. */
export function accountProblem(
  account: Pick<
    AccountRow,
    'provider' | 'capability' | 'is_enabled' | 'reauth_required_at'
  >,
  product: GoogleProduct,
  scopes: string[],
): string | null {
  if (account.provider !== 'google' || account.capability !== product)
    return 'not this product'
  if (account.is_enabled === false) return 'switched off'
  if (account.reauth_required_at) return 'refused by Google'
  if (missingScopes('google', product, scopes).length)
    return 'missing the scope'
  return null
}

/** A member's name in this workspace, for "who has to reconnect". */
export async function memberName(
  svc: SupabaseClient,
  workspaceId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null
  const { data } = await svc
    .from('member')
    .select('display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()
  const name = (data as { display_name?: unknown } | null)?.display_name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export interface CallerAccount {
  accountId: string
  email: string | null
  /** ok: a token is in hand; needs_reconnect: switched off, refused, missing the scope, or no token. */
  status: 'ok' | 'needs_reconnect'
  token: string | null
}

/**
 * The caller's own connections for a product, primary first, each with a
 * token when it can be used. `withTokens: false` checks them without asking
 * for tokens (a status read).
 */
export async function callerAccounts(
  svc: SupabaseClient,
  who: { userId: string },
  product: GoogleProduct,
  deps: TokenDeps & { withTokens?: boolean } = {},
): Promise<CallerAccount[]> {
  const { data } = await svc
    .from('connected_account')
    .select(ACCOUNT_FIELDS)
    .eq('user_id', who.userId)
    .eq('provider', 'google')
    .eq('capability', product)
    .order('created_at', { ascending: true })
  const accounts = ((data ?? []) as AccountRow[]).sort(
    (a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)),
  )
  if (!accounts.length) return []
  const scopes = await grantedScopes(
    svc,
    who.userId,
    accounts.map((a) => a.id),
  )
  const tokenFor = deps.tokenForAccount ?? defaultTokenForAccount
  return Promise.all(
    accounts.map(async (a): Promise<CallerAccount> => {
      if (accountProblem(a, product, scopes.get(a.id) ?? []))
        return {
          accountId: a.id,
          email: a.account_email,
          status: 'needs_reconnect',
          token: null,
        }
      if (deps.withTokens === false)
        return {
          accountId: a.id,
          email: a.account_email,
          status: 'ok',
          token: null,
        }
      const token = await tokenFor(a.id).catch(() => null)
      return token
        ? {
            accountId: a.id,
            email: a.account_email,
            status: 'ok',
            token: token.token,
          }
        : {
            accountId: a.id,
            email: a.account_email,
            status: 'needs_reconnect',
            token: null,
          }
    }),
  )
}

export interface ReadToken {
  token: string
  accountId: string
  source: SourceRow
  /** Who the reads go through, for a RECONNECT_NEEDED raised later by Google itself. */
  owner: { user_id: string | null; name: string | null; is_you: boolean }
}

function sourceFor(
  row: SourceRow | null,
  product: GoogleProduct,
): { chosen: boolean; accountId: string | null; chosenBy: string | null } {
  if (!row) return { chosen: false, accountId: null, chosenBy: null }
  return product === 'search_console'
    ? {
        chosen: Boolean(row.sc_site_url),
        accountId: row.sc_account_id,
        chosenBy: row.sc_chosen_by,
      }
    : {
        chosen: Boolean(row.ga4_property_id),
        accountId: row.ga4_account_id,
        chosenBy: row.ga4_chosen_by,
      }
}

/**
 * THE rule for a read: the token of the connection the workspace's choice
 * names, whoever is asking. `userId` is the person asking (null for a
 * scheduled read): it decides NO_SOURCE versus NOT_CONNECTED and whether the
 * reconnect sentence says "your".
 */
export async function resolveReadToken(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
  product: GoogleProduct,
  deps: TokenDeps = {},
): Promise<ReadToken> {
  const row = await readSource(svc, who.workspaceId)
  const src = sourceFor(row, product)
  if (!row || !src.chosen) {
    if (!who.userId) throw noSource(product)
    const mine = await callerAccounts(svc, { userId: who.userId }, product, {
      ...deps,
      withTokens: false,
    })
    throw mine.length ? noSource(product) : notConnected(product)
  }
  // The reads go through one member's own Google connection, so they stop
  // the moment that person is no longer a full member here (left, removed,
  // or now a guest). An unreadable member row throws: no read on a guess.
  const standing = src.chosenBy
    ? await memberStanding(svc, who.workspaceId, src.chosenBy)
    : { role: null, name: null }
  const owner = {
    user_id: src.chosenBy,
    name: standing.name,
    is_you: Boolean(who.userId && src.chosenBy === who.userId),
  }
  if (!isFullMemberRole(standing.role)) throw chooserGone(product, owner)
  if (!src.accountId)
    throw reconnectNeeded(product, owner, 'connection removed')

  const { data } = await svc
    .from('connected_account')
    .select(ACCOUNT_FIELDS)
    .eq('id', src.accountId)
    .maybeSingle()
  const account = data as AccountRow | null
  if (!account) throw reconnectNeeded(product, owner, 'connection removed')
  // The reads go through the chooser's own connection: one that is someone else's is never used.
  if (account.user_id !== src.chosenBy)
    throw reconnectNeeded(product, owner, 'connection belongs to someone else')
  const scopes =
    (await grantedScopes(svc, account.user_id, [account.id])).get(account.id) ??
    []
  const problem = accountProblem(account, product, scopes)
  if (problem) throw reconnectNeeded(product, owner, problem)

  const token = await (deps.tokenForAccount ?? defaultTokenForAccount)(
    account.id,
  ).catch(() => null)
  if (!token) throw reconnectNeeded(product, owner, 'no token')
  return { token: token.token, accountId: account.id, source: row, owner }
}

/** A RECONNECT_NEEDED that Google raised mid-read, said about the member whose connection it is. Anything else unchanged. */
export function attributeFailure(
  err: unknown,
  product: GoogleProduct,
  owner: ReadToken['owner'],
): unknown {
  if (
    err instanceof GoogleSeoError &&
    err.code === 'RECONNECT_NEEDED' &&
    !err.extra.reconnectBy
  ) {
    return reconnectNeeded(product, owner, err.extra.detail)
  }
  return err
}
