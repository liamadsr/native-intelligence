/**
 * Registration guards for `claim` as a view entity type.
 *
 * Most of the contract is enforced by TypeScript: the dozen
 * `Record<ViewEntityType, …>` maps do not compile with a member missing. What
 * they cannot check is whether the values are RIGHT — that a filter offers the
 * values the database actually stores, that an endpoint exists, that a bulk
 * action the UI lists is one the bulk route can execute. Those are the gaps.
 *
 * The most important test in this file is the last one. A claim view can be
 * drawn as a list, a board, or the WebGL knowledge map, and the list and the
 * map are two entirely separate engines — SQL on one side, an in-memory bitmask
 * on the other. They must agree on WHICH CLAIMS EXIST, or flipping the layout
 * toggle silently changes the answer with no visible difference in the chrome.
 * That agreement is two predicates in two files, and nothing but this test ties
 * them together.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BOARD_GROUP_BY,
  DEFAULT_DISPLAY_PROPERTIES,
  DISPLAY_PROPERTIES,
  FIELD_CATEGORIES,
  FILTERABLE_FIELDS,
  defaultLayout,
} from '@/lib/views/types'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { BULK_ACTIONS } from '@/components/views/bulk-actions/types'

const ROOT = process.cwd()
const MIGRATION_109 = readFileSync(join(ROOT, 'supabase/migrations/109_claims_and_entity_links.sql'), 'utf8')
const MIGRATION_117 = readFileSync(join(ROOT, 'supabase/migrations/117_smart_capture.sql'), 'utf8')
const BULK_ROUTE = readFileSync(join(ROOT, 'src/app/api/account/bulk/route.ts'), 'utf8')
const QUERY_ENGINE = readFileSync(join(ROOT, 'src/lib/views/query-engine.ts'), 'utf8')
const GRAPH_BUILD = readFileSync(join(ROOT, 'src/lib/knowledge/graph-map/graph-build.ts'), 'utf8')

/** The values a `CHECK (col IN (...))` constraint allows, from the DDL. */
function checkValues(ddl: string, column: string): string[] {
  const match = ddl.match(new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i'))
  if (!match) return []
  return match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

const field = (name: string) => FILTERABLE_FIELDS.claim.find((f) => f.field === name)

describe('claim filter fields mirror the database', () => {
  it('type offers exactly the values the CHECK constraint allows', () => {
    const dbValues = checkValues(MIGRATION_109, 'type')
    expect(dbValues.length).toBeGreaterThan(0)
    expect((field('type')?.options as string[]).slice().sort()).toEqual(dbValues.slice().sort())
  })

  it('scope offers exactly the values its CHECK constraint allows', () => {
    const dbValues = checkValues(MIGRATION_117, 'scope')
    expect(dbValues.length).toBeGreaterThan(0)
    expect((field('scope')?.options as string[]).slice().sort()).toEqual(dbValues.slice().sort())
  })

  it('confirmation offers the two live states and NOT dismissed', () => {
    const dbValues = checkValues(MIGRATION_109, 'confirmation')
    expect(dbValues.slice().sort()).toEqual(['confirmed', 'dismissed', 'suggested'])
    // `dismissed` is deliberately absent: a dismissed claim is outside the
    // knowledge universe (see the boundary test below), so a filter for it
    // could only ever return nothing.
    expect((field('confirmation')?.options as string[]).slice().sort()).toEqual(['confirmed', 'suggested'])
  })

  it('does NOT offer status — it is the universe boundary, not a filter', () => {
    expect(field('status')).toBeUndefined()
  })

  it('offers project as the denormalized ARRAY column, not a scalar', () => {
    // A claim can sit on several projects. Filtering a uuid[] with `eq` would
    // match only claims whose ONLY project is that one, silently hiding every
    // claim that also touches another.
    expect(field('project_ids')?.isArray).toBe(true)
    expect(field('project_id')).toBeUndefined()
  })
})

describe('registration', () => {
  it('opens on the knowledge map, not a list of sentences', () => {
    expect(defaultLayout('claim')).toBe('graph')
  })

  it('every categorized field is a real filterable field', () => {
    const known = new Set(FILTERABLE_FIELDS.claim.map((f) => f.field))
    for (const group of FIELD_CATEGORIES.claim) {
      for (const f of group.fields) {
        expect(known.has(f), `FIELD_CATEGORIES.claim lists “${f}”, which is not a filterable field`).toBe(true)
      }
    }
  })

  it('every default display property is a declared display property', () => {
    const known = new Set(DISPLAY_PROPERTIES.claim.map((p) => p.field))
    for (const p of DEFAULT_DISPLAY_PROPERTIES.claim) {
      expect(known.has(p), `${p} is a default but not a declared display property`).toBe(true)
    }
  })

  it('boards group by the one field a person can actually set', () => {
    // Grouping a board by an extraction output (type, confidence) makes a board
    // whose every drag must be refused. `confirmation` is the only writable
    // field, which turns the claim board into the review queue.
    const groupBy = DEFAULT_BOARD_GROUP_BY.claim
    expect(groupBy).toBe('confirmation')
    const editable = DISPLAY_PROPERTIES.claim.filter((p) => p.editable).map((p) => p.field)
    expect(editable).toEqual([groupBy])
  })

  it('points inline edits and board drags at a route that exists and takes confirmation', () => {
    const endpoint = ENTITY_ENDPOINTS.claim('abc')
    expect(endpoint).toBe('/api/account/claims/abc')
    const route = readFileSync(join(ROOT, 'src/app/api/account/claims/[id]/route.ts'), 'utf8')
    expect(route).toMatch(/export async function PATCH/)
    // The editable cell writes `confirmation`; if the route refused it the cell
    // would 400 and roll back after an optimistic update.
    expect(route).toMatch(/confirmation/)
  })

  it('lists only bulk actions the bulk route can execute', () => {
    expect(BULK_ACTIONS.claim.length).toBeGreaterThan(0)
    for (const action of BULK_ACTIONS.claim) {
      expect(
        BULK_ROUTE.includes(`case '${action.id}'`),
        `BULK_ACTIONS.claim offers “${action.id}” but /api/account/bulk has no case for it`,
      ).toBe(true)
    }
    // And the route must know which table to write.
    expect(BULK_ROUTE).toMatch(/claim: 'claim'/)
  })

  it('offers no bulk delete — a claim is dismissed, never deleted', () => {
    expect(BULK_ACTIONS.claim.map((a) => a.id)).not.toContain('delete')
  })
})

describe('THE UNIVERSE BOUNDARY — the list and the map must hold the same claims', () => {
  it('the SQL query applies exactly the predicate the map bakes into its layout', () => {
    // The map's side: graph-build decides which source rows become nodes at
    // all. A claim excluded here has no position on the canvas and cannot be
    // filtered back in, because positions come from the visible set.
    expect(GRAPH_BUILD).toMatch(/status === 'active'/)
    expect(GRAPH_BUILD).toMatch(/confirmation !== 'dismissed'/)

    // The SQL side: the same two predicates, pinned in buildEntityQuery's claim
    // case where no user filter can clear them.
    const claimCase = QUERY_ENGINE.slice(QUERY_ENGINE.indexOf("case 'claim':"))
    expect(claimCase).toMatch(/\.eq\('status', 'active'\)/)
    expect(claimCase).toMatch(/\.neq\('confirmation', 'dismissed'\)/)
  })
})
