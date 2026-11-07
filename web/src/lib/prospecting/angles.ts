/**
 * Stage 2 discovery angles and the discovery systemPrompt (spec §7).
 *
 * The one place a model could plausibly earn its keep in this pipeline —
 * turning "who we sell to" into search angles — is instead DETERMINISTIC
 * TEMPLATES plus an editable `search_hint`. Cheaper, inspectable, replayable,
 * and it never surprises anyone at 3am with a query nobody wrote.
 *
 * Two exports:
 *
 *   * `buildDiscoveryAngles(icp, purpose, round)` — up to four angles, each
 *     one deep search, each carrying the OTHER phrasings as
 *     `additionalQueries`. Round 2 broadens two of the four rather than
 *     re-asking verbatim: a verbatim re-ask returns the same page of results
 *     and bills for it. Fewer than four come back when a thin ICP collapses
 *     two slots onto the same phrasing — paying twice for one question is the
 *     waste this module exists to avoid.
 *
 *   * `buildDiscoverySystemPrompt(icp, opts)` — the "Return UP TO N DISTINCT
 *     companies … NEVER include: …" prompt, with the source-company
 *     description and the `anti.exclude_*` terms.
 *
 * On the investors angle set, which is the reason `icp.target.comparables`
 * exists at all: the probe (§12) fired a NAIVE "VC funds that invest in AI"
 * angle and got back `lumenfoldstudio.vc`, `brisaseed.com.br`, `4096.vc` — obscure
 * funds that no founder would recognize. The mitigation is PORTFOLIO EVIDENCE:
 * every investor angle names `comparables[]`, so the search has something
 * verifiable to retrieve against rather than a category label. Investor
 * discovery quality remains unproven (§13); this is the mitigation, not a fix.
 *
 * A note on the suppression list: the prompt exclusion is soft — the probe
 * measured 2 of 30 named domains leaking back anyway. The post-filter in the
 * run engine is the correctness guarantee; naming domains here is a COST
 * optimization (fewer wasted result slots), which is why the cap is a flat 30
 * and not "however many we have".
 *
 * Pure: no network, no database, no LLM.
 */
import type { Icp, ProspectListPurpose } from './types'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The four angle slots per purpose. `buyers`/`partners`/`talent`/`custom`
 *  share the direct/lookalike/segment/signal vocabulary; investors get their
 *  own, because "segment" and "signal" mean nothing for a fund and the
 *  portfolio-evidence phrasing is the whole point. */
export const DISCOVERY_ANGLE_KEYS = [
  'direct',
  'lookalike',
  'segment',
  'signal',
  'thesis',
  'portfolio',
  'stage',
  'activity',
] as const
export type DiscoveryAngleKey = (typeof DISCOVERY_ANGLE_KEYS)[number]

export interface DiscoveryAngle {
  /** Which slot this is. Stamped onto every entry as `discovery_angle`, which
   *  is cheap telemetry that is unavailable retroactively: after a few weeks
   *  you can see which angles produce saved contacts and retire the rest. */
  key: DiscoveryAngleKey
  /** The deep-search `query`. */
  query: string
  /** The OTHER three angles' phrasings, ≤3, passed as Exa's
   *  `additionalQueries` so one paid call covers four framings. */
  additionalQueries: string[]
}

/** The MAXIMUM angles a round fires. Four is a measured choice: §12's cost
 *  model prices a round at ≈$0.11 with four angles at `numResults: 25`. A
 *  round fires fewer when the ICP is too thin to phrase four distinct
 *  questions — see `buildDiscoveryAngles`. */
export const DISCOVERY_ANGLES_PER_ROUND = 4

/** Exa caps `additionalQueries`; we cap at the three sibling phrasings. */
const MAX_ADDITIONAL_QUERIES = 3

/** §7: at most 30 suppressed domains reach the prompt. */
export const MAX_SUPPRESSED_DOMAINS_IN_PROMPT = 30

// ---------------------------------------------------------------------------
// Phrasing helpers
// ---------------------------------------------------------------------------

/** Join a list the way a person would read it: "a, b and c". Empty → ''. */
function phraseList(values: readonly string[], limit = 6): string {
  const items = values.map((v) => v.trim()).filter(Boolean).slice(0, limit)
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Squash whitespace and strip a trailing separator left by an empty slot. */
function tidy(query: string): string {
  return query
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/[,\s]+$/, '')
    .trim()
}

/**
 * Append `search_hint` to every angle — the power-user escape hatch, and the
 * reason there is no filter UI. It goes on the END so the template's subject
 * still leads the query.
 */
function withHint(query: string, hint: string): string {
  const base = tidy(query)
  const extra = hint.trim()
  if (!extra) return base
  if (!base) return extra
  return `${base}. ${extra}`
}

