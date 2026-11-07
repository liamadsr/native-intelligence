/**
 * GET /api/account/github/repos reads the person's GitHub token with the
 * service client (migration 466 takes the token columns from
 * `authenticated`), scoped to the session's own user id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  storedGithubToken: vi.fn(),
  service: { tag: 'service-client' },
}))

vi.mock('@/lib/api-auth', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/oauth/github-token', () => ({ storedGithubToken: h.storedGithubToken }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.service }))

const { GET } = await import('../route')

const USER_ID = '11111111-1111-4111-8111-111111111111'
const userClient = { tag: 'user-client' }

describe('GET /api/account/github/repos', () => {
  beforeEach(() => {
    h.requireUser.mockResolvedValue({ supabase: userClient, user: { id: USER_ID } })
    h.storedGithubToken.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the token with the service client for the session user, never the user-scoped one', async () => {
    h.storedGithubToken.mockResolvedValue(null)
    const res = await GET()
    expect(h.storedGithubToken).toHaveBeenCalledTimes(1)
    expect(h.storedGithubToken).toHaveBeenCalledWith(h.service, USER_ID)
    expect(h.storedGithubToken.mock.calls[0][0]).not.toBe(userClient)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ error: 'GitHub not connected', repos: [] })
  })

  it('refuses without a session and reads no token', async () => {
    h.requireUser.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    const res = await GET()
    expect(res.status).toBe(401)
    expect(h.storedGithubToken).not.toHaveBeenCalled()
  })

  it('lists the repos with the token it read', async () => {
    h.storedGithubToken.mockResolvedValue('gho_test_token')
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            full_name: 'acme-test/widgets',
            name: 'widgets',
            owner: { login: 'acme-test', avatar_url: 'https://example.test/a.png' },
            private: true,
            html_url: 'https://github.com/acme-test/widgets',
            description: null,
            default_branch: 'main',
          },
        ]),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await GET()
    const body = await res.json()
    expect(body.repos).toHaveLength(1)
    expect(body.repos[0].full_name).toBe('acme-test/widgets')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gho_test_token')
  })
})
