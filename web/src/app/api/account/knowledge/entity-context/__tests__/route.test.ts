/**
 * Tests for GET /api/account/knowledge/entity-context (plan items 20b + 20d).
 *
 * The route serves the CRM detail panels' knowledge sections:
 *   - type=contact → claims linked to the contact (bidirectional entity_link),
 *     active + non-dismissed, each with its top excerpt. No brief.
 *   - type=project → the same claims list PLUS the project's knowledge_brief.
 *
 * Branches locked in:
 *   - 401 when the caller isn't authed (requireWorkspace returns a Response)
 *   - 400 on a bad/missing `type` or a missing `id`
 *   - contact 200: claims shape, brief field absent, dismissed/superseded excluded
 *   - project 200: brief present when a row exists, null when none
 *   - the entity_link filter runs in BOTH directions (claim→entity and entity→claim)
 *
 * Supabase is a stateful fake modelling the three tables the route reads
 * (entity_link, claim, knowledge_brief). reconcileProvenance is stubbed so the
 * excerpt-attach step is asserted independently of its own (separately-tested)
 * reconciliation logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  reconcileProvenance: vi.fn(),
  db: {
    entity_link: [] as Record<string, unknown>[],
    claim: [] as Record<string, unknown>[],
    knowledge_brief: [] as Record<string, unknown>[],
    // Read only for the mail check (a claim learned from mail is shown to no one, 341).
    claim_source: [] as Record<string, unknown>[],
    captures: [] as Record<string, unknown>[],
    attachments: [] as Record<string, unknown>[],
    // Cited documents: a private one is its creator's alone (369).
    document: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

vi.mock('@/lib/ai/tools/claims', () => ({
  reconcileProvenance: hoisted.reconcileProvenance,
}))

// A tiny query builder over the in-memory db. Supports the exact chains the
// route uses:
//   entity_link: select().eq().eq()...  (awaited directly → { data, error })
//   claim:       select().eq().in().neq().eq().order().order().limit()  (awaited)
//   knowledge_brief: select().eq().eq().eq().maybeSingle()
function makeClient() {
  function table(name: keyof typeof hoisted.db) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    let inFilter: ((r: Record<string, unknown>) => boolean) | null = null
    let limitN = Infinity
    const orders: Array<[string, boolean]> = []

    const rows = () => {
      let out = hoisted.db[name].filter((r) => filters.every((f) => f(r)))
      if (inFilter) out = out.filter(inFilter)
      // Reverse + stable sort = lexicographic over the order keys (nulls last).
      for (const [k, asc] of [...orders].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[k] as string | null | undefined
          const bv = b[k] as string | null | undefined
          if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1
          return asc ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      return out.slice(0, limitN)
    }

    const result = () => ({ data: rows(), error: null })

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => {
        filters.push((r) => r[k] === v)
        return api
      },
      neq: (k: string, v: unknown) => {
        filters.push((r) => r[k] !== v)
        return api
      },
      in: (k: string, vals: unknown[]) => {
        const set = new Set(vals)
        inFilter = (r) => set.has(r[k])
        return api
      },
      order: (k: string, o?: { ascending?: boolean }) => {
        orders.push([k, o?.ascending !== false])
        return api
      },
      range: (from: number, to: number) =>
        Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
      limit: (n: number) => {
        limitN = n
        return Promise.resolve(result())
      },
      maybeSingle: () => {
        const out = rows()
        return Promise.resolve({ data: out[0] ?? null, error: null })
      },
      // entity_link queries are awaited without a terminal method — make the
      // builder itself thenable so `await supabase.from(...).select()...` works.
      then: (cb: (v: unknown) => unknown) => Promise.resolve(result()).then(cb),
    }
    return api
  }

  return { from: (name: string) => table(name as keyof typeof hoisted.db) }
}

function authContext(workspaceId = 'workspace-1') {
  return {
    supabase: makeClient(),
    user: { id: 'user-1' },
    workspaceId,
  }
}

const UNAUTHED = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
})

const { GET } = await import('@/app/api/account/knowledge/entity-context/route')

function getReq(params: Record<string, string> = {}): NextRequest {
  const url = new URL('https://nativeintelligence.dev/api/account/knowledge/entity-context')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const req = buildRequest({ url: url.toString(), method: 'GET' })
  return Object.assign(req, { nextUrl: url }) as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.db.entity_link = []
  hoisted.db.claim = []
  hoisted.db.knowledge_brief = []
  hoisted.db.claim_source = []
  hoisted.db.captures = []
  hoisted.db.attachments = []
  hoisted.db.document = []
  hoisted.requireWorkspace.mockResolvedValue(authContext())
  // Default: no provenance → excerpt null for every claim.
  hoisted.reconcileProvenance.mockResolvedValue(new Map())
})

describe('GET /api/account/knowledge/entity-context', () => {
  it('returns 401 when the caller is not authed', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(UNAUTHED)
    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when type is missing or invalid', async () => {
    expect((await GET(getReq({ id: 'c-1' }))).status).toBe(400)
    expect((await GET(getReq({ type: 'capture', id: 'c-1' }))).status).toBe(400)
  })

  it('returns 400 when id is missing', async () => {
    const res = await GET(getReq({ type: 'contact' }))
    expect(res.status).toBe(400)
  })

  it('contact: returns linked claims (both edge directions) with no brief field', async () => {
    // Outbound edge: claim-A --about--> contact c-1
    // Inbound edge:  contact c-1 --mentions--> claim-B
    hoisted.db.entity_link = [
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'claim-A', target_type: 'contact', target_id: 'c-1', relation: 'about' },
      { workspace_id: 'workspace-1', source_type: 'contact', source_id: 'c-1', target_type: 'claim', target_id: 'claim-B', relation: 'mentions' },
    ]
    hoisted.db.claim = [
      { id: 'claim-A', text: 'A commits to ship Friday', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
      { id: 'claim-B', text: 'B mentioned budget', type: 'inference', confirmation: 'suggested', status: 'active', event_at: null, created_at: '2026-06-01T00:00:00Z', workspace_id: 'workspace-1' },
    ]

    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('contact')
    expect(body).not.toHaveProperty('brief')
    const ids = (body.claims as Array<{ id: string }>).map((c) => c.id).sort()
    expect(ids).toEqual(['claim-A', 'claim-B'])
    // Shape check on one claim.
    const a = (body.claims as Array<{ id: string; excerpt: unknown }>).find((c) => c.id === 'claim-A')
    expect(a).toMatchObject({ text: 'A commits to ship Friday', type: 'fact', confirmation: 'confirmed', excerpt: null })
  })

  it('contact: returns a claim only when one of its sources is readable: never mail, never another person\'s private capture (341)', async () => {
    const ids = ['from-meeting', 'from-mail', 'mail-and-meeting', 'their-private', 'my-private', 'private-and-doc']
    hoisted.db.entity_link = ids.map((id) => ({ workspace_id: 'workspace-1', source_type: 'claim', source_id: id, target_type: 'contact', target_id: 'c-1' }))
    hoisted.db.claim = ids.map((id) => ({
      id, text: id, type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1',
    }))
    hoisted.db.captures = [
      { id: 'cap-1', visibility: 'workspace', user_id: 'someone', is_eval: false },
      { id: 'cap-theirs', visibility: 'private', user_id: 'someone', is_eval: false },
      { id: 'cap-mine', visibility: 'private', user_id: 'user-1', is_eval: false },
    ]
    hoisted.db.claim_source = [
      { claim_id: 'from-meeting', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'from-mail', source_type: 'email', source_id: 'msg-1' },
      { claim_id: 'mail-and-meeting', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'mail-and-meeting', source_type: 'email', source_id: 'msg-2' },
      { claim_id: 'their-private', source_type: 'capture', source_id: 'cap-theirs' },
      { claim_id: 'my-private', source_type: 'capture', source_id: 'cap-mine' },
      { claim_id: 'private-and-doc', source_type: 'capture', source_id: 'cap-theirs' },
      { claim_id: 'private-and-doc', source_type: 'document', source_id: 'doc-1' },
    ]
    hoisted.db.document = [{ id: 'doc-1', visibility: 'workspace', owner: null }]

    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    expect(res.status).toBe(200)
    const shown = ((await res.json()).claims as Array<{ id: string }>).map((c) => c.id).sort()
    expect(shown).toEqual(['from-meeting', 'my-private', 'private-and-doc'])
  })

  it('contact: a claim known only from another person\'s private document is hidden; from my own it shows (369)', async () => {
    const ids = ['their-doc', 'my-doc', 'their-doc-and-meeting']
    hoisted.db.entity_link = ids.map((id) => ({ workspace_id: 'workspace-1', source_type: 'claim', source_id: id, target_type: 'contact', target_id: 'c-1' }))
    hoisted.db.claim = ids.map((id) => ({
      id, text: id, type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1',
    }))
    hoisted.db.captures = [{ id: 'cap-1', visibility: 'workspace', user_id: 'someone', is_eval: false }]
    hoisted.db.document = [
      { id: 'doc-theirs', visibility: 'private', owner: { user_id: 'someone' } },
      { id: 'doc-mine', visibility: 'private', owner: { user_id: 'user-1' } },
    ]
    hoisted.db.claim_source = [
      { claim_id: 'their-doc', source_type: 'document', source_id: 'doc-theirs' },
      { claim_id: 'my-doc', source_type: 'document', source_id: 'doc-mine' },
      { claim_id: 'their-doc-and-meeting', source_type: 'document', source_id: 'doc-theirs' },
      { claim_id: 'their-doc-and-meeting', source_type: 'capture', source_id: 'cap-1' },
    ]

    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    const shown = ((await res.json()).claims as Array<{ id: string }>).map((c) => c.id).sort()
    expect(shown).toEqual(['my-doc', 'their-doc-and-meeting'])
  })

  it('contact: excludes dismissed and superseded claims', async () => {
    hoisted.db.entity_link = [
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'live', target_type: 'contact', target_id: 'c-1' },
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'dismissed', target_type: 'contact', target_id: 'c-1' },
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'superseded', target_type: 'contact', target_id: 'c-1' },
    ]
    hoisted.db.claim = [
      { id: 'live', text: 'live', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
      { id: 'dismissed', text: 'gone', type: 'fact', confirmation: 'dismissed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
      { id: 'superseded', text: 'old', type: 'fact', confirmation: 'confirmed', status: 'superseded', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
    ]

    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    const body = await res.json()
    const ids = (body.claims as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toEqual(['live'])
  })

  it('contact: attaches the top excerpt from reconcileProvenance', async () => {
    hoisted.db.entity_link = [
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'claim-A', target_type: 'contact', target_id: 'c-1' },
    ]
    hoisted.db.claim = [
      { id: 'claim-A', text: 'text', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
    ]
    hoisted.reconcileProvenance.mockResolvedValueOnce(
      new Map([
        [
          'claim-A',
          [
            { entity_type: 'contact', entity_id: 'c-1', source_uri: null, excerpt: null, relations: ['about'], in_sources: false, in_graph: true },
            { entity_type: 'capture', entity_id: 'cap-1', source_uri: null, excerpt: 'the supporting quote', relations: [], in_sources: true, in_graph: false },
          ],
        ],
      ]),
    )

    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    const body = await res.json()
    expect(body.claims[0].excerpt).toEqual({
      excerpt: 'the supporting quote',
      source_label: null,
      source_type: 'capture',
    })
  })

  it('project: returns the brief when a row exists', async () => {
    hoisted.db.knowledge_brief = [
      { workspace_id: 'workspace-1', scope_type: 'project', scope_id: 'p-1', content: '# Brief\n\nSome markdown', claim_count: 7, generated_at: '2026-07-05T00:00:00Z' },
    ]
    const res = await GET(getReq({ type: 'project', id: 'p-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('project')
    expect(body.brief).toEqual({
      content: '# Brief\n\nSome markdown',
      claim_count: 7,
      generated_at: '2026-07-05T00:00:00Z',
    })
    expect(Array.isArray(body.claims)).toBe(true)
  })

  it('project: returns brief=null when the project has no brief', async () => {
    const res = await GET(getReq({ type: 'project', id: 'p-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.brief).toBeNull()
    expect(body.claims).toEqual([])
  })
})

/**
 * `company` is an ANCHOR type now, so it gets exactly what a project gets: the
 * bidirectional claims union AND a knowledge_brief scoped to its own type.
 * Nothing in the claims block is company-specific — these tests exist to prove
 * the type flows all the way through rather than being special-cased.
 */
