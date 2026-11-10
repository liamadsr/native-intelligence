import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the jira branch of GET /api/oauth/[provider]/authorize.
 *
 * The route is provider-generic and every other provider needs no extra
 * authorize params — Jira needs TWO, and both fail in ways that are invisible
 * from the code:
 *
 *  - `audience=api.atlassian.com` is MANDATORY. Atlassian rejects the authorize
 *    request outright without it, so a missing audience is a connection that can
 *    never be made.
 *  - `prompt=consent` forces the access-grant screen every time. Without it a
 *    returning user can skip consent and we silently inherit the scope set from
 *    a PREVIOUS connect — so a reconnect after widening scopes hands back a
 *    token missing the new ones, with no error anywhere and a failure that only
 *    shows up later at the first call needing the new scope.
 *
 * The generic half (state signing, the scope list, the redirect URI) is asserted
 * alongside so a future edit to the ternary chain can't quietly drop Jira out of
 * it.
 */

const hoistedAuth = vi.hoisted(() => ({ user: { id: 'u-1' } as { id: string } | null }))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => {
    if (!hoistedAuth.user) throw new Response('Unauthorized', { status: 401 })
    return { user: hoistedAuth.user }
  },
}))

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

import { GET } from '../route'

async function authorizeUrl(
  provider: string,
  capability = 'tasks',
): Promise<URL> {
  const res = await GET(
    new Request(`https://nativeintelligence.dev/api/oauth/${provider}/authorize?capability=${capability}`),
    { params: Promise.resolve({ provider }) },
  )
  const body = (await res.json()) as { url?: string; error?: string }
  if (!body.url) throw new Error(`no url in response: ${JSON.stringify(body)}`)
  return new URL(body.url)
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedAuth.user = { id: 'u-1' }
  process.env.JIRA_CLIENT_ID = 'jira-client'
  process.env.OAUTH_REDIRECT_BASE_URL = 'https://nativeintelligence.dev'
  process.env.OAUTH_STATE_SECRET = 'state-secret'
})

describe('GET /api/oauth/jira/authorize', () => {
  it('accepts jira as a provider at all', async () => {
    const url = await authorizeUrl('jira')
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize')
  })

  it('sends audience=api.atlassian.com — Atlassian REJECTS the request without it', async () => {
    const url = await authorizeUrl('jira')
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com')
  })

  it('sends prompt=consent so a reconnect cannot inherit a stale scope grant', async () => {
    const url = await authorizeUrl('jira')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('carries the full classic scope set including offline_access', async () => {
    const scopes = (await authorizeUrl('jira')).searchParams.get('scope')!.split(' ')
    expect(scopes).toEqual([
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
      'manage:jira-webhook',
      // The User Identity API scope the callback's /me lookup needs — a
      // SEPARATE permission in the Atlassian console from the Jira API ones.
      'read:me',
      'offline_access',
    ])
  })

  it('uses the JIRA_CLIENT_ID and the provider-scoped callback URL', async () => {
    const url = await authorizeUrl('jira')
    expect(url.searchParams.get('client_id')).toBe('jira-client')
    expect(url.searchParams.get('redirect_uri')).toBe('https://nativeintelligence.dev/api/oauth/jira/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('still signs the state param (the CSRF gate is provider-generic)', async () => {
    const state = (await authorizeUrl('jira')).searchParams.get('state')!
    const [payload, sig] = state.split('.')
    expect(sig).toBeTruthy()
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(decoded).toMatchObject({ user_id: 'u-1', capability: 'tasks', workspace_id: 'ws-1' })
  })

  it('does NOT leak the Atlassian params onto another provider', async () => {
    process.env.ASANA_CLIENT_ID = 'asana-client'
    const url = await authorizeUrl('asana')
    expect(url.searchParams.get('audience')).toBeNull()
    expect(url.searchParams.get('prompt')).toBeNull()
  })
})
