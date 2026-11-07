/**
 * The entry-list filters the two GET routes accept, parsed in ONE place.
 *
 * `GET /api/account/prospecting/lists/[id]` and `…/[id]/entries` both narrow
 * their reads by the same query string, and `listEntries` (lists.ts) pushes
 * every filter into SQL. Parsing in one module means neither route can drift
 * into accepting a value the other rejects — and with `kind` and the score
 * floor whitelisted here, a typo in a hand-built URL is ignored rather than
 * turned into an empty list.
 */
import {
  PROSPECT_ENTRY_KINDS,
  PROSPECT_ENTRY_STAGES,
  type ProspectEntryKind,
  type ProspectEntryStage,
} from './types'

export interface ParsedEntryFilters {
  stage?: ProspectEntryStage
  /** Keep only entries scored at or above this (0–100). Unscored entries are
   *  excluded — an unscored row is not a match, it is a row nobody has
   *  profiled yet. */
  min_fit_score?: number
  kind?: ProspectEntryKind
}

/**
 * Parse `?stage=&min_fit_score=&kind=` into the filter args `listEntries` takes.
 *
 * `min_fit_score` must be an integer in 0–100; anything else (a word, 150, a
 * blank) is left ABSENT rather than coerced, so `?min_fit_score=hot` is the
 * whole list and not an empty one. A floor of 0 is meaningful — it is "only
 * the scored rows" — and is kept.
 */
export function parseEntryFilters(searchParams: URLSearchParams): ParsedEntryFilters {
  const out: ParsedEntryFilters = {}

  const rawStage = searchParams.get('stage')
  if (rawStage && (PROSPECT_ENTRY_STAGES as readonly string[]).includes(rawStage)) {
    out.stage = rawStage as ProspectEntryStage
  }

  const rawKind = searchParams.get('kind')
  if (rawKind && (PROSPECT_ENTRY_KINDS as readonly string[]).includes(rawKind)) {
    out.kind = rawKind as ProspectEntryKind
  }

  const rawMin = searchParams.get('min_fit_score')
  if (rawMin !== null && /^\d{1,3}$/.test(rawMin.trim())) {
    const n = Number(rawMin.trim())
    if (n >= 0 && n <= 100) out.min_fit_score = n
  }

  return out
}
