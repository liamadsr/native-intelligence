/**
 * The Reviews page's pure half (docs/plans/github-reviews.md, phase 1): the
 * search a section and its filters make, the GraphQL that reads it, what a
 * pull request looks like once read, its board column, and whether the
 * person may merge it from here.
 *
 * Every pull request is read live from GitHub with the person's own token
 * (./reviews-server.ts); nothing here is stored. Filter values the person
 * types are checked against GitHub's own shapes (an `owner/name`, a login, a
 * label's text) before they become a qualifier, so no value can add a
 * qualifier of its own.
 *
 * Client-safe and pure.
 */

export const REVIEW_SECTIONS = ['review_requests', 'authored', 'assigned', 'involves'] as const
export type ReviewSection = (typeof REVIEW_SECTIONS)[number]

export const SECTION_LABEL: Record<ReviewSection, string> = {
  review_requests: 'Review requests',
  authored: 'Authored by me',
  assigned: 'Assigned to me',
  involves: 'Involves me',
}

const SECTION_QUALIFIER: Record<ReviewSection, string> = {
  review_requests: 'review-requested:@me',
  authored: 'author:@me',
  assigned: 'assignee:@me',
  involves: 'involves:@me',
}

export const REVIEW_STATES = ['open', 'closed', 'all'] as const
export type ReviewStateFilter = (typeof REVIEW_STATES)[number]

export const REVIEW_DECISIONS = ['none', 'required', 'approved', 'changes_requested'] as const
export type ReviewDecisionFilter = (typeof REVIEW_DECISIONS)[number]

export const REVIEW_SORTS = ['updated', 'created'] as const
export type ReviewSort = (typeof REVIEW_SORTS)[number]

export const LINKED_FILTERS = ['any', 'linked', 'unlinked'] as const
export type LinkedFilter = (typeof LINKED_FILTERS)[number]

export interface ReviewFilters {
  section: ReviewSection
  state: ReviewStateFilter
  repo?: string | null
  author?: string | null
  assignee?: string | null
  label?: string | null
  review?: ReviewDecisionFilter | null
  linked?: LinkedFilter
  sort: ReviewSort
}

