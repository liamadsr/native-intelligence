/**
 * The crawl's one-hop fetch (../fetch.ts) is a server-side request forgery
 * surface: the site's own pages and sitemaps choose the URLs. Only http and
 * https; never a private, loopback, link-local or metadata address, by
 * literal or by what a name resolves to (checked at the dial); a redirect
 * comes back as the 3xx it is; a body nobody reads is never downloaded; a
 * size cap after decompression; a timeout; nothing of ours sent; our user
 * agent always.
 *
 * The request is a fake that dials as a socket would (it asks the lookup it
 * was given, then answers from a table), and DNS is a table too, as in the
 * link preview's tests (src/lib/link-preview/__tests__/safe-fetch.test.ts):
 * nothing here touches the network.
 */
import { PublicFetchError, type Send } from '@/lib/link-preview/safe-fetch'
import { publicOnlyLookup } from '@/lib/mcp/client-metadata-fetch'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { Readable } from 'node:stream'
import { deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crawlFetch, type CrawlFetchOptions } from '../fetch'
import { CRAWL_USER_AGENT } from '../limits'

/** What each name resolves to. */
const DNS: Record<string, string[]> = {
  'example.com': ['93.184.216.34'],
  'www.example.org': ['2606:4700::6810:84e5'],
  'intranet.example.com': ['10.0.0.5'],
  'metadata.example.com': ['169.254.169.254'],
  'mixed.example.org': ['93.184.216.34', '127.0.0.1'],
}
const resolve = (
  host: string,
  _opts: unknown,
  cb: (
    err: NodeJS.ErrnoException | null,
    addresses: Array<{ address: string; family: number }>,
  ) => void,
) => {
  const found = DNS[host]
  if (!found)
    return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), [])
  cb(
    null,
    found.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  )
}
const lookup = publicOnlyLookup(resolve as never)

interface Answer {
  status?: number
  headers?: Record<string, string | string[]>
  /** The body, or a stream of it. */
  body?: string | Buffer | (() => Readable)
}

/** A request that dials as a socket would: a name goes through the lookup it was given; a literal IP is dialled as is. */
function fakeNet(answers: Record<string, Answer>) {
  const dialled: Array<{
    url: string
    address: string
    headers: Record<string, unknown>
  }> = []
  const responses: IncomingMessage[] = []
  const send: Send = (url, options: RequestOptions, onResponse) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void
      destroy: () => void
      destroyed: boolean
    }
    req.destroyed = false
    req.destroy = () => {
      req.destroyed = true
    }
    req.end = () => {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
      const answer = (address: string) => {
        dialled.push({
          url,
          address,
          headers: { ...(options.headers as Record<string, unknown>) },
        })
        const a = answers[url]
        if (!a)
          return req.emit(
            'error',
            Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            }),
          )
        const bytes = typeof a.body === 'string' ? Buffer.from(a.body) : a.body
        const stream =
          typeof bytes === 'function'
            ? bytes()
            : Readable.from(bytes === undefined ? [] : [bytes])
        const res = stream as unknown as IncomingMessage
        res.statusCode = a.status ?? 200
        res.headers = Object.fromEntries(
          Object.entries(
            a.headers ?? { 'content-type': 'text/html; charset=utf-8' },
          ).map(([k, v]) => [k.toLowerCase(), v]),
        )
        responses.push(res)
        onResponse(res)
      }
      if (/^[\d.]+$/.test(host) || host.includes(':'))
        return queueMicrotask(() => answer(host))
      ;(
        options.lookup as (
          h: string,
          o: object,
          cb: (err: NodeJS.ErrnoException | null, address: string) => void,
        ) => void
      )(host, {}, (err, address) => {
        if (err) return req.emit('error', err)
        answer(address)
      })
    }
    return req as never
  }
  return { send: { 'http:': send, 'https:': send }, dialled, responses }
}

function get(
  url: string,
  net: ReturnType<typeof fakeNet>,
  opts: CrawlFetchOptions = {},
) {
  return crawlFetch(url, { send: net.send, lookup, ...opts })
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(PublicFetchError)
    return (err as PublicFetchError).reason
  }
  throw new Error('expected a refusal')
}

/** A body of `chunks` 64 KiB chunks that counts how many were produced. */
function countedBody(chunks: number) {
  const counter = { produced: 0 }
  const body = () =>
    Readable.from(
      (function* () {
        for (let i = 0; i < chunks; i++) {
          counter.produced++
          yield Buffer.alloc(64 * 1024, 0x61)
        }
      })(),
    )
  return { counter, body }
}

