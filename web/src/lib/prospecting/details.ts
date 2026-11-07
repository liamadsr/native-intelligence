/**
 * The prospect entry's DETAILS MODEL — `prospect_list_entry.research` (plus
 * the candidate's own fields) laid out as the SAME sectioned view the CRM
 * company Details tab renders, so a candidate reads like the CRM record it is
 * about to become (Liam, 2026-09-06: "make it look as similar as possible to
 * our CRM page, like how we display companies … once these get created into
 * your CRM, then it's kind of like already similar").
 *
 * The blob is deliberately `company.metadata.enrichment.fields`-shaped, so the
 * CRM's tolerant reader (`readBlob`), its field assembly and its low-confidence
 * quarantine all apply unchanged. What this module owns is the CATALOG: which
 * research key lands in which section under which label — the CRM's own keys
 * (`industry`, `key_people`, `products_and_services`…) side by side with the
 * prospecting cards' keys (`total_raised`, `growth_signals`, `tech_stack`…),
 * because both generations of enricher write into this column.
 *
 * Three things are deliberately NOT in the sections, because the panel shows
 * them elsewhere and printing them twice was the "thrown in here" feeling:
 * the identity (`name`, `domain`, `one_liner` — the header), the verdict
 * (`why_fit`, `why_match` — the Match block) and, for a person, the identity
 * fields the sidebar carries. A key nobody catalogued still lands under
 * "Other" with a label derived from the key — a new card field must never
 * silently vanish.
 *
 * Pure and framework-free; the page's panel and its tests read it.
 */

import {
  assembleSections,
  cleanText,
  fieldFromBlob,
  isUnverified,
  looksLikeList,
  lowestConfidence,
  readBlob,
  splitList,
  type BlobField,
  type DetailField,
  type DetailKind,
  type DetailSection,
  type DetailSource,
  type DetailsModel,
} from '@/lib/crm/enrichment-details'
import { hasAccountCard } from './cards'
import type { ProspectCandidate, ProspectEntryKind } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProspectSectionKey =
  | 'about'
  | 'contact'
  | 'size'
  | 'funding'
  | 'leadership'
  | 'products'
  | 'technology'
  | 'signals'
  | 'other'

export type ProspectDetailsModel = DetailsModel<ProspectSectionKey>

