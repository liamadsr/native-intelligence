/**
 * Tests for the transport helpers the compose panel's option routes call:
 *   jira-api:   listCreateMetaFields, listCreateMetaIssueTypes, searchAssignableUsers
 *   asana-api:  listWorkspaceUsers, typeaheadUsers
 *   linear-api: listAssignableUsers, listTeamLabels
 *
 * One file across the three clients because these helpers exist for ONE feature
 * and each provider's trap here is a different answer to the same question —
 * "when have I seen everything?" — which is easiest to compare side by side:
 *  - Jira createmeta pages on startAt and ends on a SHORT page.
 *  - Jira assignable/search under-returns BY DESIGN, so a short page means
 *    nothing and only an EMPTY one ends the walk.
 *  - Asana typeahead has no cursor at all and is explicitly non-authoritative.
 *  - Linear pages on a Relay cursor, and its own filters cannot express `guest`
 *    or `app` — so those are dropped client-side or not at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  listCreateMetaFields,
  listCreateMetaIssueTypes,
  searchAssignableUsers,
} from '@/lib/integrations/jira-api'
import { listWorkspaceUsers, typeaheadUsers } from '@/lib/integrations/asana-api'
import { listAssignableUsers, listTeamLabels } from '@/lib/integrations/linear-api'

type FakeResponse = {
  status?: number
  ok?: boolean
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}
let responses: FakeResponse[] = []
let requests: Array<{ url: string; init: RequestInit | undefined }> = []

function pushJson(body: unknown, status = 200) {
  responses.push({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

/** A Linear GraphQL success envelope. */
function pushData(data: unknown) {
  responses.push({ status: 200, ok: true, text: async () => JSON.stringify({ data }) })
}

/** The parsed `{ query, variables }` body of the Nth fetch (Linear only). */
function bodyOf(index: number): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(requests[index].init?.body))
}

const CLOUD = 'cafe0123'

