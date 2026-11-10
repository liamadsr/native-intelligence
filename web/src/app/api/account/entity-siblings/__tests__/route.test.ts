/**
 * Tests for GET /api/account/entity-siblings.
 *
 * The route is the prev/next fallback for a detail panel opened WITHOUT a list
 * behind it, so the load-bearing behaviour is the ORDERING — the neighbours it
 * returns must match what the arrows would do with the list mounted:
 *   - actions ride the per-team identifier ladder ranked NUMERICALLY (the
 *     column is TEXT, so a lexical sort would put GEN-9 after GEN-52) and the
 *     ladder is gap-ridden, so prev of GEN-52 can be GEN-54
 *   - a team-less / identifier-less action falls back to created_at DESC
 *   - captures order by COALESCE(started_at, created_at) DESC
 *   - the ends of a list return null on the outward side
 *   - an entity that isn't in this workspace is nulls at 200, never a 404
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'
import { unauthorized } from '@/lib/api-errors'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
}))

import { GET } from '../route'
import { SCOPE_LIMIT } from '@/lib/views/entity-siblings'

type Row = Record<string, unknown>

interface TableFixture {
  /** Rows the table holds; the fake applies .eq() filters against them. */
  rows: Row[]
  error?: { message: string } | null
}

/**
 * A Supabase fake that actually honours `.eq()` and `.maybeSingle()` so the
 * test exercises the route's real filtering (workspace scoping, team scoping)
 * rather than trusting a canned result.
 */
function makeSupabase(tables: Record<string, TableFixture>) {
  const fromCalls: Array<{ table: string; filters: Record<string, unknown> }> = []

  function builder(table: string) {
    const fixture = tables[table] ?? { rows: [] }
    const filters: Record<string, unknown> = {}
    const call = { table, filters }
    fromCalls.push(call)

    const nullFilters: string[] = []

    const neqFilters: Array<[string, unknown]> = []
    const orderings: Array<{ key: string; ascending: boolean; nullsFirst: boolean }> = []

    const matching = () =>
      fixture.rows.filter(
        (row) =>
          Object.entries(filters).every(([key, value]) => row[key] === value) &&
          nullFilters.every((key) => (row[key] ?? null) === null) &&
          neqFilters.every(([key, value]) => row[key] !== value),
      )

    // Honour the recorded .order() calls with Postgres null semantics so the
    // .limit() below truncates the SAME rows a real query would — that is the
    // whole point of the ordered-limit regression tests.
    const ordered = () => {
      const rows = [...matching()]
      if (orderings.length === 0) return rows
      rows.sort((a, b) => {
        for (const { key, ascending, nullsFirst } of orderings) {
          const av = a[key] ?? null
          const bv = b[key] ?? null
          if (av === null || bv === null) {
            if (av === bv) continue
            return (av === null ? -1 : 1) * (nullsFirst ? 1 : -1)
          }
          if (av === bv) continue
          const cmp = String(av) < String(bv) ? -1 : 1
          return ascending ? cmp : -cmp
        }
        return 0
      })
      return rows
    }

    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => {
        filters[key] = value
        return chain
      },
      is: (key: string, value: unknown) => {
        expect(value).toBeNull()
        nullFilters.push(key)
        return chain
      },
      neq: (key: string, value: unknown) => {
        neqFilters.push([key, value])
        return chain
      },
      order: (key: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
        const ascending = opts?.ascending ?? true
        orderings.push({
          key,
          ascending,
          // Postgres defaults: NULLS LAST for ASC, NULLS FIRST for DESC.
          nullsFirst: opts?.nullsFirst ?? !ascending,
        })
        return chain
      },
      limit: (n: number) =>
        Promise.resolve(
          fixture.error
            ? { data: null, error: fixture.error }
            : { data: ordered().slice(0, n), error: null },
        ),
      maybeSingle: () =>
        Promise.resolve(
          fixture.error
            ? { data: null, error: fixture.error }
            : { data: matching()[0] ?? null, error: null },
        ),
    }
    return chain
  }

  return { client: { from: (table: string) => builder(table) }, fromCalls }
}

