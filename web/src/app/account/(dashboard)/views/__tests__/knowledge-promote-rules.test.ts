/**
 * Promote must never widen a filter.
 *
 * A LIVE package persists the user's filter as standing `rules`, and those
 * rules keep selecting claims for as long as the package exists. The rule
 * vocabulary is far narrower than the view filter vocabulary, so the dangerous
 * failure is not an error — it is a PARTIAL translation: a package created from
 * "confidence ≥ 0.8, scope personal" that persists only the confidence half
 * silently accumulates every workspace claim above 0.8, and nothing ever tells
 * the user.
 *
 * So the contract is all-or-nothing: one unrepresentable filter collapses the
 * whole set to `undefined`, and the dialog falls back to pinning the claims
 * that match right now. Narrower than asked for is acceptable; wider is not.
 *
 * These tests are written field by field because that is the failure mode —
 * adding a filter field and forgetting this file.
 */

import { describe, expect, it } from 'vitest'

import { FILTERABLE_FIELDS, type ViewFilter } from '@/lib/views/types'
import { viewFiltersToPromoteRules } from '../knowledge-promote-rules'

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'

const f = (field: string, operator: ViewFilter['operator'], value: ViewFilter['value']): ViewFilter => ({
  id: `${field}-${operator}`,
  field,
  operator,
  value,
})

describe('filters that DO have a rule form', () => {
  it('no filters at all is no rules — the dialog offers frozen pins only', () => {
    expect(viewFiltersToPromoteRules([])).toBeUndefined()
  })

  it('project membership', () => {
    expect(viewFiltersToPromoteRules([f('project_ids', 'is', PROJECT_A)])).toEqual({
      projects: [PROJECT_A],
    })
    expect(
      viewFiltersToPromoteRules([f('project_ids', 'is_any_of', [PROJECT_A, PROJECT_B])]),
    ).toEqual({ projects: [PROJECT_A, PROJECT_B] })
  })

  it('claim types', () => {
    expect(
      viewFiltersToPromoteRules([f('type', 'is_any_of', ['fact', 'decision_summary'])]),
    ).toEqual({ types: ['fact', 'decision_summary'] })
  })

  it('confirmed-only becomes include_suggested: false', () => {
    expect(viewFiltersToPromoteRules([f('confirmation', 'is', 'confirmed')])).toEqual({
      include_suggested: false,
    })
  })

  it('a confidence FLOOR', () => {
    expect(viewFiltersToPromoteRules([f('confidence', 'gte', 0.8)])).toEqual({
      min_confidence: 0.8,
    })
  })

  it('combines several representable filters into one rule set', () => {
    expect(
      viewFiltersToPromoteRules(
        [
          f('project_ids', 'is', PROJECT_A),
          f('type', 'is_any_of', ['open_question']),
          f('confidence', 'gte', 0.7),
          f('confirmation', 'is', 'confirmed'),
        ],
      ),
    ).toEqual({
      projects: [PROJECT_A],
      types: ['open_question'],
      min_confidence: 0.7,
      include_suggested: false,
    })
  })
})

describe('filters that do NOT have a rule form collapse the whole set', () => {
  it.each([
    ['suggested-only — the inverse of include_suggested has no rule', f('confirmation', 'is', 'suggested')],
    ['a project EXCLUSION — rules can only say "in these projects"', f('project_ids', 'is_none_of', [PROJECT_A])],
    ['claims with no project at all', f('project_ids', 'is_empty', '')],
    ['a confidence CEILING', f('confidence', 'lte', 0.5)],
    ['a strict confidence floor — gt is not gte, and the boundary value differs', f('confidence', 'gt', 0.8)],
    // `since` is resolved against updated_at, so even a created_at LOWER bound
    // would admit old claims that were edited or confirmed recently.
    ['a created_at lower bound', f('created_at', 'gte', '2026-08-01T00:00:00.000Z')],
    ['a PAST created_at window', f('created_at', 'is_relative', { unit: 'day', direction: 'past', count: 30 })],
    ['a created_at UPPER bound', f('created_at', 'lte', '2026-08-01T00:00:00.000Z')],
    ['a created_at range', f('created_at', 'between', { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' })],
    ['a THIS-period window, which has an upper edge', f('created_at', 'is_relative', { unit: 'month', direction: 'this' })],
    ['scope', f('scope', 'is', 'personal')],
    ['auto_accepted', f('auto_accepted', 'is', true)],
    ['a creator', f('created_by', 'is', PROJECT_A)],
    ['event_at', f('event_at', 'gte', '2026-08-01T00:00:00.000Z')],
    ['last_verified_at', f('last_verified_at', 'is_empty', '')],
    ['free text', f('text', 'contains', 'pricing')],
  ])('%s', (_label, filter) => {
    expect(viewFiltersToPromoteRules([filter])).toBeUndefined()
  })

  it('poisons an otherwise-representable set rather than persisting half of it', () => {
    // The dangerous case: without the all-or-nothing rule this would persist
    // `{min_confidence: 0.8}` and quietly include every personal-scope claim
    // the user had filtered OUT.
    expect(
      viewFiltersToPromoteRules(
        [f('confidence', 'gte', 0.8), f('scope', 'is', 'personal')],
      ),
    ).toBeUndefined()
  })
})

describe('drift guard', () => {
  it('every claim filter field is either translated or explicitly refused', () => {
    // Not a tautology: the point is that a NEW field added to
    // FILTERABLE_FIELDS.claim must produce `undefined` here (fail closed)
    // rather than being silently ignored by a pass-through. A field that
    // returns rules without appearing in the translated list above means
    // someone added a passthrough branch without a test.
    const translated = new Set(['project_ids', 'type', 'confirmation', 'confidence'])
    for (const def of FILTERABLE_FIELDS.claim) {
      if (translated.has(def.field)) continue
      const probe = f(def.field, 'is', 'anything')
      expect(
        viewFiltersToPromoteRules([probe]),
        `${def.field} is a claim filter with no rule form, so it must collapse the rule set`,
      ).toBeUndefined()
    }
  })
})
