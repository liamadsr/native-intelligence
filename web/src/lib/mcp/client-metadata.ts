/**
 * OAuth Client ID Metadata Documents (CIMD) for Dial8's MCP OAuth server
 * (draft-ietf-oauth-client-id-metadata-document, which the MCP authorization
 * spec of 2025-11-25 says servers SHOULD support). An app with no prior
 * relationship to Dial8 names itself with an https URL as its client_id, and
 * the JSON document at that URL is its registration: its name, its redirect
 * URIs, how it authenticates. It sits beside dynamic client registration
 * (register/route.ts), whose ids are `mcp_…` and never a URL.
 *
 * This file: what a client_id URL and its document must be, and a cache of
 * documents that passed. The fetch itself (DNS-pinned to public addresses)
 * is client-metadata-fetch.ts; checkMcpClient (oauth-client.ts) is the caller.
 */

import { assertSafeMcpUrl, ipv6Groups } from '@/lib/mcp-client/url-guard'
import { isAllowedRedirectUri } from './redirect-uri'

/** The most of a document read (the draft recommends 5 KB); a longer one is refused. */
export const METADATA_MAX_BYTES = 5 * 1024
/** How long a document that passed is trusted with no cache header, and at most. */
export const DEFAULT_TTL_MS = 5 * 60_000
export const MAX_TTL_MS = 60 * 60_000
const CACHE_LIMIT = 500
/** Unrefunded document fetches (the failed ones) one person may cause per window, per server instance. */
export const FAILED_FETCHES_PER_WINDOW = 20
export const FETCH_WINDOW_MS = 10 * 60_000
/** How long a client_id whose document passed for a person is fetched for them without charge. */
export const PASSED_GRACE_MS = 60 * 60_000
/** At most this many passed client_ids kept per person, and this many newly kept per window. */
export const PASSED_PER_PERSON = 50
export const NEW_PASSES_PER_WINDOW = 20
const PEOPLE_LIMIT = 500
const MAX_CLIENT_ID_LENGTH = 512
const MAX_REDIRECT_URIS = 20
const MAX_NAME_LENGTH = 100

/** What Dial8 keeps of a document that passed. */
export interface ClientMetadata {
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
}

/** A document as fetched: its parsed JSON body and its Cache-Control header. */
export interface FetchedDocument {
  body: unknown
  cacheControl: string | null
}
export type FetchDocument = (url: string) => Promise<FetchedDocument>

export type MetadataResult = { ok: true; metadata: ClientMetadata } | { ok: false; reason: string }

/** A client_id that names a metadata document rather than a registered client. */
export function isMetadataClientId(clientId: string): boolean {
  return clientId.startsWith('https://')
}

/**
 * Why `raw` can't be a client_id URL, or null when it can. The draft's rules
 * (https, a path, no userinfo, no fragment, no dot segments; a query is
 * NOT RECOMMENDED and refused here), plus Dial8's: the URL in its canonical
 * form (so the string compared is the one fetched), the default port (so a
 * client_id can't aim Dial8 at another service on a host), a public host
 * name, never an IP address or a name the SSRF guard refuses.
 */
