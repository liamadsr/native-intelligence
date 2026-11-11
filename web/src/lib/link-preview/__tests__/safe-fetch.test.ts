/**
 * The link preview's fetcher (../safe-fetch.ts) is a server-side request
 * forgery surface: a person's link is fetched by the server. Only http and
 * https; never a private, loopback, link-local, carrier-grade NAT or
 * metadata address, by literal or by what a name resolves to (checked at the
 * dial, through the same public-only lookup the MCP metadata fetch uses), on
 * the first hop and on every redirect; a few redirects at most; a short
 * timeout; a size cap (after decompression); nothing of the person's sent.
 *
 * The request is a fake that dials as a socket would (it asks the lookup it
 * was given, then answers from a table), and DNS is a table too: nothing here
 * touches the network.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { publicOnlyLookup } from '@/lib/mcp/client-metadata-fetch'
import { checkPublicUrl, fetchPublicPage, PublicFetchError, type Send } from '../safe-fetch'

/** What each name resolves to. */
const DNS: Record<string, string[]> = {
  'news.example.test': ['93.184.216.34'],
  'cdn.example.test': ['2606:4700::6810:84e5'],
  'intranet.example.test': ['10.0.0.5'],
  'metadata.example.test': ['169.254.169.254'],
  'half.example.test': ['93.184.216.34', '127.0.0.1'],
  'cgnat.example.test': ['100.64.1.1'],
}
const resolve = (host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => {
  const found = DNS[host]
  if (!found) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), [])
  cb(
    null,
    found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  )
}
const lookup = publicOnlyLookup(resolve as never)

interface Answer {
  status?: number
  headers?: Record<string, string>
  /** The body, or a stream of it. */
  body?: string | Buffer | (() => Readable)
}

/** A request that dials as a socket would: a name goes through the lookup it was given; a literal IP is dialled as is. */
function fakeNet(answers: Record<string, Answer>) {
  const dialled: Array<{ url: string; address: string; headers: Record<string, unknown> }> = []
  const send: Send = (url, options: RequestOptions, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; destroyed: boolean }
    req.destroyed = false
    req.destroy = () => {
      req.destroyed = true
    }
    req.end = () => {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
      const answer = (address: string) => {
        dialled.push({ url, address, headers: { ...(options.headers as Record<string, unknown>) } })
        const a = answers[url]
        if (!a) return req.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }))
        const bytes = typeof a.body === 'string' ? Buffer.from(a.body) : a.body
        const stream = typeof bytes === 'function' ? bytes() : Readable.from(bytes === undefined ? [] : [bytes])
        const res = stream as unknown as IncomingMessage
        res.statusCode = a.status ?? 200
        res.headers = Object.fromEntries(Object.entries(a.headers ?? { 'content-type': 'text/html; charset=utf-8' }).map(([k, v]) => [k.toLowerCase(), v]))
        onResponse(res)
      }
      if (/^[\d.]+$/.test(host) || host.includes(':')) return queueMicrotask(() => answer(host))
      ;(options.lookup as (h: string, o: object, cb: (err: NodeJS.ErrnoException | null, address: string) => void) => void)(host, {}, (err, address) => {
        if (err) return req.emit('error', err)
        answer(address)
      })
    }
    return req as never
  }
  return { send: { 'http:': send, 'https:': send }, dialled }
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

describe('which URLs it fetches at all', () => {
  it('http and https only: never file, ftp, data, javascript or gopher', () => {
    for (const url of ['file:///etc/passwd', 'ftp://news.example.test/x', 'data:text/html,hi', 'javascript:alert(1)', 'gopher://news.example.test/']) {
      expect(() => checkPublicUrl(url), url).toThrow(PublicFetchError)
    }
    expect(checkPublicUrl('https://news.example.test/a').hostname).toBe('news.example.test')
  })

  it('never a private, loopback, link-local, CGNAT or metadata address, however it is written', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://localhost:3000/',
      'http://printer.local/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://api.localhost/',
    ]) {
      expect(() => checkPublicUrl(url), url).toThrow(PublicFetchError)
    }
  })

  it('never a URL with a user name or password in it', () => {
    expect(() => checkPublicUrl('https://admin:hunter2@news.example.test/')).toThrow(/credentials/)
  })
})

