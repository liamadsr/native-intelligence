/**
 * Registration invariants for the 'prospect_list' views entity — the list of
 * PROSPECT LISTS that replaced the bespoke card index.
 *
 * Ported from prospect-entry-view-registration.test.ts one level down. The
 * exhaustive Record<ViewEntityType, …> maps already force compile-time
 * coverage; these tests pin the CONTENT the compiler cannot check: enum
 * options in lockstep with BOTH the const arrays in @/lib/prospecting/types
 * AND the migrations' CHECK constraints, the archived-by-default contract,
 * board grouping wired to a field a drag can actually write, and the two
 * VIRTUAL last-run fields being filterable-but-not-sortable.
 *
 * The enum-lockstep half is the load-bearing part. types.ts deliberately
 * spells its option arrays as literals rather than importing the prospecting
 * consts (it is loaded by client components and the prospecting module is
 * server-shaped), so nothing but these assertions stops the two from drifting
 * — and a drifted enum is silent: the filter simply stops offering a value
 * that rows really have.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_BOARD_GROUP_BY,
  DEFAULT_DISPLAY_PROPERTIES,
  defaultDisplayProperties,
  DISPLAY_PROPERTIES,
  FIELD_CATEGORIES,
  FILTERABLE_FIELDS,
  OPERATORS_BY_TYPE,
  defaultOrdering,
} from '@/lib/views/types'
import { applySearch } from '@/lib/views/query-engine'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { BULK_ACTIONS } from '@/components/views/bulk-actions/types'
import {
  PROSPECTING_RUN_KINDS,
  PROSPECTING_RUN_STATUSES,
  PROSPECT_EXCLUDE_CONTACTED,
  PROSPECT_LIST_PURPOSES,
  PROSPECT_LIST_STATUSES,
  PROSPECT_PURPOSE_LABELS,
} from '@/lib/prospecting/types'

const MIGRATION_248 = readFileSync(
  join(process.cwd(), 'supabase/migrations/248_prospecting.sql'),
  'utf8',
)
const MIGRATION_255 = readFileSync(
  join(process.cwd(), 'supabase/migrations/255_prospect_list_view_enum.sql'),
  'utf8',
)

/**
 * Pull the value list out of `CHECK (<column> IN ('a','b',…))` in 248.
 * `occurrence` picks between tables that share a column name — `status` is on
 * prospect_list (declared first), prospect_list_entry and prospecting_run.
 */
function checkValues(column: string, occurrence = 0): string[] {
  const all = [
    ...MIGRATION_248.matchAll(
      new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'gi'),
    ),
  ].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]))
  if (all.length <= occurrence) {
    throw new Error(`No CHECK (${column} IN …) #${occurrence} in 248_prospecting.sql`)
  }
  return all[occurrence]
}

const field = (name: string) => FILTERABLE_FIELDS.prospect_list.find((f) => f.field === name)

