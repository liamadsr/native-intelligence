/**
 * THE CITATION BEHIND A CANDIDATE — one definition, two readers.
 *
 * A prospect entry carries a per-ITEM citation: the page that surfaced this
 * company. It is the first MET signal's `evidence_url`, and failing that the
 * research blob's own `why_match.source_url`.
 *
 * This used to live twice — as `rowEvidenceUrl`/`hostOf` inside
 * `src/components/views/list/entity-row.tsx`, and nowhere else, because the
 * row was the only surface that showed it. The slim row moved the citation
 * into the entry panel (and keeps it inline only when "Why" is ticked), so two
 * components now need the same answer.
 *
 * IT LIVES IN `src/lib/prospecting/` AND NOT IN THE PAGE FOLDER on purpose:
 * `entity-row.tsx` belongs to the shared views system, which must never import
 * from a feature page package (`src/app/account/(dashboard)/prospecting/`).
 * A lib module is the one place both are allowed to reach.
 *
 * Both readers pass a LOOSE shape (`Record<string, unknown>` from the views
 * query, a typed `ProspectListEntryRow` from the page) so the parameter is
 * structural and every field is re-validated here rather than trusted.
 */

/** The blob this reads — the `research` jsonb column on `prospect_list_entry`. */
export interface EvidenceSource {
  /** `{ fields: { why_match: { value, source_url } } }`, or the bare bag. */
  research?: unknown
}

/**
 * The URL worth linking for this entry, or null.
 *
 * `why_fit.source_url` (the profile's own reasoning, anchored to the company's
 * site) wins over `why_match.source_url` (whatever the discovery search was
 * reading when it formed its opinion). There are no per-criterion signals any
 * more: discovery stopped scoring on 2026-09-05, so the only citations are the
 * two "why" sentences'.
 */
export function entryEvidenceUrl(entry: EvidenceSource): string | null {
  const blob = entry.research
  if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
    // The blob is sometimes `{ fields: {...} }` and sometimes the bare bag —
    // both shapes are written by the research pass depending on its vintage.
    const fields = (blob as { fields?: unknown }).fields
    const bag = (fields && typeof fields === 'object' ? fields : blob) as Record<string, unknown>
    for (const key of ['why_fit', 'why_match']) {
      const why = bag[key]
      if (why && typeof why === 'object' && !Array.isArray(why)) {
        const url = (why as { source_url?: unknown }).source_url
        if (typeof url === 'string' && url.trim()) return url.trim()
      }
    }
  }

  return null
}

/**
 * The display host of a URL — `www.` stripped, null when it will not parse.
 *
 * Callers use it for BOTH the human label ("Surfaced by techcrunch.com") and
 * the favicon lookup, so a null here must suppress the whole affordance rather
 * than produce a broken image pointing at an empty domain.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
