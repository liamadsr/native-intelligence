/**
 * PERSONAL SCOPE in the views query engine — `workspaceScope: 'all'`, the
 * server-side "all of my workspaces" that backs a cross-workspace My Actions
 * and Projects (the workspace menu's "Show all workspaces" switch).
 *
 * Two halves, and the first matters more than the second:
 *
 *  1. THE DEFAULT PATH DOES NOT MOVE. Every existing caller passes no scope at
 *     all, and must keep emitting the query it always emitted — the same
 *     `eq('workspace_id', …)`, the same `eq('assignee_id', …)`, the same
 *     workflow-state read. A cross-workspace feature that quietly rewrites the
 *     single-workspace board's query is a regression in every list in the app,
 *     so the chain is asserted WHOLE and in order here, not just sampled.
 *  2. PERSONAL SCOPE WIDENS BY THE RESOLVED IDS, never by anything a caller
 *     invented: `in('workspace_id', …)` over the membership set, and — because
 *     "me" is a different `member` row in every workspace (migration 013) —
 *     `in('assignee_id', …)` over the matching member ids.
 *
 * The workflow-state helpers get the same treatment: a workflow state belongs
 * to ONE team (migration 020), so across workspaces there is no shared state
 * and no shared name — only `category` is common vocabulary, and that is what
 * "done" has to resolve through.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildEntityQuery,
  applyCompletedFilter,
  applyFilters,
  applyOrdering,
  resolvePersonalScope,
  type PersonalScope,
} from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

type Call = { method: string; args: unknown[] }

/** Chain methods the builders below reach for. Each records and returns `this`. */
const CHAIN_METHODS = ['select', 'eq', 'in', 'is', 'not', 'or', 'neq', 'order', 'limit', 'range', 'ilike'] as const

/** A query builder that records every call, in order, with its arguments. */
function makeQuery(result: unknown = { data: [], count: 0, error: null }) {
  const calls: Call[] = []
  const chain: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  for (const method of CHAIN_METHODS) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    })
  }
  return { query: chain as never, chain, calls }
}

/** A Supabase stand-in whose single table read resolves to `result`. */
function makeClient(result: unknown) {
  const { chain, calls } = makeQuery(result)
  const tables: string[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      tables.push(table)
      return chain
    }),
  }
  return { supabase: supabase as never, calls, tables }
}

const PERSONAL: PersonalScope = {
  memberIds: ['member-a', 'member-b'],
  workspaceIds: ['ws-a', 'ws-b'],
}

/** Workflow states as the completed/status-type reads see them: state → team → workspace. */
function state(id: string, workspaceId: string) {
  return { id, team: { workspace_id: workspaceId } }
}

// ── The single-workspace regression guard ───────────────────────────────────

describe('buildEntityQuery — the default scope is untouched', () => {
  it('emits exactly the chain it emitted before personal scope existed', () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', {
      memberId: 'member-1',
      actionScope: 'assigned',
    })

    // WHOLE chain, in order — a new predicate, a reordered one, or an `in`
    // where an `eq` used to be would all show up here.
    expect(calls.map((c) => ({ method: c.method, args: c.args.slice(1) }))).toEqual([
      { method: 'select', args: [{ count: 'exact' }] },
      { method: 'eq', args: ['ws-1'] },
      { method: 'is', args: [null] },
      { method: 'eq', args: ['member-1'] },
    ])
    expect(calls.map((c) => c.args[0])).toEqual([
      expect.stringContaining('id, identifier'),
      'workspace_id',
      'parent_id',
      'assignee_id',
    ])
  })

  it("passing workspaceScope 'workspace' explicitly changes nothing", () => {
    const bare = makeClient(null)
    buildEntityQuery(bare.supabase, 'action', 'ws-1', 'user-1', {
      memberId: 'member-1',
      actionScope: 'assigned',
    })
    const explicit = makeClient(null)
    buildEntityQuery(explicit.supabase, 'action', 'ws-1', 'user-1', {
      memberId: 'member-1',
      actionScope: 'assigned',
      workspaceScope: 'workspace',
      // A resolved set is present but must be ignored: the SCOPE decides.
      personalScope: PERSONAL,
    })
    expect(explicit.calls).toEqual(bare.calls)
  })

  it("scope 'created' still filters on the auth user id, which spans workspaces anyway", () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', { actionScope: 'created' })
    expect(calls).toContainEqual({ method: 'eq', args: ['user_id', 'user-1'] })
  })
})

