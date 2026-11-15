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
 * One exception to "names stay plain": a contact a public intake made (a
 * website form, a quote, a customer's first text) is named by a stranger,
 * so its own fields go in the same fence too (fenceStrangerContact).
 *
 * The drift test (src/lib/ai/__tests__/outside-text-tools.test.ts) holds each
 * tool that returns these fields to one of the helpers below.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { isE164 } from '@/lib/twilio/phone'
import {
  STRANGER_CONTACT_NAME,
  STRANGER_CONTACT_SOURCES,
  contactModelName,
  isPlainEmail,
  isStrangerContactSource,
  strangerEmail,
} from '@/lib/knowledge/stranger-contacts'

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

// The stranger's sources, the neutral name and the plain-email rule live
// beside the form rows' (src/lib/knowledge/stranger-contacts.ts): one copy.
export { STRANGER_CONTACT_SOURCES, STRANGER_CONTACT_NAME, isStrangerContactSource, isPlainEmail, strangerEmail, contactModelName }

/**
 * The fields of such a contact whose words a stranger chose: the names
 * (theirs, as they typed it; or the email's local part when they gave
 * none) and the address (no intake writes it today; a person may have
 * pasted it from their message). The email and any secondary ones are
 * theirs too, but fenced only when they are not a plain address
 * (strangerEmail): a plain one cannot carry prose, and the model copies it
 * into a send or a draft.
 */
export const STRANGER_CONTACT_FIELDS = ['full_name', 'first_name', 'last_name', 'address'] as const

/**
 * The contacts among `ids` a public intake made (their `source`), for a
 * caller whose rows came without it. One indexed read (by id) for the page;
 * none when `ids` is empty. A failed read counts every id, as above.
 */
export async function strangerContactIds(supabase: SupabaseClient, workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))]
  if (unique.length === 0) return new Set()
  const { data, error } = await supabase
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .in('id', unique)
    .in('source', [...STRANGER_CONTACT_SOURCES])
  if (error) return new Set(unique)
  return new Set(((data ?? []) as Array<{ id: unknown }>).map((r) => String(r.id)))
}

/**
 * The contacts among `ids` that a contact a public intake made was merged
 * into (merged_into_contact_id; merge_contacts, migration 248, folds the
 * tombstone's emails, names, phone and notes into the one it joins). Such a
 * contact reads as the stranger's too (fenceStrangerContact), as
 * get_contact_details already does when asked by the tombstone's id. One
 * indexed read for the page; none when `ids` is empty. A failed read counts
 * every id: a stranger's words never come back plain because a lookup failed.
 * One hop: a chain of merges (a stranger into B, B into C) is not followed.
 */
export async function strangerMergedInto(supabase: SupabaseClient, workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))]
  if (unique.length === 0) return new Set()
  const { data, error } = await supabase
    .from('contact')
    .select('merged_into_contact_id')
    .eq('workspace_id', workspaceId)
    .in('merged_into_contact_id', unique)
    .in('source', [...STRANGER_CONTACT_SOURCES])
  if (error) return new Set(unique)
  return new Set(((data ?? []) as Array<{ merged_into_contact_id: unknown }>).map((r) => String(r.merged_into_contact_id)))
}

const RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One string of a custom field, fenced, unless it is a record's id (a relation field's): the model needs those verbatim. */
function fenceFieldString(value: unknown): unknown {
  return typeof value === 'string' && RECORD_ID_RE.test(value) ? value : webText(value)
}

/** A custom field's value with its words fenced: a string, or each string of a list; numbers, flags and amounts as they are. */
function fenceFieldValue(value: unknown): unknown {
  if (typeof value === 'string') return fenceFieldString(value)
  if (Array.isArray(value)) return value.map(fenceFieldString)
  return value
}

/**
 * A contact as the model reads it when a public intake made it (`source`
 * 'web_form' or 'sms'): every string a stranger could have typed goes in the
 * WEB fence, the row keeps its keys, and `from_form: true` says why. The
 * names, the address, the custom fields' strings; the email and any
 * secondary ones only when they are not a plain address (isPlainEmail), a
 * phone only when it is not E.164 (intakes store it normalised: digits, no
 * words). Conservative: the source never changes, so a contact a person later
 * edited by hand stays fenced. Any other contact comes back as it is. Pure;
 * `source` is the contact's own column (read it with the row).
 */
export function fenceStrangerContact<T extends Record<string, unknown>>(contact: T, source: unknown): T {
  if (!contact || typeof contact !== 'object' || !isStrangerContactSource(source)) return contact
  const out = fenceWebFields(contact, STRANGER_CONTACT_FIELDS) as Record<string, unknown>
  if ('email' in out) out.email = strangerEmail(out.email)
  if (typeof out.phone === 'string' && !isE164(out.phone)) out.phone = webText(out.phone)
  if (Array.isArray(out.secondary_emails)) out.secondary_emails = out.secondary_emails.map((e) => strangerEmail(e))
  const fields = out.custom_fields
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    out.custom_fields = Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([key, value]) => [key, fenceFieldValue(value)]))
  }
  out.from_form = true
  return out as T
}
/** The company columns enrichment writes from public pages (COMPANY_COLUMNS' prose ones). */
export const COMPANY_WEB_FIELDS = ['industry', 'description'] as const
