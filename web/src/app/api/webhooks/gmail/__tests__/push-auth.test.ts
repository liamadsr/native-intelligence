/**
 * Who may post a Gmail push (push-auth.ts): with GMAIL_PUSH_SERVICE_ACCOUNT
 * set, only a Google ID token for that service account and our audience;
 * until then, the static `?token=`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { pushAudience, verifyGmailPush } from '../push-auth'

const SA = 'gmail-push@dial8-prod.iam.gserviceaccount.com'
const AUD = 'https://dial8.ai/api/webhooks/gmail'

let google: { privateKey: CryptoKey; keys: JWTVerifyGetKey }
let stranger: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'google-1', alg: 'RS256' }
  google = { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }) }
  stranger = (await generateKeyPair('RS256')).privateKey
})

/** Every `[gmail-push]` line logged since the test began. */
let warned: string[]

beforeEach(() => {
  warned = []
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void warned.push(String(m)))
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  vi.stubEnv('GMAIL_PUSH_SERVICE_ACCOUNT', SA)
  vi.stubEnv('GMAIL_PUSH_AUDIENCE', '')
  vi.stubEnv('GMAIL_WEBHOOK_TOKEN', '')
  vi.stubEnv('VERCEL_ENV', 'production')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function idToken(
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; kid?: string; issuer?: string; audience?: string; expiresIn?: string | number } = {},
): Promise<string> {
  return new SignJWT({ email: SA, email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'google-1' })
    .setIssuer(opts.issuer ?? 'https://accounts.google.com')
    .setAudience(opts.audience ?? AUD)
    .setSubject('1234567890')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(opts.key ?? google.privateKey)
}

