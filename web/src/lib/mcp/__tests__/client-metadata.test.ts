/**
 * Client ID Metadata Documents (client-metadata.ts): which client_id URLs
 * Dial8 will fetch, what a document must say, and how long a good one is
 * kept. The fetch is injected; nothing here touches the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TTL_MS,
  FAILED_FETCHES_PER_WINDOW,
  FETCH_WINDOW_MS,
  NEW_PASSES_PER_WINDOW,
  PASSED_GRACE_MS,
  _allowancesKeptForTests,
  MAX_TTL_MS,
  _resetClientMetadataCacheForTests,
  cacheTtlMs,
  cleanClientName,
  clientIdUrlProblem,
  isMetadataClientId,
  parseClientMetadata,
  resolveClientMetadata,
} from '../client-metadata'

const ID = 'https://app.example.com/oauth/client.json'
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: ID,
  client_name: 'Example App',
  redirect_uris: ['http://127.0.0.1:33418/callback', 'https://app.example.com/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...over,
})

beforeEach(() => _resetClientMetadataCacheForTests())

describe('client_id URLs', () => {
  it('only an https client_id names a document (registered ids are mcp_…)', () => {
    expect(isMetadataClientId(ID)).toBe(true)
    expect(isMetadataClientId('mcp_0123abcd')).toBe(false)
    expect(isMetadataClientId('http://app.example.com/client.json')).toBe(false)
  })

  it('takes a canonical https URL with a path on a public host name', () => {
    expect(clientIdUrlProblem(ID)).toBeNull()
    expect(clientIdUrlProblem('https://claude.ai/oauth/claude-code-client-metadata')).toBeNull()
  })

  it('refuses the shapes the draft forbids, and anything the fetch would read differently', () => {
    const refused = [
      'http://app.example.com/client.json', // not https
      'https://user:pw@app.example.com/client.json', // userinfo
      'https://app.example.com/client.json#x', // fragment
      'https://app.example.com/client.json?v=1', // query
      'https://app.example.com/client.json?', // empty query
      'https://app.example.com', // no path
      'https://app.example.com/', // only "/"
      'https://app.example.com/a/../client.json', // dot segment
      'https://app.example.com/./client.json',
      'https://APP.example.com/client.json', // not canonical (host case)
      'https://app.example.com:443/client.json', // default port spelled out
      'https://app.example.com:8443/client.json', // any other port: never another service on the host
      'https://93.184.216.34/client.json', // an IP, not a host
      'https://[2606:4700::1111]/client.json',
      'https://localhost/client.json', // not a public name
      'https://intranet/client.json',
      'https://app.example.com./client.json', // trailing dot
      'https://metadata.google.internal/computeMetadata', // the SSRF guard's names
      `https://app.example.com/${'a'.repeat(600)}`, // too long
      'not a url',
    ]
    for (const raw of refused) expect(clientIdUrlProblem(raw), raw).not.toBeNull()
  })
})

describe('the document', () => {
  it('passes a public client naming itself, and keeps what Dial8 needs', () => {
    const parsed = parseClientMetadata(ID, doc())
    expect(parsed).toEqual({
      ok: true,
      metadata: {
        client_id: ID,
        client_name: 'Example App',
        redirect_uris: ['http://127.0.0.1:33418/callback', 'https://app.example.com/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
      },
    })
  })

  it("must name its own URL exactly: another app's document can't be borrowed", () => {
    expect(parseClientMetadata(ID, doc({ client_id: 'https://other.example.com/client.json' })).ok).toBe(false)
    expect(parseClientMetadata(ID, doc({ client_id: `${ID}/` })).ok).toBe(false)
    expect(parseClientMetadata(ID, doc({ client_id: undefined })).ok).toBe(false)
  })

  it('is a public client: no secret, and auth method none (absent means none)', () => {
    expect(parseClientMetadata(ID, doc({ token_endpoint_auth_method: undefined })).ok).toBe(true)
    for (const method of ['client_secret_basic', 'client_secret_post', 'private_key_jwt']) {
      expect(parseClientMetadata(ID, doc({ token_endpoint_auth_method: method })).ok, method).toBe(false)
    }
    expect(parseClientMetadata(ID, doc({ client_secret: 'x' })).ok).toBe(false)
    expect(parseClientMetadata(ID, doc({ client_secret_expires_at: 0 })).ok).toBe(false)
  })

  it('lists 1–20 redirect URIs, each one /register would take', () => {
    for (const redirect_uris of [undefined, [], 'https://app.example.com/cb', ['javascript:alert(1)'], ['http://evil.example/cb'], [42], Array(21).fill('https://app.example.com/cb')]) {
      expect(parseClientMetadata(ID, doc({ redirect_uris })).ok, JSON.stringify(redirect_uris)).toBe(false)
    }
    expect(parseClientMetadata(ID, doc({ redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'] })).ok).toBe(true)
  })

  it('allows the code flow when it lists grants or response types', () => {
    expect(parseClientMetadata(ID, doc({ grant_types: ['client_credentials'] })).ok).toBe(false)
    expect(parseClientMetadata(ID, doc({ response_types: ['token'] })).ok).toBe(false)
    const codeOnly = parseClientMetadata(ID, doc({ grant_types: ['authorization_code'] }))
    expect(codeOnly.ok && codeOnly.metadata.grant_types).toEqual(['authorization_code'])
  })

  it("shows a clean name: control and bidi characters dropped, at most 100, the host when there's none", () => {
    const named = (client_name: unknown) => {
      const r = parseClientMetadata(ID, doc({ client_name }))
      return r.ok ? r.metadata.client_name : null
    }
    expect(named('Evil\u202eppA')).toBe('EvilppA')
    expect(named('  Tabs\tand\nnewlines ')).toBe('Tabsandnewlines')
    expect(named('x'.repeat(300))).toHaveLength(100)
    expect(named(undefined)).toBe('app.example.com')
    expect(named('\u200b')).toBe('app.example.com')
  })

  it('is a JSON object', () => {
    for (const body of [null, 'x', 1, [doc()]]) expect(parseClientMetadata(ID, body).ok).toBe(false)
  })
})

describe('cleanClientName (registered names too)', () => {
  it('drops control and bidi characters, caps at 100, falls back when nothing is left', () => {
    expect(cleanClientName('Claude\u202e edoC', 'x')).toBe('Claude edoC')
    expect(cleanClientName(42, 'MCP Client')).toBe('MCP Client')
    expect(cleanClientName(' \u0000 ', 'MCP Client')).toBe('MCP Client')
  })
})

describe('caching', () => {
  it('reads Cache-Control: none for no-store/no-cache, max-age bounded to an hour, five minutes by default', () => {
    expect(cacheTtlMs(null)).toBe(DEFAULT_TTL_MS)
    expect(cacheTtlMs('public')).toBe(DEFAULT_TTL_MS)
    expect(cacheTtlMs('no-store')).toBe(0)
    expect(cacheTtlMs('public, no-cache')).toBe(0)
    expect(cacheTtlMs('max-age=60')).toBe(60_000)
    expect(cacheTtlMs('public, max-age=0')).toBe(0)
    expect(cacheTtlMs('max-age=86400')).toBe(MAX_TTL_MS)
  })

  it('keeps a good document until it goes stale, then fetches again', async () => {
    const fetchDocument = vi.fn(async () => ({ body: doc(), cacheControl: 'max-age=60' }))
    const t0 = 1_000_000
    expect((await resolveClientMetadata(ID, { fetchDocument: fetchDocument, requester: 'u1', now: t0 })).ok).toBe(true)
    expect((await resolveClientMetadata(ID, { fetchDocument: fetchDocument, requester: 'u1', now: t0 + 59_000 })).ok).toBe(true)
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    await resolveClientMetadata(ID, { fetchDocument: fetchDocument, requester: 'u1', now: t0 + 61_000 })
    expect(fetchDocument).toHaveBeenCalledTimes(2)
  })

  it('never keeps a failure, a bad document, or a no-store one', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ENOTPUBLIC 10.0.0.5')
    })
    const failed = await resolveClientMetadata(ID, { fetchDocument: failing, requester: 'u1' })
    expect(failed).toEqual({ ok: false, reason: "Couldn't fetch the client's metadata document" }) // the detail is logged, not returned
    await resolveClientMetadata(ID, { fetchDocument: failing, requester: 'u1' })
    expect(failing).toHaveBeenCalledTimes(2)

    const bad = vi.fn(async () => ({ body: doc({ client_id: 'https://x.example.com/c' }), cacheControl: null }))
    await resolveClientMetadata(ID, { fetchDocument: bad, requester: 'u1' })
    await resolveClientMetadata(ID, { fetchDocument: bad, requester: 'u1' })
    expect(bad).toHaveBeenCalledTimes(2)

    const noStore = vi.fn(async () => ({ body: doc(), cacheControl: 'no-store' }))
    await resolveClientMetadata(ID, { fetchDocument: noStore, requester: 'u1' })
    await resolveClientMetadata(ID, { fetchDocument: noStore, requester: 'u1' })
    expect(noStore).toHaveBeenCalledTimes(2)
  })

  it('counts FAILED fetches per person: past the allowance, a refusal and no fetch', async () => {
    const t0 = 5_000_000
    const bad = (n: number) => `https://probe${n}.example.com/c.json`
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW; i++) await resolveClientMetadata(bad(i), { fetchDocument: failing, requester: 'u1', now: t0 + i })
    const over = await resolveClientMetadata(bad(99), { fetchDocument: failing, requester: 'u1', now: t0 + 100 })
    expect(over).toEqual({ ok: false, reason: 'Too many failed client lookups. Try again in a few minutes.' })
    expect(failing).toHaveBeenCalledTimes(FAILED_FETCHES_PER_WINDOW)
    // Someone else isn't held back, and the window moves on.
    await resolveClientMetadata(bad(99), { fetchDocument: failing, requester: 'u2', now: t0 + 100 })
    expect(failing).toHaveBeenCalledTimes(FAILED_FETCHES_PER_WINDOW + 1)
    await resolveClientMetadata(bad(99), { fetchDocument: failing, requester: 'u1', now: t0 + FETCH_WINDOW_MS + 100 })
    expect(failing).toHaveBeenCalledTimes(FAILED_FETCHES_PER_WINDOW + 2)
  })

  it("good lookups are free, and an app that passed within the hour is never held back (another site can't spend it)", async () => {
    const t0 = 5_000_000
    // VS Code serves its document no-store: every sign-in step fetches it.
    const good = vi.fn(async () => ({ body: doc(), cacheControl: 'no-store' }))
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW * 2; i++) {
      expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: t0 + i })).ok).toBe(true)
    }
    // A popup steered at 20 bad client_ids spends u1's allowance…
    const failing = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW; i++) {
      await resolveClientMetadata(`https://junk${i}.example.com/c.json`, { fetchDocument: failing, requester: 'u1', now: t0 + 100 })
    }
    expect((await resolveClientMetadata('https://junk99.example.com/c.json', { fetchDocument: failing, requester: 'u1', now: t0 + 200 })).ok).toBe(false)
    // …but the app that passed still signs in, until its hour runs out.
    expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: t0 + 300 })).ok).toBe(true)
    const later = t0 + 300 + PASSED_GRACE_MS + 1
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW; i++) {
      await resolveClientMetadata(`https://junk${i}.example.com/c.json`, { fetchDocument: failing, requester: 'u1', now: later })
    }
    expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: later })).ok).toBe(false)
  })

  it('parallel lookups are charged before they run: no burst gets past the allowance', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        resolveClientMetadata(`https://burst${i}.example.com/c.json`, { fetchDocument: failing, requester: 'u1', now: 7_000_000 }),
      ),
    )
    expect(failing).toHaveBeenCalledTimes(FAILED_FETCHES_PER_WINDOW)
  })

  it('a passed app that later fails is charged, and loses its free pass', async () => {
    const t0 = 7_000_000
    let up = true
    const flaky = vi.fn(async () => {
      if (!up) throw new Error('ECONNREFUSED')
      return { body: doc(), cacheControl: 'no-store' }
    })
    expect((await resolveClientMetadata(ID, { fetchDocument: flaky, requester: 'u1', now: t0 })).ok).toBe(true)
    up = false
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW + 5; i++) await resolveClientMetadata(ID, { fetchDocument: flaky, requester: 'u1', now: t0 + 1 })
    // One free failure ends the pass; from then on each is charged, up to the allowance.
    expect(flaky).toHaveBeenCalledTimes(1 + FAILED_FETCHES_PER_WINDOW)
  })

  it("passes are each person's own: another account's lookups can't push them out", async () => {
    const t0 = 7_000_000
    const good = vi.fn(async (url: string) => ({ body: doc({ client_id: url }), cacheControl: 'no-store' }))
    await resolveClientMetadata(ID, { fetchDocument: good, requester: 'victim', now: t0 })
    for (let i = 0; i < 600; i++) {
      await resolveClientMetadata(`https://attacker.example.com/c${i}.json`, { fetchDocument: good, requester: 'attacker', now: t0 })
    }
    const failing = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW; i++) {
      await resolveClientMetadata(`https://junk${i}.example.com/c.json`, { fetchDocument: failing, requester: 'victim', now: t0 + 1 })
    }
    expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'victim', now: t0 + 2 })).ok).toBe(true)
  })

  it('a steered browser can add only a few new passes per window, so it cannot churn out a real one', async () => {
    const t0 = 7_000_000
    const good = vi.fn(async (url: string) => ({ body: doc({ client_id: url }), cacheControl: 'no-store' }))
    await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: t0 })
    for (let i = 0; i < 200; i++) {
      await resolveClientMetadata(`https://valid${i}.example.com/c.json`, { fetchDocument: good, requester: 'u1', now: t0 + 1 })
    }
    const failing = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW; i++) {
      await resolveClientMetadata(`https://junk${i}.example.com/c.json`, { fetchDocument: failing, requester: 'u1', now: t0 + 2 })
    }
    expect(NEW_PASSES_PER_WINDOW).toBeLessThan(50)
    expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: t0 + 3 })).ok).toBe(true)
  })

  it('a passed app gets ONE free fetch at a time: a parallel burst of it is charged', async () => {
    const t0 = 7_000_000
    let up = true
    const doc0 = vi.fn(async () => {
      if (!up) throw new Error('ECONNREFUSED') // its DNS now points somewhere else
      return { body: doc(), cacheControl: 'no-store' }
    })
    expect((await resolveClientMetadata(ID, { fetchDocument: doc0, requester: 'u1', now: t0 })).ok).toBe(true)
    up = false
    await Promise.all(Array.from({ length: 60 }, () => resolveClientMetadata(ID, { fetchDocument: doc0, requester: 'u1', now: t0 + 1 })))
    // 1 pass, then 1 free + the allowance: the rest are refused before they fetch.
    expect(doc0).toHaveBeenCalledTimes(1 + 1 + FAILED_FETCHES_PER_WINDOW)
  })

  it('the app in daily use is never the pass the cap evicts, however long a steered popup keeps adding', async () => {
    const t0 = 7_000_000
    const good = vi.fn(async (url: string) => ({ body: doc({ client_id: url }), cacheControl: 'no-store' }))
    let n = 0
    for (let w = 0; w < 6; w++) {
      const at = t0 + w * FETCH_WINDOW_MS + 1
      // The person signs in with the real app now and then...
      expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: at })).ok).toBe(true)
      // ...while a steered popup adds as many valid passes as a window allows.
      for (let i = 0; i < 30; i++) await resolveClientMetadata(`https://valid${n++}.example.com/c.json`, { fetchDocument: good, requester: 'u1', now: at + 1 })
    }
    const end = t0 + 6 * FETCH_WINDOW_MS
    const failing = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW; i++) {
      await resolveClientMetadata(`https://junk${i}.example.com/c.json`, { fetchDocument: failing, requester: 'u1', now: end })
    }
    expect((await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: end + 1 })).ok).toBe(true)
  })

  it('keeps no empty allowance, and at most 500 people', async () => {
    const good = vi.fn(async () => ({ body: doc(), cacheControl: 'max-age=600' }))
    await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u1', now: 8_000_000 })
    await resolveClientMetadata(ID, { fetchDocument: good, requester: 'u2', now: 8_000_000 }) // a cache hit: nothing kept for u2
    expect(_allowancesKeptForTests()).toBe(1)
    const failing = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    for (let i = 0; i < 700; i++) await resolveClientMetadata(`https://x${i}.example.com/c.json`, { fetchDocument: failing, requester: `p${i}`, now: 8_000_000 })
    expect(_allowancesKeptForTests()).toBe(500)
  })

  it('a cache hit costs nothing', async () => {
    const cached = vi.fn(async () => ({ body: doc(), cacheControl: 'max-age=600' }))
    for (let i = 0; i < FAILED_FETCHES_PER_WINDOW * 2; i++) await resolveClientMetadata(ID, { fetchDocument: cached, requester: 'u1', now: 5_000_000 })
    expect(cached).toHaveBeenCalledTimes(1)
  })

  it('never fetches a client_id URL it refuses', async () => {
    const fetchDocument = vi.fn()
    expect((await resolveClientMetadata('https://localhost/c.json', { fetchDocument: fetchDocument, requester: 'u1' })).ok).toBe(false)
    expect(fetchDocument).not.toHaveBeenCalled()
  })
})