function authWith(tables: Record<string, TableFixture>) {
  const { client } = makeSupabase(tables)
  return {
    user: { id: 'user-1', email: 'test@nativeintelligence.test' },
    workspaceId: 'ws-1',
    supabase: client,
  }
}

function req(query: string) {
  return new Request(`https://nativeintelligence.dev/api/account/entity-siblings?${query}`) as unknown as NextRequest
}

async function siblings(query: string) {
  const res = await GET(req(query))
  expect(res.status).toBe(200)
  return readJson<{
    prev: { id: string; title: string | null } | null
    next: { id: string; title: string | null } | null
  }>(res)
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
})

// ── param validation + auth ─────────────────────────────────────────────────

describe('entity-siblings param validation', () => {
  it('400s on an unknown type', async () => {
    hoisted.requireWorkspace.mockResolvedValue(authWith({}))
    const res = await GET(req('type=widget&id=a1'))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body.code).toBe('BAD_REQUEST')
  })

  it('400s when type is missing entirely', async () => {
    hoisted.requireWorkspace.mockResolvedValue(authWith({}))
    const res = await GET(req('id=a1'))
    expect(res.status).toBe(400)
  })

  it('400s when id is missing', async () => {
    hoisted.requireWorkspace.mockResolvedValue(authWith({}))
    const res = await GET(req('type=action'))
    expect(res.status).toBe(400)
  })

  it('passes the auth failure Response straight through', async () => {
    hoisted.requireWorkspace.mockResolvedValue(unauthorized())
    const res = await GET(req('type=action&id=a1'))
    expect(res.status).toBe(401)
    // The gate runs BEFORE param validation, so even a bogus type stays 401.
    const bad = await GET(req('type=widget&id=a1'))
    expect(bad.status).toBe(401)
  })
})

// ── action: identifier ladder ───────────────────────────────────────────────

