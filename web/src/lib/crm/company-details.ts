/**
 * Company details model — turns a company row plus its enrichment blob into
 * the structured, sectioned view the Details tab renders.
 *
 * Two sources feed one screen: the real columns (`industry`, `website`, the
 * HQ trio…) and `metadata.enrichment.fields`, where everything Exa found that
 * has no column lives (funding, leadership, products, news). The panel used to
 * dump the second group as a flat label/value list in the properties sidebar;
 * this module gives every value a home in a named section, in the order a
 * reader scans a company: what it is → how big → how funded → who runs it →
 * what it sells → what's new.
 *
 * Types, the tolerant blob reader and the value parsers are shared with the
 * contact model in ./enrichment-details; this file owns the company catalog.
 */

import {
  assembleSections,
  cleanText,
  fieldFromBlob,
  fieldFromColumn,
  isUnverified,
  lowestConfidence,
  normalizeStatus,
  readBlob,
  type BlobField,
  type DetailField,
  type DetailKind,
  type DetailSection,
  type DetailsModel,
} from './enrichment-details'

export type {
  DetailConfidence,
  DetailField,
  DetailKind,
  DetailSource,
  KeyPerson,
} from './enrichment-details'
export { displayUrl, parseKeyPeople, sourceHost, splitList } from './enrichment-details'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompanySectionKey =
  | 'about'
  | 'contact'
  | 'size'
  | 'funding'
  | 'leadership'
  | 'products'
  | 'news'
export type CompanyDetailSection = DetailSection<CompanySectionKey>
export type CompanyDetailsModel = DetailsModel<CompanySectionKey>