/** The slice of an entry row this module reads. */
export interface ProspectDetailsInput {
  kind: ProspectEntryKind
  candidate: unknown
  research: unknown
  sources: unknown
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface CatalogEntry {
  key: string
  label: string
  kind: DetailKind
  section: ProspectSectionKey
}

/**
 * Every research key with a known home, in render order. The CRM catalog's
 * keys (`@/lib/crm/company-details`) come first in each section so a blob the
 * shared enricher wrote lays out exactly as the CRM would; the prospecting
 * cards' keys (`PROSPECT_DISCOVERY_CARD`, `PROSPECT_ACCOUNT_CARD` in
 * ./schemas, snake_cased) follow. Two keys with the SAME label in one section
 * (`employee_range` / `employee_count_range`, `total_raised` /
 * `total_funding_raised`) are the same fact under two vintages' names — only
 * the first one present is shown.
 */
const CATALOG: CatalogEntry[] = [
  // What it is
  { key: 'industry', label: 'Industry', kind: 'text', section: 'about' },
  { key: 'company_stage', label: 'Stage', kind: 'text', section: 'about' },
  { key: 'founded_year', label: 'Founded', kind: 'text', section: 'about' },
  { key: 'ownership', label: 'Ownership', kind: 'text', section: 'about' },
  { key: 'website', label: 'Website', kind: 'url', section: 'about' },
  { key: 'linkedin_url', label: 'LinkedIn', kind: 'url', section: 'about' },
  { key: 'twitter_url', label: 'Twitter', kind: 'url', section: 'about' },
  // Headquarters (the card's one field, or the CRM's city/state/country
  // trio) slots in here — see buildHeadquarters.
  { key: 'headquarters', label: 'Headquarters', kind: 'text', section: 'about' },
  { key: 'street_address', label: 'Address', kind: 'text', section: 'about' },
  { key: 'address', label: 'Address', kind: 'text', section: 'about' },
  // How to reach them
  { key: 'contact_email', label: 'Email', kind: 'text', section: 'contact' },
  { key: 'phone', label: 'Phone', kind: 'text', section: 'contact' },
  { key: 'contact_page', label: 'Contact page', kind: 'url', section: 'contact' },
  // How big
  { key: 'employee_count', label: 'Headcount', kind: 'text', section: 'size' },
  { key: 'employee_range', label: 'Employee range', kind: 'text', section: 'size' },
  { key: 'employee_count_range', label: 'Employee range', kind: 'text', section: 'size' },
  { key: 'annual_revenue', label: 'Revenue', kind: 'text', section: 'size' },
  { key: 'annual_revenue_range', label: 'Revenue range', kind: 'text', section: 'size' },
  // How funded
  { key: 'funding_stage', label: 'Funding stage', kind: 'text', section: 'funding' },
  { key: 'latest_funding', label: 'Latest round', kind: 'text', section: 'funding' },
  { key: 'total_raised', label: 'Total raised', kind: 'text', section: 'funding' },
  { key: 'total_funding_raised', label: 'Total raised', kind: 'text', section: 'funding' },
  { key: 'investors', label: 'Investors', kind: 'list', section: 'funding' },
  { key: 'funding_summary', label: 'Funding', kind: 'prose', section: 'funding' },
  // Who runs it
  { key: 'key_people', label: 'Key people', kind: 'people', section: 'leadership' },
  // What it sells
  { key: 'products', label: 'Products', kind: 'prose', section: 'products' },
  { key: 'products_and_services', label: 'Products', kind: 'prose', section: 'products' },
  // What it runs on
  { key: 'tech_stack', label: 'Tech stack', kind: 'list', section: 'technology' },
  // What's new
  { key: 'growth_signals', label: 'Growth signals', kind: 'prose', section: 'signals' },
  { key: 'signal', label: 'Signal', kind: 'prose', section: 'signals' },
  { key: 'recent_news', label: 'Recent news', kind: 'prose', section: 'signals' },
]

const SECTION_META: Record<ProspectSectionKey, { title: string; layout: DetailSection['layout'] }> = {
  about: { title: 'About', layout: 'rows' },
  contact: { title: 'Contact', layout: 'rows' },
  size: { title: 'Size & revenue', layout: 'rows' },
  funding: { title: 'Funding', layout: 'rows' },
  leadership: { title: 'Leadership', layout: 'block' },
  products: { title: 'Products & services', layout: 'block' },
  technology: { title: 'Technology', layout: 'block' },
  signals: { title: 'Signals', layout: 'block' },
  other: { title: 'Other', layout: 'rows' },
}

const SECTION_ORDER: readonly ProspectSectionKey[] = [
  'about',
  'contact',
  'size',
  'funding',
  'leadership',
  'products',
  'technology',
  'signals',
  'other',
]

/**
 * Keys the panel shows OUTSIDE the sections. `fit_score` is the card's own
 * rating, stripped by `applyCard` but present in blobs written before it was
 * — it is the chip, never a row.
 */
const COMPANY_ELSEWHERE: ReadonlySet<string> = new Set([
  'name',
  'domain',
  'one_liner',
  'why_fit',
  'why_match',
  'fit_score',
])

/** A person's identity fields live in the sidebar; `why_relevant` is the
 *  person's Match block. */
const PERSON_ELSEWHERE: ReadonlySet<string> = new Set([
  'name',
  'full_name',
  'domain',
  'company_name',
  'one_liner',
  'job_title',
  'title',
  'linkedin_url',
  'seniority',
  'email',
  'why_relevant',
])

// ---------------------------------------------------------------------------
// Reading the blob
// ---------------------------------------------------------------------------

/**
 * `entry.research` in the shape `readBlob` reads.
 *
 * The CRM writes `company.metadata.enrichment` as `{ fields: {…}, sources,
 * summary, … }` and `readBlob` reads `blob.fields`. The prospecting engines
 * write the entry's `research` as the BARE field map (discovery stores
 * `candidate.fields`, `applyCard` the merged map) — read through `readBlob`
 * directly that is an empty blob, and every profiled company's panel once
 * said "Nothing researched yet" under a real score (seen live, 2026-09-05).
 * A blob that already carries `fields` passes through; a bare map is wrapped.
 */
export function researchAsBlob(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  // A blob that carries a `fields` key is the wrapped shape whatever that key
  // holds — `readBlob` ignores a `fields` that is not an object, whereas
  // wrapping it here would turn `{ fields: 'nope' }` into a row called
  // "Fields".
  if ('fields' in record) return raw
  return { fields: raw }
}

/** The blob's field map, tolerant of both shapes. */
export function researchFields(raw: unknown): Record<string, BlobField> {
  return readBlob(researchAsBlob(raw)).fields
}

/**
 * One string out of the research blob by key — the TEXT only, for a chip or
 * a sidebar row that has no source to draw. Tolerates the bare map, the
 * `fields` wrapper, and a field stored as a plain string rather than a
 * `{ value, source_url }` object, matching the tolerance the list row applies
 * to the same keys so a value shown in the row never goes missing here.
 */
export function researchValue(research: unknown, key: string): string | null {
  if (!research || typeof research !== 'object' || Array.isArray(research)) return null
  const fields = (research as { fields?: unknown }).fields
  const bag = (fields && typeof fields === 'object' ? fields : research) as Record<string, unknown>
  const field = bag[key]
  if (typeof field === 'string') return field.trim() || null
  if (field && typeof field === 'object' && !Array.isArray(field)) {
    return cleanText((field as { value?: unknown }).value)
  }
  return null
}

export function candidateOf(entry: { candidate: unknown }): ProspectCandidate {
  const raw = entry.candidate
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ProspectCandidate) : {}
}

