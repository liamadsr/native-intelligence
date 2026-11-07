/**
 * Web-derived CRM and prospecting text, fenced for the model (always-on safety
 * fixes, 2026-10-15; "untrusted labels everywhere", always-on-agent §6).
 *
 * Enrichment and prospecting read public web pages (a company's own site,
 * a LinkedIn profile, search results) and write what they found into CRM
 * columns and blobs: a company's description and industry, a contact's job
 * title and the enrichment summary folded into their notes, a prospect's
 * why-fit paragraph. Whoever wrote those pages can put instructions in them,
 * so wherever a tool hands that text to a model it goes inside the WEB
 * untrusted-content marker (src/lib/email/untrusted.ts). Names, domains, ids
 * and URLs stay plain: the model needs them verbatim to call other tools.
 *
 * The drift test (src/lib/ai/__tests__/outside-text-tools.test.ts) holds each
 * tool that returns these fields to one of the helpers below.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'

/** A web-derived string inside the WEB fence; anything else (null, numbers, '') as it is. */
export function webText<T>(value: T): T | string {
  return typeof value === 'string' && value.trim() ? (wrapUntrusted(value, 'WEB') ?? value) : value
}

/** A copy of `row` with each named string field fenced (only fields that are present). */
export function fenceWebFields<T extends Record<string, unknown>>(row: T, fields: readonly string[]): T {
  if (!row || typeof row !== 'object') return row
  const out: Record<string, unknown> = { ...row }
  for (const field of fields) if (field in out) out[field] = webText(out[field])
  return out as T
}

/** Each string value of a flat field map, fenced (an enrichment card's fields as the model reads them). */
export function fenceWebValues(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) out[key] = webText(value)
  return out
}

/**
 * A row's `metadata` with its web enrichment blob fenced: each field's value,
 * the run's summary and the notes summary. The blob keeps its shape; sources
 * (URLs) stay plain. Anything that is not an object passes as it is.
 */
export function fenceEnrichmentMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata
  const meta = metadata as Record<string, unknown>
  const enrichment = meta.enrichment
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) return metadata
  const blob = { ...(enrichment as Record<string, unknown>) }
  const fields = blob.fields
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    blob.fields = Object.fromEntries(
      Object.entries(fields as Record<string, unknown>).map(([key, entry]) => [
        key,
        entry && typeof entry === 'object' && !Array.isArray(entry) && 'value' in (entry as Record<string, unknown>)
          ? { ...(entry as Record<string, unknown>), value: webText((entry as Record<string, unknown>).value) }
          : webText(entry),
      ]),
    )
  }
  for (const key of ['summary', 'notes_summary']) if (key in blob) blob[key] = webText(blob[key])
  return { ...meta, enrichment: blob }
}

/**
 * A contact row as the model reads it: the columns enrichment fills from the
 * web (job title, department) and the enrichment blob go in the WEB fence.
 * The notes are the person's own words with the enrichment summary folded in
 * (src/lib/crm/enrichment.ts), so they take the WORKSPACE fence ("workspace
 * records built partly from outside text"), never a WEB label on what the
 * person typed.
 */
export function fenceContactForModel<T extends Record<string, unknown>>(contact: T): T {
  const fenced = fenceWebFields(contact, CONTACT_WEB_FIELDS) as Record<string, unknown>
  if (typeof fenced.notes === 'string' && fenced.notes.trim()) fenced.notes = wrapUntrusted(fenced.notes, 'WORKSPACE') ?? fenced.notes
  if ('metadata' in fenced) fenced.metadata = fenceEnrichmentMetadata(fenced.metadata)
  return fenced as T
}

/** The contact columns enrichment writes from public pages (src/lib/crm/enrichment.ts). */
export const CONTACT_WEB_FIELDS = ['job_title', 'department'] as const
/** The company columns enrichment writes from public pages (COMPANY_COLUMNS' prose ones). */
export const COMPANY_WEB_FIELDS = ['industry', 'description'] as const
