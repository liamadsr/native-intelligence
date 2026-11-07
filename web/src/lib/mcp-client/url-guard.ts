/**
 * SSRF guard for outbound MCP-related URLs.
 *
 * Any URL we open a connection to — initial probe, OAuth discovery,
 * dynamic-client-registration, token endpoint, tools/call — needs to
 * be validated, otherwise an authenticated user can point us at
 * internal infrastructure (AWS IMDS, internal services on the
 * serverless network) and use Dial8 as a reflection point.
 *
 * Two distinct surfaces:
 *
 *   1. User-supplied: the `server_url` field on the add-server form.
 *      Validated before we touch it.
 *
 *   2. Server-supplied: the `resource_metadata` URL extracted from a
 *      remote 401's WWW-Authenticate header, and the authorization_server
 *      issuer URL discovered through it. Even an otherwise-legitimate
 *      HTTPS server can serve a crafted 401 pointing inward, so these
 *      are validated too.
 *
 * Rules:
 *   - https only (no http, no file, no data, no javascript)
 *   - Reject hosts that look like a literal private/loopback/link-local
 *     IP. DNS rebinding is a real attack vector against the
 *     "resolve at validate time, fetch a moment later" pattern; we
 *     additionally pin the resolved IP at request time below.
 *   - Reject obvious cloud-metadata addresses by name as belt-and-braces
 *     for typos in the IP regex.
 *
 * What this does NOT do: full DNS rebinding protection (resolve once,
 * pin the IP, dial that specific IP with Host header). The MCP SDK we
 * use doesn't expose a custom DNS resolver, so we get one layer of
 * defence — name/literal-IP filtering. The right long-term answer is a
 * dedicated egress proxy.
 */

const BLOCKED_HOSTNAMES = new Set([
  // AWS / GCP / Azure / OCI / etc. instance-metadata services
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
  // Loopback names
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
])

export function isPrivateOrLocalIPv4(hostname: string): boolean {
  // IPv4 dotted-quad?
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) {
    // Not a real IPv4 — let it through; the fetch will fail naturally.
    return false
  }
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 127.0.0.0/8 loopback
  if (a === 127) return true
  // 0.0.0.0/8 "current network"
  if (a === 0) return true
  // 169.254.0.0/16 link-local (includes AWS IMDS at 169.254.169.254)
  if (a === 169 && b === 254) return true
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true
  // The other RFC 6890 special-use blocks: 192.0.0.0/24 (IETF), 192.0.2.0/24,
  // 198.51.100.0/24 and 203.0.113.0/24 (documentation), 198.18.0.0/15
  // (benchmarking), 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved, broadcast).
  if (a === 192 && b === 0 && (Number(m[3]) === 0 || Number(m[3]) === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && Number(m[3]) === 100) return true
  if (a === 203 && b === 0 && Number(m[3]) === 113) return true
  if (a >= 224) return true
  return false
}

/**
 * An IPv6 literal as its eight 16-bit groups, or null when it isn't one. A
 * trailing dotted quad (`::ffff:127.0.0.1`) becomes its two groups, so the
 * hex form a URL parser normalises it to (`::ffff:7f00:1`) reads the same.
 */
export function ipv6Groups(literal: string): number[] | null {
  let h = literal.replace(/^\[|\]$/g, '').toLowerCase()
  const zone = h.indexOf('%')
  if (zone !== -1) h = h.slice(0, zone)
  if (!h.includes(':')) return null
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (quad) {
    const n = quad.slice(1).map(Number)
    if (n.some((x) => x > 255)) return null
    h = h.slice(0, quad.index) + `${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part ? part.split(':') : [])
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

export function isPrivateOrLocalIPv6(hostname: string): boolean {
  const g = ipv6Groups(hostname)
  if (!g) return false
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  // ::/96 (unspecified, loopback, the deprecated IPv4-compatible form): never a public host.
  if (zeros(0, 6)) return true
  // ::ffff:0:0/96, IPv4-mapped: the v4 rules on the embedded address, whatever form it was written in.
  if (zeros(0, 5) && g[5] === 0xffff) {
    return isPrivateOrLocalIPv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`)
  }
  // Only global unicast (2000::/3) is a public host. Everything else is
  // special-use: NAT64 (64:ff9b::/96 and the local 64:ff9b:1::/48, which reach
  // IPv4 through a translator), ULA fc00::/7, link-local fe80::/10, the old
  // site-local fec0::/10, multicast ff00::/8, discard 100::/64, and the rest.
  if ((g[0] & 0xe000) !== 0x2000) return true
  // Inside it, the ranges that tunnel to IPv4 or aren't routed: Teredo
  // 2001::/32, documentation 2001:db8::/32, 6to4 2002::/16.
  if (g[0] === 0x2001 && (g[1] === 0x0000 || g[1] === 0x0db8)) return true
  if (g[0] === 0x2002) return true
  return false
}

/** True when an address (as a resolver returns it) is a public one: what a dial may reach. */
export function isPublicAddress(address: string): boolean {
  if (ipv6Groups(address)) return !isPrivateOrLocalIPv6(address)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return !isPrivateOrLocalIPv4(address)
  return false
}

export interface UrlGuardOk {
  ok: true
  url: URL
}
export interface UrlGuardFail {
  ok: false
  reason: string
}
export type UrlGuardResult = UrlGuardOk | UrlGuardFail

/**
 * Validate that `raw` is safe to open a connection to as part of any MCP
 * outbound flow. Caller surfaces `reason` verbatim to the user when the
 * URL is rejected — keep it self-explanatory.
 */
export function assertSafeMcpUrl(raw: string): UrlGuardResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }

  // Allow localhost only in development for testing against a local
  // MCP server; production must always be https.
  const allowLocalhost = process.env.NODE_ENV !== 'production'
  if (url.protocol !== 'https:' && !(allowLocalhost && url.protocol === 'http:' && url.hostname === 'localhost')) {
    return { ok: false, reason: 'Only HTTPS URLs are allowed' }
  }

  // A trailing dot is the same host (`localhost.`, `metadata.google.internal.`).
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    // localhost in dev is allowed above via the protocol carve-out;
    // here we still reject the cloud-metadata names regardless.
    if (!(allowLocalhost && hostname === 'localhost')) {
      return { ok: false, reason: `Hostname "${hostname}" is not allowed` }
    }
  }
  if (isPrivateOrLocalIPv4(hostname)) {
    if (!(allowLocalhost && hostname === '127.0.0.1')) {
      return { ok: false, reason: 'Private / loopback IPv4 addresses are not allowed' }
    }
  }
  if (isPrivateOrLocalIPv6(hostname)) {
    return { ok: false, reason: 'Private / loopback IPv6 addresses are not allowed' }
  }

  return { ok: true, url }
}

/** Throwing variant for call sites already inside a try/catch. */
export function ensureSafeMcpUrl(raw: string): URL {
  const result = assertSafeMcpUrl(raw)
  if (!result.ok) throw new Error(`Refused to fetch ${raw}: ${result.reason}`)
  return result.url
}