/** The entry's own `sources` column when present (what the run recorded),
 *  else the blob's list (a blob written by the shared enrichment path). */
export function entrySources(entry: { research: unknown; sources: unknown }): DetailSource[] {
  const own = Array.isArray(entry.sources)
    ? (entry.sources as Array<{ url?: unknown; title?: unknown }>)
        .filter((s) => s && typeof s.url === 'string' && s.url.trim() !== '')
        .map((s) => ({
          url: (s.url as string).trim(),
          title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : null,
        }))
    : []
  if (own.length > 0) return own
  return readBlob(researchAsBlob(entry.research)).sources
}

// ---------------------------------------------------------------------------
// Labels and kinds for keys nobody catalogued
// ---------------------------------------------------------------------------

/** `products_and_services` → "Products and services". */
export function labelForKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim()
  if (!words) return key
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A value that reads like sentences wants prose; a short one wants a row. */
export function kindForValue(value: string): 'prose' | 'text' {
  return value.length > 80 || /[.!?]\s/.test(value) ? 'prose' : 'text'
}

/**
 * A list answer with a full stop on the end — "Salesforce, HubSpot, Docker."
 * — fails the CRM's `looksLikeList` on its last item and renders as one long
 * sentence. The stop is dropped when what is left is plainly a list of short
 * names (every item four words or fewer); a real sentence ("X, Y and Z, as
 * evidenced by his talks.") keeps its stop and stays prose, which is the case
 * that heuristic exists for.
 */
