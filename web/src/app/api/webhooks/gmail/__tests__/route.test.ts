/**
 * POST /api/webhooks/gmail goes through the push check (./push-auth.ts) before
 * reading anything: with GMAIL_PUSH_SERVICE_ACCOUNT set, Google's ID token is
 * required and the static ?token= no longer lets a push in.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  from: vi.fn(),
  keys: null as JWTVerifyGetKey | null,
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: hoisted.from }) }))
// Google's published keys, stood in for by a local key set (nothing is fetched).
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>()
  return { ...actual, createRemoteJWKSet: () => ((...args: Parameters<JWTVerifyGetKey>) => hoisted.keys!(...args)) as JWTVerifyGetKey }
})

const { POST } = await import('../route')

const SA = 'gmail-push@dial8-prod.iam.gserviceaccount.com'
let privateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  hoisted.keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] })
})

beforeEach(() => {
  hoisted.send.mockReset().mockResolvedValue(undefined)
  hoisted.from.mockReset().mockImplementation(() => {
    const q: Record<string, unknown> = {}
    q.select = () => q
    q.eq = () => q
    q.limit = () => q
    q.maybeSingle = async () => ({ data: { id: 'acc-1', user_id: 'user-1', workspace_id: 'ws-1' }, error: null })
    return q
  })
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  vi.stubEnv('GMAIL_WEBHOOK_TOKEN', 'sekret')
  vi.stubEnv('GMAIL_PUSH_SERVICE_ACCOUNT', SA)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function push(headers: Record<string, string> = {}): Request {
  const data = Buffer.from(JSON.stringify({ emailAddress: 'me@gmail.com', historyId: 7 })).toString('base64')
  return new Request('https://dial8.ai/api/webhooks/gmail?token=sekret', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message: { data } }),
  })
}

const idToken = () =>
  new SignJWT({ email: SA, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://accounts.google.com')
    .setAudience('https://dial8.ai/api/webhooks/gmail?token=sekret')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

describe('POST /api/webhooks/gmail with GMAIL_PUSH_SERVICE_ACCOUNT set', () => {
  it('refuses a push that has only the static token: 401, nothing read or sent', async () => {
    expect((await POST(push())).status).toBe(401)
    expect(hoisted.from).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it("serves a push carrying Google's ID token for the push service account", async () => {
    expect((await POST(push({ authorization: `Bearer ${await idToken()}` }))).status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'email/webhook-received' }))
  })
})
