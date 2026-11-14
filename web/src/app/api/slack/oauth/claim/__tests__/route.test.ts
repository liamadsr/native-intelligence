/**
 * The desktop Slack install's claim (POST /api/slack/oauth/claim): the code
 * the callback sealed is opened and the install finished only for the
 * webview's signed-in person the state names, presenting the claim secret
 * whose hash the state carries, with a desktop Slack-install state within its
 * claim grace. A web state is never claimable here. Every id here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubSlackEnv } from '@/test/slack'

const m = vi.hoisted(() => ({
  complete: vi.fn(),
  auth: { userId: '33333333-3333-4333-8333-333333333333' as string | null, via: 'cookie' as 'cookie' | 'jwt' | 'device' },
  deps: { made: 'up-deps' },
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ svc: true }) }))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => {
    if (!m.auth.userId) throw new Response('Unauthorized', { status: 401 })
    return { user: { id: m.auth.userId }, supabase: {}, via: m.auth.via }
  },
}))
vi.mock('@/lib/slack/deps', () => ({ slackInstallDeps: () => m.deps }))
vi.mock('@/lib/slack/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/slack/install')>()),
  completeSlackInstall: m.complete,
}))

import crypto from 'crypto'
import { POST } from '../route'
import { buildSlackInstall } from '@/lib/slack/install'
import { claimHash, oauthStateSecret, sealDesktopCode } from '@/lib/oauth/state'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '33333333-3333-4333-8333-333333333333'
const OTHER_USER = '44444444-4444-4444-8444-444444444444'

function desktopStart(over: Partial<Parameters<typeof buildSlackInstall>[0]> = {}) {
  const start = buildSlackInstall({ userId: USER, workspaceId: WS, source: 'desktop', ...over })
  return { ...start, claimSecret: start.claimSecret!, sealed: sealDesktopCode('made-up-code', start.nonce) }
}

function claim(body: unknown) {
  return new Request('https://nativeintelligence.dev/api/slack/oauth/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function answer(res: Response) {
  return { status: res.status, result: ((await res.json()) as { result?: string }).result }
}

/** A state signed with the real key, with any fields (to build shapes buildSlackInstall never makes). */
function signed(fields: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(fields)).toString('base64url')
  return `${b64}.${crypto.createHmac('sha256', oauthStateSecret()).update(b64).digest('base64url')}`
}

