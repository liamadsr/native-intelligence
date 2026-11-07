/**
 * The address customers really use (roadmap track E, step 2 "Inspect").
 *
 * A repo often names only the host's own address (its GitHub homepage is
 * x.vercel.app) while customers reach the site at the business's domain. The
 * form's intake key lets browsers post only from the site's origins, so the
 * wrong address would refuse every real customer while the live check (which
 * reads the host's address) passed.
 *
 * From a host's own address: where it redirects, when that is a domain of
 * the business's own (the host only redirects a project to its own domains);
 * else the page's canonical address (or og:url), when it is on a domain of the
 * business's own, answers, and is the same site: the same title AND an asset
 * only that build has (never a framework's file every site on its version
 * shares). A template's leftover canonical (its vendor's site, example.com,
 * yourdomain.com, the last client's site a designer copied it from) is never
 * followed. The other addresses the site answers at are kept so their origins
 * may post too. A domain of the business's own, or an address the owner said,
 * is never swapped.
 */
import { fetchPublic, publicHttpsUrl, type SiteFetchResult } from './fetch'
import { platformHostOf, siteUrlOf } from './inspect'

const PAGE_MAX_BYTES = 3_000_000

/** A placeholder address a template ships with. */
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|(your|my)-?(domain|site|website|company|business|url)\.[a-z]{2,}|(domain|website|site|company|sample|placeholder)\.(com|net|org|io|co)|localhost|test|invalid)$/i

/** The page's canonical address (<link rel="canonical">, else og:url), as an https URL, or null. Pure. */
export function canonicalOf(html: string, pageUrl: string): string | null {
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']{1,300})["']`, 'i'))?.[1] ?? null
  let named: string | null = null
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/\brel\s*=\s*["']?canonical\b/i.test(m[0]) && (named = attr(m[0], 'href'))) break
  }
  if (!named) {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (/\b(property|name)\s*=\s*["']og:url["']/i.test(m[0]) && (named = attr(m[0], 'content'))) break
    }
  }
  const url = named ? publicHttpsUrl(named, pageUrl) : null
  return url && !PLACEHOLDER_HOST.test(url.hostname) ? url.toString() : null
}

function titleOf(html: string): string | null {
  const t = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim()
  return t || null
}

/** A framework's own file, the same on every site that uses its version (Next's polyfills, framework and main chunks, shared numbered chunks). */
const FRAMEWORK_COMMON = /^(\d|polyfills|framework|main|main-app|webpack|vendors?|react|runtime|chunk-vendors|commons)([-.~_]|$)/i

/** The paths of a page's assets only its build has: a hashed file of its own code, or its build id's manifest. */
function buildAssets(html: string): Set<string> {
  const out = new Set<string>()
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']{1,300})["']/gi)) {
    const path = m[1].replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0]
    const file = path.split('/').pop() ?? ''
    if (/\/_next\/static\/[\w-]{8,}\/_(build|ssg)Manifest\.js$/.test(path)) out.add(path)
    else if (/[-.][0-9a-zA-Z_]{8,}\.(js|css)$/.test(file) && /[0-9]/.test(file) && !FRAMEWORK_COMMON.test(file)) out.add(path)
  }
  return out
}

/** Whether two pages are the same site: the same title AND an asset only that build has. Pure. */
export function samePage(a: string, b: string): boolean {
  const ta = titleOf(a)
  if (!ta || ta !== titleOf(b)) return false
  const assets = buildAssets(b)
  for (const path of buildAssets(a)) if (assets.has(path)) return true
  return false
}

const sameHost = (a: string, b: string) => new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '')

/**
 * The live address customers use, from a candidate (see the header), and the
 * other addresses the same site answers at. The candidate unchanged when it
 * can't be read, and when `stated` (the owner said it): only its redirect's
 * origin is added.
 */
export async function liveAddress(candidate: string, deps: { fetchImpl?: typeof fetch; stated?: boolean } = {}): Promise<{ siteUrl: string; alsoUrls: string[] }> {
  const read = (url: string): Promise<SiteFetchResult | null> => fetchPublic(url, { fetchImpl: deps.fetchImpl, maxBytes: PAGE_MAX_BYTES }).catch(() => null)
  // The other origins it answers at, never the address's own.
  const answer = (siteUrl: string, urls: readonly string[]) => ({ siteUrl, alsoUrls: [...new Set(urls.map((u) => new URL(u).origin))].filter((o) => o !== new URL(siteUrl).origin) })
  const page = await read(candidate)
  if (!page || page.status >= 400) return answer(candidate, [])
  // A domain of the business's own is what customers use, and an address the owner said is theirs: never swapped.
  if (deps.stated || platformHostOf(candidate) === null) return answer(candidate, [page.url])
  // The host's address redirects to the business's domain: the host only does that for the project's own domains.
  if (platformHostOf(page.url) === null) return answer(siteUrlOf(page.url) ?? candidate, [candidate, page.url])
  const named = page.text ? canonicalOf(page.text, page.url) : null
  if (!named || platformHostOf(named) !== null || sameHost(named, page.url)) return answer(candidate, [page.url])
  const there = await read(named)
  if (!there?.text || there.status >= 400 || !page.text || !samePage(page.text, there.text)) return answer(candidate, [page.url])
  return answer(siteUrlOf(named) ?? candidate, [candidate, page.url, there.url])
}
