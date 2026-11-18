/**
 * CRM web enrichment — fill empty contact/company columns from public sources.
 *
 * One Exa Deep Search PER CARD per entity, run concurrently. No LLM in the
 * loop at all.
 *
 * Exa caps `outputSchema` at 10 properties (recursively — nesting does not help
 * (see MAX_OUTPUT_SCHEMA_PROPERTIES), so each entity is described by two
 * <=10-property cards that go out together against the same query and are
 * folded back into one result with `mergeDeepSearchResults`. Everything after
 * the merge is card-agnostic and unchanged.
 *
 * The pipeline used to be two Gateway model calls (a provider-executed Exa
 * search, then a forced tool call to extract fields from the harvest). Both
 * stages are gone. Exa's Deep Search does the searching, the reading AND the
 * schema-shaped extraction in a single request, and returns per-field
 * GROUNDING — citations plus a low/medium/high confidence — which is exactly
 * the signal the write-back already gated on. Paying a model to re-read search
 * results we had already paid for bought nothing but latency and two more ways
 * to hang (see the 2026-09-01 provider structured-output outage).
 *
 * The Gateway's provider-executed Exa tool cannot do this: it validates `type`
 * against auto|fast|instant, so no `type: 'deep'`, no `outputSchema`, no
 * grounding. Hence the direct client in src/lib/exa/deep-search.ts.
 *
 * WRITE-BACK CONTRACT (unchanged, and the important half):
 *   - Structured columns are filled with `computeFillEmptyPatch` — enrichment
 *     NEVER overwrites a populated column, only fills an empty one. That is
 *     the same enrich-don't-clobber rule the HubSpot sync follows, and it is
 *     what makes re-enrichment safe to run repeatedly.
 *   - Only 'high'/'medium' confidence values are eligible to fill a column.
 *     'low' still lands in the metadata blob, where a human can see it.
 *   - EVERYTHING Exa grounded — low-confidence values included, plus the many
 *     fields that have no column at all (funding stage, investors, key people,
 *     recent news, socials) — is written to `metadata.enrichment`, merged into
 *     the existing metadata so sibling keys (company_autolinked,
 *     hubspot_push_error, …) survive.
 *
 * Nothing calls this on its own: a run happens because a person asked (the
 * Enrich button, a yes to the chat's enrich_contact, Prospecting establishing
 * a company, onboarding researching the new user's own company). The
 * half-hourly sweep that used to enrich every new contact is gone
 * (src/lib/inngest/crm-enrichment.ts says why). Spend is gated by the usage
 * guard in the Inngest functions. This module is the unit of work.
 *
 * SPEND IS RECORDED AS SPENT. Every Exa answer bills, including the cards of
 * a run that then fails, so a failed run records what its answered cards cost
 * (`search_cost_dollars`, added to `total_cost_dollars`) rather than $0, and
 * the cards of one stage are awaited together (allSettled) so none is still
 * in flight, billing, when the run writes its outcome.
 *
 * For a person on their own ChatGPT plan (the free tier) every card runs on
 * their plan instead of Exa (deepSearchForUser, src/lib/web-research/
 * plan-deep-search.ts): the same query and card, the same result shape, at
 * no cost to Native Intelligence. The run's `userId` is whose plan pays.
 */

import { getServiceClient } from '@/lib/admin'
import {
  COMPANY_CARD_SCHEMAS,
  DEEP_SEARCH_TIMEOUT_MS,
  ExaNotConfiguredError,
  ExaRequestError,
  PERSON_CARD_SCHEMAS,
  companyContactQuery,
  companyProfileQuery,
  demoteLookAlikeSources,
  demoteUnrelatedSources,
  groundedFields,
  mergeDeepSearchResults,
  demoteUnrelatedPersonSources,
  normalizeLinkedInProfileUrl,
  PERSON_CARD_CORE,
  personAdditionalQueries,
  personProfileQuery,
  sourcesOf,
  type DeepSearchResult,
  type GroundedField,
} from '@/lib/exa/deep-search'
import { computeFillEmptyPatch } from './hubspot-sync'
import { companyDomainFromEmail, isPersonalDomain, normalizeDomain } from './domains'
import { deepSearchForUser, type DeepSearchFn } from '@/lib/web-research/plan-deep-search'

/**
 * Usage-taxonomy slug this module used to bill Gateway calls under. Nothing
 * here calls the Gateway any more (Exa bills directly against EXA_API_KEY),
 * but the export stays: sibling modules import it. (The old `crm_enrichment`
 * model surface is gone with Settings → AI Models.)
 */
export const ENRICHMENT_FEATURE = 'crm_enrichment'

// The pure domain helpers live in ./domains (client code imports them, and
// this module is server-only); re-exported for this module's callers.
export { companyDomainFromEmail, isPersonalDomain, normalizeDomain } from './domains'

/** Shape version of the `metadata.enrichment` blob. Bump on a breaking change. */
export const ENRICHMENT_VERSION = 1

/**
 * Recorded as `blob.model`. Not a model slug any more — it names the ENGINE
 * that produced the fields, which is what the UI badge and any future
 * re-processing actually need to know.
 */
export const ENRICHMENT_ENGINE = 'exa/deep-search'

/** The exact set the `company.employee_count_range` column carries. A value
 *  that will not map onto one of these is omitted rather than guessed at. */
export const EMPLOYEE_COUNT_RANGES = [
  '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+',
] as const

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Hosts that hide a LinkedIn profile behind a redirect. */
const LINKEDIN_SHORT_HOSTS = new Set(['lnkd.in'])
const LINKEDIN_RESOLVE_TIMEOUT_MS = 4_000

/**
 * Turn a lnkd.in short link into the profile URL it redirects to, so the URL
 * can be compared against citations and quoted in the search query. Any
 * other URL (or no URL) is returned as is; any failure returns the input —
 * this is a best-effort disambiguator, never a reason to fail a run.
 * LinkedIn bounces anonymous visitors to an authwall whose `sessionRedirect`
 * parameter carries the real target, so that is unwrapped too.
 */
export async function resolveLinkedInShortLink(
  url: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const trimmed = url?.trim()
  if (!trimmed) return null
  let host = ''
  try {
    host = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return trimmed
  }
  if (!LINKEDIN_SHORT_HOSTS.has(host)) return trimmed
  try {
    const res = await fetchImpl(trimmed, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(LINKEDIN_RESOLVE_TIMEOUT_MS),
    })
    const final = res.url || trimmed
    try {
      const target = new URL(final).searchParams.get('sessionRedirect')
      if (target) return target
    } catch {
      // not a URL we can parse — fall through with what we have
    }
    return final
  } catch {
    return trimmed
  }
}

/**
 * Does this URL name exactly ONE human — i.e. is it a personal LinkedIn
 * profile rather than a company page or some other link?
 *
 * A profile URL is the strongest identifier the CRM can hold about a person:
 * `personProfileQuery` quotes it as the query's disambiguator, and
 * `demoteUnrelatedPersonSources` anchors a citation on it. So it is also, on
 * its own, reason enough to search — which is what {@link contactSkipReason}
 * uses this for.
 *
 * `linkedin.com/company/…`, a bare `linkedin.com`, and anything unparseable
 * are NOT profiles. A `lnkd.in` short link is: it always redirects to one,
 * and `resolveLinkedInShortLink` unwraps it at search time (this guard is
 * synchronous, so it cannot follow the redirect itself).
 */
export function hasLinkedInProfile(url: string | null | undefined): boolean {
  const trimmed = url?.trim()
  if (!trimmed) return false
  if (normalizeLinkedInProfileUrl(trimmed)) return true
  try {
    const host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname
      .toLowerCase()
      .replace(/^www\./, '')
    return LINKEDIN_SHORT_HOSTS.has(host)
  } catch {
    return false
  }
}

/**
 * Map a free-form size string onto the exact `employee_count_range` domain.
 * Exa returns headcount as prose ('approximately 250 employees') or as an
 * off-enum band ('200-500'), and neither must reach the column — this is the
 * last gate, and returns null (omit the field) rather than guessing wrong.
 */
export function normalizeEmployeeRange(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim()
  if ((EMPLOYEE_COUNT_RANGES as readonly string[]).includes(v)) return v

  // Tolerate a bare number or a numeric range by bucketing on its LOW end —
  // the bucket a company of that size belongs to.
  const nums = v.match(/\d[\d,]*/g)?.map((n) => Number(n.replace(/,/g, ''))) ?? []
  const low = nums.length > 0 ? nums[0] : NaN
  if (!Number.isFinite(low) || low <= 0) return null
  if (low <= 10) return '1-10'
  if (low <= 50) return '11-50'
  if (low <= 200) return '51-200'
  if (low <= 500) return '201-500'
  if (low <= 1000) return '501-1000'
  return '1000+'
}

/**
 * The one email address inside an Exa answer, lowercased — Exa likes to wrap
 * it ("Email: hello@acme.com", "hello@acme.com (general enquiries)"). Null
 * when there is no address in the string at all.
 */
