/**
 * The Slack install's callback: a signed Slack-install state and this
 * browser's binding cookie before anything is exchanged; Slack's refusal and
 * our own failures come back as a plain result on the page the install began
 * on, never Slack's body; the cookie is spent; an answer that came to the
 * app's other domain is handed over unspent. A desktop install is never
 * finished here: its code goes back to the app sealed. Every id here is made up.
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
import { oauthStateSecret, openDesktopCode, verifyOAuthState } from '@/lib/oauth/state'

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

  it('a web state is still refused without its cookie, and still answers on the web page', async () => {
    const { state } = start({ source: 'web' })
    const res = await GET(callback({ code: 'c', state }))
    expect(resultOf(res)).toBe('session')
    expect(res.headers.get('location')!.startsWith('https://')).toBe(true)
    expect(m.complete).not.toHaveBeenCalled()
  })
})

describe('GET /api/slack/oauth/callback, an install started in the desktop app', () => {
  const desktop = () => start({ source: 'desktop' })
  const link = (res: Response) => new URL(res.headers.get('location')!)

  it('never exchanges the code nor needs a cookie: it goes back to the app sealed, with the state', async () => {
    const { state, nonce } = desktop()
    const res = await GET(callback({ code: 'made-up-code', state }))
    expect(res.status).toBe(307)
    const to = link(res)
    expect(to.protocol).toBe('dial8desktop:')
    expect(`${to.host}${to.pathname}`).toBe('slack/complete')
    expect(to.searchParams.get('state')).toBe(state)
    const sealed = to.searchParams.get('sealed')!
    expect(sealed).not.toContain('made-up-code')
    expect(openDesktopCode(sealed, nonce)).toBe('made-up-code')
    // Only this state's nonce opens it.
    expect(openDesktopCode(sealed, desktop().nonce)).toBeNull()
    expect(to.searchParams.get('code')).toBeNull()
    expect(m.complete).not.toHaveBeenCalled()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it("does not read the cookie: even the right one does not finish it in this browser", async () => {
    const { state, nonce } = desktop()
    const res = await GET(callback({ code: 'c', state }, { cookie: `${COOKIE}=${nonce}` }))
    expect(link(res).protocol).toBe('dial8desktop:')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it("Slack's refusal and a missing code go back to the app as a result: denied for a cancel, failed otherwise", async () => {
    const a = desktop()
    const denied = link(await GET(callback({ error: 'access_denied', state: a.state })))
    expect(`${denied.protocol}//${denied.host}${denied.pathname}`).toBe('dial8desktop://slack/error')
    expect(denied.searchParams.get('error')).toBe('denied')
    expect(denied.searchParams.get('state')).toBe(a.state)

    const b = desktop()
    const other = link(await GET(callback({ error: 'invalid_team_for_non_distributed_app', state: b.state })))
    expect(other.searchParams.get('error')).toBe('failed')
    expect(other.href).not.toContain('invalid_team')

    const c = desktop()
    const missing = link(await GET(callback({ state: c.state })))
    expect(`${missing.host}${missing.pathname}`).toBe('slack/error')
    expect(missing.searchParams.get('error')).toBe('failed')
    expect(missing.searchParams.get('sealed')).toBeNull()

    const d = desktop()
    expect(link(await GET(callback({ code: 'x'.repeat(501), state: d.state }))).searchParams.get('error')).toBe('failed')
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a desktop state without a claim hash: nobody could claim its code', async () => {
    const nonce = crypto.randomUUID()
    const b64 = Buffer.from(
      JSON.stringify({ nonce, user_id: USER, capability: 'slack_install', source: 'desktop', workspace_id: WS, exp: Date.now() + 60_000 }),
    ).toString('base64url')
    const state = `${b64}.${crypto.createHmac('sha256', oauthStateSecret()).update(b64).digest('base64url')}`
    expect(verifyOAuthState(state).ok).toBe(true)
    const to = link(await GET(callback({ code: 'c', state })))
    expect(`${to.protocol}//${to.host}${to.pathname}`).toBe('dial8desktop://slack/error')
    expect(to.searchParams.get('error')).toBe('failed')
    expect(to.searchParams.get('sealed')).toBeNull()
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('a desktop state that does not verify goes to the web page, as any other', async () => {
    const { state } = desktop()
    const to = link(await GET(callback({ code: 'c', state: `${state}x` })))
    expect(to.protocol).toBe('https:')
    expect(to.searchParams.get('slack')).toBe('failed')
    const old = start({ source: 'desktop', now: Date.now() - 11 * 60_000 })
    expect(resultOf(await GET(callback({ code: 'c', state: old.state })))).toBe('expired')
    expect(m.complete).not.toHaveBeenCalled()
  })
})
