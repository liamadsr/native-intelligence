import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROADMAP_API_URL, ROADMAP_REPO, ROADMAP_REVALIDATE_SECONDS } from '../constants'
import { getRoadmap } from '../fetch'
import { buildRoadmap, summaryFromBody, toRoadmapItem, type GitHubIssue } from '../parse'

// Made-up issues in the shape of GitHub's REST issue list.
function issue(overrides: Partial<GitHubIssue> & { number: number }): GitHubIssue {
  return {
    title: `Item ${overrides.number}`,
    body: 'A short description.\n\n---\nVote with 👍 or 👎.',
    html_url: `https://github.com/example/repo/issues/${overrides.number}`,
    state: 'open',
    closed_at: null,
    labels: [{ name: 'roadmap' }, { name: 'now' }],
    milestone: { title: '2026 Q4' },
    reactions: { '+1': 0, '-1': 0 },
    ...overrides,
  }
}

const labels = (...names: string[]) => names.map((name) => ({ name }))

describe('summaryFromBody', () => {
  it('keeps only the part before the --- line', () => {
    expect(summaryFromBody('Calendar sync for teams.\n\n---\nVote with 👍.')).toBe('Calendar sync for teams.')
  })

  it('handles CRLF bodies and a --- with spaces around it', () => {
    expect(summaryFromBody('First line.\r\nSecond line.\r\n  ---  \r\nVoting note')).toBe('First line.\nSecond line.')
  })

  it('keeps the whole body when there is no --- line', () => {
    expect(summaryFromBody('  Just a description.  ')).toBe('Just a description.')
  })

  it('does not cut at a --- inside a line', () => {
    expect(summaryFromBody('Before --- after.\n---\nnote')).toBe('Before --- after.')
  })

  it('returns an empty string for a missing body', () => {
    expect(summaryFromBody(null)).toBe('')
    expect(summaryFromBody(undefined)).toBe('')
  })
})

describe('toRoadmapItem', () => {
  it('maps the horizon, status, quarter and votes', () => {
    const item = toRoadmapItem(
      issue({
        number: 7,
        title: '  Offline mode ',
        labels: labels('roadmap', 'next', 'in progress'),
        milestone: { title: '2027 Q1' },
        reactions: { '+1': 9, '-1': 2 },
      }),
    )
    expect(item).toEqual({
      number: 7,
      title: 'Offline mode',
      summary: 'A short description.',
      url: 'https://github.com/example/repo/issues/7',
      horizon: 'next',
      status: 'in_progress',
      quarter: '2027 Q1',
      up: 9,
      down: 2,
      net: 7,
      closedAt: null,
    })
  })

  it('reads labels given as plain strings and in any case', () => {
    const item = toRoadmapItem(issue({ number: 3, labels: ['roadmap', 'Later'] }))
    expect(item?.horizon).toBe('later')
    expect(item?.status).toBe('planned')
  })

  it('treats a closed issue with the shipped label as shipped', () => {
    const item = toRoadmapItem(
      issue({ number: 2, state: 'closed', closed_at: '2026-10-01T00:00:00Z', labels: labels('roadmap', 'now', 'shipped') }),
    )
    expect(item?.status).toBe('shipped')
    expect(item?.horizon).toBeNull()
    expect(item?.closedAt).toBe('2026-10-01T00:00:00Z')
  })

  it('drops a closed issue that did not ship', () => {
    expect(toRoadmapItem(issue({ number: 2, state: 'closed', labels: labels('roadmap', 'now') }))).toBeNull()
  })

  it('drops an open issue with no horizon label', () => {
    expect(toRoadmapItem(issue({ number: 2, labels: labels('roadmap') }))).toBeNull()
  })

  it('skips pull requests', () => {
    expect(toRoadmapItem(issue({ number: 2, pull_request: { url: 'https://api.github.com/x' } }))).toBeNull()
  })

  it('has no quarter without a milestone, and zero votes without reactions', () => {
    const item = toRoadmapItem(issue({ number: 2, milestone: null, reactions: null }))
    expect(item?.quarter).toBeNull()
    expect([item?.up, item?.down, item?.net]).toEqual([0, 0, 0])
  })
})