export function normalizeContactEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return m ? m[0].toLowerCase() : null
}

/**
 * A phone number as written, trimmed to the number itself ("Tel: +1 (415)
 * 555-0100" → "+1 (415) 555-0100"). Null unless it carries 7–15 digits, so
 * prose ("via the contact form") and fragments never reach the column.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\+?[\d(][\d\s().-]{5,}\d/)
  if (!m) return null
  const digits = m[0].replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? m[0].trim() : null
}

// ---------------------------------------------------------------------------
// The metadata blob
// ---------------------------------------------------------------------------

export interface EnrichmentBlob {
  version: number
  status: 'enriched' | 'failed' | 'skipped'
  enriched_at: string
  /** The engine that produced these fields — `ENRICHMENT_ENGINE`. */
  model: string
  /**
   * Every grounded field, verbatim (value/source_url/confidence), plus
   * `found_at`. ADDITIVE across runs: a re-run replaces a field only when it
   * found that field again at no lower confidence, keeps every field it did
   * not find, and a failed or empty run keeps all of them. Refreshing a
   * record therefore only ever adds or updates — nothing found earlier is
   * lost. See mergeBlobFields.
   */
  fields: Record<string, unknown>
  /** Names of the columns enrichment has written — this run's fill-empty
   *  survivors unioned with every earlier run's. */
  applied_fields: string[]
  /** This run's citations first, then earlier runs' — de-duplicated by URL. */
  sources: Array<{ url: string; title?: string | null; published_date?: string | null }>
  /** This run's summary, or the previous one when this run produced none. */
  summary: string | null
  /** When THIS run finished, success or not. `enriched_at` is the last run
   *  that produced findings — a failed run keeps the earlier stamp. */
  last_run_at?: string
  /**
   * CONTACTS ONLY. The exact text this run appended to `contact.notes`, or null
   * when nothing was written. It is the anchor for idempotent re-enrichment:
   * the next run looks for this verbatim string inside the current notes and
   * REPLACES it with the new summary, so a manual re-run refreshes the block
   * instead of stacking a second paragraph. If the user edited or deleted it
   * the search misses, and the new summary is appended as if it were the first.
   */
  notes_summary?: string | null
  search_cost_dollars: number | null
  /** Running total across every run on this row. */
  total_cost_dollars?: number | null
  error?: string
  /** True when the failure will recur on every retry — the guards and the
   *  manual-trigger route both refuse to re-run a permanently-failed row. */
  permanent?: boolean
  /**
   * When Prospecting's ICP card last ran against this company
   * (src/lib/prospecting/research.ts). NOT written here — this module never
   * fires that card — but CARRIED FORWARD across every terminal write, because
   * the blob is replaced wholesale and that stamp is the card's ONLY spend
   * guard. Dropping it would silently re-bill $0.012 on the next list creation.
   */
  icp_card_at?: string
}

export interface EnrichmentOutcome {
  status: 'enriched' | 'failed' | 'skipped'
  /** Columns actually written on the entity row. */
  applied: string[]
  /** Set when this run created a company row from a contact's found domain. */
  createdCompanyId?: string
  reason?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Write-back helpers (pure — unit-tested directly)
// ---------------------------------------------------------------------------

/** Confidence levels allowed to fill a real column. 'low' is metadata-only. */
const COLUMN_CONFIDENCE = new Set(['high', 'medium'])

/** A grounded field as it arrives from Exa, or nothing at all. */
type MaybeField = GroundedField | null | undefined

/**
 * Reduce a `{ column: GroundedField }` map to the plain `{ column: value }`
 * shape the fill-empty merge takes, dropping anything below the confidence bar
 * or with no value. This is the ONLY gate between Exa's card and a column
 * write.
 */
export function columnCandidates(
  fields: Record<string, MaybeField>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, f] of Object.entries(fields)) {
    if (!f || typeof f.value !== 'string') continue
    if (!COLUMN_CONFIDENCE.has(f.confidence)) continue
    const value = f.value.trim()
    if (!value) continue
    out[key] = value
  }
  return out
}

/** Strip the summary/sources bookkeeping off the field map for the metadata
 *  blob — the blob keeps the full triple, including 'low' confidence and
 *  column-less fields. */
export function serializeFields(
  extraction: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(extraction)) {
    if (key === 'sources' || key === 'summary') continue
    if (v == null) continue
    fields[key] = v
  }
  return fields
}

/**
 * Merge the enrichment blob into an existing metadata object WITHOUT touching
 * sibling keys. `company_autolinked` (mig 232) and `hubspot_push_error`
 * (hubspot-push-contact) both live in the same jsonb column and must survive.
 */
export function mergeEnrichmentMetadata(
  existing: unknown,
  blob: EnrichmentBlob,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  base.enrichment = blob
  return base
}

/**
 * True when a contact's `full_name` is a machine placeholder rather than a
 * name a human typed. Sync-created contacts routinely land with the raw email
 * in the name column ('jmarlow@bright-wave.com') or just its local part
 * ('jmarlow'), which reads as a name to every list and mention UI.
 *
 * `computeFillEmptyPatch` cannot express this: the column is NON-EMPTY in
 * exactly the case we want to overwrite, so the placeholder test has to be
 * explicit. Deliberately narrow — only these three shapes qualify, so a real
 * name is NEVER overwritten by the enricher:
 *   - empty / whitespace
 *   - the contact's own email, case-insensitive and trimmed
 *   - the local part of that email (before '@'), case-insensitive
 */
export function isPlaceholderName(
  fullName: string | null | undefined,
  email: string | null | undefined,
): boolean {
  const name = (fullName ?? '').trim()
  if (name === '') return true

  const addr = (email ?? '').trim().toLowerCase()
  if (!addr) return false

  const lower = name.toLowerCase()
  if (lower === addr) return true

  const at = addr.lastIndexOf('@')
  const local = at > 0 ? addr.slice(0, at) : ''
  return local !== '' && lower === local
}

/** Read the previous run's `notes_summary` off a row's metadata, if any. */
export function previousNotesSummary(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const e = (metadata as Record<string, unknown>).enrichment
  if (!e || typeof e !== 'object') return null
  const prev = (e as Record<string, unknown>).notes_summary
  return typeof prev === 'string' && prev.trim() !== '' ? prev : null
}

/** Separator between the existing notes and the appended enrichment block. */
const NOTES_SEPARATOR = '\n\n'

/**
 * Fold an enrichment summary into a contact's notes.
 *
 * The rule the user asked for, in order:
 *   - No summary → notes are returned untouched (null patch, nothing written).
 *   - Empty/whitespace notes → the notes BECOME the summary.
 *   - The previous run's block is still present verbatim → that exact substring
 *     is replaced in place with the new summary. This is what makes a manual
 *     re-enrich idempotent: the paragraph refreshes rather than duplicating,
 *     and everything the user wrote around it keeps its position.
 *   - Otherwise (first run, or the user edited/deleted the old block) → append
 *     after a blank line. Existing content is NEVER modified or cleared.
 *
 * Returns the text actually stored in `notes_summary` alongside the new notes,
 * so the next run has an anchor to find.
 */
export function applySummaryToNotes(args: {
  notes: string | null | undefined
  summary: string | null | undefined
  previousSummary: string | null | undefined
}): { notes: string; notesSummary: string } | null {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (!summary) return null

  const notes = typeof args.notes === 'string' ? args.notes : ''

  if (notes.trim() === '') {
    return { notes: summary, notesSummary: summary }
  }

  const prev = args.previousSummary
  if (prev && notes.includes(prev)) {
    // Replace only the FIRST occurrence — `String.replace` with a string
    // needle does exactly that, and a literal needle means no regex escaping.
    return { notes: notes.replace(prev, summary), notesSummary: summary }
  }

  return {
    notes: `${notes.replace(/\s+$/, '')}${NOTES_SEPARATOR}${summary}`,
    notesSummary: summary,
  }
}

/**
 * How many times Inngest re-runs an enrichment after the first attempt throws.
 * Consumed by src/lib/inngest/crm-enrichment.ts as the `retries:` value on
 * both registrations. It lives here, in the leaf module, so the dependency
 * runs inngest → lib and never the other way.
 */
export const ENRICHMENT_INNGEST_RETRIES = 2

/**
 * The row's last enrichment OUTCOME off its blob ('enriched', 'failed' or
 * 'skipped'), or null when it never had one. What a row marked 'pending' goes
 * back to when the run it was marked for never happened (a refused run, a lost
 * event), so it neither keeps a spinner nor loses its earlier outcome.
 */
export function lastEnrichmentOutcome(metadata: unknown): 'enriched' | 'failed' | 'skipped' | null {
  if (!metadata || typeof metadata !== 'object') return null
  const e = (metadata as Record<string, unknown>).enrichment
  if (!e || typeof e !== 'object') return null
  const status = (e as Record<string, unknown>).status
  return status === 'enriched' || status === 'failed' || status === 'skipped' ? status : null
}

