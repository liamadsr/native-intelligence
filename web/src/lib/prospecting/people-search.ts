/**
 * READING `candidate.people_search` — what the last people search for a
 * company saw, in words. One reader for the list row (shared views system)
 * and the entry panel (page folder), which is why it lives in `lib`.
 *
 * The state it exists for: a search that returned people and kept none of
 * them, because every one was already known. Before the stamp that read as
 * "No people found yet", and the honest answer — "1 found, already in this
 * list" with the row it duplicates — was only in the run ledger.
 */

import {
  PEOPLE_SEARCH_KNOWN_CAP,
  PROSPECT_SUPPRESSION_SOURCES,
  type ProspectPeopleSearch,
  type ProspectSuppressionSource,
} from './types'

/** The stamp off an untyped candidate blob, or null when it is absent or
 *  unreadable. Every field is re-validated; a malformed entry in `known` is
 *  dropped rather than trusted. */
export function readPeopleSearch(candidate: unknown): ProspectPeopleSearch | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const raw = (candidate as { people_search?: unknown }).people_search
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const known = Array.isArray(rec.known)
    ? rec.known
        .map((k) => {
          if (!k || typeof k !== 'object') return null
          const item = k as Record<string, unknown>
          const by = item.by
          if (!PROSPECT_SUPPRESSION_SOURCES.includes(by as ProspectSuppressionSource)) return null
          return {
            name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null,
            by: by as ProspectSuppressionSource,
            ref_id: typeof item.ref_id === 'string' && item.ref_id ? item.ref_id : null,
          }
        })
        .filter((k): k is ProspectPeopleSearch['known'][number] => k !== null)
        .slice(0, PEOPLE_SEARCH_KNOWN_CAP)
    : []
  return {
    at: typeof rec.at === 'string' ? rec.at : '',
    found: num(rec.found),
    added: num(rec.added),
    known,
    capped: num(rec.capped),
    invalid: num(rec.invalid),
  }
}

/** The search returned people and kept none: every hit was already known
 *  (or over the cap). The state that used to read as "nobody found". */
export function foundOnlyKnownPeople(search: ProspectPeopleSearch | null): search is ProspectPeopleSearch {
  return search !== null && search.found > 0 && search.added === 0 && search.known.length > 0
}

/** The rule that turned a person away, as words that follow a name:
 *  "Theo Sandford · already in this list". */
export const KNOWN_PEOPLE_PHRASES: Record<ProspectSuppressionSource, string> = {
  this_list: 'already in this list',
  crm: 'already in your CRM',
  other_list: 'in another list',
  dismissed_global: 'dismissed as a competitor or customer',
  contacted: 'already contacted',
  opted_out: 'opted out',
  self: 'your own company',
  personal_domain: 'no company address',
  over_cap: 'more than you asked for',
  noise_host: 'not a company site',
}

/** "1 found, already in this list" / "3 found, already known". */
export function knownPeopleSummary(search: ProspectPeopleSearch): string {
  const n = search.found
  const rules = new Set(search.known.map((k) => k.by))
  const tail =
    rules.size === 1 && search.known.length === n
      ? KNOWN_PEOPLE_PHRASES[search.known[0].by]
      : 'already known'
  return `${n} found, ${tail}`
}

/** One line per known person, for a tooltip. */
export function knownPeopleLines(search: ProspectPeopleSearch): string[] {
  return search.known.map((k) => `${k.name ?? 'Someone'} — ${KNOWN_PEOPLE_PHRASES[k.by]}`)
}