describe('entity-context — company anchor', () => {
  it('accepts type=company (the gate was project|contact only)', async () => {
    const res = await GET(getReq({ type: 'company', id: 'co-1' }))
    expect(res.status).toBe(200)
    expect((await res.json()).type).toBe('company')
  })

  it('still refuses a type that is not an anchor or contact', async () => {
    // `campaign` is in the anchor design but has no table yet — it must 400
    // until it is deliberately added, not fall through to an empty query.
    expect((await GET(getReq({ type: 'campaign', id: 'x' }))).status).toBe(400)
    expect((await GET(getReq({ type: 'capture', id: 'x' }))).status).toBe(400)
  })

  it('company: collects claims from BOTH edge directions', async () => {
    hoisted.db.entity_link = [
      // claim --about--> company
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'claim-A', target_type: 'company', target_id: 'co-1', relation: 'about' },
      // company --mentions--> claim
      { workspace_id: 'workspace-1', source_type: 'company', source_id: 'co-1', target_type: 'claim', target_id: 'claim-B', relation: 'mentions' },
      // A different company's edge must NOT leak in.
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'claim-C', target_type: 'company', target_id: 'co-2', relation: 'about' },
    ]
    hoisted.db.claim = [
      { id: 'claim-A', text: 'Acme renewed for 2 years', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
      { id: 'claim-B', text: 'Acme wants SSO', type: 'inference', confirmation: 'suggested', status: 'active', event_at: null, created_at: '2026-06-01T00:00:00Z', workspace_id: 'workspace-1' },
      { id: 'claim-C', text: 'Other co', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: '2026-06-01T00:00:00Z', workspace_id: 'workspace-1' },
    ]

    const res = await GET(getReq({ type: 'company', id: 'co-1' }))
    const body = await res.json()
    const ids = (body.claims as Array<{ id: string }>).map((c) => c.id).sort()
    expect(ids).toEqual(['claim-A', 'claim-B'])
  })

  it('company: excludes dismissed and superseded claims like every other type', async () => {
    hoisted.db.entity_link = [
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'live', target_type: 'company', target_id: 'co-1' },
      { workspace_id: 'workspace-1', source_type: 'claim', source_id: 'dismissed', target_type: 'company', target_id: 'co-1' },
    ]
    hoisted.db.claim = [
      { id: 'live', text: 'live', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
      { id: 'dismissed', text: 'gone', type: 'fact', confirmation: 'dismissed', status: 'active', event_at: null, created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1' },
    ]
    const body = await (await GET(getReq({ type: 'company', id: 'co-1' }))).json()
    expect((body.claims as Array<{ id: string }>).map((c) => c.id)).toEqual(['live'])
  })

  it('company: returns the brief filed under scope_type=company', async () => {
    hoisted.db.knowledge_brief = [
      { workspace_id: 'workspace-1', scope_type: 'company', scope_id: 'co-1', content: '# Acme', claim_count: 4, generated_at: '2026-07-05T00:00:00Z' },
      // A project brief with the SAME scope_id must not be picked up — the
      // scope_type filter is what keeps the two namespaces apart.
      { workspace_id: 'workspace-1', scope_type: 'project', scope_id: 'co-1', content: '# Not this', claim_count: 99, generated_at: '2026-07-05T00:00:00Z' },
    ]
    const body = await (await GET(getReq({ type: 'company', id: 'co-1' }))).json()
    expect(body.brief).toEqual({
      content: '# Acme',
      claim_count: 4,
      generated_at: '2026-07-05T00:00:00Z',
    })
  })

  it('company: brief is null when nothing is compiled yet', async () => {
    const body = await (await GET(getReq({ type: 'company', id: 'co-1' }))).json()
    expect(body.brief).toBeNull()
  })

  it('contact still gets NO brief field — the weaver compiles none for contacts', async () => {
    hoisted.db.knowledge_brief = [
      { workspace_id: 'workspace-1', scope_type: 'contact', scope_id: 'c-1', content: '# Nope', claim_count: 1, generated_at: '2026-07-05T00:00:00Z' },
    ]
    const body = await (await GET(getReq({ type: 'contact', id: 'c-1' }))).json()
    expect(body).not.toHaveProperty('brief')
  })
})