/** Read the permanent-failure marker off a row's metadata. */
export function hasPermanentFailure(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  const e = (metadata as Record<string, unknown>).enrichment
  if (!e || typeof e !== 'object') return false
  return (e as Record<string, unknown>).permanent === true
}

function buildBlob(args: {
  status: 'enriched' | 'failed' | 'skipped'
  /** The flattened, grounded card plus its `summary` / `sources` bookkeeping. */
  extraction?: Record<string, unknown>
  applied: string[]
  /** Exa's reported cost for the deep search this run made, when it made one. */
  costDollars?: number | null
  error?: string
  permanent?: boolean
  reason?: string
  /** The row's metadata BEFORE this run. Everything the previous blob held
   *  — fields, sources, applied columns, summary, the cost total — is
   *  carried into this one (see mergeBlobFields), so a run
   *  only ever adds to a row. */
  previousMetadata?: unknown
}): EnrichmentBlob {
  const extraction = args.extraction ?? {}
  const rawSources = Array.isArray(extraction.sources) ? extraction.sources : []
  const now = new Date().toISOString()
  const prev = readPreviousBlob(args.previousMetadata)
  const cost = args.costDollars ?? null
  const blob: EnrichmentBlob = {
    version: ENRICHMENT_VERSION,
    status: args.status,
    // A failed run keeps the stamp of the last run that actually found
    // something — that is still when the fields on this blob are from.
    enriched_at: args.status === 'failed' && prev.enrichedAt ? prev.enrichedAt : now,
    last_run_at: now,
    model: ENRICHMENT_ENGINE,
    fields: mergeBlobFields(prev.fields, serializeFields(extraction), now),
    applied_fields: Array.from(new Set([...prev.applied, ...args.applied])),
    sources: mergeBlobSources(rawSources as EnrichmentBlob['sources'], prev.sources),
    summary: typeof extraction.summary === 'string' ? extraction.summary : prev.summary,
    search_cost_dollars: cost,
    total_cost_dollars: Math.round(((prev.totalCost ?? 0) + (cost ?? 0)) * 1e6) / 1e6,
  }
  // Carried on EVERY run: an enriched run that writes no new notes (no trusted
  // summary, the namesake guard) must still keep the anchor to the paragraph
  // already in the notes. A run that does write one overrides it after.
  if (prev.notesSummary) blob.notes_summary = prev.notesSummary
  // Carried, never written here. See the field's doc comment: it is the ICP
  // card's only spend guard, and this blob replaces the previous one wholesale.
  if (prev.icpCardAt) blob.icp_card_at = prev.icpCardAt
  if (args.error) blob.error = args.error
  if (args.reason) blob.error = blob.error ?? args.reason
  if (args.permanent) blob.permanent = true
  return blob
}

/** What a previous blob holds that the next one must carry. Tolerant of
 *  every past shape — any part that does not parse is simply absent. */
function readPreviousBlob(metadata: unknown): {
  fields: Record<string, Record<string, unknown>>
  applied: string[]
  sources: EnrichmentBlob['sources']
  summary: string | null
  notesSummary: string | null
  enrichedAt: string | null
  totalCost: number | null
  icpCardAt: string | null
} {
  const empty = {
    fields: {}, applied: [], sources: [], summary: null, notesSummary: null,
    enrichedAt: null, totalCost: null, icpCardAt: null,
  }
  if (!metadata || typeof metadata !== 'object') return empty
  const e = (metadata as Record<string, unknown>).enrichment
  if (!e || typeof e !== 'object' || Array.isArray(e)) return empty
  const blob = e as Record<string, unknown>

  const fields: Record<string, Record<string, unknown>> = {}
  const enrichedAt = typeof blob.enriched_at === 'string' ? blob.enriched_at : null
  if (blob.fields && typeof blob.fields === 'object' && !Array.isArray(blob.fields)) {
    for (const [key, entry] of Object.entries(blob.fields as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const rec = entry as Record<string, unknown>
      if (rec.value == null || rec.value === '') continue
      // Older entries predate found_at; the run stamp is the best guess.
      fields[key] = rec.found_at ? rec : { ...rec, ...(enrichedAt ? { found_at: enrichedAt } : {}) }
    }
  }
  const sources = Array.isArray(blob.sources)
    ? (blob.sources as unknown[]).filter(
        (s): s is EnrichmentBlob['sources'][number] =>
          !!s && typeof s === 'object' && typeof (s as { url?: unknown }).url === 'string',
      )
    : []
  const applied = Array.isArray(blob.applied_fields)
    ? (blob.applied_fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : []
  const totalRaw = blob.total_cost_dollars ?? blob.search_cost_dollars
  return {
    fields,
    applied,
    sources,
    summary: typeof blob.summary === 'string' && blob.summary.trim() ? blob.summary : null,
    notesSummary:
      typeof blob.notes_summary === 'string' && blob.notes_summary.trim() ? blob.notes_summary : null,
    enrichedAt,
    totalCost: typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : null,
    icpCardAt: typeof blob.icp_card_at === 'string' ? blob.icp_card_at : null,
  }
}

const BLOB_CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }

function blobConfidenceRank(entry: Record<string, unknown> | undefined): number {
  const c = entry?.confidence
  // An entry with no confidence (older engines) is treated as medium: real
  // enough to keep, weak enough that a new high-confidence find replaces it.
  return typeof c === 'string' ? (BLOB_CONFIDENCE_RANK[c] ?? 2) : 2
}

/**
 * The additive merge. Start from everything the previous run held; for each
 * field this run found, replace the old entry unless the new one is LESS
 * confident (a verified fact must never be displaced by a namesake's
 * low-confidence guess). New entries are stamped `found_at` now; carried
 * entries keep their own stamp, so the UI can say how fresh each fact is.
 */
export function mergeBlobFields(
  previous: Record<string, Record<string, unknown>>,
  current: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous }
  for (const [key, entry] of Object.entries(current)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out[key] = entry
      continue
    }
    const rec = entry as Record<string, unknown>
    const prevEntry = previous[key]
    if (prevEntry && blobConfidenceRank(rec) < blobConfidenceRank(prevEntry)) continue
    out[key] = { ...rec, found_at: now }
  }
  return out
}

const MAX_BLOB_SOURCES = 40

/** This run's citations first (they back the freshest fields), then earlier
 *  runs', de-duplicated by URL and capped so a row re-run monthly for years
 *  does not accrete an unbounded list. */
function mergeBlobSources(
  current: EnrichmentBlob['sources'],
  previous: EnrichmentBlob['sources'],
): EnrichmentBlob['sources'] {
  const seen = new Set<string>()
  const out: EnrichmentBlob['sources'] = []
  for (const s of [...current, ...previous]) {
    if (!s || typeof s.url !== 'string' || seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
    if (out.length >= MAX_BLOB_SOURCES) break
  }
  return out
}

/**
 * Re-read a row's CURRENT `metadata` from the database, for use as the
 * "previous blob" of a terminal write.
 *
 * WHY THIS EXISTS. `enrichCompany` / `enrichContact` load the row, then spend
 * 60-180s inside Exa, then build the blob. Using the row loaded at the START as
 * the previous blob makes the terminal write a LAST-WRITE-WINS overwrite of
 * everything anything else merged into `metadata.enrichment` while the search
 * ran — and something else does: `fireIcpCard` (src/lib/prospecting/research.ts)
 * merges the ICP card's `target_customer` / `value_proposition` into the same
 * blob, and POST /api/account/prospecting/source fires it concurrently with the
 * enrichment it just kicked. On production that is exactly what happened to
 * Native Intelligence's own company row: the three CRM cards landed, and the ICP fields the
 * card had merged mid-run were gone.
 *
 * The additive-merge guarantee ("a re-run never loses a finding") is only true
 * if the blob it merges onto is the blob as it stands NOW, so this is read
 * immediately before the write. It is best-effort: on a read error the caller
 * falls back to the row it already has, because losing a concurrent merge is
 * strictly better than failing an otherwise-successful enrichment.
 */
async function currentMetadata(
  supabase: ServiceClient,
  table: 'contact' | 'company',
  id: string,
  workspaceId: string,
  fallback: unknown,
): Promise<unknown> {
  const { data, error } = await supabase
    .from(table)
    .select('metadata')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error || !data) return fallback
  return (data as { metadata?: unknown }).metadata ?? fallback
}

/** A run's search, keeping a running total of what its answers cost. */
interface MeteredSearch {
  search: DeepSearchFn
  /** Dollars billed by every answered card so far (null when none reported a
   *  cost), whether the run goes on to enrich or to fail. */
  spent: () => number | null
}

/**
 * Wrap a run's search so every answered card adds its `costDollars`. The run
 * records this total, not the merged result's: the merge leaves out a card
 * whose answer was replaced (an empty own-domain CORE before its open-web
 * fallback) or that the run never got to merge (a failed run), and Exa bills
 * those all the same.
 */
