/**
 * Tests for the Knowledge Map's source reads.
 *
 * What these lock in — each maps to a design constraint that a plausible
 * refactor would quietly break:
 *   - paging issues EVERY page in parallel (the old route's sequential loop is
 *     what made a 20k-row workspace pay 20 serial round-trips) and dedupes by
 *     id, so an overlapping page can never double a node;
 *   - a hub whose label row does not come back is DROPPED (§4.1) — that is the
 *     single mechanism keeping another user's emails and private captures out
 *     of the map, so it needs a test, not a comment;
 *   - link targets of non-citable types never become hubs, AND their rows do
 *     not leave this module at all — the core reads `rows.links` to pick each
 *     claim's primary hub, so a `decision` or `member` target surviving the
 *     read would win that pick and file the claim under `unfiled`;
 *   - a claim→claim link is NOT a hub target but IS an edge, so it survives;
 *   - EVERY registry-citable type has a working label mapping. Asserted against
 *     the registry itself, so adding a citable type without a label makes this
 *     fail — the old route's hard-coded CITABLE list drifted exactly this way.
 *
 * The Supabase fake is a small in-memory PostgREST: it models `.range()`,
 * `count: 'exact'`, `.in()` and ordering well enough that the paging logic is
 * exercised for real rather than stubbed out.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'
import {
  CITABLE_TYPES,
  fetchSourceRows,
  isCitableType,
  probeVersion,
  resolveEntityLabels,
  type MapSourceClient,
} from '@/lib/knowledge/graph-map/source'

type Row = Record<string, unknown>

interface Call {
  table: string
  from?: number
  to?: number
  head: boolean
}

/** In-memory tables + a log of every request the fake served. */
interface Db {
  tables: Record<string, Row[]>
  calls: Call[]
  /** Resolves when at least `n` page requests are in flight simultaneously. */
  concurrencyPeak: number
}

function makeDb(): Db {
  return { tables: {}, calls: [], concurrencyPeak: 0 }
}

/**
 * A Supabase-shaped fake. Every terminal (`await`, `.maybeSingle()`) resolves
 * on a microtask *after* a real timer tick, so parallel page requests actually
 * overlap and `concurrencyPeak` is meaningful.
 */
function makeClient(db: Db): MapSourceClient {
  let inFlight = 0

  function table(name: string) {
    const eqs: Array<[string, unknown]> = []
    let inSet: { key: string; vals: Set<unknown> } | null = null
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
      inFlight++
      db.concurrencyPeak = Math.max(db.concurrencyPeak, inFlight)
      await new Promise((r) => setTimeout(r, 0))
      inFlight--

      const all = matching()
      db.calls.push({ table: name, from: range?.from, to: range?.to, head })
      const count = wantCount ? all.length : null
      if (head) return { data: null, count, error: null }
      const sliced = range
        ? all.slice(range.from, range.to + 1)
        : all.slice(0, limitN)
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
      overrideTypes: () => api,
      maybeSingle: () => settle().then((r) => ({ ...r, data: (r.data ?? [])[0] ?? null })),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        settle().then(ok, err),
    }
    return api
  }

  return { from: (name: string) => table(name) } as unknown as MapSourceClient
}

const WS = 'ws-1'

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
    confirmation: 'confirmed',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
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
    created_at: '2026-01-02T00:00:00Z',
    ...extra,
  }
}

