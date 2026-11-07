/**
 * The one import path every source feeds (roadmap track G,
 * docs/plans/customer-import.md). Server only: a service-role client, since
 * the batch tables have no client write policy.
 *
 *   create   {@link createImportBatch}: a batch for one source (a file, an
 *            account). Status 'staging'.
 *   stage    {@link stageRecords}: records into contact_import_item, cleaned
 *            (./record.ts). A record that names nobody is staged as
 *            'skipped', so the summary can say so.
 *   apply    {@link applyPendingItems}: up to `limit` pending items at a
 *            time, in order. Each record is matched with the merge engine
 *            (./plan.ts matchContact): the same person is filled in, never
 *            over the owner's own fields; a maybe-the-same person is a new
 *            contact to check; anyone else is a new contact. Every write is
 *            journaled on its item (before and after), with the history rows
 *            and source links it added.
 *   finish   {@link finishImportBatch}: status 'done', the summary
 *            (./summary.ts), and the owner told once: their home thread and
 *            a text (./notify.ts).
 *   undo     {@link undoImportItems} + {@link finishUndo}: the whole batch
 *            taken back, newest item first (./undo.ts).
 *
 * Nothing here sends anything anywhere, starts enrichment or outreach, or
 * writes back to a source. Every contact an import creates carries a
 * `source_provider`, which is what keeps the HubSpot push sweep away from it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addToContactMatchIndex,
  buildContactMatchIndex,
  DEDUP_COLUMNS,
  namesCompatible,
  type ContactMatchIndex,
  type DedupContact,
} from '@/lib/crm/contact-dedup'
import { isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { isPersonalDomain } from '@/lib/crm/domains'
import { HUBSPOT_PUSH_HOLD_KEY, hubspotPushHold } from '@/lib/crm/hubspot-push-hold'
import {
  companyInsert,
  companyPatch,
  contactInsert,
  contactPatch,
  matchContact,
  provenanceOf,
  toDedupContact,
  type FieldChanges,
  type LocalContact,
} from './plan'
import {
  normalizeRecord,
  type ImportCompanyRecord,
  type ImportCompanyRef,
  type ImportContactRecord,
  type ImportPastJob,
  type ImportRecord,
  type ImportSource,
  UNSUBSCRIBED_EMAIL_TAG,
} from './record'
import { addCounts, emptyCounts, readCounts, type ImportCounts } from './summary'

type Db = SupabaseClient

export type ImportBatchStatus = 'staging' | 'running' | 'done' | 'failed' | 'undoing' | 'undone'

export interface ImportBatch {
  id: string
  workspace_id: string
  user_id: string
  source: ImportSource
  label: string | null
  account_id: string | null
  status: ImportBatchStatus
  total: number
  counts: ImportCounts
  summary: string | null
  notify: boolean
  created_at: string
  finished_at: string | null
  notified_at: string | null
  undone_at: string | null
}

export type ItemOutcome = 'pending' | 'created' | 'matched' | 'repeat' | 'review' | 'unchanged' | 'skipped' | 'failed'

export interface ImportItem {
  id: string
  batch_id: string
  workspace_id: string
  seq: number
  kind: 'contact' | 'company'
  record: ImportRecord
  outcome: ItemOutcome
  contact_id: string | null
  company_id: string | null
  candidate_contact_id: string | null
  match_type: string | null
  changes: FieldChanges
  created_company_id: string | null
  history_ids: string[]
  links: SourceLinkRef[]
  undone_at: string | null
}

/** A crm_source_link row an item created (undo removes it). */
export interface SourceLinkRef {
  kind: 'contact' | 'company'
  external_id: string
}

const BATCH_COLUMNS = 'id, workspace_id, user_id, source, label, account_id, status, total, counts, summary, notify, created_at, finished_at, notified_at, undone_at'
const ITEM_COLUMNS =
  'id, batch_id, workspace_id, seq, kind, record, outcome, contact_id, company_id, candidate_contact_id, match_type, changes, created_company_id, history_ids, links, undone_at'
const LOCAL_CONTACT_COLUMNS =
  'id, first_name, last_name, full_name, email, secondary_emails, phone, address, job_title, notes, tags, company_id, relationship_type, last_interaction_at, metadata, merged_into_contact_id, source_provider, provider_contact_id'

/** Records staged per insert. */
const STAGE_CHUNK = 500
/** What one apply call takes on by default. */
export const APPLY_CHUNK = 200
/** At or under this many records, an import runs inside the agent's own call. */
export const INLINE_IMPORT_MAX = 150

function toBatch(row: Record<string, unknown>): ImportBatch {
  return { ...(row as unknown as ImportBatch), counts: readCounts(row.counts) }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err)).slice(0, 500)
}

