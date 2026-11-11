/**
 * What a page says about itself, read from its HTML: its title, description,
 * image and favicon (Open Graph and Twitter tags, then the plain ones). Pure:
 * the editor's link card (/api/account/link-preview) and team chat's
 * previews (src/lib/team-chat/link-preview.ts) read pages fetched by
 * ./safe-fetch.ts with it.
 */

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A page's HTML entities decoded (the few a meta tag uses). */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d{1,6});/g, (m, n: string) => {
      const code = Number(n)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    })
}

/** A `<meta property|name="…" content="…">` tag's content, either way round. */
export function extractMeta(html: string, name: string): string | null {
  const key = escapeForRegExp(name)
  const forward = new RegExp(`<meta[^>]*(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)
  if (forward) return decodeHtmlEntities(forward[1])
  const reversed = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i').exec(html)
  return reversed ? decodeHtmlEntities(reversed[1]) : null
}

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  return match ? decodeHtmlEntities(match[1].trim()) : null
}

export function extractFavicon(html: string, baseUrl: string): string | null {
  const match = /<link[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']*)["']/i.exec(html)
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

/** A page's bytes as text, in the charset it named (UTF-8 when it named none or one this can't read). */
export function decodeHtml(body: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

function clean(text: string | null | undefined, max: number): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export interface PagePreview {
  title: string | null
  description: string | null
  /** The page's own image, as an absolute URL (any scheme the page gave: the caller decides what it shows). */
  image: string | null
  /** The site's name (og:site_name), if it gave one. */
  siteName: string | null
}

/** A page's title (≤ 200), description (≤ 300), image and site name, from its HTML. */
export function readPagePreview(html: string, baseUrl: string): PagePreview {
  const image = extractMeta(html, 'og:image') || extractMeta(html, 'og:image:url') || extractMeta(html, 'twitter:image')
  let absolute: string | null = null
  if (image) {
    try {
      absolute = new URL(image, baseUrl).href
    } catch {
      absolute = null
    }
  }
  return {
    title: clean(extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title') || extractTitle(html), 200),
    description: clean(extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description') || extractMeta(html, 'description'), 300),
    image: absolute,
    siteName: clean(extractMeta(html, 'og:site_name'), 80),
  }
}
