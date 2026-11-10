import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHATGPT_PLAN_RESOURCE, DYNAMIC_CLIENT_ID, type ChatGptClient } from '../config'
import {
  authorizeUrl,
  createTransaction,
  exchangeClientId,
  exchangeCode,
  IdTokenError,
  openTransaction,
  resetJwksCacheForTests,
  sealTransaction,
  stateMatches,
  verifyIdToken,
} from '../oidc'

const partner: ChatGptClient = { clientId: 'oaiapp_partner', clientSecret: 's3cret', hostId: null }
const selfServe: ChatGptClient = { clientId: DYNAMIC_CLIENT_ID, clientSecret: null, hostId: 'urn:uuid:host-1' }
const REDIRECT = 'https://nativeintelligence.dev/auth/chatgpt/callback'

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})

describe('transaction', () => {
  it('round-trips through the sealed cookie and expires', () => {
    const tx = createTransaction(partner, { desktop: false, bind: null, redirectUri: REDIRECT }, 1_000)
    const sealed = sealTransaction(tx)
    expect(sealed).not.toContain(tx.verifier)
    expect(openTransaction(sealed, 2_000)).toEqual(tx)
    expect(openTransaction(sealed, tx.expiresAt + 1)).toBeNull()
  })

  it('refuses a missing or tampered cookie', () => {
    const sealed = sealTransaction(createTransaction(partner, { desktop: false, bind: null, redirectUri: REDIRECT }))
    expect(openTransaction(undefined)).toBeNull()
    expect(openTransaction(`${sealed.slice(0, -4)}AAAA`)).toBeNull()
    expect(openTransaction('not-a-seal')).toBeNull()
  })

  it('keeps a bind only for the desktop', () => {
    const bind = 'a'.repeat(48)
    expect(createTransaction(partner, { desktop: false, bind, redirectUri: REDIRECT }).bind).toBeNull()
    expect(createTransaction(partner, { desktop: true, bind, redirectUri: REDIRECT }).bind).toBe(bind)
  })

  it('matches state exactly', () => {
    const tx = createTransaction(partner, { desktop: false, bind: null, redirectUri: REDIRECT })
    expect(stateMatches(tx, tx.state)).toBe(true)
    expect(stateMatches(tx, `${tx.state}x`)).toBe(false)
    expect(stateMatches(tx, null)).toBe(false)
  })
})

describe('authorizeUrl', () => {
  it('asks a partner client for sign-in and plan usage, with PKCE and resource', () => {
    const tx = createTransaction(partner, { desktop: false, bind: null, redirectUri: REDIRECT })
    const url = new URL(authorizeUrl(partner, tx))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    const q = url.searchParams
    expect(q.get('client_id')).toBe('oaiapp_partner')
    expect(q.get('redirect_uri')).toBe(REDIRECT)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']),
    )
    expect(q.get('resource')).toBe(CHATGPT_PLAN_RESOURCE)
    expect(q.get('state')).toBe(tx.state)
    expect(q.get('nonce')).toBe(tx.nonce)
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.has('ext_agent_host_id')).toBe(false)
    expect(q.has('agent_name_hint')).toBe(false)
  })

  it('names the host on every self-serve request, and the app only when registering', () => {
    const registering = new URL(
      authorizeUrl(selfServe, createTransaction(selfServe, { desktop: false, bind: null, redirectUri: REDIRECT })),
    ).searchParams
    expect(registering.get('client_id')).toBe(DYNAMIC_CLIENT_ID)
    expect(registering.get('ext_agent_host_id')).toBe('urn:uuid:host-1')
    expect(registering.get('agent_name_hint')).toBe('Native Intelligence')

    const issued = { ...selfServe, clientId: 'oaiapp_issued' }
    const returning = new URL(
      authorizeUrl(issued, createTransaction(issued, { desktop: false, bind: null, redirectUri: REDIRECT })),
    ).searchParams
    expect(returning.get('ext_agent_host_id')).toBe('urn:uuid:host-1')
    expect(returning.has('agent_name_hint')).toBe(false)
  })
})

