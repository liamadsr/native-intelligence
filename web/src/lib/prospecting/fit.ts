/**
 * Fit — ONE score per company, written by the full profile.
 *
 * This module used to be a rule engine: five weighted ICP criteria substring-
 * matched against discovery's one-sentence blurb, an A–D tier, a confidence
 * grade and a signals list, all computed the moment a company was discovered
 * and "improved" later by the account card. Measured against the recorded
 * 25-result discovery response on 2026-09-05 it was noise: 16 of 21 companies
 * had no blurb to match, the buyer-title criterion could never fire, the
 * industry criterion fired once, and the A tier mostly meant "one ICP word
 * appeared in Exa's sentence and the company is in the US". Worse, that tier
 * gated which companies got the full profile — the only step that could have
 * produced the evidence the score needed.
 *
 * So the pipeline now matches Exa's own demo. Discovery does NOT score; it
 * keeps the search's why-match sentence as the row's "why". The full profile
 * (one own-domain-anchored deep search per company, `PROSPECT_ACCOUNT_CARD`)
 * asks the synthesis model for a 0–100 `fitScore` with the whole profile and
 * the ICP in hand, plus the `whyFit` paragraph behind it. That number is the
 * score, once. The user prunes first and profiles what is left, so no company
 * is paid for that they were going to dismiss.
 *
 * What remains deterministic here, because it is the USER'S rule and not the
 * model's opinion:
 *
 *   * {@link antiRuleHit} — an ICP `anti.exclude_industries` /
 *     `exclude_keywords` term found in the company's text. It zeroes the score
 *     at discovery AND after the profile, and the rationale names the rule, so
 *     a company the user said "never" to sinks to the bottom with a reason
 *     they can read.
 *   * {@link fitLabel} — the bands the number is read in (strong / good /
 *     partial / weak match), shared by the row, the panel and the agent so all
 *     three say the same word for the same number.
 *
 * Pure: no network, no database, no LLM. Client-safe (the row renderer in the
 * shared views system imports `fitLabel`).
 */
import type { Icp, ProspectFitLabel } from './types'

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** One grounded field as the research blob stores it. Only `value` is read
 *  here; the rest is carried so a `GroundedField` satisfies the type as-is. */
export interface FitInputField {
  value: string
  confidence?: string | null
  source_url?: string | null
  source_title?: string | null
}

/** What the anti-rule check reads: the blob's fields, plus the free Exa
 *  entity a discovery candidate may carry (headquarters, description). */
export interface FitInput {
  fields?: Record<string, FitInputField | undefined> | null
  entity?: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The floor of each band. Anything below `partial` is a weak match. */
export const FIT_LABEL_FLOOR: Record<Exclude<ProspectFitLabel, 'weak'>, number> = {
  strong: 80,
  good: 60,
  partial: 40,
}

/** The words. `short` is the row chip; `long` is the tooltip and the panel,
 *  and reads the way Exa's demo does ("HOT · STRONG FIT"). */
export const FIT_LABEL_TEXT: Record<ProspectFitLabel, { short: string; long: string }> = {
  // "match", never "fit" alone and never a temperature: the CRM's
  // relationship strength is hot/warm/cold, and the list must not sound like it.
  strong: { short: 'Strong match', long: 'Strong match' },
  good: { short: 'Good match', long: 'Good match' },
  partial: { short: 'Partial match', long: 'Partial match' },
  weak: { short: 'Weak match', long: 'Weak match' },
}

/** The band a score falls in, or null for an unscored entry. */
export function fitLabel(score: number | null | undefined): ProspectFitLabel | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  if (score >= FIT_LABEL_FLOOR.strong) return 'strong'
  if (score >= FIT_LABEL_FLOOR.good) return 'good'
  if (score >= FIT_LABEL_FLOOR.partial) return 'partial'
  return 'weak'
}

// ---------------------------------------------------------------------------
// Reading the card's number
// ---------------------------------------------------------------------------

