/**
 * The filter wire — one query param carrying the canonical `MapPredicate[]`.
 *
 * The map used to speak five named params (`types`, `confirmation`,
 * `minConfidence`, `sinceDays`, `project`), which is a shape the open filter
 * vocabulary cannot fit: eleven fields × up to ten operators, several of them
 * set-valued, and the same field usable twice ("created after X and before Y").
 * So the wire carries the predicate list itself.
 *
 * NOTHING HERE TRUSTS THE CLIENT. Every predicate is re-validated field by
 * field through `normalisePredicate` — the same function `toMapFilters` runs on
 * the UI's own chips — so a hand-crafted URL can only ever produce a filter set
 * the mask already knows how to answer. That matters twice over: the parsed
 * value becomes a CACHE KEY (`filtersKey`), so an unvalidated value would both
 * churn the build LRU and, before the key became structural, forge another
 * filter set's entry.
 *
 * A malformed payload is a 400, never a throw: the routes read this on every
 * request, and an exception escaping here would surface as a 500 that looks
 * like the map is broken rather than like the request was.
 *
 * Filters are applied on the server BEFORE tiling; positions always come from
 * the unfiltered layout, so toggling a filter re-ranks which nodes fill which
 * tiles but never moves one (§4.3).
 */

import type { FilterOperator, FilterValue, ViewFilter } from '@/lib/views/types'
import {
  MAX_FILTER_PAYLOAD_BYTES,
  MAX_PREDICATES,
  normalisePredicate,
  type MapFilters,
  type MapPredicate,
  UNSET,
} from './filter-model'

/**
 * The single query param. One letter because it rides in every tile request's
 * URL alongside the version and up to 32 tile ids.
 */
export const FILTER_PARAM = 'f'

/**
 * Wire form of one predicate: `[field, op]` or `[field, op, value]`.
 *
 * A tuple rather than `{field, op, value}` — the object spelling costs about
 * 20 bytes per predicate in JSON, and a URL that has to carry two dozen of
 * them alongside the tile list is the one place in this feature where bytes
 * are genuinely scarce.
 */
type WirePredicate = [string, string] | [string, string, FilterValue]

/**
 * Parsed filters, or the reason the payload was refused.
 *
 * A result rather than a throw-or-silently-ignore: the old parser dropped
 * anything it did not understand, which meant a client bug rendered as a map
 * with the wrong claims on it and no way to tell.
 */
export type ParsedFilters =
  | { ok: true; filters: MapFilters }
  | { ok: false; error: string }

/** Read and validate the filter param. Never throws. */
export function parseFilters(params: URLSearchParams): ParsedFilters {
  const raw = params.get(FILTER_PARAM)
  if (raw === null || raw.trim() === '') return { ok: true, filters: {} }

  // Size is checked BEFORE parsing: `JSON.parse` on a multi-megabyte param is
  // itself the denial of service, and the cap has to bound work, not just the
  // result. Two steps because a UTF-8 byte count means encoding the string:
  // one UTF-16 unit is at least one byte, so the cheap length test rejects
  // everything genuinely over the cap, and only a ≤ 8 K-unit string (≤ 32 KB
  // encoded, trivially cheap) is ever measured exactly.
  if (raw.length > MAX_FILTER_PAYLOAD_BYTES) return tooLarge()
  if (new TextEncoder().encode(raw).length > MAX_FILTER_PAYLOAD_BYTES) return tooLarge()

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'filters are not valid JSON' }
  }

  if (!Array.isArray(decoded)) return { ok: false, error: 'filters must be a list' }
  if (decoded.length > MAX_PREDICATES) {
    return { ok: false, error: `at most ${MAX_PREDICATES} filters` }
  }

  const where: MapPredicate[] = []
  for (let i = 0; i < decoded.length; i++) {
    const entry: unknown = decoded[i]
    if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) {
      return { ok: false, error: `filter ${i} is not [field, operator, value?]` }
    }
    const [field, op, value] = entry as WirePredicate
    if (typeof field !== 'string' || typeof op !== 'string') {
      return { ok: false, error: `filter ${i} has no field or operator` }
    }
    // `op` is cast, not trusted: `normalisePredicate` rejects any operator its
    // field's kind does not implement, so an arbitrary string cannot get past
    // it into the mask.
    const result = normalisePredicate({
      id: `f${i}`,
      field,
      operator: op as FilterOperator,
      // `is_empty` / `is_not_empty` carry no value at all, and `ViewFilter`
      // requires the key; the normaliser returns before reading it.
      value: (value ?? '') as FilterValue,
    } satisfies ViewFilter)
    if (typeof result === 'string') return { ok: false, error: `filter ${i}: ${result}` }
    // An unset value cannot arrive here in practice — `toMapFilters` drops
    // those before serialising — but a hand-built URL can carry one, and a
    // predicate the client omitted must not become one the server invents.
    if (result === UNSET) continue
    where.push(result)
  }

  return { ok: true, filters: where.length > 0 ? { where } : {} }
}

function tooLarge(): ParsedFilters {
  return { ok: false, error: `filters exceed ${MAX_FILTER_PAYLOAD_BYTES} bytes` }
}

/**
 * Inverse of `parseFilters`. '' for an empty filter set.
 *
 * Round-trips exactly, because the predicates it serialises are already
 * canonical: `normalisePredicate` is idempotent on its own output (sorted
 * de-duplicated arrays, finite numbers, ISO strings, collapsed lower-cased
 * text), so re-parsing what this produced yields the same `filtersKey`.
 */
export function filtersToParam(filters: MapFilters): string {
  const where = filters.where ?? []
  if (where.length === 0) return ''
  const wire: WirePredicate[] = where.map((p) =>
    p.value === undefined
      ? [p.field, p.op]
      : [p.field, p.op, p.value as FilterValue],
  )
  return JSON.stringify(wire)
}

/** The same, as the query params a request carries. Empty when unfiltered. */
export function filtersToParams(filters: MapFilters): URLSearchParams {
  const params = new URLSearchParams()
  const encoded = filtersToParam(filters)
  if (encoded !== '') params.set(FILTER_PARAM, encoded)
  return params
}

/**
 * Re-exported from the shared vocabulary so importers of the map's own module
 * keep working, and so there is exactly ONE implementation of the cache key —
 * a second one here is how the two engines would drift.
 */
export { filtersKey, hasRelativeFilter, isEmptyFilters } from './filter-model'
