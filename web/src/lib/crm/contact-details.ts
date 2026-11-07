/**
 * Contact details model — a person's row plus their enrichment blob, laid
 * out as the sections the contact Details tab renders.
 *
 * Reading order follows how you size someone up: what they do now (Role),
 * how to reach them (Contact), what they know (Expertise), where they've
 * been (Experience, as a timeline), where they studied (Education, also a
 * timeline), and anything notable. The enricher's bio paragraph is NOT part
 * of this model's sections — it is written into `contact.notes` and shown on
 * the Overview tab, so repeating it here would put the same paragraph on two
 * tabs.
 *
 * Types, the tolerant blob reader and the value parsers are shared with the
 * company model in ./enrichment-details; this file owns the contact catalog.
 */

import {
  assembleSections,
  cleanText,
  fieldFromBlob,
  fieldFromColumn,
  isUnverified,
  normalizeStatus,
  parseTimeline,
  readBlob,
  type BlobField,
  type DetailField,
  type DetailKind,
  type DetailSection,
  type DetailsModel,
} from './enrichment-details'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactSectionKey =
  | 'role'
  | 'contact'
  | 'expertise'
  | 'experience'
  | 'education'
  | 'notable'
export type ContactDetailSection = DetailSection<ContactSectionKey>
export type ContactDetailsModel = DetailsModel<ContactSectionKey>

