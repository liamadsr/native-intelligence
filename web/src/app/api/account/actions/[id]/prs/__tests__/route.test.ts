/**
 * POST /api/account/actions/[id]/prs looks up the PR's metadata with the
 * person's own GitHub token, read with the service client (migration 466
 * takes the token columns from `authenticated`) for the session's user id.
 * The action and PR rows stay on the user-scoped client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  storedGithubToken: vi.fn(),
  service: { tag: 'service-client' },
  upserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: h.requireWorkspace }))
vi.mock('@/lib/oauth/github-token', () => ({ storedGithubToken: h.storedGithubToken }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.service }))

const { POST } = await import('../route')

const USER_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const ACTION_ID = '33333333-3333-4333-8333-333333333333'

function userClient() {
  const tables: string[] = []
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: { id: ACTION_ID, pr: true }, error: null }),
    upsert: (row: Record<string, unknown>) => {
      h.upserts.push(row)
      return chain
    },
  })
  return {
    tables,
    from: (t: string) => {
      tables.push(t)
      return chain
    },
  }
}

function post(body: unknown): Request {
  return new Request(`https://example.test/api/account/actions/${ACTION_ID}/prs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/account/actions/[id]/prs', () => {
  let client: ReturnType<typeof userClient>
  beforeEach(() => {
    client = userClient()
    h.upserts.length = 0
    h.storedGithubToken.mockReset()
    h.requireWorkspace.mockResolvedValue({ supabase: client, user: { id: USER_ID }, workspaceId: WORKSPACE_ID })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the GitHub token with the service client for the session user, and links the PR on the user client', async () => {
    h.storedGithubToken.mockResolvedValue('gho_test_token')
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ title: 'Fix the widget', state: 'open', merged: false, draft: false, head: { ref: 'fix-widget' } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(post({ pr_url: 'https://github.com/acme-test/widgets/pull/7' }), { params: Promise.resolve({ id: ACTION_ID }) })

    expect(res.status).toBe(201)
    expect(h.storedGithubToken).toHaveBeenCalledWith(h.service, USER_ID)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gho_test_token')
    expect(client.tables).toEqual(['actions', 'action_github_pr'])
    expect(h.upserts[0]).toMatchObject({ workspace_id: WORKSPACE_ID, action_id: ACTION_ID, created_by: USER_ID, pr_title: 'Fix the widget' })
  })

  it('reads no token for a URL that is not a GitHub PR', async () => {
    const res = await POST(post({ pr_url: 'https://example.test/not-a-pr' }), { params: Promise.resolve({ id: ACTION_ID }) })
    expect(res.status).toBe(400)
    expect(h.storedGithubToken).not.toHaveBeenCalled()
  })
})