// ── Personal scope ──────────────────────────────────────────────────────────

describe("buildEntityQuery — workspaceScope 'all'", () => {
  it('replaces the workspace equality with the resolved membership set', () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', {
      memberId: 'member-1',
      workspaceScope: 'all',
      personalScope: PERSONAL,
    })
    expect(calls).toContainEqual({ method: 'in', args: ['workspace_id', ['ws-a', 'ws-b']] })
    // The active workspace must not survive as a second predicate — that would
    // intersect the two and quietly hand back a single-workspace list.
    expect(calls).not.toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
  })

  it("'assigned' matches the MEMBER-ID SET — one member row per workspace", () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', {
      memberId: 'member-1',
      actionScope: 'assigned',
      workspaceScope: 'all',
      personalScope: PERSONAL,
    })
    expect(calls).toContainEqual({ method: 'in', args: ['assignee_id', ['member-a', 'member-b']] })
    // The ACTIVE workspace's member id would match nothing in the others.
    expect(calls).not.toContainEqual({ method: 'eq', args: ['assignee_id', 'member-1'] })
  })

  it('keeps the top-level-only predicate — sub-actions are still hidden', () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', {
      workspaceScope: 'all',
      personalScope: PERSONAL,
    })
    expect(calls).toContainEqual({ method: 'is', args: ['parent_id', null] })
  })

  it('FAILS NARROW: an unresolved or empty scope falls back to the active workspace', () => {
    // A caller that forgets to resolve the set gets its own workspace, never
    // an unfiltered read of every workspace in the database.
    for (const personalScope of [undefined, { memberIds: [], workspaceIds: [] }]) {
      const { supabase, calls } = makeClient(null)
      buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', {
        memberId: 'member-1',
        actionScope: 'assigned',
        workspaceScope: 'all',
        personalScope,
      })
      expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
      expect(calls).toContainEqual({ method: 'eq', args: ['assignee_id', 'member-1'] })
      expect(calls.some((c) => c.method === 'in')).toBe(false)
    }
  })

  it('projects widen the same way: the resolved set, never the active workspace alone', () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'project', 'ws-1', 'user-1', {
      workspaceScope: 'all',
      personalScope: PERSONAL,
    })
    expect(calls).toContainEqual({ method: 'in', args: ['workspace_id', ['ws-a', 'ws-b']] })
    expect(calls).not.toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
    // The hidden default project stays hidden across workspaces too.
    expect(calls).toContainEqual({ method: 'neq', args: ['name', '__default__'] })
  })

  it('projects: the default scope, and an empty set, stay on the active workspace', () => {
    for (const options of [undefined, { workspaceScope: 'all' as const, personalScope: { memberIds: [], workspaceIds: [] } }]) {
      const { supabase, calls } = makeClient(null)
      buildEntityQuery(supabase, 'project', 'ws-1', 'user-1', options)
      expect(calls).toEqual([
        { method: 'select', args: [expect.any(String), { count: 'exact' }] },
        { method: 'eq', args: ['workspace_id', 'ws-1'] },
        { method: 'neq', args: ['name', '__default__'] },
      ])
    }
  })

  it('is ACTIONS AND PROJECTS only — every other entity ignores the scope', () => {
    for (const entityType of ['capture', 'contact', 'document'] as const) {
      const { supabase, calls } = makeClient(null)
      buildEntityQuery(supabase, entityType, 'ws-1', 'user-1', {
        workspaceScope: 'all',
        personalScope: PERSONAL,
      })
      expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
      expect(calls).not.toContainEqual({ method: 'in', args: ['workspace_id', ['ws-a', 'ws-b']] })
    }
  })
})