const isUniqueViolation = (error: { code?: string } | null | undefined) => error?.code === '23505'

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function createImportBatch(
  db: Db,
  args: { workspaceId: string; userId: string; source: ImportSource; label?: string | null; accountId?: string | null; notify?: boolean },
): Promise<{ ok: true; batch: ImportBatch } | { ok: false; error: string }> {
  const { data, error } = await db
    .from('contact_import_batch')
    .insert({
      workspace_id: args.workspaceId,
      user_id: args.userId,
      source: args.source,
      label: args.label ? args.label.slice(0, 200) : null,
      account_id: args.accountId ?? null,
      notify: args.notify ?? true,
      status: 'staging',
      total: 0,
    })
    .select(BATCH_COLUMNS)
    .maybeSingle()
  if (error || !data) return { ok: false, error: `contact_import_batch insert failed: ${error?.message ?? 'no row'}` }
  return { ok: true, batch: toBatch(data as Record<string, unknown>) }
}

export async function loadImportBatch(db: Db, batchId: string): Promise<ImportBatch | null> {
  const { data } = await db.from('contact_import_batch').select(BATCH_COLUMNS).eq('id', batchId).maybeSingle()
  return data ? toBatch(data as Record<string, unknown>) : null
}

/** The account's batch still staging (a source that stages page by page over several runs), if any. */
export async function stagingBatchForAccount(db: Db, accountId: string): Promise<ImportBatch | null> {
  const { data } = await db
    .from('contact_import_batch')
    .select(BATCH_COLUMNS)
    .eq('account_id', accountId)
    .eq('status', 'staging')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? toBatch(data as Record<string, unknown>) : null
}

/** The workspace's latest batches (one person's, given `userId`), newest first. */
export async function recentImportBatches(db: Db, workspaceId: string, limit = 5, userId?: string): Promise<ImportBatch[]> {
  let query = db.from('contact_import_batch').select(BATCH_COLUMNS).eq('workspace_id', workspaceId)
  if (userId) query = query.eq('user_id', userId)
  const { data } = await query.order('created_at', { ascending: false }).limit(limit)
  return ((data as Record<string, unknown>[] | null) ?? []).map(toBatch)
}

/** True while a batch of the workspace is being applied or undone (its contact snapshot would race this one). */
export async function workspaceImportBusy(db: Db, workspaceId: string): Promise<boolean> {
  const { data } = await db.from('contact_import_batch').select('id').eq('workspace_id', workspaceId).in('status', ['running', 'undoing']).limit(1)
  return Array.isArray(data) && data.length > 0
}

