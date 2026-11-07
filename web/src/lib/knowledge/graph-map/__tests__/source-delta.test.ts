/**
 * Tests for the Knowledge Map's DELTA source read (tier A+).
 *
 * What these lock in:
 *   - `probeParts` returns the SAME token `probeVersion` does, against the same
 *     rows. The two hashings are duplicated (probeVersion lives in source.ts and
 *     returns only the hash), so a parity test is the only thing stopping them
 *     from drifting — and a drift would make every client's `have=` compare
 *     against a token the server no longer produces;
 *   - the watermark bound is INCLUSIVE, so rows sharing a timestamp with the
 *     row that set the watermark are never lost;
 *   - the delta applies the same "drop targets that are neither 'claim' nor
 *     citable" rule as the full fetch — the delta path must not admit a link the
 *     full path would drop, or the two read paths build different maps;
 *   - labels are resolved ONLY for hub targets the snapshot does not know;
 *   - count validation is on the RAW link tally, because `rows.links` is the
 *     filtered set and is legitimately smaller than the probe's count.
 *
 * The Supabase fake is the same small in-memory PostgREST as source.test.ts,
 * extended with `.gte()` so the watermark bound is exercised for real.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { probeVersion, type MapSourceClient } from '@/lib/knowledge/graph-map/source'
import {
  applyDelta,
  deltaMatchesProbe,
  fetchSourceDelta,
  probeParts,
  snapshotOf,
  type SourceSnapshot,
} from '@/lib/knowledge/graph-map/source-delta'
import type { SourceRows } from '@/lib/knowledge/graph-map/types'

type Row = Record<string, unknown>

interface Call {
  table: string
  head: boolean
  gte?: [string, string]
}

interface Db {
  tables: Record<string, Row[]>
  calls: Call[]
}

function makeDb(): Db {
  return { tables: {}, calls: [] }
}

function makeClient(db: Db): MapSourceClient {
  function table(name: string) {
    const eqs: Array<[string, unknown]> = []
    let inSet: { key: string; vals: Set<unknown> } | null = null
    let gte: [string, string] | null = null
    let lt: [string, string] | null = null
    const orders: Array<{ col: string; asc: boolean }> = []
    let range: { from: number; to: number } | null = null
    let head = false
    let wantCount = false
    let limitN = Infinity

    const matching = () => {
      let rows = (db.tables[name] ?? []).filter((r) =>
        eqs.every(([k, v]) => r[k] === v),
      )
      if (inSet) rows = rows.filter((r) => inSet!.vals.has(r[inSet!.key]))
      if (gte) rows = rows.filter((r) => String(r[gte![0]] ?? '') >= gte![1])
      if (lt) rows = rows.filter((r) => String(r[lt![0]] ?? '') < lt![1])
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = String(a[o.col] ?? '')
          const bv = String(b[o.col] ?? '')
          return o.asc ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      return rows
    }

    const settle = async () => {
      await new Promise((r) => setTimeout(r, 0))
      const all = matching()
      db.calls.push({ table: name, head, gte: gte ?? undefined })
      const count = wantCount ? all.length : null
      if (head) return { data: null, count, error: null }
      const sliced = range ? all.slice(range.from, range.to + 1) : all.slice(0, limitN)
      return { data: sliced, count, error: null }
    }

    const api: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact') wantCount = true
        if (opts?.head) head = true
        return api
      },
      eq: (k: string, v: unknown) => {
        eqs.push([k, v])
        return api
      },
      gte: (k: string, v: string) => {
        gte = [k, v]
        return api
      },
      lt: (k: string, v: string) => {
        lt = [k, v]
        return api
      },
      in: (k: string, vals: unknown[]) => {
        inSet = { key: k, vals: new Set(vals) }
        return api
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push({ col, asc: opts?.ascending !== false })
        return api
      },
      limit: (n: number) => {
        limitN = n
        return api
      },
      range: (from: number, to: number) => {
        range = { from, to }
        return api
      },
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        settle().then(ok, err),
    }
    return api
  }

  return { from: (name: string) => table(name) } as unknown as MapSourceClient
}

const WS = 'ws-1'
const T0 = '2026-01-01T00:00:00Z'

let db: Db
let client: MapSourceClient

beforeEach(() => {
  db = makeDb()
  client = makeClient(db)
})

function claim(id: string, extra: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    text: `claim ${id}`,
    type: 'fact',
    confidence: 0.7,
    confirmation: 'suggested',
    status: 'active',
    created_at: T0,
    updated_at: T0,
    ...extra,
  }
}

function link(sourceId: string, targetType: string, targetId: string, extra: Row = {}): Row {
  return {
    id: `link-${sourceId}-${targetType}-${targetId}`,
    workspace_id: WS,
    source_type: 'claim',
    source_id: sourceId,
    target_type: targetType,
    target_id: targetId,
    relation: 'cites',
    created_at: T0,
    ...extra,
  }
}

/** The `SourceRows` shape a full fetch of the current db would produce. */
function rowsFrom(db: Db): SourceRows {
  const claims = (db.tables.claim ?? []).map((c) => ({
    id: String(c.id),
    text: String(c.text),
    type: c.type as SourceRows['claims'][number]['type'],
    confidence: c.confidence as number | null,
    confirmation: c.confirmation as SourceRows['claims'][number]['confirmation'],
    status: c.status as SourceRows['claims'][number]['status'],
    scope: (c.scope ?? null) as SourceRows['claims'][number]['scope'],
    auto_accepted: (c.auto_accepted ?? null) as boolean | null,
    created_by: (c.created_by ?? null) as string | null,
    created_at: String(c.created_at),
    event_at: (c.event_at ?? null) as string | null,
    last_verified_at: (c.last_verified_at ?? null) as string | null,
  }))
  const usable = (db.tables.entity_link ?? []).filter(
    (l) => l.target_type === 'claim' || l.target_type === 'capture',
  )
  const links = usable.map((l) => ({
    source_id: String(l.source_id),
    target_type: String(l.target_type),
    target_id: String(l.target_id),
    relation: String(l.relation),
    created_at: String(l.created_at),
  }))
  const hubs: SourceRows['hubs'] = []
  const seen = new Set<string>()
  for (const l of usable) {
    if (l.target_type === 'claim') continue
    const key = `${l.target_type}:${l.target_id}`
    if (seen.has(key)) continue
    const row = (db.tables.captures ?? []).find((c) => c.id === l.target_id)
    if (!row) continue
    seen.add(key)
    hubs.push({ type: String(l.target_type), id: String(l.target_id), label: String(row.title) })
  }
  return { claims, links, hubs }
}

