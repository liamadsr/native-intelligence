/**
 * Shared URL-safety guard for flow http_post actions.
 *
 * One predicate, used in two places that MUST agree:
 *   - validateHttpPostConfig (queries.ts) — gates what a user can save as a
 *     complete/enabled action.
 *   - isActionRunnable (runner.ts) — gates what actually fires at runtime.
 *
 * Keeping them in sync matters for SSRF: an action that saved as an incomplete
 * "draft" (its config was kept verbatim, unvalidated) must NOT be allowed to
 * fire to a private/internal host just because the string happens to parse as
 * a URL. The runner re-checks this predicate before every call.
 */

import { isPrivateOrLocalIPv4, isPrivateOrLocalIPv6 } from '@/lib/mcp-client/url-guard'

/** Loopback and cloud-metadata names, refused whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.azure.com',
])

/**
 * True iff `url` is a non-empty, http(s) URL that does NOT target a private /
 * loopback / link-local host. Soft SSRF guard — a determined user can still
 * point at a public tunnel, but a hostile flow can't scan the platform's
 * internal network from inside the function runtime. The address ranges are
 * the MCP client's (src/lib/mcp-client/url-guard.ts): every IPv4 private,
 * loopback, link-local and CGNAT range, and every IPv6 form of them (an
 * IPv4-mapped `[::ffff:127.0.0.1]` reads as its IPv4 address).
 */
export function isPublicHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  // URL() keeps IPv6 literals bracketed (e.g. "[::1]"); strip the brackets. A
  // trailing dot is the same host (`localhost.`), so drop it too.
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isPrivateOrLocalIPv4(hostname) ||
    isPrivateOrLocalIPv6(hostname)
  ) {
    return false
  }
  return true
}
