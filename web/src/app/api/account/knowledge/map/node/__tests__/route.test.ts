/**
 * Tests for GET /api/account/knowledge/map/node — the inspector's data.
 *
 * Locked in:
 *   - auth passthrough, and the private per-viewer cache headers;
 *   - claim keys return the row, its claim_source evidence (WITH excerpts, the
 *     one place the map fetches them) and its outgoing non-claim links, each
 *     with a label resolved the same way the map resolved the dot's;
 *   - a claim outside the workspace / hidden by RLS is a 404, not an empty 200
 *     — an empty 200 would tell the caller the id exists;
 *   - entity keys validate the type against the REGISTRY, 404 on an unreadable
 *     label, and page their claims (confirmed first, confidence DESC NULLS
 *     LAST, 25 per page, opaque cursor, exact total);
 *   - a hub cited by MORE than PostgREST's 1000-row response cap still reports
 *     an exact total and pages every claim, and no single `.in()` grows into a
 *     URI a proxy would refuse — prod already has a 1,614-claim hub, and both
 *     defects are invisible to a fake that does not model the cap;
 *   - `unfiled:<yyyy-mm>` is a 400 — virtual hubs have no row behind them.
 *
 * Supabase is a stateful in-memory fake covering the chains the route uses,
 * INCLUDING the server's 1000-row ceiling and the URI cost of an `.in()` list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  db: {} as Record<string, Row[]>,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

const WS = 'ws-1'

/**
 * PostgREST caps any response at 1000 rows regardless of `.limit()`/`.range()`.
 * The fake models it because a route that pages around the cap and one that
 * ignores it are indistinguishable without it — that is how the unbounded
 * citing-link read shipped.
 */
const SERVER_ROW_CAP = 1000

/** Widest `.in(…)` list any single request used, in ids and in URI bytes. */
const inStats = { maxIds: 0, maxUriBytes: 0 }

/**
 * Models eq / neq / in / order / range / maybeSingle / count:'exact' /
 * head:true, plus the server's own row cap and the URI cost of an `.in()`
 * list. Ordering uses the real column values so the "confirmed first,
 * confidence DESC NULLS LAST" assertion tests the route's order() calls rather
 * than the fake's.
 */
function makeClient() {
  function table(name: string) {
    const preds: Array<(r: Row) => boolean> = []
    const orders: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = []
    let range: { from: number; to: number } | null = null
    let wantCount = false
    let head = false

    const matching = () => {
      let rows = (hoisted.db[name] ?? []).filter((r) => preds.every((p) => p(r)))
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[o.col]
          const bv = b[o.col]
          const aNull = av === null || av === undefined
          const bNull = bv === null || bv === undefined
          if (aNull || bNull) {
            if (aNull && bNull) return 0
            return (aNull ? 1 : -1) * (o.nullsFirst ? -1 : 1)
          }
          const cmp =
            typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : String(av).localeCompare(String(bv))
          return o.asc ? cmp : -cmp
        })
      }
      return rows
    }

    const settle = async () => {
      const all = matching()
      const count = wantCount ? all.length : null
      if (head) return { data: null, count, error: null }
      const windowed = range ? all.slice(range.from, range.to + 1) : all
      // The server truncates HERE, after the range is applied — asking for
      // rows 0..9999 does not get you 10,000 rows, it gets you 1,000.
      return { data: windowed.slice(0, SERVER_ROW_CAP), count, error: null }
    }

    const api: Record<string, unknown> = {
      select: (_c?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact') wantCount = true
        if (opts?.head) head = true
        return api
      },
      eq: (k: string, v: unknown) => {
        preds.push((r) => r[k] === v)
        return api
      },
      neq: (k: string, v: unknown) => {
        preds.push((r) => r[k] !== v)
        return api
      },
      in: (k: string, vals: unknown[]) => {
        // An `.in()` list is serialized into the request URI, so its width is a
        // real limit (a 414 waiting to happen), not a style preference.
        inStats.maxIds = Math.max(inStats.maxIds, vals.length)
        inStats.maxUriBytes = Math.max(
          inStats.maxUriBytes,
          vals.map((v) => encodeURIComponent(String(v))).join(',').length,
        )
        const set = new Set(vals)
        preds.push((r) => set.has(r[k]))
        return api
      },
      order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
        orders.push({
          col,
          asc: opts?.ascending !== false,
          nullsFirst: opts?.nullsFirst === true,
        })
        return api
      },
      range: (from: number, to: number) => {
        range = { from, to }
        return api
      },
      overrideTypes: () => api,
      // `data` is null on a head:true read, which maybeSingle never does — but
      // the types do not know that, so narrow rather than assert.
      maybeSingle: () => settle().then((r) => ({ ...r, data: (r.data ?? [])[0] ?? null })),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        settle().then(ok, err),
    }
    return api
  }
  return { from: (name: string) => table(name) }
}