/**
 * The card's `fitScore`, as an integer in 0–100, or null.
 *
 * `groundedFields` stringifies numbers, so the value arrives as "85". The
 * model occasionally decorates it ("85/100", "85 — strong") or answers the
 * question it was not asked (0.85): the first integer wins, a lone fraction
 * is read as a percentage, and anything else — a word, a blank, a number
 * out of range — is null rather than a guess.
 */
export function parseFitScore(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    return clampScore(raw > 0 && raw <= 1 && !Number.isInteger(raw) ? raw * 100 : raw)
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  const fraction = text.match(/^0?\.(\d+)$/)
  if (fraction) return clampScore(Number(`0.${fraction[1]}`) * 100)
  const integer = text.match(/-?\d+(?:\.\d+)?/)
  if (!integer) return null
  return clampScore(Number(integer[0]))
}

function clampScore(n: number): number | null {
  if (!Number.isFinite(n)) return null
  if (n < 0 || n > 100) return null
  return Math.round(n)
}

// ---------------------------------------------------------------------------
// The user's own rule: anti
// ---------------------------------------------------------------------------

export interface AntiRuleHit {
  /** The ICP term that matched, as the user wrote it. */
  term: string
  rule: 'excluded industry' | 'excluded keyword'
}

/**
 * Does any ICP exclusion term appear in what we know about this company?
 *
 * Whole-word, case-insensitive: "AI" must not fire on "retail", and a
 * two-word term matches as a phrase. Industries are checked before keywords
 * so the rationale names the more specific rule when both would fire.
 */
export function antiRuleHit(input: FitInput, icp: Icp): AntiRuleHit | null {
  const haystack = allText(input)
  if (!haystack) return null
  const industry = firstMention(haystack, icp.anti.exclude_industries)
  if (industry) return { term: industry, rule: 'excluded industry' }
  const keyword = firstMention(haystack, icp.anti.exclude_keywords)
  if (keyword) return { term: keyword, rule: 'excluded keyword' }
  return null
}

/** The rationale a zeroed score carries — a dismissal the user cannot explain
 *  is a dismissal they will override. */
export function antiRuleRationale(hit: AntiRuleHit): string {
  return `Matches ${hit.rule} "${hit.term}".`
}

function allText(input: FitInput): string {
  const parts: string[] = []
  for (const field of Object.values(input.fields ?? {})) {
    if (field && typeof field.value === 'string' && field.value.trim()) parts.push(field.value)
  }
  const entity = input.entity
  if (entity && typeof entity === 'object') {
    for (const value of Object.values(entity)) {
      if (typeof value === 'string' && value.trim()) parts.push(value)
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const inner of Object.values(value as Record<string, unknown>)) {
          if (typeof inner === 'string' && inner.trim()) parts.push(inner)
        }
      }
    }
  }
  return parts.join(' · ')
}

function firstMention(haystack: string, terms: readonly string[]): string | null {
  for (const raw of terms) {
    const term = raw.trim()
    if (!term) continue
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu')
    if (pattern.test(haystack)) return term
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// The one scoring call
// ---------------------------------------------------------------------------

export interface ProfileFit {
  /** 0–100, or null when the card returned no usable number. */
  fit_score: number | null
  /** The card's why-fit, else the discovery why-match, else what the entry
   *  already had — or the anti rule when one fired. */
  fit_rationale: string | null
}

/**
 * Score a company from its full profile.
 *
 * `card` is what THIS profile returned (its `fit_score` is read from here and
 * never from the blob, so a stale number from an earlier card cannot leak
 * through the additive merge); `merged` is the research blob after the card
 * was merged in, which is where the anti check and the rationale read from.
 */
export function scoreFromProfile(args: {
  card: Record<string, FitInputField | undefined>
  merged: Record<string, FitInputField | undefined>
  icp: Icp
  previousRationale?: string | null
}): ProfileFit {
  const anti = antiRuleHit({ fields: args.merged }, args.icp)
  if (anti) return { fit_score: 0, fit_rationale: antiRuleRationale(anti) }

  const fit_score = parseFitScore(args.card.fit_score?.value)
  const fit_rationale =
    args.merged.why_fit?.value?.trim() ||
    args.merged.why_match?.value?.trim() ||
    args.previousRationale?.trim() ||
    null
  return { fit_score, fit_rationale }
}