describe('fetchSourceRows — paging', () => {
  it('fetches every page in parallel and returns all rows exactly once', async () => {
    // 2,500 claims = three pages. Sequential paging would peak at 1 in flight.
    db.tables.claim = Array.from({ length: 2500 }, (_u, i) =>
      claim(`c-${String(i).padStart(5, '0')}`),
    )
    db.tables.entity_link = []

    const rows = await fetchSourceRows(client, WS)

    expect(rows.claims).toHaveLength(2500)
    expect(new Set(rows.claims.map((c) => c.id)).size).toBe(2500)

    const pageCalls = db.calls.filter((c) => c.table === 'claim' && !c.head)
    expect(pageCalls).toHaveLength(3)
    expect(pageCalls.map((c) => c.from).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      0, 1000, 2000,
    ])
    // The point of the rewrite: pages overlap rather than queue up.
    expect(db.concurrencyPeak).toBeGreaterThan(1)
  })

  it('dedupes rows an overlapping page returns twice', async () => {
    // The count says 2 pages' worth, but only 1,001 distinct rows exist, so the
    // second page re-serves rows the first already returned when the table
    // shifts under a concurrent write.
    db.tables.claim = Array.from({ length: 1001 }, (_u, i) =>
      claim(`c-${String(i).padStart(5, '0')}`),
    )
    // Duplicate one row so a naive concat would produce 1,002.
    db.tables.claim.push({ ...(db.tables.claim[0] as Row) })
    db.tables.entity_link = []

    const rows = await fetchSourceRows(client, WS)
    expect(new Set(rows.claims.map((c) => c.id)).size).toBe(rows.claims.length)
  })

  it('reads claims of EVERY status and confirmation (slots depend on them)', async () => {
    db.tables.claim = [
      claim('live'),
      claim('dismissed', { confirmation: 'dismissed' }),
      claim('superseded', { status: 'superseded' }),
    ]
    db.tables.entity_link = []

    const rows = await fetchSourceRows(client, WS)
    expect(rows.claims.map((c) => c.id).sort()).toEqual([
      'dismissed',
      'live',
      'superseded',
    ])
  })
})

describe('fetchSourceRows — hubs', () => {
  it('drops a hub whose label row is not readable, keeping its links for the core to drop', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2')]
    db.tables.entity_link = [
      link('c-1', 'capture', 'cap-visible'),
      link('c-2', 'capture', 'cap-hidden'),
    ]
    // Only the visible capture exists in the viewer's readable set.
    db.tables.captures = [{ id: 'cap-visible', workspace_id: WS, title: 'Standup' }]

    const rows = await fetchSourceRows(client, WS)

    expect(rows.hubs).toEqual([{ type: 'capture', id: 'cap-visible', label: 'Standup' }])
    // The link is still reported — dropping edges is the pure core's job.
    expect(rows.links).toHaveLength(2)
  })

  it('ignores link targets whose type is not registry-citable', async () => {
    db.tables.claim = [claim('c-1'), claim('c-2')]
    db.tables.entity_link = [
      link('c-1', 'capture', 'cap-1'),
      // `member` is linkable but NOT citable — it must never become a hub.
      link('c-2', 'member', 'm-1'),
    ]
    db.tables.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Sync' }]
    db.tables.member = [{ id: 'm-1', workspace_id: WS, display_name: 'Liam' }]

    const rows = await fetchSourceRows(client, WS)
    expect(rows.hubs.map((h) => h.type)).toEqual(['capture'])
    expect(db.calls.some((c) => c.table === 'member')).toBe(false)
  })

  it('DROPS links to non-citable targets instead of passing them to the core', async () => {
    // Real workspaces link claims to `decision` and `member` rows constantly.
    // Neither can ever be a hub, and the core picks a claim's primary hub from
    // the EARLIEST link it is handed — so a non-citable link left in here wins
    // that race and strands the claim under `unfiled` with nothing to show.
    // Ordering matters: the decision link is older than the capture link.
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [
      link('c-1', 'decision', 'dec-1', { created_at: '2026-01-01T00:00:00Z' }),
      link('c-1', 'member', 'm-1', { created_at: '2026-01-01T00:00:01Z' }),
      link('c-1', 'capture', 'cap-1', { created_at: '2026-01-02T00:00:00Z' }),
    ]
    db.tables.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Sync' }]

    const rows = await fetchSourceRows(client, WS)

    expect(rows.links.map((l) => l.target_type)).toEqual(['capture'])
    expect(rows.hubs).toEqual([{ type: 'capture', id: 'cap-1', label: 'Sync' }])
  })

  it('keeps claim→claim links, which are edges rather than hubs', async () => {
    // `claim` is not a citable TYPE, but a claim→claim link is how supersedes
    // is drawn — dropping it with the non-citable targets would erase edges.
    db.tables.claim = [claim('c-1'), claim('c-2')]
    db.tables.entity_link = [
      link('c-1', 'claim', 'c-2', { relation: 'supersedes' }),
      link('c-1', 'member', 'm-1'),
    ]

    const rows = await fetchSourceRows(client, WS)
    expect(rows.links).toHaveLength(1)
    expect(rows.links[0]).toMatchObject({ target_type: 'claim', target_id: 'c-2' })
    expect(rows.hubs).toEqual([])
  })

  it('labels an empty-titled row "(untitled)" rather than dropping it', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'document', 'doc-1')]
    db.tables.document = [{ id: 'doc-1', workspace_id: WS, title: '   ' }]

    const rows = await fetchSourceRows(client, WS)
    expect(rows.hubs).toEqual([{ type: 'document', id: 'doc-1', label: '(untitled)' }])
  })

  it('chunks label lookups so no single .in() is unbounded', async () => {
    db.tables.claim = Array.from({ length: 700 }, (_u, i) => claim(`c-${i}`))
    db.tables.entity_link = Array.from({ length: 700 }, (_u, i) =>
      link(`c-${i}`, 'capture', `cap-${i}`),
    )
    db.tables.captures = Array.from({ length: 700 }, (_u, i) => ({
      id: `cap-${i}`,
      workspace_id: WS,
      title: `Capture ${i}`,
    }))

    const rows = await fetchSourceRows(client, WS)
    expect(rows.hubs).toHaveLength(700)
    // 700 ids at 300 per request = 3 requests.
    expect(db.calls.filter((c) => c.table === 'captures')).toHaveLength(3)
  })
})

