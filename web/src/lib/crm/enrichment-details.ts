/**
 * Shared vocabulary for the CRM Details tabs (company + contact).
 *
 * Both tabs are the same idea — a row's columns plus its
 * `metadata.enrichment.fields` blob, laid out as named sections of typed
 * fields — so the types, the tolerant blob reader, and the value parsers
 * (lists, "Name (Title)" rosters, career/education timelines) live here.
 * Each entity's module owns only its catalog and section order.
 *
 * Pure and framework-free. The blob is untyped jsonb written by several
 * generations of the enricher, so every read tolerates a missing key, a bare
 * scalar where a `{ value }` triple was expected, or `fields` not being an
 * object at all.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetailConfidence = 'high' | 'medium' | 'low'

/** How a value is rendered. */
export type DetailKind =
  /** One short line. */
  | 'text'
  /** An external link, shown without scheme. */
  | 'url'
  /** One or more sentences. */
  | 'prose'
  /** A comma list rendered as chips when it really is a list (see looksLikeList). */
  | 'list'
  /** "Name (Title), Name (Title)" rendered as a roster. */
  | 'people'
  /** Dated entries ("Role at Org (2020–2022); …") rendered as a timeline. */
  | 'timeline'

export interface TimelineEntry {
  /** Role or degree. */
  title: string
  /** Employer or school. */
  org: string | null
  /** The date range as written, dashes normalised ("2022–Present"). */
  period: string | null
}

export interface DetailField {
  /** Column name or enrichment field key. */
  key: string
  label: string
  /** The raw value — what the copy button copies. */
  value: string
  kind: DetailKind
  /** 'column' = lives on the row (human-editable); 'enrichment' = blob only. */
  origin: 'column' | 'enrichment'
  /** True when the value came off the web (blob entry, or a column the run wrote). */
  enriched: boolean
  sourceUrl: string | null
  sourceTitle: string | null
  confidence: DetailConfidence | null
  /** When the run that found this value finished (blob `found_at`), if known. */
  foundAt: string | null
  /** Pre-parsed entries for the 'timeline' kind. */
  entries?: TimelineEntry[]
}

export interface DetailSection<K extends string = string> {
  key: K
  title: string
  /** 'rows' = label/value table; 'block' = a single value under the heading. */
  layout: 'rows' | 'block'
  fields: DetailField[]
}

export interface DetailSource {
  url: string
  title: string | null
}

export type DetailStatus = 'pending' | 'enriched' | 'failed' | 'skipped' | null

export interface DetailsModel<K extends string = string> {
  /** Non-empty sections only, in reading order. */
  sections: DetailSection<K>[]
  /**
   * Values the run found but could not tie to this record (low confidence —
   * the enricher never writes these to a column). Kept out of the sections so
   * a namesake's facts never read as the record.
   */
  unverified: DetailField[]
  sources: DetailSource[]
  summary: string | null
  enrichedAt: string | null
  status: DetailStatus
  error: string | null
  /** Number of fields across all sections (not counting unverified). */
  fieldCount: number
}

// ---------------------------------------------------------------------------
// Blob reading — tolerant of every past shape
// ---------------------------------------------------------------------------

export interface BlobField {
  value: string
  sourceUrl: string | null
  sourceTitle: string | null
  confidence: DetailConfidence | null
  foundAt: string | null
}

export interface ReadBlob {
  fields: Record<string, BlobField>
  applied: string[]
  sources: DetailSource[]
  summary: string | null
  enrichedAt: string | null
  status: string | null
  error: string | null
}