function action(id: string, identifier: string | null, extra: Row = {}): Row {
  return {
    id,
    workspace_id: 'ws-1',
    team_id: 'team-1',
    identifier,
    title: `Action ${identifier ?? id}`,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

describe('entity-siblings — action identifier ladder', () => {
  it('ranks the ladder NUMERICALLY, not lexically (GEN-9 is older than GEN-52)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [action('a9', 'GEN-9'), action('a52', 'GEN-52'), action('a53', 'GEN-53')],
        },
      }),
    )
    const body = await siblings('type=action&id=a52')
    // A lexical sort would order GEN-9 > GEN-53 > GEN-52 and hand back the
    // wrong neighbours entirely.
    expect(body.prev).toEqual({ id: 'a53', title: 'Action GEN-53' })
    expect(body.next).toEqual({ id: 'a9', title: 'Action GEN-9' })
  })

  it('skips ladder gaps — prev of GEN-52 is GEN-54 when 53 is gone', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: { rows: [action('a54', 'GEN-54'), action('a52', 'GEN-52'), action('a48', 'GEN-48')] },
      }),
    )
    const body = await siblings('type=action&id=a52')
    expect(body.prev?.id).toBe('a54')
    expect(body.next?.id).toBe('a48')
  })

  it('scopes the ladder to the action OWN team — another team is not a sibling', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a53', 'GEN-53'),
            action('a52', 'GEN-52'),
            action('b53', 'ENG-53', { team_id: 'team-2' }),
            action('b51', 'ENG-51', { team_id: 'team-2' }),
          ],
        },
      }),
    )
    const body = await siblings('type=action&id=a52')
    expect(body.prev?.id).toBe('a53')
    // team-2's ENG-51 would sit directly below GEN-52 on a workspace-wide
    // numeric sort; team scoping keeps it out.
    expect(body.next).toBeNull()
  })

  it('returns prev=null at the top of the ladder and next=null at the bottom', async () => {
    const rows = [action('a3', 'GEN-3'), action('a2', 'GEN-2'), action('a1', 'GEN-1')]
    hoisted.requireWorkspace.mockResolvedValue(authWith({ actions: { rows } }))
    const top = await siblings('type=action&id=a3')
    expect(top.prev).toBeNull()
    expect(top.next?.id).toBe('a2')

    hoisted.requireWorkspace.mockResolvedValue(authWith({ actions: { rows } }))
    const bottom = await siblings('type=action&id=a1')
    expect(bottom.prev?.id).toBe('a2')
    expect(bottom.next).toBeNull()
  })

  it('falls back to created_at DESC when the action has no team_id', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a-new', null, { team_id: null, created_at: '2026-03-03T00:00:00Z' }),
            action('a-mid', null, { team_id: null, created_at: '2026-02-02T00:00:00Z' }),
            action('a-old', null, { team_id: null, created_at: '2026-01-01T00:00:00Z' }),
          ],
        },
      }),
    )
    const body = await siblings('type=action&id=a-mid')
    expect(body.prev?.id).toBe('a-new')
    expect(body.next?.id).toBe('a-old')
  })

  it('falls back to created_at DESC when the identifier has no parseable number', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a-new', 'legacy', { created_at: '2026-03-03T00:00:00Z' }),
            action('a-mid', 'GEN-XX', { created_at: '2026-02-02T00:00:00Z' }),
            action('a-old', 'GEN-4', { created_at: '2026-01-01T00:00:00Z' }),
          ],
        },
      }),
    )
    // The TARGET has no rung, so the whole scope degrades to created_at DESC —
    // which does include the ranked GEN-4 row (it's still a workspace action).
    const body = await siblings('type=action&id=a-mid')
    expect(body.prev?.id).toBe('a-new')
    expect(body.next?.id).toBe('a-old')
  })

  it('drops unranked rows out of a ladder scope rather than piling them at the bottom', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a5', 'GEN-5'),
            action('a4', 'GEN-4'),
            action('a-junk', 'legacy-import'),
          ],
        },
      }),
    )
    const body = await siblings('type=action&id=a4')
    expect(body.prev?.id).toBe('a5')
    expect(body.next).toBeNull()
  })

  it('scopes to the workspace — an action in another workspace is not a sibling', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a5', 'GEN-5', { workspace_id: 'ws-other' }),
            action('a4', 'GEN-4'),
            action('a3', 'GEN-3'),
          ],
        },
      }),
    )
    const body = await siblings('type=action&id=a4')
    expect(body.prev).toBeNull()
    expect(body.next?.id).toBe('a3')
  })

  it('excludes sub-actions from the ladder — the actions list never shows them as rows', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a53', 'GEN-53'),
            action('a52', 'GEN-52'),
            // A sub-task on the same ladder, adjacent by number. Stepping onto
            // it would land on a row that appears in no list.
            action('a51-sub', 'GEN-51', { parent_id: 'a52' }),
            action('a50', 'GEN-50'),
          ],
        },
      }),
    )
    const body = await siblings('type=action&id=a52')
    expect(body.prev?.id).toBe('a53')
    expect(body.next?.id).toBe('a50')
  })

  it('returns nulls when the target itself is a sub-action — it belongs to no list ordering', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: {
          rows: [
            action('a52', 'GEN-52'),
            action('a51-sub', 'GEN-51', { parent_id: 'a52' }),
            action('a50', 'GEN-50'),
          ],
        },
      }),
    )
    const body = await siblings('type=action&id=a51-sub')
    expect(body.prev).toBeNull()
    expect(body.next).toBeNull()
  })
})

// ── capture: COALESCE(started_at, created_at) ───────────────────────────────

function capture(id: string, startedAt: string | null, createdAt: string): Row {
  return {
    id,
    workspace_id: 'ws-1',
    title: `Capture ${id}`,
    started_at: startedAt,
    created_at: createdAt,
  }
}