async function saveCounts(db: Db, batch: ImportBatch, delta: Partial<ImportCounts>, extra: Record<string, unknown> = {}): Promise<ImportCounts> {
  const fresh = await loadImportBatch(db, batch.id)
  const counts = addCounts(fresh?.counts ?? batch.counts, delta)
  await db.from('contact_import_batch').update({ counts, ...extra }).eq('id', batch.id)
  batch.counts = counts
  return counts
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Stage records after the batch's current last one. Records are cleaned
 * here; one that names nobody is staged as 'skipped'. Returns how many were
 * staged and skipped.
 */
export async function stageRecords(db: Db, batch: ImportBatch, records: ImportRecord[], nowMs: number = Date.now()): Promise<{ staged: number; skipped: number }> {
  if (records.length === 0) return { staged: 0, skipped: 0 }
  const fresh = await loadImportBatch(db, batch.id)
  let seq = (fresh?.total ?? batch.total) || 0
  let skipped = 0
  const rows = records.map((raw) => {
    const record = normalizeRecord(raw, nowMs)
    if (!record) skipped++
    return {
      batch_id: batch.id,
      workspace_id: batch.workspace_id,
      seq: seq++,
      kind: raw.kind,
      record: record ?? { kind: raw.kind },
      outcome: record ? 'pending' : 'skipped',
    }
  })
  for (let i = 0; i < rows.length; i += STAGE_CHUNK) {
    const { error } = await db.from('contact_import_item').insert(rows.slice(i, i + STAGE_CHUNK))
    if (error) throw new Error(`contact_import_item insert failed: ${error.message}`)
  }
  batch.total = seq
  await saveCounts(db, batch, { skipped }, { total: seq })
  return { staged: rows.length, skipped }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

interface ApplyContext {
  db: Db
  batch: ImportBatch
  index: ContactMatchIndex
  /** The contacts the batch's user may see, by id: the import matches and writes only these. */
  visible: Map<string, DedupContact>
  /** Contacts this batch created (earlier chunks and this one): a match to one is a repeat. */
  createdByBatch: Set<string>
  /** Companies resolved this chunk, by key. */
  companyCache: Map<string, CompanyResolution>
  memberId: string | null
  counts: ImportCounts
}

interface CompanyResolution {
  id: string | null
  created: boolean
  /** Contacts the workspace already had that the new company's domain trigger adopted (undo gives them back). */
  adopted: string[]
}

function dedupShape(row: Record<string, unknown>): DedupContact {
  return {
    id: String(row.id),
    full_name: (row.full_name as string | null) ?? null,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    secondary_emails: (row.secondary_emails as string[] | null) ?? [],
    phone: (row.phone as string | null) ?? null,
    company_id: (row.company_id as string | null) ?? null,
    member_id: (row.member_id as string | null) ?? null,
    interaction_count: (row.interaction_count as number | null) ?? 0,
    last_interaction_at: (row.last_interaction_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? new Date().toISOString(),
  }
}

/**
 * The workspace's active contacts the batch's user may see, as contact_visible_to
 * (migration 234) decides it for the common cases: an owner or admin sees all,
 * anyone else the workspace's contacts and their own. Team and shared private
 * contacts are left out (fail closed): an import never reads, matches or writes
 * a contact its user can't see.
 */
async function loadVisibleContacts(db: Db, workspaceId: string, member: { id: string; role: string | null } | null): Promise<DedupContact[]> {
  const all = member?.role === 'owner' || member?.role === 'admin'
  const rows: DedupContact[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from('contact')
      .select(`${DEDUP_COLUMNS}, visibility, created_by_member_id`)
      .eq('workspace_id', workspaceId)
      .is('merged_into_contact_id', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + 999)
    if (error) throw new Error(`contact read failed: ${error.message}`)
    const page = (data as Array<Record<string, unknown>> | null) ?? []
    for (const r of page) {
      if (all || r.visibility === 'workspace' || (member && r.created_by_member_id === member.id)) rows.push(dedupShape(r))
    }
    if (page.length < 1000) break
  }
  return rows
}

async function loadLocalContact(db: Db, workspaceId: string, id: string): Promise<(LocalContact & { merged_into_contact_id: string | null; source_provider: string | null; provider_contact_id: string | null }) | null> {
  const { data } = await db.from('contact').select(LOCAL_CONTACT_COLUMNS).eq('id', id).eq('workspace_id', workspaceId).maybeSingle()
  return (data as never) ?? null
}

/**
 * The key a source's own id is linked under: per connected account (a Brevo
 * contact 5 in one account is not contact 5 in another), else as given.
 */
function linkKey(ctx: ApplyContext, externalId: string): string {
  return ctx.batch.account_id ? `${ctx.batch.account_id}:${externalId}` : externalId
}

/** A source link's contact, following a merge to the contact that survived it. */
async function linkedContactId(ctx: ApplyContext, externalId: string): Promise<string | null> {
  const { db, batch } = ctx
  const { data } = await db
    .from('crm_source_link')
    .select('entity_id')
    .eq('workspace_id', batch.workspace_id)
    .eq('source', batch.source)
    .eq('kind', 'contact')
    .eq('external_id', linkKey(ctx, externalId))
    .maybeSingle()
  let id = (data as { entity_id?: string } | null)?.entity_id ?? null
  if (!id && batch.source === 'hubspot') {
    // Contacts HubSpot's own sync brought in before imports existed.
    const { data: synced } = await db
      .from('contact')
      .select('id')
      .eq('workspace_id', batch.workspace_id)
      .eq('source_provider', 'hubspot')
      .eq('provider_contact_id', externalId)
      .maybeSingle()
    id = (synced as { id?: string } | null)?.id ?? null
  }
  for (let hops = 0; id && hops < 5; hops++) {
    const { data: row } = await db.from('contact').select('id, merged_into_contact_id').eq('id', id).eq('workspace_id', batch.workspace_id).maybeSingle()
    const r = row as { id: string; merged_into_contact_id: string | null } | null
    if (!r) return null
    if (!r.merged_into_contact_id) return r.id
    id = r.merged_into_contact_id
  }
  return null
}

async function linkSource(ctx: ApplyContext, kind: 'contact' | 'company', externalId: string | null | undefined, entityId: string): Promise<SourceLinkRef | null> {
  if (!externalId) return null
  const key = linkKey(ctx, externalId)
  const { error } = await ctx.db.from('crm_source_link').insert({
    workspace_id: ctx.batch.workspace_id,
    source: ctx.batch.source,
    kind,
    external_id: key,
    entity_id: entityId,
    batch_id: ctx.batch.id,
  })
  // Already linked (a re-import): the existing link stays the earlier batch's.
  if (error) return null
  return { kind, external_id: key }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * The workspace company a record names: its source link, then its domain
 * (a real one, not a free-mail domain), then its exact name. Created when
 * none matches and the record names one. A created company with a domain
 * adopts the workspace's unassigned contacts at that domain (migration 232's
 * trigger): those are returned, so undo can give them back.
 */
async function resolveCompany(ctx: ApplyContext, ref: ImportCompanyRef | ImportCompanyRecord): Promise<CompanyResolution> {
  const { db, batch } = ctx
  const externalId = ref.externalId ?? null
  const domain = ref.domain && !isPersonalDomain(ref.domain) ? ref.domain : null
  const name = ref.name ?? null
  const key = `${externalId ?? ''}|${domain ?? ''}|${(name ?? '').toLowerCase()}`
  const cached = ctx.companyCache.get(key)
  if (cached) return { id: cached.id, created: false, adopted: [] }
  const found = (id: string | null): CompanyResolution => {
    const r = { id, created: false, adopted: [] }
    ctx.companyCache.set(key, r)
    return r
  }

  let id: string | null = null
  if (externalId) {
    const { data } = await db
      .from('crm_source_link')
      .select('entity_id')
      .eq('workspace_id', batch.workspace_id)
      .eq('source', batch.source)
      .eq('kind', 'company')
      .eq('external_id', linkKey(ctx, externalId))
      .maybeSingle()
    id = (data as { entity_id?: string } | null)?.entity_id ?? null
    if (!id && batch.source === 'hubspot') {
      const { data: synced } = await db
        .from('company')
        .select('id')
        .eq('workspace_id', batch.workspace_id)
        .eq('source_provider', 'hubspot')
        .eq('provider_company_id', externalId)
        .maybeSingle()
      id = (synced as { id?: string } | null)?.id ?? null
    }
  }
  if (!id && domain) {
    const { data } = await db.from('company').select('id').eq('workspace_id', batch.workspace_id).eq('domain', domain).maybeSingle()
    id = (data as { id?: string } | null)?.id ?? null
  }
  if (!id && name) {
    const { data } = await db.from('company').select('id').eq('workspace_id', batch.workspace_id).ilike('name', escapeLike(name)).limit(1).maybeSingle()
    id = (data as { id?: string } | null)?.id ?? null
  }
  if (id) return found(id)
  // A contact's company is created only when it is named; a domain alone is the autolink trigger's job.
  const own = 'kind' in ref && ref.kind === 'company' ? (ref as ImportCompanyRecord) : null
  if (!name && !own) return found(null)
  const record: ImportCompanyRecord = own ?? { kind: 'company', name, domain, externalId }
  const { data: inserted, error } = await db.from('company').insert(companyInsert(batch.workspace_id, { ...record, domain }, batch.source)).select('id').maybeSingle()
  if (error || !inserted) {
    // Another writer took the domain first: use theirs.
    if (isUniqueViolation(error) && domain) {
      const { data } = await db.from('company').select('id').eq('workspace_id', batch.workspace_id).eq('domain', domain).maybeSingle()
      return found((data as { id?: string } | null)?.id ?? null)
    }
    return found(null)
  }
  const createdId = (inserted as { id: string }).id
  // Whoever points at it this instant was adopted by the domain trigger: nothing of the import's does yet.
  const { data: adoptedRows } = domain ? await db.from('contact').select('id').eq('workspace_id', batch.workspace_id).eq('company_id', createdId) : { data: [] }
  const adopted = ((adoptedRows as Array<{ id: string }> | null) ?? []).map((r) => r.id)
  ctx.companyCache.set(key, { id: createdId, created: false, adopted: [] })
  return { id: createdId, created: true, adopted }
}

/** The timeline line for a past job: "Hand wash, 8x10 Persian · $480.00". */
export function pastJobLine(job: ImportPastJob): { title: string; summary: string | null } {
  const amount = job.amountCents !== null ? `${(job.currency ?? 'usd') === 'usd' ? '$' : `${(job.currency ?? '').toUpperCase()} `}${(job.amountCents / 100).toFixed(2)}` : null
  return { title: job.title, summary: amount ? `${job.kind === 'invoice' ? 'Invoice' : 'Job'} · ${amount}` : null }
}

/** What makes two past jobs the same: title, day (or undated) and amount. */
function jobKey(title: string | null, dated: boolean, occurredAt: string | null, amountCents: number | null): string {
  return `${title ?? ''}|${dated && occurredAt ? new Date(occurredAt).toISOString().slice(0, 10) : 'undated'}|${amountCents ?? ''}`
}

/** Add the record's past jobs to the contact's timeline, skipping ones already there. Returns the new rows' ids. */
async function addHistory(ctx: ApplyContext, contactId: string, record: ImportContactRecord, fresh: boolean): Promise<string[]> {
  const jobs = record.history ?? []
  if (jobs.length === 0) return []
  const seen = new Set<string>()
  if (!fresh) {
    const { data } = await ctx.db.from('contact_interaction').select('title, occurred_at, metadata').eq('contact_id', contactId).eq('interaction_type', 'past_job')
    for (const row of (data as Array<{ title: string | null; occurred_at: string | null; metadata: Record<string, unknown> | null }> | null) ?? []) {
      const amount = typeof row.metadata?.amount_cents === 'number' ? row.metadata.amount_cents : null
      seen.add(jobKey(row.title, row.metadata?.dated !== false, row.occurred_at, amount))
    }
  }
  const fallbackAt = record.lastContactAt ?? ctx.batch.created_at
  const rows = jobs
    .map((job) => {
      const key = jobKey(job.title, !!job.occurredAt, job.occurredAt, job.amountCents)
      if (seen.has(key)) return null
      seen.add(key)
      const line = pastJobLine(job)
      return {
        workspace_id: ctx.batch.workspace_id,
        contact_id: contactId,
        interaction_type: 'past_job',
        reference_type: 'import_batch',
        reference_id: ctx.batch.id,
        title: line.title,
        summary: line.summary,
        occurred_at: job.occurredAt ?? fallbackAt,
        metadata: { kind: job.kind, amount_cents: job.amountCents, currency: job.currency, source: ctx.batch.source, dated: !!job.occurredAt },
      }
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
  if (rows.length === 0) return []
  const { data, error } = await ctx.db.from('contact_interaction').insert(rows).select('id')
  if (error) throw new Error(`contact_interaction insert failed: ${error.message}`)
  return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id)
}

/**
 * A source says this person unsubscribed from email: their addresses go on
 * the workspace's outreach suppression list (every sequence send checks it,
 * whatever later happens to the tag). Kept on undo: the opt-out is theirs,
 * not the import's. Already there (23505) is fine.
 */
async function suppressUnsubscribed(ctx: ApplyContext, record: ImportContactRecord): Promise<void> {
  if (!(record.tags ?? []).includes(UNSUBSCRIBED_EMAIL_TAG)) return
  for (const email of record.emails ?? []) {
    const { error } = await ctx.db.from('outreach_suppression').insert({ workspace_id: ctx.batch.workspace_id, email: email.toLowerCase(), reason: 'opted_out', created_by: ctx.batch.user_id })
    if (error && !isUniqueViolation(error)) throw new Error(`outreach_suppression insert failed: ${error.message}`)
  }
}

/** The record's addresses that already belong to another contact (never taken from them). */
function emailsOwnedByOthers(ctx: ApplyContext, record: ImportContactRecord, targetId: string | null): string[] {
  return (record.emails ?? []).filter((e) => {
    const owner = ctx.index.byEmail.get(e)
    return !!owner && owner.id !== targetId
  })
}

/** The columns of a created contact undo compares, to tell whether anyone has changed it since. */
export const INSERT_SNAPSHOT_FIELDS = [
  'full_name', 'first_name', 'last_name', 'email', 'secondary_emails', 'phone', 'address', 'job_title', 'department', 'linkedin_url',
  'avatar_url', 'notes', 'tags', 'relationship_type', 'relationship_strength', 'next_followup_at', 'visibility', 'company_id', 'prospect_list_ids',
] as const

function snapshotOf(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(INSERT_SNAPSHOT_FIELDS.map((f) => [f, row[f] ?? null]))
}

interface ItemResult {
  outcome: ItemOutcome
  contact_id?: string | null
  company_id?: string | null
  candidate_contact_id?: string | null
  match_type?: string | null
  changes?: FieldChanges
  created_company_id?: string | null
  history_ids?: string[]
  links?: SourceLinkRef[]
  error?: string | null
  /** How far an item got before it failed: whether its contact was created or matched (undo reads it). */
  partial?: 'created' | 'matched'
}

/** Patch a matched contact. Returns the changes journaled (empty: nothing changed). */
async function updateMatched(ctx: ApplyContext, contactId: string, record: ImportContactRecord, companyId: string | null): Promise<FieldChanges> {
  const local = await loadLocalContact(ctx.db, ctx.batch.workspace_id, contactId)
  if (!local) throw new Error('matched contact is gone')
  const blocked = new Set<string>(emailsOwnedByOthers(ctx, record, contactId))
  for (let attempt = 0; attempt < 2; attempt++) {
    const { patch, changes } = contactPatch({ local, record, source: ctx.batch.source, companyId, blockedEmails: blocked })
    // HubSpot's own sync finds a contact by its HubSpot id: claim an unclaimed one, as the sync does.
    if (ctx.batch.source === 'hubspot' && record.externalId && !local.source_provider && !local.provider_contact_id) {
      patch.source_provider = 'hubspot'
      patch.provider_contact_id = record.externalId
      changes.source_provider = { before: null, after: 'hubspot' }
      changes.provider_contact_id = { before: null, after: record.externalId }
    }
    if (Object.keys(patch).length === 0) return {}
    // An email filled on a contact no source owns would make it the HubSpot push
    // sweep's: hold it, so an import never writes out. A person's edit lifts it.
    if (typeof patch.email === 'string' && !local.source_provider && !patch.source_provider) {
      patch.metadata = { ...((patch.metadata as Record<string, unknown> | undefined) ?? local.metadata ?? {}), [HUBSPOT_PUSH_HOLD_KEY]: hubspotPushHold() }
    }
    // The provenance travels in metadata; journal it too, so undo can put it back.
    if (patch.metadata) changes.metadata_imported = { before: provenanceOf(local.metadata, ctx.batch.source), after: provenanceOf(patch.metadata as Record<string, unknown>, ctx.batch.source) }
    const { error } = await ctx.db.from('contact').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', contactId).eq('workspace_id', ctx.batch.workspace_id)
    if (!error) {
      const next = dedupShape({ ...local, ...patch, id: contactId })
      ctx.visible.set(contactId, next)
      addToContactMatchIndex(ctx.index, next)
      return changes
    }
    // Its email belongs to another contact: take everything else.
    if (isUniqueViolation(error) && typeof patch.email === 'string') {
      blocked.add(patch.email)
      continue
    }
    throw new Error(`contact update failed: ${error.message}`)
  }
  return {}
}

/** Fold the company a contact item created (and whom it adopted) into the item's journal. */
function withCompany(progress: ItemResult, company: CompanyResolution): void {
  if (!company.created) return
  progress.created_company_id = company.id
  if (company.adopted.length) progress.changes = { ...(progress.changes ?? {}), adopted_contact_ids: { before: null, after: company.adopted } }
}

async function applyContactItem(ctx: ApplyContext, item: ImportItem, progress: ItemResult, orphanId: string | null): Promise<ItemResult> {
  const record = item.record as ImportContactRecord
  const { batch } = ctx
  await suppressUnsubscribed(ctx, record)
  const company = record.company ? await resolveCompany(ctx, record.company) : { id: null, created: false, adopted: [] }
  if (company.created) ctx.counts.companiesCreated++
  withCompany(progress, company)
  progress.company_id = company.id

  // 0. A retry after a crash: the contact this item already inserted.
  if (orphanId) {
    progress.contact_id = orphanId
    progress.partial = 'created'
    ctx.createdByBatch.add(orphanId)
    const { data: row } = await ctx.db.from('contact').select('*').eq('id', orphanId).maybeSingle()
    progress.changes = { ...(progress.changes ?? {}), inserted: { before: null, after: snapshotOf((row as Record<string, unknown>) ?? {}) } }
    progress.history_ids = await addHistory(ctx, orphanId, record, false)
    const link = await linkSource(ctx, 'contact', record.externalId, orphanId)
    return { ...progress, outcome: 'created', links: link ? [link] : [] }
  }

  // 1. The source's own id, from an earlier import of the same source: a
  //    contact the user can see, whose name doesn't say it's someone else.
  let target: { id: string; matchType: string } | null = null
  if (record.externalId) {
    const linked = await linkedContactId(ctx, record.externalId)
    const known = linked ? ctx.visible.get(linked) : undefined
    if (linked && known && namesCompatible(toDedupContact(record), known)) target = { id: linked, matchType: 'link' }
  }
  // 2. The merge engine's evidence.
  const decision = target ? null : matchContact(ctx.index, record)
  if (decision?.kind === 'same') target = { id: decision.contactId, matchType: decision.match.matchType }
  // The same name again in one file, with nothing to tell them apart: a repeat row (an invoice per row).
  if (
    decision?.kind === 'check' &&
    decision.match.matchType === 'suggest:name' &&
    ctx.createdByBatch.has(decision.candidateId) &&
    !(record.emails ?? []).length &&
    !(record.phones ?? []).length
  ) {
    target = { id: decision.candidateId, matchType: 'repeat:name' }
  }

  const matched = async (id: string, matchType: string, forceOutcome?: ItemOutcome): Promise<ItemResult> => {
    progress.contact_id = id
    progress.match_type = matchType
    progress.partial = 'matched'
    const changes = await updateMatched(ctx, id, record, company.id)
    progress.changes = { ...(progress.changes ?? {}), ...changes }
    progress.history_ids = await addHistory(ctx, id, record, false)
    const link = await linkSource(ctx, 'contact', record.externalId, id)
    const repeat = ctx.createdByBatch.has(id)
    const changed = Object.keys(changes).some((k) => k !== 'metadata_imported') || progress.history_ids.length > 0
    return { ...progress, outcome: forceOutcome ?? (repeat ? 'repeat' : changed ? 'matched' : 'unchanged'), links: link ? [link] : [] }
  }
  if (target) return matched(target.id, target.matchType)

  // 3. A new contact; one that may be someone already here is flagged to check.
  //    Never with an address another contact has.
  const check = decision?.kind === 'check' ? decision : null
  const drop = new Set([...(check?.dropEmails ?? []), ...emailsOwnedByOthers(ctx, record, null)])
  const insertRow = (dropEmails: Set<string>) =>
    contactInsert({ workspaceId: batch.workspace_id, record, source: batch.source, companyId: company.id, createdByMemberId: ctx.memberId, dropEmails: [...dropEmails], stamp: { batchId: batch.id, itemId: item.id } })
  let insert = insertRow(drop)
  let hidden = false
  let { data, error } = await ctx.db.from('contact').insert(insert).select('*').maybeSingle()
  if ((error || !data) && isUniqueViolation(error) && typeof insert.email === 'string') {
    const { data: existing } = await ctx.db.from('contact').select('id').eq('workspace_id', batch.workspace_id).eq('email', insert.email).maybeSingle()
    const id = (existing as { id?: string } | null)?.id
    // Another writer created this address a moment ago: the same person, when the user can see them.
    if (id && ctx.visible.has(id)) return matched(id, 'auto:alias', 'matched')
    // Someone the user can't see has it: a contact of their own, without it, to check.
    if (id && (await isContactVisibleTo(ctx.db, id, batch.user_id))) return matched(id, 'auto:alias', 'matched')
    drop.add(insert.email)
    hidden = true
    insert = insertRow(drop)
    ;({ data, error } = await ctx.db.from('contact').insert(insert).select('*').maybeSingle())
  }
  if (error || !data) throw new Error(`contact insert failed: ${error?.message ?? 'no row'}`)
  const row = data as Record<string, unknown>
  const id = String(row.id)
  progress.contact_id = id
  progress.partial = 'created'
  progress.changes = { ...(progress.changes ?? {}), inserted: { before: null, after: snapshotOf(row) } }
  ctx.createdByBatch.add(id)
  const shape = dedupShape(row)
  ctx.visible.set(id, shape)
  addToContactMatchIndex(ctx.index, shape)
  progress.history_ids = await addHistory(ctx, id, record, true)
  const link = await linkSource(ctx, 'contact', record.externalId, id)
  return {
    ...progress,
    outcome: check || hidden ? 'review' : 'created',
    candidate_contact_id: check?.candidateId ?? null,
    match_type: check?.match.matchType ?? (hidden ? 'hidden:email' : null),
    links: link ? [link] : [],
  }
}

async function applyCompanyItem(ctx: ApplyContext, item: ImportItem, progress: ItemResult): Promise<ItemResult> {
  const record = item.record as ImportCompanyRecord
  const resolved = await resolveCompany(ctx, record)
  if (!resolved.id) return { outcome: 'failed', error: 'company could not be saved' }
  progress.company_id = resolved.id
  if (resolved.created) {
    ctx.counts.companiesCreated++
    withCompany(progress, resolved)
    const link = await linkSource(ctx, 'company', record.externalId, resolved.id)
    return { ...progress, outcome: 'created', links: link ? [link] : [] }
  }
  ctx.counts.companiesMatched++
  const { data: local } = await ctx.db.from('company').select('*').eq('id', resolved.id).eq('workspace_id', ctx.batch.workspace_id).maybeSingle()
  const { patch, changes } = local ? companyPatch(local as Record<string, unknown>, record, ctx.batch.source) : { patch: {}, changes: {} }
  if (Object.keys(patch).length) {
    progress.changes = changes
    const { error } = await ctx.db.from('company').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', resolved.id)
    if (error) throw new Error(`company update failed: ${error.message}`)
  }
  const link = await linkSource(ctx, 'company', record.externalId, resolved.id)
  return { ...progress, outcome: Object.keys(patch).length ? 'matched' : 'unchanged', changes, links: link ? [link] : [] }
}

/**
 * Apply up to `limit` of the batch's pending items, in order. Returns how
 * many were applied and whether any are left. An item that fails is marked
 * 'failed' with its error and whatever it had already written (undo reads
 * that); the rest go on. A retry after a crash finds the contact an item
 * inserted before it could be marked (its metadata names the item).
 */
export async function applyPendingItems(db: Db, batchId: string, opts: { limit?: number } = {}): Promise<{ applied: number; remaining: boolean; counts: ImportCounts }> {
  const batch = await loadImportBatch(db, batchId)
  if (!batch || (batch.status !== 'staging' && batch.status !== 'running')) return { applied: 0, remaining: false, counts: batch?.counts ?? emptyCounts() }
  if (batch.status === 'staging') {
    await db.from('contact_import_batch').update({ status: 'running' }).eq('id', batch.id)
    batch.status = 'running'
  }
  const limit = opts.limit ?? APPLY_CHUNK
  const { data: pending, error } = await db
    .from('contact_import_item')
    .select(ITEM_COLUMNS)
    .eq('batch_id', batch.id)
    .eq('outcome', 'pending')
    .order('seq', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`contact_import_item read failed: ${error.message}`)
  const items = (pending as unknown as ImportItem[] | null) ?? []
  if (items.length === 0) return { applied: 0, remaining: false, counts: batch.counts }

  const { data: memberRow } = await db.from('member').select('id, role').eq('user_id', batch.user_id).eq('workspace_id', batch.workspace_id).maybeSingle()
  const member = (memberRow as { id: string; role: string | null } | null) ?? null
  const contacts = await loadVisibleContacts(db, batch.workspace_id, member)
  const { data: earlier } = await db.from('contact_import_item').select('contact_id').eq('batch_id', batch.id).in('outcome', ['created', 'review'])
  const { data: orphanRows } = await db.from('contact').select('id, metadata').eq('workspace_id', batch.workspace_id).in('metadata->>import_item', items.map((i) => i.id))
  const orphans = new Map(((orphanRows as Array<{ id: string; metadata: Record<string, unknown> | null }> | null) ?? []).map((r) => [String(r.metadata?.import_item), r.id]))
  const ctx: ApplyContext = {
    db,
    batch,
    index: buildContactMatchIndex(contacts),
    visible: new Map(contacts.map((c) => [c.id, c])),
    createdByBatch: new Set(((earlier as Array<{ contact_id: string | null }> | null) ?? []).map((r) => r.contact_id).filter((id): id is string => !!id)),
    companyCache: new Map(),
    memberId: member?.id ?? null,
    counts: emptyCounts(),
  }

  for (const item of items) {
    const progress: ItemResult = { outcome: 'failed' }
    let result: ItemResult
    try {
      result = item.kind === 'company' ? await applyCompanyItem(ctx, item, progress) : await applyContactItem(ctx, item, progress, orphans.get(item.id) ?? null)
    } catch (err) {
      result = { ...progress, outcome: 'failed', error: errText(err), match_type: progress.partial ? `partial:${progress.partial}` : null }
    }
    if (item.kind === 'contact') {
      if (result.outcome in ctx.counts) ctx.counts[result.outcome as keyof ImportCounts]++
      if ((item.record as ImportContactRecord).relationship === 'customer' && result.outcome !== 'failed' && result.outcome !== 'repeat') ctx.counts.customers++
      ctx.counts.history += result.history_ids?.length ?? 0
    } else if (result.outcome === 'failed') {
      ctx.counts.failed++
    }
    const { error: saveError } = await db
      .from('contact_import_item')
      .update({
        outcome: result.outcome,
        contact_id: result.contact_id ?? null,
        company_id: result.company_id ?? null,
        candidate_contact_id: result.candidate_contact_id ?? null,
        match_type: result.match_type ?? null,
        changes: result.changes ?? {},
        created_company_id: result.created_company_id ?? null,
        history_ids: result.history_ids ?? [],
        links: result.links ?? [],
        error: result.error ?? null,
        applied_at: new Date().toISOString(),
      })
      .eq('id', item.id)
    if (saveError) throw new Error(`contact_import_item update failed: ${saveError.message}`)
  }
  const counts = await saveCounts(db, batch, ctx.counts)
  return { applied: items.length, remaining: items.length === limit, counts }
}

/** Mark a batch failed (a source could not be read). */
export async function failImportBatch(db: Db, batchId: string, error: string): Promise<void> {
  await db.from('contact_import_batch').update({ status: 'failed', error: error.slice(0, 1000), finished_at: new Date().toISOString() }).eq('id', batchId)
}

/** Items to check: new contacts that may be someone already here, with who. */
export async function reviewItems(db: Db, batchId: string, limit = 20): Promise<Array<{ contact_id: string | null; candidate_contact_id: string | null; match_type: string | null }>> {
  const { data } = await db.from('contact_import_item').select('contact_id, candidate_contact_id, match_type').eq('batch_id', batchId).eq('outcome', 'review').order('seq', { ascending: true }).limit(limit)
  return (data as Array<{ contact_id: string | null; candidate_contact_id: string | null; match_type: string | null }> | null) ?? []
}

export { ITEM_COLUMNS, BATCH_COLUMNS }
