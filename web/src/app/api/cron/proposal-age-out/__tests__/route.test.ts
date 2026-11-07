import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Age-out sweep tests (Phase 3, WS-4d). Two load-bearing assertions:
 *  1. The UPDATE SHAPE: dismissing a stale proposal must MERGE the aged_out_30d
 *     marker into the existing `extra` (never clobber a load-bearing key like
 *     assignee_ai_member_id), and must only ever touch pending + change_type=
 *     'create' rows older than the cutoff.
 *  2. SCHEDULABILITY: with no explicit `workspace` scope the cron discovers every
 *     workspace holding stale proposals and sweeps them under ONE global 500-cap
 *     per tick — stopping mid-list when the cap is hit — while the explicit
 *     `workspace=` mode keeps its per-workspace cap unchanged.
 */

// getServiceClient is called inside GET; each test swaps in a fresh fake DB via
// this holder so the mock stays a single hoisted module factory.
let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))
// Row 4: the sweep is attributed to each workspace's Reconciler system teammate.
vi.mock('@/lib/work/system-teammates', () => ({
  systemTeammateId: async (_client: unknown, workspaceId: string, key: string) => `tm-${key}-${workspaceId}`,
}))

import {
  mergeAgeOutExtra,
  ageOutCreateProposals,
  discoverAgeOutWorkspaces,
  sweepWorkspaces,
  AGE_OUT_DISMISS_REASON,
  AGE_OUT_BATCH,
} from '@/lib/flows/proposal-create-age-out'
import { GET } from '../route'

type Row = Record<string, unknown>

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

/** A stateful fake for proposed_change honoring the select filters + the
 *  per-row CAS UPDATE (`.eq('status','pending')`) ageOutCreateProposals issues. */