function push(headers: Record<string, string> = {}, url = 'https://dial8.ai/api/webhooks/gmail'): Request {
  return new Request(url, { method: 'POST', headers })
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('verifyGmailPush with GMAIL_PUSH_SERVICE_ACCOUNT set', () => {
  it("accepts Google's ID token for the push service account and our endpoint", async () => {
    expect(await verifyGmailPush(push(bearer(await idToken())), google.keys)).toBe(true)
    expect(await verifyGmailPush(push(bearer(await idToken({}, { issuer: 'accounts.google.com' }))), google.keys)).toBe(true)
  })

  it('refuses a push with no token, or a malformed one', async () => {
    expect(await verifyGmailPush(push(), google.keys)).toBe(false)
    expect(await verifyGmailPush(push({ authorization: 'Bearer ' }), google.keys)).toBe(false)
    expect(await verifyGmailPush(push(bearer('not.a.jwt')), google.keys)).toBe(false)
  })

  it('refuses a token not signed by Google', async () => {
    expect(await verifyGmailPush(push(bearer(await idToken({}, { key: stranger }))), google.keys)).toBe(false)
  })

  it('refuses another audience, another issuer, or an expired token', async () => {
    expect(await verifyGmailPush(push(bearer(await idToken({}, { audience: 'https://attacker.example/push' }))), google.keys)).toBe(false)
    expect(await verifyGmailPush(push(bearer(await idToken({}, { issuer: 'https://evil.example' }))), google.keys)).toBe(false)
    const past = Math.floor(Date.now() / 1000) - 3600
    expect(await verifyGmailPush(push(bearer(await idToken({}, { expiresIn: past }))), google.keys)).toBe(false)
  })

  it('refuses another service account, or an unverified email', async () => {
    expect(await verifyGmailPush(push(bearer(await idToken({ email: 'someone@other-project.iam.gserviceaccount.com' }))), google.keys)).toBe(false)
    expect(await verifyGmailPush(push(bearer(await idToken({ email_verified: false }))), google.keys)).toBe(false)
    expect(await verifyGmailPush(push(bearer(await idToken({ email_verified: 'true' }))), google.keys)).toBe(false)
    expect(await verifyGmailPush(push(bearer(await idToken({ email: undefined }))), google.keys)).toBe(false)
  })

  it('no longer takes the static token in place of the ID token', async () => {
    vi.stubEnv('GMAIL_WEBHOOK_TOKEN', 'sekret')
    expect(await verifyGmailPush(push({}, 'https://dial8.ai/api/webhooks/gmail?token=sekret'), google.keys)).toBe(false)
  })

  it("matches our endpoint on origin and path: Pub/Sub's default audience is the endpoint URL, ?token= included", async () => {
    const withQuery = await idToken({}, { audience: 'https://dial8.ai/api/webhooks/gmail?token=sekret' })
    expect(await verifyGmailPush(push(bearer(withQuery)), google.keys)).toBe(true)
    for (const audience of ['https://dial8.ai/api/webhooks/outlook', 'https://www.dial8.ai/api/webhooks/gmail', 'http://dial8.ai/api/webhooks/gmail', 'https://dial8.ai.evil.example/api/webhooks/gmail', 'not a url']) {
      expect(await verifyGmailPush(push(bearer(await idToken({}, { audience }))), google.keys)).toBe(false)
    }
  })

  it('logs why a push was refused, never the token', async () => {
    const cases: [string, Promise<string>][] = [
      ['audience', idToken({}, { audience: 'https://attacker.example/push' })],
      ['issuer', idToken({}, { issuer: 'https://evil.example' })],
      ['email', idToken({ email: 'someone@other-project.iam.gserviceaccount.com' })],
      ['email_unverified', idToken({ email_verified: false })],
      ['signature', idToken({}, { key: stranger })],
      ['expired', idToken({}, { expiresIn: Math.floor(Date.now() / 1000) - 3600 })],
      ['malformed', Promise.resolve('not.a.jwt')],
    ]
    for (const [reason, pending] of cases) {
      warned = []
      const token = await pending
      expect(await verifyGmailPush(push(bearer(token)), google.keys)).toBe(false)
      expect(warned).toEqual([`[gmail-push] refused: ${reason}`])
      expect(warned.join(' ')).not.toContain(token)
    }
    warned = []
    await verifyGmailPush(push(), google.keys)
    expect(warned).toEqual(['[gmail-push] refused: no_token'])
  })

  it('uses GMAIL_PUSH_AUDIENCE when set, and refuses everything when no audience is known', async () => {
    vi.stubEnv('GMAIL_PUSH_AUDIENCE', 'https://www.dial8.ai/api/webhooks/gmail')
    expect(await verifyGmailPush(push(bearer(await idToken({}, { audience: 'https://www.dial8.ai/api/webhooks/gmail' }))), google.keys)).toBe(true)
    expect(await verifyGmailPush(push(bearer(await idToken())), google.keys)).toBe(false)
    // A configured audience is compared exactly: no query let through.
    expect(await verifyGmailPush(push(bearer(await idToken({}, { audience: 'https://www.dial8.ai/api/webhooks/gmail?token=x' }))), google.keys)).toBe(false)
    vi.stubEnv('GMAIL_PUSH_AUDIENCE', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(pushAudience()).toBeNull()
    expect(await verifyGmailPush(push(bearer(await idToken())), google.keys)).toBe(false)
    expect(warned.at(-1)).toBe('[gmail-push] refused: no_audience')
  })
})

describe('verifyGmailPush until GMAIL_PUSH_SERVICE_ACCOUNT is set: the static ?token=', () => {
  beforeEach(() => vi.stubEnv('GMAIL_PUSH_SERVICE_ACCOUNT', ''))

  it('accepts the matching token and refuses any other', async () => {
    vi.stubEnv('GMAIL_WEBHOOK_TOKEN', 'sekret')
    expect(await verifyGmailPush(push({}, 'https://dial8.ai/api/webhooks/gmail?token=sekret'))).toBe(true)
    expect(await verifyGmailPush(push({}, 'https://dial8.ai/api/webhooks/gmail?token=nope'))).toBe(false)
    expect(await verifyGmailPush(push())).toBe(false)
  })

  it('fails closed with no token in production, and lets local dev in', async () => {
    expect(await verifyGmailPush(push())).toBe(false)
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'test')
    expect(await verifyGmailPush(push())).toBe(true)
  })
})
