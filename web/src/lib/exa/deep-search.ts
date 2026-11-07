/**
 * Exa Deep Search — the ONE Exa client for the whole app.
 *
 * Exa's documented enrichment recipe is a single request:
 *
 *   POST https://api.exa.ai/search
 *   { query, type: 'deep', category: 'company' | 'people', numResults: 5,
 *     outputSchema: { … }, contents: { maxAgeHours: 24 } }
 *
 * The response carries `output.content` (a synthesized card shaped by the
 * schema) and `output.grounding` (per-field citations + a confidence), plus the
 * bare `results` and a `costDollars` total. Exa does the searching, the reading
 * AND the extraction, so there is no LLM in our loop at all: the grounding IS
 * the confidence signal the CRM write-back gates on.
 *
 * WHY NOT THE GATEWAY `web_search`/`exaSearch` TOOL: the Vercel AI Gateway's
 * provider-executed Exa tool validates `type` against auto|fast|instant. It
 * cannot express `type: 'deep'`, cannot send an `outputSchema`, and returns no
 * grounding. Proven live. So this goes straight to Exa with `EXA_API_KEY`.
 *
 * PURE + INJECTABLE: `fetchImpl` is a parameter so tests exercise the
 * request/response mapping without a network call or an API key. No React, no
 * Supabase, no DB.
 */

export const EXA_SEARCH_URL = 'https://api.exa.ai/search'

/**
 * Upper bound on one deep search. Exa quotes 4-15s for `deep`; 60s is generous
 * headroom that still fits comfortably inside the Inngest route's
 * `maxDuration = 300` alongside the DB write-back.
 */
export const DEEP_SEARCH_TIMEOUT_MS = 60_000

/** Exa's recipe: five results feed the synthesis. */
export const DEEP_SEARCH_NUM_RESULTS = 5

/**
 * Freshness target for the crawled content, per Exa's recipe. A day, because
 * the card is meant to reflect headcount/funding/news as they stand right now
 * and an enrichment run happens rarely per entity.
 */
export const DEEP_SEARCH_MAX_AGE_HOURS = 24

/**
 * Exa's hard ceiling on `outputSchema` properties, counted RECURSIVELY across
 * the whole schema. Exceeding it is a 400:
 *
 *   Validation error: Output_schema exceeds maximum of 10 properties
 *     at "outputSchema"
 *
 * Nesting buys nothing — an object property whose own `properties` hold 10
 * inner fields 400s just the same, so the count is total and not per-level.
 * This is why each entity is described by an ARRAY of <=10-property cards
 * (COMPANY_CARD_SCHEMAS / PERSON_CARD_SCHEMAS) merged after the fact rather
 * than by one rich schema.
 */
export const MAX_OUTPUT_SCHEMA_PROPERTIES = 10

/** Thrown before any fetch when EXA_API_KEY is absent from the environment. */
export class ExaNotConfiguredError extends Error {
  constructor(message = 'EXA_API_KEY is not configured') {
    super(message)
    this.name = 'ExaNotConfiguredError'
  }
}

/** Thrown when Exa answers with a non-2xx or an unusable body. */
export class ExaRequestError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ExaRequestError'
    this.status = status
  }
}

export type Confidence = 'low' | 'medium' | 'high'

/** One card field flattened for storage: the value, what states it, how sure. */
export interface GroundedField {
  value: string
  source_url: string | null
  /** Title of that citation. Carried because the relevance gate reads it (a
   *  Crunchbase page titled "Dial8 - Crunchbase Company Profile" proves the
   *  citation is about THIS company even though the host is an aggregator).
   *  Blob-only: it never reaches a column patch. */
  source_title: string | null
  confidence: Confidence
}

export interface DeepSearchGrounding {
  field: string
  citations: Array<{ url: string; title: string | null }>
  confidence: Confidence
}

/**
 * One `results[i].entities[j]`, kept verbatim off the wire.
 *
 * ADDITIVE, and deliberately loose: `properties` is whatever Exa attached
 * (`name`, `foundedYear`, `description`, `workforce`, `headquarters`,
 * `financials`, `webTraffic`…), and the shape varies by category and over
 * time. Everything that reads it goes through `resultEntities()`, which picks
 * out only the members it can type.
 */
export interface DeepSearchEntity {
  /** A stable Exa id, e.g. `https://exa.ai/library/organization/<id>`. */
  id: string | null
  /** 'company' | 'person' | anything Exa adds later. */
  type: string | null
  properties: Record<string, unknown>
}

export interface DeepSearchResultItem {
  url: string
  title: string | null
  publishedDate: string | null
  /**
   * Exa's free firmographics for this result (§12). Absent on responses that
   * carried none, so every pre-existing reader is untouched.
   */
  entities?: DeepSearchEntity[]
}