describe('which hosts it will dial', () => {
  it.each([
    ['http://127.0.0.1/', 'not a public address'],
    ['http://10.1.2.3/', 'not a public address'],
    ['http://192.168.1.1/', 'not a public address'],
    ['http://169.254.169.254/latest/meta-data/', 'not a public address'],
    ['http://[::1]/', 'not a public address'],
    ['http://[fd00::1]/', 'not a public address'],
    // The URL parser reads a bare number as an IPv4 address: 127.0.0.1.
    ['http://2130706433/', 'not a public address'],
    ['http://localhost:3000/', 'not a public host'],
    [
      'http://metadata.google.internal/computeMetadata/v1/',
      'not a public host',
    ],
    ['http://printer.local/', 'not a public host'],
    ['file:///etc/passwd', 'only http and https'],
    ['https://admin:secret@example.com/', 'credentials in the URL'],
    ['not a url', 'not a URL'],
  ])('refuses %s before any dial (%s)', async (url, reason) => {
    const net = fakeNet({ [url]: { body: 'secret' } })
    expect(await refusal(get(url, net))).toBe(reason)
    expect(net.dialled).toHaveLength(0)
  })

  it.each([
    'intranet.example.com',
    'metadata.example.com',
    'mixed.example.org',
  ])(
    'refuses %s, a name that resolves to a private address (ENOTPUBLIC at the dial)',
    async (host) => {
      const net = fakeNet({ [`http://${host}/`]: { body: 'secret' } })
      expect(await refusal(get(`http://${host}/`, net))).toBe(
        'resolves to an address that is not public',
      )
      expect(net.dialled).toHaveLength(0)
    },
  )

  it('dials the address the lookup returned for a public name', async () => {
    const net = fakeNet({
      'https://example.com/': { body: 'a' },
      'https://www.example.org/': { body: 'b' },
    })
    await get('https://example.com/', net)
    await get('https://www.example.org/', net)
    expect(net.dialled.map((d) => d.address)).toEqual([
      '93.184.216.34',
      '2606:4700::6810:84e5',
    ])
  })

  it('rejects with the reason when the connection fails', async () => {
    const net = fakeNet({})
    expect(await refusal(get('https://example.com/nothing', net))).toBe(
      'connect ECONNREFUSED',
    )
  })
})

describe('what it sends', () => {
  it('sends the crawler’s user agent and nothing of ours: no cookie, authorization or referrer', async () => {
    const net = fakeNet({
      'https://example.com/': { body: '<title>Hi</title>' },
    })
    await get('https://example.com/', net)
    const headers = net.dialled[0].headers
    expect(headers['user-agent']).toBe(CRAWL_USER_AGENT)
    expect(CRAWL_USER_AGENT).toContain('NativeIntelligenceBot')
    expect(headers.accept).toBe('text/html,application/xhtml+xml')
    const names = Object.keys(headers).map((h) => h.toLowerCase())
    for (const name of [
      'cookie',
      'authorization',
      'referer',
      'proxy-authorization',
    ]) {
      expect(names).not.toContain(name)
    }
  })

  it('sends the Accept header it was asked to', async () => {
    const net = fakeNet({ 'https://example.com/robots.txt': { body: '' } })
    await get('https://example.com/robots.txt', net, { accept: 'text/plain' })
    expect(net.dialled[0].headers.accept).toBe('text/plain')
  })
})