beforeEach(() => {
  stubSlackEnv()
  vi.stubEnv('OAUTH_STATE_SECRET', 'made-up-state-secret')
  m.complete.mockReset().mockResolvedValue('installed')
  m.auth.userId = USER
  m.auth.via = 'cookie'
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('POST /api/slack/oauth/claim', () => {
  it("finishes the install with the opened code, for the state's person and workspace, and answers its result", async () => {
    const { state, claimSecret, sealed } = desktopStart()
    expect(await answer(await POST(claim({ sealed, state, claimSecret })))).toEqual({ status: 200, result: 'installed' })
    expect(m.complete).toHaveBeenCalledTimes(1)
    expect(m.complete).toHaveBeenCalledWith({ svc: true }, { code: 'made-up-code', userId: USER, workspaceId: WS }, m.deps)
  })

  it('answers whatever the finish found, with 200: the install was attempted', async () => {
    for (const result of ['not_admin', 'other_workspace', 'added', 'failed'] as const) {
      m.complete.mockResolvedValueOnce(result)
      const { state, claimSecret, sealed } = desktopStart()
      expect(await answer(await POST(claim({ sealed, state, claimSecret })))).toEqual({ status: 200, result })
    }
  })

  it('a bearer of the JWT session works too (the webview sends either)', async () => {
    m.auth.via = 'jwt'
    const { state, claimSecret, sealed } = desktopStart()
    expect((await answer(await POST(claim({ sealed, state, claimSecret })))).status).toBe(200)
  })

  it('says Slack is unavailable when it is not set up, before anything else', async () => {
    stubSlackEnv({ SLACK_SIGNING_SECRET: '' })
    const { state, claimSecret, sealed } = desktopStart()
    expect(await answer(await POST(claim({ sealed, state, claimSecret })))).toEqual({ status: 503, result: 'unavailable' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a caller who is not signed in, or signed in with a device token', async () => {
    const { state, claimSecret, sealed } = desktopStart()
    m.auth.userId = null
    expect(await answer(await POST(claim({ sealed, state, claimSecret })))).toEqual({ status: 401, result: 'session' })
    m.auth.userId = USER
    m.auth.via = 'device'
    expect(await answer(await POST(claim({ sealed, state, claimSecret })))).toEqual({ status: 401, result: 'session' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON or lacks the sealed code or the state', async () => {
    const { state, claimSecret, sealed } = desktopStart()
    expect(await answer(await POST(claim('not json')))).toEqual({ status: 400, result: 'failed' })
    expect(await answer(await POST(claim({ state, claimSecret })))).toEqual({ status: 400, result: 'failed' })
    expect(await answer(await POST(claim({ sealed, claimSecret })))).toEqual({ status: 400, result: 'failed' })
    expect(await answer(await POST(claim({ sealed: 3, state, claimSecret })))).toEqual({ status: 400, result: 'failed' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a forged state, and a state past its life and the claim grace', async () => {
    const { state, claimSecret, sealed } = desktopStart()
    expect(await answer(await POST(claim({ sealed, state: `${state}x`, claimSecret })))).toEqual({ status: 400, result: 'failed' })
    const old = desktopStart({ now: Date.now() - (10 + 5) * 60_000 - 1_000 })
    expect(await answer(await POST(claim({ sealed: old.sealed, state: old.state, claimSecret: old.claimSecret })))).toEqual({ status: 400, result: 'expired' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('lets a claim finish within the grace after the state expired (the callback passed in time)', async () => {
    const late = desktopStart({ now: Date.now() - 12 * 60_000 })
    expect(await answer(await POST(claim({ sealed: late.sealed, state: late.state, claimSecret: late.claimSecret })))).toEqual({ status: 200, result: 'installed' })
  })

  it('never claims a web install, which is bound to its browser’s cookie', async () => {
    const web = buildSlackInstall({ userId: USER, workspaceId: WS, source: 'web' })
    const res = await POST(claim({ sealed: sealDesktopCode('made-up-code', web.nonce), state: web.state, claimSecret: 'anything' }))
    expect(await answer(res)).toEqual({ status: 400, result: 'session' })
    // Not even a web-shaped state that somehow carries a claim hash.
    const secret = 'made-up-claim-secret'
    const nonce = crypto.randomUUID()
    const forgedWeb = signed({ nonce, user_id: USER, capability: 'slack_install', source: 'web', workspace_id: WS, exp: Date.now() + 60_000, claim: claimHash(secret) })
    expect(await answer(await POST(claim({ sealed: sealDesktopCode('c', nonce), state: forgedWeb, claimSecret: secret })))).toEqual({ status: 400, result: 'session' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it("refuses another flow's desktop state (not a Slack install's)", async () => {
    const secret = 'made-up-claim-secret'
    const nonce = crypto.randomUUID()
    const state = signed({ nonce, user_id: USER, capability: 'calendar', source: 'desktop', workspace_id: WS, exp: Date.now() + 60_000, claim: claimHash(secret) })
    expect(await answer(await POST(claim({ sealed: sealDesktopCode('c', nonce), state, claimSecret: secret })))).toEqual({ status: 400, result: 'failed' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a desktop state without a claim hash or a workspace', async () => {
    const nonce = crypto.randomUUID()
    const base = { nonce, user_id: USER, capability: 'slack_install', source: 'desktop', workspace_id: WS, exp: Date.now() + 60_000 }
    const sealed = sealDesktopCode('c', nonce)
    expect(await answer(await POST(claim({ sealed, state: signed(base), claimSecret: 'x' })))).toEqual({ status: 400, result: 'session' })
    const noWs = signed({ ...base, workspace_id: undefined, claim: claimHash('x') })
    expect(await answer(await POST(claim({ sealed, state: noWs, claimSecret: 'x' })))).toEqual({ status: 400, result: 'failed' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a caller signed in as anyone but the person who started it, even with the secret', async () => {
    const { state, claimSecret, sealed } = desktopStart()
    m.auth.userId = OTHER_USER
    expect(await answer(await POST(claim({ sealed, state, claimSecret })))).toEqual({ status: 403, result: 'session' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('refuses a missing or wrong claim secret, and another install’s', async () => {
    const { state, sealed } = desktopStart()
    const other = desktopStart()
    expect(await answer(await POST(claim({ sealed, state })))).toEqual({ status: 403, result: 'session' })
    expect(await answer(await POST(claim({ sealed, state, claimSecret: 'guess' })))).toEqual({ status: 403, result: 'session' })
    expect(await answer(await POST(claim({ sealed, state, claimSecret: other.claimSecret })))).toEqual({ status: 403, result: 'session' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it("refuses a sealed code that does not open with this state's nonce (another install's, or tampered)", async () => {
    const { state, claimSecret, sealed } = desktopStart()
    const other = desktopStart()
    expect(await answer(await POST(claim({ sealed: other.sealed, state, claimSecret })))).toEqual({ status: 400, result: 'session' })
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`
    expect(await answer(await POST(claim({ sealed: tampered, state, claimSecret })))).toEqual({ status: 400, result: 'session' })
    expect(await answer(await POST(claim({ sealed: 'made-up-code', state, claimSecret })))).toEqual({ status: 400, result: 'session' })
    expect(m.complete).not.toHaveBeenCalled()
  })

  it('never logs the code, the secret or the state', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { state, claimSecret, sealed } = desktopStart()
      await POST(claim({ sealed, state, claimSecret }))
      const logged = JSON.stringify(log.mock.calls)
      expect(logged).toContain('installed')
      for (const secret of ['made-up-code', claimSecret, state, sealed]) expect(logged).not.toContain(secret)
    } finally {
      log.mockRestore()
    }
  })
})
