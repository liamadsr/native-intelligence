/**
 * "Add to Slack" (POST /api/account/integrations/slack/install): a web
 * install gets Slack's link and this browser the binding cookie; a desktop
 * install (`source: 'desktop'`, exactly) gets the link, the state and its
 * claim secret, and no cookie, since the browser that finishes it is the
 * person's own. Only an admin may start one. Every id here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubSlackEnv } from '@/test/slack'

const m = vi.hoisted(() => ({ role: 'admin' as string }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    user: { id: '33333333-3333-4333-8333-333333333333' },
    workspaceId: '11111111-1111-4111-8111-111111111111',
    member: { id: 'm-1', role: m.role },
    supabase: {},
  }),
}))

import { POST } from '../route'
import { claimSecretMatches, verifyOAuthState } from '@/lib/oauth/state'

const COOKIE = 'slack_install_nonce'

function install(body?: unknown) {
  return new Request('https://nativeintelligence.dev/api/account/integrations/slack/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://nativeintelligence.dev' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  stubSlackEnv()
  vi.stubEnv('OAUTH_STATE_SECRET', 'made-up-state-secret')
  m.role = 'admin'
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/account/integrations/slack/install', () => {
  it('web: the link, and the binding cookie with the state’s nonce; no state or secret in the answer', async () => {
    const res = await POST(install({ returnTo: '/account/settings/connectors/slack' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['url'])
    const state = new URL(body.url as string).searchParams.get('state')!
    const verified = verifyOAuthState(state)
    expect(verified.ok && verified.data.source).toBe('web')
    expect(verified.ok && verified.data.claim).toBeNull()
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${COOKIE}=${verified.ok ? verified.data.nonce : 'x'}`)
    expect(cookie).toContain('HttpOnly')
  })

  it('anything but exactly "desktop" is a web install', async () => {
    for (const source of ['Desktop', 'desktop ', 1, null, { desktop: true }]) {
      const res = await POST(install({ source }))
      expect(Object.keys((await res.json()) as object)).toEqual(['url'])
      expect(res.headers.get('set-cookie')).toContain(COOKIE)
    }
    const bare = await POST(install())
    expect(bare.headers.get('set-cookie')).toContain(COOKIE)
  })

  it('desktop: the link, the state and its claim secret, and no cookie', async () => {
    const res = await POST(install({ returnTo: '/account/settings/connectors/slack', source: 'desktop' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { url: string; state: string; claimSecret: string }
    expect(Object.keys(body).sort()).toEqual(['claimSecret', 'state', 'url'])
    expect(new URL(body.url).searchParams.get('state')).toBe(body.state)
    expect(body.url).not.toContain(body.claimSecret)
    const verified = verifyOAuthState(body.state)
    expect(verified.ok && verified.data).toMatchObject({ source: 'desktop', capability: 'slack_install', origin: null })
    expect(verified.ok && claimSecretMatches(body.claimSecret, verified.data.claim)).toBe(true)
  })

  it('only an admin may start one, from either surface', async () => {
    m.role = 'member'
    expect((await POST(install({ source: 'desktop' }))).status).toBe(403)
    expect((await POST(install())).status).toBe(403)
  })
})
