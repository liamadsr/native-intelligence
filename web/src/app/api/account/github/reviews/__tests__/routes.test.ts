/**
 * The Reviews routes (docs/plans/github-reviews.md, phase 1): a member who
 * is not a guest, with their own GitHub connected; their token read for
 * their own user id only; filters parsed before they reach GitHub; a merge
 * refused on malformed input and on anything mergePull refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  auth: null as unknown,
  token: 'tok' as string | null,
  tokenFor: [] as string[],
  search: vi.fn(),
  readPull: vi.fn(),
  readFiles: vi.fn(),
  merge: vi.fn(),
  linked: vi.fn(async () => new Map()),
  identity: [] as Array<[string, unknown]>,
}))
vi.mock('@/lib/github/identity', () => ({ recordGithubIdentity: async (_s: unknown, userId: string, gh: unknown) => (hoisted.identity.push([userId, gh]), true) }))

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: async () => hoisted.auth }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/oauth/github-token', () => ({
  storedGithubToken: async (_s: unknown, userId: string) => {
    hoisted.tokenFor.push(userId)
    return hoisted.token
  },
}))
vi.mock('@/lib/github/reviews-server', async (orig) => {
  const real = await orig<typeof import('@/lib/github/reviews-server')>()
  return { ...real, searchReviews: hoisted.search, readPull: hoisted.readPull, readFiles: hoisted.readFiles, mergePull: hoisted.merge, linkedActionsFor: hoisted.linked }
})

import { GET as list } from '../route'
import { GET as one } from '../pull/route'
import { POST as merge } from '../merge/route'
import { GithubError } from '@/lib/github/reviews-server'

const member = (role = 'member') => ({ supabase: { user: true }, user: { id: 'user-1' }, workspaceId: 'ws-1', member: { id: 'm-1', role } })
const SHA = 'f'.repeat(40)

beforeEach(() => {
  hoisted.auth = member()
  hoisted.token = 'tok'
  hoisted.tokenFor.length = 0
  hoisted.search.mockReset()
  hoisted.readPull.mockReset()
  hoisted.readFiles.mockReset()
  hoisted.merge.mockReset()
  hoisted.linked.mockClear()
  hoisted.identity.length = 0
})

const post = (body: unknown) => new Request('http://localhost/api/account/github/reviews/merge', { method: 'POST', body: JSON.stringify(body) })

describe('GET /api/account/github/reviews', () => {
  it('refuses a guest, and names a missing GitHub connection', async () => {
    hoisted.auth = member('guest')
    expect((await list(new Request('http://localhost/api/account/github/reviews'))).status).toBe(403)
    hoisted.auth = member()
    hoisted.token = null
    const res = await list(new Request('http://localhost/api/account/github/reviews'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'github_not_connected' })
    expect(hoisted.tokenFor).toEqual(['user-1'])
  })

  it('searches with the person’s token and parsed filters, links read through their own client', async () => {
    hoisted.search.mockResolvedValue({ viewer: { login: 'dana', id: 1 }, total: 2, cursor: null, prs: [{ repo: 'acme/app', number: 1 }, { repo: 'acme/app', number: 2 }] })
    hoisted.linked.mockResolvedValueOnce(new Map([['acme/app#1', [{ id: 'a1', identifier: 'ENG-1', title: 'x' }]]]))
    const res = await list(new Request('http://localhost/api/account/github/reviews?section=authored&repo=bad%20repo%20org:x&linked=linked'))
    const [token, filters] = hoisted.search.mock.calls[0]
    expect(token).toBe('tok')
    expect(filters).toMatchObject({ section: 'authored', repo: null, linked: 'linked' })
    expect(hoisted.linked).toHaveBeenCalledWith({ user: true }, 'ws-1', expect.any(Array))
    const body = await res.json()
    expect(body.prs.map((p: { number: number }) => p.number)).toEqual([1])
    // Who they are on GitHub, as GitHub named the viewer for their own token (migration 694).
    expect(hoisted.identity).toEqual([['user-1', { id: 1, login: 'dana' }]])
  })

  it('answers GitHub’s refusal in words', async () => {
    hoisted.search.mockRejectedValue(new GithubError('rate_limited'))
    const res = await list(new Request('http://localhost/api/account/github/reviews'))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'github_rate_limited' })
  })
})

describe('GET /api/account/github/reviews/pull', () => {
  it('needs a well-formed repo and number', async () => {
    expect((await one(new Request('http://localhost/x?repo=acme&number=1'))).status).toBe(400)
    expect((await one(new Request('http://localhost/x?repo=acme/app&number=-1'))).status).toBe(400)
    expect(hoisted.readPull).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/github/reviews/merge', () => {
  it('refuses malformed input before reading GitHub', async () => {
    for (const body of [
      { repo: 'acme', number: 1, method: 'squash', sha: SHA },
      { repo: 'acme/app', number: '1', method: 'squash', sha: SHA },
      { repo: 'acme/app', number: 1, method: 'force', sha: SHA },
      { repo: 'acme/app', number: 1, method: 'squash', sha: 'abc' },
    ]) {
      expect((await merge(post(body))).status).toBe(400)
    }
    expect(hoisted.merge).not.toHaveBeenCalled()
  })

  it('merges as the person, and passes on a refusal', async () => {
    hoisted.merge.mockResolvedValueOnce({ ok: true, sha: SHA })
    const ok = await merge(post({ repo: 'acme/app', number: 3, method: 'squash', sha: SHA }))
    expect(ok.status).toBe(200)
    expect(hoisted.merge).toHaveBeenCalledWith('tok', { repo: 'acme/app', number: 3, method: 'squash', expectedSha: SHA })
    hoisted.merge.mockResolvedValueOnce({ ok: false, reason: 'It has conflicts.', code: 'blocked' })
    const no = await merge(post({ repo: 'acme/app', number: 3, method: 'squash', sha: SHA }))
    expect(no.status).toBe(409)
    expect(await no.json()).toEqual({ error: 'It has conflicts.', code: 'merge_blocked' })
  })

  it('refuses a guest', async () => {
    hoisted.auth = member('guest')
    expect((await merge(post({ repo: 'acme/app', number: 3, method: 'squash', sha: SHA }))).status).toBe(403)
    expect(hoisted.merge).not.toHaveBeenCalled()
  })
})