function meterSearch(search: DeepSearchFn): MeteredSearch {
  let total = 0
  let billed = false
  return {
    search: async (args) => {
      const res = await search(args)
      if (typeof res.costDollars === 'number' && Number.isFinite(res.costDollars)) {
        total += res.costDollars
        billed = true
      }
      return res
    },
    spent: () => (billed ? Math.round(total * 1e6) / 1e6 : null),
  }
}

/** True when at least one field on the card is one a source plainly supports. */
function hasConfidentField(fields: Record<string, GroundedField>): boolean {
  return Object.values(fields).some((f) => COLUMN_CONFIDENCE.has(f.confidence))
}

// ---------------------------------------------------------------------------
// Contact enrichment
// ---------------------------------------------------------------------------

export interface EnrichContactArgs {
  contactId: string
  workspaceId: string
  userId: string | null
  /**
   * Permit enriching a workspace member's OWN self-contact.
   *
   * Skipped by default: searching the web for your own teammates is useless
   * and impolite, and those rows are identity anchors. But onboarding
   * explicitly wants the new user's own contact enriched ("who am I, what do
   * I do"), and a human clicking Enrich on their own or a teammate's card is
   * asking for exactly that too. Those senders pass true.
   */
  allowSelf?: boolean
}

interface ContactRow {
  id: string
  workspace_id: string
  full_name: string | null
  email: string | null
  job_title: string | null
  department: string | null
  linkedin_url: string | null
  notes: string | null
  company_id: string | null
  member_id: string | null
  merged_into_contact_id: string | null
  metadata: unknown
  company?: { name: string | null; domain: string | null } | null
}

/**
 * Decide whether a contact is worth enriching. Returns a skip reason, or null
 * to proceed. Pure so the guard matrix is directly testable.
 *
 *   - member_id set          → a teammate's own self-contact. Searching the
 *                              web for your own users in bulk is both useless
 *                              and impolite; these rows are identity anchors.
 *                              `opts.allowSelf` lifts exactly this one guard,
 *                              for onboarding and explicit manual clicks.
 *   - merged_into_contact_id → a merge tombstone; the surviving row is the
 *                              one worth enriching.
 *   - permanent failure      → a marked row must never be retried.
 *   - no signal              → we need an email, OR a LinkedIn profile, OR a
 *                              full name plus SOME disambiguating context, or
 *                              the search is a bare name-guess that returns
 *                              strangers.
 *
 * A LINKEDIN PROFILE STANDS ALONE, like an email does. THE INCIDENT: Grant
 * Ellery was added with his name and linkedin.com/in/grantellery and nothing
 * else; every Enrich click came back empty in seconds because this guard —
 * which knew about email, company, title and notes but not about LinkedIn —
 * refused to search at all. It was the one identifier the rest of the pipeline
 * trusts most: the query quotes it, and the citation gate treats a page at
 * that exact URL as anchored. (Proven on the live index afterwards: that one
 * profile URL returns his role, employer, location and bio, all cited to his
 * own profile.) An email and a profile URL are the same kind of fact — each
 * names one human — so they get the same standing here.
 *
 * The context that qualifies alongside a name is deliberately wider than a
 * linked company row. Hand-entered contacts routinely carry their employer
 * only as prose — job_title "EVP or CFO (title unverified), Brex", or notes
 * describing them as an Operator Collective LP — which is ample search signal
 * even though no `company_id` or domain was ever structured. So the name-plus
 * branch accepts a structured company signal OR a non-trivial job_title OR
 * non-trivial notes. "Non-trivial" is a trimmed length of >= 3, which keeps
 * out whitespace and stray single characters.
 *
 * Guard matrix (after the three hard skips above):
 *
 *   email    linkedin   name    company   job_title   notes    → result
 *   ──────────────────────────────────────────────────────────────────
 *   yes      any        any     any       any         any      → proceed
 *   any      profile    any     any       any         any      → proceed
 *   no       no         yes     yes       any         any      → proceed
 *   no       no         yes     no        yes         any      → proceed
 *   no       no         yes     no        no          yes      → proceed
 *   no       no         yes     no        no          no       → insufficient_identity_signal
 *   no       no         no      any       any         any      → insufficient_identity_signal
 */
export function contactSkipReason(
  row: {
    member_id?: string | null
    merged_into_contact_id?: string | null
    email?: string | null
    full_name?: string | null
    job_title?: string | null
    notes?: string | null
    linkedin_url?: string | null
    company_id?: string | null
    company?: { name?: string | null; domain?: string | null } | null
    metadata?: unknown
  },
  opts?: { allowSelf?: boolean },
): string | null {
  if (row.member_id && !opts?.allowSelf) return 'workspace_member_self_contact'
  if (row.merged_into_contact_id) return 'merged_tombstone'
  if (hasPermanentFailure(row.metadata)) return 'permanent_failure'

  const nonTrivial = (v: string | null | undefined) => (v ?? '').trim().length >= 3

  const hasEmail = !!row.email?.trim()
  const hasProfile = hasLinkedInProfile(row.linkedin_url)
  const hasName = !!row.full_name?.trim()
  const hasCompanySignal = !!(row.company_id || row.company?.name || row.company?.domain)
  const hasTextSignal = nonTrivial(row.job_title) || nonTrivial(row.notes)
  const hasContext = hasCompanySignal || hasTextSignal
  if (!hasEmail && !hasProfile && !(hasName && hasContext)) {
    return 'insufficient_identity_signal'
  }
  return null
}

