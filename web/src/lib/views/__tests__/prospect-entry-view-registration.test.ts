/**
 * Registration invariants for the 'prospect_list_entry' views entity.
 *
 * Near-verbatim port of sequence-view-registration.test.ts. The exhaustive
 * Record<ViewEntityType, …> maps already force compile-time coverage; these
 * tests pin the CONTENT the compiler can't check — enum options in lockstep
 * with BOTH the const arrays in @/lib/prospecting/types AND migration 248's
 * CHECK constraints, board grouping wired to a filterable field, defaults
 * referencing real display properties, the read-only contract on every FIT
 * field, and endpoint targeting.
 *
 * The enum-lockstep tests are the load-bearing ones. types.ts deliberately
 * spells its option arrays as literals rather than importing the prospecting
 * consts (it is loaded by client components), so nothing but these assertions
 * stops the two from drifting — and a drifted enum is silent: the filter
 * simply stops offering a value that rows really have.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_BOARD_GROUP_BY,
  DEFAULT_DISPLAY_PROPERTIES,
  DEFAULT_ORDERING,
  defaultDisplayProperties,
  DISPLAY_PROPERTIES,
  FIELD_CATEGORIES,
  FILTERABLE_FIELDS,
  OPERATORS_BY_TYPE, operatorLabel,
} from '@/lib/views/types'
import { applySearch } from '@/lib/views/query-engine'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { BULK_ACTIONS } from '@/components/views/bulk-actions/types'
import {
  PROSPECT_DISMISSED_REASONS,
  PROSPECT_ENTRY_KINDS,
  PROSPECT_ENTRY_STAGES,
  PROSPECT_IDENTITY_STATES,
} from '@/lib/prospecting/types'
import { getProspectListUrl, prospectListScopeFilters } from '@/lib/prospecting/urls'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/248_prospecting.sql'),
  'utf8',
)

/** Pull the value list out of `CHECK (<column> IN ('a','b',…))` in 248. */
function checkValues(column: string): string[] {
  const all = [
    ...MIGRATION.matchAll(
      new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'gi'),
    ),
  ].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]))
  if (!all.length) throw new Error(`No CHECK (… IN …) for "${column}" in 248_prospecting.sql`)
  return all[0]
}

const field = (name: string) => FILTERABLE_FIELDS.prospect_list_entry.find((f) => f.field === name)