export interface DeepSearchResult {
  requestId: string | null
  /** `output.content` verbatim — the synthesized card, shaped by outputSchema. */
  content: Record<string, unknown> | null
  grounding: DeepSearchGrounding[]
  results: DeepSearchResultItem[]
  costDollars: number | null
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function isConfidence(v: unknown): v is Confidence {
  return v === 'low' || v === 'medium' || v === 'high'
}

/**
 * camelCase → snake_case. The Exa schemas are camelCase (Exa's own recipe
 * naming) while every CRM blob key is snake_case, so the two are bridged here
 * rather than by duplicating the schema in both cases.
 */
export function camelToSnake(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/**
 * Reduce a grounding `field` path to the schema key it addresses. Exa reports
 * paths as a bare key ("industry"), a dotted path ("content.industry") or an
 * indexed one ("companies[0].industry"), so resolve on the LAST segment with
 * any array subscript stripped.
 */
export function fieldKeyFromPath(path: string): string {
  return path.split('.').pop()?.replace(/\[\d+\]$/, '').trim() ?? ''
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface DeepSearchArgs {
  query: string
  category?: 'company' | 'people'
  outputSchema: object
  additionalQueries?: string[]
  /**
   * Restrict retrieval to these domains. Exa DOES accept this on the company
   * category (unlike excludeDomains and the date filters, which 400), and it
   * is the strongest identity anchor there is: a card built only from the
   * company's own site cannot describe a different company.
   */
  includeDomains?: string[]
  /**
   * Free-text instructions attached to the extraction, above the query.
   *
   * ADDITIVE and optional: every pre-existing caller omits it and sends the
   * byte-identical body it always did. Prospecting's discovery round needs it
   * for the two things a query string cannot express — the output contract
   * ("UP TO 20 DISTINCT companies, one per entry, each with a domain") and the
   * suppression hint (§7). The hint is a COST OPTIMIZATION ONLY: the measured
   * leak is 2 of 30 named domains coming back anyway, so the post-filter in
   * `admitCandidates` remains the correctness guarantee.
   */
  systemPrompt?: string
  numResults?: number
  maxAgeHours?: number
  /** Defaults to `process.env.EXA_API_KEY`. */
  apiKey?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/**
 * Total number of properties in a JSON schema, counting nested object
 * properties too — which is how Exa counts them. A property that is itself an
 * object contributes 1 for itself PLUS everything inside it, so no amount of
 * nesting gets a fat schema under the cap.
 */
export function countSchemaProperties(schema: unknown): number {
  const node = asRecord(schema)
  const props = asRecord(node?.properties)
  if (!props) return 0
  let total = 0
  for (const value of Object.values(props)) {
    total += 1 + countSchemaProperties(value)
  }
  return total
}

/**
 * The SAME count as Exa's server makes — which recurses into array `items`
 * as well as object `properties`.
 *
 * `countSchemaProperties` above deliberately never descends into `items`, and
 * for the flat entity cards that is the same number. For a LIST card it is
 * not, and the difference is a measured 400 (§12 of docs/plans/prospecting.md):
 * a `companies[]` array whose item shape carried 12 properties returned
 * `HTTP 400 "Output_schema exceeds maximum of 10 properties"` while the
 * shallow counter reported **1**. So the local validator would have waved
 * through a schema the server rejects, and the failure would surface minutes
 * into an already-billed run.
 *
 * The array itself costs 1, exactly like an object property, so a list card
 * has room for at most 9 leaf properties in its item shape.
 *
 * Kept as a SIBLING rather than a replacement: `countSchemaProperties` is
 * exported and already asserted against in existing tests and in
 * `prospecting/schemas.ts`, and its shallow number is still the useful one
 * when reasoning about a flat card.
 */
export function countSchemaPropertiesDeep(schema: unknown): number {
  const node = asRecord(schema)
  if (!node) return 0
  let total = 0
  const props = asRecord(node.properties)
  if (props) {
    for (const value of Object.values(props)) {
      total += 1 + countSchemaPropertiesDeep(value)
    }
  }
  // An array contributes its ITEM shape's properties, which is the half Exa
  // counts and the shallow counter does not. `items` may be a tuple.
  const items = node.items
  if (Array.isArray(items)) {
    for (const member of items) total += countSchemaPropertiesDeep(member)
  } else if (items) {
    total += countSchemaPropertiesDeep(items)
  }
  return total
}

/**
 * Fail a too-large schema HERE rather than paying for a round trip to be told
 * so. A plain `Error` on purpose: this is a programming mistake in our own
 * schema definitions, not an upstream condition, so it must never be mistaken
 * for a transient Exa failure that the enrichment lane would retry (and
 * re-bill) forever.
 *
 * BOTH counters are checked, and the reported number is the larger of the two
 * — the deep one is what the server enforces, the shallow one is what every
 * pre-existing call site was already sized against, and taking the max means
 * neither can be exceeded silently.
 */
function assertSchemaFitsCap(schema: object): void {
  const count = Math.max(countSchemaProperties(schema), countSchemaPropertiesDeep(schema))
  if (count > MAX_OUTPUT_SCHEMA_PROPERTIES) {
    throw new Error(
      `Exa outputSchema has ${count} properties, exceeding the maximum of ` +
        `${MAX_OUTPUT_SCHEMA_PROPERTIES}. Split it into multiple cards and ` +
        'merge the results with mergeDeepSearchResults().',
    )
  }
}

/**
 * The module-load guard schema authors call: same rule as
 * {@link assertSchemaFitsCap}, exported so an over-cap card cannot even be
 * imported rather than failing minutes into a paid run.
 *
 * `label` names the offending card in the message, because by the time this
 * throws the stack is a module-evaluation trace with no schema in it.
 */
export function assertSchemaWithinCapDeep(schema: object, label: string): void {
  const shallow = countSchemaProperties(schema)
  const deep = countSchemaPropertiesDeep(schema)
  const count = Math.max(shallow, deep)
  if (count > MAX_OUTPUT_SCHEMA_PROPERTIES) {
    throw new Error(
      `${label} has ${count} properties (${shallow} shallow, ${deep} deep as Exa ` +
        `counts them), exceeding Exa's maximum of ${MAX_OUTPUT_SCHEMA_PROPERTIES}.`,
    )
  }
}

/**
 * Build the exact request body Exa's recipe sends.
 *
 * DELIBERATELY ABSENT: `startPublishedDate`, `endPublishedDate` and
 * `excludeDomains`. The company/people categories reject all three with a 400,
 * and the failure looks like a schema problem rather than a filter problem.
 */
export function buildDeepSearchBody(args: {
  query: string
  category?: 'company' | 'people'
  outputSchema: object
  additionalQueries?: string[]
  includeDomains?: string[]
  systemPrompt?: string
  numResults?: number
  maxAgeHours?: number
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: args.query,
    type: 'deep',
    numResults: args.numResults ?? DEEP_SEARCH_NUM_RESULTS,
  }
  if (args.category) body.category = args.category
  assertSchemaFitsCap(args.outputSchema)
  body.outputSchema = args.outputSchema
  body.contents = { maxAgeHours: args.maxAgeHours ?? DEEP_SEARCH_MAX_AGE_HOURS }
  if (args.additionalQueries?.length) body.additionalQueries = args.additionalQueries
  if (args.includeDomains?.length) body.includeDomains = args.includeDomains
  // Only sent when non-empty, so a caller that passes '' produces the same
  // body as one that passes nothing.
  if (args.systemPrompt?.trim()) body.systemPrompt = args.systemPrompt.trim()
  return body
}

/**
 * Map Exa's response body into `DeepSearchResult`. Tolerant by construction:
 * a missing `output`, a missing grounding array, or junk members are all read
 * as "nothing there" rather than throwing, because a thin answer is a normal
 * outcome for an obscure entity and the caller decides what to do with it.
 */
export function parseDeepSearchResponse(json: unknown): DeepSearchResult {
  const root = asRecord(json)
  if (!root) throw new ExaRequestError('Exa returned a non-object response body.')

  const output = asRecord(root.output)
  const content = asRecord(output?.content)

  const grounding: DeepSearchGrounding[] = []
  for (const raw of Array.isArray(output?.grounding) ? output.grounding : []) {
    const g = asRecord(raw)
    if (!g) continue
    const field = nonEmptyString(g.field)
    if (!field) continue
    const citations: Array<{ url: string; title: string | null }> = []
    for (const c of Array.isArray(g.citations) ? g.citations : []) {
      const cite = asRecord(c)
      const url = nonEmptyString(cite?.url)
      if (!url) continue
      citations.push({ url, title: nonEmptyString(cite?.title) })
    }
    grounding.push({
      field,
      citations,
      confidence: isConfidence(g.confidence) ? g.confidence : 'low',
    })
  }

  const results: DeepSearchResult['results'] = []
  for (const raw of Array.isArray(root.results) ? root.results : []) {
    const r = asRecord(raw)
    const url = nonEmptyString(r?.url)
    if (!url) continue
    const item: DeepSearchResultItem = {
      url,
      title: nonEmptyString(r?.title),
      publishedDate: nonEmptyString(r?.publishedDate),
    }
    // ADDITIVE: only set when Exa actually sent entities, so a response
    // without them parses to exactly the object it always did.
    const entities: DeepSearchEntity[] = []
    for (const rawEntity of Array.isArray(r?.entities) ? (r.entities as unknown[]) : []) {
      const e = asRecord(rawEntity)
      if (!e) continue
      entities.push({
        id: nonEmptyString(e.id),
        type: nonEmptyString(e.type),
        properties: asRecord(e.properties) ?? {},
      })
    }
    if (entities.length > 0) item.entities = entities
    results.push(item)
  }

  const cost = asRecord(root.costDollars)?.total
  return {
    requestId: nonEmptyString(root.requestId),
    content,
    grounding,
    results,
    costDollars: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  }
}

/** Run one Exa Deep Search and map the response. */
export async function deepSearch(args: DeepSearchArgs): Promise<DeepSearchResult> {
  const apiKey = args.apiKey ?? process.env.EXA_API_KEY
  // BEFORE any fetch: a missing key is a configuration problem, not a request
  // failure, and the caller classifies it as transient (it heals when the env
  // var lands) rather than burning a permanent-failure marker on the row.
  if (!apiKey) throw new ExaNotConfiguredError()

  const fetchImpl = args.fetchImpl ?? fetch
  const body = buildDeepSearchBody(args)

  const res = await fetchImpl(EXA_SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
    signal: args.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ExaRequestError(
      `Exa deep search failed (${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`,
      res.status,
    )
  }

  const json = (await res.json().catch(() => null)) as unknown
  return parseDeepSearchResponse(json)
}

/**
 * Fold the per-card results of one entity's concurrent searches into a single
 * `DeepSearchResult`, so everything downstream (`groundedFields`, `sourcesOf`,
 * the whole write-back) stays card-agnostic.
 *
 * Merge rules, in the order the cards were given:
 *   - content: shallow merge, FIRST NON-EMPTY WINS. A later card never
 *     overwrites a value an earlier one already found — the cards are ordered
 *     by importance (CORE first), so when both name a field the authoritative
 *     card is the one that keeps it. Blank/whitespace values do not count as
 *     found, so a later card can still fill a field the first left empty.
 *   - grounding: concatenated. Duplicate field paths are harmless — the first
 *     entry wins in `groundedFields`, matching the content rule above.
 *   - results: de-duplicated by url, first occurrence keeping its position.
 *   - costDollars: summed across the cards that reported one; null only when
 *     NONE did, so the blob records what the entity actually cost in total.
 *   - requestId: the first non-null, purely as a debugging handle.
 */
export function mergeDeepSearchResults(results: DeepSearchResult[]): DeepSearchResult {
  const content: Record<string, unknown> = {}
  const grounding: DeepSearchGrounding[] = []
  const seenUrls = new Set<string>()
  const merged: DeepSearchResult['results'] = []
  let requestId: string | null = null
  let cost = 0
  let sawCost = false
  let sawContent = false

  for (const res of results) {
    if (!requestId) requestId = res.requestId

    if (res.content) {
      sawContent = true
      for (const [key, value] of Object.entries(res.content)) {
        // "Already found" means a value that survives the same emptiness test
        // `groundedFields` applies, so a first card returning '' does not
        // shadow a second card's real answer.
        const held = content[key]
        const heldIsEmpty =
          held == null ||
          (typeof held === 'string' && held.trim() === '') ||
          (Array.isArray(held) && held.length === 0)
        if (!heldIsEmpty) continue
        content[key] = value
      }
    }

    grounding.push(...res.grounding)

    for (const r of res.results) {
      if (seenUrls.has(r.url)) continue
      seenUrls.add(r.url)
      merged.push(r)
    }

    if (res.costDollars != null) {
      cost += res.costDollars
      sawCost = true
    }
  }

  return {
    requestId,
    // Distinguish "no card returned any content object" (null, which the
    // caller reads as a total miss) from "every card returned an empty one".
    content: sawContent ? content : null,
    grounding,
    results: merged,
    costDollars: sawCost ? cost : null,
  }
}

// ---------------------------------------------------------------------------
// Non-answers and look-alike domains
// ---------------------------------------------------------------------------

/*
 * Exa fills an optional field it could not answer with a PLACEHOLDER rather
 * than leaving it out: "Not publicly disclosed", "Not explicitly disclosed",
 * "Not available". Those arrive grounded at medium confidence, so without this
 * filter they sail through the column gate — on the first live DEV run the
 * `annual_revenue_range` column was literally written with the string
 * "Not publicly disclosed".
 *
 * These are ABSENCES, not facts, so they are dropped in `groundedFields`
 * before anything downstream sees them: no column, no blob, no "the card had a
 * confident field" signal for the namesake guard.
 *
 * Each pattern is anchored at BOTH ends (allowing only trailing punctuation or
 * a parenthetical such as "(as of 2026)"), because a placeholder is the WHOLE
 * value. That anchoring is what keeps real values alive: "Not-for-profit
 * organization" is not "not ... provided", and "Unknown Worlds Entertainment"
 * is not "unknown".
 */
const NON_ANSWER_PATTERNS: RegExp[] = [
  // n/a, na, none, null, unknown, undisclosed, unavailable
  /^(?:n\/?a|none|null|unknown|undisclosed|unavailable)$/,
  // not [publicly|explicitly|currently] disclosed / available / known / ...
  /^not\s+(?:publicly\s+|explicitly\s+|currently\s+)?(?:disclosed|available|known|found|listed|provided|specified|stated|applicable)$/,
  // no [public] information / data / details [available]
  /^no\s+(?:public\s+)?(?:information|data|details)(?:\s+available)?$/,
  /^information\s+not\s+available$/,
  // none found / nothing found / no profile found / no website available —
  // seen live for twitter_url/github_url ("None found").
  /^(?:none|nothing)\s+(?:found|available|listed|known)$/,
  /^no\s+(?:public\s+)?(?:\w+\s+)?(?:profile|website|handle|page|account|url|link)(?:\s+(?:found|available|listed|known))?$/,
  // A lone dash is Exa's other way of saying "nothing here".
  /^[—–-]$/,
]

/**
 * True when a value is Exa's way of saying "I could not find this" rather than
 * a fact worth storing.
 *
 * Trailing punctuation and a single trailing parenthetical are tolerated (in
 * either order), so "Not publicly disclosed.", "Not publicly disclosed (as of
 * 2026)" and "Not applicable (venue/space)." all count — but any other trailing prose does not, because that would be a real
 * sentence carrying real information.
 */
export function isNonAnswer(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return true
  // Strip one trailing parenthetical and any trailing punctuation, then test
  // the remainder as a whole. Anything left over means this is real prose.
  const core = trimmed
    .replace(/[.,;:!]+$/, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/[.,;:!]+$/, '')
    .trim()
  return NON_ANSWER_PATTERNS.some((re) => re.test(core))
}

/** The registrable-ish label of a host: 'www.dialzy.ai' -> 'dialzy'. Deliberately
 *  naive (first label after dropping 'www.') — it only ever compares one
 *  citation host against one company domain, where that is enough. */
function firstLabel(hostOrDomain: string): string {
  let host = hostOrDomain.trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '')
  host = host.split('/')[0].split('?')[0].split('#')[0]
  host = host.replace(/^www\./, '')
  return host.split('.')[0] ?? ''
}

/** Length of the shared leading run of two strings. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/** How much of a leading run two labels must share before one is treated as
 *  impersonating the other. Four is what separates dial8/dialzy (a real
 *  collision) from dial8/data (a coincidence). */
const LOOK_ALIKE_PREFIX_CHARS = 4

/**
 * True when a citation comes from a DIFFERENT company whose name merely looks
 * like the one being enriched.
 *
 * Exa's neural search is associative, so enriching dial8.ai also pulled in
 * dialzy.ai, dialova.ca, dialbyte.ai, dialuno.ai and dialwisp.ai — and then reported
 * `products_and_services` as "Dialzy Studio, DIALZY XL…" at HIGH confidence,
 * citing dialzy.ai. That is a different company's product line, and it would
 * have been written straight into the CRM.
 *
 * The test is deliberately narrow: the labels must DIFFER (the company's own
 * site is never a look-alike) and share a long leading run, or one must be a
 * prefix of the other. A generic aggregator that happens to cite the company
 * (crunchbase, linkedin) shares no prefix and is left alone.
 */
export function isLookAlikeDomain(sourceUrl: string, companyDomain: string): boolean {
  const source = firstLabel(sourceUrl)
  const own = firstLabel(companyDomain)
  if (!source || !own) return false
  // The company's own site, by definition, is not impersonating itself.
  if (source === own) return false
  if (source.startsWith(own) || own.startsWith(source)) return true
  return commonPrefixLength(source, own) >= LOOK_ALIKE_PREFIX_CHARS
}

/** Full host of a URL, lowercased, without 'www.'. '' when unparseable. */
function hostOf(url: string): string {
  let host = url.trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '')
  host = host.split('/')[0].split('?')[0].split('#')[0]
  return host.replace(/^www\./, '')
}

/** True when `host` IS `domain` or a subdomain of it. */
function isOwnDomain(host: string, domain: string): boolean {
  const d = hostOf(domain)
  return !!d && (host === d || host.endsWith(`.${d}`))
}

/** Lowercase and strip everything that is not a letter or digit, so
 *  "Dial8, Inc." and "dial8 inc" compare equal and punctuation in a page
 *  title cannot hide a match. */
function normalizeForNameMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Shortest company name worth substring-matching. Two characters would match
 *  inside half the words on the web. */
const MIN_NAME_MATCH_CHARS = 3

/**
 * Force every field that is NOT demonstrably about this company down to 'low'.
 *
 * THE INCIDENT: enriching dial8.ai returned a LONDON COCKTAIL BAR — "dial8 is
 * a cocktail bar at Number Nine, Hotel Varenne", industry Hospitality at HIGH
 * confidence, cited to hotelvarenne.com. Two of four live runs were wrong.
 * `demoteLookAlikeSources` could not help: hotelvarenne is not a look-alike
 * of dial8, it is simply a different subject that Exa's neural search decided
 * the query was about.
 *
 * So this gate inverts the burden of proof. Instead of blacklisting the
 * wrong sources, a field must EARN its confidence by being cited to either:
 *   - the company's own domain (or a subdomain of it), or
 *   - a page whose TITLE contains the company name — which is what lets a
 *     legitimate aggregator through ("Dial8 - Crunchbase Company Profile"
 *     keeps its confidence; "Hotel Varenne" does not).
 * Anything else is demoted to 'low': kept in the blob for a human, but below
 * the column gate and not counted as an anchored signal.
 *
 * Applied ONLY to cards retrieved from the open web. A card fetched with
 * `includeDomains: [domain]` is already anchored by construction, and running
 * this over it would pointlessly demote the company's own untitled pages.
 */
export function demoteUnrelatedSources(
  fields: Record<string, GroundedField>,
  identity: { domain?: string | null; name?: string | null },
): Record<string, GroundedField> {
  const domain = identity.domain?.trim() ?? ''
  const name = normalizeForNameMatch(identity.name?.trim() ?? '')
  const nameUsable = name.length >= MIN_NAME_MATCH_CHARS

  // With no identity at all there is nothing to anchor against, so demoting
  // everything would just erase the run. Leave it to the caller's own guards.
  if (!domain && !nameUsable) return fields

  const out: Record<string, GroundedField> = {}
  for (const [key, field] of Object.entries(fields)) {
    const host = field.source_url ? hostOf(field.source_url) : ''
    const anchoredByDomain = !!domain && !!host && isOwnDomain(host, domain)
    const anchoredByTitle =
      nameUsable &&
      !!field.source_title &&
      normalizeForNameMatch(field.source_title).includes(name)
    out[key] =
      anchoredByDomain || anchoredByTitle ? field : { ...field, confidence: 'low' }
  }
  return out
}

/**
 * "linkedin.com/in/<slug>" for a personal profile URL, or null for anything
 * else (a company page, a short link, a post, not LinkedIn at all). Lowercased,
 * no scheme/www/query/trailing slash, so two spellings of one profile compare
 * equal.
 */
export function normalizeLinkedInProfileUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null
  const m = parsed.pathname.match(/^\/in\/([^/?#]+)/i)
  if (!m) return null
  // A malformed escape (`john-doe%`) must not throw out of a "null for
  // anything else" helper: keep the raw slug.
  let slug = m[1]
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // keep the raw slug
  }
  return `linkedin.com/in/${slug.toLowerCase()}`
}

/** Identity a person's citations must be tied to. */
export interface PersonIdentity {
  /** Full name — ignored when it is an email address standing in for a name. */
  name?: string | null
  companyName?: string | null
  companyDomain?: string | null
  /** Their own LinkedIn profile, when the CRM already has it. */
  linkedinUrl?: string | null
}

/**
 * Force every field that is NOT demonstrably about this PERSON down to 'low'.
 *
 * THE INCIDENT: Devin Marsh, CEO of Fieldwing (fieldwing.ag). Exa's people
 * index has no page for his own profile, but it does have a different Devin
 * Marsh — Senior Counsel at Halvern — and it cited that profile at HIGH for his
 * previous roles, education and location; his title and company were cited to
 * two Fieldwing colleagues' profiles. Every citation was "a page that supports
 * the text"; none was about him. The company-side gate (demoteUnrelatedSources)
 * had no counterpart for people, so all of it became the record.
 *
 * So, as for companies, a field must EARN its confidence:
 *   - cited to the company's own domain (or a subdomain) — the team page — or
 *   - cited to the person's OWN LinkedIn profile (when the CRM knows it), or
 *   - cited to a LinkedIn profile whose TITLE carries both the person's name
 *     AND the company ("Devin Marsh - CEO - Fieldwing | LinkedIn"): a bare
 *     name title is exactly how a namesake looks, and a colleague's profile
 *     carries the company but not the name, or
 *   - cited to any other page whose title or URL carries the company: a
 *     conference page or news item about the company's CEO qualifies; an
 *     article about a namesake at another employer does not.
 * Anything else is demoted to 'low': kept in the blob for a human (it shows
 * under Unverified), below the column gate, and — with the additive merge —
 * never able to displace a value an earlier run verified.
 *
 * Applied ONLY to cards retrieved from the open web; an own-domain card is
 * anchored by construction.
 */
export function demoteUnrelatedPersonSources(
  fields: Record<string, GroundedField>,
  identity: PersonIdentity,
): Record<string, GroundedField> {
  const domain = identity.companyDomain?.trim().toLowerCase() ?? ''
  const knownProfile = normalizeLinkedInProfileUrl(identity.linkedinUrl)
  const companyTokens = [
    normalizeForNameMatch(identity.companyName?.trim() ?? ''),
    // 'fieldwing' from 'fieldwing.ag' — what a title or URL slug actually carries.
    normalizeForNameMatch(domain.split('.')[0] ?? ''),
  ].filter((t) => t.length >= MIN_NAME_MATCH_CHARS)
  const rawName = identity.name?.trim() ?? ''
  const nameTokens = rawName.includes('@')
    ? []
    : rawName
        .split(/\s+/)
        .map((t) => normalizeForNameMatch(t))
        .filter((t) => t.length >= 2)
  const nameUsable = nameTokens.length >= 2

  // Nothing to anchor against — leave it to the caller's own guards.
  if (!domain && companyTokens.length === 0 && !knownProfile) return fields

  const carriesCompany = (text: string) => {
    const norm = normalizeForNameMatch(text)
    return companyTokens.some((t) => norm.includes(t))
  }
  const carriesName = (text: string) => {
    if (!nameUsable) return false
    const norm = normalizeForNameMatch(text)
    return nameTokens.every((t) => norm.includes(t))
  }

  const out: Record<string, GroundedField> = {}
  for (const [key, field] of Object.entries(fields)) {
    const url = field.source_url ?? ''
    const host = url ? hostOf(url) : ''
    const title = field.source_title ?? ''
    let anchored = false
    if (domain && host && isOwnDomain(host, domain)) {
      anchored = true
    } else {
      const profile = normalizeLinkedInProfileUrl(url)
      if (profile) {
        anchored =
          (knownProfile !== null && profile === knownProfile) ||
          (carriesName(title) && carriesCompany(title))
      } else {
        anchored = carriesCompany(title) || carriesCompany(url)
      }
    }
    out[key] = anchored ? field : { ...field, confidence: 'low' }
  }
  return out
}

/**
 * Force every field cited to a look-alike domain down to 'low' confidence.
 *
 * Demote rather than drop: the value stays visible in `metadata.enrichment`
 * where a human can judge it (and see which domain it came from), but 'low' is
 * below the column gate, so it can never fill a column and never counts as the
 * confident signal the contact-side namesake guard looks for.
 *
 * COMPANIES ONLY. A person's citations legitimately span employers, press and
 * profiles, so there is no "the domain should match" invariant to enforce.
 */
export function demoteLookAlikeSources(
  fields: Record<string, GroundedField>,
  companyDomain: string | null | undefined,
): Record<string, GroundedField> {
  if (!companyDomain?.trim()) return fields
  const out: Record<string, GroundedField> = {}
  for (const [key, field] of Object.entries(fields)) {
    out[key] =
      field.source_url && isLookAlikeDomain(field.source_url, companyDomain)
        ? { ...field, confidence: 'low' }
        : field
  }
  return out
}

// ---------------------------------------------------------------------------
// Flattening the card
// ---------------------------------------------------------------------------

/**
 * Flatten `output.content` into `{ snake_case_key: GroundedField }`.
 *
 * Only values a source actually supported survive: an absent or blank value is
 * OMITTED entirely rather than stored as an empty string, so "Exa found nothing
 * for this field" and "Exa found an empty string" are the same thing downstream.
 * Arrays of strings are joined with ', ' — the CRM columns and the blob are both
 * text, and a stored array would render as `[object Object]` in half the UI.
 *
 * Confidence comes from the matching grounding entry; a field Exa returned but
 * did NOT ground is 'low', which keeps it out of column writes while still
 * showing it in the metadata blob where a human can judge it.
 */
export function groundedFields(
  res: DeepSearchResult,
  keyMap?: Record<string, string>,
): Record<string, GroundedField> {
  const out: Record<string, GroundedField> = {}
  const content = res.content
  if (!content) return out

  // Index the grounding by resolved schema key. First entry wins: Exa may emit
  // several grounding rows for one field and the first carries its primary
  // citation.
  const byField = new Map<string, DeepSearchGrounding>()
  for (const g of res.grounding) {
    const key = fieldKeyFromPath(g.field)
    if (!key || byField.has(key)) continue
    byField.set(key, g)
  }

  for (const [rawKey, rawValue] of Object.entries(content)) {
    // Strings trimmed, finite numbers stringified, string arrays joined with
    // ', ' after dropping placeholder members, and the whole value rejected
    // when it is a non-answer: "Not publicly disclosed" is an ABSENCE, not a
    // fact, and dropping it here keeps it out of the columns, out of the blob,
    // and out of the has-a-confident-field signal. Shared with `groundedArray`
    // so a list card's items are read by exactly these rules.
    const value = coerceFieldValue(rawValue)
    if (!value) continue

    const g = byField.get(rawKey)
    const key = keyMap?.[rawKey] ?? camelToSnake(rawKey)
    out[key] = {
      value,
      source_url: g?.citations[0]?.url ?? null,
      source_title: g?.citations[0]?.title ?? null,
      confidence: g?.confidence ?? 'low',
    }
  }

  return out
}

/**
 * The de-duplicated source list for the blob: every grounding citation first
 * (those are the URLs that actually back a field), then any bare result Exa
 * returned but never cited. Order is the reader's order of usefulness.
 */
export function sourcesOf(
  res: DeepSearchResult,
): Array<{ url: string; title: string | null; published_date: string | null }> {
  const byUrl = new Map<string, { url: string; title: string | null; published_date: string | null }>()

  for (const g of res.grounding) {
    for (const c of g.citations) {
      const existing = byUrl.get(c.url)
      if (existing) {
        if (!existing.title) existing.title = c.title
        continue
      }
      byUrl.set(c.url, { url: c.url, title: c.title, published_date: null })
    }
  }

  for (const r of res.results) {
    const existing = byUrl.get(r.url)
    if (existing) {
      if (!existing.title) existing.title = r.title
      if (!existing.published_date) existing.published_date = r.publishedDate
      continue
    }
    byUrl.set(r.url, { url: r.url, title: r.title, published_date: r.publishedDate })
  }

  return [...byUrl.values()]
}

// ---------------------------------------------------------------------------
// List cards: per-item grounding, and the free entities on every result
// ---------------------------------------------------------------------------

/** One item of an array card, with its fields grounded INDEPENDENTLY. */
export interface GroundedArrayItem {
  /** Zero-based position in `output.content[arrayKey]`. */
  index: number
  /** snake_case field key -> the grounded value, exactly as `groundedFields`
   *  shapes one, so downstream storage and rendering are identical. */
  fields: Record<string, GroundedField>
}

/**
 * `groundedFields` for a LIST card.
 *
 * `groundedFields` resolves every grounding path through `fieldKeyFromPath`,
 * which strips the array subscript and keeps the last segment — so
 * `companies[0].whyMatch` and `companies[7].whyMatch` collapse to ONE key and
 * the first entry wins. That is correct for a single-entity card and useless
 * for a list: nineteen companies would share company zero's citations.
 *
 * So this parses the subscript instead. `output.grounding[].field` comes back
 * as `<arrayKey>[i].<key>` (measured, §12), each item's fields are indexed by
 * their own `i`, and everything else — the value coercion, the ', ' join for
 * string arrays, `isNonAnswer` dropping "Not publicly disclosed", the
 * ungrounded-means-'low' rule — is applied per field EXACTLY as
 * `groundedFields` applies it.
 *
 * Items come back in content order and every item is returned, including one
 * whose every field was dropped (an empty `fields`), because the caller
 * indexes candidates positionally and a silent hole would misalign them.
 *
 * NOTE what is NOT done here: no identity gate. `demoteUnrelatedSources` takes
 * a single `Record<string, GroundedField>` for one entity and there is no such
 * record for a list — discovery output is gated by the exclusion set instead
 * (§7).
 */
export function groundedArray(res: DeepSearchResult, arrayKey: string): GroundedArrayItem[] {
  const content = res.content
  if (!content) return []
  const rawItems = content[arrayKey]
  if (!Array.isArray(rawItems)) return []

  // Index grounding by `${index}.${schemaKey}`. First entry wins, matching
  // `groundedFields`: Exa may emit several rows for one field and the first
  // carries its primary citation.
  const byPath = new Map<string, DeepSearchGrounding>()
  for (const g of res.grounding) {
    const parsed = parseArrayGroundingPath(g.field, arrayKey)
    if (!parsed) continue
    const mapKey = `${parsed.index}.${parsed.key}`
    if (byPath.has(mapKey)) continue
    byPath.set(mapKey, g)
  }

  const out: GroundedArrayItem[] = []
  rawItems.forEach((rawItem, index) => {
    const item = asRecord(rawItem)
    const fields: Record<string, GroundedField> = {}
    if (item) {
      for (const [rawKey, rawValue] of Object.entries(item)) {
        const value = coerceFieldValue(rawValue)
        if (!value) continue
        const g = byPath.get(`${index}.${rawKey}`)
        fields[camelToSnake(rawKey)] = {
          value,
          source_url: g?.citations[0]?.url ?? null,
          source_title: g?.citations[0]?.title ?? null,
          confidence: g?.confidence ?? 'low',
        }
      }
    }
    out.push({ index, fields })
  })
  return out
}

/**
 * `companies[3].whyMatch` -> `{ index: 3, key: 'whyMatch' }`, for the ONE
 * array key asked about; null for anything else (a bare key, a different
 * array, a path with no subscript).
 *
 * A leading `content.` is tolerated because Exa reports both spellings
 * (`groundedFields` tolerates it too, by resolving on the last segment).
 */
function parseArrayGroundingPath(
  path: string,
  arrayKey: string,
): { index: number; key: string } | null {
  const trimmed = path.trim().replace(/^content\./, '')
  const m = trimmed.match(/^([A-Za-z0-9_$]+)\[(\d+)\]\.(.+)$/)
  if (!m) return null
  if (m[1] !== arrayKey) return null
  const index = Number(m[2])
  if (!Number.isInteger(index) || index < 0) return null
  // Only the leaf segment names the schema key; deeper nesting is not a shape
  // any list card declares, and the last segment is what `groundedFields`
  // would have resolved to anyway.
  const key = m[3].split('.').pop()?.replace(/\[\d+\]$/, '').trim() ?? ''
  if (!key) return null
  return { index, key }
}

/**
 * The value coercion `groundedFields` performs, factored out so an array
 * card's items are read by EXACTLY the same rules as a flat card's fields:
 * strings trimmed, finite numbers stringified, string arrays joined with ', '
 * after dropping placeholder members, and the whole thing rejected when it is
 * a non-answer. Returns null for "nothing worth storing".
 */
function coerceFieldValue(rawValue: unknown): string | null {
  let value: string | null = null
  if (typeof rawValue === 'string') {
    value = rawValue.trim() || null
  } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    value = String(rawValue)
  } else if (Array.isArray(rawValue)) {
    const parts = rawValue
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim())
      .filter((v) => !isNonAnswer(v))
    value = parts.length > 0 ? parts.join(', ') : null
  }
  if (!value) return null
  if (isNonAnswer(value)) return null
  return value
}

/** A company lifted for free off `results[].entities[]` (§12). */
export interface ResultCompanyEntity {
  /** Exa's stable entity id, e.g. `https://exa.ai/library/organization/<id>`. */
  id: string | null
  name: string | null
  /** Host of the RESULT url with `www.` stripped — the entity properties carry
   *  no domain, and the result's own host is what the company was found at. */
  domain: string | null
  description: string | null
  foundedYear: number | null
  /** The result URL the entity rode in on. */
  url: string
  /** The result title, which is often the company name spelled differently. */
  title: string | null
  /**
   * The entity's properties VERBATIM.
   *
   * The flattened members above are the ones every caller needs; this is the
   * rest, and it is not optional decoration: the measured response carries
   * `workforce.total` and `headquarters.city` on every company result, and
   * `fit.ts` scores headcount and geography off exactly those. Dropping them
   * here made both criteria dead code on the real pipeline.
   */
  properties: Record<string, unknown>
}

/**
 * Every `results[].entities[]` member of type 'company', flattened.
 *
 * This is the SECOND harvest source for discovery (§7) and it is free: the
 * firmographics ride along with results we have already paid for. It is also
 * NOISY — measured result hosts include `linkedin.com` and recruiter sites —
 * so the caller must run both the personal/noise-domain filter and the full
 * exclusion set over what comes back. Nothing is filtered here.
 *
 * `domain` comes from the RESULT url rather than the entity, because the
 * entity properties carry no domain at all; `hostOf` lowercases and drops a
 * leading `www.`, and a host that will not parse yields null (the caller then
 * records the candidate as `invalid`). The raw `properties` ride along
 * untouched — `workforce.total` and `headquarters` are free firmographics the
 * fit scorer needs and nothing else supplies.
 */
export function resultEntities(res: DeepSearchResult): ResultCompanyEntity[] {
  const out: ResultCompanyEntity[] = []
  for (const result of res.results) {
    for (const entity of result.entities ?? []) {
      if (entity.type !== 'company') continue
      const props = entity.properties
      const foundedYear = props.foundedYear
      const host = hostOf(result.url)
      out.push({
        id: entity.id,
        name: nonEmptyString(props.name),
        domain: host || null,
        description: nonEmptyString(props.description),
        foundedYear:
          typeof foundedYear === 'number' && Number.isFinite(foundedYear) ? foundedYear : null,
        url: result.url,
        title: result.title,
        properties: props,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/*
 * TWO CARDS PER ENTITY, NOT ONE.
 *
 * Exa caps `outputSchema` at MAX_OUTPUT_SCHEMA_PROPERTIES properties TOTAL —
 * a single flat schema with 11 props 400s with "Output_schema exceeds maximum
 * of 10 properties", and nesting does NOT buy headroom (an object property
 * carrying 10 inner props 400s too; the count is recursive). Proven live on
 * DEV, which is where the original 24-property company schema died.
 *
 * So each entity is described by an ARRAY of <=10-property cards, run
 * concurrently against the SAME query and merged with `mergeDeepSearchResults`.
 * The split is by importance, not alphabetically: CORE carries everything that
 * feeds a CRM column or Exa's own documented recipe, so a partial failure or a
 * thin answer still fills the columns; the second card carries the extras that
 * only ever reach the metadata blob.
 *
 * Every property keeps a one-line `description` because Exa's synthesizer reads
 * them — without one, `companyStage` and `fundingStage` come back as the same
 * string, and `employeeCount` comes back as prose instead of a band.
 */

/**
 * CORE company card: Exa's seven documented recipe fields, verbatim and in
 * their order, plus the three extras that feed columns (`companyName` fixes a
 * placeholder name, `website` fills its column, `linkedinUrl` is the single
 * most-requested link). Exactly 10.
 */
export const COMPANY_CARD_CORE = {
  type: 'object',
  properties: {
    industry: { type: 'string', description: 'Industry or sector, in a few words.' },
    annualRevenue: {
      type: 'string',
      description: "Estimated annual revenue or revenue band, e.g. '$10M-$50M'.",
    },
    employeeCount: {
      type: 'string',
      description: "Approximate headcount or range, e.g. '51-200'.",
    },
    ownership: {
      type: 'string',
      description: 'Ownership structure: private, public, VC-backed, PE-owned, subsidiary.',
    },
    latestFunding: {
      type: 'string',
      description: 'Most recent funding round: stage, amount, date and lead investor.',
    },
    description: {
      type: 'string',
      description: '1-2 sentences on what the company does.',
    },
    recentNews: {
      type: 'string',
      description: 'Notable recent news or announcements about the company.',
    },
    companyName: { type: 'string', description: "The company's official name." },
    website: { type: 'string', description: "The company's primary website URL." },
    linkedinUrl: { type: 'string', description: "Full URL of the company's LinkedIn page." },
  },
  required: ['industry', 'description'],
} as const

/**
 * DETAILS company card: the firmographics that have no column and only ever
 * reach `metadata.enrichment` — funding shape, stage, people, what they sell,
 * and the split-out headquarters parts (which DO feed city/state/country).
 * Exactly 10, and `required: []` because a thin answer here is normal and must
 * not fail the card.
 */
export const COMPANY_CARD_DETAILS = {
  type: 'object',
  properties: {
    fundingStage: {
      type: 'string',
      description: 'Bootstrapped, Pre-seed, Seed, Series A/B/C…, Growth, Public, Acquired.',
    },
    totalFundingRaised: {
      type: 'string',
      description: "Total capital raised to date, e.g. '$45M'.",
    },
    investors: { type: 'string', description: 'Notable investors or backers.' },
    foundedYear: { type: 'string', description: 'Year the company was founded, as 4 digits.' },
    companyStage: {
      type: 'string',
      description: 'Idea, Early-stage startup, Growth, Scale-up, Mature, Public.',
    },
    keyPeople: { type: 'string', description: 'Founders and executives, with their roles.' },
    productsAndServices: {
      type: 'string',
      description: 'Main products or services the company sells.',
    },
    headquartersCity: { type: 'string', description: 'City of the headquarters.' },
    headquartersState: { type: 'string', description: 'State or province of the headquarters.' },
    headquartersCountry: { type: 'string', description: 'Country of the headquarters.' },
  },
  required: [],
} as const

/**
 * CONTACT company card: how to reach them. Everything here lives on the
 * company's own contact page, so the card is retrieved own-domain anchored
 * (like CORE) and never from the open web. `contactEmail`, `phone` and
 * `streetAddress` feed the `contact_email`, `phone` and `address` columns;
 * `contactPage` is blob-only. Four properties, `required: []` — most small
 * companies publish an email and nothing else.
 */
export const COMPANY_CARD_CONTACT = {
  type: 'object',
  properties: {
    contactEmail: {
      type: 'string',
      description: "General, sales or hello@ contact email address, e.g. 'hello@acme.com'.",
    },
    phone: {
      type: 'string',
      description: 'Main company phone number, with country code if shown.',
    },
    streetAddress: {
      type: 'string',
      description: 'Full postal address of the headquarters: street, city, region, postal code, country.',
    },
    contactPage: {
      type: 'string',
      description: 'URL of the contact, demo-request or sales page.',
    },
  },
  required: [],
} as const

/** The company cards: CORE and CONTACT own-domain, DETAILS open web; merged after. */
export const COMPANY_CARD_SCHEMAS = [
  COMPANY_CARD_CORE,
  COMPANY_CARD_DETAILS,
  COMPANY_CARD_CONTACT,
] as const

/**
 * CORE person card: everything that feeds a column (`fullName`, `jobTitle`,
 * `department`, `linkedinUrl`), the company identity the namesake guard reads
 * (`companyName` / `companyDomain`), and the `summary` that becomes the
 * contact's notes. `fullName` is the only required field: on a thin identity
 * everything else legitimately comes back absent, and requiring more would push
 * the synthesizer into inventing a plausible namesake. Exactly 10.
 */
export const PERSON_CARD_CORE = {
  type: 'object',
  properties: {
    fullName: { type: 'string', description: "The person's full name." },
    jobTitle: { type: 'string', description: "The person's current job title." },
    department: { type: 'string', description: 'Their department or functional area.' },
    seniority: {
      type: 'string',
      description: 'Seniority level: IC, Manager, Director, VP, C-level, Founder.',
    },
    companyName: { type: 'string', description: 'The company they currently work for.' },
    companyDomain: {
      type: 'string',
      description: "That company's primary web domain, e.g. 'vercel.com' — no scheme, no path.",
    },
    location: { type: 'string', description: 'City / region where they are based.' },
    linkedinUrl: { type: 'string', description: 'Full URL of their LinkedIn profile.' },
    summary: {
      type: 'string',
      description:
        '2-4 sentence professional bio: their current role and company, plus their background.',
    },
    notableWork: {
      type: 'string',
      description: 'Notable projects, publications, talks or achievements.',
    },
  },
  required: ['fullName'],
} as const

/**
 * BACKGROUND person card: the history and links that only reach the blob. Five
 * properties, well inside the cap — there is no value in padding it.
 */
export const PERSON_CARD_BACKGROUND = {
  type: 'object',
  properties: {
    previousRoles: {
      type: 'string',
      description: 'Prior roles and employers, most recent first.',
    },
    education: { type: 'string', description: 'Universities, degrees and fields of study.' },
    expertise: { type: 'string', description: 'Areas of professional expertise or focus.' },
    twitterUrl: { type: 'string', description: 'Full URL of their X/Twitter profile.' },
    githubUrl: { type: 'string', description: 'Full URL of their GitHub profile.' },
  },
  required: [],
} as const

/** Both person cards, run concurrently and merged. */
export const PERSON_CARD_SCHEMAS = [PERSON_CARD_CORE, PERSON_CARD_BACKGROUND] as const

// ---------------------------------------------------------------------------
// Query templates
// ---------------------------------------------------------------------------

/** Exa's query template for a company card. */
export function companyProfileQuery(domainOrName: string): string {
  return `Company profile and information for ${domainOrName.trim()}`
}

/**
 * Query for the CONTACT card. Runs own-domain anchored, so it only has to
 * steer Exa to the contact page, not identify the company.
 */
export function companyContactQuery(name: string, domain: string): string {
  return `Contact information for ${name.trim()} (${domain}): contact email address, phone number, street address, contact page`
}

export interface PersonQueryArgs {
  name: string
  company?: string | null
  domain?: string | null
  jobTitle?: string | null
  /** The person's own LinkedIn profile URL, when the CRM already has it. */
  linkedinUrl?: string | null
}

/**
 * The person query. Every known disambiguator goes in, because a bare name is a
 * coin-flip across namesakes and the whole point of the extra facts is to make
 * Exa's search resolve to THIS person.
 */
export function personProfileQuery(args: PersonQueryArgs): string {
  const name = args.name.trim()
  const title = args.jobTitle?.trim()
  const company = args.company?.trim()
  const domain = args.domain?.trim()

  // The strongest disambiguator there is: the profile URL names exactly one
  // human. Even when Exa has not indexed that page, the synthesizer sees which
  // namesake it is meant to resolve. With no name at all it IS the subject —
  // a contact can legitimately be a profile link and nothing else.
  const profile = normalizeLinkedInProfileUrl(args.linkedinUrl)

  const who = name || profile
  let subject = who ? `Professional profile for ${who}` : 'Professional profile'
  if (title) subject += `, ${title}`
  if (company) subject += `${title ? ' at' : ', at'} ${company}`
  if (domain) subject += ` (${domain})`
  if (profile && name) subject += ` — LinkedIn: ${profile}`
  return `${subject} — current role, employer, background`
}

/**
 * Up to three narrower query variations Exa runs alongside the main one. Each
 * needs a real disambiguator: a bare-name variation would just widen the
 * namesake problem the main query is trying to close.
 */
export function personAdditionalQueries(args: PersonQueryArgs): string[] {
  const name = args.name.trim()
  if (!name) return []
  const quoted = `"${name}"`
  const out: string[] = []
  const domain = args.domain?.trim()
  const company = args.company?.trim()
  const title = args.jobTitle?.trim()
  if (domain) out.push(`${quoted} ${domain}`)
  if (company) out.push(`${quoted} linkedin ${company}`)
  if (title) out.push(`${quoted} ${title}`)
  return out.slice(0, 3)
}