/** `owner/name`, as GitHub allows them. */
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
/** A GitHub login (39 at most, letters, digits and single hyphens, not at either end), or `@me`. */
export const LOGIN_RE = /^(?:@me|[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/
/** A label's text: no quotes, backslashes or line breaks (it goes inside a quoted qualifier). */
const LABEL_RE = /^[^"\\\r\n]{1,50}$/

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback
}

function clean(value: unknown, re: RegExp): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v && re.test(v) ? v : null
}

/** The filters from a request's query string: anything malformed is dropped (never passed on). */
export function parseReviewFilters(params: URLSearchParams | Record<string, string | null | undefined>): ReviewFilters {
  const get = (k: string): string | null => (params instanceof URLSearchParams ? params.get(k) : (params[k] ?? null))
  const review = get('review')
  return {
    section: oneOf(REVIEW_SECTIONS, get('section'), 'review_requests'),
    state: oneOf(REVIEW_STATES, get('state'), 'open'),
    repo: clean(get('repo'), REPO_RE),
    author: clean(get('author'), LOGIN_RE),
    assignee: clean(get('assignee'), LOGIN_RE),
    label: clean(get('label'), LABEL_RE),
    review: review && (REVIEW_DECISIONS as readonly string[]).includes(review) ? (review as ReviewDecisionFilter) : null,
    linked: oneOf(LINKED_FILTERS, get('linked'), 'any'),
    sort: oneOf(REVIEW_SORTS, get('sort'), 'updated'),
  }
}

/** The filters as a query string for the page's own fetch (defaults left out). */
export function reviewFiltersQuery(f: ReviewFilters): string {
  const p = new URLSearchParams()
  p.set('section', f.section)
  if (f.state !== 'open') p.set('state', f.state)
  if (f.repo) p.set('repo', f.repo)
  if (f.author) p.set('author', f.author)
  if (f.assignee) p.set('assignee', f.assignee)
  if (f.label) p.set('label', f.label)
  if (f.review) p.set('review', f.review)
  if (f.linked && f.linked !== 'any') p.set('linked', f.linked)
  if (f.sort !== 'updated') p.set('sort', f.sort)
  return p.toString()
}

/** GitHub's search query for a section and its (already parsed) filters. */
export function buildSearchQuery(f: ReviewFilters): string {
  const parts = ['is:pr', 'archived:false', SECTION_QUALIFIER[f.section]]
  if (f.state === 'open') parts.push('is:open')
  if (f.state === 'closed') parts.push('is:closed')
  if (f.repo && REPO_RE.test(f.repo)) parts.push(`repo:${f.repo}`)
  if (f.author && LOGIN_RE.test(f.author)) parts.push(`author:${f.author}`)
  if (f.assignee && LOGIN_RE.test(f.assignee)) parts.push(`assignee:${f.assignee}`)
  if (f.label && LABEL_RE.test(f.label)) parts.push(`label:"${f.label}"`)
  if (f.review === 'none') parts.push('review:none')
  if (f.review === 'required') parts.push('review:required')
  if (f.review === 'approved') parts.push('review:approved')
  if (f.review === 'changes_requested') parts.push('review:changes_requested')
  parts.push(f.sort === 'created' ? 'sort:created-desc' : 'sort:updated-desc')
  return parts.join(' ')
}

/** The fields every pull request is read with (search and one pull request alike). */
const PR_FIELDS = `
  id
  number
  title
  url
  state
  isDraft
  merged
  mergeable
  mergeStateStatus
  reviewDecision
  createdAt
  updatedAt
  additions
  deletions
  changedFiles
  headRefName
  headRefOid
  baseRefName
  viewerCanUpdate
  author { login avatarUrl }
  labels(first: 10) { nodes { name color } }
  assignees(first: 10) { nodes { login avatarUrl } }
  repository { nameWithOwner viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`

export const SEARCH_QUERY = `
query ReviewsSearch($q: String!, $first: Int!, $after: String) {
  viewer { login databaseId }
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`

export const PULL_QUERY = `
query ReviewsPull($owner: String!, $name: String!, $number: Int!) {
  viewer { login databaseId }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_FIELDS}
      body
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 50) {
                nodes {
                  __typename
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`

export type RollupState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null
export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** A pull request as the page shows it. */
export interface ReviewPr {
  id: string
  repo: string
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  /** GitHub's MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeable: string | null
  /** GitHub's CLEAN / BLOCKED / BEHIND / DIRTY / UNSTABLE / HAS_HOOKS / DRAFT / UNKNOWN. */
  mergeState: string | null
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED, or null (no review required). */
  reviewDecision: string | null
  checks: RollupState
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  headRef: string | null
  headSha: string | null
  baseRef: string | null
  author: { login: string; avatarUrl: string | null } | null
  labels: Array<{ name: string; color: string | null }>
  assignees: Array<{ login: string; avatarUrl: string | null }>
  /** The person's permission on the repository (ADMIN, MAINTAIN, WRITE, TRIAGE, READ). */
  permission: string | null
  mergeMethods: MergeMethod[]
  /** The actions this pull request is linked to that the person can see (filled by the server). */
  linked: Array<{ id: string; identifier: string | null; title: string | null }>
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const nodes = (v: unknown): Json[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : [])

/** One GraphQL PullRequest node as a ReviewPr, or null for anything else (an issue, a node GitHub hid). */
export function normalizePr(raw: unknown): ReviewPr | null {
  const n = obj(raw)
  const repo = obj(n.repository)
  const repoName = str(repo.nameWithOwner)
  if (!str(n.id) || typeof n.number !== 'number' || !repoName) return null
  const rollup = obj(obj(obj(nodes(n.commits)[0]).commit).statusCheckRollup)
  const state = n.merged === true ? 'merged' : str(n.state) === 'OPEN' ? 'open' : 'closed'
  const methods: MergeMethod[] = []
  if (repo.squashMergeAllowed === true) methods.push('squash')
  if (repo.mergeCommitAllowed === true) methods.push('merge')
  if (repo.rebaseMergeAllowed === true) methods.push('rebase')
  const author = obj(n.author)
  return {
    id: str(n.id)!,
    repo: repoName,
    number: n.number,
    title: str(n.title) ?? '',
    url: str(n.url) ?? `https://github.com/${repoName}/pull/${n.number}`,
    state,
    draft: n.isDraft === true,
    mergeable: str(n.mergeable),
    mergeState: str(n.mergeStateStatus),
    reviewDecision: str(n.reviewDecision),
    checks: (str(rollup.state) as RollupState) ?? null,
    createdAt: str(n.createdAt) ?? '',
    updatedAt: str(n.updatedAt) ?? '',
    additions: num(n.additions),
    deletions: num(n.deletions),
    changedFiles: num(n.changedFiles),
    headRef: str(n.headRefName),
    headSha: str(n.headRefOid),
    baseRef: str(n.baseRefName),
    author: str(author.login) ? { login: str(author.login)!, avatarUrl: str(author.avatarUrl) } : null,
    labels: nodes(n.labels).filter((l) => str(l.name)).map((l) => ({ name: str(l.name)!, color: str(l.color) })),
    assignees: nodes(n.assignees).filter((a) => str(a.login)).map((a) => ({ login: str(a.login)!, avatarUrl: str(a.avatarUrl) })),
    permission: str(repo.viewerPermission),
    mergeMethods: methods,
    linked: [],
  }
}

export const BOARD_COLUMNS = ['draft', 'in_review', 'checks_failing', 'conflicts', 'ready', 'merged'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

export const BOARD_COLUMN_LABEL: Record<BoardColumn, string> = {
  draft: 'Draft',
  in_review: 'In review',
  checks_failing: 'Checks failing',
  conflicts: 'Conflicts',
  ready: 'Ready to merge',
  merged: 'Merged',
}

const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS'])
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

/** Checks that pass: every one succeeded, or there are none. */
export function checksPass(pr: Pick<ReviewPr, 'checks'>): boolean {
  return pr.checks === 'SUCCESS' || pr.checks === null
}

/** Approved, or a repository that requires no review. */
function reviewed(pr: Pick<ReviewPr, 'reviewDecision'>): boolean {
  return pr.reviewDecision === 'APPROVED' || pr.reviewDecision === null
}

/**
 * The board column a pull request sits in, first match winning: merged,
 * draft, conflicts, failing checks, ready, else in review. A closed one that
 * never merged has none (null).
 */
export function boardColumn(pr: Pick<ReviewPr, 'state' | 'draft' | 'mergeable' | 'mergeState' | 'checks' | 'reviewDecision'>): BoardColumn | null {
  if (pr.state === 'merged') return 'merged'
  if (pr.state !== 'open') return null
  if (pr.draft) return 'draft'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'conflicts'
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return 'checks_failing'
  if (reviewed(pr) && checksPass(pr) && MERGEABLE_STATES.has(pr.mergeState ?? '')) return 'ready'
  return 'in_review'
}

/** Why the person can't merge it from here, or null when they can. Pure; the server checks it again before merging. */
export function mergeBlocker(pr: Pick<ReviewPr, 'state' | 'draft' | 'mergeable' | 'mergeState' | 'checks' | 'reviewDecision' | 'permission' | 'mergeMethods' | 'headSha'>): string | null {
  if (pr.state !== 'open') return 'It is not open.'
  if (pr.draft) return 'It is a draft.'
  if (!WRITE_PERMISSIONS.has(pr.permission ?? '')) return 'Your GitHub access to this repository does not allow merging.'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'It has conflicts.'
  if (!checksPass(pr)) return pr.checks === 'PENDING' || pr.checks === 'EXPECTED' ? 'Its checks are still running.' : 'Its checks are failing.'
  if (!reviewed(pr)) return 'It is not approved yet.'
  if (!MERGEABLE_STATES.has(pr.mergeState ?? '')) return 'GitHub does not say it is ready to merge yet.'
  if (pr.mergeMethods.length === 0) return 'The repository allows no merge method.'
  if (!pr.headSha) return 'Its head commit is unknown.'
  return null
}

/** One check on the pull request's head commit, as the panel lists it. */
export interface ReviewCheck {
  name: string
  /** success, failure, pending, neutral, skipped… (lower case). */
  outcome: string
  url: string | null
}

/** The checks out of a PULL_QUERY answer's head commit. */
export function normalizeChecks(rawPr: unknown): ReviewCheck[] {
  const rollup = obj(obj(obj(nodes(obj(rawPr).commits)[0]).commit).statusCheckRollup)
  return nodes(rollup.contexts)
    .map((c): ReviewCheck | null => {
      if (c.__typename === 'CheckRun') {
        const status = str(c.status)
        const outcome = status && status !== 'COMPLETED' ? 'pending' : (str(c.conclusion) ?? 'pending').toLowerCase()
        return { name: str(c.name) ?? 'Check', outcome, url: str(c.detailsUrl) }
      }
      if (c.__typename === 'StatusContext') {
        return { name: str(c.context) ?? 'Status', outcome: (str(c.state) ?? 'pending').toLowerCase(), url: str(c.targetUrl) }
      }
      return null
    })
    .filter((c): c is ReviewCheck => !!c)
}

/** One changed file, as REST's `pulls/{n}/files` gives it. */
export interface ReviewFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** The unified diff hunk text; absent for a binary or a too-large file. */
  patch: string | null
  previousFilename: string | null
}

export function normalizeFiles(raw: unknown): ReviewFile[] {
  if (!Array.isArray(raw)) return []
  return raw.map(obj).filter((f) => str(f.filename)).map((f) => ({
    filename: str(f.filename)!,
    status: str(f.status) ?? 'modified',
    additions: num(f.additions),
    deletions: num(f.deletions),
    patch: str(f.patch),
    previousFilename: str(f.previous_filename),
  }))
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note'
export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

/** A file's patch as numbered lines, for the read-only diff. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      out.push({ kind: 'hunk', text: line, oldNo: null, newNo: null })
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'note', text: line, oldNo: null, newNo: null })
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    } else {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return out
}

/** A pull request's key across the page: `owner/name#12`. */
export const prKey = (repo: string, number: number): string => `${repo}#${number}`