describe('prospect_list views registration', () => {
  // ── The migration that makes any of this legal ────────────────────────────

  it('migration 255 adds the enum value, alone', () => {
    // GET /api/account/views?entity_type=prospect_list filters the `view`
    // table on view_entity_type; without the value that query 500s and saving
    // a view over the list index fails.
    expect(MIGRATION_255).toMatch(
      /ALTER TYPE public\.view_entity_type ADD VALUE IF NOT EXISTS 'prospect_list';/,
    )
    // ALTER TYPE … ADD VALUE cannot share a transaction with anything else.
    const statements = MIGRATION_255
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
      .join(' ')
      .split(';')
      .filter((x) => x.trim() !== '')
    expect(statements).toHaveLength(1)
  })

  it('the migration says out loud that it reverses 249', () => {
    // 249 wrote "`prospect_list` itself is deliberately NOT registered". A
    // future reader finding both files must be able to tell that this was a
    // decision, not an oversight being papered over.
    expect(MIGRATION_255).toMatch(/249/)
    expect(MIGRATION_255.toLowerCase()).toMatch(/reverses|deliberately not registered/)
  })

  // ── Enum lockstep: FILTERABLE_FIELDS ↔ const arrays ↔ migration 248 ───────

  it('purpose options match PROSPECT_LIST_PURPOSES and the DB CHECK, in order', () => {
    const purpose = field('purpose')
    expect(purpose?.type).toBe('enum')
    expect(purpose?.options).toEqual([...PROSPECT_LIST_PURPOSES])
    expect(checkValues('purpose')).toEqual([...PROSPECT_LIST_PURPOSES])
  })

  it('status options match PROSPECT_LIST_STATUSES and the DB CHECK', () => {
    expect(field('status')?.options).toEqual([...PROSPECT_LIST_STATUSES])
    // First `status IN` in 248 is prospect_list's (the table is declared first).
    expect(checkValues('status')).toEqual([...PROSPECT_LIST_STATUSES])
  })

  it('status is NOT allowEmpty — NOT NULL with a default in 248', () => {
    // An "is empty" option would name a state no row can be in.
    expect(field('status')?.allowEmpty).toBeUndefined()
  })

  it('exclude_contacted options match the const and the DB CHECK', () => {
    expect(field('exclude_contacted')?.options).toEqual([...PROSPECT_EXCLUDE_CONTACTED])
    expect(checkValues('exclude_contacted')).toEqual([...PROSPECT_EXCLUDE_CONTACTED])
  })

  it('last_run_status options match PROSPECTING_RUN_STATUSES and the run CHECK', () => {
    // The run vocabulary, not the flow one: 'budget_exhausted' is in it and
    // 'pending' is not.
    expect(field('last_run_status')?.options).toEqual([...PROSPECTING_RUN_STATUSES])
    // prospecting_run.status is the SECOND `status IN` CHECK in 248
    // (prospect_list first, prospect_list_entry has `stage` not `status`).
    expect(checkValues('status', 1)).toEqual([...PROSPECTING_RUN_STATUSES])
    expect(field('last_run_status')?.options).toContain('budget_exhausted')
  })

  it('last_run_kind options match PROSPECTING_RUN_KINDS and the run CHECK', () => {
    expect(field('last_run_kind')?.options).toEqual([...PROSPECTING_RUN_KINDS])
    // prospecting_run.kind is the SECOND `kind IN` CHECK in 248 —
    // prospect_list_entry.kind (company/person) is declared first.
    expect(checkValues('kind', 1)).toEqual([...PROSPECTING_RUN_KINDS])
  })

  // ── Virtual fields ───────────────────────────────────────────────────────

  it('both last-run fields are marked virtual — filterable, never sortable', () => {
    // They live on the embedded newest prospecting_run, not on prospect_list.
    // PostgREST's `order` takes a column of the QUERIED table, so
    // `.order('last_run_status')` is a 400. The sort picker reads this flag.
    for (const name of ['last_run_status', 'last_run_kind']) {
      expect(field(name)?.virtual, `${name} must be virtual`).toBe(true)
      expect(field(name)?.allowEmpty, `${name} must allow "never run"`).toBe(true)
    }
  })

  it('no NON-virtual filterable field is missing from the real column set', () => {
    // Every non-virtual field must be a column applyColumnFilter can eq() —
    // a typo here is silent (PostgREST 400s at request time, not build time).
    const columns = new Set([
      'name', 'description', 'purpose', 'icp_version', 'source_company_id',
      'exclude_crm', 'exclude_other_lists', 'exclude_contacted',
      'max_spend_dollars', 'target_new_candidates', 'max_rounds',
      'people_per_company', 'status', 'created_by', 'created_at', 'updated_at',
    ])
    for (const f of FILTERABLE_FIELDS.prospect_list) {
      if (f.virtual) continue
      expect(columns.has(f.field), `"${f.field}" is not a prospect_list column`).toBe(true)
    }
  })

  it('enum fields carry both is and is_not — the archived escape hatch needs it', () => {
    // "Show me everything except archived" is `status is_not archived`, and
    // that filter must also count as an EXPLICIT status filter (it does — the
    // default keys off the FIELD, not the operator; see the select test).
    expect(field('status')?.type).toBe('enum')
    expect(OPERATORS_BY_TYPE.enum).toContain('is')
    expect(OPERATORS_BY_TYPE.enum).toContain('is_not')
  })

  // ── Board ────────────────────────────────────────────────────────────────

  it('board group-by is purpose — the one grouping a drag can write', () => {
    // A board drag PATCHes the group-by field. PATCH
    // /api/account/prospecting/lists/[id] takes `purpose` (updateList →
    // asPurpose), so every column is a legal destination. `status` is still in
    // the picker but the default query hides archived rows, so that board
    // opens with exactly one column.
    expect(DEFAULT_BOARD_GROUP_BY.prospect_list).toBe('purpose')
    expect(field('purpose')).toBeDefined()
  })

  it('the purpose column labels match PROSPECT_PURPOSE_LABELS', () => {
    // query-engine spells them as a literal (it must not import the
    // server-shaped prospecting module); this is what stops the drift. Note
    // buyers → "Customers": the column says who they are to you.
    const engine = readFileSync(join(process.cwd(), 'src/lib/views/query-engine.ts'), 'utf8')
    const block = engine.match(/PROSPECT_PURPOSE_GROUP_LABELS[^{]*\{([^}]*)\}/)
    expect(block).toBeTruthy()
    const pairs = Object.fromEntries(
      [...block![1].matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]),
    )
    expect(pairs).toEqual(PROSPECT_PURPOSE_LABELS)
  })

  // ── Display properties ───────────────────────────────────────────────────

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.prospect_list.map((d) => d.field))
    for (const f of DEFAULT_DISPLAY_PROPERTIES.prospect_list) {
      expect(declared.has(f), `default "${f}" is not a declared display property`).toBe(true)
    }
  })

  it('defaults are what a list IS: purpose, size, saved, last run', () => {
    expect(DEFAULT_DISPLAY_PROPERTIES.prospect_list).toEqual([
      'purpose', 'candidates', 'saved', 'last_run',
    ])
    // `status` stays OFF by default: the query hides archived lists, so the
    // column would read "active" on every row it could ever render.
    expect(DEFAULT_DISPLAY_PROPERTIES.prospect_list).not.toContain('status')
    // …but it is still offered, which is what makes this a default and not a
    // removal.
    expect(DISPLAY_PROPERTIES.prospect_list.map((d) => d.field)).toContain('status')
  })

  it('NOTHING is inline-editable — purpose re-seeds the ICP, archive is destructive', () => {
    // Both LOOK like enum cells the generic picker could edit. A purpose change
    // re-seeds the ICP draft and the angle templates the next run uses, and
    // archiving is the verb the DELETE route maps to — neither is a thing to
    // flip by mis-clicking a dropdown in a row.
    const editable = DISPLAY_PROPERTIES.prospect_list.filter((d) => d.editable)
    expect(editable.map((d) => d.field)).toEqual([])
  })

  it('declares no scope-only display property — the index is never scoped', () => {
    for (const d of DISPLAY_PROPERTIES.prospect_list) expect(d.scopeOnly).toBeUndefined()
    expect(defaultDisplayProperties('prospect_list', new Set())).toEqual(
      DEFAULT_DISPLAY_PROPERTIES.prospect_list,
    )
  })

  // ── Filter picker categories ─────────────────────────────────────────────

  it('every categorized filter field is a declared filterable field', () => {
    const filterable = new Set(FILTERABLE_FIELDS.prospect_list.map((f) => f.field))
    for (const category of FIELD_CATEGORIES.prospect_list) {
      for (const f of category.fields) {
        expect(filterable.has(f), `category names unknown field "${f}"`).toBe(true)
      }
    }
  })

  it('every filterable field is offered in the picker — nothing is a scope here', () => {
    // Unlike prospect_list_entry (whose `list_id` is a locked scope), the list
    // index has no hidden scope field: it is the top-level, unscoped view.
    const categorized = new Set(FIELD_CATEGORIES.prospect_list.flatMap((c) => c.fields))
    for (const f of FILTERABLE_FIELDS.prospect_list) {
      expect(categorized.has(f.field), `"${f.field}" is filterable but not in the picker`).toBe(true)
    }
  })

  // ── Endpoint + search + bulk ─────────────────────────────────────────────

  it('single-record endpoint targets the prospecting lists API', () => {
    expect(ENTITY_ENDPOINTS.prospect_list('abc')).toBe('/api/account/prospecting/lists/abc')
  })

  it('search covers name AND description', () => {
    // The description is the prose ICP seed the user typed, which is the half
    // of the row they are most likely to remember.
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'prospect_list', 'fintech')
    expect(q.or).toHaveBeenCalledWith('name.ilike.%fintech%,description.ilike.%fintech%')
    expect(q.ilike).not.toHaveBeenCalled()
  })

  it('offers Delete, and only Delete, as a bulk action', () => {
    // Liam, 2026-09-06: "from the main lists page with the bulk actions there
    // should be a delete option". Destructive, so the bar treats it as such —
    // and unified-view-layout intercepts it into ProspectListDeleteDialog,
    // which owns the sentence about what goes (the list, its candidates and
    // runs — the entries WERE the suppression record, so dismissed candidates
    // may be found again) and what stays (CRM records only leave the group).
    // Each list goes through its own DELETE route, never the generic bulk
    // endpoint.
    //
    // `archive` is still absent because the GENERIC bulk endpoint writes
    // `is_archived = true`, a column prospect_list does not have (it has
    // `status`, with a CHECK). Registering it would render a control that 400s
    // on every selection.
    expect(BULK_ACTIONS.prospect_list).toEqual([
      { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
    ])
  })

  it('opens sorted by most recently touched, not by creation date', () => {
    // A list is a WORKING SURFACE that is run again and again, not a record
    // filed once — so the list you touched last belongs at the top, and
    // `created_at` would sink a list you use weekly under lists you made and
    // forgot. `updated_at` is on the table and bumps on every PATCH.
    expect(defaultOrdering('prospect_list')).toEqual([
      { field: 'updated_at', direction: 'desc' },
    ])
    // The exception is named, not universal: everything else is a feed and
    // keeps the newest-first fallback.
    expect(defaultOrdering('contact')).toEqual([
      { field: 'created_at', direction: 'desc' },
    ])
    // And it is a real sort, not a virtual one — the ordering guard would drop
    // it silently if it were.
    expect(
      FILTERABLE_FIELDS.prospect_list.find((f) => f.field === 'updated_at')?.virtual ?? false,
    ).toBe(false)
  })
})
