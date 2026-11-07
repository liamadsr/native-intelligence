/**
 * Registration invariants for the 'eval_suite' views entity.
 *
 * Ported from sequence-view-registration.test.ts, with the migration-text
 * lockstep prospect-entry-view-registration.test.ts introduced. The exhaustive
 * `Record<ViewEntityType, …>` maps already force compile-time coverage; these
 * tests pin the CONTENT the compiler cannot check.
 *
 * The lockstep assertions are the load-bearing ones, and they run against BOTH
 * the const arrays in @/lib/evals/types AND the CHECK constraints in 252/255.
 * views/types.ts deliberately spells its option arrays as literals rather than
 * importing the evals consts (it is loaded by client components and the evals
 * module is server-shaped), so nothing but these assertions stops the two from
 * drifting — and a drifted enum is silent: the filter simply stops offering a
 * value that rows really have.
 *
 * The other half is the READ-ONLY contract. `case_count`, `last_run_at`,
 * `last_run_mode` and `last_outcome` are owned by migration 255's triggers on
 * eval_case and eval_run. An inline picker over any of them would write a
 * value the next child-table change silently reverts, and the suites PATCH
 * route does not accept them at all — so it would 400 and roll the cell back.
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
import {
  applySearch,
  EVAL_OUTCOME_LABELS,
  EVAL_OUTCOME_ORDER,
} from '@/lib/views/query-engine'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { BULK_ACTIONS } from '@/components/views/bulk-actions/types'
import {
  EVAL_MODES,
  EVAL_SUITE_KINDS,
  EVAL_TARGET_KINDS,
  EVAL_TRIAL_OUTCOMES,
} from '@/lib/evals/types'
import { OUTCOME_LABELS } from '@/app/account/(dashboard)/evals/ui-helpers'
import { UpdateSuiteSchema } from '@/app/api/account/evals/schemas'

const MIGRATION_252 = readFileSync(
  join(process.cwd(), 'supabase/migrations/252_evals.sql'),
  'utf8',
)
const MIGRATION_255 = readFileSync(
  join(process.cwd(), 'supabase/migrations/255_eval_suite_summary.sql'),
  'utf8',
)

/** Pull the value list out of `CHECK (<column> IN ('a','b',…))` in 252. The
 *  eval_suite table is declared first, so the first match is its constraint. */