describe('entity-siblings — capture ordering', () => {
  it('orders by started_at DESC, falling back to created_at when started_at is null', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        captures: {
          rows: [
            // Ordering by created_at alone would put c-created (Jan 5) below
            // c-late (created Jan 1) — the COALESCE is what floats it up.
            capture('c-late', '2026-01-10T09:00:00Z', '2026-01-01T00:00:00Z'),
            capture('c-created', null, '2026-01-05T00:00:00Z'),
            capture('c-early', '2026-01-02T09:00:00Z', '2026-01-09T00:00:00Z'),
          ],
        },
      }),
    )
    const body = await siblings('type=capture&id=c-created')
    expect(body.prev).toEqual({ id: 'c-late', title: 'Capture c-late' })
    expect(body.next).toEqual({ id: 'c-early', title: 'Capture c-early' })
  })

  it('returns nulls on both sides for a lone capture', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({ captures: { rows: [capture('c1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')] } }),
    )
    const body = await siblings('type=capture&id=c1')
    expect(body).toEqual({ prev: null, next: null })
  })

  it('tiebreaks equal timestamps by id so the order is total and stable', async () => {
    const at = '2026-01-01T00:00:00Z'
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        captures: { rows: [capture('cc', at, at), capture('aa', at, at), capture('bb', at, at)] },
      }),
    )
    const body = await siblings('type=capture&id=bb')
    expect(body.prev?.id).toBe('aa')
    expect(body.next?.id).toBe('cc')
  })
})

// ── created_at types + title normalization ─────────────────────────────────

describe('entity-siblings — created_at types', () => {
  it('normalizes the contact title from full_name', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        contact: {
          rows: [
            { id: 'p3', workspace_id: 'ws-1', full_name: 'Cara', created_at: '2026-03-01T00:00:00Z' },
            { id: 'p2', workspace_id: 'ws-1', full_name: 'Bo', created_at: '2026-02-01T00:00:00Z' },
            { id: 'p1', workspace_id: 'ws-1', full_name: 'Ada', created_at: '2026-01-01T00:00:00Z' },
          ],
        },
      }),
    )
    const body = await siblings('type=contact&id=p2')
    expect(body.prev).toEqual({ id: 'p3', title: 'Cara' })
    expect(body.next).toEqual({ id: 'p1', title: 'Ada' })
  })

  it('skips a contact merged away into another contact (the list hides it too)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        contact: {
          rows: [
            { id: 'p3', workspace_id: 'ws-1', full_name: 'Cara', created_at: '2026-03-01T00:00:00Z' },
            {
              id: 'p-merged',
              workspace_id: 'ws-1',
              full_name: 'Dupe',
              created_at: '2026-02-15T00:00:00Z',
              merged_into_contact_id: 'p3',
            },
            { id: 'p2', workspace_id: 'ws-1', full_name: 'Bo', created_at: '2026-02-01T00:00:00Z' },
          ],
        },
      }),
    )
    // p-merged sits between p3 and p2 by created_at; stepping onto it would
    // land the user on a tombstone row, so it must be skipped entirely.
    const body = await siblings('type=contact&id=p2')
    expect(body.prev?.id).toBe('p3')
    expect(body.next).toBeNull()
  })

  it('normalizes project/initiative/company titles from name', async () => {
    for (const [type, table] of [
      ['project', 'projects'],
      ['initiative', 'initiative'],
      ['company', 'company'],
    ] as const) {
      hoisted.requireWorkspace.mockResolvedValue(
        authWith({
          [table]: {
            rows: [
              { id: 'x2', workspace_id: 'ws-1', name: 'Newer', created_at: '2026-02-01T00:00:00Z' },
              { id: 'x1', workspace_id: 'ws-1', name: 'Older', created_at: '2026-01-01T00:00:00Z' },
            ],
          },
        }),
      )
      const body = await siblings(`type=${type}&id=x1`)
      expect(body.prev, type).toEqual({ id: 'x2', title: 'Newer' })
      expect(body.next, type).toBeNull()
    }
  })

  it('excludes the internal __default__ project — the projects list hides it too', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        projects: {
          rows: [
            { id: 'p2', workspace_id: 'ws-1', name: 'Real project', created_at: '2026-02-01T00:00:00Z' },
            // Provisioned at workspace setup, so typically the oldest row —
            // exactly where a created_at scan would otherwise surface it.
            { id: 'p-def', workspace_id: 'ws-1', name: '__default__', created_at: '2026-01-01T00:00:00Z' },
            { id: 'p1', workspace_id: 'ws-1', name: 'Oldest real', created_at: '2026-01-15T00:00:00Z' },
          ],
        },
      }),
    )
    const body = await siblings('type=project&id=p2')
    expect(body.next?.id).toBe('p1')

    // As a target it answers nulls: it is in no list, so it has no ordering.
    const asTarget = await siblings('type=project&id=p-def')
    expect(asTarget.prev).toBeNull()
    expect(asTarget.next).toBeNull()
  })

  it('orders documents by created_at DESC', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        document: {
          rows: [
            { id: 'd1', workspace_id: 'ws-1', title: 'One', created_at: '2026-01-01T00:00:00Z' },
            { id: 'd3', workspace_id: 'ws-1', title: 'Three', created_at: '2026-03-01T00:00:00Z' },
            { id: 'd2', workspace_id: 'ws-1', title: 'Two', created_at: '2026-02-01T00:00:00Z' },
          ],
        },
      }),
    )
    const body = await siblings('type=document&id=d2')
    expect(body.prev?.id).toBe('d3')
    expect(body.next?.id).toBe('d1')
  })
})