describe('what it hands back', () => {
  it('returns a redirect as the 3xx it is, with its Location, without following it or reading it', async () => {
    const net = fakeNet({
      'https://example.com/old': {
        status: 301,
        headers: { location: '/new', 'content-type': 'text/html' },
        body: '<a href="/new">Moved</a>',
      },
      'https://example.com/new': { body: 'new' },
    })
    const res = await get('https://example.com/old', net)
    expect(res.status).toBe(301)
    expect(res.header('location')).toBe('/new')
    expect(res.header('Location')).toBe('/new')
    expect(res.body).toBe('')
    expect(net.dialled.map((d) => d.url)).toEqual(['https://example.com/old'])
  })

  it('reads the status, headers, media type and body of a page', async () => {
    const net = fakeNet({
      'https://example.com/a': {
        status: 404,
        headers: {
          'Content-Type': 'Text/HTML; Charset=UTF-8',
          'x-robots-tag': 'noindex',
          'set-cookie': ['a=1', 'b=2'],
        },
        body: '<title>Gone</title>',
      },
    })
    const res = await get('https://example.com/a', net)
    expect(res).toMatchObject({
      url: 'https://example.com/a',
      status: 404,
      contentType: 'text/html',
      body: '<title>Gone</title>',
      truncated: false,
    })
    expect(res.header('x-robots-tag')).toBe('noindex')
    expect(res.header('set-cookie')).toBe('a=1, b=2')
    expect(res.header('link')).toBeNull()
    expect(res.responseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('skips the body when wantBody says no, and drops the connection instead of downloading it', async () => {
    const { counter, body } = countedBody(64)
    const net = fakeNet({
      'https://example.com/report.pdf': {
        headers: { 'content-type': 'application/pdf' },
        body,
      },
    })
    const seen: Array<[number, string]> = []
    const res = await get('https://example.com/report.pdf', net, {
      wantBody: (status, contentType) => {
        seen.push([status, contentType])
        return contentType === 'text/html'
      },
    })
    expect(seen).toEqual([[200, 'application/pdf']])
    expect(res.body).toBe('')
    expect(res.truncated).toBe(false)
    expect(res.contentType).toBe('application/pdf')
    await new Promise((r) => setTimeout(r, 10))
    expect(counter.produced).toBeLessThan(64)
    expect(net.responses[0].destroyed).toBe(true)
  })

  it('caps the body at maxBytes, sets truncated, and stops downloading the rest', async () => {
    const { counter, body } = countedBody(64)
    const net = fakeNet({ 'https://example.com/huge': { body } })
    const res = await get('https://example.com/huge', net, {
      maxBytes: 256 * 1024,
    })
    expect(res.truncated).toBe(true)
    expect(res.body).toHaveLength(256 * 1024)
    await new Promise((r) => setTimeout(r, 10))
    expect(counter.produced).toBeLessThan(64)
  })

  it('does not call a body of exactly maxBytes truncated', async () => {
    const net = fakeNet({ 'https://example.com/a': { body: 'x'.repeat(100) } })
    const res = await get('https://example.com/a', net, { maxBytes: 100 })
    expect(res.truncated).toBe(false)
    expect(res.body).toHaveLength(100)
  })

  it('decodes gzip and deflate', async () => {
    const html = '<title>Packed</title>'.repeat(50)
    const net = fakeNet({
      'https://example.com/gz': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: gzipSync(html),
      },
      'https://example.com/deflate': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'deflate' },
        body: deflateSync(html),
      },
    })
    expect((await get('https://example.com/gz', net)).body).toBe(html)
    expect((await get('https://example.com/deflate', net)).body).toBe(html)
  })

  it('caps a compressed body by what it unpacks to', async () => {
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024).fill(0x20))
    expect(bomb.byteLength).toBeLessThan(64 * 1024)
    const net = fakeNet({
      'https://example.com/bomb': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: bomb,
      },
    })
    const res = await get('https://example.com/bomb', net, {
      maxBytes: 128 * 1024,
    })
    expect(res.truncated).toBe(true)
    expect(res.body).toHaveLength(128 * 1024)
  })

  it('fails on a body that claims gzip but is not', async () => {
    const net = fakeNet({
      'https://example.com/bad': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: 'plain text, not gzip',
      },
    })
    await expect(get('https://example.com/bad', net)).rejects.toBeInstanceOf(
      PublicFetchError,
    )
  })

  it('decodes the charset the response names', async () => {
    const net = fakeNet({
      'https://example.com/latin': {
        headers: { 'content-type': 'text/html; charset="ISO-8859-1"' },
        body: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      },
      'https://example.com/unknown': {
        headers: { 'content-type': 'text/html; charset=no-such-charset' },
        body: 'plain',
      },
    })
    expect((await get('https://example.com/latin', net)).body).toBe('café')
    expect((await get('https://example.com/unknown', net)).body).toBe('plain')
  })

  it('times out on a page that never finishes', async () => {
    const never = () => new Readable({ read() {} })
    const net = fakeNet({ 'https://example.com/slow': { body: never } })
    expect(
      await refusal(get('https://example.com/slow', net, { timeoutMs: 30 })),
    ).toBe('timed out')
  })
})
