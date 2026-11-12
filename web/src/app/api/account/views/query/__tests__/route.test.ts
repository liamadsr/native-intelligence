/**
 * Tests for POST /api/account/views/query — the hot list-view query route
 * (S1 in the perf audit).
 *
 * What is locked in by the perf phase 2 migration:
 *  - auth flows through requireWorkspaceMember (mocked here), which resolves
 *    user + workspace + member in ONE query — the route must NOT issue its own
 *    member-table lookup for action scoping anymore,
 *  - the member id from the auth context feeds action scoping; non-action
 *    entities keep memberId undefined exactly as before,
 *  - error semantics: 401 passthrough, 400 for a missing entity_type, 500
 *    with the thrown message on query failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  requireWorkspaceFeature: vi.fn(),
  buildEntityQuery: vi.fn(),
  applyFilters: vi.fn(),
  applyCompletedFilter: vi.fn(),
  applyOrdering: vi.fn(),
  resolvePersonalScope: vi.fn(),
  /** Tables touched via supabase.from — proves no member-table roundtrip. */
  fromTables: [] as string[],
  queryResult: { data: [] as unknown[], count: 0, error: null as unknown },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
  requireWorkspaceFeature: hoisted.requireWorkspaceFeature,
}))

vi.mock('@/lib/views/query-engine', () => ({
  buildEntityQuery: hoisted.buildEntityQuery,
  applyFilters: hoisted.applyFilters,
  applyCompletedFilter: hoisted.applyCompletedFilter,
  applyEntityDefaults: vi.fn(),
  applyTeamScope: vi.fn(),
  applyOrdering: hoisted.applyOrdering,
  applyPagination: vi.fn(),
  applySearch: vi.fn(),
  customFieldTypesFor: vi.fn(async () => undefined),
  viewFieldsOf: vi.fn(() => []),
  resolvePersonalScope: hoisted.resolvePersonalScope,
  groupResults: vi.fn((items: unknown[]) => [{ key: 'all', label: 'All', items }]),
  CATEGORY_ORDER: {},
  CATEGORY_LABELS: {},
  SEQUENCE_STATUS_ORDER: {},
  SEQUENCE_STATUS_LABELS: {},
  EVAL_OUTCOME_ORDER: { passed: 0, scored: 1, failed: 2, errored: 3 },
  EVAL_OUTCOME_LABELS: { passed: 'Passed', scored: 'Scored', failed: 'Failed', errored: 'Errored' },
  NoMatchSignal: class NoMatchSignal extends Error {},
}))

const { POST } = await import('@/app/api/account/views/query/route')

/** Thenable stand-in for the query builder the engine returns. */
function makeQuery() {
  const query: Record<string, unknown> = {
    not: vi.fn(() => query),
    is: vi.fn(() => query),
    eq: vi.fn(() => query),
    neq: vi.fn(() => query),
    then: (cb: (v: unknown) => unknown) => Promise.resolve(hoisted.queryResult).then(cb),
  }
  return query
}

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      hoisted.fromTables.push(table)
      const chain: Record<string, unknown> = {
        then: (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb),
      }
      return new Proxy(chain, {
        get(target, prop: string) {
          if (prop in target) return target[prop]
          return () => new Proxy(chain, this)
        },
      })
    },
  }
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/views/query',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.requireWorkspaceFeature.mockReset().mockResolvedValue(null)
  hoisted.buildEntityQuery.mockReset()
  hoisted.applyFilters.mockReset()
  hoisted.applyCompletedFilter.mockReset()
  hoisted.applyOrdering.mockReset()
  hoisted.resolvePersonalScope.mockReset()
  hoisted.fromTables = []
  hoisted.queryResult = { data: [{ id: 'a-1', title: 'Do it' }], count: 1, error: null }

  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1' },
  })
  hoisted.buildEntityQuery.mockImplementation(() => makeQuery())
  hoisted.applyFilters.mockResolvedValue(undefined)
  hoisted.applyCompletedFilter.mockResolvedValue(undefined)
  hoisted.resolvePersonalScope.mockResolvedValue({
    memberIds: ['member-1', 'member-2'],
    workspaceIds: ['workspace-1', 'workspace-2'],
  })
})