beforeEach(() => {
  responses = []
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error(`no fake response queued for ${url}`)
    return {
      status: next.status ?? 200,
      ok: next.ok ?? true,
      json: next.json ?? (async () => ({})),
      text: next.text ?? (async () => ''),
      headers: { get: () => null },
    } as unknown as Response
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- Jira: createmeta fields ----------------------------------------------

describe('listCreateMetaFields', () => {
  it('asks the SPLIT createmeta endpoint, not the deprecated expand= form', async () => {
    pushJson({ fields: [{ fieldId: 'summary' }], total: 1 })
    await listCreateMetaFields('tok', CLOUD, '10000', '10001')
    expect(requests[0].url).toContain('/issue/createmeta/10000/issuetypes/10001')
    expect(requests[0].url).not.toContain('expand=')
  })

  /**
   * PAGING IS THE POINT here, unlike the issue-type list. A required custom
   * field on page 2 is exactly the one that would 400 the create, so stopping
   * at page 1 would defeat the reason for asking at all.
   */
  it('walks every page until a SHORT one', async () => {
    pushJson({ fields: Array.from({ length: 50 }, (_, i) => ({ fieldId: `f${i}` })), total: 62 })
    pushJson({ fields: Array.from({ length: 12 }, (_, i) => ({ fieldId: `g${i}` })), total: 62 })
    const fields = await listCreateMetaFields('tok', CLOUD, '10000', '10001')
    expect(fields).toHaveLength(62)
    expect(requests).toHaveLength(2)
    expect(requests[1].url).toContain('startAt=50')
  })

  it('stops on `total` even when the last page came back full', async () => {
    pushJson({ fields: Array.from({ length: 50 }, (_, i) => ({ fieldId: `f${i}` })), total: 50 })
    const fields = await listCreateMetaFields('tok', CLOUD, '10000', '10001')
    expect(fields).toHaveLength(50)
    expect(requests).toHaveLength(1)
  })

  /** A bounded walk: a project that never reports exhaustion cannot loop. */
  it('caps the walk rather than paging forever', async () => {
    for (let i = 0; i < 10; i++) {
      pushJson({ fields: Array.from({ length: 50 }, (_, j) => ({ fieldId: `p${i}-${j}` })) })
    }
    const fields = await listCreateMetaFields('tok', CLOUD, '10000', '10001')
    expect(requests).toHaveLength(5)
    expect(fields).toHaveLength(250)
  })

  it('returns an empty list for a body with no fields', async () => {
    pushJson({})
    expect(await listCreateMetaFields('tok', CLOUD, '10000', '10001')).toEqual([])
  })
})

// ---- Jira: issue types (now paged) -----------------------------------------

describe('listCreateMetaIssueTypes', () => {
  it('walks past the first page', async () => {
    pushJson({ issueTypes: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}` })), total: 53 })
    pushJson({ issueTypes: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }], total: 53 })
    const types = await listCreateMetaIssueTypes('tok', CLOUD, '10000')
    expect(types).toHaveLength(53)
    expect(requests).toHaveLength(2)
  })

  /** The ordinary project: one short page, one request, unchanged behaviour. */
  it('makes exactly ONE request for a project that fits on a page', async () => {
    pushJson({ issueTypes: [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug', subtask: false }] })
    const types = await listCreateMetaIssueTypes('tok', CLOUD, '10000')
    expect(types).toHaveLength(2)
    expect(requests).toHaveLength(1)
  })
})

// ---- Jira: assignable users ------------------------------------------------

describe('searchAssignableUsers', () => {
  it('scopes by project KEY and omits an empty query', async () => {
    pushJson([])
    await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(requests[0].url).toContain('/user/assignable/search')
    expect(requests[0].url).toContain('project=ENG')
    // Jira treats an ABSENT query as "everyone assignable"; a blank one is not
    // the same thing to it, so the param is omitted rather than sent empty.
    expect(requests[0].url).not.toContain('query=')
  })

  it('passes a query through when one is given', async () => {
    pushJson([])
    await searchAssignableUsers('tok', CLOUD, 'ENG', { query: 'ada' })
    expect(requests[0].url).toContain('query=ada')
  })

  /**
   * THE UNDER-RETURN TRAP. Atlassian documents that this endpoint "usually
   * returns fewer users than specified in maxResults" because the permission
   * filter runs after the match — so a short page is NORMAL and must not be read
   * as exhaustion the way every other Jira list can be.
   */
  it('keeps paging after a SHORT but non-empty page', async () => {
    pushJson([{ accountId: 'a1', displayName: 'Ada' }])
    pushJson([{ accountId: 'a2', displayName: 'Bob' }])
    pushJson([])
    const users = await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(users.map((u) => u.accountId)).toEqual(['a1', 'a2'])
    expect(requests).toHaveLength(3)
  })

  it('stops on the first EMPTY page', async () => {
    pushJson([])
    await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(requests).toHaveLength(1)
  })

  it('caps the walk', async () => {
    for (let i = 0; i < 10; i++) pushJson([{ accountId: `a${i}` }])
    const users = await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(requests).toHaveLength(3)
    expect(users).toHaveLength(3)
  })

  /** A user with no accountId cannot be assigned to anything. */
  it('drops users with no accountId', async () => {
    pushJson([{ displayName: 'Ghost' }, { accountId: 'a1', displayName: 'Ada' }])
    pushJson([])
    const users = await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(users.map((u) => u.accountId)).toEqual(['a1'])
  })

  /** Paging by offset over a permission-filtered list can repeat a row. */
  it('de-duplicates across pages by accountId', async () => {
    pushJson([{ accountId: 'a1' }])
    pushJson([{ accountId: 'a1' }, { accountId: 'a2' }])
    pushJson([])
    const users = await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(users.map((u) => u.accountId)).toEqual(['a1', 'a2'])
  })

  /** Privacy settings blank the email while accountId stays populated. */
  it('preserves a null emailAddress rather than dropping the user', async () => {
    pushJson([{ accountId: 'a1', displayName: 'Ada', emailAddress: null }])
    pushJson([])
    const users = await searchAssignableUsers('tok', CLOUD, 'ENG')
    expect(users[0]).toMatchObject({ accountId: 'a1', emailAddress: null })
  })
})

// ---- Asana: users ----------------------------------------------------------

describe('listWorkspaceUsers', () => {
  /** Asana returns the compact gid-only form unless opt_fields asks for more. */
  it('requests name AND email explicitly via opt_fields', async () => {
    pushJson({ data: [{ gid: '1', name: 'Ada' }] })
    await listWorkspaceUsers('tok', 'ws-gid')
    expect(requests[0].url).toContain('/workspaces/ws-gid/users')
    expect(decodeURIComponent(requests[0].url)).toContain('opt_fields=gid,name,email')
  })

  it('returns the opaque next-page offset', async () => {
    pushJson({ data: [{ gid: '1' }], next_page: { offset: 'cursor-2' } })
    const page = await listWorkspaceUsers('tok', 'ws-gid')
    expect(page.nextOffset).toBe('cursor-2')
  })

  it('reports exhaustion as a null offset', async () => {
    pushJson({ data: [{ gid: '1' }] })
    expect((await listWorkspaceUsers('tok', 'ws-gid')).nextOffset).toBeNull()
  })
})

describe('typeaheadUsers', () => {
  it('asks the typeahead endpoint scoped to resource_type=user', async () => {
    pushJson({ data: [{ gid: '1', name: 'Ada' }] })
    await typeaheadUsers('tok', 'ws-gid', 'ad')
    const url = decodeURIComponent(requests[0].url)
    expect(url).toContain('/workspaces/ws-gid/typeahead')
    expect(url).toContain('resource_type=user')
    expect(url).toContain('query=ad')
  })

  /** Typeahead has no cursor — one page is the whole contract. */
  it('makes exactly one request', async () => {
    pushJson({ data: [] })
    await typeaheadUsers('tok', 'ws-gid', 'ad')
    expect(requests).toHaveLength(1)
  })
})

// ---- Linear: assignable users ----------------------------------------------

describe('listAssignableUsers', () => {
  /**
   * No query → Team.members. There is NO `assignableUsers` field in Linear's
   * schema, so team membership is the closest real notion of "who belongs here".
   */
  it('uses Team.members when a team is given and nothing is typed', async () => {
    pushData({ team: { members: { nodes: [{ id: 'u1', displayName: 'ada' }] } } })
    const users = await listAssignableUsers('tok', { teamId: 'team-1' })
    expect(bodyOf(0).query).toContain('members(')
    expect(bodyOf(0).variables).toMatchObject({ teamId: 'team-1' })
    expect(users.map((u) => u.id)).toEqual(['u1'])
  })

  /**
   * A typed query goes WORKSPACE-wide and filters on BOTH displayName and name:
   * they are separate fields (nickname vs full name) and a user typing either
   * expects a hit.
   */
  it('filters on displayName OR name when a query is typed', async () => {
    pushData({ users: { nodes: [] } })
    await listAssignableUsers('tok', { teamId: 'team-1', query: 'ada' })
    const query = bodyOf(0).query
    expect(query).toContain('displayName: { containsIgnoreCase: $q }')
    expect(query).toContain('name: { containsIgnoreCase: $q }')
    expect(bodyOf(0).variables).toMatchObject({ q: 'ada' })
  })

  /**
   * Complexity cost multiplies by `first`, and the default when omitted is 50.
   * An explicit small page is the entire cost story for a typeahead.
   */
  it('ALWAYS passes an explicit small `first`', async () => {
    pushData({ users: { nodes: [] } })
    await listAssignableUsers('tok', { query: 'ada' })
    expect(bodyOf(0).variables.first).toBe(10)
  })

  it('caps `first` at the list maximum', async () => {
    pushData({ users: { nodes: [] } })
    await listAssignableUsers('tok', { query: 'ada', first: 500 })
    expect(bodyOf(0).variables.first).toBe(50)
  })

  /**
   * `UserFilter` has no comparator for either flag, so this filtering CANNOT be
   * server-side — it is a schema fact, not a shortcut.
   */
  it('filters out app and guest actors client-side', async () => {
    pushData({
      users: {
        nodes: [
          { id: 'u1', displayName: 'ada' },
          { id: 'bot', displayName: 'Deploy Bot', app: true },
          { id: 'g1', displayName: 'contractor', guest: true },
        ],
      },
    })
    const users = await listAssignableUsers('tok', { query: 'a' })
    expect(users.map((u) => u.id)).toEqual(['u1'])
  })

  it('falls back to a workspace listing with neither team nor query', async () => {
    pushData({ users: { nodes: [{ id: 'u1' }] } })
    const users = await listAssignableUsers('tok')
    expect(bodyOf(0).query).toContain('users(first: $first)')
    expect(users.map((u) => u.id)).toEqual(['u1'])
  })
})

// ---- Linear: labels --------------------------------------------------------

describe('listTeamLabels', () => {
  /**
   * ONE query, not two: workspace-level labels are simply labels whose `team` is
   * null, so the scope is an `or` filter rather than a union of round trips.
   */
  it('asks for the team’s labels OR the null-team (workspace) ones', async () => {
    pushData({ issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } })
    await listTeamLabels('tok', 'team-1')
    const query = bodyOf(0).query
    expect(query).toContain('team: { id: { eq: $teamId } }')
    expect(query).toContain('team: { null: true }')
  })

  /**
   * THE isGroup TRAP. A group label is a container whose CHILDREN are the
   * applicable labels; its own id in `labelIds` is rejected. Excluded in the
   * transport so no caller can forget.
   */
  it('EXCLUDES group labels', async () => {
    pushData({
      issueLabels: {
        nodes: [
          { id: 'l1', name: 'bug', isGroup: false },
          { id: 'grp', name: 'Type', isGroup: true },
          { id: 'l2', name: 'chore' },
        ],
        pageInfo: { hasNextPage: false },
      },
    })
    const labels = await listTeamLabels('tok', 'team-1')
    expect(labels.map((l) => l.id)).toEqual(['l1', 'l2'])
  })

  it('preserves the team scope so the panel can distinguish shared labels', async () => {
    pushData({
      issueLabels: {
        nodes: [
          { id: 'l1', name: 'bug', team: { id: 'team-1' } },
          { id: 'l2', name: 'urgent', team: null },
        ],
        pageInfo: { hasNextPage: false },
      },
    })
    const labels = await listTeamLabels('tok', 'team-1')
    expect(labels[0].team).toEqual({ id: 'team-1' })
    expect(labels[1].team).toBeNull()
  })

  it('follows the Relay cursor across pages', async () => {
    pushData({
      issueLabels: {
        nodes: [{ id: 'l1' }],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      },
    })
    pushData({
      issueLabels: { nodes: [{ id: 'l2' }], pageInfo: { hasNextPage: false } },
    })
    const labels = await listTeamLabels('tok', 'team-1')
    expect(labels.map((l) => l.id)).toEqual(['l1', 'l2'])
    expect(bodyOf(1).variables.after).toBe('c1')
  })

  it('stops when hasNextPage is true but the cursor is missing', async () => {
    pushData({
      issueLabels: { nodes: [{ id: 'l1' }], pageInfo: { hasNextPage: true, endCursor: null } },
    })
    const labels = await listTeamLabels('tok', 'team-1')
    expect(labels.map((l) => l.id)).toEqual(['l1'])
    expect(requests).toHaveLength(1)
  })
})