// ── missing entity + DB failure ────────────────────────────────────────────

describe('entity-siblings — missing entity', () => {
  it('returns nulls at 200 (not 404) when the entity is not in this workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        actions: { rows: [action('a1', 'GEN-1'), action('a2', 'GEN-2')] },
      }),
    )
    const body = await siblings('type=action&id=does-not-exist')
    expect(body).toEqual({ prev: null, next: null })
  })

  it('returns nulls at 200 when the entity exists in ANOTHER workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        captures: { rows: [capture('c1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')] },
      }),
    )
    // The fixture row is ws-1; ask as a different workspace.
    hoisted.requireWorkspace.mockResolvedValue({
      user: { id: 'user-1' },
      workspaceId: 'ws-other',
      supabase: makeSupabase({
        captures: { rows: [capture('c1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')] },
      }).client,
    })
    const body = await siblings('type=capture&id=c1')
    expect(body).toEqual({ prev: null, next: null })
  })

  it('returns nulls for a merged-away contact — it is not in its own list', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({
        contact: {
          rows: [
            { id: 'p1', workspace_id: 'ws-1', full_name: 'Ada', created_at: '2026-01-01T00:00:00Z' },
            {
              id: 'p-merged',
              workspace_id: 'ws-1',
              full_name: 'Dupe',
              created_at: '2026-02-01T00:00:00Z',
              merged_into_contact_id: 'p1',
            },
          ],
        },
      }),
    )
    const body = await siblings('type=contact&id=p-merged')
    expect(body).toEqual({ prev: null, next: null })
  })

  it('500s when the scope query errors', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      authWith({ document: { rows: [], error: { message: 'boom' } } }),
    )
    const res = await GET(req('type=document&id=d1'))
    // A target lookup that errors is a 500, not a silent "no siblings".
    expect(res.status).toBe(500)
  })
})

// ── ordered truncation ──────────────────────────────────────────────────────

describe('entity-siblings — scope cap keeps the TOP of the ordering', () => {
  it('finds a newest-row target in a scope one past the cap', async () => {
    // One more capture than the cap, inserted OLDEST-FIRST so that an
    // unordered `.limit()` (which the fake then serves in insertion order)
    // would truncate away the newest rows — including the target — and the
    // route would answer "no siblings" for an entity with an obvious
    // neighbour. The ORDER BY the route sends makes retention keep the newest
    // rows instead, which is the only correct set for a newest-first scan.
    const rows: Row[] = []
    const epoch = Date.UTC(2026, 0, 1)
    for (let i = 0; i <= SCOPE_LIMIT; i++) {
      rows.push({
        id: `c${String(i).padStart(5, '0')}`,
        workspace_id: 'ws-1',
        title: `Capture ${i}`,
        started_at: null,
        created_at: new Date(epoch + i * 1000).toISOString(),
      })
    }
    const newest = rows[rows.length - 1]
    const secondNewest = rows[rows.length - 2]
    hoisted.requireWorkspace.mockResolvedValue(authWith({ captures: { rows } }))
    const body = await siblings(`type=capture&id=${newest.id}`)
    expect(body.prev).toBeNull()
    expect(body.next?.id).toBe(secondNewest.id)
  })
})