export function readBlob(raw: unknown): ReadBlob {
  const empty: ReadBlob = {
    fields: {},
    applied: [],
    sources: [],
    summary: null,
    enrichedAt: null,
    status: null,
    error: null,
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const blob = raw as Record<string, unknown>

  const fields: Record<string, BlobField> = {}
  const rawFields = blob.fields
  if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
    for (const [key, entry] of Object.entries(rawFields as Record<string, unknown>)) {
      const parsed = readField(entry)
      if (parsed) fields[key] = parsed
    }
  }

  const applied = Array.isArray(blob.applied_fields)
    ? blob.applied_fields.filter((f): f is string => typeof f === 'string')
    : []

  const sources: DetailSource[] = []
  if (Array.isArray(blob.sources)) {
    for (const s of blob.sources) {
      if (!s || typeof s !== 'object') continue
      const url = (s as Record<string, unknown>).url
      if (typeof url !== 'string' || url.trim() === '') continue
      const title = (s as Record<string, unknown>).title
      sources.push({ url, title: typeof title === 'string' && title.trim() ? title.trim() : null })
    }
  }

  return {
    fields,
    applied,
    sources,
    summary: cleanText(blob.summary),
    enrichedAt: cleanText(blob.enriched_at),
    status: cleanText(blob.status),
    error: cleanText(blob.error),
  }
}

/** `{ value, source_url, source_title, confidence }`, or a bare scalar. */
function readField(entry: unknown): BlobField | null {
  if (entry == null) return null
  if (typeof entry !== 'object') {
    const value = cleanText(entry)
    return value
      ? { value, sourceUrl: null, sourceTitle: null, confidence: null, foundAt: null }
      : null
  }
  const rec = entry as Record<string, unknown>
  const value = cleanText(rec.value)
  if (!value) return null
  return {
    value,
    sourceUrl: cleanText(rec.source_url),
    sourceTitle: cleanText(rec.source_title),
    confidence: normalizeConfidence(rec.confidence),
    foundAt: cleanText(rec.found_at),
  }
}

export function cleanText(value: unknown): string | null {
  if (value == null || typeof value === 'object') return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function normalizeConfidence(value: unknown): DetailConfidence | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null
}

export function normalizeStatus(value: string | null | undefined): DetailStatus {
  return value === 'pending' || value === 'enriched' || value === 'failed' || value === 'skipped'
    ? value
    : null
}

const CONFIDENCE_RANK: Record<DetailConfidence, number> = { high: 3, medium: 2, low: 1 }

export function lowestConfidence(
  values: Array<DetailConfidence | null | undefined>,
): DetailConfidence | null {
  let lowest: DetailConfidence | null = null
  for (const v of values) {
    if (!v) continue
    if (!lowest || CONFIDENCE_RANK[v] < CONFIDENCE_RANK[lowest]) lowest = v
  }
  return lowest
}

// ---------------------------------------------------------------------------
// Field assembly shared by both catalogs
// ---------------------------------------------------------------------------

/** A blob-only field (no column behind it). */
export function fieldFromBlob(
  key: string,
  label: string,
  kind: DetailKind,
  blobField: BlobField,
): DetailField {
  return {
    key,
    label,
    value: blobField.value,
    kind,
    origin: 'enrichment',
    enriched: true,
    sourceUrl: blobField.sourceUrl,
    sourceTitle: blobField.sourceTitle,
    confidence: blobField.confidence,
    foundAt: blobField.foundAt,
  }
}

/**
 * A column-backed field. The column is canonical; provenance (source +
 * confidence) is lent from the blob only when the run actually wrote the
 * column (`applied`), so a human-typed value never carries a web citation.
 */
export function fieldFromColumn(
  key: string,
  label: string,
  kind: DetailKind,
  value: string,
  provenance: BlobField | undefined,
): DetailField {
  return {
    key,
    label,
    value,
    kind,
    origin: 'column',
    enriched: provenance !== undefined,
    sourceUrl: provenance?.sourceUrl ?? null,
    sourceTitle: provenance?.sourceTitle ?? null,
    confidence: provenance?.confidence ?? null,
    foundAt: provenance?.foundAt ?? null,
  }
}

/** True when a web-sourced field is too weak to show as the record. */
export function isUnverified(field: DetailField): boolean {
  return field.enriched && field.confidence === 'low'
}