describe('exchangeClientId', () => {
  const tx = (clientId: string) => ({ ...createTransaction(partner, { desktop: false, bind: null, redirectUri: REDIRECT }), clientId })
  it('adopts the id a self-serve registration returns', () => {
    expect(exchangeClientId(tx(DYNAMIC_CLIENT_ID), 'oaiapp_new')).toBe('oaiapp_new')
    expect(exchangeClientId(tx(DYNAMIC_CLIENT_ID), null)).toBeNull()
    expect(exchangeClientId(tx(DYNAMIC_CLIENT_ID), DYNAMIC_CLIENT_ID)).toBeNull()
  })
  it('keeps the requested client and refuses a different one', () => {
    expect(exchangeClientId(tx('oaiapp_partner'), null)).toBe('oaiapp_partner')
    expect(exchangeClientId(tx('oaiapp_partner'), 'oaiapp_partner')).toBe('oaiapp_partner')
    expect(exchangeClientId(tx('oaiapp_partner'), 'oaiapp_other')).toBeNull()
  })
})

describe('exchangeCode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends resource and the verifier, and authenticates a confidential client with Basic only', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const tx = createTransaction(partner, { desktop: false, bind: null, redirectUri: REDIRECT })
    const tokens = await exchangeCode(partner, 'oaiapp_partner', 'the-code', tx)

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', idToken: 'it', expiresIn: 3600, scopes: ['openid', 'chatgpt.tokens.use.direct'] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token')
    const form = new URLSearchParams(String(init.body))
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT,
      client_id: 'oaiapp_partner',
      code_verifier: tx.verifier,
      resource: CHATGPT_PLAN_RESOURCE,
    })
    expect(form.has('client_secret')).toBe(false)
    const auth = (init.headers as Record<string, string>).authorization
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('oaiapp_partner:s3cret')
  })

  it('sends no secret for a public client and surfaces OpenAI errors', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const tx = createTransaction(selfServe, { desktop: false, bind: null, redirectUri: REDIRECT })
    await expect(exchangeCode(selfServe, 'oaiapp_issued', 'c', tx)).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
    const init = fetchMock.mock.calls[0][1] as unknown as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })
})

describe('verifyIdToken', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  const nowS = 1_800_000_000

  function token(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey } = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_partner', sub: 'user-sub', iat: nowS, exp: nowS + 3600, nonce: 'n1', ...claims }),
    ).toString('base64url')
    const sig = sign('sha256', new TextEncoder().encode(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url')
    return `${header}.${payload}.${sig}`
  }

  beforeEach(() => {
    resetJwksCacheForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('returns the identity of a valid token', async () => {
    const id = await verifyIdToken(token({ email: 'a@b.co', email_verified: true, name: ' Ada ' }), 'oaiapp_partner', 'n1', nowS * 1000)
    expect(id).toEqual({ sub: 'user-sub', email: 'a@b.co', emailVerified: true, name: 'Ada' })
  })

  it.each([
    ['audience', { aud: 'oaiapp_other' }, 'n1'],
    ['issuer', { iss: 'https://evil.example' }, 'n1'],
    ['expiry', { exp: nowS - 60 }, 'n1'],
    ['nonce', {}, 'other-nonce'],
    ['subject', { sub: '' }, 'n1'],
  ])('rejects a bad %s', async (_label, claims, nonce) => {
    await expect(verifyIdToken(token(claims), 'oaiapp_partner', nonce, nowS * 1000)).rejects.toBeInstanceOf(IdTokenError)
  })

  it('rejects a token signed by another key, or with an unknown kid', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    await expect(verifyIdToken(token({}, { key: other }), 'oaiapp_partner', 'n1', nowS * 1000)).rejects.toThrow(/signature/)
    await expect(verifyIdToken(token({}, { kid: 'k-unknown' }), 'oaiapp_partner', 'n1', nowS * 1000)).rejects.toThrow(/JWKS/)
  })
})
