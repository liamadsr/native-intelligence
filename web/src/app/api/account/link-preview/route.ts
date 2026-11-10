import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { isPrivateOrLocalIPv4, isPrivateOrLocalIPv6 } from '@/lib/mcp-client/url-guard'

const MAX_REDIRECTS = 5

/**
 * SSRF host guard, run on the SUBMITTED url AND every redirect hop. Reuses the
 * rigorous literal-IP logic from url-guard (covers dotted-quad private ranges,
 * IPv6 ULA/link-local/loopback, and IPv4-mapped IPv6) rather than the looser
 * string-prefix regex a single check would use. Returns true when the host must
 * be refused. Note: this is name/literal-IP filtering, not full DNS-rebinding
 * protection (same caveat as url-guard) — but it now runs on redirect targets,
 * closing the "public URL 302s to 169.254.169.254" hole.
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (
    h === 'localhost' ||
    h === '[::1]' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata.google.internal' ||
    h === 'metadata.azure.com'
  ) {
    return true
  }
  if (isPrivateOrLocalIPv4(h)) return true
  if (isPrivateOrLocalIPv6(h)) return true
  return false
}

/**
 * Fetch `startUrl` following redirects MANUALLY (redirect: 'manual') so the SSRF
 * host guard re-runs on every hop's Location target — an attacker's public URL
 * can 302 to http://169.254.169.254/ and a `redirect: 'follow'` would never
 * re-check it. Returns the final Response and the URL it was fetched from, or
 * null on a blocked host / too many hops / network error (caller falls back to
 * minimal metadata; never throws to the client).
 */
async function safeFetchFollowingRedirects(
  startUrl: string,
  init: RequestInit,
): Promise<{ res: Response; finalUrl: string } | null> {
  let currentUrl = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL
    try {
      parsed = new URL(currentUrl)
    } catch {
      return null
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (isBlockedHost(parsed.hostname)) return null

    const res = await fetch(currentUrl, { ...init, redirect: 'manual' })

    // Non-redirect response — this is the final response.
    if (res.status < 300 || res.status >= 400) {
      return { res, finalUrl: currentUrl }
    }

    // Redirect — resolve Location against the current URL and loop (the guard
    // above re-runs on the next iteration's host).
    const location = res.headers.get('location')
    if (!location) return { res, finalUrl: currentUrl }
    try {
      currentUrl = new URL(location, currentUrl).href
    } catch {
      return null
    }
  }
  // Exceeded the redirect budget.
  return null
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { url } = await request.json()
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 })
  }

  try {
    const parsed = new URL(url)

    // Block non-HTTP protocols
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return NextResponse.json({ error: 'Only HTTP(S) URLs are allowed' }, { status: 400 })
    }

    // Block private/internal IP ranges to prevent SSRF (initial host).
    if (isBlockedHost(parsed.hostname)) {
      return NextResponse.json({ error: 'URL not allowed' }, { status: 400 })
    }

    const domain = parsed.hostname.replace(/^www\./, '')

    // Fetch the page with a short timeout. Redirects are followed MANUALLY so
    // the SSRF host guard re-runs on every hop (a public URL that 302s to an
    // internal address is caught). A blocked hop / too many hops returns null →
    // treat as a failed fetch (minimal-metadata fallback below).
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    let fetched: { res: Response; finalUrl: string } | null
    try {
      fetched = await safeFetchFollowingRedirects(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NativeIntelligenceBot/1.0)',
          Accept: 'text/html',
        },
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!fetched || !fetched.res.ok) {
      return NextResponse.json({
        title: domain,
        description: null,
        image: null,
        favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
        domain,
        url,
      })
    }

    const res = fetched.res

    const html = await res.text()
    // Resolve relative asset URLs against the FINAL (post-redirect) URL.
    const baseUrl = fetched.finalUrl

    // Parse OG and meta tags
    const title =
      extractMeta(html, 'og:title') ||
      extractMeta(html, 'twitter:title') ||
      extractTitle(html) ||
      domain
    const description =
      extractMeta(html, 'og:description') ||
      extractMeta(html, 'twitter:description') ||
      extractMeta(html, 'description')
    const image =
      extractMeta(html, 'og:image') ||
      extractMeta(html, 'twitter:image')

    // Resolve relative image URLs
    const resolvedImage = image
      ? image.startsWith('http')
        ? image
        : new URL(image, baseUrl).href
      : null

    const favicon =
      extractFavicon(html, baseUrl) ||
      `https://www.google.com/s2/favicons?domain=${domain}&sz=32`

    return NextResponse.json({
      title: title.slice(0, 200),
      description: description?.slice(0, 300) || null,
      image: resolvedImage,
      favicon,
      domain,
      url,
    })
  } catch {
    // If fetching fails, return minimal metadata from the URL itself
    try {
      const parsed = new URL(url)
      const domain = parsed.hostname.replace(/^www\./, '')
      return NextResponse.json({
        title: domain,
        description: null,
        image: null,
        favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
        domain,
        url,
      })
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
    }
  }
}

function extractMeta(html: string, name: string): string | null {
  // Match property="name" or name="name"
  const regex = new RegExp(
    `<meta[^>]*(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`,
    'i',
  )
  const match = html.match(regex)
  if (match) return decodeHTMLEntities(match[1])

  // Try reversed order: content before property
  const regex2 = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  )
  const match2 = html.match(regex2)
  return match2 ? decodeHTMLEntities(match2[1]) : null
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return match ? decodeHTMLEntities(match[1].trim()) : null
}

function extractFavicon(html: string, baseUrl: string): string | null {
  const match = html.match(
    /<link[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']*)["']/i,
  )
  if (!match) return null
  const href = match[1]
  if (href.startsWith('http')) return href
  if (href.startsWith('//')) return `https:${href}`
  try {
    return new URL(href, baseUrl).href
  } catch {
    return null
  }
}

function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
}