export async function enrichContact(
  args: EnrichContactArgs,
): Promise<EnrichmentOutcome> {
  const supabase = getServiceClient()

  const { data: row, error: loadErr } = await supabase
    .from('contact')
    .select(
      'id, workspace_id, full_name, email, job_title, department, linkedin_url, ' +
        'notes, company_id, member_id, merged_into_contact_id, metadata, ' +
        'company:company_id(name, domain)',
    )
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()

  if (loadErr) throw new Error(`contact load failed: ${loadErr.message}`)
  if (!row) return { status: 'skipped', applied: [], reason: 'not_found' }

  const contact = row as unknown as ContactRow

  const skip = contactSkipReason(contact, { allowSelf: args.allowSelf })
  if (skip) {
    // A permanently-failed row keeps its existing blob; re-stamping it would
    // reset the marker's own timestamp on every refused request.
    if (skip !== 'permanent_failure') {
      await writeTerminal(supabase, 'contact', contact.id, args.workspaceId, contact.metadata,
        buildBlob({
          status: 'skipped',
          applied: [],
          reason: skip,
          previousMetadata: contact.metadata,
        }), 'skipped')
    }
    return { status: 'skipped', applied: [], reason: skip }
  }

  const emailDomain = companyDomainFromEmail(contact.email)
  const knownCompanyName = contact.company?.name ?? null
  const knownCompanyDomain = contact.company?.domain ?? null
  const knownDomain = knownCompanyDomain || emailDomain

  // A synced row often carries the raw email (or its local part) in the name
  // column. Sending that as the search subject would look up a mailbox, so the
  // email address itself becomes the query anchor instead.
  const namePlaceholder = isPlaceholderName(contact.full_name, contact.email)
  // The person's own LinkedIn URL is the strongest disambiguator the CRM
  // holds: it names exactly one human. A lnkd.in short link is resolved first
  // so it can be quoted in the query and compared against citations.
  const linkedinUrl = await resolveLinkedInShortLink(contact.linkedin_url)
  const queryArgs = {
    name: namePlaceholder
      ? (contact.email?.trim() ?? '')
      : (contact.full_name?.trim() ?? ''),
    company: knownCompanyName,
    domain: knownDomain,
    jobTitle: contact.job_title,
    linkedinUrl,
  }

  /*
   * Three cards, concurrently, each with the full timeout budget:
   *   1. CORE on the open web (people category) — title, department,
   *      company, location, LinkedIn, summary.
   *   2. BACKGROUND on the open web (people category) — roles, education…
   *   3. CORE again, restricted to the EMPLOYER'S OWN DOMAIN — the team page.
   *      This is the one source that is about this person by construction
   *      (see the Devin Marsh incident on demoteUnrelatedPersonSources), so it
   *      is anchored, never gated, and its fields win the merge. Optional:
   *      many sites have no team page, and a failure here must not sink the
   *      run. Skipped without a domain.
   * Either open-web card failing fails the run: a half-answered entity would
   * write a card's worth of gaps into columns that are then never re-filled
   * (the write-back is fill-empty). The three are awaited together all the
   * same (allSettled), so a failed run still knows what its answered cards
   * cost, and none is still in flight when the outcome is written.
   */
  const [coreSchema, backgroundSchema] = PERSON_CARD_SCHEMAS
  let metered: MeteredSearch
  try {
    // Exa's, or the person's own ChatGPT plan's (a throw: their plan can't be read).
    metered = meterSearch(await deepSearchForUser(args.userId, args.workspaceId))
  } catch (err) {
    return failEntity(supabase, 'contact', contact.id, args.workspaceId, contact.metadata, err)
  }
  const openWeb = (outputSchema: object) =>
    metered.search({
      query: personProfileQuery(queryArgs),
      category: 'people',
      outputSchema,
      additionalQueries: personAdditionalQueries(queryArgs),
      signal: AbortSignal.timeout(DEEP_SEARCH_TIMEOUT_MS),
    })
  const [coreCard, backgroundCard, ownDomainCard] = await Promise.allSettled([
    openWeb(coreSchema),
    openWeb(backgroundSchema),
    knownDomain
      ? metered.search({
          query: personProfileQuery(queryArgs),
          outputSchema: PERSON_CARD_CORE,
          includeDomains: [knownDomain],
          additionalQueries: personAdditionalQueries(queryArgs),
          signal: AbortSignal.timeout(DEEP_SEARCH_TIMEOUT_MS),
        })
      : Promise.resolve(null),
  ])
  if (coreCard.status === 'rejected' || backgroundCard.status === 'rejected') {
    const err = coreCard.status === 'rejected' ? coreCard.reason : (backgroundCard as PromiseRejectedResult).reason
    return failEntity(
      supabase, 'contact', contact.id, args.workspaceId, contact.metadata, err, metered.spent(),
    )
  }
  const peopleCore = coreCard.value
  const peopleBackground = backgroundCard.value
  const ownDomainCore = ownDomainCard.status === 'fulfilled' ? ownDomainCard.value : null

  // Gate the open-web cards, then let the own-domain card override: a field
  // the employer's own site states beats the same field off a stranger's
  // profile. Everything the gate demotes stays in the blob at 'low'.
  const identity = {
    name: queryArgs.name,
    companyName: knownCompanyName,
    companyDomain: knownDomain,
    linkedinUrl,
  }
  const gate = (r: DeepSearchResult) => demoteUnrelatedPersonSources(groundedFields(r), identity)
  const fields: Record<string, GroundedField> = {
    ...gate(peopleCore),
    ...gate(peopleBackground),
    ...(ownDomainCore ? groundedFields(ownDomainCore) : {}),
  }
  const res = mergeDeepSearchResults([
    peopleCore,
    peopleBackground,
    ...(ownDomainCore ? [ownDomainCore] : []),
  ])
  const sources = sourcesOf(res)

  if (Object.keys(fields).length === 0 && sources.length === 0) {
    // Nothing at all — not an error, just nothing to say. Recorded as a
    // terminal outcome so the card says the web was searched.
    const latest = await currentMetadata(
      supabase, 'contact', contact.id, args.workspaceId, contact.metadata,
    )
    const blob = buildBlob({
      status: 'failed',
      applied: [],
      costDollars: metered.spent(),
      error: 'no_search_results',
      previousMetadata: latest,
    })
    await writeTerminal(supabase, 'contact', contact.id, args.workspaceId, latest, blob, 'failed')
    return { status: 'failed', applied: [], error: blob.error }
  }

  /*
   * NAMESAKE GUARD. A common name with a thin identity comes back as a
   * confident-looking card about a DIFFERENT person, and writing that into the
   * CRM is worse than writing nothing. TWO things must both hold before we
   * discard it: nothing on the card reached high/medium (so Exa itself was
   * unsure), AND the employer the card names contradicts the domain/company we
   * already know. A card that merely found little, or one that agrees with the
   * known employer, is kept. The discard still writes an 'enriched' blob with
   * empty fields — the existing empty-enrichment UI path — so the row is
   * terminal and its card says what was searched.
   */
  const cardDomain = normalizeDomain(fields.company_domain?.value ?? null)
  const cardCompany = fields.company_name?.value?.trim().toLowerCase() ?? null
  const knownName = knownCompanyName?.trim().toLowerCase() ?? null
  const contradictsKnownEmployer =
    (!!knownDomain && !!cardDomain && cardDomain !== knownDomain) ||
    (!!knownName &&
      !!cardCompany &&
      !cardCompany.includes(knownName) &&
      !knownName.includes(cardCompany))

  if (!hasConfidentField(fields) && contradictsKnownEmployer) {
    const latest = await currentMetadata(
      supabase, 'contact', contact.id, args.workspaceId, contact.metadata,
    )
    const blob = buildBlob({
      status: 'enriched',
      extraction: { sources },
      applied: [],
      costDollars: metered.spent(),
      previousMetadata: latest,
    })
    await writeTerminal(
      supabase, 'contact', contact.id, args.workspaceId, latest, blob, 'enriched',
    )
    return { status: 'enriched', applied: [] }
  }

  // ── Column write-back (fill-empty only) ──────────────────
  const candidates = columnCandidates({
    job_title: fields.job_title,
    department: fields.department,
    linkedin_url: fields.linkedin_url,
  })
  const patch = computeFillEmptyPatch(
    {
      job_title: contact.job_title,
      department: contact.department,
      linkedin_url: contact.linkedin_url,
    },
    candidates,
  )

  // `full_name` sits OUTSIDE the fill-empty merge on purpose: the rows worth
  // fixing have a non-empty name that is really the email address, which
  // computeFillEmptyPatch would (correctly, by its own rule) leave alone. The
  // placeholder test is the only thing that authorizes an overwrite here.
  // Confidence is still gated to high/medium via columnCandidates.
  const foundName = columnCandidates({ full_name: fields.full_name }).full_name
  if (typeof foundName === 'string' && namePlaceholder) {
    patch.full_name = foundName
  }

  const applied = Object.keys(patch)

  // ── Company creation from a discovered domain ────────────
  // Only when the contact has no company yet. We create the company row and
  // let the mig-232 autolink trigger attach the contact — setting company_id
  // by hand here would race the trigger and bypass its freemail/member rules.
  let createdCompanyId: string | undefined
  const foundDomain = columnCandidates({ company_domain: fields.company_domain }).company_domain
  const discoveredDomain = normalizeDomain(
    typeof foundDomain === 'string' ? foundDomain : null,
  )
  const discoveredName = columnCandidates({ company_name: fields.company_name }).company_name
  if (!contact.company_id && discoveredDomain && !isPersonalDomain(discoveredDomain)) {
    createdCompanyId =
      (await ensureCompanyForDomain(supabase, {
        workspaceId: args.workspaceId,
        domain: discoveredDomain,
        name: typeof discoveredName === 'string' ? discoveredName : null,
      })) ?? undefined
  }

  /*
   * …except that the trigger links by EMAIL DOMAIN, so a contact with no
   * email is never adopted by the company we just created for them. That used
   * to be unreachable — nothing without an email got this far — and became
   * live the moment a LinkedIn URL was enough to search on: Grant Ellery came
   * back as Co-Founder of Stage 2 Capital, the company row was created, and
   * his card still said no company.
   *
   * So the link is made here for exactly that case. There is no race to lose:
   * the trigger only fires on an email that changed, and this row has none.
   * It is stamped `company_autolinked` like every other derived assignment.
   */
  const linkedCompanyId =
    createdCompanyId && !contact.email?.trim() ? createdCompanyId : undefined
  if (linkedCompanyId) patch.company_id = linkedCompanyId

  // The blob keeps EVERY grounded field except the summary, which has its own
  // top-level slot (and, for contacts, ends up in the notes).
  const { summary: summaryField, ...blobFields } = fields
  // The bio is prose about a PERSON, and a namesake's bio in Notes is worse
  // than none. Only a summary the gate left at column confidence is written;
  // otherwise the blob keeps the previous summary and Notes are left alone.
  const trustedSummary =
    summaryField && COLUMN_CONFIDENCE.has(summaryField.confidence) ? summaryField.value : null
  // The blob is built on the row's metadata AS IT STANDS NOW, not on the copy
  // loaded before the search ran — see `currentMetadata`. Anything that merged
  // into `metadata.enrichment` during those 60-180s survives.
  const latest = await currentMetadata(
    supabase, 'contact', contact.id, args.workspaceId, contact.metadata,
  )
  const blob = buildBlob({
    status: 'enriched',
    extraction: { ...blobFields, summary: trustedSummary, sources },
    applied,
    costDollars: metered.spent(),
    previousMetadata: latest,
  })

  // ── Notes append (contacts only) ─────────────────────────
  // The bio paragraph belongs in the contact's Notes, not buried in a sidebar
  // section. Unlike the columns above this is NOT a fill-empty write: existing
  // notes are preserved and the summary is appended after them, or — on a
  // re-run — swapped in place of the block the previous run left behind. The
  // anchor comes off the FRESH metadata for the same reason the blob does.
  const notesResult = applySummaryToNotes({
    notes: contact.notes,
    summary: trustedSummary,
    previousSummary: previousNotesSummary(latest),
  })
  if (notesResult) {
    patch.notes = notesResult.notes
    blob.notes_summary = notesResult.notesSummary
  }

  // A company_id set here is a DERIVED assignment, and migration 232 stamps
  // every one of those so they stay distinguishable from a deliberate one.
  const metadataBase =
    latest && typeof latest === 'object' && !Array.isArray(latest)
      ? (latest as Record<string, unknown>)
      : {}
  const metadataForWrite = linkedCompanyId
    ? { ...metadataBase, company_autolinked: true }
    : latest

  await writeTerminal(
    supabase, 'contact', contact.id, args.workspaceId, metadataForWrite, blob, 'enriched', patch,
  )

  return { status: 'enriched', applied, createdCompanyId }
}

