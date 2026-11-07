/**
 * Registration invariants for the 'eval_case' views entity.
 *
 * The suite detail page's Cases tab is a scoped `UnifiedViewLayout` — the same
 * shared views component a project's Actions tab embeds — so a case is now a
 * first-class views entity with saved views, filters, grouping and a board.
 * Modelled on eval-suite-view-registration.test.ts, plus the hidden-scope-field
 * pin prospect-entry-view-registration.test.ts introduced.
 *
 * The exhaustive `Record<ViewEntityType, …>` maps already force compile-time
 * coverage; these tests pin the CONTENT the compiler cannot check, and there
 * are three kinds of it:
 *
 *  1. ENUM LOCKSTEP against BOTH the const arrays in @/lib/evals/types AND the
 *     CHECK constraints in 252/257. views/types.ts deliberately spells its
 *     option arrays as literals rather than importing the evals consts (it is
 *     loaded by client components and the evals module is server-shaped), so
 *     nothing but these assertions stops the two from drifting — and a drifted
 *     enum is silent: the filter simply stops offering a value rows really
 *     have.
 *  2. THE READ-ONLY CONTRACT. `last_outcome` and `last_run_at` are owned by
 *     migration 257's triggers on eval_trial. An inline picker over either
 *     would write a value the next trial silently reverts, and UpdateCaseSchema
 *     does not accept them at all — so the cell would 400 and roll back.
 *     `visibility` is refused by the schema for the same reason, and `modes`
 *     is a text[] that a single-value picker would silently narrow.
 *  3. THE SCOPE FIELD. `suite_id` must be filterable (the page locks it) and
 *     must NOT be in FIELD_CATEGORIES (the user never picks it).
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
} from '@/lib/views/types'
import { applySearch, EVAL_OUTCOME_ORDER } from '@/lib/views/query-engine'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { BULK_ACTIONS } from '@/components/views/bulk-actions/types'
import { resolveEnumOptions } from '@/components/views/list/entity-row'
import {
  EVAL_CASE_VISIBILITIES,
  EVAL_MODES,
  EVAL_POLARITIES,
  EVAL_TRIAL_OUTCOMES,
} from '@/lib/evals/types'
import { UpdateCaseSchema } from '@/app/api/account/evals/schemas'

const MIGRATION_252 = readFileSync(
  join(process.cwd(), 'supabase/migrations/252_evals.sql'),
  'utf8',
)
const MIGRATION_257 = readFileSync(
  join(process.cwd(), 'supabase/migrations/257_eval_suite_scope_case_summary.sql'),
  'utf8',
)

/** The eval_case slice of 252 — from its CREATE TABLE to the next one. Scoped
 *  because `modes`, `visibility` and `status`-shaped names recur on the sibling
 *  tables in the same file, and an unscoped regex would happily match
 *  eval_trial's constraint and call it a pass. */
const EVAL_CASE_DDL = MIGRATION_252.slice(
  MIGRATION_252.indexOf('CREATE TABLE IF NOT EXISTS public.eval_case'),
  MIGRATION_252.indexOf('CREATE INDEX IF NOT EXISTS eval_case_suite_idx'),
)

