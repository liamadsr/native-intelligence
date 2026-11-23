import { describe, expect, it } from 'vitest'
import {
  boardColumn,
  buildSearchQuery,
  mergeBlocker,
  normalizeChecks,
  normalizePr,
  parsePatch,
  parseReviewFilters,
  reviewFiltersQuery,
  type ReviewPr,
} from '../reviews'

const base = (over: Partial<ReviewPr> = {}): ReviewPr => ({
  id: 'PR_1',
  repo: 'acme/app',
  number: 12,
  title: 'Fix login',
  url: 'https://github.com/acme/app/pull/12',
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  reviewDecision: 'APPROVED',
  checks: 'SUCCESS',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  headRef: 'eng-42-fix-login',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  author: { login: 'dana', avatarUrl: null },
  labels: [],
  assignees: [],
  permission: 'WRITE',
  mergeMethods: ['squash'],
  linked: [],
  ...over,
})

describe('parseReviewFilters', () => {
  it('defaults and drops anything malformed', () => {
    const f = parseReviewFilters(new URLSearchParams('section=nope&state=weird&repo=bad repo&author=a b&label=x"y&review=maybe&sort=old'))
    expect(f).toEqual({ section: 'review_requests', state: 'open', repo: null, author: null, assignee: null, label: null, review: null, linked: 'any', sort: 'updated' })
  })

  it('keeps well-formed values', () => {
    const f = parseReviewFilters(new URLSearchParams('section=authored&state=all&repo=acme/app&author=dana-x&assignee=@me&label=needs review&review=approved&linked=linked&sort=created'))
    expect(f).toMatchObject({ section: 'authored', state: 'all', repo: 'acme/app', author: 'dana-x', assignee: '@me', label: 'needs review', review: 'approved', linked: 'linked', sort: 'created' })
  })

  it('round-trips through the query string', () => {
    const f = parseReviewFilters(new URLSearchParams('section=involves&state=closed&repo=acme/app&label=bug'))
    expect(parseReviewFilters(new URLSearchParams(reviewFiltersQuery(f)))).toEqual(f)
  })
})

describe('buildSearchQuery', () => {
  it('builds each section with its qualifier', () => {
    expect(buildSearchQuery(parseReviewFilters({ section: 'review_requests' }))).toBe('is:pr archived:false review-requested:@me is:open sort:updated-desc')
    expect(buildSearchQuery(parseReviewFilters({ section: 'authored', state: 'closed', sort: 'created' }))).toBe('is:pr archived:false author:@me is:closed sort:created-desc')
    expect(buildSearchQuery(parseReviewFilters({ section: 'assigned', state: 'all' }))).toBe('is:pr archived:false assignee:@me sort:updated-desc')
    expect(buildSearchQuery(parseReviewFilters({ section: 'involves' }))).toContain('involves:@me')
  })

  it('adds the filters, a label quoted', () => {
    const q = buildSearchQuery(parseReviewFilters({ repo: 'acme/app', author: 'dana', assignee: 'lee', label: 'needs review', review: 'changes_requested' }))
    expect(q).toContain('repo:acme/app')
    expect(q).toContain('author:dana')
    expect(q).toContain('assignee:lee')
    expect(q).toContain('label:"needs review"')
    expect(q).toContain('review:changes_requested')
  })

  it('never lets a typed value add a qualifier of its own', () => {
    const q = buildSearchQuery(parseReviewFilters({ repo: 'acme/app is:public', author: 'dana org:other', label: 'x" repo:evil/x "' }))
    expect(q).not.toContain('org:other')
    expect(q).not.toContain('evil')
    expect(q).not.toContain('is:public')
  })
})