// ---------------------------------------------------------------------------
// Company enrichment
// ---------------------------------------------------------------------------

export interface EnrichCompanyArgs {
  companyId: string
  workspaceId: string
  userId: string | null
}

interface CompanyRow {
  id: string
  workspace_id: string
  name: string | null
  domain: string | null
  website: string | null
  industry: string | null
  description: string | null
  employee_count_range: string | null
  annual_revenue_range: string | null
  city: string | null
  state: string | null
  country: string | null
  address: string | null
  phone: string | null
  contact_email: string | null
  metadata: unknown
}

const COMPANY_COLUMNS = [
  'website', 'industry', 'description', 'employee_count_range',
  'annual_revenue_range', 'city', 'state', 'country',
  'address', 'phone', 'contact_email',
] as const

/**
 * True when a company row's `name` is machine filler rather than a name a
 * human or a source supplied. `ensureCompanyForDomain` writes the domain into
 * the NOT NULL name column when it has nothing better, and the mig-232
 * autolink does the same, so 'acme.com' as a company name is the norm on a
 * freshly-created row — and the one case where an Exa-found name may overwrite.
 */
function isPlaceholderCompanyName(
  name: string | null | undefined,
  domain: string | null | undefined,
): boolean {
  const n = (name ?? '').trim()
  if (n === '') return true
  const d = (domain ?? '').trim().toLowerCase()
  return d !== '' && n.toLowerCase() === d
}

/**
 * Enrich one company.
 *
 * WALL CLOCK: the cards run SEQUENTIALLY (the DETAILS query depends on the
 * name CORE resolved), each with its own DEEP_SEARCH_TIMEOUT_MS. Worst case is
 * therefore 3 x 60s = ~180s when the own-domain CORE times out, falls back to
 * the open web, and DETAILS is slow too. That fits the Inngest route's
 * maxDuration=300, but any caller with a tighter ceiling — the internal
 * onboarding route currently sits at 120 — must raise it to match.
 */
