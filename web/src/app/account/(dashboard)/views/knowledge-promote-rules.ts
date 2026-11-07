/**
 * A saved view's filters → a knowledge package's standing rules.
 *
 * Promote turns what you are looking at into a shareable package. It offers two
 * modes: LIVE, where the filter is persisted as `rules` JSONB (migration 124)
 * and matching claims keep flowing in, and FROZEN, where the claims currently
 * matching are pinned by id.
 *
 * THIS FUNCTION IS FAIL-CLOSED, and that is the whole point of it existing
 * separately. The package rule vocabulary is much narrower than the view filter
 * vocabulary — it understands projects, claim types, a minimum confidence, a
 * since-date (on updated_at) and an include-suggested flag, and nothing else. If a filter has
 * no faithful representation in that vocabulary, returning a PARTIAL rule set
 * would create a standing package that quietly includes claims the user's
 * filter excluded, for as long as the package exists. So a single
 * unrepresentable filter collapses the whole set to `undefined`, and the dialog
 * falls back to frozen pins — narrower than the user asked for, never wider.
 *
 * Widening the view vocabulary is what makes this dangerous, which is why every
 * field is enumerated explicitly here rather than passed through: a field added
 * to `FILTERABLE_FIELDS.claim` and forgotten here fails closed by construction.
 */

import type { ViewFilter } from '@/lib/views/types'
import type { PromoteLiveRules } from './knowledge-library'

function asArray(value: ViewFilter['value']): string[] | null {
  if (typeof value === 'string') return value === '' ? null : [value]
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string' && v !== '')
    return out.length > 0 ? out : null
  }
  return null
}

/**
 * Returns the rules, or `undefined` if ANY filter cannot be expressed.
 */
export function viewFiltersToPromoteRules(
  filters: readonly ViewFilter[],
): PromoteLiveRules | undefined {
  const rules: PromoteLiveRules = {}

  for (const f of filters) {
    switch (f.field) {
      case 'project_ids': {
        // Only a positive membership test is a rule. `is_none_of` /
        // `is_not` / `is_empty` describe an absence, and `rules.projects` can
        // only ever express "in these projects".
        if (f.operator !== 'is' && f.operator !== 'is_any_of') return undefined
        const ids = asArray(f.value)
        if (!ids) return undefined
        rules.projects = [...new Set([...(rules.projects ?? []), ...ids])]
        break
      }

      case 'type': {
        if (f.operator !== 'is' && f.operator !== 'is_any_of') return undefined
        const types = asArray(f.value)
        if (!types) return undefined
        rules.types = [...new Set([...(rules.types ?? []), ...types])] as PromoteLiveRules['types']
        break
      }

      case 'confirmation': {
        // `include_suggested: false` is the ONLY confirmation rule there is.
        // "Confirmed only" maps to it exactly. "Suggested only" is the inverse
        // and has no rule form at all — the shape the original bar already
        // refused to fake.
        if (f.operator !== 'is') return undefined
        if (f.value === 'confirmed') {
          rules.include_suggested = false
          break
        }
        return undefined
      }

      case 'confidence': {
        // A package threshold is a FLOOR. `gt` is not `gte`, and mapping it to
        // one would silently include the boundary value.
        if (f.operator !== 'gte') return undefined
        const n = Number(f.value)
        if (!Number.isFinite(n)) return undefined
        rules.min_confidence = Math.max(rules.min_confidence ?? 0, n)
        break
      }

      // `created_at` has NO rule form either. The package rule `since` is
      // resolved against `updated_at` (src/lib/knowledge/brief.ts), and a claim
      // edited or confirmed after the window opened has a recent updated_at
      // however old it is — so a created_at bound as `since` would let older
      // claims into the standing package that the filter excluded.
      //
      // Every other claim field — scope, auto_accepted, created_by, event_at,
      // last_verified_at, text — has NO rule form. Listing them is not
      // necessary for correctness (the default returns undefined) but it is
      // what makes the omission deliberate rather than an oversight.
      default:
        return undefined
    }
  }

  return Object.keys(rules).length > 0 ? rules : undefined
}
