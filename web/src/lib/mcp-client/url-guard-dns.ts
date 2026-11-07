/**
 * The DNS half of the MCP SSRF guard (url-guard.ts checks the name and any
 * literal IP; this checks what the name RESOLVES to). One lookup of every
 * address the host has, before a probe or an OAuth discovery dials it: a
 * public-looking name that resolves to a private, loopback, link-local or
 * metadata address is refused.
 *
 * It narrows DNS rebinding but doesn't close it (the dial resolves again a
 * moment later; url-guard.ts says why a pinned dial isn't possible with the
 * MCP SDK). Server-only (node:dns). The lookup is injectable: tests pass
 * their own and never touch real DNS.
 */
import 'server-only'
import { lookup as dnsLookup } from 'node:dns/promises'
import { ensureSafeMcpUrl, ipv6Groups, isPublicAddress } from './url-guard'

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string }>>

const defaultLookup: AddressLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

/** How long a host found public is trusted before it is looked up again (per instance). */
export const PUBLIC_HOST_TTL_MS = 60_000
const publicUntil = new Map<string, number>()

/** Test seam: forget which hosts were found public. */
export function _resetPublicHostCacheForTests(): void {
  publicUntil.clear()
}

/**
 * The whole guard before ANY dial or fetch of an MCP-related URL, the
 * person's or one a server supplied (resource metadata, an issuer, a
 * registration or token endpoint): the name and literal checks
 * (url-guard.ts ensureSafeMcpUrl), then every address the name resolves to
 * must be public. Throws on a refusal.
 *
 * Hot path (every withClient: each chat call, live lookup, apply, refresh):
 * a host found public is trusted for PUBLIC_HOST_TTL_MS (60 s) per
 * instance, so a busy server costs one lookup a minute, not one per call. A
 * refusal is never cached (it throws again next time, cheaply).
 */
export async function ensurePublicMcpUrl(raw: string, lookup?: AddressLookup, now = Date.now()): Promise<URL> {
  const url = ensureSafeMcpUrl(raw)
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if ((publicUntil.get(host) ?? 0) > now) return url
  const checked = await assertPublicHost(url, lookup)
  if (!checked.ok) throw new Error(`Refused to fetch ${url.origin}: ${checked.reason}`)
  publicUntil.set(host, now + PUBLIC_HOST_TTL_MS)
  return url
}

/** Refuse a host any of whose addresses is not public. A literal IP is checked as itself. */
export async function assertPublicHost(
  url: URL | string,
  lookup: AddressLookup = defaultLookup,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = (typeof url === 'string' ? new URL(url) : url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  // Development's local test server (url-guard.ts allows it there only).
  if (process.env.NODE_ENV !== 'production' && (host === 'localhost' || host === '127.0.0.1')) return { ok: true }
  if (ipv6Groups(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return isPublicAddress(host) ? { ok: true } : { ok: false, reason: 'That address is not a public one' }
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host)
  } catch {
    return { ok: false, reason: `Couldn't resolve ${host}` }
  }
  if (!addresses.length) return { ok: false, reason: `Couldn't resolve ${host}` }
  if (addresses.some((a) => !isPublicAddress(a.address))) return { ok: false, reason: `${host} resolves to an address that is not public` }
  return { ok: true }
}
