import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptCredential } from '@/lib/crypto/credentials'
import { connectedUserId, getPlanAccessToken, saveConnection, setConnectionStatus } from '../connection'
import { fakeService, type FakeService } from './fake-service'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const identity = { sub: 'sub-1', email: 'ada@example.com', emailVerified: true, name: 'Ada' }
const tokens = (over: Partial<{ accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] }> = {}) => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  idToken: 'id',
  expiresIn: 3600,
  scopes: ['openid', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
  ...over,
})

let svc: FakeService
let fetchMock: ReturnType<typeof vi.fn>

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})

beforeEach(() => {
  vi.stubEnv('CHATGPT_CLIENT_ID', 'oaiapp_partner')
  vi.stubEnv('CHATGPT_CLIENT_SECRET', 'secret')
  vi.stubEnv('CHATGPT_DEV_HOST_ID', '')
  svc = fakeService()
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' })),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A token endpoint that answers when the test says so. */
function deferredRefresh() {
  let resolve!: (res: Response) => void
  const answer = new Promise<Response>((r) => {
    resolve = r
  })
  return { fetch: () => answer, resolve }
}

/** A promise and whether it has settled yet. */
function settled<T>(promise: Promise<T>) {
  const out = { promise, done: false }
  void promise.finally(() => {
    out.done = true
  })
  return out
}

async function connect(over: Parameters<typeof tokens>[0] = {}, now = NOW) {
  await saveConnection(svc.client, { userId: 'u1', identity, clientId: 'oaiapp_partner', tokens: tokens(over) }, now)
}

describe('saveConnection', () => {
  it('stores the tokens encrypted, with the plan grant and identity', async () => {
    await connect()
    const row = svc.rows.get('u1')!
    expect(row.access_token_enc).not.toContain('at-1')
    expect(decryptCredential(row.access_token_enc as string)).toBe('at-1')
    expect(decryptCredential(row.refresh_token_enc as string)).toBe('rt-1')
    expect(row).toMatchObject({ issuer: 'https://auth.openai.com', subject: 'sub-1', plan_enabled: true, status: 'active' })
    expect(await connectedUserId(svc.client, 'sub-1')).toBe('u1')
    expect(await connectedUserId(svc.client, 'other')).toBeNull()
  })

  it('marks a grant without the plan scope as not plan-enabled', async () => {
    await connect({ scopes: ['openid', 'email'] })
    expect(svc.rows.get('u1')!.plan_enabled).toBe(false)
    expect(await getPlanAccessToken(svc.client, 'u1', () => NOW)).toEqual({ ok: false, reason: 'not_enabled' })
  })
})

describe('getPlanAccessToken', () => {
  it('returns a fresh token without refreshing', async () => {
    await connect()
    expect(await getPlanAccessToken(svc.client, 'u1', () => NOW + 60_000)).toEqual({ ok: true, accessToken: 'at-1', status: 'active' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes near expiry, stores the rotated tokens and frees the lease', async () => {
    await connect({ expiresIn: 200 })
    const result = await getPlanAccessToken(svc.client, 'u1', () => NOW)
    expect(result).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })

    const form = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'oaiapp_partner',
      resource: 'https://api.openai.com/v1',
    })
    const row = svc.rows.get('u1')!
    expect(decryptCredential(row.access_token_enc as string)).toBe('at-2')
    expect(decryptCredential(row.refresh_token_enc as string)).toBe('rt-2')
    expect(row.refresh_lease_until).toBeNull()
  })

  it('refreshes once when two callers race; the loser reads the winner’s token', async () => {
    await connect({ expiresIn: 200 })
    let release!: () => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })))
        }),
    )
    const first = getPlanAccessToken(svc.client, 'u1', () => NOW)
    await new Promise((r) => setTimeout(r, 0))
    const second = getPlanAccessToken(svc.client, 'u1', () => NOW)
    await new Promise((r) => setTimeout(r, 50))
    release()
    expect(await first).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })
    expect(await second).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("waits out another caller's slow refresh (18 s on DEV, 10-21) rather than answering busy", async () => {
    await connect({ expiresIn: 200 })
    const slow = deferredRefresh()
    fetchMock.mockImplementationOnce(slow.fetch)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const first = getPlanAccessToken(svc.client, 'u1', () => NOW)
      await vi.advanceTimersByTimeAsync(1)
      const second = settled(getPlanAccessToken(svc.client, 'u1', () => NOW))
      await vi.advanceTimersByTimeAsync(18_000)
      expect(second.done).toBe(false)
      slow.resolve(new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })))
      await vi.advanceTimersByTimeAsync(800)
      expect(await first).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })
      expect(await second.promise).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("takes the lease and refreshes itself when the holder's refresh failed", async () => {
    await connect({ expiresIn: 200 })
    const failing = deferredRefresh()
    fetchMock.mockImplementationOnce(failing.fetch)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const first = getPlanAccessToken(svc.client, 'u1', () => NOW)
      await vi.advanceTimersByTimeAsync(1)
      const second = getPlanAccessToken(svc.client, 'u1', () => NOW)
      await vi.advanceTimersByTimeAsync(1_000)
      failing.resolve(new Response('upstream', { status: 503 }))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await first).toEqual({ ok: false, reason: 'refresh_failed' })
      expect(await second).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(svc.rows.get('u1')).toMatchObject({ status: 'active', refresh_lease_until: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes over a lease whose holder died (the lease ran out)', async () => {
    await connect({ expiresIn: 200 })
    fetchMock.mockImplementationOnce(deferredRefresh().fetch) // never answers
    let t = NOW
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      void getPlanAccessToken(svc.client, 'u1', () => t)
      await vi.advanceTimersByTimeAsync(1)
      const second = getPlanAccessToken(svc.client, 'u1', () => t)
      await vi.advanceTimersByTimeAsync(1_000)
      t = NOW + 31_000
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await second).toEqual({ ok: true, accessToken: 'at-2', status: 'active' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("answers busy only after the lease's whole length, while the holder still holds it", async () => {
    await connect({ expiresIn: 200 })
    fetchMock.mockImplementationOnce(deferredRefresh().fetch) // never answers
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      void getPlanAccessToken(svc.client, 'u1', () => NOW)
      await vi.advanceTimersByTimeAsync(1)
      const second = settled(getPlanAccessToken(svc.client, 'u1', () => NOW))
      await vi.advanceTimersByTimeAsync(29_000)
      expect(second.done).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await second.promise).toEqual({ ok: false, reason: 'busy' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the connection revoked when the refresh token is dead', async () => {
    await connect({ expiresIn: 200 })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'refresh_token_reused' }), { status: 400 }))
    expect(await getPlanAccessToken(svc.client, 'u1', () => NOW)).toEqual({ ok: false, reason: 'revoked' })
    expect(svc.rows.get('u1')).toMatchObject({ status: 'revoked', refresh_lease_until: null })
  })

  it('keeps the connection on a temporary refresh failure', async () => {
    await connect({ expiresIn: 200 })
    fetchMock.mockResolvedValueOnce(new Response('upstream', { status: 503 }))
    expect(await getPlanAccessToken(svc.client, 'u1', () => NOW)).toEqual({ ok: false, reason: 'refresh_failed' })
    expect(svc.rows.get('u1')).toMatchObject({ status: 'active', refresh_lease_until: null })
  })

  it('says why there is no token', async () => {
    expect(await getPlanAccessToken(svc.client, 'nobody', () => NOW)).toEqual({ ok: false, reason: 'not_connected' })
    await connect()
    await setConnectionStatus(svc.client, 'u1', 'exhausted', 'usage limit', NOW)
    expect(svc.rows.get('u1')).toMatchObject({ status: 'exhausted', last_error: 'usage limit' })
    // Out of plan credits still tries: the retry costs Native Intelligence nothing.
    expect(await getPlanAccessToken(svc.client, 'u1', () => NOW)).toEqual({ ok: true, accessToken: 'at-1', status: 'exhausted' })
    await setConnectionStatus(svc.client, 'u1', 'revoked', 'invalid_grant', NOW)
    expect(await getPlanAccessToken(svc.client, 'u1', () => NOW)).toEqual({ ok: false, reason: 'revoked' })
  })
})
