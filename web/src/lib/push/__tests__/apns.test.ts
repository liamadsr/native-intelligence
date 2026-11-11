/**
 * The APNs sender (src/lib/push/apns.ts) against a local HTTP/2 server that
 * stands in for Apple: the provider token is an ES256 JWT Apple can verify
 * (header, claims, a raw r||s signature over them), made once and reused for
 * 50 minutes, made again at once when Apple says it expired; each push has
 * Apple's headers and payload; 410 and BadDeviceToken say the install is
 * gone, other refusals only that it failed; the settings unset turn push off.
 */
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2'
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  APNS_EXPIRATION_S,
  APNS_MAX_PAYLOAD_BYTES,
  APNS_TOKEN_REFRESH_MS,
  apnsConfig,
  apnsPayload,
  createApnsSender,
  type ApnsConfig,
  type ApnsSender,
} from '../apns'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CONFIG: ApnsConfig = { keyId: 'KEY1234567', teamId: 'TEAM123456', privateKey: PEM, bundleId: 'com.example.app' }
const TOKEN = 'ab'.repeat(32)
const NOW = Date.parse('2026-11-11T20:00:00.000Z')

interface Seen {
  headers: IncomingHttpHeaders
  body: string
}

/** What the stand-in answers next (status and JSON body), by device token. */
let answers: Record<string, Array<{ status: number; reason?: string }>> = {}
let seen: Seen[] = []
let server: Http2Server
let origin = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      seen.push({ headers: req.headers, body })
      const token = String(req.headers[':path'] ?? '').split('/').pop() ?? ''
      const next = answers[token]?.shift() ?? { status: 200 }
      res.writeHead(next.status, { 'apns-id': String(req.headers['apns-id'] ?? 'none'), 'content-type': 'application/json' })
      res.end(next.reason ? JSON.stringify({ reason: next.reason }) : '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

let senders: ApnsSender[] = []
afterEach(() => {
  for (const s of senders) s.close()
  senders = []
  answers = {}
  seen = []
})

function sender(now: () => number = () => NOW): ApnsSender {
  const s = createApnsSender({ config: CONFIG, origins: { sandbox: origin, production: origin }, now })
  senders.push(s)
  return s
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

function jwtOf(headers: IncomingHttpHeaders): string {
  const auth = String(headers.authorization ?? '')
  expect(auth.startsWith('bearer ')).toBe(true)
  return auth.slice('bearer '.length)
}

function verifies(jwt: string, key: KeyObject): boolean {
  const [h, c, sig] = jwt.split('.')
  return verify('sha256', new Uint8Array(Buffer.from(`${h}.${c}`)), { key, dsaEncoding: 'ieee-p1363' }, new Uint8Array(Buffer.from(sig, 'base64url')))
}

const push = { title: 'Ana Ruiz in #launch', body: 'The deck is ready', badge: 3, threadId: 'team_chat:c1', collapseId: 'team_chat:c1', data: { kind: 'team_chat', channel_id: 'c1', message_id: 'm1', thread_root_id: null } }

describe('the settings', () => {
  it('all four, or push is off', () => {
    const env = { APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456', APNS_PRIVATE_KEY: PEM, APNS_BUNDLE_ID: 'com.example.app' }
    expect(apnsConfig(env)).toEqual({ ...CONFIG, privateKey: PEM.trim() })
    for (const name of Object.keys(env)) expect(apnsConfig({ ...env, [name]: '' }), name).toBeNull()
    expect(apnsConfig({})).toBeNull()
  })

  it('a key pasted on one line, its newlines written as \\n, is the key', () => {
    const oneLine = PEM.trim().split('\n').join('\\n')
    expect(apnsConfig({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: oneLine, APNS_BUNDLE_ID: 'b' })?.privateKey).toBe(PEM.trim())
  })
})

describe('the provider token', () => {
  it('is an ES256 JWT over the key id and team, signed so Apple can check it', async () => {
    expect(await sender().send({ token: TOKEN, environment: 'sandbox', notification: push })).toMatchObject({ ok: true })
    const jwt = jwtOf(seen[0].headers)
    const [h, c] = jwt.split('.')
    expect(decode(h)).toEqual({ alg: 'ES256', kid: 'KEY1234567' })
    expect(decode(c)).toEqual({ iss: 'TEAM123456', iat: Math.floor(NOW / 1000) })
    expect(verifies(jwt, publicKey)).toBe(true)
    // A raw r||s pair (64 bytes), not DER.
    expect(Buffer.from(jwt.split('.')[2], 'base64url')).toHaveLength(64)
  })

  it('is made once and reused, then made again after 50 minutes (Apple: under an hour, no more than every 20)', async () => {
    let now = NOW
    const s = sender(() => now)
    await s.send({ token: TOKEN, environment: 'sandbox', notification: push })
    now += 20 * 60_000
    await s.send({ token: TOKEN, environment: 'production', notification: push })
    now = NOW + APNS_TOKEN_REFRESH_MS + 1
    await s.send({ token: TOKEN, environment: 'sandbox', notification: push })
    const [a, b, c] = seen.map((x) => jwtOf(x.headers))
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(decode(c.split('.')[1]).iat).toBe(Math.floor((NOW + APNS_TOKEN_REFRESH_MS + 1) / 1000))
  })

  it('Apple saying it expired makes a fresh one and tries once more', async () => {
    let now = NOW
    const s = sender(() => now)
    await s.send({ token: TOKEN, environment: 'sandbox', notification: push })
    now += 60_000
    answers[TOKEN] = [{ status: 403, reason: 'ExpiredProviderToken' }]
    expect(await s.send({ token: TOKEN, environment: 'sandbox', notification: push })).toMatchObject({ ok: true })
    expect(seen).toHaveLength(3)
    expect(jwtOf(seen[2].headers)).not.toBe(jwtOf(seen[1].headers))
  })
})

describe('a push', () => {
  it('has Apple’s headers: alert, the topic, now, a day to live, collapsed by its conversation', async () => {
    await sender().send({ token: TOKEN, environment: 'sandbox', notification: push })
    const h = seen[0].headers
    expect(h[':method']).toBe('POST')
    expect(h[':path']).toBe(`/3/device/${TOKEN}`)
    expect(h['apns-push-type']).toBe('alert')
    expect(h['apns-topic']).toBe('com.example.app')
    expect(h['apns-priority']).toBe('10')
    expect(h['apns-expiration']).toBe(String(Math.floor(NOW / 1000) + APNS_EXPIRATION_S))
    expect(h['apns-collapse-id']).toBe('team_chat:c1')
    expect(String(h['apns-id'])).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries the title, the words, the badge, the thread and the ids the app opens it at', async () => {
    await sender().send({ token: TOKEN, environment: 'sandbox', notification: push })
    expect(JSON.parse(seen[0].body)).toEqual({
      aps: { alert: { title: 'Ana Ruiz in #launch', body: 'The deck is ready' }, sound: 'default', badge: 3, 'thread-id': 'team_chat:c1' },
      kind: 'team_chat',
      channel_id: 'c1',
      message_id: 'm1',
      thread_root_id: null,
    })
  })

  it('no badge: the icon is left as it is; a collapse id is cut to Apple’s 64 bytes', async () => {
    await sender().send({ token: TOKEN, environment: 'sandbox', notification: { title: 't', body: 'b', collapseId: 'x'.repeat(80) } })
    expect(JSON.parse(seen[0].body).aps).not.toHaveProperty('badge')
    expect(seen[0].headers['apns-collapse-id']).toBe('x'.repeat(64))
  })

  it('a body too long for Apple’s 4 KB is cut, never refused', () => {
    const json = apnsPayload({ title: 't', body: 'word '.repeat(2000) })
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(APNS_MAX_PAYLOAD_BYTES)
    expect(JSON.parse(json).aps.alert.body.endsWith('…')).toBe(true)
  })
})

describe('what Apple answers', () => {
  it('410 and BadDeviceToken: the install is gone', async () => {
    const s = sender()
    answers[TOKEN] = [{ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'DeviceTokenNotForTopic' }]
    expect(await s.send({ token: TOKEN, environment: 'production', notification: push })).toEqual({ ok: false, gone: true, status: 410, reason: 'Unregistered' })
    expect(await s.send({ token: TOKEN, environment: 'production', notification: push })).toEqual({ ok: false, gone: true, status: 400, reason: 'BadDeviceToken' })
    expect(await s.send({ token: TOKEN, environment: 'production', notification: push })).toMatchObject({ gone: true, reason: 'DeviceTokenNotForTopic' })
  })

  it('anything else only failed: the install stays (a busy Apple, a bad payload, a wrong key)', async () => {
    const s = sender()
    answers[TOKEN] = [{ status: 500, reason: 'InternalServerError' }, { status: 429, reason: 'TooManyRequests' }, { status: 403, reason: 'InvalidProviderToken' }, { status: 400, reason: 'PayloadTooLarge' }]
    for (const reason of ['InternalServerError', 'TooManyRequests', 'InvalidProviderToken', 'PayloadTooLarge']) {
      expect(await s.send({ token: TOKEN, environment: 'production', notification: push })).toMatchObject({ ok: false, gone: false, reason })
    }
    // InvalidProviderToken is not retried (only an expired one is).
    expect(seen).toHaveLength(4)
  })

  it('a token that is not hex never goes out', async () => {
    expect(await sender().send({ token: 'not-a-token', environment: 'production', notification: push })).toMatchObject({ ok: false, gone: true })
    expect(seen).toHaveLength(0)
  })

  it('a host that is down is a failure, not a throw', async () => {
    const s = createApnsSender({ config: CONFIG, origins: { production: 'http://127.0.0.1:1' }, now: () => NOW })
    senders.push(s)
    expect(await s.send({ token: TOKEN, environment: 'production', notification: push })).toMatchObject({ ok: false, gone: false })
  })
})