describe('POST /api/account/views/query', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action' }))
    expect(res.status).toBe(401)
    expect(hoisted.buildEntityQuery).not.toHaveBeenCalled()
  })

  it('returns 400 when entity_type is missing', async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('entity_type is required')
  })

  it('feeds member.id from the auth context into action scoping — no member-table query', async () => {
    const res = await POST(postReq({ entity_type: 'action', action_scope: 'assigned' }))
    expect(res.status).toBe(200)

    // The old route issued supabase.from('member') per request; the auth
    // helper already resolved the member row, so the table must stay untouched.
    expect(hoisted.fromTables).not.toContain('member')
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(),
      'action',
      'workspace-1',
      'user-1',
      expect.objectContaining({ memberId: 'member-1', actionScope: 'assigned' }),
    )
  })

  it('keeps memberId undefined for non-action entities', async () => {
    await POST(postReq({ entity_type: 'capture' }))
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(),
      'capture',
      'workspace-1',
      'user-1',
      expect.objectContaining({ memberId: undefined }),
    )
  })

  it('returns the standard payload shape', async () => {
    // capture: no project/has_children/contact-count enrichment paths run, so
    // the rows come back exactly as the query returned them.
    const res = await POST(postReq({ entity_type: 'capture', page: 2, per_page: 25 }))
    expect(res.status).toBe(200)
    const body = await readJson<{
      data: unknown[]
      total: number
      page: number
      per_page: number
      display_properties: unknown
    }>(res)
    expect(body.data).toEqual([{ id: 'a-1', title: 'Do it' }])
    expect(body.total).toBe(1)
    expect(body.page).toBe(2)
    expect(body.per_page).toBe(25)
    expect(body.display_properties).toBeDefined()
  })

  it("capture_scope 'mine' filters to the viewer's own captures", async () => {
    const query = makeQuery()
    hoisted.buildEntityQuery.mockReturnValueOnce(query)
    const res = await POST(postReq({ entity_type: 'capture', capture_scope: 'mine' }))
    expect(res.status).toBe(200)
    // user_id is the capture's OWNER — an auth user id, so the filter uses
    // user.id from the auth context, never member.id.
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(query.neq).not.toHaveBeenCalled()
  })

  it("capture_scope 'shared' filters to teammates' workspace-visible captures", async () => {
    const query = makeQuery()
    hoisted.buildEntityQuery.mockReturnValueOnce(query)
    const res = await POST(postReq({ entity_type: 'capture', capture_scope: 'shared' }))
    expect(res.status).toBe(200)
    expect(query.eq).toHaveBeenCalledWith('visibility', 'workspace')
    expect(query.neq).toHaveBeenCalledWith('user_id', 'user-1')
  })

  it('an absent capture_scope leaves the capture query unfiltered (All)', async () => {
    const query = makeQuery()
    hoisted.buildEntityQuery.mockReturnValueOnce(query)
    await POST(postReq({ entity_type: 'capture' }))
    expect(query.eq).not.toHaveBeenCalled()
    expect(query.neq).not.toHaveBeenCalled()
  })

  it('capture_scope is ignored for non-capture entities', async () => {
    const query = makeQuery()
    hoisted.buildEntityQuery.mockReturnValueOnce(query)
    await POST(postReq({ entity_type: 'action', capture_scope: 'mine' }))
    expect(query.eq).not.toHaveBeenCalled()
    expect(query.neq).not.toHaveBeenCalled()
  })

  it('returns 500 with the message when the query errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.queryResult = { data: null as unknown as unknown[], count: 0, error: { message: 'db down' } }
    const res = await POST(postReq({ entity_type: 'action' }))
    expect(res.status).toBe(500)
  })
})

/**
 * `workspace_scope` — the request-level switch for PERSONAL SCOPE (all of the
 * caller's workspaces) versus the active one.
 *
 * The contract the client depends on, and the one the server has to enforce:
 * the body carries a SCOPE, never a workspace list. Which workspaces "all"
 * means is resolved here, from the `member` table, by resolvePersonalScope.
 *
 * The default is what most of these tests are really about. Every existing
 * caller omits the field, and an omitted field must reach the engine as the
 * single active workspace, with no membership read paid for and no argument
 * changed anywhere downstream.
 */
