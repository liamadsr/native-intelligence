/**
 * SSRF guard for the chat-agent's web_fetch tool.
 *
 * WHY A MIRROR (not an import of src/lib/mcp-client/url-guard.ts): the eve
 * compile bundles ONLY this agent's own tree (agents/chat-agent/*), so a tool
 * cannot import from src/ — the same mirror-not-import constraint the
 * onboarding-researcher's home-brief-writer.ts documents. This is the deliberate
 * agent-side twin of that guard; keep the predicates in sync with the app copy.
 *
 * This agent's web_fetch lets the model open ARBITRARY user-influenced URLs
 * (a link the user pasted, a page the model chose to read). Without a guard an
 * authenticated user could steer a fetch at internal infrastructure (AWS IMDS at
 * 169.254.169.254, private-range services on the serverless network) and use
 * Native Intelligence as an SSRF reflection point. Every web_fetch URL routes through
 * ensureSafeWebUrl before the underlying fetch runs.
 *
 * Rules (identical to the app's url-guard):
 *   - https only (http allowed for localhost in dev)
 *   - reject literal private / loopback / link-local / carrier-NAT IPs (v4 + v6)
 *   - reject cloud-metadata hostnames by name (belt-and-braces for IP typos)
 *
 * This is name/literal-IP filtering, NOT full DNS-rebinding protection (the eve
 * web_fetch tool doesn't expose a custom resolver to pin the resolved IP) — one
 * layer of defence, matching what the app copy provides for the MCP client.
 */

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
])

export function isPrivateOrLocalIPv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * An IPv6 literal as its eight 16-bit groups, or null when it isn't one. A
 * trailing dotted quad (`::ffff:127.0.0.1`) becomes its two groups, so the
 * hex form the URL parser normalises it to (`::ffff:7f00:1`) reads the same.
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
  // 64:ff9b::/96 (NAT64): it reaches an IPv4 address through a translator; refused outright.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return true
  if ((g[0] & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true // multicast ff00::/8
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

/** Validate that `raw` is safe to fetch. Caller surfaces `reason` on rejection. */
export function assertSafeWebUrl(raw: string): UrlGuardResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }

  const allowLocalhost = process.env.NODE_ENV !== 'production'
  if (
    url.protocol !== 'https:' &&
    !(allowLocalhost && url.protocol === 'http:' && url.hostname === 'localhost')
  ) {
    return { ok: false, reason: 'Only HTTPS URLs are allowed' }
  }

  // A trailing dot is the same host (`localhost.`, `metadata.google.internal.`).
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')

  if (BLOCKED_HOSTNAMES.has(hostname)) {
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
export function ensureSafeWebUrl(raw: string): URL {
  const result = assertSafeWebUrl(raw)
  if (!result.ok) throw new Error(`Refused to fetch ${raw}: ${result.reason}`)
  return result.url
}
