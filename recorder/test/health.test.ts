import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOWN_AFTER_MS, HEALTH_RESEND_MS, NO_WORDS_AFTER_MS, callHealth, healthToSend, needsVerdict, voiced, type FeedHealth } from '../src/health.ts'
import { DeepgramStream, type SocketLike } from '../src/deepgram.ts'
import { checkDeepgramKey, checkDeepgramStream, restBase, verdictOfStatus } from '../src/deepgram-check.ts'
import { formatChecks, runChecks } from '../src/check.ts'
import { AppError } from '../src/app-client.ts'

test('a frame is voiced when loud enough to be speech, never room noise or silence', () => {
  assert.equal(voiced(new Int16Array(160)), false)
  assert.equal(voiced(new Int16Array(160).fill(200)), false)
  assert.equal(voiced(new Int16Array(160).fill(3000)), true)
  assert.equal(voiced(new Int16Array(0)), false)
})

test('a call is ok, down (named when Deepgram says why), or missing words', () => {
  assert.equal(callHealth([], null), 'ok')
  assert.equal(callHealth([{ downForMs: DOWN_AFTER_MS - 1, voicedSinceWordsMs: 0 }], null), 'ok', 'a reconnect blip is not a failure')
  assert.equal(callHealth([{ downForMs: DOWN_AFTER_MS, voicedSinceWordsMs: 0 }], null), 'down')
  assert.equal(callHealth([{ downForMs: DOWN_AFTER_MS, voicedSinceWordsMs: 0 }], 'unreachable'), 'down')
  assert.equal(callHealth([{ downForMs: DOWN_AFTER_MS, voicedSinceWordsMs: 0 }], 'refused'), 'refused')
  assert.equal(callHealth([{ downForMs: DOWN_AFTER_MS, voicedSinceWordsMs: 0 }], 'no_credit'), 'no_credit')
  assert.equal(callHealth([{ downForMs: 0, voicedSinceWordsMs: 0 }], 'refused'), 'ok', 'an old verdict says nothing while sockets are open')
  assert.equal(callHealth([{ downForMs: 0, voicedSinceWordsMs: NO_WORDS_AFTER_MS }, { downForMs: 0, voicedSinceWordsMs: 0 }], null), 'no_words')
  assert.equal(needsVerdict([{ downForMs: DOWN_AFTER_MS, voicedSinceWordsMs: 0 }]), true)
  assert.equal(needsVerdict([{ downForMs: 0, voicedSinceWordsMs: NO_WORDS_AFTER_MS }]), false)
})

test('health goes to the app when it changes, and again every so often, never every beat', () => {
  const now = new Map<string, FeedHealth>([['a', 'ok'], ['b', 'down']])
  assert.deepEqual(healthToSend(now, new Map(), 1000), [{ id: 'a', state: 'ok' }, { id: 'b', state: 'down' }])
  const sent = new Map([['a', { state: 'ok' as FeedHealth, at: 1000 }], ['b', { state: 'ok' as FeedHealth, at: 1000 }]])
  assert.deepEqual(healthToSend(now, sent, 6000), [{ id: 'b', state: 'down' }])
  assert.deepEqual(healthToSend(now, sent, 1000 + HEALTH_RESEND_MS).map((h) => h.id), ['a', 'b'])
})

class FakeSocket implements SocketLike {
  readyState = 0
  binaryType = 'blob'
  sent: unknown[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: unknown): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
}

test('a stream says how long it has had no socket, and how many opens in a row failed', async () => {
  let t = 0
  const sockets: FakeSocket[] = []
  const stream = new DeepgramStream({
    url: 'wss://deepgram.test/v1/listen',
    key: 'k-test',
    now: () => t,
    socket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    onHeard: () => undefined,
  })
  t = 3000
  assert.deepEqual(stream.health(), { downForMs: 3000, failedOpens: 0 }, 'not open yet counts as down')
  sockets[0].open()
  assert.deepEqual(stream.health(), { downForMs: 0, failedOpens: 0 })
  t = 5000
  sockets[0].drop()
  t = 9000
  assert.deepEqual(stream.health(), { downForMs: 4000, failedOpens: 0 })
  await new Promise((r) => setTimeout(r, 700))
  sockets[1].drop()
  assert.equal(stream.health().failedOpens, 1)
  await stream.close(10)
})