describe('prospect_list_entry views registration', () => {
  // ── Enum lockstep: FILTERABLE_FIELDS ↔ const arrays ↔ migration 248 ───────

  it('stage options match PROSPECT_ENTRY_STAGES and the DB CHECK, in order', () => {
    const stage = field('stage')
    expect(stage?.type).toBe('enum')
    expect(stage?.options).toEqual([...PROSPECT_ENTRY_STAGES])
    // `stage` appears on prospect_list_entry AND prospecting_run; the entry's
    // table is declared first in 248, so the first match is the right one.
    expect(checkValues('stage')).toEqual([...PROSPECT_ENTRY_STAGES])
  })

  it('fit_score is a nullable NUMBER filter called Match score — "at least 80" is a filter a user can build', () => {
    // Migration 256: the profile's 0–100 match score, NULL until a company is
    // profiled. A number so the picker offers gte/lte; `allowEmpty` because
    // an unprofiled row has no score.
    const score = field('fit_score')
    expect(score?.label).toBe('Match score')
    expect(score?.type).toBe('number')
    expect(score?.allowEmpty).toBe(true)
    expect(OPERATORS_BY_TYPE.number).toEqual([
      'is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty',
    ])
  })

  it('a number compares as a number, not as a date (Liam, 2026-09-06: "why is Fit score like a date?")', () => {
    // `gt`/`lt` are shared with dates, and the shared labels are the date
    // ones — so the chip asks the field's type before it picks a word.
    expect(operatorLabel('gt', 'number')).toBe('greater than')
    expect(operatorLabel('gte', 'number')).toBe('at least')
    expect(operatorLabel('lt', 'number')).toBe('less than')
    expect(operatorLabel('lte', 'number')).toBe('at most')
    expect(operatorLabel('is_empty', 'number')).toBe('has no value')
    expect(operatorLabel('gt', 'date')).toBe('after')
    expect(operatorLabel('gte', 'date')).toBe('on or after')
    expect(operatorLabel('is', 'number')).toBe('is')
  })

  it('the columns migration 256 dropped are not filterable, groupable, or displayable', () => {
    for (const gone of ['fit_tier', 'fit_confidence', 'fit_signals']) {
      expect(field(gone), gone).toBeUndefined()
      expect(DISPLAY_PROPERTIES.prospect_list_entry.map((d) => d.field)).not.toContain(gone)
      expect(FIELD_CATEGORIES.prospect_list_entry.flatMap((c) => c.fields)).not.toContain(gone)
    }
  })

  it('opens hottest first — the score is the point of profiling', () => {
    // `applyOrdering` sends NULLS LAST, so the rows nobody has profiled sit
    // under every scored one, newest first among themselves.
    expect(DEFAULT_ORDERING.prospect_list_entry).toEqual([
      { field: 'fit_score', direction: 'desc' },
      { field: 'created_at', direction: 'desc' },
    ])
  })

  it('identity_state options match PROSPECT_IDENTITY_STATES and the DB CHECK', () => {
    expect(field('identity_state')?.options).toEqual([...PROSPECT_IDENTITY_STATES])
    expect(checkValues('identity_state')).toEqual([...PROSPECT_IDENTITY_STATES])
  })

  it('kind options match PROSPECT_ENTRY_KINDS and the DB CHECK', () => {
    expect(field('kind')?.options).toEqual([...PROSPECT_ENTRY_KINDS])
    expect(checkValues('kind')).toEqual([...PROSPECT_ENTRY_KINDS])
  })

  it('dismissed_reason options match PROSPECT_DISMISSED_REASONS and the DB CHECK', () => {
    expect(field('dismissed_reason')?.options).toEqual([...PROSPECT_DISMISSED_REASONS])
    expect(checkValues('dismissed_reason')).toEqual([...PROSPECT_DISMISSED_REASONS])
  })

  // ── Board ────────────────────────────────────────────────────────────────

  it('board group-by is stage — the pipeline — and it is filterable', () => {
    // A board drag PATCHes the group-by field, so the default must be a field
    // the board has a write path for. As of PR 7 `stage` does:
    // `unified-view-layout`'s prospect intercept routes `dismissed` through the
    // reason picker and `saved` through the save route, refuses `discovered`,
    // and lets `shortlisted` fall through as a plain PATCH. `fit_tier` — the
    // previous default — is a machine score no drag may rewrite, so a board
    // that opened on it had four columns and not one legal move.
    expect(DEFAULT_BOARD_GROUP_BY.prospect_list_entry).toBe('stage')
    expect(field('stage')).toBeDefined()
  })

  // ── Display properties ───────────────────────────────────────────────────

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.prospect_list_entry.map((d) => d.field))
    for (const f of DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry) {
      expect(declared.has(f), `default "${f}" is not a declared display property`).toBe(true)
    }
  })

  it('defaults are SLIM — the score and the stage, nothing else', () => {
    // The row reads favicon · name · score · stage. "Why" (fit_rationale)
    // gates the whole reasoning strip — the rationale sentence, the employee
    // range and the citation link — and all of it lives in the detail panel
    // beside the list, where there is room to read it. It is still one tick
    // away in the picker, which is what makes this a DEFAULT rather than a
    // removal.
    expect(DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry).toEqual(['fit_score', 'stage'])
    expect(DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry).not.toContain('fit_rationale')
    // And "Why" is still offered, so ticking it brings the strip back.
    expect(DISPLAY_PROPERTIES.prospect_list_entry.map((d) => d.field)).toContain('fit_rationale')
  })

  it('NO fit field is inline-editable — a machine score is not a picker', () => {
    // The honest affordances are dismiss (with a reason) and re-run. A bare
    // enum picker on fit_tier would imply a human can overrule the model in
    // place, and would silently diverge the tier from fit_score/fit_rationale
    // that produced it.
    for (const d of DISPLAY_PROPERTIES.prospect_list_entry) {
      if (d.field.startsWith('fit_')) {
        expect(d.editable, `${d.field} must not be inline-editable`).toBeUndefined()
      }
    }
  })

  it('NOTHING is inline-editable in this PR — stage included', () => {
    // The generic enum-cell path PATCHes /api/account/prospecting/entries/[id],
    // which refuses stage='saved' and refuses stage='dismissed' with no reason,
    // so an enum picker offering all four values 400s on two of them. Stage is
    // moved by the explicit Save / Dismiss controls until PR 7 gives the cell a
    // write path that can honour those conditions.
    const editable = DISPLAY_PROPERTIES.prospect_list_entry.filter((d) => d.editable)
    expect(editable.map((d) => d.field)).toEqual([])
  })

  it('declares no scope-only display property, so scoping never changes defaults', () => {
    // Unlike sequences' `enrollment`, nothing here is merged only under a
    // scope — the list detail page's rows carry the same columns the global
    // list would.
    for (const d of DISPLAY_PROPERTIES.prospect_list_entry) expect(d.scopeOnly).toBeUndefined()
    expect(defaultDisplayProperties('prospect_list_entry', new Set(['list_id']))).toEqual(
      DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry,
    )
  })

  // ── The list scope ───────────────────────────────────────────────────────

  it('list_id is filterable (a real column) but hidden from the filter picker', () => {
    // It is the fixed scope the list detail page locks, not a filter a user
    // picks — the same deliberate omission as the sibling embeds' scope fields.
    expect(field('list_id')).toBeDefined()
    for (const category of FIELD_CATEGORIES.prospect_list_entry) {
      expect(category.fields).not.toContain('list_id')
    }
  })

  it('the scope helper emits exactly that filter', () => {
    expect(prospectListScopeFilters('list-1')).toEqual([
      { id: '__scope_prospect_list', field: 'list_id', operator: 'is', value: 'list-1' },
    ])
  })

  it('the deep link matches the param the main chat host consumes', () => {
    expect(getProspectListUrl('list-1')).toMatch(/\/account\?prospect_list=list-1$/)
  })

  it('every categorized filter field is a declared filterable field', () => {
    const filterable = new Set(FILTERABLE_FIELDS.prospect_list_entry.map((f) => f.field))
    for (const category of FIELD_CATEGORIES.prospect_list_entry) {
      for (const f of category.fields) expect(filterable.has(f)).toBe(true)
    }
  })

  // ── Endpoint + search + bulk ─────────────────────────────────────────────

  it('single-record endpoint targets the prospecting entries API', () => {
    expect(ENTITY_ENDPOINTS.prospect_list_entry('abc')).toBe(
      '/api/account/prospecting/entries/abc',
    )
  })

  it('search applies ilike on candidate_key, lowercased', () => {
    // The candidate has no name COLUMN (it is jsonb until promotion);
    // candidate_key is the normalized identity and is always lowercase.
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'prospect_list_entry', 'Acme.COM')
    expect(q.ilike).toHaveBeenCalledWith('candidate_key', '%acme.com%')
    expect(q.or).not.toHaveBeenCalled()
  })

  it('offers no bulk delete — an entry IS the suppression record', () => {
    // Deleting one would make a rejected candidate re-discoverable next run;
    // "remove from list" is dismiss, which keeps suppressing.
    const ids = BULK_ACTIONS.prospect_list_entry.map((a) => a.id)
    expect(ids).not.toContain('delete')
    expect(ids).toEqual(['save_to_crm', 'dismiss'])
  })

  it('offers no add_to_sequence yet — the generic intercept reads ENTRY ids as contact ids', () => {
    // unified-view-layout's existing intercept passes the selection to the
    // enrollment dialog, which expects contact ids; a prospect selection is
    // entry ids, and most entries have no contact until saved. PR 6 adds the
    // translation and the per-row no_email disabling.
    expect(BULK_ACTIONS.prospect_list_entry.map((a) => a.id)).not.toContain('add_to_sequence')
  })

  it('save/dismiss take no generic value picker — they are intercepted', () => {
    // Both need per-entry outcomes the generic {success, failed} bulk response
    // cannot express, so neither may be dispatched through the bulk endpoint.
    for (const a of BULK_ACTIONS.prospect_list_entry) {
      expect(a.requiresValue).toBeUndefined()
      expect(a.valueType).toBeUndefined()
    }
  })
})
