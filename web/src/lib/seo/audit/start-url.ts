/**
 * Which URLs the audit may fetch, and where an audit really starts.
 *
 * The address checks are the link preview's (checkPublicUrl: http/https,
 * no credentials, no private or internal host); the DNS side is held at the
 * dial by crawlFetch. This module adds the crawl's own rules on top.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { checkPublicUrl, PublicFetchError } from '@/lib/link-preview/safe-fetch'
import 'server-only'
import { crawlFetch, type CrawlFetch } from './fetch'
import { MAX_URL_CHARS } from './limits'

/** Why a site can't be audited, in words for the person who asked. */
export class StartUrlError extends Error {
  constructor(
    readonly code: 'INVALID_URL' | 'NOT_PUBLIC',
    message: string,
  ) {
    super(message)
    this.name = 'StartUrlError'
  }
}

/**
 * Whether a URL found mid-crawl (a link, a redirect target, a sitemap entry)
 * may be fetched at all: http(s), a public-looking host, the scheme's own
 * port (a website, not some other service on the same machine), a sane
 * length.
 */
export function isCrawlableUrl(url: string): boolean {
  if (url.length > MAX_URL_CHARS) return false
  try {
    // The URL parser drops a default port (https 443, http 80): any port left is another one.
    return checkPublicUrl(url).port === ''
  } catch {
    return false
  }
}

/**
 * The address a person typed ("example.com", "https://example.com/blog"), as
 * a URL the audit can start from. Throws a StartUrlError saying why not.
 */
export function normalizeStartUrl(input: string): string {
  let raw = input.trim()
  if (!raw)
    throw new StartUrlError('INVALID_URL', 'That isn’t a website address.')
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  // Checked again on the address as it will be stored: parsing can lengthen it.
  if (raw.length > MAX_URL_CHARS)
    throw new StartUrlError('INVALID_URL', 'That address is too long.')

  let parsed: URL
  try {
    parsed = checkPublicUrl(raw)
  } catch (err) {
    const reason = err instanceof PublicFetchError ? err.reason : 'not a URL'
    if (
      reason === 'not a URL' ||
      reason === 'only http and https' ||
      reason === 'no host'
    ) {
      throw new StartUrlError('INVALID_URL', 'That isn’t a website address.')
    }
    if (reason === 'credentials in the URL') {
      throw new StartUrlError(
        'INVALID_URL',
        'Leave the user name and password out of the address.',
      )
    }
    throw new StartUrlError(
      'NOT_PUBLIC',
      'Only public websites can be audited.',
    )
  }
  // A bare word ("localhost" is refused above; "intranet" has no dot) is not a public site.
  if (!parsed.hostname.includes('.'))
    throw new StartUrlError('INVALID_URL', 'That isn’t a website address.')
  // The parser drops a default port: any port left is another service, not the website.
  if (parsed.port !== '')
    throw new StartUrlError(
      'INVALID_URL',
      'Leave the port number out: an audit reads a site on its standard address only.',
    )
  parsed.hash = ''
  const normalized = parsed.toString()
  if (normalized.length > MAX_URL_CHARS)
    throw new StartUrlError('INVALID_URL', 'That address is too long.')
  return normalized
}

const START_URL_REDIRECT_HOPS = 5
const START_URL_PROBE_TIMEOUT_MS = 10_000

/**
 * Follow redirects on the audit's start URL so the audit anchors to the
 * site's real origin. Without this, auditing a domain that 301s elsewhere
 * (apex to www, .net to .com) dead-ends after one page: the redirect target
 * is a different origin, so the same-origin crawl can't follow it.
 *
 * Every hop is checked like a start URL, so a redirect can't take the audit
 * somewhere the person couldn't have pointed it directly. A probe that fails
 * (a timeout, a refusal) falls back to the last good URL: the crawl records
 * what really happens there.
 */
export async function resolveStartUrlRedirects(
  startUrl: string,
  fetchPage: CrawlFetch = crawlFetch,
): Promise<string> {
  let current = startUrl
  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: Awaited<ReturnType<CrawlFetch>>
    try {
      response = await fetchPage(current, {
        timeoutMs: START_URL_PROBE_TIMEOUT_MS,
        wantBody: () => false,
      })
    } catch {
      return current
    }
    if (response.status < 300 || response.status >= 400) return current
    const location = response.header('location')
    if (!location) return current
    let next: string
    try {
      next = normalizeStartUrl(new URL(location, current).toString())
    } catch {
      return current
    }
    current = next
  }
  return current
}