describe('POST /api/account/views/query — workspace_scope', () => {
  it('defaults to the active workspace and never reads the membership set', async () => {
    const res = await POST(postReq({ entity_type: 'action', action_scope: 'assigned' }))
    expect(res.status).toBe(200)
    expect(hoisted.resolvePersonalScope).not.toHaveBeenCalled()
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(),
      'action',
      'workspace-1',
      'user-1',
      expect.objectContaining({
        memberId: 'member-1',
        actionScope: 'assigned',
        workspaceScope: 'workspace',
        personalScope: undefined,
      }),
    )
    // The workspace-scoped helpers keep taking the single id, exactly as before.
    expect(hoisted.applyCompletedFilter).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'all', true, 'workspace-1',
    )
    expect(hoisted.applyOrdering).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'action', { tieBreakOnId: false },
    )
  })

  it("an explicit 'workspace' behaves identically to omitting it", async () => {
    await POST(postReq({ entity_type: 'action', workspace_scope: 'workspace' }))
    expect(hoisted.resolvePersonalScope).not.toHaveBeenCalled()
    expect(hoisted.applyCompletedFilter).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'all', true, 'workspace-1',
    )
  })

  it('accepts an explicit null — the shape the sibling scope fields already use', async () => {
    const res = await POST(postReq({ entity_type: 'action', workspace_scope: null }))
    expect(res.status).toBe(200)
    expect(hoisted.resolvePersonalScope).not.toHaveBeenCalled()
  })

  it('rejects an unrecognized scope with 400 instead of quietly narrowing', async () => {
    // Coercing an unknown value to 'workspace' would answer a request for the
    // cross-workspace list with a single-workspace one that looks correct.
    const res = await POST(postReq({ entity_type: 'action', workspace_scope: 'everything' }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe("workspace_scope must be 'workspace' or 'all'")
    expect(hoisted.buildEntityQuery).not.toHaveBeenCalled()
    expect(hoisted.resolvePersonalScope).not.toHaveBeenCalled()
  })

  it("resolves the membership set SERVER-side for 'all' and threads it into the engine", async () => {
    const res = await POST(postReq({
      entity_type: 'action',
      action_scope: 'assigned',
      workspace_scope: 'all',
    }))
    expect(res.status).toBe(200)

    // Resolved from the authenticated user, not from anything in the body.
    expect(hoisted.resolvePersonalScope).toHaveBeenCalledWith(expect.anything(), 'user-1')
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(),
      'action',
      'workspace-1',
      'user-1',
      expect.objectContaining({
        workspaceScope: 'all',
        personalScope: { memberIds: ['member-1', 'member-2'], workspaceIds: ['workspace-1', 'workspace-2'] },
      }),
    )
  })

  it("hands the workspace SET to the filter and completed-filter helpers", async () => {
    await POST(postReq({
      entity_type: 'action',
      workspace_scope: 'all',
      filters: [{ id: 'f1', field: 'status_type', operator: 'is', value: 'started' }],
    }))
    // Workflow states are per team, so "done" and "status type" only resolve
    // across workspaces if these two see the whole set.
    expect(hoisted.applyFilters).toHaveBeenCalledWith(
      expect.anything(), 'action', expect.anything(), expect.anything(),
      ['workspace-1', 'workspace-2'],
      expect.anything(),
      expect.anything(),
    )
    expect(hoisted.applyCompletedFilter).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'all', true,
      ['workspace-1', 'workspace-2'],
    )
  })

  it('asks for a total ordering so cross-workspace paging cannot repeat a row', async () => {
    await POST(postReq({ entity_type: 'action', workspace_scope: 'all' }))
    expect(hoisted.applyOrdering).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'action', { tieBreakOnId: true },
    )
  })

  it('merges status columns by CATEGORY — a cross-workspace board is cross-team', async () => {
    const engine = await import('@/lib/views/query-engine')
    await POST(postReq({
      entity_type: 'action',
      workspace_scope: 'all',
      grouping: { field: 'status_id', direction: 'asc' },
    }))
    // 4th arg is mergeByCategory. Workspaces share no workflow_state row and no
    // sort_order, so category is the only key their columns can collapse on.
    expect(vi.mocked(engine.groupResults).mock.calls.at(-1)?.[3]).toBe(true)
  })

  it('merges by category even when a team is named — the scope wins', async () => {
    const engine = await import('@/lib/views/query-engine')
    await POST(postReq({
      entity_type: 'action',
      workspace_scope: 'all',
      team_id: 'team-1',
      grouping: { field: 'status_id', direction: 'asc' },
    }))
    expect(vi.mocked(engine.groupResults).mock.calls.at(-1)?.[3]).toBe(true)
  })

  it('leaves the single-team board keyed by category::name, as it was', async () => {
    const engine = await import('@/lib/views/query-engine')
    await POST(postReq({
      entity_type: 'action',
      team_id: 'team-1',
      grouping: { field: 'status_id', direction: 'asc' },
    }))
    expect(vi.mocked(engine.groupResults).mock.calls.at(-1)?.[3]).toBe(false)
  })

  it("resolves the set for the Projects list too, and hands it to the engine and the filters", async () => {
    const res = await POST(postReq({
      entity_type: 'project',
      workspace_scope: 'all',
      filters: [{ id: 'f1', field: 'status', operator: 'is', value: 'started' }],
    }))
    expect(res.status).toBe(200)
    expect(hoisted.resolvePersonalScope).toHaveBeenCalledWith(expect.anything(), 'user-1')
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(),
      'project',
      'workspace-1',
      'user-1',
      expect.objectContaining({
        workspaceScope: 'all',
        personalScope: { memberIds: ['member-1', 'member-2'], workspaceIds: ['workspace-1', 'workspace-2'] },
      }),
    )
    expect(hoisted.applyFilters).toHaveBeenCalledWith(
      expect.anything(), 'project', expect.anything(), expect.anything(),
      ['workspace-1', 'workspace-2'],
      expect.anything(),
      expect.anything(),
    )
  })

  it('is actions and projects only — other entities pay for no membership read', async () => {
    // The engine ignores the scope for them, so resolving the set would be a
    // round trip bought for a value nothing reads.
    await POST(postReq({ entity_type: 'capture', workspace_scope: 'all' }))
    expect(hoisted.resolvePersonalScope).not.toHaveBeenCalled()
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(), 'capture', 'workspace-1', 'user-1',
      expect.objectContaining({ personalScope: undefined }),
    )
  })
})