describe('ACTION_VIEW_SELECT — the workspace embed', () => {
  /** The select string the action builder hands PostgREST. */
  function actionSelect(options?: Parameters<typeof buildEntityQuery>[4]) {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'action', 'ws-1', 'user-1', options)
    return calls.find((c) => c.method === 'select')!.args[0] as string
  }

  it('embeds the workspace on every action row, in EVERY scope', () => {
    // Unconditional on purpose: a single-workspace row carries it too, so the
    // client can compare against the active workspace and hide the badge
    // rather than having to know which scope produced the list.
    const embed = 'workspace:workspace!workspace_id(id, name, slug, logo_url)'
    expect(actionSelect()).toContain(embed)
    expect(actionSelect({ workspaceScope: 'all', personalScope: PERSONAL })).toContain(embed)
  })

  it('names the FK column as the hint, like every other embed on this select', () => {
    // `actions.workspace_id REFERENCES workspace(id)` (migration 014); the
    // sibling embeds (`workflow_state!status_id`, `member!assignee_id`) use the
    // same disambiguating form.
    const select = actionSelect()
    expect(select).toMatch(/workspace:workspace!workspace_id\(/)
  })

  it('stays a row-sized embed — no settings blob, no plan', () => {
    const fields = actionSelect()
      .match(/workspace:workspace!workspace_id\(([^)]*)\)/)![1]
      .split(',')
      .map((f) => f.trim())
    expect(fields).toEqual(['id', 'name', 'slug', 'logo_url'])
  })

  it('embeds the workspace on every project row too — the Projects list spans workspaces as well', () => {
    const { supabase, calls } = makeClient(null)
    buildEntityQuery(supabase, 'project', 'ws-1', 'user-1')
    const select = calls.find((c) => c.method === 'select')!.args[0] as string
    expect(select).toContain('workspace:workspace!workspace_id(id, name, slug, logo_url)')
  })

  it('leaves the rest of the action select intact', () => {
    const select = actionSelect()
    for (const column of ['id', 'identifier', 'workspace_id', 'workflow_state:', 'labels:', 'team:team!team_id']) {
      expect(select).toContain(column)
    }
  })
})

// ── Workflow states across workspaces ───────────────────────────────────────

