/**
 * The claim mask.
 *
 * The class of bug guarded here is DIVERGENCE: the mask answering a saved claim
 * view differently from the SQL list that answers the same view. Every case
 * below is one where the obvious in-memory implementation is wrong and Postgres
 * is right —
 *
 *   - three-valued logic. A null fails `is_not` as surely as it fails `is`,
 *     which is the opposite of what "everything that is not X" reads like.
 *   - a 0 timestamp is 1970, a date a filter can legitimately ask about, so an
 *     unset `event_at` must not be swept up by "before 2000".
 *   - a Float32 column compared against a float64 literal drops the claims
 *     whose confidence is exactly the number the user typed.
 *   - the map used to hold only an 80-character label, so `text contains …`
 *     missed every match past the truncation that the SQL list found.
 *   - `project_ids` is `NOT NULL DEFAULT '{}'`, so the empty set is a VALUE:
 *     a claim on no project really does satisfy "project is none of X".
 */

import { describe, expect, it } from 'vitest'

import { layoutMap, type LaidOutMap } from '../layout'
import { maskClaims } from '../mask'
import { parseFilters, FILTER_PARAM } from '../filters'
import { tileMap } from '../tiling'
import type { FilterOperator } from '@/lib/views/types'
import type { MapFilters, SourceClaimRow, SourceLinkRow, SourceRows } from '../types'

const NOW = Date.UTC(2026, 8, 21)

const ANA = '0194b2c1-0000-7000-8000-00000000a11a'
const BEN = '0194b2c1-0000-7000-8000-00000000b22b'
const PROJECT_1 = '0194b2c1-0000-7000-8000-0000000001a1'
const PROJECT_2 = '0194b2c1-0000-7000-8000-0000000002a2'
const PROJECT_UNKNOWN = '0194b2c1-0000-7000-8000-000000009999'

/**
 * 210 characters, with the distinguishing word past character 150.
 *
 * `shortLabel` cuts at 80, so a map that kept only the label could not
 * possibly answer a `contains` on this — and would silently say "no matches".
 */
const LONG_TEXT = `${'The quarterly review covered a great many things. '.repeat(3)}Finally the board approved the PELICAN budget line, which nobody expected.`

function claim(id: string, over: Partial<SourceClaimRow> = {}): SourceClaimRow {
  return {
    id,
    text: `claim ${id}`,
    type: 'fact',
    confidence: 0.5,
    confirmation: 'suggested',
    status: 'active',
    scope: 'workspace',
    auto_accepted: false,
    created_by: ANA,
    created_at: '2026-09-01T00:00:00Z',
    event_at: '2026-08-20T00:00:00Z',
    last_verified_at: '2026-09-10T00:00:00Z',
    ...over,
  }
}

function link(sourceId: string, targetType: string, targetId: string, createdAt = '2026-09-02T00:00:00Z'): SourceLinkRow {
  return {
    source_id: sourceId,
    target_type: targetType,
    target_id: targetId,
    relation: 'mentions',
    created_at: createdAt,
  }
}

/**
 * Three claims spanning the interesting states: everything set, nothing
 * optional set, and a second populated row to prove a filter excludes rather
 * than merely fails to include.
 */
const rows: SourceRows = {
  hubs: [
    { type: 'capture', id: 'cap-A', label: 'Capture A' },
    { type: 'project', id: PROJECT_1, label: 'Zeta' },
    { type: 'project', id: PROJECT_2, label: 'Alpha' },
  ],
  claims: [
    claim('full', {
      text: LONG_TEXT,
      confidence: 0.7,
      confirmation: 'confirmed',
      auto_accepted: true,
      created_by: ANA,
      scope: 'workspace',
    }),
    claim('nulls', {
      confidence: null,
      scope: null,
      auto_accepted: null,
      created_by: null,
      event_at: null,
      last_verified_at: null,
    }),
    claim('other', {
      confidence: 0.2,
      created_by: BEN,
      scope: 'personal',
      auto_accepted: false,
      event_at: '2026-07-01T00:00:00Z',
    }),
  ],
  links: [
    link('full', 'capture', 'cap-A', '2026-09-01T00:00:00Z'),
    link('nulls', 'capture', 'cap-A', '2026-09-01T00:00:00Z'),
    link('other', 'capture', 'cap-A', '2026-09-01T00:00:00Z'),
    // `full` is on both projects; `other` on one; `nulls` on none.
    link('full', 'project', PROJECT_1),
    link('full', 'project', PROJECT_2),
    link('other', 'project', PROJECT_2),
  ],
}

