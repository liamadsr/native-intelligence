/**
 * Registration invariants for the 'eval_run' views entity.
 *
 * The suite detail page's Runs tab is a scoped `UnifiedViewLayout`, so a run is
 * a first-class views entity. It is the ODD ONE OUT of the three Evals
 * entities, in three ways this file exists to pin:
 *
 *  1. A RUN IS IMMUTABLE. It is the record of what one prompt scored at one
 *     moment; nothing about it is a field a person sets afterwards. There is no
 *     PATCH route (ENTITY_ENDPOINTS.eval_run returns null), so NO display
 *     property may be editable and no bulk action may exist — the layout would
 *     have nowhere to send either.
 *  2. A RUN HAS NO NAME COLUMN. Its identity is composed from mode +
 *     started_at, so `applySearch` matches on `target_prompt_hash` instead, as
 *     a PREFIX.
 *  3. ITS OUTCOME VOCABULARY IS NARROWER than the case's and the suite's.
 *     Migration 252's CHECK on eval_run.outcome allows only
 *     passed/scored/failed: a run that BROKE is `status = 'failed'`, not an
 *     'errored' outcome. Injecting an Errored board column here would produce a
 *     column no run can ever land in.
 *
 * The rest mirrors eval-suite-view-registration.test.ts, plus the
 * hidden-scope-field pin prospect-entry-view-registration.test.ts introduced.
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
import {
  EVAL_MODES,
  EVAL_RUN_OUTCOMES,
  EVAL_RUN_STATUSES,
  EVAL_SPEEDS,
  EVAL_TRIAL_OUTCOMES,
} from '@/lib/evals/types'

const MIGRATION_252 = readFileSync(
  join(process.cwd(), 'supabase/migrations/252_evals.sql'),
  'utf8',
)

/** The eval_run slice of 252. Scoped for the same reason the case test scopes
 *  its own: `mode`, `status` and `outcome` all recur on the sibling tables in
 *  this file, and an unscoped regex would match eval_trial's constraint and
 *  call it a pass. */
const EVAL_RUN_DDL = MIGRATION_252.slice(
  MIGRATION_252.indexOf('CREATE TABLE IF NOT EXISTS public.eval_run'),
  MIGRATION_252.indexOf('CREATE INDEX IF NOT EXISTS eval_run_suite_idx'),
)

/**
 * The column NAMES declared on eval_run, as a Set.
 *
 * A raw `expect(EVAL_RUN_DDL).toContain(field)` is not this test: the DDL text
 * is one long string, so any PREFIX of a real column passes — `cost` inside
 * `cost_usd`, `token` inside `tokens_in`, `start` inside `started_at`. Those
 * are exactly the plausible typos a "is this a real column?" test exists to
 * catch, and each would be a PostgREST 42703 on every filtered list.
 *
 * One name per column-definition line: two-space indent, an identifier, then a
 * type keyword. Everything else in the block (CHECK bodies, REFERENCES,
 * continuation lines) fails the shape and contributes no name.
 */
const COLUMN_DEF =
  /^\s{2,}([a-z_][a-z0-9_]*)\s+(uuid|text|jsonb|boolean|numeric|integer|smallint|bigint|timestamptz|date|real|double)\b/

const EVAL_RUN_COLUMNS = new Set(
  EVAL_RUN_DDL.split('\n')
    .map((line) => line.match(COLUMN_DEF)?.[1])
    .filter((name): name is string => Boolean(name)),
)

