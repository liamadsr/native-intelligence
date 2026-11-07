/**
 * Has this company been through the ACCOUNT CARD?
 *
 * ONE PREDICATE, ONE FILE. This used to live in the page's `ui-helpers.ts`,
 * which made it reachable only from the client bundle — so the agent lane
 * (`src/lib/ai/tools/prospecting.ts`) grew its own inline copy of the "is it
 * researched?" test, and the two disagreed about the fallback. A disagreement
 * here is not cosmetic: the predicate decides which companies a targeted
 * account-card run is allowed to skip, so one copy saying "not researched"
 * where the other says "researched" either double-bills a company or strands
 * it with no affordance.
 *
 * It lives in `src/lib/prospecting/` rather than under `src/app` because BOTH
 * lanes need it and only this side is server-safe. Pure TypeScript over a plain
 * object — no Supabase, no React, no schema import — so the page can keep
 * importing it through `ui-helpers.ts`'s re-export with no bundle cost.
 */

/**
 * The keys the account card produces, in the snake_case `groundedFields`
 * writes them (`camelToSnake` over the schema's camelCase property names).
 *
 * They are the FALLBACK evidence for {@link hasAccountCard}, not its primary
 * signal — see there for why a stamp had to exist at all. Kept as a literal
 * rather than derived from the schema object because deriving it would pull
 * `schemas.ts` (and its module-load `assertSchemaWithinCapDeep` calls) into
 * the client bundle for a nine-element array; the lockstep against
 * `PROSPECT_ACCOUNT_CARD` is pinned by a test instead
 * (`src/app/account/(dashboard)/prospecting/__tests__/gate-estimates.test.ts`).
 */
export const PROSPECT_ACCOUNT_CARD_KEYS = [
  'employee_count',
  'headquarters',
  'funding_stage',
  'total_raised',
  'growth_signals',
  'tech_stack',
  'products',
  'key_people',
  'why_fit',
] as const

/**
 * Has the ACCOUNT CARD run for this entry?
 *
 * THE ONE PREDICATE. Both halves of the page's gate, both list tabs, and the
 * agent's `find_prospects` card leg ask this question, and they must agree:
 * the research half offers the companies this returns false for, the people
 * half offers the companies it returns true for, and a disagreement between
 * them either double-bills a company or strands it with no affordance at all.
 *
 * WHY IT IS NOT "the research blob is non-empty", which is what it used to be.
 * Discovery writes a research blob too — `name`, `domain`, `one_liner`,
 * `why_match`, `signal`, `founded_year`, `employee_range` — so that test is
 * true for every company the moment it is discovered. Observed live: a list
 * of 45 reported "1 company to research" (the single hand-added entry, whose
 * blob really was empty) and offered to find people at the other 44, none of
 * which had ever had an account card run. The gate was not slightly wrong; it
 * was inverted.
 *
 * The primary signal is therefore the EXPLICIT stamp `candidate.account_card_at`,
 * written by `applyCard` in `src/lib/prospecting/account-run.ts` when a card
 * completes. The key-presence check below is kept only for rows enriched
 * before that stamp existed — no migration backfills it, because the stamp is
 * a claim about when something happened and inventing a timestamp for it would
 * be a worse lie than the heuristic.
 */
export function hasAccountCard(entry: {
  candidate?: unknown
  research?: unknown
}): boolean {
  const candidate =
    entry.candidate && typeof entry.candidate === 'object' && !Array.isArray(entry.candidate)
      ? (entry.candidate as { account_card_at?: unknown })
      : null
  const stamp = candidate?.account_card_at
  if (typeof stamp === 'string' && stamp.trim()) return true

  // ── Fallback: a pre-stamp row, recognised by the card's own keys ──
  //
  // Tolerates the two shapes the blob legitimately arrives in: `{ fields: {…} }`
  // (what the shared enrichment path writes) and a bare `{ key: {…} }` map.
  const blob = entry.research
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false
  const fields = (blob as { fields?: unknown }).fields
  const bag = (
    fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : blob
  ) as Record<string, unknown>
  return PROSPECT_ACCOUNT_CARD_KEYS.some((key) => bag[key] != null)
}
