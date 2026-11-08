/**
 * What an import does with one record, decided without I/O (roadmap track G):
 *
 *   who      {@link matchContact}: the merge engine's own evidence
 *            (src/lib/crm/contact-dedup.ts) against the workspace's contacts
 *            and what this import already wrote. An auto-tier match is the
 *            same person; a suggest-tier match is a new contact to check; no
 *            match is a new contact.
 *   what     {@link contactPatch}: the fields an import may write on a contact
 *            it matched, never over the owner's own. A field is written when
 *            it is empty, or when it still holds what this same source wrote
 *            last time (so a re-import refreshes its own data); anything else
 *            the owner typed or another source wrote stays. Tags and extra
 *            emails are added, never removed; notes are appended; the last
 *            contact date only moves later; "contact" may become "customer",
 *            never the other way.
 *   new      {@link contactInsert}: a new contact's row, tagged with its
 *            source.
 *
 * `metadata.imported[source]` holds, per field, the value that source last
 * wrote: the provenance the no-overwrite rule reads.
 */
import {
  bestContactMatch,
  namesCompatible,
  nameTokens,
  type ContactMatchIndex,
  type DedupContact,
  type PairMatch,
} from '@/lib/crm/contact-dedup'
import { IMPORT_SOURCE_LABEL, sourceTag, type ImportContactRecord, type ImportCompanyRecord, type ImportSource } from './record'

/** The scalar contact fields an import may fill. */
export const IMPORT_CONTACT_FIELDS = ['first_name', 'last_name', 'full_name', 'email', 'phone', 'address', 'job_title'] as const
export type ImportContactField = (typeof IMPORT_CONTACT_FIELDS)[number]

/** A field's value before and after an import changed it: the undo journal's entry. */
export interface FieldChange {
  before: unknown
  after: unknown
}

export type FieldChanges = Record<string, FieldChange>

/** The local contact row, as much of it as the patch reads. */
export interface LocalContact {
  id: string
  first_name: string | null
  last_name: string | null
  full_name: string | null
  email: string | null
  secondary_emails: string[] | null
  phone: string | null
  address: string | null
  job_title: string | null
  notes: string | null
  tags: string[] | null
  company_id: string | null
  relationship_type: string | null
  last_interaction_at: string | null
  metadata: Record<string, unknown> | null
}

/** The record as the merge engine compares people. `id` is a placeholder. */
export function toDedupContact(record: ImportContactRecord, id = 'incoming'): DedupContact {
  const [email, ...others] = record.emails ?? []
  return {
    id,
    full_name: record.fullName ?? null,
    first_name: record.firstName ?? null,
    last_name: record.lastName ?? null,
    email: email ?? null,
    secondary_emails: others,
    phone: record.phones?.[0] ?? null,
    company_id: null,
    member_id: null,
    interaction_count: 0,
    last_interaction_at: null,
    created_at: new Date(0).toISOString(),
  }
}

export type ContactMatchDecision =
  | { kind: 'same'; contactId: string; match: PairMatch }
  /** Someone who may be the same person: a new contact, flagged to check against `candidateId`. */
  | { kind: 'check'; candidateId: string; match: PairMatch; dropEmails: string[] }
  | { kind: 'new' }

/**
 * Who the record is. One exception to the engine's tiers: a shared email
 * with a clearly different name (a couple sharing "smithfamily@") is not the
 * same person here. The record becomes a contact of its own, without that
 * address (one address belongs to one contact), flagged to check.
 */
export function matchContact(index: ContactMatchIndex, record: ImportContactRecord): ContactMatchDecision {
  const incoming = toDedupContact(record)
  const best = bestContactMatch(index, incoming)
  if (!best) return { kind: 'new' }
  if (best.match.tier === 'auto') {
    const bothNamed = nameTokens(incoming).length > 0 && nameTokens(best.contact).length > 0
    if (best.match.matchType === 'auto:alias' && bothNamed && !namesCompatible(incoming, best.contact)) {
      const theirs = new Set([best.contact.email, ...(best.contact.secondary_emails ?? [])].filter(Boolean).map((e) => String(e).toLowerCase()))
      return { kind: 'check', candidateId: best.contact.id, match: best.match, dropEmails: (record.emails ?? []).filter((e) => theirs.has(e)) }
    }
    return { kind: 'same', contactId: best.contact.id, match: best.match }
  }
  return { kind: 'check', candidateId: best.contact.id, match: best.match, dropEmails: [] }
}

// ---------------------------------------------------------------------------
// The no-overwrite patch
// ---------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

/** What `source` last wrote on this contact, per field. */
export function provenanceOf(metadata: Record<string, unknown> | null | undefined, source: ImportSource): Record<string, unknown> {
  const imported = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).imported : null
  const mine = imported && typeof imported === 'object' ? (imported as Record<string, unknown>)[source] : null
  return mine && typeof mine === 'object' && !Array.isArray(mine) ? { ...(mine as Record<string, unknown>) } : {}
}