function checkValues(column: string): string[] {
  const match = EVAL_RUN_DDL.match(
    new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i'),
  )
  if (!match) throw new Error(`No CHECK (… IN …) for "${column}" on eval_run`)
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

const field = (name: string) =>
  FILTERABLE_FIELDS.eval_run.find((f) => f.field === name)

describe('eval_run views registration', () => {
  // ── Enum lockstep: FILTERABLE_FIELDS ↔ const arrays ↔ migration 252 ──────

  it('mode options match EVAL_MODES and the 252 CHECK', () => {
    expect(field('mode')?.type).toBe('enum')
    expect(field('mode')?.options).toEqual([...EVAL_MODES])
    expect(checkValues('mode')).toEqual([...EVAL_MODES])
  })

  it('speed options match EVAL_SPEEDS and the 252 CHECK', () => {
    // The FULL enum, including the two speeds only the client driver can run.
    // A run recorded at 'fast' before the driver shipped must still be
    // filterable, and the filter picker is not the place that decides what is
    // runnable — the start-run dialog is.
    expect(field('speed')?.options).toEqual([...EVAL_SPEEDS])
    expect(checkValues('speed')).toEqual([...EVAL_SPEEDS])
  })

  it('status options match EVAL_RUN_STATUSES and the 252 CHECK', () => {
    expect(field('status')?.options).toEqual([...EVAL_RUN_STATUSES])
    expect(checkValues('status')).toEqual([...EVAL_RUN_STATUSES])
  })

  it('outcome is the NARROW vocabulary — no "errored", and it allows empty', () => {
    // The distinction this pins: a run that broke is status='failed', while
    // 'errored' is a TRIAL outcome (a harness failure on one case). Offering
    // it here would be a filter value no row can hold.
    expect(field('outcome')?.options).toEqual([...EVAL_RUN_OUTCOMES])
    expect(checkValues('outcome')).toEqual([...EVAL_RUN_OUTCOMES])
    expect(field('outcome')?.options).not.toContain('errored')
    expect([...EVAL_TRIAL_OUTCOMES]).toContain('errored')
    // NULL while the run has not settled — queued, running, or cancelled.
    expect(field('outcome')?.allowEmpty).toBe(true)
  })

  it('the numeric and date filters are typed for their columns', () => {
    expect(field('started_at')?.type).toBe('date')
    expect(field('cost_usd')?.type).toBe('number')
    expect(field('duration_ms')?.type).toBe('number')
    expect(field('trials_per_case')?.type).toBe('number')
    expect(field('target_prompt_hash')?.type).toBe('text')
  })

  it('every filterable field is a REAL column on eval_run', () => {
    for (const f of FILTERABLE_FIELDS.eval_run) {
      expect(EVAL_RUN_COLUMNS, `${f.field} is not a column on eval_run`).toContain(f.field)
    }
  })

  it('the column parse is exact — a PREFIX of a real column is not a column', () => {
    // What makes the test above worth running. Each of these is a substring of
    // a real column name (cost_usd, tokens_in, target_model, started_at,
    // error_code, duration_ms) and passed the old raw-text search.
    expect(EVAL_RUN_COLUMNS.has('cost_usd')).toBe(true)
    for (const bogus of ['cost', 'token', 'target', 'start', 'error', 'duration', 'run']) {
      expect(EVAL_RUN_COLUMNS.has(bogus), `'${bogus}' must not read as a column`).toBe(false)
    }
    // …and the parse actually found the table, rather than an empty set that
    // would make every membership assertion above vacuously strict.
    expect(EVAL_RUN_COLUMNS.size).toBeGreaterThan(20)
  })

  it('declares NO created_at filter, because the column does not exist', () => {
    // A run's birth time is `started_at` (252). This is not a style choice:
    // the views default ordering is `created_at desc` for every other entity,
    // and ordering eval_run on it would be a PostgREST 42703 — the list would
    // 500 on its first load. `use-view`'s defaultConfig carries the exception.
    expect(EVAL_RUN_DDL).not.toMatch(/^\s*created_at\s/m)
    expect(FILTERABLE_FIELDS.eval_run.some((f) => f.field === 'created_at')).toBe(false)
  })

  // ── The scope field ──────────────────────────────────────────────────────

  it('suite_id is filterable (a real column) but hidden from the filter picker', () => {
    expect(field('suite_id')).toBeDefined()
    expect(EVAL_RUN_DDL).toMatch(/suite_id\s+uuid NOT NULL REFERENCES public\.eval_suite/)
    for (const category of FIELD_CATEGORIES.eval_run) {
      expect(category.fields).not.toContain('suite_id')
    }
  })

  // ── Board ────────────────────────────────────────────────────────────────

  it('board group-by is outcome — NOT last_outcome, which is the parent’s column', () => {
    expect(DEFAULT_BOARD_GROUP_BY.eval_run).toBe('outcome')
    expect(FILTERABLE_FIELDS.eval_run.some((f) => f.field === 'outcome')).toBe(true)
    // The suite and the case group on `last_outcome`; a run's verdict is its
    // own, not a denormalized summary of something else.
    expect(FILTERABLE_FIELDS.eval_run.some((f) => f.field === 'last_outcome')).toBe(false)
  })

  it('the columns a run board may inject are the outcome order MINUS errored', () => {
    // The route filters EVAL_OUTCOME_ORDER's keys for eval_run; this is what
    // says which set that filter must produce.
    const injectable = Object.keys(EVAL_OUTCOME_ORDER).filter((o) => o !== 'errored')
    expect(injectable).toEqual([...EVAL_RUN_OUTCOMES])
    // …and the order stays best → worst, which is what makes the board read
    // left to right as "getting worse".
    expect(
      injectable.slice().sort((a, b) => EVAL_OUTCOME_ORDER[a] - EVAL_OUTCOME_ORDER[b]),
    ).toEqual(['passed', 'scored', 'failed'])
  })

  // ── Display properties ───────────────────────────────────────────────────

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.eval_run.map((d) => d.field))
    for (const f of DEFAULT_DISPLAY_PROPERTIES.eval_run) {
      expect(declared.has(f)).toBe(true)
    }
  })

  it('no eval_run display property is scope-only, so defaults are scope-free', () => {
    for (const d of DISPLAY_PROPERTIES.eval_run) {
      expect(d.scopeOnly).toBeUndefined()
    }
    expect(defaultDisplayProperties('eval_run', new Set(['suite_id']))).toEqual(
      DEFAULT_DISPLAY_PROPERTIES.eval_run,
    )
  })

  it('NOTHING on a run is inline-editable — it is an immutable record', () => {
    // The load-bearing one. Every other views entity has at least one editable
    // cell, so "none" here has to be asserted rather than assumed: a run
    // records what happened, and there is no route that would accept an edit.
    for (const d of DISPLAY_PROPERTIES.eval_run) {
      expect(d.editable).toBeUndefined()
    }
  })

  it('has no single-record endpoint, which is what makes every edit path a no-op', () => {
    // ENTITY_ENDPOINTS is what `patchItem` and `handleMoveItem` both read, so
    // a null here disarms inline edits AND board drags by construction rather
    // than by each path remembering to check.
    expect(ENTITY_ENDPOINTS.eval_run('abc')).toBeNull()
  })

  it('scores is display-only — a jsonb tally with no filter behind it', () => {
    // The per-dimension rates are the most-read thing on a run row, and they
    // are NOT filterable: they live in a `scores` jsonb whose keys are the
    // dimension names, so a PostgREST predicate would need a path expression
    // per dimension. Display and filter maps are independent for exactly this.
    expect(DEFAULT_DISPLAY_PROPERTIES.eval_run).toContain('scores')
    expect(DISPLAY_PROPERTIES.eval_run.some((d) => d.field === 'scores')).toBe(true)
    expect(FILTERABLE_FIELDS.eval_run.some((f) => f.field === 'scores')).toBe(false)
    expect(EVAL_RUN_DDL).toMatch(/scores\s+jsonb/)
  })

  // ── The started_by trap ──────────────────────────────────────────────────

  it('declares no Creator filter — started_by is auth.users-backed, the member picker is not', () => {
    // eval_run.started_by (252) references auth.users(id), while the shared
    // 'member'-typed picker emits member.id — a disjoint UUID space — so the
    // filter would silently match zero rows for every selection. eval_run has
    // no `created_by` column at all, so both names are pinned absent.
    expect(EVAL_RUN_DDL).toMatch(/started_by\s+uuid REFERENCES auth\.users \(id\)/)
    for (const name of ['started_by', 'created_by']) {
      expect(FILTERABLE_FIELDS.eval_run.some((f) => f.field === name)).toBe(false)
      for (const category of FIELD_CATEGORIES.eval_run) {
        expect(category.fields).not.toContain(name)
      }
    }
  })

  // ── Registries ───────────────────────────────────────────────────────────

  it('every categorized filter field is a declared filterable field', () => {
    const filterable = new Set(FILTERABLE_FIELDS.eval_run.map((f) => f.field))
    for (const category of FIELD_CATEGORIES.eval_run) {
      for (const f of category.fields) {
        expect(filterable.has(f)).toBe(true)
      }
    }
  })

  it('has NO bulk actions — there is no run DELETE route to give it one', () => {
    // Deleting a run deletes the evidence behind every comparison that cites
    // it. Cancelling a live run is a different verb and lives on the run rail.
    expect(BULK_ACTIONS.eval_run).toEqual([])
  })

  it('search matches target_prompt_hash as a PREFIX, since a run has no name', () => {
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'eval_run', 'a1b2c3d4')
    // No leading '%': a hash's tail is not something anyone holds in hand, and
    // the row prints the first eight characters for exactly this to work.
    expect(q.ilike).toHaveBeenCalledWith('target_prompt_hash', 'a1b2c3d4%')
    expect(q.or).not.toHaveBeenCalled()
  })

  it('does not search on name — the column does not exist', () => {
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'eval_run', 'batch')
    expect(q.ilike).not.toHaveBeenCalledWith('name', expect.anything())
  })
})