/** Snapshot of the db as it stands, as a full refresh would have produced it. */
async function snapshotNow(nowMs = 0): Promise<SourceSnapshot> {
  const parts = await probeParts(makeClient(db), WS)
  return snapshotOf(rowsFrom(db), parts, nowMs)
}

describe('probeParts — parity with probeVersion', () => {
  it('produces the identical token for the same rows', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2', { updated_at: '2026-03-03T00:00:00Z' })]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]

    const parts = await probeParts(makeClient(db), WS)
    const token = await probeVersion(makeClient(db), WS)

    // If these ever diverge, every client's `have=` compares against a token
    // the server no longer mints and the realtime loop full-reloads forever.
    expect(parts.version).toBe(token)
  })

  it('matches probeVersion on an EMPTY workspace too', async () => {
    db.tables.claim = []
    db.tables.entity_link = []
    const parts = await probeParts(makeClient(db), WS)
    expect(parts.version).toBe(await probeVersion(makeClient(db), WS))
  })

  it('exposes the raw parts the delta needs', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2', { updated_at: '2026-03-03T00:00:00Z' })]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]

    const parts = await probeParts(client, WS)
    expect(parts).toMatchObject({
      claimCount: 2,
      claimMaxUpdatedAt: '2026-03-03T00:00:00Z',
      linkCount: 1,
      linkMaxCreatedAt: T0,
    })
  })
})

