import { describe, it, expect } from 'vitest'
import {
  ageOutStaleProposals,
  groomExpiredAttentionCards,
  DEFAULT_AGE_OUT_DAYS,
} from '../proposal-age-out'

/**
 * Age-out sweep tests (loop-closure E1).
 *
 * A stateful fake models the two tables the sweep touches (proposed_change,
 * captures). The load-bearing assertions: the sweep NEVER touches a mid-flight
 * (applied_at/result_entity_id set), non-pending, fresh, or demo-capture row; a
 * dry run writes nothing; and only genuinely-stale abandoned rows are dismissed
 * with the marker.
 */

type Row = Record<string, unknown>

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

function makeSupabase(db: { proposed_change: Row[]; captures: Row[] }) {
  // Model the age_out_stale_proposals RPC (migration 168): the same guarded,
  // merging dismiss the real function does, so the execute path is exercised.
  function rpc(name: string, args: Record<string, unknown>) {
    if (name !== 'age_out_stale_proposals') return Promise.resolve({ data: [], error: null })
    const cutoff = args.p_cutoff as string
    const wsScope = args.p_workspace_id as string | null
    const limit = args.p_limit as number | null
    const demoCaptureIds = new Set(db.captures.filter((c) => (c.metadata as Row | null)?.demo === true).map((c) => c.id))
    let matched = db.proposed_change.filter((r) =>
      r.status === 'pending' &&
      (r.applied_at ?? null) === null &&
      (r.result_entity_id ?? null) === null &&
      ((r.extra as Row | null)?.applied_at ?? null) === null &&
      typeof r.created_at === 'string' && (r.created_at as string) < cutoff &&
      (!wsScope || r.workspace_id === wsScope) &&
      !(r.capture_id && demoCaptureIds.has(r.capture_id as string)),
    )
    matched.sort((a, b) => (a.created_at as string).localeCompare(b.created_at as string))
    if (limit && limit > 0) matched = matched.slice(0, limit)
    for (const r of matched) {
      r.status = 'dismissed'
      r.extra = { ...(r.extra as Row ?? {}), aged_out: true, aged_out_reason: 'stale — the meeting’s moment passed' }
    }
    return Promise.resolve({ data: matched.map((r) => ({ id: r.id, workspace_id: r.workspace_id })), error: null })
  }
  function table(name: 'proposed_change' | 'captures') {
    const preds: Array<(r: Row) => boolean> = []
    let update: Row | null = null
    let inChunk: { col: string; vals: unknown[] } | null = null
    let limitN: number | null = null

    const api: Record<string, unknown> = {
      select: () => api,
      update: (patch: Row) => {
        update = patch
        return api
      },
      eq: (k: string, v: unknown) => {
        preds.push((r) => r[k] === v)
        return api
      },
      is: (k: string, v: null) => {
        if (k === 'extra->>applied_at') {
          preds.push((r) => (((r.extra as Row | null)?.applied_at) ?? null) === v)
        } else {
          preds.push((r) => (r[k] ?? null) === v)
        }
        return api
      },
      not: (k: string, _op: string, v: null) => {
        // Only used as .not('expires_at','is',null) → expires_at IS NOT NULL
        preds.push((r) => (r[k] ?? null) !== v)
        return api
      },
      lt: (k: string, v: string) => {
        preds.push((r) => typeof r[k] === 'string' && (r[k] as string) < v)
        return api
      },
      gt: () => api,
      in: (col: string, vals: unknown[]) => {
        inChunk = { col, vals }
        preds.push((r) => vals.includes(r[col]))
        return api
      },
      order: () => api,
      limit: (n: number) => {
        limitN = n
        return api
      },
      then: (resolve: (v: unknown) => unknown) => {
        let rows = db[name].filter((r) => preds.every((p) => p(r)))
        if (update) {
          for (const r of rows) Object.assign(r, update)
        } else if (limitN != null) {
          rows = rows.slice(0, limitN)
        }
        void inChunk
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve)
      },
    }
    return api
  }
  return {
    from: (t: string) => table(t as 'proposed_change' | 'captures'),
    rpc: (name: string, args: Record<string, unknown>) => rpc(name, args),
  } as never
}