export async function enrichCompany(
  args: EnrichCompanyArgs,
): Promise<EnrichmentOutcome> {
  const supabase = getServiceClient()

  const { data: row, error: loadErr } = await supabase
    .from('company')
    .select(
      'id, workspace_id, name, domain, website, industry, description, ' +
        'employee_count_range, annual_revenue_range, city, state, country, ' +
        'address, phone, contact_email, metadata',
    )
    .eq('id', args.companyId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()

  if (loadErr) throw new Error(`company load failed: ${loadErr.message}`)
  if (!row) return { status: 'skipped', applied: [], reason: 'not_found' }

  const company = row as unknown as CompanyRow

  if (hasPermanentFailure(company.metadata)) {
    return { status: 'skipped', applied: [], reason: 'permanent_failure' }
  }
  const domain = company.domain?.trim() ?? ''
  const name = company.name?.trim() ?? ''
  if (!name && !domain) {
    const blob = buildBlob({
      status: 'skipped',
      applied: [],
      reason: 'insufficient_identity_signal',
      previousMetadata: company.metadata,
    })
    await writeTerminal(supabase, 'company', company.id, args.workspaceId, company.metadata, blob, 'skipped')
    return { status: 'skipped', applied: [], reason: 'insufficient_identity_signal' }
  }

  /*
   * IDENTITY ANCHORING. The plain recipe query is not enough: enriching
   * dial8.ai returned a LONDON COCKTAIL BAR ("dial8 is a cocktail bar at
   * Number Nine, Hotel Varenne", Hospitality at HIGH confidence) on two of four
   * live runs. So the cards run SEQUENTIALLY, each anchored a different way:
   *
   *   1. CORE, restricted to the company's OWN domain when we know it. A card
   *      built only from their own site cannot describe someone else. This is
   *      where description/industry/website/socials/HQ should come from.
   *   2. CORE fallback on the open web, only if (1) found nothing at all (site
   *      blocked, JS-only, or brand-new). Gated by `demoteUnrelatedSources`.
   *   3. DETAILS on the open web, its query built from the name CORE
   *      resolved, because funding/investors/headcount genuinely are not on
   *      the company's own site. Also gated.
   *
   * Sequential and not Promise.all because step 3's query depends on step 1's
   * answer. Worst case is 3 calls x DEEP_SEARCH_TIMEOUT_MS = ~180s, which fits
   * the Inngest route's maxDuration=300 but NOT a 120s caller — the internal
   * onboarding route needs its own ceiling raised to match.
   */
  const [coreSchema, detailsSchema, contactSchema] = COMPANY_CARD_SCHEMAS
  // Exa's, or the person's own ChatGPT plan's (a throw: their plan can't be read).
  let metered: MeteredSearch
  try {
    metered = meterSearch(await deepSearchForUser(args.userId, args.workspaceId))
  } catch (err) {
    return failEntity(supabase, 'company', company.id, args.workspaceId, company.metadata, err)
  }
  const runCard = (opts: {
    query: string
    outputSchema: object
    includeDomains?: string[]
    additionalQueries?: string[]
  }) =>
    metered.search({
      query: opts.query,
      category: 'company',
      outputSchema: opts.outputSchema,
      includeDomains: opts.includeDomains,
      additionalQueries: opts.additionalQueries,
      signal: AbortSignal.timeout(DEEP_SEARCH_TIMEOUT_MS),
    })

  let coreRes: DeepSearchResult
  let detailsRes: DeepSearchResult
  // CONTACT card, own-domain like CORE. Null for a name-only row (nothing to
  // anchor to) or when the card itself failed — it is optional by design.
  let contactRes: DeepSearchResult | null = null
  // Whether the CORE card came off the company's own site. An own-domain card
  // is anchored by construction and must NOT go through the relevance gate.
  let coreWasDomainAnchored = false
  try {
    if (domain) {
      coreRes = await runCard({
        query: companyProfileQuery(domain),
        outputSchema: coreSchema,
        includeDomains: [domain],
      })
      coreWasDomainAnchored = Object.keys(groundedFields(coreRes)).length > 0
      if (!coreWasDomainAnchored) {
        // Their own site told us nothing — blocked, empty, or unindexed. Fall
        // back to the open web, where the gate below has to earn every field.
        coreRes = await runCard({
          query: companyProfileQuery(domain),
          outputSchema: coreSchema,
        })
      }
    } else {
      coreRes = await runCard({
        query: companyProfileQuery(name),
        outputSchema: coreSchema,
      })
    }

    // The name CORE actually resolved is a better search handle than a
    // placeholder row name ('acme.com') or a bare domain.
    const coreFields = groundedFields(coreRes)
    const confidentCoreName = columnCandidates({ name: coreFields.company_name }).name
    const resolvedName =
      (typeof confidentCoreName === 'string' ? confidentCoreName : null) ??
      (isPlaceholderCompanyName(company.name, company.domain) ? null : name) ??
      domain

    // Awaited together (allSettled) so a DETAILS failure still waits for the
    // CONTACT card, and the failed run records what both cost.
    const [detailsCard, contactCard] = await Promise.allSettled([
      runCard({
        query:
          `${resolvedName}${domain ? ` (${domain})` : ''} company profile: funding stage, ` +
          'total funding raised, investors, founded year, headcount, leadership, headquarters',
        outputSchema: detailsSchema,
        additionalQueries: [
          ...(domain ? [`"${resolvedName}" ${domain} funding investors`] : []),
          `"${resolvedName}" crunchbase OR linkedin company`,
        ],
      }),
      // CONTACT: email, phone, postal address, contact page. These live on the
      // company's own contact page, so the card is own-domain anchored — and
      // skipped for a name-only row, where "Acme's phone number" off the open
      // web is exactly the namesake guess we refuse to store. A failure here
      // (timeout, 5xx) must not sink the run: CORE and DETAILS still land.
      domain
        ? runCard({
            query: companyContactQuery(resolvedName, domain),
            outputSchema: contactSchema,
            includeDomains: [domain],
          })
        : Promise.resolve(null),
    ])
    if (detailsCard.status === 'rejected') throw detailsCard.reason
    detailsRes = detailsCard.value
    contactRes = contactCard.status === 'fulfilled' ? contactCard.value : null
  } catch (err) {
    return failEntity(
      supabase, 'company', company.id, args.workspaceId, company.metadata, err, metered.spent(),
    )
  }

  /*
   * Gate each card by how it was retrieved, THEN merge. An own-domain CORE is
   * already anchored; every open-web card must prove each field is about this
   * company (own domain, or a citation title carrying the name).
   * `demoteLookAlikeSources` still runs over everything to catch the
   * dialzy.ai/dialova.ca family, which a title match could otherwise wave
   * through.
   */
  const identity = { domain: company.domain, name: company.name }
  const gate = (r: DeepSearchResult, alreadyAnchored: boolean) => {
    const f = groundedFields(r)
    return demoteLookAlikeSources(
      alreadyAnchored ? f : demoteUnrelatedSources(f, identity),
      company.domain,
    )
  }
  const res = mergeDeepSearchResults([coreRes, detailsRes, ...(contactRes ? [contactRes] : [])])
  const fields = {
    ...gate(detailsRes, false),
    // Own-domain by construction — anchored, so only the look-alike check.
    ...(contactRes ? gate(contactRes, true) : {}),
    ...gate(coreRes, coreWasDomainAnchored),
  }
  const sources = sourcesOf(res)

  if (Object.keys(fields).length === 0 && sources.length === 0) {
    const latest = await currentMetadata(
      supabase, 'company', company.id, args.workspaceId, company.metadata,
    )
    const blob = buildBlob({
      status: 'failed',
      applied: [],
      costDollars: metered.spent(),
      error: 'no_search_results',
      previousMetadata: latest,
    })
    await writeTerminal(supabase, 'company', company.id, args.workspaceId, latest, blob, 'failed')
    return { status: 'failed', applied: [], error: blob.error }
  }

  /*
   * COMPANY NAMESAKE GUARD. If the gate above left NOTHING at high/medium,
   * then not one field could be tied to this company — which is exactly what
   * the cocktail-bar run looked like (own-domain CORE empty, open-web CORE
   * full of hotelvarenne.com citations). Storing that card would put another
   * business's industry and description into the CRM, so write the
   * empty-enrichment blob instead: terminal, zero columns, and the UI already
   * renders it as "Searched the web - no additional information found". The
   * sources are kept so a human can see what was found and judge for
   * themselves.
   */
  if (!hasConfidentField(fields)) {
    const latest = await currentMetadata(
      supabase, 'company', company.id, args.workspaceId, company.metadata,
    )
    const blob = buildBlob({
      status: 'enriched',
      extraction: { sources },
      applied: [],
      costDollars: metered.spent(),
      previousMetadata: latest,
    })
    await writeTerminal(
      supabase, 'company', company.id, args.workspaceId, latest, blob, 'enriched',
    )
    return { status: 'enriched', applied: [] }
  }

  const candidates = columnCandidates({
    website: fields.website,
    industry: fields.industry,
    description: fields.description,
    employee_count_range: fields.employee_count,
    annual_revenue_range: fields.annual_revenue,
    city: fields.headquarters_city,
    state: fields.headquarters_state,
    country: fields.headquarters_country,
    address: fields.street_address,
    phone: fields.phone,
    contact_email: fields.contact_email,
  })

  // Last gate on the enum column: Exa reports headcount as prose or an
  // off-enum band. Drop what won't map rather than writing an invalid value.
  if (typeof candidates.employee_count_range === 'string') {
    const mapped = normalizeEmployeeRange(candidates.employee_count_range)
    if (mapped) candidates.employee_count_range = mapped
    else delete candidates.employee_count_range
  }
  // Shape gates on the contact columns: an email must look like one (stored
  // lowercase, unwrapped from "Email: …"), a phone must carry real digits.
  // Prose such as "via the website form" is dropped, not written.
  if (typeof candidates.contact_email === 'string') {
    const email = normalizeContactEmail(candidates.contact_email)
    if (email) candidates.contact_email = email
    else delete candidates.contact_email
  }
  if (typeof candidates.phone === 'string') {
    const phone = normalizePhone(candidates.phone)
    if (phone) candidates.phone = phone
    else delete candidates.phone
  }

  const local: Record<string, unknown> = {}
  for (const c of COMPANY_COLUMNS) local[c] = company[c]
  const patch = computeFillEmptyPatch(local, candidates)

  // `name` sits OUTSIDE the fill-empty merge for the same reason `full_name`
  // does on contacts: an auto-created row's name IS its domain, which is
  // non-empty and therefore untouchable by the merge, and is exactly the value
  // a real found name should replace.
  const foundName = columnCandidates({ name: fields.company_name }).name
  if (
    typeof foundName === 'string' &&
    isPlaceholderCompanyName(company.name, company.domain)
  ) {
    patch.name = foundName
  }

  const applied = Object.keys(patch)

  // The blob carries EVERY grounded field, including the many with no column:
  // funding stage, total raised, investors, company stage, key people,
  // products, target customers, recent news, socials, founded year.
  const { summary: summaryField, ...blobFields } = fields
  const employeeRange = normalizeEmployeeRange(fields.employee_count?.value)
  // The row's metadata AS IT STANDS NOW. The three cards above took 60-180s,
  // and `fireIcpCard` merges `target_customer` / `value_proposition` into this
  // very blob concurrently (POST /api/account/prospecting/source fires both).
  // Building on `company.metadata` — the copy loaded before the search — made
  // this write a silent overwrite of whatever landed meanwhile, which is how
  // Native Intelligence's own row lost its ICP fields on production. See `currentMetadata`.
  const latest = await currentMetadata(
    supabase, 'company', company.id, args.workspaceId, company.metadata,
  )
  const blob = buildBlob({
    status: 'enriched',
    extraction: {
      ...blobFields,
      // The normalized bucket alongside the raw headcount, so the UI can show
      // the band even when the column was already populated.
      ...(employeeRange && fields.employee_count
        ? { employee_count_range: { ...fields.employee_count, value: employeeRange } }
        : {}),
      summary: summaryField?.value ?? fields.description?.value ?? null,
      sources,
    },
    applied,
    costDollars: metered.spent(),
    previousMetadata: latest,
  })

  await writeTerminal(
    supabase, 'company', company.id, args.workspaceId, latest, blob, 'enriched', patch,
  )

  return { status: 'enriched', applied }
}

// ---------------------------------------------------------------------------
// Shared DB write paths
// ---------------------------------------------------------------------------

type ServiceClient = ReturnType<typeof getServiceClient>

/**
 * The single terminal write: status + timestamp + merged metadata + whatever
 * column patch survived the fill-empty merge, in ONE update so a row is never
 * left half-written. Always re-filtered on workspace_id — the id and workspace
 * both come from an event payload.
 */
async function writeTerminal(
  supabase: ServiceClient,
  table: 'contact' | 'company',
  id: string,
  workspaceId: string,
  existingMetadata: unknown,
  blob: EnrichmentBlob,
  status: 'enriched' | 'failed' | 'skipped',
  columnPatch: Record<string, unknown> = {},
): Promise<void> {
  const update: Record<string, unknown> = {
    ...columnPatch,
    enrichment_status: status,
    enriched_at: blob.enriched_at,
    metadata: mergeEnrichmentMetadata(existingMetadata, blob),
    updated_at: blob.enriched_at,
  }
  const { error } = await supabase
    .from(table)
    .update(update)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`${table} enrichment write failed: ${error.message}`)
}

/**
 * Record a failure and rethrow-or-return. Two kinds are recorded and RETURNED:
 *
 *   - a PERMANENT failure (a request Exa will reject identically forever);
 *   - the search account being OUT OF CREDITS (Exa's 402). That is the
 *     account, not this row: retrying in seconds only asks Exa again, and the
 *     row stays re-runnable (never `permanent`) for once someone tops it up.
 *
 * Everything else — network, Exa 5xx, rate limit, unconfigured key, our own
 * timeout — is recorded and RETHROWN so Inngest retries.
 *
 * `costDollars` is what the run's answered cards billed before it failed
 * (meterSearch), so the blob's totals carry real spend.
 *
 * A timeout gets a WRITTEN-OUT message rather than the raw one. An
 * AbortSignal.timeout surfaces as "The operation was aborted", which reads
 * like a bug and says nothing about what stalled — three days of the
 * 2026-09-01 outage were spent chasing an equally unhelpful string. The
 * synthesized message names the stage and the budget it blew, so the row
 * itself says what happened. Out of credits gets one too: Exa's raw 402 is a
 * JSON body, and the person reading it on the card needs to know what to do.
 */