/**
 * Round-2 broadening. §7: round 2 appends a broadening clause to angles 3 and
 * 4 "rather than repeating verbatim — a verbatim re-ask returns the same page
 * of results". Rounds are 1-indexed; anything past 2 keeps broadening (the
 * clause names the round so successive rounds still differ from each other).
 */
function broaden(query: string, round: number): string {
  if (round <= 1) return query
  const clause =
    round === 2
      ? 'Include adjacent industries and smaller or earlier-stage companies that were not obvious in a first pass'
      : `Broaden further than the previous ${round - 1} passes: include adjacent categories, other regions and less well-known companies`
  return `${query}. ${clause}`
}

/** Which slots broaden in round 2 — the two narrowest ones, by index. */
const BROADENED_SLOTS = [2, 3] as const

// ---------------------------------------------------------------------------
// Per-purpose templates
// ---------------------------------------------------------------------------

/** One angle before the hint, the broadening clause and the sibling queries
 *  are woven in. */
interface AngleSeed {
  key: DiscoveryAngleKey
  query: string
}

/** The buyers/partners/talent/custom set (§7). Each falls back to the direct
 *  phrasing when its own inputs are empty; `buildDiscoveryAngles` then drops
 *  the resulting duplicate rather than billing for it twice. */
function generalAngles(icp: Icp, purpose: ProspectListPurpose): AngleSeed[] {
  const sells = icp.source.what_we_sell.trim()
  const description = icp.target.description.trim()
  const industries = phraseList(icp.target.industries)
  const bands = phraseList(icp.target.employee_bands)
  const geos = phraseList(icp.target.geographies)
  const titles = phraseList(icp.target.buyer_titles)
  const customers = phraseList(icp.source.our_customers)
  const useCases = phraseList(icp.target.use_cases)

  // 1 — Direct. The ICP's own words, which is why `target.description` is THE
  // field and everything else is optional narrowing.
  const directSubject =
    description || useCases || industries || 'companies that match this buyer profile'
  const direct = sells
    ? verbForPurpose(purpose, sells, directSubject)
    : `Companies matching this profile: ${directSubject}`

  // 2 — Lookalike. Falls back to angle 1's wording when we know no customers,
  // per §7, rather than firing an empty "companies similar to".
  const lookalike = customers
    ? `Companies similar to ${customers}`
    : direct

  // 3 — Segment. The firmographic narrowing, assembled from whichever parts
  // exist; with none of them it degrades to the direct phrasing.
  const segmentParts = [
    industries || 'Companies',
    bands ? `with ${bands} employees` : '',
    geos ? `in ${geos}` : '',
  ].filter(Boolean)
  const segment = segmentParts.length > 1 ? segmentParts.join(' ') : direct

  // 4 — Signal. Hiring or funding evidence, which is what makes a candidate
  // timely rather than merely plausible.
  //
  // The noun is appended ONLY when the subject is a bare industry list
  // ("Fintech" -> "Fintech companies hiring..."). When `industries` is empty
  // the subject falls back to `directSubject`, which is usually already a
  // clause ending in "companies" — appending again produced "…growing sales
  // teams companies that are hiring", broken grammar in a query we PAY for and
  // whose phrasing is the whole of its retrieval quality.
  const signal = industries
    ? titles
      ? `${industries} companies hiring ${titles} or recently funded`
      : `${industries} companies that are hiring or recently funded`
    : titles
      ? `${directSubject}, hiring ${titles} or recently funded`
      : `${directSubject}, that are hiring or recently funded`

  return [
    { key: 'direct', query: direct },
    { key: 'lookalike', query: lookalike },
    { key: 'segment', query: segment },
    { key: 'signal', query: signal },
  ]
}

/** The direct angle's verb changes with purpose — "would buy", "would partner
 *  with", "we would hire from" — which is the whole of what `purpose` does to
 *  a general-set angle. */
function verbForPurpose(purpose: ProspectListPurpose, sells: string, subject: string): string {
  switch (purpose) {
    case 'partners':
      return `Companies whose product complements ${sells} and would partner or integrate with it: ${subject}`
    case 'talent':
      return `Companies working on problems close to ${sells}, whose people we would want to hire: ${subject}`
    default:
      return `Companies that would buy ${sells}: ${subject}`
  }
}

/**
 * The investors set. EVERY angle names `comparables[]` or another concrete
 * evidence anchor, because §12 measured that the naive category phrasing does
 * not work. When `comparables` is empty we fall back through competitors →
 * our_customers → industries + use_cases, in that order, so the phrasing stays
 * evidence-shaped as long as we have any evidence at all.
 */