/** The record's value for each scalar field (null when it has none). */
export function incomingFields(record: ImportContactRecord): Record<ImportContactField, string | null> {
  return {
    first_name: record.firstName ?? null,
    last_name: record.lastName ?? null,
    full_name: record.fullName ?? null,
    email: record.emails?.[0] ?? null,
    phone: record.phones?.[0] ?? null,
    address: record.address ?? null,
    job_title: record.jobTitle ?? null,
  }
}

/** A name that is only a placeholder (empty, or the email address findOrCreateContact stores). */
function placeholderName(local: LocalContact): boolean {
  if (isEmpty(local.full_name)) return true
  const name = String(local.full_name).trim().toLowerCase()
  return !!local.email && name === local.email.trim().toLowerCase()
}

/**
 * The relationship an import may move a contact to: "contact" (the default)
 * may become "lead" or "customer"; a "lead" only becomes "customer" when this
 * source made it a lead (`ours`), since a lead the owner set is their word.
 * Partner, vendor, internal and candidate never move.
 */
export function upgradedRelationship(current: string | null, incoming: ImportContactRecord['relationship'], ours = false): string | null {
  if (!incoming || incoming === 'contact') return null
  const rank: Record<string, number> = { contact: 0, lead: 1, customer: 2 }
  const now = current ?? 'contact'
  if (!(now in rank)) return null
  if (now !== 'contact' && !ours) return null
  return rank[incoming] > rank[now] ? incoming : null
}

export interface ContactPatchResult {
  /** The columns to write (empty: nothing to change). */
  patch: Record<string, unknown>
  /** Before and after of each column written (the undo journal). */
  changes: FieldChanges
}

/**
 * The patch an import writes on a contact it matched. Pure. `companyId` is
 * the record's resolved company, set only when the contact has none.
 */
export function contactPatch(args: {
  local: LocalContact
  record: ImportContactRecord
  source: ImportSource
  companyId?: string | null
  /** Emails the patch must not take (they belong to another contact). */
  blockedEmails?: ReadonlySet<string>
}): ContactPatchResult {
  const { local, record, source } = args
  const patch: Record<string, unknown> = {}
  const changes: FieldChanges = {}
  const provenance = provenanceOf(local.metadata, source)
  const nextProvenance = { ...provenance }
  const set = (field: string, before: unknown, after: unknown) => {
    patch[field] = after
    changes[field] = { before: before ?? null, after }
  }

  const incoming = incomingFields(record)
  const blocked = args.blockedEmails ?? new Set<string>()
  if (incoming.email && blocked.has(incoming.email)) incoming.email = null

  for (const field of IMPORT_CONTACT_FIELDS) {
    const value = incoming[field]
    if (isEmpty(value)) continue
    const current = local[field]
    // Already the same: nothing to write, and no claim on it either. A value
    // the owner typed stays theirs even when a file happens to agree with it,
    // so a later file can't overwrite it as "ours" (an earlier claim stays).
    if (current === value) continue
    const empty = field === 'full_name' ? placeholderName(local) : isEmpty(current)
    const ours = !isEmpty(provenance[field]) && provenance[field] === current
    // The primary email changes only when there is none: an address is identity.
    if (field === 'email' && !empty) continue
    if (empty || ours) {
      set(field, current, value)
      nextProvenance[field] = value
    }
  }

  // Extra addresses join the contact's other emails.
  const known = new Set([patch.email ?? local.email, ...(local.secondary_emails ?? [])].filter(Boolean).map((e) => String(e).toLowerCase()))
  const extra = (record.emails ?? []).filter((e) => !known.has(e) && !blocked.has(e))
  if (extra.length) set('secondary_emails', local.secondary_emails ?? [], [...(local.secondary_emails ?? []), ...extra])

  // Tags: the source's own tag and the record's, added.
  const tags = local.tags ?? []
  const addTags = [sourceTag(source), ...(record.tags ?? [])].filter((t) => !tags.includes(t))
  if (addTags.length) set('tags', tags, [...tags, ...addTags])

  // Notes: appended under the source's name, once.
  if (record.notes) {
    const current = local.notes ?? ''
    if (!current.includes(record.notes)) {
      const next = current.trim() ? `${current.trim()}\n\nFrom ${IMPORT_SOURCE_LABEL[source].replace(/^your /, 'the ')}: ${record.notes}` : record.notes
      set('notes', local.notes, next)
    }
  }

  if (args.companyId && isEmpty(local.company_id)) set('company_id', local.company_id, args.companyId)

  const relationship = upgradedRelationship(local.relationship_type, record.relationship, !isEmpty(provenance.relationship_type) && provenance.relationship_type === local.relationship_type)
  if (relationship) {
    set('relationship_type', local.relationship_type, relationship)
    nextProvenance.relationship_type = relationship
  }

  if (record.lastContactAt && (!local.last_interaction_at || Date.parse(record.lastContactAt) > Date.parse(local.last_interaction_at))) {
    set('last_interaction_at', local.last_interaction_at, record.lastContactAt)
  }

  if (Object.keys(patch).length > 0 || JSON.stringify(nextProvenance) !== JSON.stringify(provenance)) {
    patch.metadata = withProvenance(local.metadata, source, nextProvenance)
  }
  return { patch, changes }
}