/** The slice of a contact row this module reads. Everything optional. */
export interface ContactDetailsInput {
  job_title?: string | null
  department?: string | null
  email?: string | null
  secondary_emails?: string[] | null
  phone?: string | null
  linkedin_url?: string | null
  /** The linked company's name (the relation, not a text column). */
  company_name?: string | null
  enrichment_status?: string | null
  enriched_at?: string | null
  metadata?: { enrichment?: unknown } | null
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Org separators for the two timeline fields. */
const ROLE_ORG_SEPARATORS = [' at ', ' @ ', ' with '] as const
const SCHOOL_ORG_SEPARATORS = [' from ', ' at '] as const

interface CatalogEntry {
  key: string
  label: string
  kind: DetailKind
  section: ContactSectionKey
  /** Column on the contact row that holds the canonical value, if any. */
  column?: 'job_title' | 'department' | 'email' | 'phone' | 'linkedin_url' | 'company_name'
}

/**
 * Every value the Details tab knows how to place. Keys match the enricher's
 * snake_case field names for the person cards (`PERSON_CARD_SCHEMAS` in
 * @/lib/exa/deep-search). Column-backed entries share their key with the
 * blob — the contact enricher writes `job_title`/`department`/`linkedin_url`
 * from the same-named fields.
 */
const CATALOG: CatalogEntry[] = [
  // What they do now
  { key: 'job_title', label: 'Title', kind: 'text', section: 'role', column: 'job_title' },
  { key: 'department', label: 'Department', kind: 'text', section: 'role', column: 'department' },
  { key: 'seniority', label: 'Seniority', kind: 'text', section: 'role' },
  { key: 'company_name', label: 'Company', kind: 'text', section: 'role', column: 'company_name' },
  { key: 'location', label: 'Location', kind: 'text', section: 'role' },
  // How to reach them
  { key: 'email', label: 'Email', kind: 'text', section: 'contact', column: 'email' },
  // Secondary emails are composed from the array — handled in buildSecondaryEmails.
  { key: 'phone', label: 'Phone', kind: 'text', section: 'contact', column: 'phone' },
  { key: 'linkedin_url', label: 'LinkedIn', kind: 'url', section: 'contact', column: 'linkedin_url' },
  { key: 'twitter_url', label: 'Twitter', kind: 'url', section: 'contact' },
  { key: 'github_url', label: 'GitHub', kind: 'url', section: 'contact' },
  // What they know
  { key: 'expertise', label: 'Expertise', kind: 'list', section: 'expertise' },
  // Where they've been
  { key: 'previous_roles', label: 'Previous roles', kind: 'timeline', section: 'experience' },
  // Where they studied
  { key: 'education', label: 'Education', kind: 'timeline', section: 'education' },
  // Anything notable
  { key: 'notable_work', label: 'Notable work', kind: 'prose', section: 'notable' },
]

const SECTION_META: Record<ContactSectionKey, { title: string; layout: DetailSection['layout'] }> = {
  role: { title: 'Role', layout: 'rows' },
  contact: { title: 'Contact', layout: 'rows' },
  expertise: { title: 'Expertise', layout: 'block' },
  experience: { title: 'Experience', layout: 'block' },
  education: { title: 'Education', layout: 'block' },
  notable: { title: 'Notable work', layout: 'block' },
}

const SECTION_ORDER: readonly ContactSectionKey[] = [
  'role', 'contact', 'expertise', 'experience', 'education', 'notable',
]

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildContactDetails(contact: ContactDetailsInput): ContactDetailsModel {
  const blob = readBlob(contact.metadata?.enrichment)
  const applied = new Set(blob.applied)

  const bySection = new Map<ContactSectionKey, DetailField[]>()
  const unverified: DetailField[] = []

  const place = (field: DetailField, section: ContactSectionKey) => {
    if (isUnverified(field)) {
      unverified.push(field)
      return
    }
    const list = bySection.get(section) ?? []
    list.push(field)
    bySection.set(section, list)
  }

  for (const entry of CATALOG) {
    const field = resolveField(entry, contact, blob.fields, applied)
    if (field) place(withEntries(field), entry.section)

    // Other emails slot in right after the primary one.
    if (entry.key === 'email') {
      const extra = buildSecondaryEmails(contact)
      if (extra) place(extra, 'contact')
    }
  }

  const sections = assembleSections(SECTION_ORDER, SECTION_META, bySection)

  return {
    sections,
    unverified,
    sources: blob.sources,
    summary: blob.summary,
    enrichedAt: blob.enrichedAt ?? contact.enriched_at ?? null,
    status: normalizeStatus(contact.enrichment_status ?? blob.status),
    error: blob.error,
    fieldCount: sections.reduce((n, s) => n + s.fields.length, 0),
  }
}

/**
 * Column wins when set (canonical, human-editable); provenance is lent from
 * the same-keyed blob entry only when the run wrote the column. Otherwise the
 * blob entry under this key, subject to the normal confidence gate.
 */
function resolveField(
  entry: CatalogEntry,
  contact: ContactDetailsInput,
  fields: Record<string, BlobField>,
  applied: Set<string>,
): DetailField | null {
  const columnValue = entry.column ? cleanText(contact[entry.column]) : null
  const blobField = fields[entry.key]

  if (entry.column && columnValue) {
    const provenance = applied.has(entry.column) ? blobField : undefined
    return fieldFromColumn(entry.key, entry.label, entry.kind, columnValue, provenance)
  }

  if (!blobField) return null
  return fieldFromBlob(entry.key, entry.label, entry.kind, blobField)
}

/** Pre-parse the two timeline fields so the renderer stays dumb. */
function withEntries(field: DetailField): DetailField {
  if (field.kind !== 'timeline') return field
  const separators = field.key === 'education' ? SCHOOL_ORG_SEPARATORS : ROLE_ORG_SEPARATORS
  return { ...field, entries: parseTimeline(field.value, { orgSeparators: separators }) }
}

function buildSecondaryEmails(contact: ContactDetailsInput): DetailField | null {
  const emails = (contact.secondary_emails ?? [])
    .map((e) => cleanText(e))
    .filter((e): e is string => e !== null)
  if (emails.length === 0) return null
  return {
    key: 'secondary_emails',
    label: emails.length === 1 ? 'Other email' : 'Other emails',
    value: emails.join(', '),
    kind: 'list',
    origin: 'column',
    enriched: false,
    sourceUrl: null,
    sourceTitle: null,
    confidence: null,
    foundAt: null,
  }
}