function investorAngles(icp: Icp): AngleSeed[] {
  const comparables = icp.target.comparables.length > 0
    ? icp.target.comparables
    : icp.target.competitors.length > 0
      ? icp.target.competitors
      : icp.source.our_customers
  const comparablePhrase = phraseList(comparables)
  const pairPhrase = phraseList(comparables.slice(0, 2), 2)
  const industries = phraseList(icp.target.industries)
  const useCases = phraseList(icp.target.use_cases)
  const description = icp.target.description.trim()
  const sells = icp.source.what_we_sell.trim()

  // The category label, used only as the LAST resort and never alone in an
  // angle that could have named a company instead.
  const category = industries || useCases || description || sells || 'this category'

  // 1 — Portfolio evidence: the strongest phrasing, and the one the probe's
  // successful investors fixture actually used.
  const portfolio = comparablePhrase
    ? `Venture funds that led seed or Series A rounds in ${comparablePhrase}`
    : `Venture funds that led seed or Series A rounds in ${category} startups`

  // 2 — Named co-investors: two comparables, which retrieves cap tables rather
  // than fund marketing pages.
  const stage = pairPhrase
    ? `Investors in ${pairPhrase}, and the funds that co-invested alongside them`
    : `Investors who led early rounds in ${category}, and the funds that co-invested alongside them`

  // 3 — Published thesis, anchored on use cases (what the fund says it looks
  // for), still naming the comparables as the proof.
  const thesisSubject = useCases || description || category
  const thesis = comparablePhrase
    ? `Venture funds whose published investment thesis names ${thesisSubject}, with portfolio companies such as ${comparablePhrase}`
    : `Venture funds whose published investment thesis names ${thesisSubject}`

  // 4 — Recent activity, time-boxed so the round finds live funds.
  const activity = comparablePhrase
    ? `Venture funds that have invested in ${industries || category} in the last 18 months, including backers of ${comparablePhrase}`
    : `Venture funds that have invested in ${industries || category} in the last 18 months`

  return [
    { key: 'portfolio', query: portfolio },
    { key: 'stage', query: stage },
    { key: 'thesis', query: thesis },
    { key: 'activity', query: activity },
  ]
}

// ---------------------------------------------------------------------------
// buildDiscoveryAngles
// ---------------------------------------------------------------------------

/**
 * The angles for one round — up to {@link DISCOVERY_ANGLES_PER_ROUND}, and
 * fewer when a thin ICP collapses two slots onto the same phrasing.
 *
 * `round` is 1-indexed. Round 1 is the templates verbatim; round 2 broadens
 * the two narrowest slots (segment/signal, or stage/activity for investors) so
 * the second paid pass retrieves a different page of results than the first.
 *
 * `search_hint` is appended to EVERY surviving query AND to every
 * `additionalQueries` phrasing, because Exa treats each additional query as a
 * retrieval in its own right — a hint that only reached the primary query
 * would be silently ignored by three quarters of the round.
 */
export function buildDiscoveryAngles(
  icp: Icp,
  purpose: ProspectListPurpose,
  round = 1,
): DiscoveryAngle[] {
  const seeds = purpose === 'investors' ? investorAngles(icp) : generalAngles(icp, purpose)
  const hint = icp.search_hint

  // Broaden BEFORE the hint so the hint stays the last clause in the query —
  // it is the user's words and they should not be buried mid-sentence.
  const phrased = seeds.map((seed, index) =>
    withHint(
      BROADENED_SLOTS.includes(index as (typeof BROADENED_SLOTS)[number])
        ? broaden(seed.query, round)
        : seed.query,
      hint,
    ),
  )

  // Collapse duplicate PRIMARIES before returning.
  //
  // On a thin ICP — no `our_customers`, no `industries`, which is the common
  // case for a list seeded straight from onboarding — the lookalike and
  // segment slots both fall back to the direct phrasing (§7 says they should),
  // leaving three byte-identical queries. Firing all four would bill four deep
  // searches, at ≈$0.027 each, for two distinct questions: ≈$0.054 wasted per
  // round, against §9 caps that are sized assuming four DISTINCT angles.
  //
  // So a round is "UP TO {@link DISCOVERY_ANGLES_PER_ROUND} angles". The first
  // slot to produce a given query keeps it; later duplicates are dropped
  // rather than re-phrased, because the alternative — inventing a filler
  // phrasing for a slot whose inputs the user never supplied — spends the same
  // money on a question the ICP does not support asking.
  const seenPrimary = new Set<string>()
  const kept: number[] = []
  for (let index = 0; index < phrased.length; index++) {
    const key = phrased[index].toLowerCase()
    if (!phrased[index] || seenPrimary.has(key)) continue
    seenPrimary.add(key)
    kept.push(index)
  }

  return kept.map((index) => ({
    key: seeds[index].key,
    query: phrased[index],
    additionalQueries: dedupeQueries(
      kept.filter((other) => other !== index).map((other) => phrased[other]),
      phrased[index],
    ).slice(0, MAX_ADDITIONAL_QUERIES),
  }))
}