test('the key check: taken with its balance, refused, no credit, unreachable; 403 decides nothing', async () => {
  assert.equal(restBase('wss://api.deepgram.com/v1/listen?model=nova-3'), 'https://api.deepgram.com')
  assert.equal(restBase('ws://127.0.0.1:9/v1/listen'), 'http://127.0.0.1:9')
  assert.equal(verdictOfStatus(403), 'unknown')
  const seen: Array<{ url: string; auth: string | null }> = []
  const ok = await checkDeepgramKey({
    streamUrl: 'wss://dg.test/v1/listen',
    key: 'k-test',
    fetch: async (url, init) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') })
      return url.endsWith('/balances')
        ? Response.json({ balances: [{ amount: 42.5, units: 'usd' }] })
        : Response.json({ projects: [{ project_id: 'proj-1' }] })
    },
  })
  assert.deepEqual(ok, { verdict: 'ok', status: 200, balance: { amount: 42.5, units: 'usd' } })
  assert.deepEqual(seen.map((s) => s.url), ['https://dg.test/v1/projects', 'https://dg.test/v1/projects/proj-1/balances'])
  assert.ok(seen.every((s) => s.auth === 'Token k-test'), 'the key goes in a header, never the URL')
  assert.equal((await checkDeepgramKey({ streamUrl: 'wss://dg.test', key: 'k', fetch: async () => new Response('', { status: 401 }) })).verdict, 'refused')
  assert.equal((await checkDeepgramKey({ streamUrl: 'wss://dg.test', key: 'k', fetch: async () => new Response('', { status: 402 }) })).verdict, 'no_credit')
  assert.equal((await checkDeepgramKey({ streamUrl: 'wss://dg.test', key: 'k', fetch: async () => { throw new Error('down') } })).verdict, 'unreachable')
})

test('the stream check opens a socket with the key and closes it before any audio', async () => {
  let made: FakeSocket | null = null
  let protocols: string[] = []
  const out = checkDeepgramStream({
    url: 'wss://dg.test/v1/listen',
    key: 'k-test',
    socket: (_u, p) => {
      protocols = p
      made = new FakeSocket()
      return made
    },
  })
  ;(made as unknown as FakeSocket).open()
  assert.equal(await out, 'open')
  assert.deepEqual(protocols, ['token', 'k-test'])
  assert.deepEqual((made as unknown as FakeSocket).sent, [JSON.stringify({ type: 'CloseStream' })])
  const refused = checkDeepgramStream({ url: 'wss://dg.test', key: 'k', socket: () => (made = new FakeSocket()) })
  ;(made as unknown as FakeSocket).drop()
  assert.equal(await refused, 'closed')
})

test('the preflight: one line per dependency, and why a failure failed', async () => {
  const socket = () => {
    const s = new FakeSocket()
    setTimeout(() => s.open(), 0)
    return s
  }
  const fetchAll = async (url: string) => {
    if (url.startsWith('http://127.0.0.1:9091')) return Response.json({ ok: true, calls: 1, appOkSecondsAgo: 2 })
    if (url.startsWith('http://livekit')) return new Response('OK')
    if (url.endsWith('/balances')) return Response.json({ balances: [{ amount: 12, units: 'usd' }] })
    return Response.json({ projects: [{ project_id: 'p' }] })
  }
  const good = await runChecks({
    client: { check: async () => ({ recorder: true, liveAgent: true, liveAgentHealth: 'ready', livekit: true }), work: async () => ({ jobs: [], pollMs: 3000 }) },
    healthPort: 9091,
    livekitUrl: 'ws://livekit:7880',
    deepgramUrl: 'wss://dg.test/v1/listen',
    deepgramKey: 'k',
    fetch: fetchAll,
    socket,
  })
  assert.ok(good.every((l) => l.ok), formatChecks(good))
  assert.deepEqual(good.map((l) => l.name), ['recorder', 'app', 'live agent', 'livekit', 'deepgram key', 'deepgram stream'])

  const bad = await runChecks({
    client: {
      check: async () => {
        throw new AppError('x', 401, null)
      },
      work: async () => ({ jobs: [], pollMs: 3000 }),
    },
    healthPort: 9091,
    livekitUrl: 'ws://livekit:7880',
    deepgramUrl: 'wss://dg.test/v1/listen',
    deepgramKey: 'k',
    fetch: async (url) => (url.includes('dg.test') ? new Response('', { status: 401 }) : fetchAll(url)),
    socket: () => {
      const s = new FakeSocket()
      setTimeout(() => s.drop(), 0)
      return s
    },
  })
  const text = formatChecks(bad)
  assert.match(text, /FAIL app: refused the feed secret/)
  assert.match(text, /FAIL deepgram key: key refused \(401\)/)
  assert.match(text, /FAIL deepgram stream: the socket was refused/)
  assert.doesNotMatch(text, /\bk\b.*secret/)
})