describe('fetchSourceDelta — what it picks up', () => {
  it('returns a newly inserted claim and nothing else', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = []
    const snap = await snapshotNow()

    db.tables.claim.push(claim('c-2', { updated_at: '2026-02-02T00:00:00Z' }))
    const delta = await fetchSourceDelta(client, WS, snap)

    // c-1 shares the watermark timestamp so the inclusive bound re-reads it;
    // what matters is that c-2 is present and the merge upserts.
    expect(delta.claims.map((c) => c.id)).toContain('c-2')
    const merged = applyDelta(snap, delta, await probeParts(makeClient(db), WS), 1)
    expect(merged.rows.claims).toHaveLength(2)
  })

  it('picks up a MODIFIED claim (confirmation flip) and upserts it in place', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2')]
    db.tables.entity_link = []
    const snap = await snapshotNow()
    expect(snap.rows.claims.find((c) => c.id === 'c-1')?.confirmation).toBe('suggested')

    // The trigger bumps updated_at when the row is confirmed.
    db.tables.claim[0].confirmation = 'confirmed'
    db.tables.claim[0].updated_at = '2026-02-02T00:00:00Z'

    const delta = await fetchSourceDelta(client, WS, snap)
    const merged = applyDelta(snap, delta, await probeParts(makeClient(db), WS), 1)

    // Upsert, not append: the claim count is unchanged and the row is the new one.
    expect(merged.rows.claims).toHaveLength(2)
    expect(merged.rows.claims.find((c) => c.id === 'c-1')?.confirmation).toBe('confirmed')
  })

  it('never loses rows that share the watermark timestamp', async () => {
    // Three claims written in the same transaction share updated_at to the
    // microsecond. The snapshot is taken holding only the first, as if the
    // other two landed between the probe and the page read; an EXCLUSIVE
    // bound would then skip them forever.
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = []
    const snap = await snapshotNow()

    db.tables.claim.push(claim('c-2'), claim('c-3')) // same updated_at as c-1
    const delta = await fetchSourceDelta(client, WS, snap)

    expect(delta.claims.map((c) => c.id).sort()).toEqual(['c-1', 'c-2', 'c-3'])
    const merged = applyDelta(snap, delta, await probeParts(makeClient(db), WS), 1)
    expect(merged.rows.claims.map((c) => c.id).sort()).toEqual(['c-1', 'c-2', 'c-3'])
  })

  it('appends a new link and dedupes one it already holds', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]
    db.tables.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Standup' }]
    const snap = await snapshotNow()

    db.tables.entity_link.push(
      link('c-1', 'capture', 'cap-2', { created_at: '2026-02-02T00:00:00Z' }),
    )
    db.tables.captures.push({ id: 'cap-2', workspace_id: WS, title: 'Retro' })

    const delta = await fetchSourceDelta(client, WS, snap)
    // The existing link is re-read by the inclusive bound but recognised.
    expect(delta.links.map((l) => l.row.target_id)).toEqual(['cap-2'])

    const merged = applyDelta(snap, delta, await probeParts(makeClient(db), WS), 1)
    expect(merged.rows.links).toHaveLength(2)
  })
})