/** The metadata with `source`'s provenance replaced (sibling keys kept). */
export function withProvenance(metadata: Record<string, unknown> | null | undefined, source: ImportSource, values: Record<string, unknown>): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {}
  const imported = base.imported && typeof base.imported === 'object' ? { ...(base.imported as Record<string, unknown>) } : {}
  imported[source] = values
  return { ...base, imported }
}

// ---------------------------------------------------------------------------
// New rows
// ---------------------------------------------------------------------------

/**
 * Where an import's contact rows say they came from (contact.source_provider).
 * A connected HubSpot keeps its sync's own value; a HubSpot export file,
 * read with no portal connected, is 'hubspot_export': its record ids name a
 * portal nobody connected, so nothing that writes to HubSpot by id (the
 * meeting log, the sync) may take its contacts for that portal's.
 */
export function sourceProvider(source: ImportSource, connected = true): string {
  return source === 'hubspot' && !connected ? 'hubspot_export' : source
}

/**
 * A new contact's row. `source_provider` is always set: the HubSpot push
 * sweep only ever pushes rows without one, so nothing an import brings in is
 * written back out to anyone's CRM.
 */
export function contactInsert(args: {
  workspaceId: string
  record: ImportContactRecord
  source: ImportSource
  companyId: string | null
  createdByMemberId: string | null
  dropEmails?: readonly string[]
  /** The batch and item writing it: a retry after a crash finds its own row (./batch.ts). */
  stamp?: { batchId: string; itemId: string }
  /** Read from a connected account (false: a file). */
  connected?: boolean
}): Record<string, unknown> {
  const { record, source } = args
  const hubspotSync = source === 'hubspot' && args.connected !== false
  const drop = new Set(args.dropEmails ?? [])
  const emails = (record.emails ?? []).filter((e) => !drop.has(e))
  const [email, ...secondary] = emails
  const [phone, ...otherPhones] = record.phones ?? []
  const fields = incomingFields({ ...record, emails })
  const provenance: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(fields)) if (!isEmpty(value)) provenance[field] = value
  if (record.relationship && record.relationship !== 'contact') provenance.relationship_type = record.relationship
  const notes = [record.notes, otherPhones.length ? `Other phone${otherPhones.length > 1 ? 's' : ''}: ${otherPhones.join(', ')}` : null]
    .filter(Boolean)
    .join('\n\n')
  return {
    workspace_id: args.workspaceId,
    full_name: record.fullName || email || phone || 'Unknown',
    first_name: record.firstName ?? null,
    last_name: record.lastName ?? null,
    email: email ?? null,
    secondary_emails: secondary,
    phone: phone ?? null,
    address: record.address ?? null,
    job_title: record.jobTitle ?? null,
    company_id: args.companyId,
    notes: notes || null,
    tags: [sourceTag(source), ...(record.tags ?? []).filter((t) => t !== sourceTag(source))],
    relationship_type: record.relationship ?? 'contact',
    last_interaction_at: record.lastContactAt ?? null,
    source: hubspotSync ? 'hubspot_sync' : 'import',
    source_provider: sourceProvider(source, args.connected !== false),
    provider_contact_id: source === 'hubspot' && !hubspotSync ? null : (record.externalId ?? null),
    // Imported customers are the business's, seen by its whole workspace.
    visibility: 'workspace',
    created_by_member_id: args.createdByMemberId,
    metadata: withProvenance(args.stamp ? { import_batch: args.stamp.batchId, import_item: args.stamp.itemId } : {}, source, provenance),
  }
}

/** A new company's row from a company record. */
export function companyInsert(workspaceId: string, record: ImportCompanyRecord, source: ImportSource): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    name: record.name || record.domain || 'Unknown company',
    domain: record.domain ?? null,
    website: record.website ?? null,
    phone: record.phone ?? null,
    address: record.address ?? null,
    city: record.city ?? null,
    state: record.state ?? null,
    country: record.country ?? null,
    industry: record.industry ?? null,
    description: record.description ?? null,
    tags: [sourceTag(source), ...(record.tags ?? [])],
    source_provider: source,
    provider_company_id: record.externalId ?? null,
    is_workspace_company: false,
  }
}

/** The company columns an import may fill on a company it matched: empty ones only. */
export const IMPORT_COMPANY_FIELDS = ['name', 'domain', 'website', 'phone', 'address', 'city', 'state', 'country', 'industry', 'description'] as const

export function companyPatch(local: Record<string, unknown>, record: ImportCompanyRecord, source: ImportSource): ContactPatchResult {
  const patch: Record<string, unknown> = {}
  const changes: FieldChanges = {}
  for (const field of IMPORT_COMPANY_FIELDS) {
    const value = record[field]
    if (isEmpty(value) || !isEmpty(local[field])) continue
    patch[field] = value
    changes[field] = { before: local[field] ?? null, after: value }
  }
  const tags = (local.tags as string[] | null) ?? []
  const addTags = [sourceTag(source), ...(record.tags ?? [])].filter((t) => !tags.includes(t))
  if (addTags.length) {
    patch.tags = [...tags, ...addTags]
    changes.tags = { before: tags, after: patch.tags }
  }
  return { patch, changes }
}
