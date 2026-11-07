/**
 * The client metadata fetch (client-metadata-fetch.ts): the DNS answer is
 * checked at the dial, a redirect is never followed, and a body is read only
 * up to 5 KB within the deadline. A local http server stands in for the app
 * (the request function is injected); no test touches real DNS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { fetchMetadataDocument, publicOnlyLookup } from '../client-metadata-fetch'

type Answer = Array<{ address: string; family: number }>
const resolver = (answer: Answer | Error) =>
  ((_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, addresses: Answer) => void) =>
    answer instanceof Error ? cb(answer, []) : cb(null, answer)) as Parameters<typeof publicOnlyLookup>[0]

function lookupOnce(lookup: LookupFunction, all: boolean): Promise<{ err: NodeJS.ErrnoException | null; address: unknown }> {
  return new Promise((resolve) => lookup('app.example.com', { all }, (err, address) => resolve({ err, address })))
}

describe('publicOnlyLookup', () => {
  it('answers with the public addresses the name has', async () => {
    const lookup = publicOnlyLookup(resolver([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::248', family: 6 }]))
    expect((await lookupOnce(lookup, true)).address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::248', family: 6 },
    ])
    expect((await lookupOnce(lookup, false)).address).toBe('93.184.216.34')
  })

  it('refuses the dial when ANY address is not public (a rebinding answer can mix them)', async () => {
    for (const answer of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }],
      [{ address: '10.1.2.3', family: 4 }],
      [{ address: '::ffff:7f00:1', family: 6 }],
      [{ address: 'fd00::1', family: 6 }],
      [{ address: '224.0.0.1', family: 4 }],
      [{ address: '198.18.0.1', family: 4 }],
      [],
    ]) {
      const { err } = await lookupOnce(publicOnlyLookup(resolver(answer)), true)
      expect(err?.code, JSON.stringify(answer)).toBe('ENOTPUBLIC')
    }
  })

  it('passes a resolver failure through', async () => {
    const { err } = await lookupOnce(publicOnlyLookup(resolver(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }))), true)
    expect(err?.code).toBe('ENOTFOUND')
  })
})

describe('fetchMetadataDocument (local server)', () => {
  let server: Server
  let base = ''
  const routes: Record<string, (res: import('node:http').ServerResponse) => void> = {
    '/ok': (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=120' })
      res.end(JSON.stringify({ client_id: 'x' }))
    },
    '/moved': (res) => {
      res.writeHead(302, { location: '/ok' })
      res.end()
    },
    '/missing': (res) => {
      res.writeHead(404)
      res.end()
    },
    '/big': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pad: 'x'.repeat(6000) }))
    },
    '/endless': (res) => {
      // No content-length: chunks until the cap trips.
      res.writeHead(200, { 'content-type': 'application/json' })
      const tick = setInterval(() => res.write('x'.repeat(1024)), 1)
      res.on('close', () => clearInterval(tick))
    },
    '/slow': () => {
      // Never answers: the deadline must.
    },
    '/html': (res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    },
    '/plain': (res) => {
      // Valid JSON as a raw-text host serves it (a gist, raw.githubusercontent.com).
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(JSON.stringify({ client_id: 'x' }))
    },
    '/vendor': (res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.example+json; charset=utf-8' })
      res.end(JSON.stringify({ client_id: 'v' }))
    },
    '/broken': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{ not json')
    },
  }

  beforeAll(async () => {
    server = createServer((req, res) => (routes[req.url ?? ''] ?? routes['/missing'])(res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    // A name, not the literal address: the injected lookup sends it to the local server.
    base = `http://app.test:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  // The local server is plain http on loopback: the test's own request and an
  // unchecked lookup stand in for https and the public-only one.
  const local = { send: httpRequest as never, lookup: undefined as unknown as LookupFunction, timeoutMs: 500 }
  const get = (path: string) => fetchMetadataDocument(`${base}${path}`, { ...local, lookup: (h, o, cb) => cb(null, o.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) })

  it('reads a 200 JSON document and its Cache-Control', async () => {
    expect(await get('/ok')).toEqual({ body: { client_id: 'x' }, cacheControl: 'max-age=120' })
  })

  it('never follows a redirect, and takes nothing but a 200', async () => {
    await expect(get('/moved')).rejects.toThrow('HTTP 302')
    await expect(get('/missing')).rejects.toThrow('HTTP 404')
  })

  it('stops at 5 KB, declared or streamed', async () => {
    await expect(get('/big')).rejects.toThrow('too large')
    await expect(get('/endless')).rejects.toThrow('too large')
  })

  it('gives up at the deadline, and on a body that is not JSON', async () => {
    await expect(get('/slow')).rejects.toThrow('timed out')
    await expect(get('/broken')).rejects.toThrow('not JSON')
  })

  it('takes only a document served as JSON (application/json or …+json)', async () => {
    await expect(get('/html')).rejects.toThrow('not served as JSON')
    await expect(get('/plain')).rejects.toThrow('not served as JSON')
    expect((await get('/vendor')).body).toEqual({ client_id: 'v' })
  })

  it('refuses a literal private address before any dial', async () => {
    await expect(fetchMetadataDocument('https://10.0.0.5/client.json')).rejects.toThrow('not a public address')
    await expect(fetchMetadataDocument('https://[::1]/client.json')).rejects.toThrow('not a public address')
  })
})
