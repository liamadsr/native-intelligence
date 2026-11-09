/**
 * The texted Stripe setup link (migration 459, stripe_connect_link): a link
 * Native Intelligence texts the owner that starts their Stripe onboarding, once, for one
 * account (user and workspace), within 15 minutes.
 *
 * Built to the shape of track A's one-time links (src/lib/links/one-time.ts,
 * migration 457: purpose, account, 15-minute expiry, single use, only the
 * token's sha256 stored, peek without using, consume atomically). When both
 * are merged this file becomes a thin call into that helper with purpose
 * 'stripe_connect', and the table folds into one_time_link.
 *
 *   create   a random 144-bit token → `<origin>/payments/setup/<token>`.
 *   peek     what the link is for, without using it: the GET page, so a link
 *            preview (iMessage, Android) fetching the URL can't burn it.
 *   consume  once, atomically (a conditional update on consumed_at and the
 *            expiry), from the page's same-origin POST.
 *
 * Server only (service client). Never throws: every result is a value.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PAYMENTS_PATHS } from './config'

/** How long a link works. */
export const SETUP_LINK_TTL_MS = 15 * 60_000
/** At most one fresh link per workspace this often (the refresh route re-texts). */
export const SETUP_LINK_MIN_GAP_MS = 2 * 60_000
/** At most this many links per workspace a day. */
export const SETUP_LINK_DAILY_CAP = 8

export const SETUP_LINK_PURPOSE = 'stripe_connect' as const

const TOKEN_BYTES = 18
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24}$/

export interface SetupLink {
  id: string
  userId: string
  workspaceId: string
  payload: Record<string, unknown>
  expiresAt: string
}

export type CreateSetupLinkResult =
  | { ok: true; token: string; url: string; expiresAt: string }
  | { ok: false; error: string; reason?: 'too_soon' | 'daily_cap' }
export type SetupLinkLookup = { ok: true; link: SetupLink } | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'lookup_failed' }

export function isSetupLinkToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
}

/** The stored form of a token. */
export function setupLinkTokenHash(token: string): string {
  return createHash('sha256').update(`stripe-connect-link:${token}`).digest('hex')
}

export function setupLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}${PAYMENTS_PATHS.setup(token)}`
}

interface LinkRow {
  id: string
  user_id: string
  workspace_id: string
  payload: unknown
  expires_at: string
  consumed_at: string | null
}

const LINK_COLUMNS = 'id, user_id, workspace_id, payload, expires_at, consumed_at'

function toLink(row: LinkRow): SetupLink {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {}
  return { id: row.id, userId: row.user_id, workspaceId: row.workspace_id, payload, expiresAt: row.expires_at }
}

export interface SetupLinkDeps {
  now?: () => number
  token?: () => string
}

/**
 * Make a link for one account. Paced per workspace (one per two minutes, a
 * few a day), since a public route (Stripe's refresh URL) can ask for one.
 */
export async function createSetupLink(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; origin: string; payload?: Record<string, unknown> },
  deps: SetupLinkDeps = {},
): Promise<CreateSetupLinkResult> {
  const now = (deps.now ?? Date.now)()
  try {
    const since = new Date(now - 24 * 60 * 60_000).toISOString()
    const { data: recent, error: recentError } = await supabase
      .from('stripe_connect_link')
      .select('created_at')
      .eq('workspace_id', args.workspaceId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(SETUP_LINK_DAILY_CAP)
    if (recentError) return { ok: false, error: `stripe_connect_link read failed: ${recentError.message}` }
    const rows = (recent ?? []) as Array<{ created_at: string }>
    if (rows.length >= SETUP_LINK_DAILY_CAP) return { ok: false, error: 'Too many setup links today.', reason: 'daily_cap' }
    if (rows[0] && now - Date.parse(rows[0].created_at) < SETUP_LINK_MIN_GAP_MS) {
      return { ok: false, error: 'A setup link was just sent.', reason: 'too_soon' }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const token = (deps.token ?? (() => randomBytes(TOKEN_BYTES).toString('base64url')))()
  if (!isSetupLinkToken(token)) return { ok: false, error: 'bad token' }
  const expiresAt = new Date(now + SETUP_LINK_TTL_MS).toISOString()
  try {
    const { error } = await supabase.from('stripe_connect_link').insert({
      token_hash: setupLinkTokenHash(token),
      purpose: SETUP_LINK_PURPOSE,
      user_id: args.userId,
      workspace_id: args.workspaceId,
      payload: args.payload ?? {},
      expires_at: expiresAt,
    })
    if (error) return { ok: false, error: `stripe_connect_link insert failed: ${error.message}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, token, url: setupLinkUrl(args.origin, token), expiresAt }
}

/** What a link is for, without using it. */
export async function peekSetupLink(supabase: SupabaseClient, token: unknown, deps: SetupLinkDeps = {}): Promise<SetupLinkLookup> {
  if (!isSetupLinkToken(token)) return { ok: false, reason: 'not_found' }
  const now = (deps.now ?? Date.now)()
  try {
    const { data, error } = await supabase
      .from('stripe_connect_link')
      .select(LINK_COLUMNS)
      .eq('token_hash', setupLinkTokenHash(token))
      .maybeSingle<LinkRow>()
    if (error) return { ok: false, reason: 'lookup_failed' }
    if (!data) return { ok: false, reason: 'not_found' }
    if (data.consumed_at) return { ok: false, reason: 'used' }
    if (Date.parse(data.expires_at) <= now) return { ok: false, reason: 'expired' }
    return { ok: true, link: toLink(data) }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
}

/**
 * Use a link, once. Conditional on it being unused and unexpired, so of two
 * parallel uses only one gets the row; a miss is read back to say why.
 */
export async function consumeSetupLink(supabase: SupabaseClient, token: unknown, deps: SetupLinkDeps = {}): Promise<SetupLinkLookup> {
  if (!isSetupLinkToken(token)) return { ok: false, reason: 'not_found' }
  const now = (deps.now ?? Date.now)()
  const at = new Date(now).toISOString()
  try {
    const { data, error } = await supabase
      .from('stripe_connect_link')
      .update({ consumed_at: at })
      .eq('token_hash', setupLinkTokenHash(token))
      .is('consumed_at', null)
      .gt('expires_at', at)
      .select(LINK_COLUMNS)
    if (error) return { ok: false, reason: 'lookup_failed' }
    const row = Array.isArray(data) ? (data[0] as LinkRow | undefined) : undefined
    if (row) return { ok: true, link: toLink(row) }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
  const peeked = await peekSetupLink(supabase, token, { now: () => now })
  return peeked.ok ? { ok: false, reason: 'used' } : peeked
}