export function tidyListValue(value: string): string {
  const stripped = value.replace(/\.\s*$/, '')
  if (stripped === value) return value
  if (!looksLikeList(stripped)) return value
  const short = splitList(stripped).every((item) => item.split(/\s+/).filter(Boolean).length <= 4)
  return short ? stripped : value
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Every research field with a home, in the CRM's reading order. Sources are
 * the entry's; the status reads off the account-card stamp, which is the one
 * honest "has been enriched" signal (see `hasAccountCard`).
 */
export function buildProspectDetails(entry: ProspectDetailsInput): ProspectDetailsModel {
  const fields = researchFields(entry.research)
  const elsewhere = entry.kind === 'person' ? PERSON_ELSEWHERE : COMPANY_ELSEWHERE

  const bySection = new Map<ProspectSectionKey, DetailField[]>()
  const unverified: DetailField[] = []
  const placed = new Set<string>()
  const labelsTaken = new Set<string>()

  const place = (field: DetailField, section: ProspectSectionKey) => {
    if (isUnverified(field)) {
      unverified.push(field)
      return
    }
    const list = bySection.get(section) ?? []
    list.push(field)
    bySection.set(section, list)
  }

  for (const entryDef of CATALOG) {
    const blobField = fields[entryDef.key]
    if (!blobField || elsewhere.has(entryDef.key)) continue
    placed.add(entryDef.key)
    const labelKey = `${entryDef.section}:${entryDef.label}`
    if (labelsTaken.has(labelKey)) continue
    labelsTaken.add(labelKey)
    const value = entryDef.kind === 'list' ? tidyListValue(blobField.value) : blobField.value
    place(
      fieldFromBlob(entryDef.key, entryDef.label, entryDef.kind, { ...blobField, value }),
      entryDef.section,
    )
  }

  // The CRM's city/state/country trio, when the card's one-field
  // `headquarters` is absent.
  if (!fields.headquarters) {
    const hq = buildHeadquarters(fields)
    if (hq) {
      placed.add('headquarters_city')
      placed.add('headquarters_state')
      placed.add('headquarters_country')
      place(hq, 'about')
    }
  } else {
    placed.add('headquarters_city')
    placed.add('headquarters_state')
    placed.add('headquarters_country')
  }

  // Everything else: a key nobody catalogued still gets a row.
  for (const [key, blobField] of Object.entries(fields)) {
    if (placed.has(key) || elsewhere.has(key)) continue
    const kind = kindForValue(blobField.value)
    place(fieldFromBlob(key, labelForKey(key), kind, blobField), 'other')
  }

  const sections = assembleSections(SECTION_ORDER, SECTION_META, bySection)
  const candidate = candidateOf(entry)
  const carded = entry.kind === 'company' && hasAccountCard(entry)

  return {
    sections,
    unverified,
    sources: entrySources(entry),
    summary: null,
    enrichedAt: carded ? (candidate.account_card_at ?? null) : null,
    status: carded ? 'enriched' : null,
    error: null,
    fieldCount: sections.reduce((n, s) => n + s.fields.length, 0),
  }
}

function buildHeadquarters(fields: Record<string, BlobField>): DetailField | null {
  const keys = ['headquarters_city', 'headquarters_state', 'headquarters_country'] as const
  const parts = keys.map((k) => fields[k]).filter((f): f is BlobField => Boolean(f))
  if (parts.length === 0) return null
  return {
    key: 'headquarters',
    label: 'Headquarters',
    value: parts.map((f) => f.value).join(', '),
    kind: 'text',
    origin: 'enrichment',
    enriched: true,
    sourceUrl: parts[0].sourceUrl,
    sourceTitle: parts[0].sourceTitle,
    confidence: lowestConfidence(parts.map((f) => f.confidence)),
    foundAt: parts[0].foundAt,
  }
}

// ---------------------------------------------------------------------------
// The sidebar's facts — the short rows the CRM's Properties sidebar shows
// ---------------------------------------------------------------------------

/**
 * One fact for the properties sidebar: the value with its provenance, so the
 * row can draw the same source dot the Details tab draws. Low-confidence
 * values are NOT facts — the sidebar states the record, and the Details tab's
 * Unverified group is where a weak finding is allowed to appear.
 */
export interface ProspectFacts {
  domain: string | null
  website: DetailField | null
  industry: DetailField | null
  employees: DetailField | null
  headquarters: DetailField | null
  founded: DetailField | null
  fundingStage: DetailField | null
  totalRaised: DetailField | null
}

function firstField(
  fields: Record<string, BlobField>,
  keys: readonly string[],
  label: string,
  kind: DetailKind = 'text',
): DetailField | null {
  for (const key of keys) {
    const blobField = fields[key]
    if (!blobField) continue
    const field = fieldFromBlob(key, label, kind, blobField)
    if (isUnverified(field)) continue
    return field
  }
  return null
}

export function prospectFacts(entry: ProspectDetailsInput): ProspectFacts {
  const fields = researchFields(entry.research)
  const candidate = candidateOf(entry)
  const domain = cleanText(candidate.domain)
  const website = firstField(fields, ['website'], 'Website', 'url')
  const hq = fields.headquarters
    ? firstField(fields, ['headquarters'], 'Headquarters')
    : (() => {
        const composed = buildHeadquarters(fields)
        return composed && !isUnverified(composed) ? composed : null
      })()
  return {
    domain,
    // The website row only earns its place when it says something the
    // domain row does not.
    website: website && domain && sameHost(website.value, domain) ? null : website,
    industry: firstField(fields, ['industry'], 'Industry'),
    employees: firstField(
      fields,
      ['employee_range', 'employee_count_range', 'employee_count'],
      'Employees',
    ),
    headquarters: hq,
    founded: firstField(fields, ['founded_year'], 'Founded'),
    fundingStage: firstField(fields, ['funding_stage'], 'Funding stage'),
    totalRaised: firstField(fields, ['total_raised', 'total_funding_raised'], 'Total raised'),
  }
}

function sameHost(url: string, domain: string): boolean {
  const host = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase()
  return host === domain.replace(/^www\./i, '').toLowerCase()
}

/** Headcount under either key the research pass has used — the text alone. */
export function employeeRangeOf(research: unknown): string | null {
  return (
    researchValue(research, 'employee_range') ??
    researchValue(research, 'employee_count_range') ??
    researchValue(research, 'employee_count')
  )
}

/** A person's "why" — the people card's `why_relevant`, with its source. */
export function personRelevance(entry: ProspectDetailsInput): DetailField | null {
  const fields = researchFields(entry.research)
  const blobField = fields.why_relevant
  if (!blobField) return null
  return fieldFromBlob('why_relevant', 'Relevance', 'prose', blobField)
}