function makeSupabase(rows: Row[]) {
  function builder() {
    const eqs: Array<[string, unknown]> = []
    const lts: Array<[string, unknown]> = []
    let op: 'select' | 'update' = 'select'
    let patch: Row | null = null
    let limitN: number | null = null

    const match = (r: Row) =>
      eqs.every(([k, v]) => r[k] === v) &&
      lts.every(([k, v]) => typeof r[k] === 'string' && (r[k] as string) < (v as string))

    const api: Record<string, unknown> = {
      select: () => api,
      update: (p: Row) => {
        op = 'update'
        patch = p
        return api
      },
      eq: (k: string, v: unknown) => {
        eqs.push([k, v])
        return api
      },
      lt: (k: string, v: unknown) => {
        lts.push([k, v])
        return api
      },
      order: () => api,
      limit: (n: number) => {
        limitN = n
        return api
      },
      maybeSingle: async () => term(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(term()).then(resolve),
    }

    function term() {
      if (op === 'update') {
        const target = rows.find(match)
        if (!target) return { data: null, error: null } // CAS lost / no match
        Object.assign(target, patch)
        return { data: { id: target.id }, error: null }
      }
      let out = rows.filter(match)
      if (limitN != null) out = out.slice(0, limitN)
      return { data: out.map((r) => ({ ...r })), error: null }
    }
    return api
  }
  return { from: () => builder() } as never
}

/**
 * A multi-table fake for the route-level sweep: `proposed_change` reuses the
 * single-table builder above (select filters + CAS UPDATE + limit + order), plus
 * `member` (owner lookup) and `tracked_job` (insert capture). Ordering by
 * `workspace_id` (discovery) is honored so global-cap iteration is deterministic.
 * Returns the fake plus the captured tracked_job inserts.
 */
function makeRouteSupabase(proposedRows: Row[], owners: Record<string, string> = {}) {
  const trackedJobs: Row[] = []

  function proposedBuilder() {
    const eqs: Array<[string, unknown]> = []
    const lts: Array<[string, unknown]> = []
    let op: 'select' | 'update' = 'select'
    let patch: Row | null = null
    let limitN: number | null = null
    const orderKeys: string[] = []

    const match = (r: Row) =>
      eqs.every(([k, v]) => r[k] === v) &&
      lts.every(([k, v]) => typeof r[k] === 'string' && (r[k] as string) < (v as string))

    const api: Record<string, unknown> = {
      select: () => api,
      update: (p: Row) => {
        op = 'update'
        patch = p
        return api
      },
      eq: (k: string, v: unknown) => {
        eqs.push([k, v])
        return api
      },
      lt: (k: string, v: unknown) => {
        lts.push([k, v])
        return api
      },
      order: (k: string) => {
        orderKeys.push(k)
        return api
      },
      limit: (n: number) => {
        limitN = n
        return api
      },
      maybeSingle: async () => term(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(term()).then(resolve),
    }

    function term() {
      if (op === 'update') {
        const target = proposedRows.find(match)
        if (!target) return { data: null, error: null }
        Object.assign(target, patch)
        return { data: { id: target.id }, error: null }
      }
      let out = proposedRows.filter(match)
      for (const k of orderKeys) {
        out = [...out].sort((a, b) => String(a[k]).localeCompare(String(b[k])))
      }
      if (limitN != null) out = out.slice(0, limitN)
      return { data: out.map((r) => ({ ...r })), error: null }
    }
    return api
  }

  function memberBuilder() {
    let wsId: string | null = null
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => {
        if (k === 'workspace_id') wsId = v as string
        return api
      },
      limit: () => api,
      maybeSingle: async () => {
        const id = wsId ? owners[wsId] : undefined
        return { data: id ? { id } : null, error: null }
      },
    }
    return api
  }

  function trackedJobBuilder() {
    let pending: Row | null = null
    const api: Record<string, unknown> = {
      insert: (row: Row) => {
        pending = row
        return api
      },
      select: () => api,
      maybeSingle: async () => {
        const stored = { id: `job-${trackedJobs.length}`, ...(pending ?? {}) }
        trackedJobs.push(stored)
        return { data: stored, error: null }
      },
    }
    return api
  }

  const db = {
    from: (table: string) => {
      if (table === 'member') return memberBuilder()
      if (table === 'tracked_job') return trackedJobBuilder()
      return proposedBuilder()
    },
  } as never
  return { db, trackedJobs }
}

function request(bearer?: string, workspace?: string) {
  const url = workspace
    ? `https://dial8.ai/api/cron/proposal-age-out?workspace=${workspace}`
    : 'https://dial8.ai/api/cron/proposal-age-out'
  return new NextRequest(url, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
}

describe('mergeAgeOutExtra', () => {
  it('adds the marker to an empty/absent extra', () => {
    expect(mergeAgeOutExtra(null)).toEqual({ dismiss_reason: AGE_OUT_DISMISS_REASON })
    expect(mergeAgeOutExtra({})).toEqual({ dismiss_reason: AGE_OUT_DISMISS_REASON })
  })

  it('PRESERVES existing keys — never clobbers load-bearing extra', () => {
    const merged = mergeAgeOutExtra({ assignee_ai_member_id: 'ai-7', foo: 'bar' })
    expect(merged.assignee_ai_member_id).toBe('ai-7')
    expect(merged.foo).toBe('bar')
    expect(merged.dismiss_reason).toBe(AGE_OUT_DISMISS_REASON)
  })
})

describe('ageOutCreateProposals', () => {
  function seed(): Row[] {
    return [
      // Stale create, load-bearing extra → dismissed WITH the key preserved.
      { id: 'p-keyed', workspace_id: 'w1', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: { assignee_ai_member_id: 'ai-7' } },
      // Stale create, empty extra → dismissed, marker added.
      { id: 'p-empty', workspace_id: 'w1', status: 'pending', change_type: 'create', created_at: daysAgo(60), extra: {} },
      // Fresh create → untouched (newer than cutoff).
      { id: 'p-fresh', workspace_id: 'w1', status: 'pending', change_type: 'create', created_at: daysAgo(5), extra: {} },
      // Stale but an UPDATE, not a create → untouched (floor is create-only).
      { id: 'p-update', workspace_id: 'w1', status: 'pending', change_type: 'update', created_at: daysAgo(45), extra: {} },
      // Stale create but already dismissed → untouched (not pending).
      { id: 'p-done', workspace_id: 'w1', status: 'dismissed', change_type: 'create', created_at: daysAgo(45), extra: {} },
      // Stale create in another workspace → untouched (out of scope).
      { id: 'p-other-ws', workspace_id: 'w2', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
    ]
  }

  const cutoff = daysAgo(30)

  it('dismisses only stale pending CREATE rows in scope, merging the marker', async () => {
    const rows = seed()
    const res = await ageOutCreateProposals(makeSupabase(rows), { workspaceId: 'w1', cutoffIso: cutoff, limit: 500 })
    expect(res.dismissed).toBe(2)
    const byId = (id: string) => rows.find((r) => r.id === id)!

    expect(byId('p-keyed').status).toBe('dismissed')
    expect((byId('p-keyed').extra as Row).dismiss_reason).toBe(AGE_OUT_DISMISS_REASON)
    // The load-bearing key survived the dismiss (reversibility).
    expect((byId('p-keyed').extra as Row).assignee_ai_member_id).toBe('ai-7')

    expect(byId('p-empty').status).toBe('dismissed')
    expect((byId('p-empty').extra as Row).dismiss_reason).toBe(AGE_OUT_DISMISS_REASON)

    // Everything outside the predicate is untouched.
    expect(byId('p-fresh').status).toBe('pending')
    expect(byId('p-update').status).toBe('pending')
    expect(byId('p-done').status).toBe('dismissed') // was already
    expect(byId('p-other-ws').status).toBe('pending')
  })

  it('respects the per-tick batch cap', async () => {
    const rows = seed()
    const res = await ageOutCreateProposals(makeSupabase(rows), { workspaceId: 'w1', cutoffIso: cutoff, limit: 1 })
    expect(res.dismissed).toBe(1)
  })

  it('is a no-op when nothing is stale', async () => {
    const rows: Row[] = [
      { id: 'p1', workspace_id: 'w1', status: 'pending', change_type: 'create', created_at: daysAgo(2), extra: {} },
    ]
    const res = await ageOutCreateProposals(makeSupabase(rows), { workspaceId: 'w1', cutoffIso: cutoff, limit: 500 })
    expect(res.dismissed).toBe(0)
    expect(rows[0].status).toBe('pending')
  })
})

describe('discoverAgeOutWorkspaces', () => {
  const cutoff = daysAgo(30)

  it('returns each DISTINCT workspace holding a stale pending CREATE proposal', async () => {
    const rows: Row[] = [
      { id: 'a1', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
      { id: 'a2', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(50), extra: {} }, // dup ws
      { id: 'b1', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(40), extra: {} },
    ]
    const ids = await discoverAgeOutWorkspaces(makeSupabase(rows), { cutoffIso: cutoff, scanLimit: 500 })
    expect(ids).toEqual(['wa', 'wb'])
  })

  it('excludes fresh, non-create, non-pending, and empty-set workspaces', async () => {
    const rows: Row[] = [
      { id: 'fresh', workspace_id: 'wfresh', status: 'pending', change_type: 'create', created_at: daysAgo(5), extra: {} },
      { id: 'upd', workspace_id: 'wupd', status: 'pending', change_type: 'update', created_at: daysAgo(45), extra: {} },
      { id: 'done', workspace_id: 'wdone', status: 'dismissed', change_type: 'create', created_at: daysAgo(45), extra: {} },
      { id: 'ok', workspace_id: 'wok', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
    ]
    const ids = await discoverAgeOutWorkspaces(makeSupabase(rows), { cutoffIso: cutoff, scanLimit: 500 })
    expect(ids).toEqual(['wok'])
  })
})

describe('sweepWorkspaces', () => {
  const cutoff = daysAgo(30)

  it('sweeps every workspace and writes ONE tracked_job per workspace', async () => {
    const proposed: Row[] = [
      { id: 'a1', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
      { id: 'a2', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(50), extra: {} },
      { id: 'b1', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(40), extra: {} },
    ]
    const { db, trackedJobs } = makeRouteSupabase(proposed, { wa: 'owner-a', wb: 'owner-b' })
    const results = await sweepWorkspaces(db, { workspaceIds: ['wa', 'wb'], cutoffIso: cutoff, budget: AGE_OUT_BATCH })

    expect(results).toEqual([
      { workspace_id: 'wa', dismissed: 2, job_recorded: true },
      { workspace_id: 'wb', dismissed: 1, job_recorded: true },
    ])
    // One tracked_job per workspace, kind=proposal_age_out, owner-scoped.
    expect(trackedJobs).toHaveLength(2)
    expect(trackedJobs.map((j) => j.kind)).toEqual(['proposal_age_out', 'proposal_age_out'])
    expect(trackedJobs.map((j) => j.member_id)).toEqual(['owner-a', 'owner-b'])
    // Who ran it: each workspace's own Reconciler system teammate.
    // The Captures face (the Reconciler until migration 318), with its area.
    expect(trackedJobs.map((j) => j.ai_team_member_id)).toEqual(['tm-captures-wa', 'tm-captures-wb'])
    expect(trackedJobs.map((j) => j.area)).toEqual(['captures', 'captures'])
    expect((trackedJobs[0].source as Row).dismissed).toBe(2)
    // All stale rows actually dismissed.
    expect(proposed.every((r) => r.status === 'dismissed')).toBe(true)
  })

  it('enforces the global budget: stops MID-LIST when the cap is exhausted', async () => {
    // wa has 3 stale, wb has 2 stale; global budget = 3 → wa fully swept (3),
    // budget hits 0, wb never reached this tick.
    const proposed: Row[] = [
      { id: 'a1', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
      { id: 'a2', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(46), extra: {} },
      { id: 'a3', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(47), extra: {} },
      { id: 'b1', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(48), extra: {} },
      { id: 'b2', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(49), extra: {} },
    ]
    const { db, trackedJobs } = makeRouteSupabase(proposed, { wa: 'owner-a', wb: 'owner-b' })
    const results = await sweepWorkspaces(db, { workspaceIds: ['wa', 'wb'], cutoffIso: cutoff, budget: 3 })

    // wa consumed the whole budget; wb was never reached (no result, no job).
    expect(results).toEqual([{ workspace_id: 'wa', dismissed: 3, job_recorded: true }])
    expect(trackedJobs).toHaveLength(1)
    // wb's rows survive to the next tick (still pending).
    expect(proposed.filter((r) => r.workspace_id === 'wb').every((r) => r.status === 'pending')).toBe(true)
  })

  it('caps a single workspace at AGE_OUT_BATCH even with a larger budget', async () => {
    const proposed: Row[] = Array.from({ length: AGE_OUT_BATCH + 5 }, (_, i) => ({
      id: `p${i}`,
      workspace_id: 'wa',
      status: 'pending',
      change_type: 'create',
      created_at: daysAgo(45),
      extra: {},
    }))
    const { db } = makeRouteSupabase(proposed, { wa: 'owner-a' })
    const results = await sweepWorkspaces(db, { workspaceIds: ['wa'], cutoffIso: cutoff, budget: AGE_OUT_BATCH * 2 })
    expect(results[0].dismissed).toBe(AGE_OUT_BATCH)
    expect(proposed.filter((r) => r.status === 'pending')).toHaveLength(5)
  })

  it('still records a tracked_job for a zero-dismissed workspace (observability)', async () => {
    const proposed: Row[] = [
      { id: 'fresh', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(2), extra: {} },
    ]
    const { db, trackedJobs } = makeRouteSupabase(proposed, { wa: 'owner-a' })
    const results = await sweepWorkspaces(db, { workspaceIds: ['wa'], cutoffIso: cutoff, budget: AGE_OUT_BATCH })
    expect(results).toEqual([{ workspace_id: 'wa', dismissed: 0, job_recorded: true }])
    expect(trackedJobs).toHaveLength(1)
    expect((trackedJobs[0].source as Row).dismissed).toBe(0)
  })
})

describe('GET /api/cron/proposal-age-out', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    // Unset: the sweep is on by default.
    vi.stubEnv('AGE_OUT_ENABLED', undefined as unknown as string)
    dbFake = null
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    dbFake = null
  })

  it('the kill switch: AGE_OUT_ENABLED exactly "false" short-circuits (no DB touch)', async () => {
    vi.stubEnv('AGE_OUT_ENABLED', 'false')
    const { db, trackedJobs } = makeRouteSupabase([])
    dbFake = db
    const res = await GET(request('test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, skipped: 'AGE_OUT_ENABLED is false' })
    expect(trackedJobs).toHaveLength(0)
  })

  it('on by default: with AGE_OUT_ENABLED unset (or empty) the sweep runs', async () => {
    for (const value of [undefined, '', 'true']) {
      vi.stubEnv('AGE_OUT_ENABLED', value as unknown as string)
      const { db } = makeRouteSupabase([])
      dbFake = db
      const body = await (await GET(request('test-secret'))).json()
      expect(body.skipped).toBeUndefined()
      expect(body.ok).toBe(true)
    }
  })

  it('rejects a bad cron secret before any work', async () => {
    const { db, trackedJobs } = makeRouteSupabase([])
    dbFake = db
    const res = await GET(request('wrong-secret'))
    expect(res.status).toBe(401)
    expect(trackedJobs).toHaveLength(0)
  })

  it('all-workspace mode: discovers and sweeps every workspace with stale proposals', async () => {
    const proposed: Row[] = [
      { id: 'a1', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
      { id: 'b1', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(40), extra: {} },
      { id: 'b2', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(41), extra: {} },
      // Fresh + another-workspace-update → never discovered.
      { id: 'fresh', workspace_id: 'wc', status: 'pending', change_type: 'create', created_at: daysAgo(3), extra: {} },
    ]
    const { db, trackedJobs } = makeRouteSupabase(proposed, { wa: 'owner-a', wb: 'owner-b' })
    dbFake = db

    const res = await GET(request('test-secret'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string; workspaces: Array<{ workspace_id: string; dismissed: number }> }
    expect(body.mode).toBe('all')
    expect(body.workspaces).toEqual([
      { workspace_id: 'wa', dismissed: 1, job_recorded: true },
      { workspace_id: 'wb', dismissed: 2, job_recorded: true },
    ])
    // wc (fresh only) never swept.
    expect(trackedJobs).toHaveLength(2)
    expect(proposed.find((r) => r.id === 'fresh')!.status).toBe('pending')
  })

  it('all-workspace mode: sweeps a sub-cap multi-workspace backlog in one tick', async () => {
    // The mid-list global-cap stop is exercised directly in the sweepWorkspaces
    // suite (AGE_OUT_BATCH is a const import, so it can't be shrunk here). This
    // asserts the route wires discovery → global sweep for a normal backlog.
    const proposed: Row[] = [
      { id: 'a1', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
      { id: 'a2', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(46), extra: {} },
      { id: 'b1', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(47), extra: {} },
    ]
    const { db, trackedJobs } = makeRouteSupabase(proposed, { wa: 'owner-a', wb: 'owner-b' })
    dbFake = db

    const res = await GET(request('test-secret'))
    const body = (await res.json()) as { workspaces: Array<{ workspace_id: string; dismissed: number }> }
    expect(body.workspaces).toEqual([
      { workspace_id: 'wa', dismissed: 2, job_recorded: true },
      { workspace_id: 'wb', dismissed: 1, job_recorded: true },
    ])
    expect(trackedJobs).toHaveLength(2)
    // All swept — nothing left for a second tick.
    expect(proposed.every((r) => r.status === 'dismissed')).toBe(true)
  })

  it('explicit workspace mode is unchanged: sweeps exactly the named ids', async () => {
    const proposed: Row[] = [
      { id: 'a1', workspace_id: 'wa', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
      // wb also has stale work, but is NOT named → must stay untouched.
      { id: 'b1', workspace_id: 'wb', status: 'pending', change_type: 'create', created_at: daysAgo(45), extra: {} },
    ]
    const { db, trackedJobs } = makeRouteSupabase(proposed, { wa: 'owner-a', wb: 'owner-b' })
    dbFake = db

    const res = await GET(request('test-secret', 'wa'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string; workspaces: Array<{ workspace_id: string; dismissed: number }> }
    expect(body.mode).toBe('explicit')
    expect(body.workspaces).toEqual([{ workspace_id: 'wa', dismissed: 1, job_recorded: true }])
    // Only wa's tracked_job, and wb's proposal survives (not in scope).
    expect(trackedJobs).toHaveLength(1)
    expect(proposed.find((r) => r.id === 'b1')!.status).toBe('pending')
  })

  it('explicit mode gives each named workspace its own full batch cap', async () => {
    // Two workspaces, each over the batch cap. Explicit mode must NOT share a
    // global budget across them — each gets its own AGE_OUT_BATCH.
    const proposed: Row[] = [
      ...Array.from({ length: AGE_OUT_BATCH + 3 }, (_, i) => ({
        id: `a${i}`,
        workspace_id: 'wa',
        status: 'pending',
        change_type: 'create',
        created_at: daysAgo(45),
        extra: {},
      })),
      ...Array.from({ length: AGE_OUT_BATCH + 3 }, (_, i) => ({
        id: `b${i}`,
        workspace_id: 'wb',
        status: 'pending',
        change_type: 'create',
        created_at: daysAgo(45),
        extra: {},
      })),
    ]
    const { db } = makeRouteSupabase(proposed, { wa: 'owner-a', wb: 'owner-b' })
    dbFake = db

    const res = await GET(request('test-secret', 'wa,wb'))
    const body = (await res.json()) as { workspaces: Array<{ workspace_id: string; dismissed: number }> }
    // Each capped at AGE_OUT_BATCH independently (not a shared global 500).
    expect(body.workspaces).toEqual([
      { workspace_id: 'wa', dismissed: AGE_OUT_BATCH, job_recorded: true },
      { workspace_id: 'wb', dismissed: AGE_OUT_BATCH, job_recorded: true },
    ])
  })
})