const map: LaidOutMap = layoutMap(rows)

/** Claim ids the mask keeps. */
function kept(where: MapFilters['where']): Set<string> {
  const keep = maskClaims(map, where ? { where } : {})
  const out = new Set<string>()
  for (let c = 0; c < map.claimCount; c++) if (keep[c]) out.add(map.claimIds[c])
  return out
}

function ids(set: Set<string>): string[] {
  return [...set].sort()
}

describe('the fixture is what the tests assume', () => {
  it('holds three claims, one of them optional-free', () => {
    expect(ids(kept(undefined))).toEqual(['full', 'nulls', 'other'])
  })
})

// ─── Three-valued logic ───────────────────────────────────────────────────────

describe('a null is never a match', () => {
  /**
   * Every operator that must EXCLUDE the un-set row, per field. The row in
   * question is `nulls`, which has no confidence, scope, author, event time or
   * verification time.
   */
  const excludesNull: Array<[string, FilterOperator, unknown]> = [
    ['confidence', 'is', 0.5],
    ['confidence', 'is_not', 0.5],
    ['confidence', 'gt', 0.1],
    ['confidence', 'gte', 0],
    ['confidence', 'lt', 1],
    ['confidence', 'lte', 1],
    ['confidence', 'between', { from: 0, to: 1 }],
    ['scope', 'is', ['workspace']],
    ['scope', 'is_not', ['workspace']],
    ['scope', 'is_any_of', ['workspace', 'personal']],
    ['scope', 'is_none_of', ['workspace']],
    ['auto_accepted', 'is', true],
    ['auto_accepted', 'is', false],
    ['created_by', 'is', [ANA]],
    ['created_by', 'is_not', [ANA]],
    ['created_by', 'is_any_of', [ANA, BEN]],
    ['created_by', 'is_none_of', [ANA]],
    ['event_at', 'is', '2026-08-20T00:00:00Z'],
    ['event_at', 'is_not', '2026-08-20T00:00:00Z'],
    ['event_at', 'gt', '2000-01-01T00:00:00Z'],
    ['event_at', 'gte', '2000-01-01T00:00:00Z'],
    ['event_at', 'lt', '2030-01-01T00:00:00Z'],
    ['event_at', 'lte', '2030-01-01T00:00:00Z'],
    ['event_at', 'between', { from: '2000-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }],
    ['last_verified_at', 'is_not', '2026-09-10T00:00:00Z'],
    ['last_verified_at', 'lt', '2030-01-01T00:00:00Z'],
  ]

  it.each(excludesNull)('%s %s does not match the un-set row', (field, op, value) => {
    expect(
      kept([{ field: field as never, op, value: value as never }]).has('nulls'),
    ).toBe(false)
  })

  /**
   * The headline case, called out on its own because it is the one a hand-
   * written mask gets wrong: `is_not` reads as "everything that is not X", and
   * in SQL it is not — `NULL <> X` is NULL, which is not true.
   */
  it('does not let is_not sweep in the un-set rows', () => {
    expect(ids(kept([{ field: 'created_by', op: 'is_not', value: [ANA] }]))).toEqual(['other'])
    expect(ids(kept([{ field: 'confidence', op: 'is_not', value: 0.5 }]))).toEqual([
      'full',
      'other',
    ])
  })

  it('matches is_empty, and ONLY the un-set rows', () => {
    expect(ids(kept([{ field: 'confidence', op: 'is_empty' }]))).toEqual(['nulls'])
    expect(ids(kept([{ field: 'created_by', op: 'is_empty' }]))).toEqual(['nulls'])
    expect(ids(kept([{ field: 'event_at', op: 'is_empty' }]))).toEqual(['nulls'])
    expect(ids(kept([{ field: 'last_verified_at', op: 'is_empty' }]))).toEqual(['nulls'])
  })

  it('is the exact complement under is_not_empty', () => {
    expect(ids(kept([{ field: 'confidence', op: 'is_not_empty' }]))).toEqual(['full', 'other'])
    expect(ids(kept([{ field: 'event_at', op: 'is_not_empty' }]))).toEqual(['full', 'other'])
  })

  it('does not treat an unset date as 1970', () => {
    // The trap the sentinel exists for: a 0 timestamp is a REAL date, so a
    // null event_at falling through to 0 would be swept up by "before 2000"
    // — which the SQL side never does.
    const before2000 = kept([
      { field: 'event_at', op: 'lt', value: '2000-01-01T00:00:00Z' },
    ])
    expect(before2000.size).toBe(0)
  })

  it('treats text as NOT NULL, exactly as the column is declared', () => {
    // `claim.text IS NULL` matches no row in Postgres, so the mask must not
    // invent an empty-string reading and disagree with the list.
    expect(kept([{ field: 'text', op: 'is_empty' }]).size).toBe(0)
    expect(ids(kept([{ field: 'text', op: 'is_not_empty' }]))).toEqual([
      'full',
      'nulls',
      'other',
    ])
  })
})

// ─── Full text ────────────────────────────────────────────────────────────────

describe('text matches the FULL claim, not the label', () => {
  it('finds a word past the 80-character label cut-off', () => {
    expect(LONG_TEXT.indexOf('PELICAN')).toBeGreaterThan(80)
    expect(ids(kept([{ field: 'text', op: 'contains', value: 'pelican' }]))).toEqual(['full'])
  })

  it('finds it through the whole wire, not just the mask', () => {
    const parsed = parseFilters(
      new URLSearchParams({
        [FILTER_PARAM]: JSON.stringify([['text', 'contains', 'PELICAN budget']]),
      }),
    )
    expect(parsed.ok).toBe(true)
    const keep = maskClaims(map, (parsed as { filters: MapFilters }).filters)
    const matched = map.claimIds.filter((_id, c) => keep[c])
    expect(matched).toEqual(['full'])
  })

  it('still ships a SHORT label on the wire', () => {
    // Carrying the full text is a server-side decision; the renderer must not
    // start receiving 200-character strings per node because of it.
    const built = tileMap(map, { filters: {}, version: 'v', nowMs: NOW })
    const labels: string[] = []
    for (const tile of built.tiles.values()) labels.push(...tile.nodes.label)
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(80)
    expect(labels.some((l) => l.endsWith('…'))).toBe(true)
  })

  it('is case-insensitive on both sides', () => {
    expect(kept([{ field: 'text', op: 'contains', value: 'quarterly review' }]).has('full')).toBe(
      true,
    )
  })

  it('supports the other text operators', () => {
    expect(ids(kept([{ field: 'text', op: 'starts_with', value: 'claim o' }]))).toEqual(['other'])
    expect(ids(kept([{ field: 'text', op: 'ends_with', value: 'nulls' }]))).toEqual(['nulls'])
    expect(ids(kept([{ field: 'text', op: 'is', value: 'claim other' }]))).toEqual(['other'])
    expect(ids(kept([{ field: 'text', op: 'does_not_contain', value: 'claim' }]))).toEqual(['full'])
  })
})

// ─── project_ids ──────────────────────────────────────────────────────────────

describe('project is a SET, compared against a set', () => {
  it('keeps claims linked to ANY of the listed projects', () => {
    expect(ids(kept([{ field: 'project_ids', op: 'is_any_of', value: [PROJECT_1] }]))).toEqual([
      'full',
    ])
    expect(
      ids(kept([{ field: 'project_ids', op: 'is_any_of', value: [PROJECT_1, PROJECT_2] }])),
    ).toEqual(['full', 'other'])
  })

  it('does not count a claim twice when it is on several of them', () => {
    // `full` is on BOTH projects; the mask walks an adjacency list, so a naive
    // implementation could keep it once per matching link.
    const keep = maskClaims(map, {
      where: [{ field: 'project_ids', op: 'is_any_of', value: [PROJECT_1, PROJECT_2] }],
    })
    expect(keep.reduce((n, v) => n + v, 0)).toBe(2)
  })

  it('reads is_empty as "on no project at all"', () => {
    expect(ids(kept([{ field: 'project_ids', op: 'is_empty' }]))).toEqual(['nulls'])
    expect(ids(kept([{ field: 'project_ids', op: 'is_not_empty' }]))).toEqual(['full', 'other'])
  })

  it('lets a claim on NO project satisfy is_none_of', () => {
    // `project_ids` is `uuid[] NOT NULL DEFAULT '{}'`, so the empty set is a
    // value, not a null: `NOT ('{}' && ARRAY[p1])` is true in Postgres, and
    // applying the three-valued gate here would drop `nulls` for no reason.
    expect(ids(kept([{ field: 'project_ids', op: 'is_none_of', value: [PROJECT_1] }]))).toEqual([
      'nulls',
      'other',
    ])
  })

  it('matches nothing for a project that is not on this map', () => {
    expect(kept([{ field: 'project_ids', op: 'is', value: [PROJECT_UNKNOWN] }]).size).toBe(0)
    // ...and its negation matches everything, since no claim is linked to it.
    expect(ids(kept([{ field: 'project_ids', op: 'is_none_of', value: [PROJECT_UNKNOWN] }]))).toEqual(
      ['full', 'nulls', 'other'],
    )
  })

  it('does not confuse a project hub with any other hub', () => {
    // Every claim links to capture `cap-A`; if the mask matched hub adjacency
    // without checking the hub's kind, a project filter would keep them all.
    expect(kept([{ field: 'project_ids', op: 'is_empty' }]).has('full')).toBe(false)
  })
})

// ─── Numbers ──────────────────────────────────────────────────────────────────

describe('confidence compares in the column\'s own precision', () => {
  it('includes a claim whose confidence is EXACTLY the threshold', () => {
    // `claimConfidence` is a Float32Array, so 0.7 reads back as
    // 0.699999988…. Compared against the float64 literal 0.7, `gte` would
    // drop the one claim the user meant to include.
    expect(kept([{ field: 'confidence', op: 'gte', value: 0.7 }]).has('full')).toBe(true)
    expect(kept([{ field: 'confidence', op: 'lte', value: 0.7 }]).has('full')).toBe(true)
    expect(kept([{ field: 'confidence', op: 'is', value: 0.7 }]).has('full')).toBe(true)
  })

  it('still excludes the values on the other side of it', () => {
    expect(ids(kept([{ field: 'confidence', op: 'gt', value: 0.7 }]))).toEqual([])
    expect(ids(kept([{ field: 'confidence', op: 'between', value: { from: 0.4, to: 0.8 } }]))).toEqual(
      ['full'],
    )
  })

  it('a half-filled range bounds only the side that is set, like the SQL list', () => {
    // An empty `to` used to become Number('') = 0 and match nothing.
    expect(ids(kept([{ field: 'confidence', op: 'between', value: { from: 0.5, to: '' } }]))).toEqual(['full'])
    expect(ids(kept([{ field: 'confidence', op: 'between', value: { from: '', to: 0.5 } }]))).toEqual(['other'])
    expect(
      ids(kept([{ field: 'event_at', op: 'between', value: { from: '2026-08-01T00:00:00Z', to: '' } }])),
    ).toEqual(['full'])
  })
})

// ─── Enums, booleans, conjunction ─────────────────────────────────────────────

describe('the rest of the vocabulary', () => {
  it('filters by type, confirmation and scope', () => {
    expect(ids(kept([{ field: 'confirmation', op: 'is', value: ['confirmed'] }]))).toEqual(['full'])
    expect(ids(kept([{ field: 'scope', op: 'is', value: ['personal'] }]))).toEqual(['other'])
    expect(ids(kept([{ field: 'type', op: 'is_none_of', value: ['fact'] }]))).toEqual([])
  })

  it('filters by auto_accepted', () => {
    expect(ids(kept([{ field: 'auto_accepted', op: 'is', value: true }]))).toEqual(['full'])
    expect(ids(kept([{ field: 'auto_accepted', op: 'is', value: false }]))).toEqual(['other'])
  })

  it('ANDs every predicate, the way the SQL engine chains them', () => {
    expect(
      ids(
        kept([
          { field: 'confidence', op: 'gte', value: 0.2 },
          { field: 'created_by', op: 'is', value: [BEN] },
        ]),
      ),
    ).toEqual(['other'])
  })

  it('matches an author id whatever case the client wrote it in', () => {
    expect(kept([{ field: 'created_by', op: 'is', value: [ANA.toUpperCase()] }]).has('full')).toBe(
      true,
    )
  })

  it('refuses an unresolved relative window rather than ignoring it', () => {
    // `service.ts` rewrites these into a concrete `between` before tiling. One
    // arriving here means the wiring broke, and a mask that shrugged would
    // quietly draw an unfiltered map.
    expect(() =>
      maskClaims(map, {
        where: [
          {
            field: 'created_at',
            op: 'is_relative',
            value: { unit: 'day', direction: 'past', count: 30 },
          },
        ],
      }),
    ).toThrow(/is_relative/)
  })
})

// ─── What a filtered build reports ────────────────────────────────────────────

describe('counts and promote over a filtered map', () => {
  const CONFIRMED: MapFilters = {
    where: [{ field: 'confirmation', op: 'is', value: ['confirmed'] }],
  }

  it('reports totalClaims over the UNFILTERED map', () => {
    const all = tileMap(map, { filters: {}, version: 'v', nowMs: NOW })
    const filtered = tileMap(map, { filters: CONFIRMED, version: 'v', nowMs: NOW })
    expect(filtered.meta.counts.claims).toBe(1)
    // "N of M" — and how an empty filter result is told apart from an empty
    // workspace.
    expect(filtered.meta.counts.totalClaims).toBe(all.meta.counts.claims)
    expect(filtered.meta.counts.totalClaims).toBe(3)
  })

  it('lists every project of the unfiltered map, sorted by label', () => {
    const built = tileMap(map, { filters: CONFIRMED, version: 'v', nowMs: NOW })
    expect(built.meta.projects).toEqual([
      { id: PROJECT_2, label: 'Alpha' },
      { id: PROJECT_1, label: 'Zeta' },
    ])
  })

  it('orders promote by confidence desc with nulls last', () => {
    const built = tileMap(map, { filters: {}, version: 'v', nowMs: NOW })
    expect(built.meta.promote.total).toBe(3)
    expect(built.meta.promote.topClaimIds[0]).toBe('full')
    expect(built.meta.promote.topClaimIds.at(-1)).toBe('nulls')
  })

  it('keeps a hub only while it still has a matching claim', () => {
    const keysOf = (filters: MapFilters) => {
      const built = tileMap(map, { filters, version: 'v', nowMs: NOW })
      const keys = new Set<string>()
      for (const t of built.tiles.values()) for (const k of t.nodes.key) keys.add(k)
      return keys
    }
    expect(keysOf(CONFIRMED).has(`project:${PROJECT_1}`)).toBe(true)
    expect(
      keysOf({ where: [{ field: 'scope', op: 'is', value: ['personal'] }] }).has(
        `project:${PROJECT_1}`,
      ),
    ).toBe(false)
  })
})