describe('GET /api/account/knowledge/entity-context — busy hubs', () => {
  it('reads hundreds of linked claims in chunks and returns the newest CLAIM_LIMIT overall', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `claim-${String(i).padStart(3, '0')}`)
    hoisted.db.entity_link = ids.map((id) => ({ workspace_id: 'workspace-1', source_type: 'claim', source_id: id, target_type: 'contact', target_id: 'c-1' }))
    hoisted.db.claim = ids.map((id, i) => ({
      id, text: id, type: 'fact', confirmation: 'confirmed', status: 'active',
      // claim-449 is the newest; the newest ten all sit in the LAST chunk.
      event_at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      created_at: '2026-07-01T00:00:00Z', workspace_id: 'workspace-1',
    }))
    hoisted.db.claim_source = ids.map((id) => ({ claim_id: id, source_type: 'document', source_id: 'doc-1' }))
    hoisted.db.document = [{ id: 'doc-1', visibility: 'workspace', owner: null }]

    const res = await GET(getReq({ type: 'contact', id: 'c-1' }))
    expect(res.status).toBe(200)
    const shown = ((await res.json()).claims as Array<{ id: string }>).map((c) => c.id)
    expect(shown).toHaveLength(10)
    expect(shown[0]).toBe('claim-449')
    expect(shown[9]).toBe('claim-440')
  })
})
