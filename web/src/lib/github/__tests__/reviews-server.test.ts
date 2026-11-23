import { describe, expect, it, vi } from 'vitest'
import { GithubError, linkedActionsFor, mergePull, searchReviews } from '../reviews-server'
import { parseReviewFilters } from '../reviews'

const SHA = 'b'.repeat(40)

function prNode(over: Record<string, unknown> = {}) {
  return {
    id: 'PR_1',
    number: 5,
    title: 'Ship it',
    url: 'https://github.com/acme/app/pull/5',
    state: 'OPEN',
    merged: false,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefOid: SHA,
    repository: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE', squashMergeAllowed: true },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    ...over,
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('searchReviews', () => {
  it('sends the built query with the token and reads the page', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: { viewer: { login: 'dana', databaseId: 9 }, search: { issueCount: 1, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [prNode(), {}] } } }),
    )
    const page = await searchReviews('tok', parseReviewFilters({ section: 'authored' }), null, fetchImpl as unknown as typeof fetch)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body)).variables.q).toContain('author:@me')
    expect(page).toMatchObject({ viewer: { login: 'dana', id: 9 }, total: 1, cursor: 'c1' })
    expect(page.prs).toHaveLength(1)
  })

  it('names a refused sign-in and a rate limit', async () => {
    const f401 = vi.fn(async () => new Response('', { status: 401 }))
    await expect(searchReviews('t', parseReviewFilters({}), null, f401 as unknown as typeof fetch)).rejects.toMatchObject({ why: 'unauthorized' })
    const f403 = vi.fn(async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    await expect(searchReviews('t', parseReviewFilters({}), null, f403 as unknown as typeof fetch)).rejects.toBeInstanceOf(GithubError)
    await expect(searchReviews('t', parseReviewFilters({}), null, f403 as unknown as typeof fetch)).rejects.toMatchObject({ why: 'rate_limited' })
  })
})

describe('mergePull', () => {
  const pullAnswer = (over: Record<string, unknown> = {}) => json({ data: { repository: { pullRequest: { ...prNode(over), body: '' } } } })

  it('merges a ready one pinned to the head the person saw', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/graphql') ? pullAnswer() : json({ merged: true, sha: 'm'.repeat(40) })))
    const out = await mergePull('tok', { repo: 'acme/app', number: 5, method: 'squash', expectedSha: SHA }, fetchImpl as unknown as typeof fetch)
    expect(out).toEqual({ ok: true, sha: 'm'.repeat(40) })
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/acme/app/pulls/5/merge')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ merge_method: 'squash', sha: SHA })
  })

  it('refuses without calling merge when it is not ready, the head moved, or the method is not allowed', async () => {
    for (const [over, args, code] of [
      [{ reviewDecision: 'CHANGES_REQUESTED' }, {}, 'blocked'],
      [{ repository: { nameWithOwner: 'acme/app', viewerPermission: 'READ', squashMergeAllowed: true } }, {}, 'blocked'],
      [{ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }, {}, 'blocked'],
      [{}, { expectedSha: 'c'.repeat(40) }, 'stale'],
      [{}, { method: 'rebase' }, 'blocked'],
    ] as const) {
      const fetchImpl = vi.fn(async () => pullAnswer(over as Record<string, unknown>))
      const out = await mergePull('tok', { repo: 'acme/app', number: 5, method: 'squash', expectedSha: SHA, ...(args as object) }, fetchImpl as unknown as typeof fetch)
      expect(out).toMatchObject({ ok: false, code })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('passes on GitHub refusing the merge in its own words', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/graphql') ? pullAnswer() : json({ message: 'Required status check is expected.' }, 405)))
    const out = await mergePull('tok', { repo: 'acme/app', number: 5, method: 'squash', expectedSha: SHA }, fetchImpl as unknown as typeof fetch)
    expect(out).toEqual({ ok: false, code: 'refused', reason: 'Required status check is expected.' })
  })
})

describe('linkedActionsFor', () => {
  it('reads links through the inner join and keys them by pull request', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const rows = [
      { repo_full_name: 'acme/app', pr_number: 5, actions: { id: 'a1', identifier: 'ENG-1', title: 'One' } },
      { repo_full_name: 'acme/app', pr_number: 5, actions: { id: 'a1', identifier: 'ENG-1', title: 'One' } },
      { repo_full_name: 'acme/app', pr_number: 6, actions: null },
      { repo_full_name: 'acme/other', pr_number: 5, actions: { id: 'a2', identifier: 'ENG-2', title: 'Two' } },
    ]
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in']) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, ...args])
        return q
      }
    }
    ;(q as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
    const supabase = { from: (t: string) => (calls.push(['from', t]), q) } as never
    const out = await linkedActionsFor(supabase, 'ws1', [{ repo: 'acme/app', number: 5 }, { repo: 'acme/app', number: 6 }])
    expect(calls).toContainEqual(['from', 'action_github_pr'])
    expect(calls).toContainEqual(['select', 'repo_full_name, pr_number, actions!inner(id, identifier, title)'])
    expect(calls).toContainEqual(['eq', 'workspace_id', 'ws1'])
    expect(out.get('acme/app#5')).toEqual([{ id: 'a1', identifier: 'ENG-1', title: 'One' }])
    expect(out.has('acme/app#6')).toBe(false)
    // A link to a pull request not on the page (acme/other#5) is not shown.
    expect(out.has('acme/other#5')).toBe(false)
  })
})