describe('buildRoadmap', () => {
  it('sorts each horizon by net votes, then by issue number', () => {
    const data = buildRoadmap([
      issue({ number: 10, reactions: { '+1': 3, '-1': 0 } }),
      issue({ number: 4, reactions: { '+1': 5, '-1': 2 } }), // net 3, older than #10
      issue({ number: 6, reactions: { '+1': 8, '-1': 1 } }), // net 7
      issue({ number: 5, reactions: { '+1': 1, '-1': 4 } }), // net -3
    ])
    expect(data.ok).toBe(true)
    expect(data.horizons.now.map((i) => [i.number, i.net])).toEqual([
      [6, 7],
      [4, 3],
      [10, 3],
      [5, -3],
    ])
  })

  it('puts items in their columns, works out each quarter, and lists shipped items newest first', () => {
    const data = buildRoadmap([
      issue({ number: 1, labels: labels('roadmap', 'now'), milestone: { title: '2026 Q4' } }),
      issue({ number: 2, labels: labels('roadmap', 'next'), milestone: { title: '2027 Q2' } }),
      issue({ number: 3, labels: labels('roadmap', 'next'), milestone: { title: '2027 Q1' } }),
      issue({ number: 4, labels: labels('roadmap', 'later'), milestone: null }),
      issue({ number: 5, state: 'closed', closed_at: '2026-09-01T00:00:00Z', labels: labels('roadmap', 'shipped') }),
      issue({ number: 6, state: 'closed', closed_at: '2026-10-15T00:00:00Z', labels: labels('roadmap', 'shipped') }),
      issue({ number: 7, pull_request: {} }),
    ])
    expect(data.horizons.now.map((i) => i.number)).toEqual([1])
    expect(data.horizons.next.map((i) => i.number)).toEqual([2, 3])
    expect(data.horizons.later.map((i) => i.number)).toEqual([4])
    expect(data.quarters).toEqual({ now: '2026 Q4', next: '2027 Q1 – 2027 Q2', later: null })
    expect(data.shipped.map((i) => i.number)).toEqual([6, 5])
  })

  it('flags a response that is not a list', () => {
    const data = buildRoadmap({ message: 'API rate limit exceeded' })
    expect(data.ok).toBe(false)
    expect(data.horizons).toEqual({ now: [], next: [], later: [] })
  })

  it('ignores junk entries in the list', () => {
    const data = buildRoadmap([null, 42, 'x', {}, issue({ number: 1 })])
    expect(data.ok).toBe(true)
    expect(data.horizons.now.map((i) => i.number)).toEqual([1])
  })
})

describe('getRoadmap', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function okResponse(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('fetches the roadmap issues of the one repo, cached for five minutes, without a token by default', async () => {
    vi.stubEnv('GITHUB_ROADMAP_TOKEN', '')
    const fetchMock = vi.fn(async () => okResponse([issue({ number: 1 })]))
    const data = await getRoadmap(fetchMock as unknown as typeof fetch)

    expect(data.ok).toBe(true)
    expect(data.horizons.now).toHaveLength(1)
    expect(ROADMAP_API_URL).toContain(`/repos/${ROADMAP_REPO}/issues`)
    expect(ROADMAP_API_URL).toContain('labels=roadmap')
    expect(ROADMAP_API_URL).toContain('state=all')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { next?: { revalidate?: number } }]
    expect(url).toBe(ROADMAP_API_URL)
    expect(init.next?.revalidate).toBe(ROADMAP_REVALIDATE_SECONDS)
    expect(ROADMAP_REVALIDATE_SECONDS).toBe(300)
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('sends the optional token when it is set', async () => {
    vi.stubEnv('GITHUB_ROADMAP_TOKEN', 'test-token-not-real')
    const fetchMock = vi.fn(async () => okResponse([]))
    await getRoadmap(fetchMock as unknown as typeof fetch)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token-not-real')
  })

  it('returns an empty, flagged result when GitHub answers with an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => new Response('{"message":"rate limited"}', { status: 403 }))
    const data = await getRoadmap(fetchMock as unknown as typeof fetch)
    expect(data).toEqual({
      ok: false,
      horizons: { now: [], next: [], later: [] },
      quarters: { now: null, next: null, later: null },
      shipped: [],
    })
  })

  it('never throws when the request fails or the JSON is bad', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const network = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(getRoadmap(network as unknown as typeof fetch)).resolves.toMatchObject({ ok: false })

    const badJson = vi.fn(async () => new Response('not json', { status: 200 }))
    await expect(getRoadmap(badJson as unknown as typeof fetch)).resolves.toMatchObject({ ok: false })
  })
})
