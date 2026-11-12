/**
 * The store of paid lookups: the same question (whatever its key order) finds
 * the newest fresh snapshot; a stale one is not served; a result over the
 * size cap is not stored; each workspace keeps a bounded number per kind;
 * lists never read the result; every read is fenced to the workspace.
 */
import { memoryDb } from '@/test/memory-db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  deleteLookup,
  getLookup,
  HOUR_MS,
  isLookupKind,
  listLookups,
  LOOKUP_MAX_RESULT_BYTES,
  lookupKeyHash,
  pruneLookups,
  readLookup,
  updateLookupResult,
  writeLookup,
} from '../lookup-cache'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const who = { workspaceId: WS, userId: null }
const at = (iso: string) => new Date(iso)

/** The in-memory db, recording every column list a select asked for. */
function spyDb() {
  const tables: Record<string, Record<string, unknown>[]> = {}
  const db = memoryDb(tables)
  const selects: string[] = []
  const svc = {
    from(table: string) {
      const chain = (
        db as unknown as { from: (t: string) => Record<string, unknown> }
      ).from(table)
      const select = chain.select as (cols?: string, opts?: unknown) => unknown
      chain.select = (cols?: string, opts?: unknown) => {
        selects.push(cols ?? '*')
        return select(cols, opts)
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { svc, tables, selects }
}

describe('the lookup key', () => {
  it('ignores key order and undefined fields, and differs by kind', () => {
    expect(
      canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] }, e: undefined }),
    ).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}')
    expect(lookupKeyHash('keyword_research', { seed: 'x', limit: 150 })).toBe(
      lookupKeyHash('keyword_research', { limit: 150, seed: 'x' }),
    )
    expect(lookupKeyHash('keyword_research', { seed: 'x' })).not.toBe(
      lookupKeyHash('keyword_metrics', { seed: 'x' }),
    )
    expect(lookupKeyHash('serp_results', { seed: 'x' })).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  it('accepts lowercase snake_case kinds only', () => {
    expect(isLookupKind('backlinks_overview')).toBe(true)
    expect(isLookupKind('Backlinks')).toBe(false)
    expect(isLookupKind('1kind')).toBe(false)
    expect(isLookupKind('a'.repeat(41))).toBe(false)
  })
})

describe('readLookup / writeLookup', () => {
  it('answers the newest fresh snapshot for the same request, and nothing once it is stale', async () => {
    const { svc } = spyDb()
    await writeLookup(
      svc,
      who,
      {
        kind: 'domain_overview',
        request: { domain: 'example.com', loc: 2840 },
        result: { n: 1 },
      },
      { now: at('2026-11-01T00:00:00Z') },
    )
    await writeLookup(
      svc,
      who,
      {
        kind: 'domain_overview',
        request: { loc: 2840, domain: 'example.com' },
        result: { n: 2 },
      },
      { now: at('2026-11-01T06:00:00Z') },
    )

    const fresh = await readLookup<{ n: number }>(
      svc,
      WS,
      'domain_overview',
      { domain: 'example.com', loc: 2840 },
      { maxAgeMs: 12 * HOUR_MS, now: at('2026-11-01T10:00:00Z') },
    )
    expect(fresh?.result.n).toBe(2)

    const stale = await readLookup(
      svc,
      WS,
      'domain_overview',
      { domain: 'example.com', loc: 2840 },
      { maxAgeMs: 12 * HOUR_MS, now: at('2026-11-02T07:00:00Z') },
    )
    expect(stale).toBeNull()
  })

  it('never answers another workspace’s snapshot or another request’s', async () => {
    const { svc } = spyDb()
    await writeLookup(
      svc,
      { workspaceId: OTHER, userId: null },
      {
        kind: 'domain_overview',
        request: { domain: 'example.com' },
        result: { n: 1 },
      },
    )
    await writeLookup(svc, who, {
      kind: 'domain_overview',
      request: { domain: 'fernhillstudio.example' },
      result: { n: 2 },
    })
    expect(
      await readLookup(
        svc,
        WS,
        'domain_overview',
        { domain: 'example.com' },
        { maxAgeMs: HOUR_MS },
      ),
    ).toBeNull()
  })

  it('does not store a result over the size cap, and says so with null', async () => {
    const { svc, tables } = spyDb()
    const big = { text: 'x'.repeat(LOOKUP_MAX_RESULT_BYTES + 10) }
    expect(
      await writeLookup(svc, who, {
        kind: 'serp_results',
        request: { k: 1 },
        result: big,
      }),
    ).toBeNull()
    expect(tables.seo_lookup ?? []).toHaveLength(0)
  })

  it('stamps who bought it and a trimmed label', async () => {
    const { svc } = spyDb()
    const row = await writeLookup(
      svc,
      { workspaceId: WS, userId: 'u-1' },
      {
        kind: 'keyword_research',
        request: { s: 1 },
        result: {},
        label: 'y'.repeat(400),
      },
    )
    expect(row?.fetched_by).toBe('u-1')
    expect(row?.label).toHaveLength(300)
  })

  it('refuses a malformed kind before touching the table', async () => {
    const { svc } = spyDb()
    await expect(
      readLookup(svc, WS, 'Bad Kind', {}, { maxAgeMs: 1 }),
    ).rejects.toThrow(/bad kind/)
  })
})