// ── Sequence contact-scope enrichment ────────────────────────────────────────
// When the internal enrolled_contact_id scope filter is present (the contact
// detail panel's embedded Sequences view), the route merges THAT contact's own
// enrollment onto each row as `contact_enrollment` — status / progress / next
// send, plus the sequence's active-step count for "Step X of N". Global lists
// (no scope filter) must not get the key at all, and must not pay the extra
// enrollment/step queries.

/** Table-aware supabase fake: from(table) chains resolve to that table's rows. */
function makeTableSupabase(tableRows: Record<string, unknown[]>) {
  return {
    from: (table: string) => {
      hoisted.fromTables.push(table)
      const rows = tableRows[table] ?? []
      const chain: Record<string, unknown> = {
        then: (cb: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(cb),
      }
      return new Proxy(chain, {
        get(target, prop: string) {
          if (prop in target) return target[prop]
          return () => new Proxy(chain, this)
        },
      })
    },
  }
}

describe('POST /api/account/views/query — sequence contact_enrollment merge', () => {
  const CONTACT_SCOPE = {
    id: '__scope_contact',
    field: 'enrolled_contact_id',
    operator: 'is',
    value: 'contact-1',
  }

  beforeEach(() => {
    hoisted.queryResult = {
      data: [
        { id: 'seq-1', name: 'Investor outreach', timezone: 'America/New_York' },
        { id: 'seq-2', name: 'Onboarding', timezone: 'UTC' },
      ],
      count: 2,
      error: null,
    }
    hoisted.requireWorkspaceMember.mockResolvedValue({
      supabase: makeTableSupabase({
        // Ordered created_at DESC as the route's query asks: the latest row
        // for seq-1 is an EXITED re-enrollment; the active one is older. The
        // active enrollment must still win the per-sequence pick.
        sequence_enrollment: [
          {
            sequence_id: 'seq-1', status: 'exited', exit_reason: 'replied',
            current_step_order: 2, next_send_at: null, created_at: '2026-08-11T00:00:00Z',
          },
          {
            sequence_id: 'seq-1', status: 'active', exit_reason: null,
            current_step_order: 1, next_send_at: '2026-08-13T14:00:00Z', created_at: '2026-08-10T00:00:00Z',
          },
        ],
        sequence_step: [
          { sequence_id: 'seq-1' },
          { sequence_id: 'seq-1' },
          { sequence_id: 'seq-1' },
        ],
      }),
      user: { id: 'user-1' },
      workspaceId: 'workspace-1',
      member: { id: 'member-1' },
    })
  })

  it('merges the scoped contact enrollment (active wins over a newer exit) + step count', async () => {
    const res = await POST(postReq({ entity_type: 'sequence', filters: [CONTACT_SCOPE] }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)

    expect(body.data[0].contact_enrollment).toEqual({
      status: 'active',
      exit_reason: null,
      current_step_order: 1,
      next_send_at: '2026-08-13T14:00:00Z',
      created_at: '2026-08-10T00:00:00Z',
      step_count: 3,
    })
    // A row the contact has no enrollment for carries an explicit null.
    expect(body.data[1].contact_enrollment).toBeNull()
    // Headline counts still ride along, untouched.
    expect(body.data[0].enrollment_counts).toEqual({ total: 2, active: 1, replied: 1 })
  })

  it('without the scope filter, rows carry no contact_enrollment and no extra queries run', async () => {
    const res = await POST(postReq({ entity_type: 'sequence', filters: [] }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)

    expect(body.data[0]).not.toHaveProperty('contact_enrollment')
    // Exactly one sequence_enrollment query (headline counts); no step query.
    expect(hoisted.fromTables.filter((t) => t === 'sequence_enrollment')).toHaveLength(1)
    expect(hoisted.fromTables).not.toContain('sequence_step')
  })

  it('a no-match sentinel scope value never triggers the merge', async () => {
    const res = await POST(postReq({
      entity_type: 'sequence',
      filters: [{ ...CONTACT_SCOPE, value: '__no_match__' }],
    }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)
    expect(body.data[0]).not.toHaveProperty('contact_enrollment')
    expect(hoisted.fromTables).not.toContain('sequence_step')
  })
})

/**
 * eval_suite — the FEATURE GATE and the outcome board.
 *
 * Evals is a hidden per-workspace feature, and every route in its own REST
 * surface (/api/account/evals/*) is gated. This generic route lists ANY
 * registered entity, so without a gate here it would be the one way to read a
 * workspace's suites with Evals off — the leak an ungated generic endpoint
 * always is.
 */
describe('POST /api/account/views/query — eval_suite', () => {
  it('builds the eval_suite query when the feature is on', async () => {
    const res = await POST(postReq({ entity_type: 'eval_suite' }))
    expect(res.status).toBe(200)
    expect(hoisted.requireWorkspaceFeature).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      'evals',
    )
    expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
      expect.anything(),
      'eval_suite',
      'workspace-1',
      'user-1',
      expect.objectContaining({ memberId: undefined }),
    )
  })

  it('returns the gate 403 and never touches the database when Evals is off', async () => {
    hoisted.requireWorkspaceFeature.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: '`Evals` is not enabled for this workspace', code: 'FEATURE_DISABLED' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const res = await POST(postReq({ entity_type: 'eval_suite' }))
    expect(res.status).toBe(403)
    const body = await readJson<{ code: string }>(res)
    expect(body.code).toBe('FEATURE_DISABLED')
    expect(hoisted.buildEntityQuery).not.toHaveBeenCalled()
  })

  it('leaves every other entity ungated — the gate is eval-specific', async () => {
    await POST(postReq({ entity_type: 'action' }))
    expect(hoisted.requireWorkspaceFeature).not.toHaveBeenCalled()
  })

  it('injects an empty column per outcome, best → worst with errored last', async () => {
    // Only 'failed' has rows; the board must still show all four columns plus
    // the never-run one, or a user grouping by outcome sees a board that
    // pretends the other verdicts do not exist.
    const engine = await import('@/lib/views/query-engine')
    vi.mocked(engine.groupResults).mockReturnValueOnce([
      { key: 'failed', label: 'failed', items: [{ id: 's1' }] },
      { key: '__none__', label: 'No value', items: [{ id: 's2' }] },
    ] as never)

    const res = await POST(postReq({
      entity_type: 'eval_suite',
      grouping: { field: 'last_outcome', direction: 'asc' },
    }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<{ key: string; label: string }> }>(res)

    expect(body.data.map((g) => g.key)).toEqual([
      'passed', 'scored', 'failed', 'errored', '__none__',
    ])
    // Injected AND pre-existing columns both carry the display label.
    expect(body.data.map((g) => g.label)).toEqual([
      'Passed', 'Scored', 'Failed', 'Errored', 'No value',
    ])
  })
})

/**
 * eval_case and eval_run — the suite detail page's Cases and Runs tabs.
 *
 * Both are scoped `UnifiedViewLayout` mounts now (the shared views component a
 * project's Actions tab embeds), which means both reach the workspace through
 * THIS generic route. So both need the same feature gate the suite needed, and
 * for exactly the same reason: with Evals off, an ungated generic endpoint is
 * the one way left to read a workspace's cases and runs.
 *
 * The board injection is where the two differ, and the difference is real
 * rather than cosmetic — see the errored test below.
 */
describe('POST /api/account/views/query — eval_case and eval_run', () => {
  for (const entityType of ['eval_case', 'eval_run'] as const) {
    it(`builds the ${entityType} query when the feature is on`, async () => {
      const res = await POST(postReq({ entity_type: entityType }))
      expect(res.status).toBe(200)
      expect(hoisted.requireWorkspaceFeature).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-1' }),
        'evals',
      )
      expect(hoisted.buildEntityQuery).toHaveBeenCalledWith(
        expect.anything(),
        entityType,
        'workspace-1',
        'user-1',
        expect.objectContaining({ memberId: undefined }),
      )
    })

    it(`returns the gate 403 for ${entityType} and never touches the database`, async () => {
      hoisted.requireWorkspaceFeature.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: '`Evals` is not enabled for this workspace', code: 'FEATURE_DISABLED' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      const res = await POST(postReq({ entity_type: entityType }))
      expect(res.status).toBe(403)
      const body = await readJson<{ code: string }>(res)
      expect(body.code).toBe('FEATURE_DISABLED')
      expect(hoisted.buildEntityQuery).not.toHaveBeenCalled()
    })
  }

  it('injects all four outcome columns on a CASE board', async () => {
    // A case's `last_outcome` (migration 257) carries the full TRIAL
    // vocabulary — 'errored' included, because a trial whose harness broke is
    // a real, distinguishable verdict on that case.
    const engine = await import('@/lib/views/query-engine')
    vi.mocked(engine.groupResults).mockReturnValueOnce([
      { key: 'failed', label: 'failed', items: [{ id: 'c1' }] },
      { key: '__none__', label: 'No value', items: [{ id: 'c2' }] },
    ] as never)

    const res = await POST(postReq({
      entity_type: 'eval_case',
      grouping: { field: 'last_outcome', direction: 'asc' },
    }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<{ key: string; label: string }> }>(res)
    expect(body.data.map((g) => g.key)).toEqual([
      'passed', 'scored', 'failed', 'errored', '__none__',
    ])
    expect(body.data.map((g) => g.label)).toEqual([
      'Passed', 'Scored', 'Failed', 'Errored', 'No value',
    ])
  })

  it('injects THREE columns on a RUN board — never an Errored one', async () => {
    // THE ASYMMETRY THIS FILE EXISTS TO PIN. Migration 252's CHECK on
    // eval_run.outcome allows only passed/scored/failed: a run that BROKE is
    // `status = 'failed'`, not an 'errored' outcome. An Errored column here
    // would be a column no run can ever land in — permanently empty furniture
    // that reads as "we have never errored".
    const engine = await import('@/lib/views/query-engine')
    vi.mocked(engine.groupResults).mockReturnValueOnce([
      { key: 'passed', label: 'passed', items: [{ id: 'r1' }] },
    ] as never)

    const res = await POST(postReq({
      entity_type: 'eval_run',
      grouping: { field: 'outcome', direction: 'asc' },
    }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<{ key: string }> }>(res)
    expect(body.data.map((g) => g.key)).toEqual(['passed', 'scored', 'failed'])
    expect(body.data.map((g) => g.key)).not.toContain('errored')
  })

  it('does not inject a run board when grouping by the PARENT\'s column name', async () => {
    // `last_outcome` belongs to the suite and the case; a run's own verdict is
    // `outcome`. Grouping a run list by the wrong name must fall through
    // untouched rather than inject columns for a field the rows do not carry.
    const engine = await import('@/lib/views/query-engine')
    vi.mocked(engine.groupResults).mockReturnValueOnce([
      { key: '__none__', label: 'No value', items: [{ id: 'r1' }] },
    ] as never)

    const res = await POST(postReq({
      entity_type: 'eval_run',
      grouping: { field: 'last_outcome', direction: 'asc' },
    }))
    const body = await readJson<{ data: Array<{ key: string }> }>(res)
    expect(body.data.map((g) => g.key)).toEqual(['__none__'])
  })
})
