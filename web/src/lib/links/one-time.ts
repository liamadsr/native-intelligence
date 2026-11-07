/**
 * Single-use links (migration 457): a link Dial8 texts (or shows) that does
 * one thing for one account, once, before it expires. The first purpose is an
 * OAuth connect started from a text (./purposes.ts); Stripe Connect's
 * onboarding link (roadmap track C) is meant to be the next.
 *
 *   create   a random 144-bit token; only its sha256 is stored, with the
 *            purpose, the account (user and workspace) it is bound to, a small
 *            payload and the expiry (15 minutes by default). The URL is
 *            `<origin>/l/<token>`.
 *   peek     what the link is for, without using it: the GET page
 *            (src/app/l/[token]/page.tsx) reads it this way, so a link
 *            preview (iMessage, Android) fetching the URL can't burn it.
 *   consume  once, atomically (a conditional update on consumed_at and the
 *            expiry), from the page's same-origin POST
 *            (src/app/api/links/[token]/route.ts). A second use, a parallel
 *            one or a late one finds nothing.
 *
 * Server only (service client): no client can read the table. Never throws:
 * every result is a discriminated value.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/** How long a link works. */
export const ONE_TIME_LINK_TTL_MS = 15 * 60_000
/** The longest a caller may ask a link to live. */
export const ONE_TIME_LINK_MAX_TTL_MS = 24 * 60 * 60_000

/** What a link may do (migration 457's check). */
export const ONE_TIME_LINK_PURPOSES = ['oauth_connect'] as const
export type OneTimeLinkPurpose = (typeof ONE_TIME_LINK_PURPOSES)[number]

/** The token's bytes: 18 → 24 base64url characters. */
const TOKEN_BYTES = 18
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24}$/

/** A link, as its purpose reads it. */
export interface OneTimeLink {
  id: string
  purpose: OneTimeLinkPurpose
  userId: string
  workspaceId: string
  payload: Record<string, unknown>
  expiresAt: string
}

export type CreateLinkResult = { ok: true; token: string; url: string; expiresAt: string } | { ok: false; error: string }
export type LinkLookup = { ok: true; link: OneTimeLink } | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'lookup_failed' }

export function isOneTimeLinkPurpose(value: unknown): value is OneTimeLinkPurpose {
  return typeof value === 'string' && (ONE_TIME_LINK_PURPOSES as readonly string[]).includes(value)
}

/** True when `token` has a link token's shape (checked before any read). */
export function isLinkToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
}

/** The stored form of a token. Exported for the tests. */
export function linkTokenHash(token: string): string {
  return createHash('sha256').update(`one-time-link:${token}`).digest('hex')
}

/** The link's URL. */
export function oneTimeLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/l/${token}`
}

interface LinkRow {
  id: string
  purpose: string
  user_id: string
  workspace_id: string
  payload: unknown
  expires_at: string
  consumed_at: string | null
}

const LINK_COLUMNS = 'id, purpose, user_id, workspace_id, payload, expires_at, consumed_at'

function toLink(row: LinkRow): OneTimeLink | null {
  if (!isOneTimeLinkPurpose(row.purpose)) return null
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {}
  return { id: row.id, purpose: row.purpose, userId: row.user_id, workspaceId: row.workspace_id, payload, expiresAt: row.expires_at }
}

/** Seams for the tests. */
export interface OneTimeLinkDeps {
  now?: () => number
  token?: () => string
}

/** Make a link for one account and one purpose. */
export async function createOneTimeLink(
  supabase: SupabaseClient,
  args: { purpose: OneTimeLinkPurpose; userId: string; workspaceId: string; payload?: Record<string, unknown>; ttlMs?: number; origin: string },
  deps: OneTimeLinkDeps = {},
): Promise<CreateLinkResult> {
  if (!isOneTimeLinkPurpose(args.purpose)) return { ok: false, error: 'unknown purpose' }
  const ttl = Math.min(Math.max(args.ttlMs ?? ONE_TIME_LINK_TTL_MS, 60_000), ONE_TIME_LINK_MAX_TTL_MS)
  const now = (deps.now ?? Date.now)()
  const token = (deps.token ?? (() => randomBytes(TOKEN_BYTES).toString('base64url')))()
  if (!isLinkToken(token)) return { ok: false, error: 'bad token' }
  const expiresAt = new Date(now + ttl).toISOString()
  try {
    const { error } = await supabase.from('one_time_link').insert({
      token_hash: linkTokenHash(token),
      purpose: args.purpose,
      user_id: args.userId,
      workspace_id: args.workspaceId,
      payload: args.payload ?? {},
      expires_at: expiresAt,
    })
    if (error) return { ok: false, error: `one_time_link insert failed: ${error.message}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, token, url: oneTimeLinkUrl(args.origin, token), expiresAt }
}

/** What a link is for, without using it. */
export async function peekOneTimeLink(supabase: SupabaseClient, token: unknown, deps: OneTimeLinkDeps = {}): Promise<LinkLookup> {
  if (!isLinkToken(token)) return { ok: false, reason: 'not_found' }
  const now = (deps.now ?? Date.now)()
  try {
    const { data, error } = await supabase.from('one_time_link').select(LINK_COLUMNS).eq('token_hash', linkTokenHash(token)).maybeSingle<LinkRow>()
    if (error) return { ok: false, reason: 'lookup_failed' }
    if (!data) return { ok: false, reason: 'not_found' }
    if (data.consumed_at) return { ok: false, reason: 'used' }
    if (Date.parse(data.expires_at) <= now) return { ok: false, reason: 'expired' }
    const link = toLink(data)
    return link ? { ok: true, link } : { ok: false, reason: 'not_found' }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
}

/**
 * Use a link, once. The update is conditional on it being unused and
 * unexpired, so of two parallel uses only one gets the row. A miss is read
 * back to say why (used, expired, or no such link).
 */
export async function consumeOneTimeLink(supabase: SupabaseClient, token: unknown, deps: OneTimeLinkDeps = {}): Promise<LinkLookup> {
  if (!isLinkToken(token)) return { ok: false, reason: 'not_found' }
  const now = (deps.now ?? Date.now)()
  const at = new Date(now).toISOString()
  try {
    const { data, error } = await supabase
      .from('one_time_link')
      .update({ consumed_at: at })
      .eq('token_hash', linkTokenHash(token))
      .is('consumed_at', null)
      .gt('expires_at', at)
      .select(LINK_COLUMNS)
    if (error) return { ok: false, reason: 'lookup_failed' }
    const row = Array.isArray(data) ? (data[0] as LinkRow | undefined) : undefined
    if (row) {
      const link = toLink(row)
      return link ? { ok: true, link } : { ok: false, reason: 'not_found' }
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
  const peeked = await peekOneTimeLink(supabase, token, { now: () => now })
  // It was there and usable a moment ago: someone else used it first.
  return peeked.ok ? { ok: false, reason: 'used' } : peeked
}