describe('fetchSourceDelta — hub labels', () => {
  it('resolves labels for NEW targets and never re-queries known ones', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]
    db.tables.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Standup' }]
    const snap = await snapshotNow()

    db.tables.entity_link.push(
      link('c-1', 'capture', 'cap-2', { created_at: '2026-02-02T00:00:00Z' }),
    )
    db.tables.captures.push({ id: 'cap-2', workspace_id: WS, title: 'Retro' })

    db.calls.length = 0
    const delta = await fetchSourceDelta(client, WS, snap)

    expect(delta.hubs).toEqual([{ type: 'capture', id: 'cap-2', label: 'Retro' }])
    // Exactly ONE label lookup, for the unknown target only. Re-resolving the
    // known hub is what makes a delta as expensive as a full read.
    const labelCalls = db.calls.filter((c) => c.table === 'captures')
    expect(labelCalls).toHaveLength(1)
  })

  it('issues NO label query at all when every target is already known', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]
    db.tables.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Standup' }]
    const snap = await snapshotNow()

    // A second claim citing the SAME capture.
    db.tables.claim.push(claim('c-2', { updated_at: '2026-02-02T00:00:00Z' }))
    db.tables.entity_link.push(
      link('c-2', 'capture', 'cap-1', { created_at: '2026-02-02T00:00:00Z' }),
    )

    db.calls.length = 0
    const delta = await fetchSourceDelta(client, WS, snap)

    expect(delta.hubs).toEqual([])
    expect(db.calls.some((c) => c.table === 'captures')).toBe(false)
  })

  it('drops a target that is neither claim nor citable, exactly as the full fetch does', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = []
    const snap = await snapshotNow()

    // `member` is linkable but NOT citable. If the delta let it through it would
    // become a claim's primary hub and strand that claim under `unfiled` — the
    // exact failure the full path drops these to avoid.
    db.tables.entity_link.push(
      link('c-1', 'member', 'm-1', { created_at: '2026-02-02T00:00:00Z' }),
    )
    db.tables.member = [{ id: 'm-1', workspace_id: WS, display_name: 'Liam' }]

    const delta = await fetchSourceDelta(client, WS, snap)

    expect(delta.links).toEqual([])
    expect(delta.hubs).toEqual([])
    expect(db.calls.some((c) => c.table === 'member')).toBe(false)
    // But it IS counted as a raw row, because the probe counts it.
    expect(delta.rawLinksAtBound).toBe(1)
    expect(delta.droppedLinkIds).toHaveLength(1)
  })

  it('keeps a claim→claim link (an edge) without trying to label it', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2')]
    db.tables.entity_link = []
    const snap = await snapshotNow()

    db.tables.entity_link.push(
      link('c-1', 'claim', 'c-2', { created_at: '2026-02-02T00:00:00Z' }),
    )

    const delta = await fetchSourceDelta(client, WS, snap)
    expect(delta.links.map((l) => l.row.target_type)).toEqual(['claim'])
    expect(delta.hubs).toEqual([])
  })
})

