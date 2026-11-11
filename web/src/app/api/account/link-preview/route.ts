import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { checkPublicUrl, fetchPublicPage, PublicFetchError } from '@/lib/link-preview/safe-fetch'
import { decodeHtml, extractFavicon, readPagePreview } from '@/lib/link-preview/parse'

/**
 * POST /api/account/link-preview { url } → the page's title, description,
 * image and favicon, for the editor's link card. The page is fetched by the
 * shared SSRF-safe fetcher (src/lib/link-preview/safe-fetch.ts: public
 * addresses only, checked at the dial and on every redirect, a short timeout
 * and a size cap); a page it refuses or can't read gets minimal metadata from
 * the URL itself.
 */
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

  let parsed: URL
  try {
    parsed = checkPublicUrl(url)
  } catch (err) {
    if (err instanceof PublicFetchError && err.reason === 'only http and https') {
      return NextResponse.json({ error: 'Only HTTP(S) URLs are allowed' }, { status: 400 })
    }
    if (err instanceof PublicFetchError && err.reason !== 'not a URL') {
      return NextResponse.json({ error: 'URL not allowed' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  const domain = parsed.hostname.replace(/^www\./, '')
  const minimal = {
    title: domain,
    description: null,
    image: null,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    domain,
    url,
  }

  try {
    const page = await fetchPublicPage(url)
    if (page.status < 200 || page.status >= 300) return NextResponse.json(minimal)
    const html = decodeHtml(page.body, page.charset)
    // Relative asset URLs resolve against the FINAL (post-redirect) URL.
    const preview = readPagePreview(html, page.url)
    return NextResponse.json({
      title: preview.title ?? domain,
      description: preview.description,
      image: preview.image,
      favicon: extractFavicon(html, page.url) || minimal.favicon,
      domain,
      url,
    })
  } catch {
    // Refused, timed out or failed: minimal metadata from the URL itself.
    return NextResponse.json(minimal)
  }
}