function checkValues(ddl: string, column: string): string[] {
  const match = ddl.match(
    new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i'),
  )
  if (!match) throw new Error(`No CHECK (… IN …) for "${column}"`)
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/** 257 spells its constraint as `CHECK (<col> IS NULL OR <col> IN (…))`,
 *  because the column is nullable — a case nothing has ever graded. */
function nullableCheckValues(column: string): string[] {
  const match = MIGRATION_257.match(
    new RegExp(
      `CHECK\\s*\\(\\s*${column}\\s+IS\\s+NULL\\s+OR\\s+${column}\\s+IN\\s*\\(([^)]*)\\)`,
      'i',
    ),
  )
  if (!match) throw new Error(`No nullable CHECK for "${column}" in 257`)
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

const field = (name: string) =>
  FILTERABLE_FIELDS.eval_case.find((f) => f.field === name)

/** The trigger-owned columns (migration 257). Nothing may make either
 *  editable. */
const DERIVED_FIELDS = ['last_outcome', 'last_run_at']

describe('eval_case views registration', () => {
  // ── Enum lockstep: FILTERABLE_FIELDS ↔ const arrays ↔ migrations ─────────

  it('polarity options match EVAL_POLARITIES and the 252 CHECK', () => {
    expect(field('polarity')?.type).toBe('enum')
    expect(field('polarity')?.options).toEqual([...EVAL_POLARITIES])
    expect(checkValues(EVAL_CASE_DDL, 'polarity')).toEqual([...EVAL_POLARITIES])
  })

  it('visibility options match EVAL_CASE_VISIBILITIES and the 252 CHECK', () => {
    expect(field('visibility')?.options).toEqual([...EVAL_CASE_VISIBILITIES])
    expect(checkValues(EVAL_CASE_DDL, 'visibility')).toEqual([
      ...EVAL_CASE_VISIBILITIES,
    ])
  })

  it('modes options match EVAL_MODES, and it is declared as an ARRAY field', () => {
    expect(field('modes')?.options).toEqual([...EVAL_MODES])
    // `modes` is `text[] NOT NULL DEFAULT ARRAY['batch','live']` (252). Without
    // isArray, an `is`-filter would emit an eq against an array column and
    // match only cases whose modes are exactly that one value — a "Live"
    // filter would silently hide every case that runs in both.
    expect(field('modes')?.isArray).toBe(true)
    expect(EVAL_CASE_DDL).toMatch(/modes\s+text\[\]/)
  })

  it('last_outcome options match the 257 CHECK, and allow empty', () => {
    // The TRIAL vocabulary, not the run one: 'errored' is a real value of this
    // column because 257 stores it for a trial that errored or was cancelled,
    // and a harness failure is not a prompt regression.
    expect(field('last_outcome')?.options).toEqual([...EVAL_TRIAL_OUTCOMES])
    expect(nullableCheckValues('last_outcome')).toEqual([...EVAL_TRIAL_OUTCOMES])
    // NULL = no trial has settled — a real state a user filters for.
    expect(field('last_outcome')?.allowEmpty).toBe(true)
  })

  it('last_run_at is a date that allows empty', () => {
    expect(field('last_run_at')?.type).toBe('date')
    expect(field('last_run_at')?.allowEmpty).toBe(true)
  })

  it('every filterable field is a REAL column on eval_case', () => {
    // A PostgREST predicate cannot touch a derived value, so a filter on one
    // would 400 rather than return nothing. 252 declares the authoring
    // columns, 257 the two summary ones.
    const declared = `${EVAL_CASE_DDL}\n${MIGRATION_257}`
    for (const f of FILTERABLE_FIELDS.eval_case) {
      expect(declared).toContain(f.field)
    }
  })

  // ── The scope field ──────────────────────────────────────────────────────

  it('suite_id is filterable (a real column) but hidden from the filter picker', () => {
    // It is the fixed scope the suite detail page locks, not a filter a user
    // picks — the same deliberate treatment prospect_list_entry's `list_id`
    // gets, and for the same reason.
    expect(field('suite_id')).toBeDefined()
    expect(EVAL_CASE_DDL).toMatch(/suite_id\s+uuid NOT NULL REFERENCES public\.eval_suite/)
    for (const category of FIELD_CATEGORIES.eval_case) {
      expect(category.fields).not.toContain('suite_id')
    }
  })

  // ── Board ────────────────────────────────────────────────────────────────

  it('board group-by is last_outcome, and it is filterable', () => {
    expect(DEFAULT_BOARD_GROUP_BY.eval_case).toBe('last_outcome')
    expect(FILTERABLE_FIELDS.eval_case.some((f) => f.field === 'last_outcome')).toBe(true)
  })

  it('the injected board columns are exactly the outcomes a case can hold', () => {
    // The case column carries the full TRIAL vocabulary, 'errored' included —
    // unlike eval_run.outcome, which the run registration pins as narrower.
    expect(Object.keys(EVAL_OUTCOME_ORDER).sort()).toEqual([...EVAL_TRIAL_OUTCOMES].sort())
  })

  // ── Display properties ───────────────────────────────────────────────────

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.eval_case.map((d) => d.field))
    for (const f of DEFAULT_DISPLAY_PROPERTIES.eval_case) {
      expect(declared.has(f)).toBe(true)
    }
  })

  it('no eval_case display property is scope-only, so defaults are scope-free', () => {
    // Unlike sequences' `enrollment`, nothing here is merged only under a
    // scope — a case row inside a suite carries the same columns a global list
    // would, so locking `suite_id` must not change the defaults.
    for (const d of DISPLAY_PROPERTIES.eval_case) {
      expect(d.scopeOnly).toBeUndefined()
    }
    expect(defaultDisplayProperties('eval_case', new Set(['suite_id']))).toEqual(
      DEFAULT_DISPLAY_PROPERTIES.eval_case,
    )
  })

  it('the trigger-owned summary columns are NEVER inline-editable', () => {
    for (const f of DERIVED_FIELDS) {
      const d = DISPLAY_PROPERTIES.eval_case.find((x) => x.field === f)
      expect(d?.editable).toBeUndefined()
    }
  })

  it('polarity is the ONLY editable cell, and the PATCH route accepts it', () => {
    const editable = DISPLAY_PROPERTIES.eval_case.filter((d) => d.editable)
    expect(editable.map((d) => d.field)).toEqual(['polarity'])
    expect(editable[0].editable).toEqual({ picker: 'enum', apiField: 'polarity' })
    // The picker writes `polarity`; the route must take it or the cell 400s.
    expect(UpdateCaseSchema.safeParse({ polarity: 'negative' }).success).toBe(true)
    // Declaring the descriptor is not enough: renderEditableCell's `case
    // 'enum'` resolves options through entity-row's resolveEnumOptions and
    // silently falls back to a read-only chip when that switch has no case for
    // the field. Registering the descriptor without registering the options is
    // the exact shape of the original bug.
    expect(resolveEnumOptions('polarity').options.map((o) => o.value)).toEqual([
      ...EVAL_POLARITIES,
    ])
  })

  it('every picker:enum descriptor in the registry resolves to real options', () => {
    // Entity-wide, not just eval_case: the silent read-only fallback is
    // available to any entity whose descriptor outruns resolveEnumOptions.
    for (const [entityType, descriptors] of Object.entries(DISPLAY_PROPERTIES)) {
      for (const d of descriptors) {
        if (d.editable?.picker !== 'enum') continue
        // renderEditableCell resolves on the DISPLAY field, not apiField.
        expect(
          resolveEnumOptions(d.field).options.length,
          `${entityType}.${d.field} declares an enum picker with no options`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('visibility is read-only because UpdateCaseSchema refuses it outright', () => {
    // This is the sharper half of the read-only contract: `visibility` is a
    // plain two-value enum that LOOKS as editable as polarity, and the only
    // thing saying otherwise is the schema.
    expect(UpdateCaseSchema.safeParse({ visibility: 'private' }).success).toBe(false)
    expect(
      DISPLAY_PROPERTIES.eval_case.find((d) => d.field === 'visibility')?.editable,
    ).toBeUndefined()
  })

  it('modes stays read-only even though the schema accepts it — a picker writes ONE value', () => {
    // UpdateCaseSchema DOES take `modes`, so the schema alone would not stop a
    // picker here. What stops it is the shape: `modes` is an array and the
    // generic enum cell writes a scalar, so a drop or a pick would narrow a
    // batch+live case to one mode without saying so.
    expect(UpdateCaseSchema.safeParse({ modes: ['batch'] }).success).toBe(true)
    expect(
      DISPLAY_PROPERTIES.eval_case.find((d) => d.field === 'modes')?.editable,
    ).toBeUndefined()
  })

  it('refuses the derived fields, so neither cell could have been editable', () => {
    for (const f of DERIVED_FIELDS.concat('suite_id')) {
      expect(UpdateCaseSchema.safeParse({ [f]: 1 }).success).toBe(false)
    }
  })

  // ── The created_by trap ──────────────────────────────────────────────────

  it('declares no Creator filter — created_by is auth.users-backed, the member picker is not', () => {
    // eval_case.created_by (migration 252) references auth.users(id), while the
    // shared 'member'-typed filter picker emits member.id — a disjoint UUID
    // space — so a Creator filter would silently match zero rows for every
    // possible selection. The same deliberate omission as eval_suite,
    // sequence and flow.
    expect(EVAL_CASE_DDL).toMatch(/created_by\s+uuid REFERENCES auth\.users \(id\)/)
    expect(FILTERABLE_FIELDS.eval_case.some((f) => f.field === 'created_by')).toBe(false)
    for (const category of FIELD_CATEGORIES.eval_case) {
      expect(category.fields).not.toContain('created_by')
    }
  })

  // ── Registries ───────────────────────────────────────────────────────────

  it('every categorized filter field is a declared filterable field', () => {
    const filterable = new Set(FILTERABLE_FIELDS.eval_case.map((f) => f.field))
    for (const category of FIELD_CATEGORIES.eval_case) {
      for (const f of category.fields) {
        expect(filterable.has(f)).toBe(true)
      }
    }
  })

  it('single-record endpoint targets the evals cases API', () => {
    expect(ENTITY_ENDPOINTS.eval_case('abc')).toBe('/api/account/evals/cases/abc')
  })

  it('the only bulk action is delete — a case has no archived state', () => {
    expect(BULK_ACTIONS.eval_case.map((a) => a.id)).toEqual(['delete'])
    expect(BULK_ACTIONS.eval_case[0].destructive).toBe(true)
  })

  it('search applies ilike on name', () => {
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'eval_case', 'stalls')
    expect(q.ilike).toHaveBeenCalledWith('name', '%stalls%')
    expect(q.or).not.toHaveBeenCalled()
  })
})
