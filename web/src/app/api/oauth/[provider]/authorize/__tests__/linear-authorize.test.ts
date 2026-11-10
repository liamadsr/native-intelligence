import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the linear branch of GET /api/oauth/[provider]/authorize.
 *
 * ONE thing about Linear diverges from every other provider in this route, and
 * it is entirely invisible from reading the code: the scope list must be
 * COMMA-separated ("read,write"). RFC 6749 says space-separated and every other
 * provider here accepts that, so `scopes.join(' ')` was correct until Linear —
 * which does not parse the spaced form. A wrong delimiter is not a build error
 * and not a 4xx at authorize time; it is a token granted with the wrong scopes,
 * discovered later at the first write that needs them.
 *
 * So the assertions below are in two halves: the delimiter is right for Linear,
 * AND it is still a space for everyone else. The second half is the one that
 * catches a fix applied too broadly.
 */

const hoistedAuth = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  /** Workspaces the user is a member of (the `member` lookup). */
  memberOf: ['ws-1'] as string[],
}))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => {
    if (!hoistedAuth.user) throw new Response('Unauthorized', { status: 401 })
    const supabase = {
      from: () => {
        let ws = ''
        const api: Record<string, unknown> = {
          select: () => api,
          eq: (k: string, v: string) => {
            if (k === 'workspace_id') ws = v
            return api
          },
          maybeSingle: async () => ({
            data: hoistedAuth.memberOf.includes(ws) ? { id: 'm-1' } : null,
            error: null,
          }),
        }
        return api
      },
    }
    return { user: hoistedAuth.user, supabase }
  },
}))

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

import { GET } from '../route'

async function authorizeUrl(provider: string, capability = 'tasks'): Promise<URL> {
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
  hoistedAuth.memberOf = ['ws-1']
  process.env.LINEAR_CLIENT_ID = 'linear-client'
  process.env.JIRA_CLIENT_ID = 'jira-client'
  process.env.ASANA_CLIENT_ID = 'asana-client'
  process.env.OAUTH_REDIRECT_BASE_URL = 'https://nativeintelligence.dev'
  process.env.OAUTH_STATE_SECRET = 'state-secret'
})

describe('GET /api/oauth/[provider]/authorize — workspace_id', () => {
  it('403s a workspace_id the caller is not a member of', async () => {
    const res = await GET(
      new Request('https://nativeintelligence.dev/api/oauth/linear/authorize?capability=tasks&workspace_id=ws-foreign'),
      { params: Promise.resolve({ provider: 'linear' }) },
    )
    expect(res.status).toBe(403)
  })

  it('signs a workspace_id the caller belongs to into the state', async () => {
    hoistedAuth.memberOf = ['ws-1', 'ws-2']
    const res = await GET(
      new Request('https://nativeintelligence.dev/api/oauth/linear/authorize?capability=tasks&workspace_id=ws-2'),
      { params: Promise.resolve({ provider: 'linear' }) },
    )
    const { state } = (await res.json()) as { state: string }
    const decoded = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString())
    expect(decoded.workspace_id).toBe('ws-2')
  })
})

describe('GET /api/oauth/linear/authorize', () => {
  it('accepts linear as a provider at all', async () => {
    const url = await authorizeUrl('linear')
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize')
  })

  /**
   * THE Linear-specific rule. Asserted on the RAW query string as well as the
   * parsed value, because `URLSearchParams` would happily hand back a
   * space-joined string too — and the wire format is what Linear parses.
   */
  it('joins scopes with a COMMA, not the RFC-default space', async () => {
    const url = await authorizeUrl('linear')
    expect(url.searchParams.get('scope')).toBe('read,write')
    // On the wire a comma may be percent-encoded or literal; a SPACE (`+` or
    // `%20`) would mean the delimiter fix never happened.
    const raw = url.search.match(/[?&]scope=([^&]*)/)![1]
    expect(decodeURIComponent(raw)).toBe('read,write')
    expect(raw).not.toContain('+')
    expect(raw).not.toContain('%20')
  })

  it('requests read + write and NOT admin', async () => {
    // `write` covers issueCreate and issueUpdate — everything this integration
    // does. `admin` exists for managing an organization (including API-created
    // webhooks), and Linear's webhooks for an OAuth app are app-level, so there
    // is nothing to ask a user for admin over their workspace for.
    const scopes = (await authorizeUrl('linear')).searchParams.get('scope')!.split(',')
    expect(scopes).toEqual(['read', 'write'])
    expect(scopes).not.toContain('admin')
  })

  it('uses the LINEAR_CLIENT_ID and the provider-scoped callback URL', async () => {
    const url = await authorizeUrl('linear')
    expect(url.searchParams.get('client_id')).toBe('linear-client')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://nativeintelligence.dev/api/oauth/linear/callback',
    )
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  /**
   * Linear needs no extra authorize params, so it must fall through the ternary
   * chain to the default `{}`. `actor` in particular is deliberately absent: the
   * default user-actor is what we want, and `actor=app` is for bots and requires
   * a workspace-admin install.
   */
  it('sends NO provider-specific extras — no audience, no prompt, no actor', async () => {
    const url = await authorizeUrl('linear')
    expect(url.searchParams.get('audience')).toBeNull()
    expect(url.searchParams.get('prompt')).toBeNull()
    expect(url.searchParams.get('actor')).toBeNull()
  })

  it('still signs the state param (the CSRF gate is provider-generic)', async () => {
    const state = (await authorizeUrl('linear')).searchParams.get('state')!
    const [payload, sig] = state.split('.')
    expect(sig).toBeTruthy()
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(decoded).toMatchObject({ user_id: 'u-1', capability: 'tasks', workspace_id: 'ws-1' })
  })
})

/**
 * The other half of the delimiter change: it must be scoped to Linear. A fix
 * applied globally would silently break every provider that has more than one
 * scope — and, like the Linear bug it was fixing, would fail at grant time
 * rather than at request time.
 */
describe('the comma delimiter does NOT leak to other providers', () => {
  it('keeps SPACE-separated scopes for jira', async () => {
    const scope = (await authorizeUrl('jira')).searchParams.get('scope')!
    expect(scope).toContain(' ')
    expect(scope).not.toContain(',')
    expect(scope.split(' ')).toContain('offline_access')
  })

  it('keeps space-separated scopes for google', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-client'
    const scope = (await authorizeUrl('google', 'calendar')).searchParams.get('scope')!
    expect(scope).toContain(' ')
    expect(scope).not.toContain(',')
  })

  it('is unaffected for a single-scope provider like asana', async () => {
    expect((await authorizeUrl('asana')).searchParams.get('scope')).toBe('default')
  })
})