export function clientIdUrlProblem(raw: string): string | null {
  if (raw.length > MAX_CLIENT_ID_LENGTH) return 'client_id URL is too long'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'client_id is not a valid URL'
  }
  if (url.protocol !== 'https:') return 'client_id URL must use https'
  if (url.username || url.password) return 'client_id URL must not carry a username or password'
  if (url.hash || raw.includes('#')) return 'client_id URL must not have a fragment'
  if (url.search || raw.includes('?')) return 'client_id URL must not have a query'
  if (url.pathname === '/') return 'client_id URL must have a path'
  if (url.port !== '') return 'client_id URL must use the default https port'
  // The parser drops dot segments and default ports and lowercases the host:
  // a URL it would change is refused, so what is compared is what is fetched.
  if (url.href !== raw) return 'client_id URL must be in canonical form'
  const host = url.hostname
  if (ipv6Groups(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'client_id URL must name a host, not an IP address'
  if (!host.includes('.') || host.endsWith('.')) return 'client_id URL must name a public host'
  if (!assertSafeMcpUrl(raw).ok) return 'client_id URL must name a public host'
  return null
}

/** Control and bidi-override characters: never in a name the consent page shows. */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * A client's name as Dial8 shows it (consent page, Connected apps): control
 * and bidi characters dropped, at most 100, `fallback` when nothing is left.
 * For registered clients too: /register stores whatever name it is sent.
 */
export function cleanClientName(name: unknown, fallback: string): string {
  const clean = typeof name === 'string' ? name.replace(UNSAFE_NAME_CHARS, '').trim().slice(0, MAX_NAME_LENGTH) : ''
  return clean || fallback
}

/**
 * The document at `clientId`, checked: a JSON object whose client_id is that
 * URL exactly, a public client (no secret; auth method `none`, the only one
 * Dial8's token endpoint takes), the authorization code flow, and 1–20
 * redirect URIs that pass the same rule /register applies. A missing name
 * becomes the host: the consent page shows the host either way.
 */
export function parseClientMetadata(clientId: string, body: unknown): MetadataResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'Client metadata is not a JSON object' }
  const doc = body as Record<string, unknown>
  if (doc.client_id !== clientId) return { ok: false, reason: "Client metadata's client_id does not match its URL" }
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) {
    return { ok: false, reason: 'Client metadata must not carry a client secret' }
  }
  const method = doc.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') return { ok: false, reason: 'Only public clients are supported (token_endpoint_auth_method "none")' }

  const redirects = doc.redirect_uris
  if (!Array.isArray(redirects) || redirects.length === 0) return { ok: false, reason: 'Client metadata has no redirect_uris' }
  if (redirects.length > MAX_REDIRECT_URIS) return { ok: false, reason: 'Client metadata lists too many redirect_uris' }
  if (!redirects.every((uri) => typeof uri === 'string' && uri.length <= 2048 && isAllowedRedirectUri(uri))) {
    return { ok: false, reason: 'Client metadata lists a redirect_uri that is not allowed' }
  }

  const grants = doc.grant_types
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes('authorization_code'))) {
    return { ok: false, reason: 'Client metadata must allow the authorization_code grant' }
  }
  const responses = doc.response_types
  if (responses !== undefined && (!Array.isArray(responses) || !responses.includes('code'))) {
    return { ok: false, reason: 'Client metadata must allow the code response type' }
  }

  return {
    ok: true,
    metadata: {
      client_id: clientId,
      client_name: cleanClientName(doc.client_name, new URL(clientId).host),
      redirect_uris: redirects as string[],
      grant_types: Array.isArray(grants)
        ? ['authorization_code', 'refresh_token'].filter((g) => grants.includes(g))
        : ['authorization_code', 'refresh_token'],
    },
  }
}

/**
 * How long to keep a document, from its Cache-Control: none for no-store or
 * no-cache, its max-age bounded to an hour, five minutes without one.
 */
export function cacheTtlMs(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_TTL_MS
  const cc = cacheControl.toLowerCase()
  if (/(^|[\s,])no-(store|cache)\b/.test(cc)) return 0
  const maxAge = /(^|[\s,])max-age\s*=\s*"?(\d+)/.exec(cc)
  if (!maxAge) return DEFAULT_TTL_MS
  return Math.min(Number(maxAge[2]) * 1000, MAX_TTL_MS)
}

// Documents that passed, per server instance. A failure is never kept (the
// draft forbids caching errors and invalid documents).
const cache = new Map<string, { metadata: ClientMetadata; until: number }>()

// Each person's allowance, per instance. With the default port and the 5 s
// deadline it keeps one account from using Dial8 to probe hosts at volume:
//   - A fetch of a client_id the person has no recent pass for is charged
//     BEFORE it runs (so parallel lookups can't all slip past) and refunded
//     if the document passes: only failures stay counted.
//   - A client_id whose document passed for this person within the hour is
//     fetched free, so another site steering their browser at bad client_ids
//     (one click opens a popup it can keep navigating) can't spend the
//     allowance a real app needs. VS Code serves its document no-store, so
//     every step of its sign-in fetches it. The passes are the person's own
//     (no other account can push them out) and only NEW_PASSES_PER_WINDOW
//     new ones are kept per window, so a steered popup can't churn them.
//   - A passed client_id that then fails is charged and loses its pass.
//   - Only ONE free fetch per person and client_id runs at a time: parallel
//     lookups of a passed client_id are charged like new ones (else a
//     document passed once, its DNS then pointed elsewhere, would fetch free
//     in a burst before the first failure is counted).
interface Allowance {
  /** Charged fetches this window (refunded ones removed). */
  charged: number[]
  /** client_id → until when it is fetched free for this person (newest last). */
  passed: Map<string, number>
  /** When each pass was newly kept, this window. */
  newPasses: number[]
  /** Passed client_ids with their one free fetch running now. */
  freeInFlight: Set<string>
}
const allowances = new Map<string, Allowance>()

