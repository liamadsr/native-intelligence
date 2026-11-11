/**
 * Apple Push Notification service, token-based (the iOS app's pushes).
 * Server only. No dependency: Node's own http2 and crypto.
 *
 * Settings (all four, or push is off and {@link apnsConfig} says so):
 *   APNS_KEY_ID       the auth key's id (10 characters, Apple's developer site)
 *   APNS_TEAM_ID      the team the key belongs to (10 characters)
 *   APNS_PRIVATE_KEY  the .p8 key itself, PEM (newlines as they are, or as \n)
 *   APNS_BUNDLE_ID    the app's bundle id: every push's topic, and the only
 *                     installs pushed to (push_token.bundle_id, migration 562)
 *
 * The provider token is an ES256 JWT ({ alg, kid } over { iss: team, iat })
 * signed with the key, made once and reused: Apple refuses one older than an
 * hour and asks that it be made no more than once every 20 minutes
 * (TooManyProviderTokenUpdates), so it is made again after
 * APNS_TOKEN_REFRESH_MS, or at once when Apple says it expired.
 *
 * One HTTP/2 connection per host (production api.push.apple.com, sandbox
 * api.sandbox.push.apple.com: each install's token says which), opened on
 * first use, kept while it is used, closed when idle. A request is
 * POST /3/device/<token> with the push type (alert), the topic, a priority,
 * an expiration and a collapse id (a conversation's pushes replace each
 * other on the lock screen).
 *
 * What Apple answers, as {@link ApnsResult}:
 *   200                 sent
 *   410, or 400 BadDeviceToken / DeviceTokenNotForTopic   gone: the install
 *                       is stopped (the caller disables its token)
 *   403 ExpiredProviderToken   a fresh token and one retry
 *   anything else       failed (the caller may fall through to email)
 *
 * Privacy: logs carry statuses and Apple's reason only, never a token, a
 * title or a word of the message.
 */
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto'
import { connect, constants, type ClientHttp2Session, type SecureClientSessionOptions } from 'node:http2'

export type ApnsEnvironment = 'sandbox' | 'production'

export interface ApnsConfig {
  keyId: string
  teamId: string
  /** The .p8 key, PEM. */
  privateKey: string
  bundleId: string
}

/** Apple's hosts, by the environment an install's token was issued in. */
export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

/** A provider token is made again after this long (Apple: at most an hour old, no more often than every 20 minutes). */
export const APNS_TOKEN_REFRESH_MS = 50 * 60_000
/** A connection nobody used for this long is closed. */
export const APNS_IDLE_MS = 5 * 60_000
/** How long one request may take. */
export const APNS_REQUEST_TIMEOUT_MS = 15_000
/** How long Apple keeps trying a device that is off (seconds, from now). */
export const APNS_EXPIRATION_S = 24 * 60 * 60
/** Apple's cap on an alert's payload. */
export const APNS_MAX_PAYLOAD_BYTES = 4096
/** Apple's cap on a collapse id. */
export const APNS_COLLAPSE_ID_MAX_BYTES = 64

/** The four settings, or null when any is missing (push is off). Newlines written as \n are real ones. */
export function apnsConfig(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim()
  const teamId = env.APNS_TEAM_ID?.trim()
  const bundleId = env.APNS_BUNDLE_ID?.trim()
  const privateKey = env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n').trim()
  if (!keyId || !teamId || !bundleId || !privateKey) return null
  return { keyId, teamId, bundleId, privateKey }
}

/** One push, as the sender takes it. */
export interface ApnsNotification {
  title: string
  body: string
  /** The app icon's badge; omitted: left as it is. */
  badge?: number
  /** Groups the pushes of one conversation in Notification Center. */
  threadId?: string
  /** A newer push with the same id replaces this one on the device (at most 64 bytes). */
  collapseId?: string
  /** What the app reads when the push is tapped (ids only). */
  data?: Record<string, string | number | boolean | null>
}

export type ApnsResult =
  | { ok: true; apnsId: string | null }
  | { ok: false; gone: true; status: number; reason: string }
  | { ok: false; gone: false; status: number; reason: string }

/** Apple's reasons that mean the install is gone for good. */
const GONE_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'])

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * The provider token: an ES256 JWT, header { alg, kid }, claims { iss, iat }
 * (seconds). The signature is the raw r||s pair JWS wants, not DER. Pure
 * given its inputs.
 */
export function apnsProviderToken(config: Pick<ApnsConfig, 'keyId' | 'teamId'>, key: KeyObject, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }))
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', new Uint8Array(Buffer.from(signingInput, 'utf8')), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${signature.toString('base64url')}`
}

/** Cut to at most `max` UTF-8 bytes on a character boundary. */
function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let out = ''
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > max) break
    out += ch
  }
  return out
}

/**
 * The JSON Apple gets: `aps` (the alert, the badge, the sound, the thread)
 * and the app's own keys beside it. A body too long for Apple's cap is cut
 * (it is already short: a notification's excerpt). Pure.
 */
export function apnsPayload(n: ApnsNotification): string {
  const build = (body: string) =>
    JSON.stringify({
      aps: {
        alert: { title: n.title, body },
        sound: 'default',
        ...(typeof n.badge === 'number' && Number.isFinite(n.badge) ? { badge: Math.max(0, Math.floor(n.badge)) } : {}),
        ...(n.threadId ? { 'thread-id': n.threadId } : {}),
      },
      ...(n.data ?? {}),
    })
  let body = n.body
  let json = build(body)
  while (Buffer.byteLength(json) > APNS_MAX_PAYLOAD_BYTES && body.length > 0) {
    body = `${body.slice(0, Math.max(0, body.length - 200)).trimEnd()}…`
    if (body === '…') body = ''
    json = build(body)
  }
  return json
}