/** The slice of a company row this module reads. Everything optional. */
export interface CompanyDetailsInput {
  domain?: string | null
  website?: string | null
  industry?: string | null
  employee_count_range?: string | null
  annual_revenue_range?: string | null
  address?: string | null
  phone?: string | null
  contact_email?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  enrichment_status?: string | null
  enriched_at?: string | null
  metadata?: { enrichment?: unknown } | null
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface CatalogEntry {
  key: string
  label: string
  kind: DetailKind
  section: CompanySectionKey
  /** Column on the company row that holds the canonical value, if any. */
  column?: keyof CompanyDetailsInput
}

/**
 * Every value the Details tab knows how to place. Order within a section is
 * the render order. Keys match the enricher's snake_case field names
 * (`groundedFields` in @/lib/exa/deep-search) — `funding_summary` is the key
 * older, pre-deep-search blobs used for the funding line and stays so those
 * rows keep rendering.
 */
const CATALOG: CatalogEntry[] = [
  // What it is
  { key: 'industry', label: 'Industry', kind: 'text', section: 'about', column: 'industry' },
  { key: 'company_stage', label: 'Stage', kind: 'text', section: 'about' },
  { key: 'founded_year', label: 'Founded', kind: 'text', section: 'about' },
  { key: 'ownership', label: 'Ownership', kind: 'text', section: 'about' },
  { key: 'website', label: 'Website', kind: 'url', section: 'about', column: 'website' },
  { key: 'linkedin_url', label: 'LinkedIn', kind: 'url', section: 'about' },
  { key: 'twitter_url', label: 'Twitter', kind: 'url', section: 'about' },
  // Headquarters is composed from three columns — handled in buildHeadquarters.
  { key: 'address', label: 'Address', kind: 'text', section: 'about', column: 'address' },
  // How to reach them
  { key: 'contact_email', label: 'Email', kind: 'text', section: 'contact', column: 'contact_email' },
  { key: 'phone', label: 'Phone', kind: 'text', section: 'contact', column: 'phone' },
  { key: 'contact_page', label: 'Contact page', kind: 'url', section: 'contact' },
  // How big
  { key: 'employee_count', label: 'Headcount', kind: 'text', section: 'size' },
  { key: 'employee_count_range', label: 'Employee range', kind: 'text', section: 'size', column: 'employee_count_range' },
  { key: 'annual_revenue', label: 'Revenue', kind: 'text', section: 'size' },
  { key: 'annual_revenue_range', label: 'Revenue range', kind: 'text', section: 'size', column: 'annual_revenue_range' },
  // How funded
  { key: 'funding_stage', label: 'Funding stage', kind: 'text', section: 'funding' },
  { key: 'latest_funding', label: 'Latest round', kind: 'text', section: 'funding' },
  { key: 'total_funding_raised', label: 'Total raised', kind: 'text', section: 'funding' },
  { key: 'investors', label: 'Investors', kind: 'list', section: 'funding' },
  { key: 'funding_summary', label: 'Funding', kind: 'prose', section: 'funding' },
  // Who runs it
  { key: 'key_people', label: 'Key people', kind: 'people', section: 'leadership' },
  // What it sells
  { key: 'products_and_services', label: 'Products', kind: 'prose', section: 'products' },
  // What's new
  { key: 'recent_news', label: 'Recent news', kind: 'prose', section: 'news' },
]

const SECTION_META: Record<CompanySectionKey, { title: string; layout: DetailSection['layout'] }> = {
  about: { title: 'About', layout: 'rows' },
  contact: { title: 'Contact', layout: 'rows' },
  size: { title: 'Size & revenue', layout: 'rows' },
  funding: { title: 'Funding', layout: 'rows' },
  leadership: { title: 'Leadership', layout: 'block' },
  products: { title: 'Products & services', layout: 'block' },
  news: { title: 'Recent news', layout: 'block' },
}

const SECTION_ORDER: readonly CompanySectionKey[] = [
  'about', 'contact', 'size', 'funding', 'leadership', 'products', 'news',
]

/**
 * Which blob field a column's value was written FROM — the enricher's own
 * column map (see `columnCandidates` in @/lib/crm/enrichment). Provenance for
 * an applied column is read from that entry; a column not listed here shares
 * its key with the blob.
 */
const COLUMN_PROVENANCE_KEY: Partial<Record<keyof CompanyDetailsInput, string>> = {
  address: 'street_address',
  employee_count_range: 'employee_count',
  annual_revenue_range: 'annual_revenue',
  city: 'headquarters_city',
  state: 'headquarters_state',
  country: 'headquarters_country',
}

function provenanceFor(
  column: keyof CompanyDetailsInput,
  fields: Record<string, BlobField>,
): BlobField | undefined {
  const mapped = COLUMN_PROVENANCE_KEY[column]
  // Older blobs keyed the entry by the column name itself; keep reading those.
  return (mapped ? fields[mapped] : undefined) ?? fields[column]
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildCompanyDetails(company: CompanyDetailsInput): CompanyDetailsModel {
  const blob = readBlob(company.metadata?.enrichment)
  const applied = new Set(blob.applied)

  const bySection = new Map<CompanySectionKey, DetailField[]>()
  const unverified: DetailField[] = []

  const place = (field: DetailField, section: CompanySectionKey) => {
    if (isUnverified(field)) {
      unverified.push(field)
      return
    }
    const list = bySection.get(section) ?? []
    list.push(field)
    bySection.set(section, list)
  }

  for (const entry of CATALOG) {
    const field = resolveField(entry, company, blob.fields, applied)
    if (field) place(field, entry.section)

    // Headquarters slots in after Twitter, before the street address.
    if (entry.key === 'twitter_url') {
      const hq = buildHeadquarters(company, blob.fields, applied)
      if (hq) place(hq, 'about')
    }
  }

  const sections = assembleSections(SECTION_ORDER, SECTION_META, bySection)

  return {
    sections,
    unverified,
    sources: blob.sources,
    summary: blob.summary,
    enrichedAt: blob.enrichedAt ?? company.enriched_at ?? null,
    status: normalizeStatus(company.enrichment_status ?? blob.status),
    error: blob.error,
    fieldCount: sections.reduce((n, s) => n + s.fields.length, 0),
  }
}

/**
 * One catalog entry → one field, or null when neither the column nor the blob
 * has anything to show.
 *
 * The column wins when it has a value: it is the canonical, human-editable
 * copy, and the blob entry only lends it provenance (source + confidence) when
 * the run actually wrote that column (`applied_fields`). A column the enricher
 * filled but a person later cleared falls through to the blob, where the
 * normal confidence gate applies.
 */
function resolveField(
  entry: CatalogEntry,
  company: CompanyDetailsInput,
  fields: Record<string, BlobField>,
  applied: Set<string>,
): DetailField | null {
  const columnValue = entry.column ? cleanText(company[entry.column]) : null

  if (entry.column && columnValue) {
    const provenance = applied.has(entry.column) ? provenanceFor(entry.column, fields) : undefined
    return fieldFromColumn(entry.key, entry.label, entry.kind, columnValue, provenance)
  }

  // Column empty (or no column): show the blob's entry under this exact key.
  // Deliberately NOT the provenance key — `employee_count` already has its own
  // Headcount row, so an empty `employee_count_range` column must not repeat
  // it under "Employee range".
  const blobField = fields[entry.key]
  if (!blobField) return null
  return fieldFromBlob(entry.key, entry.label, entry.kind, blobField)
}

/**
 * "City, State, Country" from the HQ columns, falling back to the blob's
 * `headquarters_*` entries when the columns are empty (they are written only
 * at high/medium confidence, so the fallback carries the low-confidence gate
 * the same way any other blob field does).
 */
function buildHeadquarters(
  company: CompanyDetailsInput,
  fields: Record<string, BlobField>,
  applied: Set<string>,
): DetailField | null {
  const columns = ['city', 'state', 'country'] as const
  const columnParts = columns.map((c) => cleanText(company[c]))
  const fromColumns = columnParts.filter((p): p is string => p !== null)

  if (fromColumns.length > 0) {
    const enrichedCols = columns.filter((c) => applied.has(c))
    const enriched = enrichedCols.length > 0
    const provenance = enrichedCols.map((c) => provenanceFor(c, fields))
    const source = provenance.find((p) => p?.sourceUrl) ?? provenance[0]
    return {
      key: 'headquarters',
      label: 'Headquarters',
      value: fromColumns.join(', '),
      kind: 'text',
      origin: 'column',
      enriched,
      sourceUrl: source?.sourceUrl ?? null,
      sourceTitle: source?.sourceTitle ?? null,
      confidence: enriched ? lowestConfidence(provenance.map((p) => p?.confidence)) : null,
      foundAt: source?.foundAt ?? null,
    }
  }

  const blobKeys = ['headquarters_city', 'headquarters_state', 'headquarters_country'] as const
  const blobParts = blobKeys.map((k) => fields[k]).filter((f): f is BlobField => Boolean(f))
  if (blobParts.length === 0) return null
  return {
    key: 'headquarters',
    label: 'Headquarters',
    value: blobParts.map((f) => f.value).join(', '),
    kind: 'text',
    origin: 'enrichment',
    enriched: true,
    sourceUrl: blobParts[0].sourceUrl,
    sourceTitle: blobParts[0].sourceTitle,
    confidence: lowestConfidence(blobParts.map((f) => f.confidence)),
    foundAt: blobParts[0].foundAt,
  }
}
