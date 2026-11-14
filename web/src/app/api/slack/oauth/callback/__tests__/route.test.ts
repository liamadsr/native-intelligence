/**
 * The Slack install's callback: a signed Slack-install state and this
 * browser's binding cookie before anything is exchanged; Slack's refusal and
 * our own failures come back as a plain result on the page the install began
 * on, never Slack's body; the cookie is spent; an answer that came to the
 * app's other domain is handed over unspent. Every id here is made up.
 */
import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubSlackEnv } from '@/test/slack'

const m = vi.hoisted(() => ({ complete: vi.fn() }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/slack/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/slack/install')>()),
  completeSlackInstall: m.complete,
}))

import { GET } from '../route'
import { buildSlackInstall } from '@/lib/slack/install'
import { oauthStateSecret } from '@/lib/oauth/state'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '33333333-3333-4333-8333-333333333333'
const COOKIE = 'slack_install_nonce'

function start(over: Partial<Parameters<typeof buildSlackInstall>[0]> = {}) {
  return buildSlackInstall({ userId: USER, workspaceId: WS, returnTo: '/account/settings/connectors/slack', ...over })
}

function callback(query: Record<string, string>, opts: { cookie?: string; host?: string } = {}) {
  const url = new URL(`https://${opts.host ?? 'nativeintelligence.dev'}/api/slack/oauth/callback`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new Request(url, { headers: opts.cookie ? { cookie: opts.cookie } : {} })
}

const resultOf = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('slack')
const cleared = (res: Response) => (res.headers.get('set-cookie') ?? '').includes(`${COOKIE}=;`)

beforeEach(() => {
  stubSlackEnv()
  vi.stubEnv('OAUTH_STATE_SECRET', 'made-up-state-secret')
  m.complete.mockReset().mockResolvedValue('installed')
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/slack/oauth/callback', () => {
  it('finishes an install started in this browser, and returns to its page with the result, the cookie spent', async () => {
    const { state, nonce } = start()
    const res = await GET(callback({ code: 'made-up-code', state }, { cookie: `${COOKIE}=${nonce}` }))
    expect(res.status).toBe(307)
    const to = new URL(res.headers.get('location')!)
    expect(`${to.origin}${to.pathname}`).toBe('https://nativeintelligence.dev/account/settings/connectors/slack')
    expect(to.searchParams.get('slack')).toBe('installed')
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), { code: 'made-up-code', userId: USER, workspaceId: WS }, expect.anything())
    expect(cleared(res)).toBe(true)
  })

  it('passes on what the finish found, as a result name only', async () => {
    for (const result of ['other_workspace', 'enterprise', 'added', 'failed'] as const) {
      m.complete.mockResolvedValueOnce(result)
      const { state, nonce } = start()
      expect(resultOf(await GET(callback({ code: 'c', state }, { cookie: `${COOKIE}=${nonce}` })))).toBe(result)
    }
  })

  it('refuses a missing, forged or expired state before anything is exchanged', async () => {
    const { state, nonce } = start()
    const cookie = `${COOKIE}=${nonce}`
    expect(resultOf(await GET(callback({ code: 'c' }, { cookie })))).toBe('failed')
    expect(resultOf(await GET(callback({ code: 'c', state: `${state}x` }, { cookie })))).toBe('failed')
    const old = start({ now: Date.now() - 11 * 60_000 })
    expect(resultOf(await GET(callback({ code: 'c', state: old.state }, { cookie: `${COOKIE}=${old.nonce}` })))).toBe('expired')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it("refuses another flow's signed state (not a Slack install's)", async () => {
    const nonce = crypto.randomUUID()
    const b64 = Buffer.from(JSON.stringify({ nonce, user_id: USER, capability: 'calendar', source: 'web', workspace_id: WS, exp: Date.now() + 60_000 })).toString('base64url')
    const state = `${b64}.${crypto.createHmac('sha256', oauthStateSecret()).update(b64).digest('base64url')}`
    expect(resultOf(await GET(callback({ code: 'c', state }, { cookie: `${COOKIE}=${nonce}` })))).toBe('failed')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a browser without the cookie, or with another install’s', async () => {
    const { state } = start()
    const other = start()
    expect(resultOf(await GET(callback({ code: 'c', state })))).toBe('session')
    expect(resultOf(await GET(callback({ code: 'c', state }, { cookie: `${COOKIE}=${other.nonce}` })))).toBe('session')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it("Slack's refusal comes back plainly: cancelled is 'denied', anything else 'failed'; never Slack's own words", async () => {
    const a = start()
    const denied = await GET(callback({ error: 'access_denied', state: a.state }, { cookie: `${COOKIE}=${a.nonce}` }))
    expect(resultOf(denied)).toBe('denied')
    expect(cleared(denied)).toBe(true)
    const b = start()
    const other = await GET(callback({ error: 'invalid_team_for_non_distributed_app', state: b.state }, { cookie: `${COOKIE}=${b.nonce}` }))
    expect(resultOf(other)).toBe('failed')
    expect(other.headers.get('location')).not.toContain('invalid_team')
    const c = start()
    expect(resultOf(await GET(callback({ state: c.state }, { cookie: `${COOKIE}=${c.nonce}` })))).toBe('failed')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it("hands an answer that came to the app's other domain over to the one the install began on, unspent", async () => {
    const { state, nonce } = start({ pageOrigin: 'https://dial8.ai' })
    const res = await GET(callback({ code: 'c', state }, { cookie: `${COOKIE}=${nonce}`, host: 'nativeintelligence.dev' }))
    const to = new URL(res.headers.get('location')!)
    expect(`${to.origin}${to.pathname}`).toBe('https://dial8.ai/api/slack/oauth/callback')
    expect(to.searchParams.get('handed')).toBe('1')
    expect(to.searchParams.get('code')).toBe('c')
    expect(m.complete).not.toHaveBeenCalled()

    // There, it finishes and returns to that domain's page.
    const there = await GET(new Request(to, { headers: { cookie: `${COOKIE}=${nonce}` } }))
    expect(new URL(there.headers.get('location')!).origin).toBe('https://dial8.ai')
    expect(m.complete).toHaveBeenCalledTimes(1)
  })

  it('says Slack is unavailable when it is not configured', async () => {
    stubSlackEnv({ SLACK_SIGNING_SECRET: '' })
    const { state, nonce } = start()
    expect(resultOf(await GET(callback({ code: 'c', state }, { cookie: `${COOKIE}=${nonce}` })))).toBe('unavailable')
    expect(m.complete).not.toHaveBeenCalled()
  })
})
