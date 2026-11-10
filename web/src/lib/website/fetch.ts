/**
 * Reading a business's live site from the server (roadmap track E): the
 * wiring's origin lookup and the live check. Only https, only public host
 * names (no IP literals, no localhost or internal names), redirects followed
 * by hand at most a few hops under the same rules, a time limit and a size
 * cap. The site's address comes from its repo, which anyone with push access
 * writes, so none of this trusts it.
 */

import { appUrl } from '@/lib/app-url'
const MAX_REDIRECTS = 4
const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|metadata\.google\.internal)$/i

/** An https URL on a public host name, or null. Pure. */
export function publicHttpsUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password) return null
    if (!host.includes('.') || BLOCKED_HOST.test(host) || /^[\d.]+$/.test(host) || host.startsWith('[') || host.includes(':')) return null
    return url
  } catch {
    return null
  }
}

export interface SiteFetchResult {
  /** Where the redirects ended. */
  url: string
  status: number
  text: string | null
}

/** GET a public https page (see the header); null when it can't be read. */
export async function fetchPublic(url: string, opts: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {}): Promise<SiteFetchResult | null> {
  let current = publicHttpsUrl(url)
  for (let hop = 0; current && hop <= MAX_REDIRECTS; hop++) {
    let res: Response
    try {
      res = await (opts.fetchImpl ?? fetch)(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        headers: { 'User-Agent': `Native Intelligence website check (+${appUrl()})` },
      })
    } catch {
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      current = location ? publicHttpsUrl(location, current.toString()) : null
      continue
    }
    if (!res.ok) return { url: current.toString(), status: res.status, text: null }
    const max = opts.maxBytes ?? 2_000_000
    const length = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(length) && length > max) return { url: current.toString(), status: res.status, text: null }
    const text = await res.text().catch(() => null)
    return { url: current.toString(), status: res.status, text: text !== null && text.length <= max ? text : null }
  }
  return null
}
