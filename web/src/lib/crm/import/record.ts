/**
 * The one shape every import source maps its rows into (roadmap track G,
 * docs/plans/customer-import.md), and the normalizing that makes two sources'
 * versions of one person comparable. Pure: no I/O.
 *
 *   ImportContactRecord   a person: names, emails, phones, one-line address,
 *                         company, tags, notes, past jobs or invoices, the
 *                         last time the business was in touch, and whether
 *                         they are a customer.
 *   ImportCompanyRecord   a company on its own (HubSpot and Brevo list them
 *                         apart from their contacts).
 *
 * {@link normalizeRecord} cleans one record (trimmed text, lowercased valid
 * emails, E.164 phones where the number allows, ISO dates, capped lengths) and
 * returns null when nothing identifies it: no name, no email, no phone.
 */
import { normalizeE164 } from '@/lib/twilio/phone'

/** Where an import's records come from (migration 462's batch source check). */
export const IMPORT_SOURCES = ['spreadsheet', 'vcard', 'google_contacts', 'hubspot', 'brevo'] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

export function isImportSource(value: unknown): value is ImportSource {
  return typeof value === 'string' && (IMPORT_SOURCES as readonly string[]).includes(value)
}

/** How a source reads in a sentence ("from HubSpot"). */
export const IMPORT_SOURCE_LABEL: Record<ImportSource, string> = {
  spreadsheet: 'your spreadsheet',
  vcard: 'your phone contacts',
  google_contacts: 'Google Contacts',
  hubspot: 'HubSpot',
  brevo: 'Brevo',
}

/** The tag every imported record carries: where it came from. */
export function sourceTag(source: ImportSource): string {
  return `from ${IMPORT_SOURCE_LABEL[source].replace(/^your /, '')}`
}

/**
 * The tags a source's opt-outs arrive as (Brevo's blacklists). The email one
 * also puts the contact's addresses on the workspace's outreach suppression
 * list (./batch.ts), which every sequence send checks; track D treats both
 * tags as opt-outs on their channel.
 */
export const UNSUBSCRIBED_EMAIL_TAG = 'unsubscribed email'
export const UNSUBSCRIBED_SMS_TAG = 'unsubscribed sms'

export type ImportRelationship = 'customer' | 'lead' | 'contact'

/** A past job or invoice, as a line on the contact's timeline. */
export interface ImportPastJob {
  kind: 'job' | 'invoice'
  title: string
  occurredAt: string | null
  amountCents: number | null
  currency: string | null
}

export interface ImportCompanyRef {
  name?: string | null
  domain?: string | null
  /** The source's own id for the company (HubSpot, Brevo). */
  externalId?: string | null
}

export interface ImportContactRecord {
  kind: 'contact'
  /** The source's own id (a Google resource name, a HubSpot or Brevo id). */
  externalId?: string | null
  fullName?: string | null
  firstName?: string | null
  lastName?: string | null
  emails?: string[]
  phones?: string[]
  address?: string | null
  company?: ImportCompanyRef | null
  jobTitle?: string | null
  tags?: string[]
  notes?: string | null
  history?: ImportPastJob[]
  /** The last time the business was in touch with them (ISO). */
  lastContactAt?: string | null
  relationship?: ImportRelationship | null
}

export interface ImportCompanyRecord {
  kind: 'company'
  externalId?: string | null
  name?: string | null
  domain?: string | null
  website?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  industry?: string | null
  description?: string | null
  tags?: string[]
}

export type ImportRecord = ImportContactRecord | ImportCompanyRecord

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_NAME_CHARS = 120
export const MAX_ADDRESS_CHARS = 300
export const MAX_NOTES_CHARS = 4000
export const MAX_TAGS = 20
export const MAX_TAG_CHARS = 60
export const MAX_EMAILS = 5
export const MAX_PHONES = 5
export const MAX_HISTORY = 50

// ---------------------------------------------------------------------------
// Small normalizers
// ---------------------------------------------------------------------------

/** Trimmed, inner whitespace collapsed, capped; null when empty. */
export function cleanText(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max).trim() : s
}