/** `requester`'s allowance with what has aged out dropped (not stored). */
function allowanceOf(requester: string, now: number): Allowance {
  const a = allowances.get(requester) ?? { charged: [], passed: new Map(), newPasses: [], freeInFlight: new Set() }
  const since = now - FETCH_WINDOW_MS
  a.charged = a.charged.filter((at) => at > since)
  a.newPasses = a.newPasses.filter((at) => at > since)
  for (const [id, until] of a.passed) if (until <= now) a.passed.delete(id)
  return a
}

/** Store `a` (newest last) when it holds anything; never more than PEOPLE_LIMIT people. */
function keep(requester: string, a: Allowance): void {
  allowances.delete(requester)
  if (a.charged.length || a.passed.size || a.newPasses.length || a.freeInFlight.size) allowances.set(requester, a)
  while (allowances.size > PEOPLE_LIMIT) allowances.delete(allowances.keys().next().value!)
}

function refund(a: Allowance, at: number): void {
  const i = a.charged.lastIndexOf(at)
  if (i !== -1) a.charged.splice(i, 1)
}

function markPassed(a: Allowance, clientId: string, now: number): void {
  if (a.passed.has(clientId)) {
    // Re-inserted, so the cap evicts the least recently used pass, never the app in daily use.
    a.passed.delete(clientId)
    a.passed.set(clientId, now + PASSED_GRACE_MS)
    return
  }
  if (a.newPasses.length >= NEW_PASSES_PER_WINDOW) return
  a.newPasses.push(now)
  a.passed.set(clientId, now + PASSED_GRACE_MS)
  while (a.passed.size > PASSED_PER_PERSON) a.passed.delete(a.passed.keys().next().value!)
}

/** Test seam: forget every kept document and every allowance. */
export function _resetClientMetadataCacheForTests(): void {
  cache.clear()
  allowances.clear()
}

/** Test seam: how many people have an allowance kept. */
export function _allowancesKeptForTests(): number {
  return allowances.size
}

export interface ResolveOptions {
  fetchDocument: FetchDocument
  /** Who caused the lookup (the signed-in person): fetches are counted per requester. */
  requester: string
  now?: number
}

/**
 * The checked metadata for a client_id URL: from the cache while it's fresh,
 * else fetched and checked again, within the requester's allowance of failed
 * fetches (a client_id that passed for them within the hour is fetched free). Any
 * failure (the URL, the allowance, the fetch, the document) is a refusal; the
 * reason is safe to show the app, and the fetch's own detail is logged, not
 * returned.
 */
export async function resolveClientMetadata(clientId: string, { fetchDocument, requester, now = Date.now() }: ResolveOptions): Promise<MetadataResult> {
  const problem = clientIdUrlProblem(clientId)
  if (problem) return { ok: false, reason: problem }
  const kept = cache.get(clientId)
  if (kept && kept.until > now) return { ok: true, metadata: kept.metadata }
  cache.delete(clientId)
  const a = allowanceOf(requester, now)
  // Free: a client_id that passed for this person, with no free fetch of it running.
  const free = a.passed.has(clientId) && !a.freeInFlight.has(clientId)
  if (free) {
    a.freeInFlight.add(clientId)
  } else {
    if (a.charged.length >= FAILED_FETCHES_PER_WINDOW) {
      keep(requester, a)
      return { ok: false, reason: 'Too many failed client lookups. Try again in a few minutes.' }
    }
    a.charged.push(now)
  }
  keep(requester, a)
  // A charged fetch is refunded on a pass; a free one that fails is charged then, and loses its pass.
  const failed = () => {
    if (free) {
      a.freeInFlight.delete(clientId)
      a.passed.delete(clientId)
      a.charged.push(now)
    }
    keep(requester, a)
  }

  let fetched: FetchedDocument
  try {
    fetched = await fetchDocument(clientId)
  } catch (err) {
    console.warn('[mcp-cimd] metadata fetch failed', { clientId, error: err instanceof Error ? err.message : String(err) })
    failed()
    return { ok: false, reason: "Couldn't fetch the client's metadata document" }
  }
  const parsed = parseClientMetadata(clientId, fetched.body)
  if (!parsed.ok) {
    failed()
    return parsed
  }
  if (free) a.freeInFlight.delete(clientId)
  else refund(a, now)
  markPassed(a, clientId, now)
  keep(requester, a)

  const ttl = cacheTtlMs(fetched.cacheControl)
  if (ttl > 0) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    cache.set(clientId, { metadata: parsed.metadata, until: now + ttl })
  }
  return parsed
}