describe('the fetch', () => {
  it('reads a public page, and sends nothing of the person’s (no cookie, authorization or referrer)', async () => {
    const net = fakeNet({ 'https://news.example.test/story': { body: '<title>Hello</title>' } })
    const page = await fetchPublicPage('https://news.example.test/story', { send: net.send, lookup })
    expect(page).toMatchObject({ url: 'https://news.example.test/story', status: 200, contentType: 'text/html', charset: 'utf-8', truncated: false })
    expect(new TextDecoder().decode(page.body)).toBe('<title>Hello</title>')
    expect(net.dialled[0].address).toBe('93.184.216.34')
    const headers = Object.keys(net.dialled[0].headers).map((h) => h.toLowerCase())
    expect(headers).not.toContain('cookie')
    expect(headers).not.toContain('authorization')
    expect(headers).not.toContain('referer')
  })

  it('refuses a public-looking name that resolves to a private or metadata address, or to any private one among public ones', async () => {
    for (const host of ['intranet.example.test', 'metadata.example.test', 'half.example.test', 'cgnat.example.test']) {
      const net = fakeNet({ [`http://${host}/`]: { body: 'secret' } })
      expect(await refusal(fetchPublicPage(`http://${host}/`, { send: net.send, lookup })), host).toBe('resolves to an address that is not public')
      expect(net.dialled, host).toHaveLength(0)
    }
  })

  it('refuses a literal private address before any dial', async () => {
    const net = fakeNet({ 'http://169.254.169.254/': { body: 'creds' } })
    expect(await refusal(fetchPublicPage('http://169.254.169.254/', { send: net.send, lookup }))).toBe('not a public address')
    expect(net.dialled).toHaveLength(0)
  })

  it('follows a redirect to a public page (relative ones too), holding every hop to the same rules', async () => {
    const net = fakeNet({
      'https://news.example.test/a': { status: 301, headers: { location: '/b' } },
      'https://news.example.test/b': { status: 302, headers: { location: 'https://cdn.example.test/c' } },
      'https://cdn.example.test/c': { body: '<title>There</title>' },
    })
    const page = await fetchPublicPage('https://news.example.test/a', { send: net.send, lookup })
    expect(page.url).toBe('https://cdn.example.test/c')
    expect(net.dialled.map((d) => d.address)).toEqual(['93.184.216.34', '93.184.216.34', '2606:4700::6810:84e5'])
  })

  it('refuses a redirect to a private address, a name that resolves privately, or another scheme', async () => {
    for (const [location, reason] of [
      ['http://169.254.169.254/latest/meta-data/', 'not a public address'],
      ['http://[::1]:8080/', 'not a public address'],
      ['http://localhost/', 'not a public host'],
      ['http://intranet.example.test/admin', 'resolves to an address that is not public'],
      ['file:///etc/passwd', 'only http and https'],
    ] as const) {
      const net = fakeNet({ 'https://news.example.test/go': { status: 302, headers: { location } }, [location]: { body: 'inside' } })
      expect(await refusal(fetchPublicPage('https://news.example.test/go', { send: net.send, lookup })), location).toBe(reason)
      expect(net.dialled.map((d) => d.url), location).toEqual(['https://news.example.test/go'])
    }
  })

  it('follows at most three redirects', async () => {
    const answers: Record<string, Answer> = {}
    for (let i = 0; i < 6; i++) answers[`https://news.example.test/${i}`] = { status: 302, headers: { location: `/${i + 1}` } }
    const net = fakeNet(answers)
    expect(await refusal(fetchPublicPage('https://news.example.test/0', { send: net.send, lookup }))).toBe('too many redirects')
    expect(net.dialled).toHaveLength(4)
  })

  it('reads at most the cap of an oversized body, and stops downloading the rest', async () => {
    let produced = 0
    const big = () =>
      Readable.from(
        (function* () {
          for (let i = 0; i < 64; i++) {
            produced++
            yield Buffer.alloc(64 * 1024, 0x61)
          }
        })(),
      )
    const net = fakeNet({ 'https://news.example.test/huge': { body: big } })
    const page = await fetchPublicPage('https://news.example.test/huge', { send: net.send, lookup, maxBytes: 256 * 1024 })
    expect(page.truncated).toBe(true)
    expect(page.body.byteLength).toBe(256 * 1024)
    await new Promise((r) => setTimeout(r, 10))
    expect(produced).toBeLessThan(64)
  })

  it('caps a compressed body by what it unpacks to (a small gzip can’t become a big one)', async () => {
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024).fill(0x20))
    expect(bomb.byteLength).toBeLessThan(64 * 1024)
    const net = fakeNet({ 'https://news.example.test/bomb': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb } })
    const page = await fetchPublicPage('https://news.example.test/bomb', { send: net.send, lookup, maxBytes: 128 * 1024 })
    expect(page.truncated).toBe(true)
    expect(page.body.byteLength).toBe(128 * 1024)
  })

  it('gives up on a page that takes too long', async () => {
    const never = () => new Readable({ read() {} })
    const net = fakeNet({ 'https://news.example.test/slow': { body: never } })
    expect(await refusal(fetchPublicPage('https://news.example.test/slow', { send: net.send, lookup, timeoutMs: 30 }))).toBe('timed out')
  })
})