/** Like {@link cleanText} but keeps line breaks (notes). */
export function cleanMultiline(value: unknown, max = MAX_NOTES_CHARS): string | null {
  if (value === null || value === undefined) return null
  const s = String(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max).trim() : s
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** A lowercased email, or null when it isn't one. Strips "mailto:" and a display name. */
export function normalizeEmail(value: unknown): string | null {
  const s = cleanText(value, 320)
  if (!s) return null
  let e = s.toLowerCase().replace(/^mailto:/, '')
  const angle = /<([^<>]+)>/.exec(e)
  if (angle) e = angle[1].trim()
  return EMAIL.test(e) ? e : null
}

/**
 * A phone number: E.164 when it can be one (US/Canada without a country code
 * read as +1), else the digits with a leading + kept, when there are at least
 * seven of them. Extensions ("x204") are dropped. Null otherwise.
 */
export function normalizePhone(value: unknown): string | null {
  const s = cleanText(value, 40)
  if (!s) return null
  const main = s.split(/\s*(?:ext\.?|x|#)\s*\d+$/i)[0] ?? s
  const e164 = normalizeE164(main.replace(/^tel:/i, ''))
  if (e164) return e164
  const digits = main.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return main.trim().startsWith('+') ? `+${digits}` : digits
}

/** Distinct values, in order. */
function distinct<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** A domain from a domain or a website URL ("https://www.acme.com/about" → "acme.com"). */
export function normalizeDomain(value: unknown): string | null {
  const s = cleanText(value, 300)
  if (!s) return null
  let d = s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '')
  d = d.split(/[/?#\s]/)[0] ?? ''
  d = d.replace(/:\d+$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null
}

/** "Jane Q. Doe" → first "Jane", last "Doe". Single word: first only. */
export function splitName(full: string): { first: string | null; last: string | null } {
  const parts = full.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: null, last: null }
  if (parts.length === 1) return { first: parts[0], last: null }
  return { first: parts[0], last: parts[parts.length - 1] }
}

/**
 * A date as an ISO string, or null. Reads ISO dates, US month/day/year
 * ("3/15/2024", "3-15-24"), "March 15, 2024", and an Excel serial day number
 * (a spreadsheet cell stored as a date). Years before 1950 or more than a day
 * ahead are refused: they are typos, not visits.
 */
export function normalizeDate(value: unknown, nowMs: number = Date.now()): string | null {
  if (value === null || value === undefined || value === '') return null
  let ms: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial: days since 1899-12-30. Only a plausible range.
    if (value > 18_000 && value < 80_000) ms = Math.round((value - 25_569) * 86_400_000)
  } else {
    const s = String(value).trim()
    if (/^\d{5}(\.\d+)?$/.test(s)) return normalizeDate(Number(s), nowMs)
    const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(s)
    if (us) {
      const month = Number(us[1])
      const day = Number(us[2])
      let year = Number(us[3])
      if (year < 100) year += year < 70 ? 2000 : 1900
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) ms = Date.UTC(year, month - 1, day)
    } else if (/^\d{4}-\d{2}-\d{2}/.test(s) || /[a-z]{3}/i.test(s)) {
      const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s)
      if (Number.isFinite(parsed)) ms = parsed
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null
  if (ms < Date.UTC(1950, 0, 1) || ms > nowMs + 86_400_000) return null
  return new Date(ms).toISOString()
}

/** "$1,250.50" → 125050 cents; "1.250,50 €" is read as 1250.50. Null when not a positive amount. */
export function parseMoneyCents(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
  const s = cleanText(value, 40)
  if (!s) return null
  let n = s.replace(/[^\d.,-]/g, '')
  if (!n || n.startsWith('-')) return null
  // A comma followed by exactly two digits at the end is a decimal comma.
  if (/,\d{2}$/.test(n) && !/\.\d{2}$/.test(n)) n = n.replace(/\./g, '').replace(',', '.')
  else n = n.replace(/,/g, '')
  const amount = Number(n)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null
  return Math.round(amount * 100)
}

/** Split a tag cell: "vip; repeat, persian" → ["vip", "repeat", "persian"]. */
export function splitTags(value: unknown): string[] {
  const s = cleanText(value, 2000)
  if (!s) return []
  return s.split(/[;,|]/).map((t) => cleanText(t, MAX_TAG_CHARS)).filter((t): t is string => !!t)
}

/** Address parts on one line: "12 Elm St, Apt 3, Pasadena, CA 91101, US". */
export function formatAddress(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.map((p) => cleanText(p, 200)).filter((p): p is string => !!p)
  const joined: string[] = []
  for (const part of cleaned) {
    // "CA" then "91101" reads as "CA 91101".
    const prev = joined[joined.length - 1]
    if (prev && /^[A-Z]{2}$/.test(prev) && /^\d{5}(-\d{4})?$/.test(part)) joined[joined.length - 1] = `${prev} ${part}`
    else if (!joined.includes(part)) joined.push(part)
  }
  return cleanText(joined.join(', '), MAX_ADDRESS_CHARS)
}

// ---------------------------------------------------------------------------
// Whole records
// ---------------------------------------------------------------------------

function normalizePastJob(job: ImportPastJob, nowMs: number): ImportPastJob | null {
  const title = cleanText(job.title, 200)
  const occurredAt = job.occurredAt ? normalizeDate(job.occurredAt, nowMs) : null
  const amountCents = typeof job.amountCents === 'number' && Number.isFinite(job.amountCents) && job.amountCents > 0 ? Math.round(job.amountCents) : null
  if (!title && amountCents === null) return null
  const currency = cleanText(job.currency, 3)?.toLowerCase() ?? null
  return {
    kind: job.kind === 'invoice' ? 'invoice' : 'job',
    title: title ?? (job.kind === 'invoice' ? 'Invoice' : 'Job'),
    occurredAt,
    amountCents,
    currency: currency && /^[a-z]{3}$/.test(currency) ? currency : null,
  }
}

/** One contact record cleaned, or null when nothing identifies it. */
export function normalizeContactRecord(record: ImportContactRecord, nowMs: number = Date.now()): ImportContactRecord | null {
  const emails = distinct((record.emails ?? []).map(normalizeEmail).filter((e): e is string => !!e)).slice(0, MAX_EMAILS)
  const phones = distinct((record.phones ?? []).map(normalizePhone).filter((p): p is string => !!p)).slice(0, MAX_PHONES)
  let firstName = cleanText(record.firstName, MAX_NAME_CHARS)
  let lastName = cleanText(record.lastName, MAX_NAME_CHARS)
  let fullName = cleanText(record.fullName, MAX_NAME_CHARS)
  // A "name" that is just the email or a phone number names nobody.
  if (fullName && (normalizeEmail(fullName) || /^[+\d\s().-]+$/.test(fullName))) fullName = null
  if (!fullName && (firstName || lastName)) fullName = [firstName, lastName].filter(Boolean).join(' ')
  if (fullName && !firstName && !lastName) {
    const split = splitName(fullName)
    firstName = split.first
    lastName = split.last
  }
  if (!fullName && emails.length === 0 && phones.length === 0) return null

  const company = record.company
    ? {
        name: cleanText(record.company.name, 200),
        domain: normalizeDomain(record.company.domain),
        externalId: cleanText(record.company.externalId, 300),
      }
    : null
  const history = (record.history ?? [])
    .map((job) => normalizePastJob(job, nowMs))
    .filter((job): job is ImportPastJob => !!job)
    .slice(0, MAX_HISTORY)
  // The last touch is the latest of what the source said and the latest job.
  const touches = [record.lastContactAt ? normalizeDate(record.lastContactAt, nowMs) : null, ...history.map((j) => j.occurredAt)].filter(
    (d): d is string => !!d,
  )
  const lastContactAt = touches.length ? touches.reduce((a, b) => (a > b ? a : b)) : null

  return {
    kind: 'contact',
    externalId: cleanText(record.externalId, 300),
    fullName,
    firstName,
    lastName,
    emails,
    phones,
    address: cleanText(record.address, MAX_ADDRESS_CHARS),
    company: company && (company.name || company.domain || company.externalId) ? company : null,
    jobTitle: cleanText(record.jobTitle, 200),
    tags: distinct((record.tags ?? []).map((t) => cleanText(t, MAX_TAG_CHARS)).filter((t): t is string => !!t)).slice(0, MAX_TAGS),
    notes: cleanMultiline(record.notes),
    history,
    lastContactAt,
    relationship: record.relationship === 'customer' || record.relationship === 'lead' || record.relationship === 'contact' ? record.relationship : null,
  }
}

/** One company record cleaned, or null with neither a name nor a domain. */
export function normalizeCompanyRecord(record: ImportCompanyRecord): ImportCompanyRecord | null {
  const domain = normalizeDomain(record.domain) ?? normalizeDomain(record.website)
  const name = cleanText(record.name, 200)
  if (!name && !domain) return null
  return {
    kind: 'company',
    externalId: cleanText(record.externalId, 300),
    name,
    domain,
    website: cleanText(record.website, 300),
    phone: normalizePhone(record.phone),
    address: cleanText(record.address, MAX_ADDRESS_CHARS),
    city: cleanText(record.city, 120),
    state: cleanText(record.state, 120),
    country: cleanText(record.country, 120),
    industry: cleanText(record.industry, 120),
    description: cleanMultiline(record.description, 2000),
    tags: distinct((record.tags ?? []).map((t) => cleanText(t, MAX_TAG_CHARS)).filter((t): t is string => !!t)).slice(0, MAX_TAGS),
  }
}

export function normalizeRecord(record: ImportRecord, nowMs: number = Date.now()): ImportRecord | null {
  return record.kind === 'company' ? normalizeCompanyRecord(record) : normalizeContactRecord(record, nowMs)
}