/** Drop blanks, exact duplicates, and anything identical to the primary query
 *  — the lookalike/segment fallbacks legitimately collapse onto the direct
 *  phrasing on a thin ICP, and paying to ask the same question twice in one
 *  call is the exact waste this module exists to avoid. */
function dedupeQueries(queries: string[], primary: string): string[] {
  const seen = new Set<string>([primary.toLowerCase()])
  const out: string[] = []
  for (const q of queries) {
    const key = q.toLowerCase()
    if (!q || seen.has(key)) continue
    seen.add(key)
    out.push(q)
  }
  return out
}

// ---------------------------------------------------------------------------
// buildDiscoverySystemPrompt
// ---------------------------------------------------------------------------

export interface DiscoverySystemPromptOptions {
  /**
   * Domains the round must not return. CAPPED AT 30 (§7): the prompt is a cost
   * optimization, not the correctness guarantee — the probe measured 2 of 30
   * named domains leaking back regardless — so past 30 the marginal domain
   * buys nothing and costs prompt budget. Prefer CRM domains and this list's
   * own keys, which the caller orders.
   */
  suppressedDomains?: readonly string[]
  /** The "UP TO N DISTINCT companies" number. Deliberately BELOW `numResults`:
   *  §12 asked for 20 against `numResults: 25` and got 20 entries. */
  targetCount?: number
  /** What we are looking for, as a noun: 'companies', 'venture funds'. */
  noun?: string
}

const DEFAULT_TARGET_COUNT = 20

/** Noun by purpose. Investors get "venture funds" because "companies" makes
 *  the model return the funds' portfolio companies instead of the funds. */
export function discoveryNounFor(purpose: ProspectListPurpose): string {
  return purpose === 'investors' ? 'venture funds' : 'companies'
}

/**
 * The discovery systemPrompt.
 *
 * Three jobs, in order: state who is searching (the source-company
 * description, so "companies like our customers" has a referent), state the
 * output contract (N distinct entries, one per company, each with a domain),
 * and name what must never come back (the suppressed domains and the `anti`
 * terms). The `anti` terms are ALSO applied as a client-side post-filter on
 * names and descriptions — same reason as the domains: the prompt is soft.
 */
export function buildDiscoverySystemPrompt(
  icp: Icp,
  opts: DiscoverySystemPromptOptions = {},
): string {
  const targetCount = Math.max(1, Math.floor(opts.targetCount ?? DEFAULT_TARGET_COUNT))
  const noun = (opts.noun ?? 'companies').trim() || 'companies'
  const lines: string[] = []

  // ── who is searching ─────────────────────────────────────────────────
  const name = icp.source.name.trim()
  const domain = icp.source.domain.trim()
  const sells = icp.source.what_we_sell.trim()
  if (name || domain || sells) {
    const label = name && domain ? `${name} (${domain})` : name || domain
    lines.push(`Prospecting for the source company. Source: ${label}${sells ? `: ${sells}` : ''}.`)
  }

  // ── the output contract ──────────────────────────────────────────────
  lines.push(
    `Return UP TO ${targetCount} DISTINCT ${noun}, one entry per ${singular(noun)}, ` +
      `each with its primary website domain. Skip anything without a clear domain.`,
  )

  // ── the anti terms ───────────────────────────────────────────────────
  const excludeIndustries = phraseList(icp.anti.exclude_industries, 12)
  if (excludeIndustries) {
    lines.push(`Do not include ${excludeIndustries} ${noun}.`)
  }
  const excludeKeywords = icp.anti.exclude_keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 12)
  if (excludeKeywords.length > 0) {
    lines.push(
      `Exclude anything whose name or description mentions: ${excludeKeywords.join(', ')}.`,
    )
  }
  const notes = icp.anti.notes.trim()
  if (notes) lines.push(notes)

  // ── the suppression list ─────────────────────────────────────────────
  const suppressed = capSuppressedDomains(opts.suppressedDomains ?? [])
  if (suppressed.length > 0) {
    lines.push(`NEVER include any of these already-known domains: ${suppressed.join(', ')}.`)
  }

  return lines.join('\n')
}

/** Normalize, dedupe and cap the prompt's suppression list at 30. Exported so
 *  the run engine can show the user exactly what it sent. */
export function capSuppressedDomains(domains: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase()
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    out.push(domain)
    if (out.length >= MAX_SUPPRESSED_DOMAINS_IN_PROMPT) break
  }
  return out
}

/** "companies" → "company", "venture funds" → "venture fund". Naive on
 *  purpose: it only ever sees the two nouns above. */
function singular(noun: string): string {
  if (noun.endsWith('ies')) return `${noun.slice(0, -3)}y`
  if (noun.endsWith('s')) return noun.slice(0, -1)
  return noun
}