/** Assemble ordered, non-empty sections from a key→fields map. */
export function assembleSections<K extends string>(
  order: readonly K[],
  meta: Record<K, { title: string; layout: DetailSection['layout'] }>,
  bySection: Map<K, DetailField[]>,
): DetailSection<K>[] {
  const sections: DetailSection<K>[] = []
  for (const key of order) {
    const fields = bySection.get(key)
    if (!fields || fields.length === 0) continue
    sections.push({ key, title: meta[key].title, layout: meta[key].layout, fields })
  }
  return sections
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

/**
 * Split a comma/semicolon list at the top level only — a comma inside
 * parentheses belongs to that item. Empty items are dropped.
 */
export function splitList(value: string): string[] {
  return splitTopLevel(value, [',', ';'])
}

function splitTopLevel(value: string, separators: string[]): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (separators.includes(ch) && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * Whether a 'list' value should render as chips. Exa sometimes answers a list
 * question with a sentence ("X, Y, and Z, as evidenced by his talks."), and
 * chipping that produces fragments — so only a value whose every item is a
 * short phrase with no sentence punctuation counts as a real list.
 */
export function looksLikeList(value: string): boolean {
  const items = splitList(value)
  if (items.length < 2) return false
  return items.every((item) => {
    const words = item.split(/\s+/).filter(Boolean)
    return words.length <= 6 && !/[.!?:]$/.test(item)
  })
}

/** Chip text for one list item: drops a leading conjunction and a trailing period. */
export function chipText(item: string): string {
  return item.replace(/^(?:and|or|&)\s+/i, '').replace(/\.$/, '').trim()
}

export interface KeyPerson {
  name: string
  title: string | null
}

/**
 * "Ansel Varga (Co-Founder), Corbin Hale (Chief Agronomic Officer)"
 * → [{ name, title }, …]. Splits on commas and semicolons OUTSIDE parentheses
 * (titles like "Co-Founder, CEO" stay intact), then peels a trailing
 * parenthetical or a " - " / " – " suffix off as the title.
 */
export function parseKeyPeople(value: string): KeyPerson[] {
  return splitList(value).map((part) => {
    const paren = part.match(/^(.*?)\s*\((.+)\)\s*$/)
    if (paren) {
      const name = paren[1].trim()
      const title = paren[2].trim()
      return { name: name || title, title: name ? title || null : null }
    }
    const dash = part.match(/^(.*?)\s+[-–—]\s+(.+)$/)
    if (dash) return { name: dash[1].trim(), title: dash[2].trim() || null }
    return { name: part, title: null }
  })
}

const YEAR = /\b(?:19|20)\d{2}\b/
/** A trailing "(2020–2022)" / "(2015)" / "(Jan 2022 – Present)". */
const TRAILING_PAREN_PERIOD = /\s*\(([^()]*(?:19|20)\d{2}[^()]*)\)\s*\.?$/
/** A trailing ", 2020–2022" / " 2020 - present" without parentheses. */
const TRAILING_BARE_PERIOD =
  /[,\s]+((?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|current|now|today))\s*\.?$/i

/**
 * Parse a career or education line into dated entries.
 *
 *   "Senior Counsel - North America at Halvern (2022–Present); Associate at
 *    Marlowe Pierce (2016–2020)"
 *   "Bachelor of Arts in History from Westbrook (2005–2009); Doctor of Law (J.D.)
 *    from Lakeshore University School of Law (2012–2016)."
 *
 * Entries split on semicolons first; when there are none, on the boundary
 * after each dated parenthetical; and as a last resort on commas, but only
 * when every comma-separated piece is a complete entry on its own — it
 * carries an org separator, or it is the "Org (Detail)" shape ("Westbrook (B.A.
 * History), Columbia (M.S.)") where the parenthetical is the degree or role
 * and what precedes it is the org. Otherwise a comma is almost certainly
 * part of a single title. The org is whatever follows the LAST org separator
 * ("… at Halvern", "… from Westbrook"); a parenthetical that does not hold a year
 * ("Doctor of Law (J.D.)") stays in the title.
 */
export function parseTimeline(
  value: string,
  opts: { orgSeparators: readonly string[] },
): TimelineEntry[] {
  return splitTimelineEntries(value, opts.orgSeparators).map((raw) => {
    let rest = raw.trim().replace(/\.$/, '').trim()
    let period: string | null = null

    const paren = rest.match(TRAILING_PAREN_PERIOD)
    if (paren) {
      period = paren[1].trim()
      rest = rest.slice(0, paren.index).trim()
    } else {
      const bare = rest.match(TRAILING_BARE_PERIOD)
      if (bare) {
        period = bare[1].trim()
        rest = rest.slice(0, bare.index).trim()
      }
    }
    rest = rest.replace(/[,;\s]+$/, '')

    const { title, org } = splitTitleOrg(rest, opts.orgSeparators)
    return { title, org, period: period ? normalizePeriod(period) : null }
  })
}

/** "Westbrook (B.A. History)" → org "Westbrook", title "B.A. History". */
const ORG_PAREN_DETAIL = /^(.+?)\s*\(([^()]+)\)$/

function isOrgParenDetail(piece: string, orgSeparators: readonly string[]): boolean {
  const m = piece.match(ORG_PAREN_DETAIL)
  return !!m && !YEAR.test(m[2]) && !orgSeparators.some((sep) => piece.includes(sep))
}

function splitTimelineEntries(value: string, orgSeparators: readonly string[]): string[] {
  const bySemicolon = splitTopLevel(value, [';'])
  if (bySemicolon.length > 1) return bySemicolon

  // No semicolons: cut after each dated parenthetical when there are several.
  const datedParens = value.match(/\([^()]*(?:19|20)\d{2}[^()]*\)/g) ?? []
  if (datedParens.length > 1) {
    const parts: string[] = []
    let current = ''
    let depth = 0
    let i = 0
    while (i < value.length) {
      const ch = value[i]
      if (ch === '(') depth++
      if (ch === ')') depth = Math.max(0, depth - 1)
      current += ch
      if (ch === ')' && depth === 0 && YEAR.test(lastParenthetical(current))) {
        parts.push(current)
        current = ''
        // Skip the separator that follows the dated group.
        let j = i + 1
        while (j < value.length && /[\s,;.]/.test(value[j])) j++
        i = j
        continue
      }
      i++
    }
    if (current.trim()) parts.push(current)
    return parts.map((p) => p.trim()).filter(Boolean)
  }

  // Last resort: commas, but only when each piece is a complete entry.
  const byComma = splitTopLevel(value, [','])
  if (
    byComma.length > 1 &&
    byComma.every(
      (piece) =>
        orgSeparators.some((sep) => piece.includes(sep)) || isOrgParenDetail(piece, orgSeparators),
    )
  ) {
    return byComma
  }

  return value.trim() ? [value] : []
}

function lastParenthetical(text: string): string {
  const m = text.match(/\(([^()]*)\)\s*$/)
  return m ? m[1] : ''
}

function splitTitleOrg(
  text: string,
  orgSeparators: readonly string[],
): { title: string; org: string | null } {
  let bestIndex = -1
  let bestSep = ''
  for (const sep of orgSeparators) {
    const idx = text.lastIndexOf(sep)
    if (idx > bestIndex) {
      bestIndex = idx
      bestSep = sep
    }
  }
  if (bestIndex > 0) {
    const title = text.slice(0, bestIndex).trim()
    const org = text.slice(bestIndex + bestSep.length).trim()
    if (title && org) return { title, org }
  }
  // "Org (Detail)" with no separator: the parenthetical is the role/degree.
  const paren = text.match(ORG_PAREN_DETAIL)
  if (paren && !YEAR.test(paren[2])) {
    return { title: paren[2].trim(), org: paren[1].trim() }
  }
  return { title: text.trim(), org: null }
}

function normalizePeriod(period: string): string {
  return period
    .replace(/\s*[-—]\s*/g, '–')
    .replace(/\s*–\s*/g, '–')
    .replace(/\bpresent\b/i, 'Present')
    .replace(/\bcurrent\b/i, 'Present')
    .replace(/\bnow\b/i, 'Present')
    .trim()
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Strip scheme/www/trailing slash so a URL reads as a label. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

/** Bare host of a URL, or null for anything that is not one. */
export function sourceHost(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