function checkValues(column: string): string[] {
  const match = MIGRATION_252.match(
    new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i'),
  )
  if (!match) throw new Error(`No CHECK (… IN …) for "${column}" in 252_evals.sql`)
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/** 255 spells its two constraints as `CHECK (<col> IS NULL OR <col> IN (…))`,
 *  because both columns are nullable — a suite that has never run. */
function nullableCheckValues(column: string): string[] {
  const match = MIGRATION_255.match(
    new RegExp(
      `CHECK\\s*\\(\\s*${column}\\s+IS\\s+NULL\\s+OR\\s+${column}\\s+IN\\s*\\(([^)]*)\\)`,
      'i',
    ),
  )
  if (!match) throw new Error(`No nullable CHECK for "${column}" in 255_eval_suite_summary.sql`)
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

const field = (name: string) => FILTERABLE_FIELDS.eval_suite.find((f) => f.field === name)

/** The trigger-owned columns. Nothing may make any of these editable. */
const DERIVED_FIELDS = ['case_count', 'last_run_at', 'last_run_mode', 'last_outcome']

describe('eval_suite views registration', () => {
  // ── Enum lockstep: FILTERABLE_FIELDS ↔ const arrays ↔ migrations ─────────

  it('target_kind options match EVAL_TARGET_KINDS and the 252 CHECK', () => {
    expect(field('target_kind')?.type).toBe('enum')
    expect(field('target_kind')?.options).toEqual([...EVAL_TARGET_KINDS])
    expect(checkValues('target_kind')).toEqual([...EVAL_TARGET_KINDS])
  })

  it('suite_kind options match EVAL_SUITE_KINDS and the 252 CHECK', () => {
    expect(field('suite_kind')?.options).toEqual([...EVAL_SUITE_KINDS])
    expect(checkValues('suite_kind')).toEqual([...EVAL_SUITE_KINDS])
  })

  it('last_outcome options match the 255 CHECK, and allow empty', () => {
    // 'errored' is part of this column and NOT of EVAL_RUN_OUTCOMES: 255 stores
    // it for a run that failed or was cancelled, because a harness failure is
    // not a prompt regression. EVAL_TRIAL_OUTCOMES is the union that includes
    // it, and it is the vocabulary the chip already draws.
    expect(field('last_outcome')?.options).toEqual([...EVAL_TRIAL_OUTCOMES])
    expect(nullableCheckValues('last_outcome')).toEqual([...EVAL_TRIAL_OUTCOMES])
    // NULL = never settled, a real state a user filters for.
    expect(field('last_outcome')?.allowEmpty).toBe(true)
  })

  it('last_run_mode options match EVAL_MODES and the 255 CHECK, and allow empty', () => {
    expect(field('last_run_mode')?.options).toEqual([...EVAL_MODES])
    expect(nullableCheckValues('last_run_mode')).toEqual([...EVAL_MODES])
    expect(field('last_run_mode')?.allowEmpty).toBe(true)
  })

  it('the date and number summary filters are typed for their columns', () => {
    expect(field('last_run_at')?.type).toBe('date')
    expect(field('last_run_at')?.allowEmpty).toBe(true)
    expect(field('case_count')?.type).toBe('number')
    expect(field('judge_model')?.type).toBe('text')
    expect(field('judge_model')?.allowEmpty).toBe(true)
  })

  it('every filterable field is a REAL column on eval_suite', () => {
    // The whole point of migration 255: a PostgREST predicate cannot touch a
    // derived value, so a filter on one would 400 rather than return nothing.
    // 252 declares the base columns, 255 the three summary ones.
    const declared = `${MIGRATION_252}\n${MIGRATION_255}`
    for (const f of FILTERABLE_FIELDS.eval_suite) {
      expect(declared).toContain(f.field)
    }
  })

  // ── Board ────────────────────────────────────────────────────────────────

  it('board group-by is last_outcome, and it is filterable', () => {
    expect(DEFAULT_BOARD_GROUP_BY.eval_suite).toBe('last_outcome')
    expect(FILTERABLE_FIELDS.eval_suite.some((f) => f.field === 'last_outcome')).toBe(true)
  })

  it('board column injection covers every outcome, best → worst with errored last', () => {
    expect(Object.keys(EVAL_OUTCOME_ORDER)).toEqual(['passed', 'scored', 'failed', 'errored'])
    // Sorting the keys by their declared order reproduces the same sequence,
    // so the route's sort and this list cannot disagree.
    const sorted = Object.keys(EVAL_OUTCOME_ORDER).sort(
      (a, b) => EVAL_OUTCOME_ORDER[a] - EVAL_OUTCOME_ORDER[b],
    )
    expect(sorted).toEqual(['passed', 'scored', 'failed', 'errored'])
    // Every filterable option gets a column.
    expect(Object.keys(EVAL_OUTCOME_ORDER).sort()).toEqual([...EVAL_TRIAL_OUTCOMES].sort())
  })

  it('board labels agree with the chip vocabulary the other Evals screens use', () => {
    // query-engine is server-side and cannot import the client ui-helpers, so
    // the labels are spelled twice. This is what stops them drifting.
    for (const outcome of EVAL_TRIAL_OUTCOMES) {
      expect(EVAL_OUTCOME_LABELS[outcome]).toBe(OUTCOME_LABELS[outcome])
    }
  })

  // ── Display properties ───────────────────────────────────────────────────

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.eval_suite.map((d) => d.field))
    for (const f of DEFAULT_DISPLAY_PROPERTIES.eval_suite) {
      expect(declared.has(f)).toBe(true)
    }
  })

  it('no eval_suite display property is scope-only, so defaults are scope-free', () => {
    for (const d of DISPLAY_PROPERTIES.eval_suite) {
      expect(d.scopeOnly).toBeUndefined()
    }
    expect(defaultDisplayProperties('eval_suite')).toEqual(
      DEFAULT_DISPLAY_PROPERTIES.eval_suite,
    )
  })

  it('the trigger-owned summary columns are NEVER inline-editable', () => {
    for (const f of DERIVED_FIELDS) {
      const d = DISPLAY_PROPERTIES.eval_suite.find((x) => x.field === f)
      expect(d?.editable).toBeUndefined()
    }
  })

  it('suite_kind is the ONLY editable cell, and the PATCH route accepts it', () => {
    const editable = DISPLAY_PROPERTIES.eval_suite.filter((d) => d.editable)
    expect(editable.map((d) => d.field)).toEqual(['suite_kind'])
    expect(editable[0].editable).toEqual({ picker: 'enum', apiField: 'suite_kind' })
    // The picker writes `suite_kind`; the route must take it or the cell 400s.
    expect(UpdateSuiteSchema.safeParse({ suite_kind: 'regression' }).success).toBe(true)
    // …and must refuse the fields the derived cells would have written, which
    // is the second reason none of them may be editable.
    for (const f of DERIVED_FIELDS.concat('target_kind')) {
      expect(UpdateSuiteSchema.safeParse({ [f]: 1 }).success).toBe(false)
    }
  })

  // ── The created_by trap ──────────────────────────────────────────────────

  it('declares no Creator filter — created_by is auth.users-backed, the member picker is not', () => {
    // eval_suite.created_by (migration 252) references auth.users(id), while
    // the shared 'member'-typed filter picker emits member.id — a disjoint
    // UUID space — so a Creator filter would silently match zero rows for
    // every possible selection. Same deliberate omission as sequence and flow.
    expect(MIGRATION_252).toMatch(/created_by\s+uuid REFERENCES auth\.users \(id\)/)
    expect(FILTERABLE_FIELDS.eval_suite.some((f) => f.field === 'created_by')).toBe(false)
    for (const category of FIELD_CATEGORIES.eval_suite) {
      expect(category.fields).not.toContain('created_by')
    }
  })

  // ── Registries ───────────────────────────────────────────────────────────

  it('every categorized filter field is a declared filterable field', () => {
    const filterable = new Set(FILTERABLE_FIELDS.eval_suite.map((f) => f.field))
    for (const category of FIELD_CATEGORIES.eval_suite) {
      for (const f of category.fields) {
        expect(filterable.has(f)).toBe(true)
      }
    }
  })

  it('single-record endpoint targets the evals suites API', () => {
    expect(ENTITY_ENDPOINTS.eval_suite('abc')).toBe('/api/account/evals/suites/abc')
  })

  it('the only bulk action is delete — a suite has no archived state', () => {
    expect(BULK_ACTIONS.eval_suite.map((a) => a.id)).toEqual(['delete'])
    expect(BULK_ACTIONS.eval_suite[0].destructive).toBe(true)
  })

  it('search applies ilike on name', () => {
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'eval_suite', 'discovery')
    expect(q.ilike).toHaveBeenCalledWith('name', '%discovery%')
    expect(q.or).not.toHaveBeenCalled()
  })
})