describe('ageOutStaleProposals', () => {
  const nonDemoCapture = { id: 'cap-real', metadata: {} }
  const demoCapture = { id: 'cap-demo', metadata: { demo: true } }

  function seed(): { proposed_change: Row[]; captures: Row[] } {
    return {
      captures: [nonDemoCapture, demoCapture].map((c) => ({ ...c })),
      proposed_change: [
        // Stale + abandoned + non-demo → SHOULD sweep
        { id: 'p-stale', workspace_id: 'w1', capture_id: 'cap-real', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(45), extra: {} },
        // Fresh → keep
        { id: 'p-fresh', workspace_id: 'w1', capture_id: 'cap-real', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(5), extra: {} },
        // Stale but MID-FLIGHT (applied_at set) → keep
        { id: 'p-midflight', workspace_id: 'w1', capture_id: 'cap-real', status: 'pending', applied_at: daysAgo(40), result_entity_id: null, created_at: daysAgo(45), extra: {} },
        // Stale but already dismissed → keep (not pending)
        { id: 'p-done', workspace_id: 'w1', capture_id: 'cap-real', status: 'dismissed', applied_at: null, result_entity_id: null, created_at: daysAgo(45), extra: {} },
        // Stale but DEMO capture → keep
        { id: 'p-demo', workspace_id: 'w1', capture_id: 'cap-demo', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(45), extra: {} },
        // Stale but ORPHANED PARTIAL-APPLY (extra.applied_at set, top-level null)
        // → keep (its side effect may have fired; never mask it).
        { id: 'p-orphan', workspace_id: 'w1', capture_id: 'cap-real', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(45), extra: { applied_at: daysAgo(44) } },
        // Stale + carries a load-bearing extra key → sweep, but PRESERVE the key.
        { id: 'p-keyed', workspace_id: 'w1', capture_id: 'cap-real', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(45), extra: { assignee_ai_member_id: 'ai-7' } },
        // Stale on another workspace → sweep (global) but not (scoped to w1... it IS w2)
        { id: 'p-stale-w2', workspace_id: 'w2', capture_id: 'cap-real', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(60), extra: {} },
      ],
    }
  }

  it('dry run reports the stale count and writes NOTHING', async () => {
    const db = seed()
    const res = await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30, dryRun: true })
    expect(res.dryRun).toBe(true)
    expect(res.matched).toBe(3) // p-stale + p-stale-w2 + p-keyed
    expect(res.dismissed).toBe(0)
    // Nothing mutated.
    expect(db.proposed_change.find((r) => r.id === 'p-stale')!.status).toBe('pending')
  })

  it('dismisses only stale + abandoned + non-demo pending rows', async () => {
    const db = seed()
    const res = await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30 })
    expect(res.matched).toBe(3)
    expect(res.dismissed).toBe(3)
    const byId = (id: string) => db.proposed_change.find((r) => r.id === id)!
    expect(byId('p-stale').status).toBe('dismissed')
    expect(byId('p-stale-w2').status).toBe('dismissed')
    // Everything else untouched.
    expect(byId('p-fresh').status).toBe('pending')
    expect(byId('p-midflight').status).toBe('pending')
    expect(byId('p-demo').status).toBe('pending')
    expect(byId('p-orphan').status).toBe('pending') // orphaned partial-apply spared
    expect(byId('p-done').status).toBe('dismissed') // was already
  })

  it('writes the aged_out marker onto swept rows', async () => {
    const db = seed()
    await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30 })
    const swept = db.proposed_change.find((r) => r.id === 'p-stale')!
    const extra = swept.extra as Record<string, unknown>
    expect(extra.aged_out).toBe(true)
    expect(extra.aged_out_reason).toContain('stale')
  })

  it('MERGES the marker — never clobbers a load-bearing extra key', async () => {
    const db = seed()
    await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30 })
    const swept = db.proposed_change.find((r) => r.id === 'p-keyed')!
    const extra = swept.extra as Record<string, unknown>
    expect(swept.status).toBe('dismissed')
    expect(extra.aged_out).toBe(true)
    // The pre-existing key survives (reversibility).
    expect(extra.assignee_ai_member_id).toBe('ai-7')
  })

  it('never ages out an orphaned partial-apply (extra.applied_at set)', async () => {
    const db = seed()
    await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30 })
    expect(db.proposed_change.find((r) => r.id === 'p-orphan')!.status).toBe('pending')
  })

  it('scopes to one workspace when given', async () => {
    const db = seed()
    const res = await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30, workspaceId: 'w1' })
    expect(res.matched).toBe(2) // p-stale + p-keyed (w1); p-stale-w2 excluded
    expect(db.proposed_change.find((r) => r.id === 'p-stale-w2')!.status).toBe('pending')
  })

  it('never sweeps a demo-capture proposal', async () => {
    const db = seed()
    await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30 })
    expect(db.proposed_change.find((r) => r.id === 'p-demo')!.status).toBe('pending')
  })

  it('reports a per-workspace breakdown', async () => {
    const db = seed()
    const res = await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30, dryRun: true })
    const w = Object.fromEntries(res.byWorkspace.map((b) => [b.workspace_id, b.matched]))
    expect(w.w1).toBe(2) // p-stale + p-keyed
    expect(w.w2).toBe(1)
  })

  it('defaults to DEFAULT_AGE_OUT_DAYS when no horizon given', async () => {
    const db = seed()
    const res = await ageOutStaleProposals(makeSupabase(db), { dryRun: true })
    expect(res.olderThanDays).toBe(DEFAULT_AGE_OUT_DAYS)
  })

  it('is a no-op when nothing is stale', async () => {
    const db = { captures: [nonDemoCapture], proposed_change: [
      { id: 'p1', workspace_id: 'w1', capture_id: 'cap-real', status: 'pending', applied_at: null, result_entity_id: null, created_at: daysAgo(2), extra: {} },
    ] }
    const res = await ageOutStaleProposals(makeSupabase(db), { olderThanDays: 30 })
    expect(res.matched).toBe(0)
    expect(res.dismissed).toBe(0)
  })
})