/** The headers of one push (the provider token's `authorization` is added by the sender). Pure. */
export function apnsHeaders(input: { topic: string; collapseId?: string; nowMs: number; apnsId?: string }): Record<string, string> {
  const collapse = input.collapseId ? cutBytes(input.collapseId, APNS_COLLAPSE_ID_MAX_BYTES) : ''
  return {
    'apns-push-type': 'alert',
    'apns-topic': input.topic,
    'apns-priority': '10',
    'apns-expiration': String(Math.floor(input.nowMs / 1000) + APNS_EXPIRATION_S),
    ...(collapse ? { 'apns-collapse-id': collapse } : {}),
    ...(input.apnsId ? { 'apns-id': input.apnsId } : {}),
  }
}

/** Apple's answer as a result. Pure. */
export function apnsResultOf(status: number, body: string, apnsId: string | null): ApnsResult {
  if (status === 200) return { ok: true, apnsId }
  let reason = ''
  try {
    const parsed = JSON.parse(body) as { reason?: unknown }
    reason = typeof parsed.reason === 'string' ? parsed.reason : ''
  } catch {
    reason = ''
  }
  const gone = status === 410 || (status === 400 && GONE_REASONS.has(reason))
  return gone ? { ok: false, gone: true, status, reason: reason || 'Unregistered' } : { ok: false, gone: false, status, reason: reason || `status ${status}` }
}

export interface ApnsSenderOptions {
  config: ApnsConfig
  /** Where each environment's pushes go (tests point both at a local server). */
  origins?: Partial<Record<ApnsEnvironment, string>>
  /** Extra TLS options for the connection (tests trust their own certificate). */
  connectOptions?: SecureClientSessionOptions
  now?: () => number
  requestTimeoutMs?: number
  idleMs?: number
}

export interface ApnsSender {
  send(input: { token: string; environment: ApnsEnvironment; notification: ApnsNotification }): Promise<ApnsResult>
  /** Close every connection (tests; a process going down). */
  close(): void
}

/** A sender over one config: its provider token cached, one connection per host. */
export function createApnsSender(options: ApnsSenderOptions): ApnsSender {
  const { config } = options
  const now = options.now ?? Date.now
  const origins = { ...APNS_ORIGINS, ...options.origins }
  const timeoutMs = options.requestTimeoutMs ?? APNS_REQUEST_TIMEOUT_MS
  const idleMs = options.idleMs ?? APNS_IDLE_MS
  let key: KeyObject | null = null
  let cached: { token: string; madeAt: number } | null = null
  const sessions = new Map<string, ClientHttp2Session>()

  const providerToken = (fresh = false): string => {
    const at = now()
    if (!fresh && cached && at - cached.madeAt < APNS_TOKEN_REFRESH_MS) return cached.token
    key ??= createPrivateKey(config.privateKey)
    cached = { token: apnsProviderToken(config, key, at), madeAt: at }
    return cached.token
  }

  const sessionFor = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const session = connect(origin, options.connectOptions)
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin)
    }
    session.on('error', forget)
    session.on('goaway', forget)
    session.on('close', forget)
    session.setTimeout(idleMs, () => {
      forget()
      session.close()
    })
    // An open connection never holds the process up.
    session.unref()
    sessions.set(origin, session)
    return session
  }

  const once = (input: { token: string; environment: ApnsEnvironment; notification: ApnsNotification }, jwt: string): Promise<ApnsResult> =>
    new Promise((resolve) => {
      let settled = false
      const done = (result: ApnsResult) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      let session: ClientHttp2Session
      try {
        session = sessionFor(origins[input.environment])
      } catch (err) {
        done({ ok: false, gone: false, status: 0, reason: err instanceof Error ? err.message : 'connect failed' })
        return
      }
      const payload = apnsPayload(input.notification)
      const req = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${input.token}`,
        authorization: `bearer ${jwt}`,
        'content-type': 'application/json',
        ...apnsHeaders({ topic: config.bundleId, collapseId: input.notification.collapseId, nowMs: now(), apnsId: randomUUID() }),
      })
      let status = 0
      let apnsId: string | null = null
      let body = ''
      req.setEncoding('utf8')
      req.setTimeout(timeoutMs, () => {
        req.close(constants.NGHTTP2_CANCEL)
        done({ ok: false, gone: false, status: 0, reason: 'timeout' })
      })
      req.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0
        const id = headers['apns-id']
        apnsId = typeof id === 'string' ? id : null
      })
      req.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk
      })
      req.on('end', () => done(apnsResultOf(status, body, apnsId)))
      req.on('error', (err) => done({ ok: false, gone: false, status: 0, reason: err.message || 'request failed' }))
      req.on('close', () => done({ ok: false, gone: false, status, reason: 'closed' }))
      req.end(payload)
    })

  return {
    async send(input) {
      if (!/^[0-9a-f]{64,200}$/.test(input.token)) return { ok: false, gone: true, status: 400, reason: 'BadDeviceToken' }
      let jwt: string
      try {
        jwt = providerToken()
      } catch {
        return { ok: false, gone: false, status: 0, reason: 'bad key' }
      }
      const first = await once(input, jwt)
      if (first.ok || first.status !== 403 || first.reason !== 'ExpiredProviderToken') return first
      // Apple says the token is too old: make one now and try once more.
      return once(input, providerToken(true))
    },
    close() {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    },
  }
}
