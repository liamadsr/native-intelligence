import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { fetchPublicPage, PublicFetchError, type PublicPage, type Send } from '@/lib/link-preview/safe-fetch'
import { probeWatchPage } from '../probe'
import { NOT_A_USUAL_PORT, PAGE_WATCH_FETCH_MAX_BYTES, PAGE_WATCH_FETCH_TIMEOUT_MS, readWatchPage, usualPortsOnly } from '../read-page'

const page = (body: string, over: Partial<PublicPage> = {}): PublicPage => ({
  url: 'https://example.com/',
  status: 200,
  contentType: 'text/html',
  charset: 'utf-8',
  body: new TextEncoder().encode(body),
  truncated: false,
  ...over,
})
const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `<p>Line ${i}</p>`).join('')

describe('probeWatchPage', () => {
  it('a page with text can be watched, and says how many lines it has', async () => {
    const fetchPage = vi.fn(async () => page(paragraphs(12)))
    expect(await probeWatchPage('example.com', { fetchPage })).toEqual({ ok: true, lineCount: 12 })
    expect(fetchPage).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({ timeoutMs: PAGE_WATCH_FETCH_TIMEOUT_MS, maxBytes: PAGE_WATCH_FETCH_MAX_BYTES }))
  })

  it('a shell a browser fills in is refused with the agreed words', async () => {
    const shell = '<html><head><script src="/app.js"></script></head><body><div id="root"></div><noscript>Enable JavaScript</noscript></body></html>'
    expect(await probeWatchPage('https://example.com/app', { fetchPage: async () => page(shell) })).toEqual({
      ok: false,
      reason: 'This page shows its content only in a browser, so it cannot be watched yet.',
    })
  })

  it('a refused address is never fetched', async () => {
    const fetchPage = vi.fn()
    const out = await probeWatchPage('http://192.168.0.10/', { fetchPage })
    expect(out.ok).toBe(false)
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it.each([
    [new PublicFetchError('timed out'), 'The page took too long to answer.'],
    [new PublicFetchError('resolves to an address that is not public'), 'That address is on a private network. Only public pages can be watched.'],
    [new PublicFetchError('too many redirects'), 'The page sends visitors on to too many other addresses.'],
    [new PublicFetchError(NOT_A_USUAL_PORT), "The page sends visitors on to an address with a port. Only pages on a website's usual address can be watched."],
    [new PublicFetchError('getaddrinfo ENOTFOUND example.invalid'), 'No website answers at that address.'],
    [new Error('something odd'), 'The page could not be read.'],
  ])('a failed fetch says why in plain words (%s)', async (err, reason) => {
    expect(await probeWatchPage('https://example.com/', { fetchPage: async () => Promise.reject(err) })).toEqual({ ok: false, reason })
  })

  it.each([
    [404, /no page at that address \(it answered 404\)/],
    [410, /not there any more \(it answered 410\)/],
    [403, /needs a sign-in/],
    [503, /had a problem answering/],
    [429, /slow down/],
  ])('a %i answer says what it means', async (status, reason) => {
    const out = await probeWatchPage('https://example.com/', { fetchPage: async () => page(paragraphs(10), { status }) })
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toMatch(reason)
  })

  it('a file is not a page', async () => {
    expect(await probeWatchPage('https://example.com/a.pdf', { fetchPage: async () => page('%PDF', { contentType: 'application/pdf' }) })).toEqual({
      ok: false,
      reason: 'That address is a file, not a page of text.',
    })
  })
})

describe('readWatchPage', () => {
  it('reads JSON and plain text as lines', async () => {
    const json = await readWatchPage('https://example.com/api', { fetchPage: async () => page('{"a":1,"b":[1,2]}', { contentType: 'application/json' }) })
    expect(json.ok && json.lines.length).toBeGreaterThan(2)
    const text = await readWatchPage('https://example.com/t.txt', { fetchPage: async () => page('one\ntwo', { contentType: 'text/plain' }) })
    expect(text).toEqual({ ok: true, lines: ['one', 'two'] })
  })

  it('decodes the charset the page named', async () => {
    const latin1 = new Uint8Array([0x3c, 0x70, 0x3e, 0x43, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])
    const out = await readWatchPage('https://example.com/', { fetchPage: async () => ({ ...page(''), body: latin1, charset: 'iso-8859-1' }) })
    expect(out).toEqual({ ok: true, lines: ['Café'] })
  })
})

describe('truncated bodies', () => {
  it('a page cut at the size cap drops its last, half-read line', async () => {
    const out = await readWatchPage('https://example.com/', { fetchPage: async () => page('<p>One</p><p>Two</p><p>Thr', { truncated: true }) })
    expect(out).toEqual({ ok: true, lines: ['One', 'Two'] })
  })

  it('data cut off part way has its own reason, not "only in a browser"', async () => {
    const out = await probeWatchPage('https://example.com/api', { fetchPage: async () => page('{"items":[1,2,', { contentType: 'application/json', truncated: true }) })
    expect(out).toEqual({ ok: false, reason: 'The page is data too large to read in full, so it cannot be watched.' })
  })
})

describe('usualPortsOnly', () => {
  /** A fake request answering with `status` and `location`, through the fetcher's own `send` hook. */
  const answering = (answers: Record<string, { status: number; location?: string; body?: string }>) => {
    const seen: string[] = []
    const send: Send = (url, _options, onResponse) => {
      seen.push(url)
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
      request.end = () => {
        setImmediate(() => {
          const a = answers[url] ?? { status: 404 }
          const res = Readable.from(a.body ? [Buffer.from(a.body)] : []) as Readable & { statusCode: number; headers: Record<string, string> }
          res.statusCode = a.status
          res.headers = { 'content-type': 'text/html', ...(a.location ? { location: a.location } : {}) }
          onResponse(res as never)
        })
      }
      request.destroy = () => {}
      return request as unknown as ClientRequest
    }
    return { send, seen }
  }

  it('lets a usual address through', async () => {
    const { send, seen } = answering({ 'https://example.com/': { status: 200, body: '<p>hi</p>' } })
    const guarded = usualPortsOnly(send)
    const res = await fetchPublicPage('https://example.com/', { send: { 'http:': guarded, 'https:': guarded } })
    expect(res.status).toBe(200)
    expect(seen).toEqual(['https://example.com/'])
  })

  it('refuses a redirect to another port without sending it', async () => {
    const { send, seen } = answering({ 'https://example.com/': { status: 302, location: 'http://example.com:6379/' } })
    const guarded = usualPortsOnly(send)
    await expect(fetchPublicPage('https://example.com/', { send: { 'http:': guarded, 'https:': guarded } })).rejects.toMatchObject({ reason: NOT_A_USUAL_PORT })
    expect(seen).toEqual(['https://example.com/'])
  })
})
