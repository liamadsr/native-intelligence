/**
 * Tests for POST /api/account/actions.
 *
 * Second worked example for the integration-test pattern. The first
 * (`api/early-access/__tests__/route.test.ts`) covers a public, single-Supabase-call
 * route. This one covers an authenticated, workspace-scoped route with
 * multiple chained Supabase queries — closer to the shape of most account
 * routes agents will modify.
 *
 * What we lock in:
 *   - 401 when unauthenticated (auth helper short-circuits before any DB calls)
 *   - 400 on missing/empty title (with leading/trailing whitespace handling)
 *   - 400 when no team exists in the workspace
 *   - 500 when the team has no default workflow state (serverError path)
 *   - 500 propagation of the insert error
 *   - 200 happy path with all the expected fields shaped correctly
 *   - Default assignee behavior (assigns to current member if assignee unspecified)
 *   - Explicit assignee_ids array overrides assignee_id
 *
 * Each Supabase chain is mocked at the call site with a step-by-step
 * `from('table')` handler so the test reads top-to-bottom in the order the
 * route exercises Supabase.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  fromHandlers: new Map<string, unknown>(),
  // Side-effect spies so the happy path can assert "actions.insert was called
  // with the right shape" and "action_assignee.insert was called once".
  actionsInsert: vi.fn(),
  actionAssigneeInsert: vi.fn(),
}))

// Build a chain that resolves to a single result, regardless of method
// composition. Good enough for most steps; the actions insert needs special
// handling because it chains .select().single() after .insert().
function singleResultChain(result: unknown) {
  const chain: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const proxy = new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      return () => proxy
    },
  }) as unknown
  return proxy
}

// The route uses the `supabase` client that requireWorkspace returns —
// it does NOT import @/lib/supabase/server directly. So we mock the
// auth helper to hand back our fake supabase. (createClient is only
// stubbed defensively in case some sibling code under test imports it.)
function makeFakeSupabase() {
  return {
    from: (table: string) => {
      const handler = hoisted.fromHandlers.get(table)
      if (!handler) {
        // Default chain: empty success. Catches "I forgot to mock this table"
        // without exploding mid-test.
        return singleResultChain({ data: null, error: null })
      }
      return handler
    },
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    rpc: vi.fn(),
  }
}

// Every happy-path POST reaches trackServerEvent('action_created'); unmocked,
// a set NEXT_PUBLIC_POSTHOG_KEY (e.g. the Vercel build env) would flush a real
// /batch/ request per test.
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

// "Make a task from this" fences its record through the mention fence: the
// tests say which records the person can see.
const mentionFence = vi.hoisted(() => ({ visible: [] as Array<{ type: string; id: string }>, calls: 0 }))
vi.mock('@/lib/entity-links/mentions', () => ({
  visibleMentionTargets: async (_s: unknown, _scope: unknown, refs: Array<{ type: string; id: string }>) => {
    mentionFence.calls++
    return refs.filter((r) => mentionFence.visible.some((v) => v.type === r.type && v.id === r.id))
  },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(),
}))

const { POST } = await import('@/app/api/account/actions/route')

function actionReq(body: unknown): NextRequest {
  // POST handler is typed as `(request: NextRequest) => ...`. At runtime
  // Next.js accepts any Request-like; for test purposes the cast is safe
  // because we only use methods/properties that Request shares with NextRequest.
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/actions',
    body,
  }) as unknown as NextRequest
}

// Build the happy authed context each test gets in beforeEach. The supabase
// client is built per-test so individual tests can swap fromHandlers freely.
function happyAuth() {
  return {
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  }
}

// Helpers that pre-seed the fromHandlers map for common happy-path setups.
// Tests can override individual tables after calling these.
function seedHappyPath() {
  // 1. team lookup (single default team)
  hoisted.fromHandlers.set(
    'team',
    singleResultChain({ data: { id: 'team-1' }, error: null }),
  )
  // 2. workflow_state lookup (default state for team)
  hoisted.fromHandlers.set(
    'workflow_state',
    singleResultChain({ data: { id: 'state-default' }, error: null }),
  )
  // 3. member lookup. Two different call sites:
  //    (a) .single() — used to get the current member's id (auto-assign).
  //        Needs to return a single object, not an array.
  //    (b) .in('id', ids) (no .single) — used to hydrate display_name/avatar
  //        for the response. Needs to return an array.
  // We can't easily distinguish in our chain handler, so we cheat: respond
  // based on whether .in(...) was called. Use a tiny stateful proxy.
  hoisted.fromHandlers.set('member', {
    select: () => {
      const state = { isInCall: false }
      const builder: Record<string, unknown> = {
        eq: () => builder,
        in: () => {
          state.isInCall = true
          return Promise.resolve({
            data: [
              { id: 'member-1', display_name: 'Alice', avatar_url: null },
              { id: 'member-2', display_name: 'Bob', avatar_url: null },
              { id: 'member-3', display_name: 'Carol', avatar_url: null },
            ],
            error: null,
          })
        },
        single: async () => ({
          data: state.isInCall
            ? null
            : { id: 'member-1', display_name: 'Alice', avatar_url: null },
          error: null,
        }),
      }
      return builder
    },
  })
  // 4. actions insert + .select().single() returns the created row
  const createdAction = {
    id: 'action-1',
    identifier: 'GEN-42',
    title: 'My new action',
    description: null,
    status_id: 'state-default',
    team_id: 'team-1',
    confirmation: 'confirmed',
    priority: 'none',
    due_at: null,
    all_day: true,
    assignee_id: 'member-1',
    parent_id: null,
    estimate: null,
    project_id: null,
    milestone_id: null,
    cycle_id: null,
    created_at: '2026-05-25T00:00:00.000Z',
    workflow_state: { id: 'state-default', name: 'Todo', category: 'unstarted', color: '#888' },
    project: null,
    milestone: null,
    cycle: null,
  }
  // The actions table is hit two ways: (a) the parent_id validation lookup
  // (.select().eq().eq().maybeSingle()) and (b) the insert (.insert().select().single()).
  // Distinguish by which method is called first.
  hoisted.fromHandlers.set('actions', {
    insert: (payload: unknown) => {
      hoisted.actionsInsert(payload)
      return {
        select: () => ({
          single: async () => ({ data: createdAction, error: null }),
        }),
      }
    },
    select: () => {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        // parent_id lookup: default to a valid same-workspace parent so the
        // happy path passes; individual tests override to null to assert 400.
        maybeSingle: async () => ({ data: { id: 'action-parent' }, error: null }),
      }
      return builder
    },
  })
  // FK-validation lookups for caller-supplied fields. Default to valid rows so
  // the happy path reaches insert; individual tests override to null for 400s.
  hoisted.fromHandlers.set('cycle', {
    select: () => {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        maybeSingle: async () => ({ data: { id: 'cycle-1' }, error: null }),
      }
      return builder
    },
  })
  hoisted.fromHandlers.set('projects', {
    select: () => {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        maybeSingle: async () => ({ data: { id: 'proj-1' }, error: null }),
      }
      return builder
    },
  })
  hoisted.fromHandlers.set('milestone', {
    select: () => {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        maybeSingle: async () => ({
          data: { id: 'milestone-1', project: { workspace_id: 'workspace-1' } },
          error: null,
        }),
      }
      return builder
    },
  })
  // 5. action_assignee insert (join table) — no return value used
  hoisted.fromHandlers.set('action_assignee', {
    insert: (payload: unknown) => {
      hoisted.actionAssigneeInsert(payload)
      return Promise.resolve({ data: null, error: null })
    },
  })
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.fromHandlers.clear()
  hoisted.actionsInsert.mockReset()
  hoisted.actionAssigneeInsert.mockReset()
  hoisted.requireWorkspace.mockResolvedValue(happyAuth())
})

describe('POST /api/account/actions', () => {
  it('returns 401 when unauthenticated and never touches the DB', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await POST(actionReq({ title: 'Anything' }))
    expect(res.status).toBe(401)
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when title is missing', async () => {
    const res = await POST(actionReq({}))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({
      error: 'Title is required',
    })
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when title is empty whitespace', async () => {
    const res = await POST(actionReq({ title: '   ' }))
    expect(res.status).toBe(400)
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when workspace has no team', async () => {
    // No team → defaultTeam is null after .single()
    hoisted.fromHandlers.set(
      'team',
      singleResultChain({ data: null, error: null }),
    )
    const res = await POST(actionReq({ title: 'Has no home' }))
    expect(res.status).toBe(400)
    // Error now names the workspace so a wrong-scope situation is diagnosable.
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('No team found in workspace')
    expect(body.error).toContain('workspace-1')
  })

  it('returns 500 when team has no default workflow state', async () => {
    // Team exists, but workflow_state.single() returns null.
    hoisted.fromHandlers.set(
      'team',
      singleResultChain({ data: { id: 'team-1' }, error: null }),
    )
    hoisted.fromHandlers.set(
      'workflow_state',
      singleResultChain({ data: null, error: null }),
    )
    const res = await POST(actionReq({ title: 'Misconfigured' }))
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('default workflow state')
  })

  it('returns 500 when the actions insert errors out', async () => {
    seedHappyPath()
    // Override the actions handler to return an error from the insert chain.
    hoisted.fromHandlers.set('actions', {
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: null,
            error: { code: '23505', message: 'duplicate key on identifier' },
          }),
        }),
      }),
    })
    const res = await POST(actionReq({ title: 'Will fail' }))
    expect(res.status).toBe(500)
  })

  it('returns 200 with the created action on happy path', async () => {
    seedHappyPath()
    const res = await POST(
      actionReq({ title: '  My new action  ', priority: 'high' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ action: { id: string; title: string; identifier: string } }>(res)
    expect(body.action.id).toBe('action-1')
    expect(body.action.title).toBe('My new action')
    expect(body.action.identifier).toBe('GEN-42')

    // Title gets trimmed before insertion.
    expect(hoisted.actionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'My new action',
        priority: 'high',
        workspace_id: 'workspace-1',
        user_id: 'user-1',
      }),
    )
  })

  it('auto-assigns to current member when no assignee specified', async () => {
    seedHappyPath()
    await POST(actionReq({ title: 'Auto-assign me' }))
    // member lookup returns member-1; that becomes assignee_id on the action row,
    // and member-1 is inserted into action_assignee.
    expect(hoisted.actionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ assignee_id: 'member-1' }),
    )
    expect(hoisted.actionAssigneeInsert).toHaveBeenCalledWith([
      { action_id: 'action-1', member_id: 'member-1' },
    ])
  })

  it('honors explicit assignee_ids array (multi-assignee)', async () => {
    seedHappyPath()
    await POST(
      actionReq({
        title: 'Multi-assigned',
        assignee_ids: ['member-2', 'member-3'],
      }),
    )
    // First in array becomes the primary assignee_id on the action row.
    expect(hoisted.actionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ assignee_id: 'member-2' }),
    )
    // Both go into the join table.
    expect(hoisted.actionAssigneeInsert).toHaveBeenCalledWith([
      { action_id: 'action-1', member_id: 'member-2' },
      { action_id: 'action-1', member_id: 'member-3' },
    ])
  })

  it('refuses an assignee who is not a member of this workspace (400)', async () => {
    seedHappyPath()
    const res = await POST(
      actionReq({ title: 'Foreign assignee', assignee_ids: ['member-2', 'member-other-ws'] }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('falls back to assignee_id when assignee_ids is absent', async () => {
    seedHappyPath()
    await POST(
      actionReq({ title: 'Single-assigned', assignee_id: 'member-2' }),
    )
    expect(hoisted.actionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ assignee_id: 'member-2' }),
    )
    expect(hoisted.actionAssigneeInsert).toHaveBeenCalledWith([
      { action_id: 'action-1', member_id: 'member-2' },
    ])
  })

  it('passes through optional fields (project_id, milestone_id, cycle_id, estimate, parent_id)', async () => {
    seedHappyPath()
    await POST(
      actionReq({
        title: 'With trimmings',
        project_id: 'proj-1',
        milestone_id: 'milestone-1',
        cycle_id: 'cycle-1',
        estimate: 5,
        parent_id: 'action-parent',
      }),
    )
    expect(hoisted.actionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'proj-1',
        milestone_id: 'milestone-1',
        cycle_id: 'cycle-1',
        estimate: 5,
        parent_id: 'action-parent',
      }),
    )
  })

  it('returns 400 when cycle_id belongs to another team', async () => {
    seedHappyPath()
    hoisted.fromHandlers.set('cycle', {
      select: () => {
        const builder: Record<string, unknown> = {
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        }
        return builder
      },
    })
    const res = await POST(actionReq({ title: 'Bad cycle', cycle_id: 'foreign-cycle' }))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({
      error: 'cycle_id does not belong to this team',
    })
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when project_id belongs to another workspace', async () => {
    seedHappyPath()
    hoisted.fromHandlers.set('projects', {
      select: () => {
        const builder: Record<string, unknown> = {
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        }
        return builder
      },
    })
    const res = await POST(actionReq({ title: 'Bad project', project_id: 'foreign-proj' }))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({
      error: 'project_id does not belong to this workspace',
    })
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when milestone_id belongs to another workspace', async () => {
    seedHappyPath()
    hoisted.fromHandlers.set('milestone', {
      select: () => {
        const builder: Record<string, unknown> = {
          eq: () => builder,
          maybeSingle: async () => ({
            data: { id: 'milestone-x', project: { workspace_id: 'other-workspace' } },
            error: null,
          }),
        }
        return builder
      },
    })
    const res = await POST(actionReq({ title: 'Bad milestone', milestone_id: 'foreign-milestone' }))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({
      error: 'milestone_id does not belong to this workspace',
    })
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when parent_id belongs to another workspace', async () => {
    seedHappyPath()
    hoisted.fromHandlers.set('actions', {
      insert: (payload: unknown) => {
        hoisted.actionsInsert(payload)
        return { select: () => ({ single: async () => ({ data: null, error: null }) }) }
      },
      select: () => {
        const builder: Record<string, unknown> = {
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        }
        return builder
      },
    })
    const res = await POST(actionReq({ title: 'Bad parent', parent_id: 'foreign-action' }))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({
      error: 'parent_id does not belong to this workspace',
    })
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('does not include optional fields when not provided', async () => {
    seedHappyPath()
    await POST(actionReq({ title: 'Minimal' }))
    const payload = hoisted.actionsInsert.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('project_id')
    expect(payload).not.toHaveProperty('milestone_id')
    expect(payload).not.toHaveProperty('cycle_id')
    expect(payload).not.toHaveProperty('estimate')
    expect(payload).not.toHaveProperty('parent_id')
  })

  it('defaults priority to "none" when not provided', async () => {
    seedHappyPath()
    await POST(actionReq({ title: 'No priority' }))
    expect(hoisted.actionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'none' }),
    )
  })

  describe('about (make a task from this)', () => {
    const DOC = '0f8fad5b-d9cb-469f-a165-70867728950e'
    let linkUpserts: unknown[]
    beforeEach(() => {
      mentionFence.visible = []
      mentionFence.calls = 0
      linkUpserts = []
      seedHappyPath()
      hoisted.fromHandlers.set('entity_link', {
        upsert: (row: unknown) => {
          linkUpserts.push(row)
          return Promise.resolve({ error: null })
        },
      })
    })

    it('links the new task to a record the person can see, about it', async () => {
      mentionFence.visible = [{ type: 'document', id: DOC }]
      const res = await POST(actionReq({ title: 'Follow up: Q4 renewals plan', about: { type: 'document', id: DOC } }))
      expect(res.status).toBe(200)
      expect(await readJson<{ about_linked: boolean }>(res)).toMatchObject({ about_linked: true })
      expect(linkUpserts).toEqual([
        expect.objectContaining({
          workspace_id: 'workspace-1',
          source_type: 'action',
          source_id: 'action-1',
          target_type: 'document',
          target_id: DOC,
          relation: 'about',
          created_by: 'member-1',
        }),
      ])
    })

    it('makes no task about a record the person cannot see', async () => {
      const res = await POST(actionReq({ title: 'Follow up', about: { type: 'document', id: DOC } }))
      expect(res.status).toBe(400)
      expect(mentionFence.calls).toBe(1)
      expect(hoisted.actionsInsert).not.toHaveBeenCalled()
      expect(linkUpserts).toEqual([])
    })

    it('refuses a kind no task is made from, before any read', async () => {
      const res = await POST(actionReq({ title: 'Follow up', about: { type: 'claim', id: DOC } }))
      expect(res.status).toBe(400)
      expect(mentionFence.calls).toBe(0)
      expect(hoisted.actionsInsert).not.toHaveBeenCalled()
    })

    it('links a task to the person’s own email thread, read from its owner column, never the mention fence', async () => {
      hoisted.fromHandlers.set('email_thread_index', singleResultChain({ data: { id: DOC }, error: null }))
      const res = await POST(actionReq({ title: 'Follow up: Contract redlines', about: { type: 'email_thread', id: DOC } }))
      expect(res.status).toBe(200)
      expect(mentionFence.calls).toBe(0)
      expect(linkUpserts).toEqual([expect.objectContaining({ source_type: 'action', target_type: 'email_thread', target_id: DOC, relation: 'about' })])
    })

    it('makes no task about a teammate’s email thread (no row of theirs comes back)', async () => {
      hoisted.fromHandlers.set('email_thread_index', singleResultChain({ data: null, error: null }))
      const res = await POST(actionReq({ title: 'Follow up', about: { type: 'email_thread', id: DOC } }))
      expect(res.status).toBe(400)
      expect(hoisted.actionsInsert).not.toHaveBeenCalled()
      expect(linkUpserts).toEqual([])
    })

    it('writes no edge and says nothing of one when there is no about', async () => {
      const res = await POST(actionReq({ title: 'Plain task' }))
      expect(await readJson<Record<string, unknown>>(res)).not.toHaveProperty('about_linked')
      expect(linkUpserts).toEqual([])
    })
  })
})