async function failEntity(
  supabase: ServiceClient,
  table: 'contact' | 'company',
  id: string,
  workspaceId: string,
  existingMetadata: unknown,
  err: unknown,
  costDollars: number | null = null,
): Promise<EnrichmentOutcome> {
  const raw = err instanceof Error ? err.message : String(err)
  const outOfCredits = isBillingError(err)
  const message = outOfCredits
    ? err instanceof ExaRequestError
      ? EXA_OUT_OF_CREDITS_MESSAGE
      : SEARCH_OUT_OF_CREDITS_MESSAGE
    : isTimeoutError(err)
      ? `search stage timed out after ${DEEP_SEARCH_TIMEOUT_MS}ms (upstream returned nothing)`
      : raw
  const permanent = isPermanentModelError(err)
  const blob = buildBlob({
    status: 'failed',
    applied: [],
    costDollars,
    error: message.slice(0, 500),
    permanent,
    previousMetadata: existingMetadata,
  })
  await writeTerminal(supabase, table, id, workspaceId, existingMetadata, blob, 'failed')
  if (!permanent && !outOfCredits) throw err
  return { status: 'failed', applied: [], error: message }
}

/**
 * What a run that Exa refused for credit says, on the card and to the person
 * who asked (who is a Native Intelligence customer, not the holder of Native Intelligence's Exa account:
 * the 402 tells ops what happened, the rest tells the person what to do).
 */
export const EXA_OUT_OF_CREDITS_MESSAGE =
  'Web search is out of credits right now (Exa 402), so nothing was found. Try again later.'
/** The same for a search that isn't Exa's (the person's own ChatGPT plan). */
const SEARCH_OUT_OF_CREDITS_MESSAGE =
  'The web search is out of credits or quota. Try again once it is topped up.'

/**
 * Phrases an upstream uses when the ACCOUNT is out of money rather than the
 * request being wrong. Matched case-insensitively against the whole error
 * message chain. Kept deliberately specific — 'credit' alone would also match
 * a page's own prose about a credit union.
 */
const BILLING_MESSAGE_PATTERNS = [
  'credit balance',
  'insufficient credit',
  'insufficient_credit',
  'insufficient funds',
  'insufficient_quota',
  'billing hard limit',
  'payment required',
  'payment_required',
  'quota exceeded',
  'exceeded your current quota',
  // Exa's own 402 body: "You have exceeded your credits limit. Please top up…"
  'exceeded your credits limit',
] as const

/** Pull an HTTP status off an error however it happens to be exposed.
 *  `ExaRequestError` carries `status`; fetch-ish errors carry `status` or
 *  `statusCode`; a wrapper hangs the real one off `cause` / `data`. */
function errorStatuses(err: unknown, depth = 0): number[] {
  if (!err || typeof err !== 'object' || depth > 4) return []
  const e = err as Record<string, unknown>
  const out: number[] = []
  for (const key of ['statusCode', 'status', 'httpStatus']) {
    const v = e[key]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  for (const key of ['cause', 'lastError', 'data', 'error', 'response']) {
    out.push(...errorStatuses(e[key], depth + 1))
  }
  if (Array.isArray(e.errors)) {
    for (const nested of e.errors) out.push(...errorStatuses(nested, depth + 1))
  }
  return out
}

/** Every message-ish string on an error and its nested causes, lowercased. */
function errorMessages(err: unknown, depth = 0): string {
  if (err == null || depth > 4) return ''
  if (typeof err === 'string') return err.toLowerCase()
  if (typeof err !== 'object') return ''
  const e = err as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['message', 'responseBody', 'body', 'detail', 'type', 'code']) {
    const v = e[key]
    if (typeof v === 'string') parts.push(v.toLowerCase())
  }
  for (const key of ['cause', 'lastError', 'data', 'error', 'response']) {
    parts.push(errorMessages(e[key], depth + 1))
  }
  if (Array.isArray(e.errors)) {
    for (const nested of e.errors) parts.push(errorMessages(nested, depth + 1))
  }
  return parts.join(' ')
}

/**
 * True when the failure is the ACCOUNT running out of credit/quota rather than
 * anything wrong with the request.
 *
 * This is the textbook TRANSIENT error — it heals the instant someone tops the
 * account up — but it arrives as a 4xx, so without this test the plain "4xx is
 * permanent" rule below would stamp `permanent: true` on the row and block
 * every future retry, manual re-enrich included. That is exactly what happened
 * in prod when the Vercel AI Gateway ran dry: 137 contacts + 28 companies were
 * permanently marked over a billing blip.
 *
 * Never permanent, but never retried in seconds either: failEntity records it
 * and returns, since asking again before a top-up gets the same refusal.
 *
 * Detected two ways, because a wrapper may or may not preserve the status:
 *   - HTTP 402 anywhere in the error chain, OR
 *   - a message matching a billing phrase ('credit balance', …).
 */
export function isBillingError(err: unknown): boolean {
  if (errorStatuses(err).includes(402)) return true
  const message = errorMessages(err)
  if (!message) return false
  return BILLING_MESSAGE_PATTERNS.some((p) => message.includes(p))
}

/** Error `name`s an aborted-by-timeout call arrives under. `AbortSignal.timeout`
 *  rejects with a DOMException named 'TimeoutError'; a caller-triggered abort
 *  and some polyfills use 'AbortError'. */
const TIMEOUT_ERROR_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'AI_AbortError',
  'AI_ToolExecutionError_Aborted',
])

/** Every `name` on an error and its nested causes. Mirrors errorMessages so a
 *  DOMException buried under a wrapper is still visible. */
function errorNames(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== 'object' || depth > 4) return []
  const e = err as Record<string, unknown>
  const out: string[] = []
  if (typeof e.name === 'string') out.push(e.name)
  for (const key of ['cause', 'lastError', 'data', 'error', 'response']) {
    out.push(...errorNames(e[key], depth + 1))
  }
  if (Array.isArray(e.errors)) {
    for (const nested of e.errors) out.push(...errorNames(nested, depth + 1))
  }
  return out
}

/**
 * True when the call was aborted by our own DEEP_SEARCH_TIMEOUT_MS.
 *
 * This is TRANSIENT by definition: the upstream was slow this once, not the
 * request wrong. The whole point of the timeout is to fail fast enough that
 * Inngest gets a real retry instead of Vercel killing the function at 300s —
 * so stamping `permanent: true` here would defeat the fix and block every
 * future re-enrich of the row, the same way the billing 4xx did.
 */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && TIMEOUT_ERROR_NAMES.has(err.name)) return true
  if (errorNames(err).some((n) => TIMEOUT_ERROR_NAMES.has(n))) return true
  const message = errorMessages(err)
  if (!message) return false
  return (
    message.includes('the operation was aborted') ||
    message.includes('signal timed out') ||
    message.includes('operation timed out') ||
    message.includes('request timed out')
  )
}

/**
 * 4xx statuses that are NOT the request's fault and heal on their own:
 * 402 payment (isBillingError catches it first), 408 timeout, 425 too early,
 * 429 rate limit. Everything else in the 4xx range means Exa will reject the
 * identical request forever.
 */
const TRANSIENT_4XX = new Set([402, 408, 425, 429])

/**
 * True for errors that will recur identically on a retry — a request Exa
 * rejects as malformed or unauthorized. Everything else is assumed transient
 * so Inngest's retries can do their job: 5xx, network failures and our own
 * aborts all get retried.
 *
 * `ExaNotConfiguredError` is TRANSIENT: a missing EXA_API_KEY is an
 * environment problem that heals the moment the var lands, and marking every
 * row permanent over a deploy misconfiguration would need a migration to undo.
 *
 * Billing exhaustion and our own abort timeouts are checked FIRST and always
 * win: billing presents as a 4xx (402) but is the most transient failure there
 * is, and an abort can surface under a wrapper that would otherwise trip the
 * status rule below.
 */
export function isPermanentModelError(err: unknown): boolean {
  if (isBillingError(err)) return false
  if (isTimeoutError(err)) return false
  if (err instanceof ExaNotConfiguredError) return false

  for (const status of errorStatuses(err)) {
    if (status >= 400 && status < 500) return !TRANSIENT_4XX.has(status)
  }
  return false
}

/**
 * Find-or-create the workspace's company for a domain: `UNIQUE (workspace_id,
 * domain)`, check-then-insert so a re-run never blanks a richer existing row,
 * and only the fields we actually have. Returns the id, or null when the write
 * raced/failed (a lost race is not an enrichment failure — the company exists
 * either way).
 *
 * EXPORTED because the onboarding internal route creates the new user's own
 * company through exactly this path before enriching it, and a second
 * implementation would drift from the unique-constraint handling here.
 */
export async function ensureCompanyForDomain(
  supabase: ServiceClient,
  args: { workspaceId: string; domain: string; name: string | null },
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('company')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('domain', args.domain)
    .maybeSingle()
  if (existing) return (existing as { id: string }).id

  const { data: created, error } = await supabase
    .from('company')
    .insert({
      workspace_id: args.workspaceId,
      domain: args.domain,
      // `company.name` is NOT NULL — fall back to the domain when we found a
      // domain but no clean name.
      name: args.name?.trim() || args.domain,
    })
    .select('id')
    .maybeSingle()

  if (error || !created) {
    console.error('[crm-enrichment] company create failed', error?.message)
    return null
  }
  return (created as { id: string }).id
}
