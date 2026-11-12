/**
 * A made-up website for the crawl's tests: a CrawlFetch that answers from a
 * table of URL -> response and records every request, plus a few page
 * builders and a driver for promises that wait on fake timers.
 *
 * Only made-up sites (example.com, example.org): nothing here touches the
 * network.
 */
import { PublicFetchError } from '@/lib/link-preview/safe-fetch'
import { vi } from 'vitest'
import type { CrawlFetch, CrawlFetchOptions, CrawlResponse } from '../fetch'

export interface FakeAnswer {
  status?: number
  headers?: Record<string, string>
  body?: string
  /** Report the body as cut at the cap. */
  truncated?: boolean
  responseTimeMs?: number
}

/** A fixed answer, one that depends on how many times the URL was asked for (1-based), or 'fail' for a network failure. */
export type FakeRoute =
  | FakeAnswer
  | 'fail'
  | ((call: number) => FakeAnswer | 'fail')

export interface FakeRequest {
  url: string
  opts: CrawlFetchOptions
  /** Whether the caller's wantBody let the body be read. */
  bodyRead: boolean
  /** When it was made (Date.now(), fake under fake timers). */
  at: number
}

/** The page fetches of a crawl: not the start-URL probe (it sets its own timeout), not robots.txt or sitemaps (no wantBody). */
export function crawlRequests(requests: FakeRequest[]): FakeRequest[] {
  return requests.filter(
    (r) => r.opts.wantBody && r.opts.timeoutMs === undefined,
  )
}

export const NOT_FOUND: FakeAnswer = {
  status: 404,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: '<!doctype html><title>Not found</title><h1>Not found</h1>',
}

export function fakeSite(
  routes: Record<string, FakeRoute>,
  fallback: FakeRoute = NOT_FOUND,
) {
  const requests: FakeRequest[] = []
  const calls = new Map<string, number>()

  const fetch: CrawlFetch = async (url, opts = {}) => {
    const call = (calls.get(url) ?? 0) + 1
    calls.set(url, call)
    const route = url in routes ? routes[url] : fallback
    const answer = typeof route === 'function' ? route(call) : route
    if (answer === 'fail') {
      requests.push({ url, opts, bodyRead: false, at: Date.now() })
      throw new PublicFetchError('connect ECONNREFUSED')
    }
    const status = answer.status ?? 200
    const headers = Object.fromEntries(
      Object.entries(answer.headers ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    )
    const contentType = (headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const wantBody = opts.wantBody ?? ((s: number) => s < 300 || s >= 400)
    const bodyRead = wantBody(status, contentType)
    requests.push({ url, opts, bodyRead, at: Date.now() })
    const response: CrawlResponse = {
      url,
      status,
      header: (name) => headers[name.toLowerCase()] ?? null,
      contentType,
      body: bodyRead ? (answer.body ?? '') : '',
      truncated: bodyRead ? (answer.truncated ?? false) : false,
      responseTimeMs: answer.responseTimeMs ?? 50,
    }
    return response
  }

  return {
    fetch,
    requests,
    /** How many times a URL was requested. */
    count: (url: string) => requests.filter((r) => r.url === url).length,
    urls: () => requests.map((r) => r.url),
  }
}

export const html = (body: string, extra: FakeAnswer = {}): FakeAnswer => ({
  status: 200,
  ...extra,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    ...extra.headers,
  },
  body,
})

export const redirect = (location: string, status = 301): FakeAnswer => ({
  status,
  headers: { location, 'content-type': 'text/html' },
  body: '<a href="' + location + '">Moved</a>',
})

export const text = (body: string, status = 200): FakeAnswer => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body,
})

export const xml = (body: string): FakeAnswer => ({
  status: 200,
  headers: { 'content-type': 'application/xml' },
  body,
})

export function urlset(urls: string[]): string {
  const entries = urls.map((url) => `<url><loc>${url}</loc></url>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
}

export function sitemapIndex(urls: string[]): string {
  const entries = urls
    .map((url) => `<sitemap><loc>${url}</loc></sitemap>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`
}

const FILLER =
  'Our small made-up studio plans calm and useful websites for teams who would rather spend their week on the work itself than on fixing pages that broke overnight.'

/**
 * A healthy HTML page: a title, a description, one H1, a couple of hundred
 * words (unique per H1) and the given links. Every per-page check passes on
 * it unless an option breaks one.
 */
export function page(opts: {
  title: string
  h1: string
  links?: string[]
  description?: string | null
  robots?: string
  head?: string
  body?: string
}): string {
  const description =
    opts.description === undefined
      ? `${opts.h1}: one page of the made-up Example Studio website, written for the audit tests.`
      : opts.description
  const words = Array.from({ length: 7 }, () => FILLER).join(' ')
  return [
    '<!doctype html><html><head>',
    `<title>${opts.title}</title>`,
    description === null
      ? ''
      : `<meta name="description" content="${description}">`,
    opts.robots ? `<meta name="robots" content="${opts.robots}">` : '',
    opts.head ?? '',
    '</head><body>',
    `<h1>${opts.h1}</h1>`,
    `<p>${opts.h1}. ${words}</p>`,
    opts.body ?? '',
    '<nav>',
    ...(opts.links ?? []).map((href) => `<a href="${href}">Go to ${href}</a>`),
    '</nav></body></html>',
  ].join('')
}

/**
 * Await a promise whose work waits on fake timers: step the clock from one
 * timer to the next (flushing microtasks when none is set) until it settles.
 */
export async function drive<T>(
  promise: Promise<T>,
  maxSteps = 200_000,
): Promise<T> {
  const state: {
    outcome?: { ok: true; value: T } | { ok: false; error: unknown }
  } = {}
  promise.then(
    (value) => {
      state.outcome = { ok: true, value }
    },
    (error: unknown) => {
      state.outcome = { ok: false, error }
    },
  )
  for (let step = 0; !state.outcome; step++) {
    if (step >= maxSteps) throw new Error('drive: the promise never settled')
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
    else await vi.advanceTimersByTimeAsync(0)
  }
  if (!state.outcome.ok) throw state.outcome.error
  return state.outcome.value
}