describe('label coverage — drift guard', () => {
  it('every registry-citable type resolves a label (including conversation, company, campaign)', async () => {
    const citable = ENTITY_REGISTRY.filter((e) => e.citable)
    // Sanity: the three types the old route's hard-coded list silently dropped.
    const ids = citable.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['conversation', 'company', 'campaign']))

    const byType = new Map<string, Set<string>>()
    for (const e of citable) {
      byType.set(e.id, new Set([`${e.id}-1`]))
      // Seed one row in each type's LABEL table with its own label column set.
      const col = e.label.columns.split(',')[0].trim()
      db.tables[e.label.table] = [
        { id: `${e.id}-1`, workspace_id: WS, [col]: `label for ${e.id}` },
      ]
    }

    const labels = await resolveEntityLabels(client, WS, byType)

    for (const e of citable) {
      expect(labels.get(`${e.id}:${e.id}-1`)).toBe(`label for ${e.id}`)
    }
    // And the exported helpers agree with the registry.
    expect([...CITABLE_TYPES].sort()).toEqual(ids.slice().sort())
    expect(citable.every((e) => isCitableType(e.id))).toBe(true)
    expect(isCitableType('member')).toBe(false)
  })
})

describe('probeVersion', () => {
  it('is stable for unchanged rows and changes when a claim is added', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = [link('c-1', 'capture', 'cap-1')]

    const a = await probeVersion(client, WS)
    const b = await probeVersion(makeClient(db), WS)
    expect(a).toBe(b)

    db.tables.claim.push(claim('c-2'))
    const c = await probeVersion(makeClient(db), WS)
    expect(c).not.toBe(a)
  })

  it('changes when a claim is updated in place (count is unchanged)', async () => {
    db.tables.claim = [claim('c-1')]
    db.tables.entity_link = []
    const before = await probeVersion(client, WS)

    ;(db.tables.claim[0] as Row).updated_at = '2026-02-02T00:00:00Z'
    const after = await probeVersion(makeClient(db), WS)
    expect(after).not.toBe(before)
  })

  it('is a short URL-safe token', async () => {
    db.tables.claim = []
    db.tables.entity_link = []
    const v = await probeVersion(client, WS)
    expect(v).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
})