describe('groomExpiredAttentionCards', () => {
  it('expires pending cards past expires_at, leaves fresh + resolved alone', async () => {
    const db = {
      captures: [],
      proposed_change: [],
    }
    // Reuse the fake against an attention_item table via a small shim.
    const cards: Row[] = [
      { id: 'c-expired', status: 'pending', expires_at: daysAgo(1) },
      { id: 'c-fresh', status: 'pending', expires_at: new Date(Date.now() + 60000).toISOString() },
      { id: 'c-noexp', status: 'pending', expires_at: null },
      { id: 'c-accepted', status: 'accepted', expires_at: daysAgo(1) },
    ]
    const supabase = {
      from: () => {
        const preds: Array<(r: Row) => boolean> = []
        let update: Row | null = null
        const api: Record<string, unknown> = {
          update: (p: Row) => { update = p; return api },
          eq: (k: string, v: unknown) => { preds.push((r) => r[k] === v); return api },
          not: (k: string, _o: string, v: null) => { preds.push((r) => (r[k] ?? null) !== v); return api },
          lt: (k: string, v: string) => { preds.push((r) => typeof r[k] === 'string' && (r[k] as string) < v); return api },
          select: () => api,
          then: (resolve: (v: unknown) => unknown) => {
            const rows = cards.filter((r) => preds.every((p) => p(r)))
            if (update) for (const r of rows) Object.assign(r, update)
            return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve)
          },
        }
        return api
      },
    } as never
    void db
    const res = await groomExpiredAttentionCards(supabase, new Date())
    expect(res.expired).toBe(1)
    expect(cards.find((c) => c.id === 'c-expired')!.status).toBe('expired')
    expect(cards.find((c) => c.id === 'c-fresh')!.status).toBe('pending')
    expect(cards.find((c) => c.id === 'c-noexp')!.status).toBe('pending')
    expect(cards.find((c) => c.id === 'c-accepted')!.status).toBe('accepted')
  })
})