describe('the per-kind cap', () => {
  it('deletes the oldest rows beyond the cap, only of that workspace and kind', async () => {
    const { svc, tables } = spyDb()
    for (let i = 0; i < 5; i++) {
      await writeLookup(
        svc,
        who,
        { kind: 'ranked_keywords', request: { i }, result: { i } },
        { now: at(`2026-11-0${i + 1}T00:00:00Z`) },
      )
    }
    await writeLookup(
      svc,
      { workspaceId: OTHER, userId: null },
      { kind: 'ranked_keywords', request: { i: 0 }, result: {} },
    )
    await writeLookup(svc, who, {
      kind: 'serp_results',
      request: { i: 0 },
      result: {},
    })

    expect(await pruneLookups(svc, WS, 'ranked_keywords', 3)).toBe(2)
    const left = (tables.seo_lookup ?? [])
      .filter(
        (row) => row.workspace_id === WS && row.kind === 'ranked_keywords',
      )
      .map((row) => (row.result as { i: number }).i)
    expect(left.sort()).toEqual([2, 3, 4])
    expect(
      (tables.seo_lookup ?? []).filter((row) => row.workspace_id === OTHER),
    ).toHaveLength(1)
    expect(
      (tables.seo_lookup ?? []).filter((row) => row.kind === 'serp_results'),
    ).toHaveLength(1)
  })
})

describe('lists and single reads', () => {
  it('lists recent lookups newest first without ever selecting the request or the result', async () => {
    const { svc, selects } = spyDb()
    await writeLookup(
      svc,
      who,
      {
        kind: 'keyword_research',
        request: { s: 'a' },
        result: { rows: [1] },
        label: 'a · United States',
      },
      { now: at('2026-11-01T00:00:00Z') },
    )
    await writeLookup(
      svc,
      who,
      {
        kind: 'keyword_research',
        request: { s: 'b' },
        result: { rows: [2] },
        label: 'b · United States',
      },
      { now: at('2026-11-02T00:00:00Z') },
    )
    await writeLookup(
      svc,
      who,
      { kind: 'serp_results', request: { s: 'c' }, result: {} },
      { now: at('2026-11-03T00:00:00Z') },
    )
    selects.length = 0

    const list = await listLookups(svc, WS, 'keyword_research', { limit: 10 })
    expect(list.map((row) => row.label)).toEqual([
      'b · United States',
      'a · United States',
    ])
    expect(list[0]).not.toHaveProperty('result')
    expect(
      selects.every(
        (cols) => !cols.includes('result') && !cols.includes('request'),
      ),
    ).toBe(true)

    expect((await listLookups(svc, WS, null)).map((row) => row.kind)).toEqual([
      'serp_results',
      'keyword_research',
      'keyword_research',
    ])
  })

  it('reads, updates and deletes one lookup only within its workspace', async () => {
    const { svc } = spyDb()
    const row = await writeLookup(svc, who, {
      kind: 'serp_results',
      request: { s: 1 },
      result: { reads: [] },
    })
    expect(row).not.toBeNull()
    const id = row!.id

    expect(await getLookup(svc, OTHER, id)).toBeNull()
    expect(await updateLookupResult(svc, OTHER, id, { reads: ['x'] })).toBe(
      false,
    )
    expect(await updateLookupResult(svc, WS, id, { reads: ['y'] })).toBe(true)
    expect(
      (await getLookup<{ reads: string[] }>(svc, WS, id))?.result.reads,
    ).toEqual(['y'])

    await deleteLookup(svc, OTHER, id)
    expect(await getLookup(svc, WS, id)).not.toBeNull()
    await deleteLookup(svc, WS, id)
    expect(await getLookup(svc, WS, id)).toBeNull()
  })
})