describe('deltaMatchesProbe — the validation gate', () => {
  it('accepts a merge whose counts agree with the probe', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = []
    const snap = await snapshotNow()

    db.tables.claim.push(claim('c-2', { updated_at: '2026-02-02T00:00:00Z' }))
    const parts = await probeParts(makeClient(db), WS)
    const merged = applyDelta(snap, await fetchSourceDelta(client, WS, snap), parts, 1)

    expect(deltaMatchesProbe(merged, parts)).toBe(true)
  })

  it('REJECTS the merge when a claim was deleted (a delta cannot see deletions)', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2')]
    db.tables.entity_link = []
    const snap = await snapshotNow()

    db.tables.claim = [claim('c-1')] // c-2 deleted
    const parts = await probeParts(makeClient(db), WS)
    const merged = applyDelta(snap, await fetchSourceDelta(client, WS, snap), parts, 1)

    // The merged rows still hold c-2 — only the count disagreement reveals it.
    expect(merged.rows.claims).toHaveLength(2)
    expect(deltaMatchesProbe(merged, parts)).toBe(false)
  })

  it('REPAIRS a link deleted from inside the inclusive tail', async () => {
    // Both links share created_at, so BOTH sides of the raw-count check shrink
    // when one is deleted and the tally alone cannot see it. The tail rebuild
    // is what catches this: `applyDelta` drops every retained row at-or-after
    // the bound and re-adds only what the delta actually read back.
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1'), link('c-1', 'capture', 'cap-2')]
    db.tables.captures = [
      { id: 'cap-1', workspace_id: WS, title: 'A' },
      { id: 'cap-2', workspace_id: WS, title: 'B' },
    ]
    const snap = await snapshotNow()
    expect(snap.rows.links).toHaveLength(2)

    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]
    const parts = await probeParts(makeClient(db), WS)
    const merged = applyDelta(snap, await fetchSourceDelta(client, WS, snap), parts, 1)

    // The stale row is GONE, so the merged rows are correct and serving them is
    // right — a rejection here would just cost a needless full fetch.
    expect(merged.rows.links.map((l) => l.target_id)).toEqual(['cap-1'])
    expect(deltaMatchesProbe(merged, parts)).toBe(true)
  })

  it('REJECTS the merge when a link BEFORE the tail was deleted', async () => {
    // A settled row, older than the bound, is outside everything the delta
    // re-reads. Only the count disagreement can reveal it.
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [
      link('c-1', 'capture', 'cap-old', { created_at: '2025-06-06T00:00:00Z' }),
      link('c-1', 'capture', 'cap-1'),
    ]
    db.tables.captures = [
      { id: 'cap-old', workspace_id: WS, title: 'Old' },
      { id: 'cap-1', workspace_id: WS, title: 'A' },
    ]
    const snap = await snapshotNow()

    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]
    const parts = await probeParts(makeClient(db), WS)
    const merged = applyDelta(snap, await fetchSourceDelta(client, WS, snap), parts, 1)

    // The stale row survives the merge — which is exactly why validation must
    // reject it and force a full fetch.
    expect(merged.rows.links.map((l) => l.target_id)).toContain('cap-old')
    expect(deltaMatchesProbe(merged, parts)).toBe(false)
  })

  it('accepts a workspace holding UNUSABLE links, whose usable set is smaller than the probe count', async () => {
    // This is the regression that a naive `rows.links.length === linkCount`
    // check would cause: one `member` link and every delta forever falls back
    // to a full fetch.
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1'), link('c-1', 'member', 'm-1')]
    db.tables.captures = [{ id: 'cap-1', workspace_id: WS, title: 'A' }]
    db.tables.member = [{ id: 'm-1', workspace_id: WS, display_name: 'Liam' }]

    const snap = await snapshotNow()
    // The usable set really is smaller than the raw count.
    expect(snap.rows.links).toHaveLength(1)

    db.tables.claim.push(claim('c-2', { updated_at: '2026-02-02T00:00:00Z' }))
    const parts = await probeParts(makeClient(db), WS)
    const merged = applyDelta(snap, await fetchSourceDelta(client, WS, snap), parts, 1)

    expect(parts.linkCount).toBe(2)
    expect(merged.rows.links).toHaveLength(1)
    expect(deltaMatchesProbe(merged, parts)).toBe(true)
  })

  it('does not double-count an unusable link across two successive deltas', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'member', 'm-1')]
    db.tables.member = [{ id: 'm-1', workspace_id: WS, display_name: 'Liam' }]
    let snap = await snapshotNow()

    for (const [i, ts] of [['c-2', '2026-02-02T00:00:00Z'], ['c-3', '2026-03-03T00:00:00Z']]) {
      db.tables.claim.push(claim(i, { updated_at: ts }))
      const parts = await probeParts(makeClient(db), WS)
      snap = applyDelta(snap, await fetchSourceDelta(client, WS, snap), parts, 1)
      // The member link is re-read every time by the inclusive bound; counting
      // it twice would make the tally drift past the probe and force a full
      // fetch on every later request.
      expect(deltaMatchesProbe(snap, parts)).toBe(true)
    }
  })
})

describe('applyDelta — immutability', () => {
  it('does not mutate the snapshot it was given', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = []
    const snap = await snapshotNow()
    const before = snap.rows.claims

    db.tables.claim.push(claim('c-2', { updated_at: '2026-02-02T00:00:00Z' }))
    applyDelta(snap, await fetchSourceDelta(client, WS, snap), await probeParts(makeClient(db), WS), 1)

    // A concurrent layoutMap may still be reading these rows.
    expect(snap.rows.claims).toBe(before)
    expect(snap.rows.claims).toHaveLength(1)
  })
})