describe('boardColumn', () => {
  it('sorts by the first rule that holds', () => {
    expect(boardColumn(base({ state: 'merged' }))).toBe('merged')
    expect(boardColumn(base({ state: 'closed' }))).toBeNull()
    expect(boardColumn(base({ draft: true, mergeable: 'CONFLICTING' }))).toBe('draft')
    expect(boardColumn(base({ mergeable: 'CONFLICTING', checks: 'FAILURE' }))).toBe('conflicts')
    expect(boardColumn(base({ checks: 'FAILURE' }))).toBe('checks_failing')
    expect(boardColumn(base({ checks: 'ERROR' }))).toBe('checks_failing')
    expect(boardColumn(base())).toBe('ready')
    expect(boardColumn(base({ checks: null, reviewDecision: null }))).toBe('ready')
    expect(boardColumn(base({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe('in_review')
    expect(boardColumn(base({ checks: 'PENDING' }))).toBe('in_review')
    expect(boardColumn(base({ mergeState: 'BLOCKED' }))).toBe('in_review')
  })
})

describe('mergeBlocker', () => {
  it('lets a ready pull request merge', () => {
    expect(mergeBlocker(base())).toBeNull()
    expect(mergeBlocker(base({ mergeState: 'HAS_HOOKS', permission: 'ADMIN' }))).toBeNull()
  })

  it('refuses every unready one, and too little access', () => {
    expect(mergeBlocker(base({ state: 'closed' }))).toMatch(/not open/)
    expect(mergeBlocker(base({ draft: true }))).toMatch(/draft/)
    expect(mergeBlocker(base({ permission: 'READ' }))).toMatch(/access/)
    expect(mergeBlocker(base({ permission: 'TRIAGE' }))).toMatch(/access/)
    expect(mergeBlocker(base({ permission: null }))).toMatch(/access/)
    expect(mergeBlocker(base({ mergeable: 'CONFLICTING' }))).toMatch(/conflicts/)
    expect(mergeBlocker(base({ checks: 'FAILURE' }))).toMatch(/failing/)
    expect(mergeBlocker(base({ checks: 'PENDING' }))).toMatch(/running/)
    expect(mergeBlocker(base({ reviewDecision: 'CHANGES_REQUESTED' }))).toMatch(/approved/)
    expect(mergeBlocker(base({ reviewDecision: 'REVIEW_REQUIRED' }))).toMatch(/approved/)
    expect(mergeBlocker(base({ mergeState: 'BLOCKED' }))).toMatch(/ready/)
    expect(mergeBlocker(base({ mergeState: 'BEHIND' }))).toMatch(/ready/)
    expect(mergeBlocker(base({ mergeMethods: [] }))).toMatch(/method/)
    expect(mergeBlocker(base({ headSha: null }))).toMatch(/head/)
  })
})

describe('normalizePr', () => {
  it('reads a GraphQL node', () => {
    const pr = normalizePr({
      id: 'PR_x',
      number: 7,
      title: 'T',
      url: 'https://github.com/acme/app/pull/7',
      state: 'MERGED',
      merged: true,
      isDraft: false,
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      reviewDecision: null,
      additions: 3,
      deletions: 1,
      changedFiles: 2,
      headRefName: 'b',
      headRefOid: 'c'.repeat(40),
      author: { login: 'lee' },
      labels: { nodes: [{ name: 'bug', color: 'f00' }] },
      assignees: { nodes: [] },
      repository: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE', squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    })
    expect(pr).toMatchObject({ repo: 'acme/app', number: 7, state: 'merged', checks: 'SUCCESS', mergeMethods: ['squash', 'rebase'], labels: [{ name: 'bug', color: 'f00' }], author: { login: 'lee' } })
  })

  it('skips nodes that are not pull requests', () => {
    expect(normalizePr({})).toBeNull()
    expect(normalizePr(null)).toBeNull()
  })

  it('reads checks of both kinds', () => {
    const checks = normalizeChecks({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x' },
                    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null },
                    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: null },
                  ],
                },
              },
            },
          },
        ],
      },
    })
    expect(checks).toEqual([
      { name: 'test', outcome: 'failure', url: 'https://x' },
      { name: 'lint', outcome: 'pending', url: null },
      { name: 'ci/legacy', outcome: 'success', url: null },
    ])
  })
})

describe('parsePatch', () => {
  it('numbers each side', () => {
    const lines = parsePatch('@@ -10,3 +10,4 @@ fn\n ctx\n-old\n+new\n+more\n\\ No newline at end of file')
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['hunk', null, null],
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['note', null, null],
    ])
  })
})