describe('applyCompletedFilter — states for every workspace in scope', () => {
  const states = [state('s-a', 'ws-a'), state('s-b', 'ws-b'), state('s-other', 'ws-other')]

  it('single workspace: the same read, the same predicate, as before', async () => {
    const client = makeClient({ data: states, error: null })
    const { query, calls } = makeQuery()
    await applyCompletedFilter(client.supabase, query, 'none', false, 'ws-a')

    // The read is fenced to the workspace in SQL (through the inner-joined
    // team: a state has no workspace_id), so it never reads another tenant's
    // states or loses in-scope ones to the row cap; one workspace is an `eq`.
    expect(client.tables).toEqual(['workflow_state'])
    expect(client.calls).toEqual([
      { method: 'select', args: ['id, team:team!team_id!inner(workspace_id)'] },
      { method: 'eq', args: ['team.workspace_id', 'ws-a'] },
      { method: 'in', args: ['category', ['completed', 'canceled']] },
    ])
    expect(calls).toEqual([{ method: 'not', args: ['status_id', 'in', '(s-a)'] }])
  })

  it("personal scope: 'done' spans the whole membership set", async () => {
    const client = makeClient({ data: states, error: null })
    const { query, calls } = makeQuery()
    await applyCompletedFilter(client.supabase, query, 'none', false, ['ws-a', 'ws-b'])
    expect(client.calls).toContainEqual({ method: 'in', args: ['team.workspace_id', ['ws-a', 'ws-b']] })
    expect(calls).toEqual([{ method: 'not', args: ['status_id', 'in', '(s-a,s-b)'] }])
  })

  it('never borrows a state from a workspace the user is not in', async () => {
    const client = makeClient({ data: states, error: null })
    const { query, calls } = makeQuery()
    await applyCompletedFilter(client.supabase, query, 'none', false, ['ws-a', 'ws-b'])
    expect(JSON.stringify(calls)).not.toContain('s-other')
  })

  it("the 'recent' window carries the whole set too", async () => {
    const client = makeClient({ data: states, error: null })
    const { query, calls } = makeQuery()
    await applyCompletedFilter(client.supabase, query, 'recent', true, ['ws-a', 'ws-b'])
    const or = calls.find((c) => c.method === 'or')!.args[0] as string
    expect(or).toContain('status_id.not.in.(s-a,s-b)')
    expect(or).toContain('status_id.in.(s-a,s-b)')
  })

  it('still short-circuits before the read when nothing is being hidden', async () => {
    const client = makeClient({ data: states, error: null })
    const { query, calls } = makeQuery()
    await applyCompletedFilter(client.supabase, query, 'all', true, ['ws-a', 'ws-b'])
    expect(client.tables).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('status_type filter — resolved by category across the scope', () => {
  const filters: ViewFilter[] = [
    { id: 'f1', field: 'status_type', operator: 'is', value: 'completed' },
  ]

  it('single workspace: only that workspace\'s states', async () => {
    const client = makeClient({ data: [state('s-a', 'ws-a'), state('s-b', 'ws-b')], error: null })
    const { query, calls } = makeQuery()
    await applyFilters(query, 'action', filters, client.supabase, 'ws-a', {})
    expect(client.calls).toContainEqual({ method: 'eq', args: ['team.workspace_id', 'ws-a'] })
    expect(calls).toEqual([{ method: 'in', args: ['status_id', ['s-a']] }])
  })

  it('personal scope: every in-scope workspace\'s state in that category', async () => {
    const client = makeClient({
      data: [state('s-a', 'ws-a'), state('s-b', 'ws-b'), state('s-other', 'ws-other')],
      error: null,
    })
    const { query, calls } = makeQuery()
    await applyFilters(query, 'action', filters, client.supabase, ['ws-a', 'ws-b'], {})
    expect(calls).toEqual([{ method: 'in', args: ['status_id', ['s-a', 's-b']] }])
  })
})

// ── Ordering ────────────────────────────────────────────────────────────────

describe('applyOrdering — the personal-scope tie-break', () => {
  const byIdentifier = [{ field: 'identifier', direction: 'asc' as const }]

  it('adds nothing by default', () => {
    const { query, calls } = makeQuery()
    applyOrdering(query, byIdentifier, 'action')
    expect(calls).toEqual([
      { method: 'order', args: ['identifier', { ascending: true, nullsFirst: false }] },
    ])
  })

  it('appends a unique key in personal scope — `identifier` is only unique per workspace', () => {
    // migration 022: UNIQUE (workspace_id, identifier). Two workspaces both
    // hold an ENG-1, so a sort on it alone is not a total order and offset
    // paging can repeat one row while skipping another.
    const { query, calls } = makeQuery()
    applyOrdering(query, byIdentifier, 'action', { tieBreakOnId: true })
    expect(calls).toEqual([
      { method: 'order', args: ['identifier', { ascending: true, nullsFirst: false }] },
      { method: 'order', args: ['id', { ascending: true, nullsFirst: false }] },
    ])
  })

  it('does not double up when the caller already sorts by id', () => {
    const { query, calls } = makeQuery()
    applyOrdering(query, [{ field: 'id', direction: 'desc' }], 'action', { tieBreakOnId: true })
    expect(calls).toEqual([
      { method: 'order', args: ['id', { ascending: false, nullsFirst: false }] },
    ])
  })
})

// ── The resolver ────────────────────────────────────────────────────────────

describe('resolvePersonalScope', () => {
  it('shapes the membership rows into the two parallel id lists, paired by index', async () => {
    const client = makeClient({
      data: [
        { id: 'member-a', workspace_id: 'ws-a' },
        { id: 'member-b', workspace_id: 'ws-b' },
      ],
      error: null,
    })
    await expect(resolvePersonalScope(client.supabase, 'user-1')).resolves.toEqual({
      memberIds: ['member-a', 'member-b'],
      workspaceIds: ['ws-a', 'ws-b'],
    })
    // Read through the fence — `member`, on the caller's own client.
    expect(client.tables).toEqual(['member'])
  })

  it('resolves to empty lists for a user with no memberships', async () => {
    const client = makeClient({ data: [], error: null })
    await expect(resolvePersonalScope(client.supabase, 'user-1')).resolves.toEqual({
      memberIds: [],
      workspaceIds: [],
    })
  })
})