const UNAUTHED = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
})

const { GET } = await import('@/app/api/account/knowledge/map/node/route')

function req(params: Record<string, string> = {}): NextRequest {
  const url = new URL('https://nativeintelligence.dev/api/account/knowledge/map/node')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return Object.assign(buildRequest({ url: url.toString(), method: 'GET' }), {
    nextUrl: url,
  }) as unknown as NextRequest
}

function claimRow(id: string, extra: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    text: `text of ${id}`,
    type: 'fact',
    confidence: 0.8,
    confirmation: 'confirmed',
    status: 'active',
    auto_accepted: false,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  inStats.maxIds = 0
  inStats.maxUriBytes = 0
  hoisted.db = { claim: [], claim_source: [], entity_link: [], captures: [], document: [] }
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeClient(),
    user: { id: 'user-1' },
    workspaceId: WS,
  })
})

describe('GET …/map/node — guards', () => {
  it('passes an auth failure through untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(UNAUTHED)
    expect((await GET(req({ key: 'claim:c-1' }))).status).toBe(401)
  })

  it('400s on a missing or malformed key', async () => {
    expect((await GET(req())).status).toBe(400)
    expect((await GET(req({ key: 'nocolon' }))).status).toBe(400)
    expect((await GET(req({ key: ':abc' }))).status).toBe(400)
    expect((await GET(req({ key: 'claim:' }))).status).toBe(400)
  })

  it('400s on a virtual hub key — there is no row to inspect', async () => {
    const res = await GET(req({ key: 'unfiled:2026-01' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/virtual/i)
  })

  it('carries the private, per-viewer cache headers', async () => {
    hoisted.db.claim = [claimRow('c-1')]
    const res = await GET(req({ key: 'claim:c-1' }))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, x-workspace-id')
  })
})

describe('GET …/map/node — claim keys', () => {
  it('returns the claim with its sources (excerpts + labels) and links', async () => {
    hoisted.db.claim = [claimRow('c-1')]
    hoisted.db.claim_source = [
      {
        workspace_id: WS,
        claim_id: 'c-1',
        source_type: 'capture',
        source_id: 'cap-1',
        source_uri: null,
        excerpt: 'we agreed to ship Friday',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    hoisted.db.entity_link = [
      {
        workspace_id: WS,
        source_type: 'claim',
        source_id: 'c-1',
        target_type: 'document',
        target_id: 'doc-1',
        relation: 'cites',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Standup' }]
    hoisted.db.document = [{ id: 'doc-1', workspace_id: WS, title: 'Spec' }]

    const res = await GET(req({ key: 'claim:c-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.kind).toBe('claim')
    expect(body.key).toBe('claim:c-1')
    expect(body.claim).toMatchObject({ id: 'c-1', text: 'text of c-1', confirmation: 'confirmed' })
    expect(body.sources).toEqual([
      {
        source_type: 'capture',
        source_id: 'cap-1',
        source_uri: null,
        excerpt: 'we agreed to ship Friday',
        label: 'Standup',
      },
    ])
    expect(body.links).toEqual([
      { relation: 'cites', type: 'document', id: 'doc-1', label: 'Spec' },
    ])
  })

  it('keeps a source whose entity row is unreadable, with a null label', async () => {
    hoisted.db.claim = [claimRow('c-1')]
    hoisted.db.claim_source = [
      {
        workspace_id: WS,
        claim_id: 'c-1',
        source_type: 'capture',
        source_id: 'cap-hidden',
        source_uri: null,
        excerpt: 'quote',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    const body = await (await GET(req({ key: 'claim:c-1' }))).json()
    expect(body.sources[0]).toMatchObject({ excerpt: 'quote', label: null })
  })

  it('handles a manual source with no source_id', async () => {
    hoisted.db.claim = [claimRow('c-1')]
    hoisted.db.claim_source = [
      {
        workspace_id: WS,
        claim_id: 'c-1',
        source_type: 'external_url',
        source_id: null,
        source_uri: 'https://example.com/post',
        excerpt: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    const body = await (await GET(req({ key: 'claim:c-1' }))).json()
    expect(body.sources[0]).toMatchObject({
      source_uri: 'https://example.com/post',
      label: null,
    })
  })

  it('excludes claim→claim links (the inspector lists entities)', async () => {
    hoisted.db.claim = [claimRow('c-1'), claimRow('c-2')]
    hoisted.db.entity_link = [
      { workspace_id: WS, source_type: 'claim', source_id: 'c-1', target_type: 'claim', target_id: 'c-2', relation: 'supersedes', created_at: '2026-01-01T00:00:00Z' },
    ]
    const body = await (await GET(req({ key: 'claim:c-1' }))).json()
    expect(body.links).toEqual([])
  })

  it('404s for a claim in another workspace', async () => {
    hoisted.db.claim = [claimRow('c-1', { workspace_id: 'ws-other' })]
    const res = await GET(req({ key: 'claim:c-1' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('NOT_FOUND')
  })
})

describe('GET …/map/node — entity keys', () => {
  function seedEntityWithClaims(count: number) {
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Weekly sync' }]
    hoisted.db.claim = Array.from({ length: count }, (_u, i) =>
      claimRow(`c-${String(i).padStart(3, '0')}`),
    )
    hoisted.db.entity_link = Array.from({ length: count }, (_u, i) => ({
      workspace_id: WS,
      source_type: 'claim',
      source_id: `c-${String(i).padStart(3, '0')}`,
      target_type: 'capture',
      target_id: 'cap-1',
      relation: 'cites',
      created_at: '2026-01-01T00:00:00Z',
    }))
  }

  it('returns the label and the first page of citing claims', async () => {
    seedEntityWithClaims(3)
    const res = await GET(req({ key: 'capture:cap-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({
      kind: 'entity',
      key: 'capture:cap-1',
      entityType: 'capture',
      entityId: 'cap-1',
      label: 'Weekly sync',
      total: 3,
      nextCursor: null,
    })
    expect(body.claims).toHaveLength(3)
    expect(body.claims[0]).toHaveProperty('text')
  })

  it('pages at 25 with an opaque cursor that resumes where it left off', async () => {
    seedEntityWithClaims(30)

    const first = await (await GET(req({ key: 'capture:cap-1' }))).json()
    expect(first.claims).toHaveLength(25)
    expect(first.total).toBe(30)
    expect(typeof first.nextCursor).toBe('string')
    // Opaque: not a bare number the client could be tempted to do maths on.
    expect(first.nextCursor).not.toBe('25')

    const second = await (
      await GET(req({ key: 'capture:cap-1', cursor: first.nextCursor }))
    ).json()
    expect(second.claims).toHaveLength(5)
    expect(second.nextCursor).toBeNull()

    const ids = new Set([
      ...first.claims.map((c: { id: string }) => c.id),
      ...second.claims.map((c: { id: string }) => c.id),
    ])
    expect(ids.size).toBe(30)
  })

  it('orders confirmed first, then confidence DESC with NULLS LAST', async () => {
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Sync' }]
    hoisted.db.claim = [
      claimRow('sug-high', { confirmation: 'suggested', confidence: 0.9 }),
      claimRow('conf-null', { confirmation: 'confirmed', confidence: null }),
      claimRow('conf-low', { confirmation: 'confirmed', confidence: 0.2 }),
      claimRow('conf-high', { confirmation: 'confirmed', confidence: 0.95 }),
    ]
    hoisted.db.entity_link = hoisted.db.claim.map((c) => ({
      workspace_id: WS,
      source_type: 'claim',
      source_id: c.id,
      target_type: 'capture',
      target_id: 'cap-1',
      relation: 'cites',
      created_at: '2026-01-01T00:00:00Z',
    }))

    const body = await (await GET(req({ key: 'capture:cap-1' }))).json()
    expect(body.claims.map((c: { id: string }) => c.id)).toEqual([
      'conf-high',
      'conf-low',
      'conf-null',
      'sug-high',
    ])
  })

  it('excludes dismissed and non-active claims', async () => {
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Sync' }]
    hoisted.db.claim = [
      claimRow('live'),
      claimRow('dismissed', { confirmation: 'dismissed' }),
      claimRow('superseded', { status: 'superseded' }),
    ]
    hoisted.db.entity_link = hoisted.db.claim.map((c) => ({
      workspace_id: WS,
      source_type: 'claim',
      source_id: c.id,
      target_type: 'capture',
      target_id: 'cap-1',
      relation: 'cites',
      created_at: '2026-01-01T00:00:00Z',
    }))

    const body = await (await GET(req({ key: 'capture:cap-1' }))).json()
    expect(body.claims.map((c: { id: string }) => c.id)).toEqual(['live'])
    expect(body.total).toBe(1)
  })

  it('returns an empty page (not a 404) for a visible entity nothing cites', async () => {
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Lonely' }]
    const body = await (await GET(req({ key: 'capture:cap-1' }))).json()
    expect(body).toMatchObject({ label: 'Lonely', claims: [], total: 0, nextCursor: null })
  })

  it('404s when the entity row is unreadable or in another workspace', async () => {
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: 'ws-other', title: 'Theirs' }]
    expect((await GET(req({ key: 'capture:cap-1' }))).status).toBe(404)
    // Nothing at all under that id.
    expect((await GET(req({ key: 'capture:ghost' }))).status).toBe(404)
  })

  it('404s for a type that is not registry-citable', async () => {
    // `member` is linkable but not citable, so it can never be a hub.
    hoisted.db.member = [{ id: 'm-1', workspace_id: WS, display_name: 'Liam' }]
    expect((await GET(req({ key: 'member:m-1' }))).status).toBe(404)
    expect((await GET(req({ key: 'bogus:x-1' }))).status).toBe(404)
  })

  it('resolves company and campaign — the types the old route silently dropped', async () => {
    hoisted.db.company = [{ id: 'co-1', workspace_id: WS, name: 'Acme' }]
    hoisted.db.campaign = [{ id: 'ca-1', workspace_id: WS, name: 'Spring launch' }]

    expect((await (await GET(req({ key: 'company:co-1' }))).json()).label).toBe('Acme')
    expect((await (await GET(req({ key: 'campaign:ca-1' }))).json()).label).toBe(
      'Spring launch',
    )
  })

  it('treats a garbage cursor as offset 0 rather than failing', async () => {
    seedEntityWithClaims(3)
    const body = await (await GET(req({ key: 'capture:cap-1', cursor: '!!!' }))).json()
    expect(body.claims).toHaveLength(3)
  })
})

/**
 * The size regime the map is built for. 1,614 is the real hub recorded in
 * docs/KNOWLEDGE_MAP_ARCHITECTURE.md, i.e. already past the 1000-row cap
 * today — these are not hypothetical numbers.
 */
describe('GET …/map/node — a hub past the 1000-row response cap', () => {
  const BIG = 1614

  function seedBigHub(count: number) {
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Weekly sync' }]
    // Confidence descends with i, so the expected order is simply c-00000…,
    // which makes an off-by-one in the merge visible rather than plausible.
    hoisted.db.claim = Array.from({ length: count }, (_u, i) =>
      claimRow(`c-${String(i).padStart(5, '0')}`, { confidence: 1 - i / (count * 2) }),
    )
    hoisted.db.entity_link = hoisted.db.claim.map((c) => ({
      workspace_id: WS,
      source_type: 'claim',
      source_id: c.id,
      target_type: 'capture',
      target_id: 'cap-1',
      relation: 'cites',
      created_at: '2026-01-01T00:00:00Z',
    }))
  }

  it('reports the EXACT total, not the 1000 rows one response can carry', async () => {
    seedBigHub(BIG)
    const body = await (await GET(req({ key: 'capture:cap-1' }))).json()
    expect(body.total).toBe(BIG)
    expect(body.claims).toHaveLength(25)
    expect(body.nextCursor).not.toBeNull()
  })

  it('keeps no `.in()` list wide enough to blow a request URI', async () => {
    seedBigHub(BIG)
    await GET(req({ key: 'capture:cap-1' }))
    // 300 is what resolveEntityLabels chose for the same reason. The unbounded
    // version sent 1,000 uuids — a ~37KB query string.
    expect(inStats.maxIds).toBeLessThanOrEqual(300)
    expect(inStats.maxUriBytes).toBeLessThan(16_000)
  })

  it('pages past 1000 instead of ending the list at the cap', async () => {
    seedBigHub(BIG)
    // Page 41 starts at offset 1000 — dead ground for the unbounded read.
    const cursor = Buffer.from('1000', 'utf8').toString('base64url')
    const body = await (await GET(req({ key: 'capture:cap-1', cursor }))).json()
    expect(body.claims).toHaveLength(25)
    expect(body.claims[0].id).toBe('c-01000')
    expect(body.total).toBe(BIG)
  })

  it('walks the whole hub end to end, in order, with no gap or repeat', async () => {
    seedBigHub(BIG)
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const params: Record<string, string> = { key: 'capture:cap-1' }
      if (cursor) params.cursor = cursor
      const body = await (await GET(req(params))).json()
      seen.push(...body.claims.map((c: { id: string }) => c.id))
      cursor = body.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(BIG)
    expect(new Set(seen).size).toBe(BIG)
    // Confidence DESC across chunk boundaries, not just within a chunk.
    expect(seen).toEqual(
      Array.from({ length: BIG }, (_u, i) => `c-${String(i).padStart(5, '0')}`),
    )
  })

  it('keeps the documented order across chunks when confidence ties', async () => {
    // 700 ids = 3 chunks, all identical on confirmation+confidence, so the
    // tiebreakers (created_at DESC, then id) are the only thing ordering them.
    hoisted.db.captures = [{ id: 'cap-1', workspace_id: WS, title: 'Sync' }]
    hoisted.db.claim = Array.from({ length: 700 }, (_u, i) =>
      claimRow(`c-${String(i).padStart(3, '0')}`, {
        confidence: 0.5,
        created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      }),
    )
    hoisted.db.entity_link = hoisted.db.claim.map((c) => ({
      workspace_id: WS,
      source_type: 'claim',
      source_id: c.id,
      target_type: 'capture',
      target_id: 'cap-1',
      relation: 'cites',
      created_at: '2026-01-01T00:00:00Z',
    }))

    const body = await (await GET(req({ key: 'capture:cap-1' }))).json()
    const rows = body.claims as Array<{ id: string }>
    const at = (id: string) => hoisted.db.claim.find((c) => c.id === id)!
    for (let i = 1; i < rows.length; i++) {
      const prev = String(at(rows[i - 1].id).created_at)
      const cur = String(at(rows[i].id).created_at)
      expect(prev >= cur).toBe(true)
    }
    expect(body.total).toBe(700)
  })

  it('answers a 50,000-claim hub in bounded work', async () => {
    seedBigHub(50_000)
    const body = await (await GET(req({ key: 'capture:cap-1' }))).json()
    expect(body.total).toBe(50_000)
    expect(body.claims).toHaveLength(25)
    expect(inStats.maxIds).toBeLessThanOrEqual(300)
  })

  it('clamps an absurd client cursor instead of reading a page per chunk', async () => {
    seedBigHub(BIG)
    const cursor = Buffer.from('99999999', 'utf8').toString('base64url')
    const body = await (await GET(req({ key: 'capture:cap-1', cursor }))).json()
    expect(body.claims).toEqual([])
    expect(body.nextCursor).toBeNull()
    expect(body.total).toBe(BIG)
  })
})
