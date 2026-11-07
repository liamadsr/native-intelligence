/**
 * Promotion — the only code in Prospecting that writes to the CRM (spec §8).
 *
 * `lists.ts` owns the orchestration (which entries, in what order, with what
 * per-entry outcome); this module owns the two PERSON paths and the shared
 * blob-merge discipline, because both are subtle enough to deserve their own
 * tests and neither belongs in a function whose job is a loop.
 *
 * The load-bearing fact: `findOrCreateContact` (`src/lib/crm/contacts.ts`)
 * CANNOT create most discovered people.
 *
 *   1. It hard-returns `null` when the email lacks '@' — a deliberate guard
 *      against calendar sync writing display labels like "Sarah Hale (ext)"
 *      into `contact.email`. That guard must not be weakened: it protects
 *      every other creation path in the product.
 *   2. It then runs `shouldAutoCreateContact`, whose noise filter rejects
 *      plenty of legitimately discovered names.
 *
 * Most people discovery finds have a LinkedIn URL and no email at all, so the
 * emailless path is a SEPARATE, explicit function — {@link createProspectContact}
 * — rather than a relaxation of the shared one. It dedupes on the normalized
 * LinkedIn profile URL by QUERY, never by a new unique index: existing
 * workspaces already hold duplicate `linkedin_url` values and a
 * `CREATE UNIQUE INDEX` would fail on a real database.
 *
 * Everything here runs on whatever Supabase client the caller holds and every
 * query carries an explicit `workspace_id` filter — RLS is never trusted
 * alone, exactly as in `lists.ts`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { columnCandidates, mergeBlobFields } from '@/lib/crm/enrichment'
// `computeFillEmptyPatch` lives in hubspot-sync and is imported into
// enrichment.ts rather than re-exported from it, so promotion imports it from
// the same source enrichment does — one implementation, no re-export chain.
import { computeFillEmptyPatch } from '@/lib/crm/hubspot-sync'
import { normalizeLinkedInProfileUrl } from '@/lib/exa/deep-search'
import { findOrCreateContact } from '@/lib/crm/contacts'
import type { ProspectCandidate, ProspectListPurpose } from './types'

// ---------------------------------------------------------------------------
// relationship_type (decision 2)
// ---------------------------------------------------------------------------

/**
 * The CRM `relationship_type` a promoted person is written with, keyed by the
 * list's purpose.
 *
 * It is a CRM COLUMN, never per-list state: a person promoted from two lists
 * keeps the FIRST value, because the record is canonical and the entry carries
 * the per-list verdict. Nothing here ever overwrites an existing contact's
 * relationship_type — see {@link promotePerson}.
 *
 * Values are constrained by `contact_relationship_type_check` (widened by
 * migration 266): 'contact' | 'lead' | 'customer' | 'partner' | 'vendor' |
 * 'internal' | 'candidate'. Anything outside that list is a 23514 at runtime,
 * so the `satisfies` below is load-bearing rather than decorative.
 */
export const RELATIONSHIP_TYPE_BY_PURPOSE = {
  buyers: 'lead',
  investors: 'partner',
  partners: 'partner',
  // A `talent` list IS a candidate pipeline — it landed on the generic
  // 'contact' only because the CHECK had no better value until mig 266.
  talent: 'candidate',
  custom: 'contact',
} as const satisfies Record<ProspectListPurpose, 'contact' | 'lead' | 'partner' | 'candidate'>

export type ProspectRelationshipType =
  (typeof RELATIONSHIP_TYPE_BY_PURPOSE)[ProspectListPurpose]

/** The relationship_type for a purpose, degrading to 'contact' for an
 *  unrecognised value rather than writing NULL into a CHECKed column. */
export function relationshipTypeForPurpose(purpose: unknown): ProspectRelationshipType {
  const key = purpose as ProspectListPurpose
  return RELATIONSHIP_TYPE_BY_PURPOSE[key] ?? 'contact'
}

// ---------------------------------------------------------------------------
// createProspectContact — the emailless person
// ---------------------------------------------------------------------------

export interface CreateProspectContactInput {
  workspaceId: string
  /** Display name. Split on the LAST space for first/last. */
  fullName: string
  /** Any form; normalized before comparison and before storage. */
  linkedinUrl?: string | null
  jobTitle?: string | null
  /** The PROMOTED PARENT company. Set explicitly, which also means the
   *  mig-232 autolink trigger is a no-op on this insert (it bails when
   *  `NEW.company_id IS NOT NULL`) — and it would bail anyway, since the
   *  trigger keys off the email domain and this contact has no email. */
  companyId?: string | null
  relationshipType: ProspectRelationshipType
  /**
   * The `member.id` of the saving user. LOAD-BEARING, not decorative: 058's
   * `contact_select_visibility` policy runs `can_view_contact(...)`, and with
   * the column default (`'private'` since 058) a row whose
   * `created_by_member_id` is NULL is invisible to every non-admin member —
   * including the person who just saved it. The insert's `RETURNING` would come
   * back empty through the RLS client and promotion would report `error`.
   */
  createdByMemberId?: string | null
}

export type CreateProspectContactResult =
  | { ok: true; contactId: string; created: boolean }
  | { ok: false; reason: 'no_identity' | 'error'; message?: string }

/**
 * Create (or find) a CRM contact for a discovered person who has NO email.
 *
 * Dedup is a QUERY on the normalized `linkedin_url` within the workspace,
 * restricted to `merged_into_contact_id IS NULL` so a merge tombstone can
 * never be resurrected as a "match". Deliberately not a unique index — see the
 * module header.
 *
 * `UNIQUE (workspace_id, email)` treats NULLs as distinct in Postgres, so N
 * emailless prospecting contacts coexist happily. That is exactly why the
 * durable person identity lives in the entry's `candidate_key` and not in
 * `contact.email`.
 *
 * A person with neither a LinkedIn URL nor a usable name has no identity we
 * could ever dedupe on, and is refused rather than inserted as an
 * un-mergeable orphan.
 */
export async function createProspectContact(
  supabase: SupabaseClient,
  input: CreateProspectContactInput,
): Promise<CreateProspectContactResult> {
  const fullName = input.fullName?.trim() ?? ''
  const linkedinUrl = normalizeLinkedInProfileUrl(input.linkedinUrl)

  // No LinkedIn URL and no name is not a person, it is a gap in the response.
  if (!linkedinUrl && !fullName) return { ok: false, reason: 'no_identity' }

  if (linkedinUrl) {
    const match = await findByLinkedIn(supabase, input.workspaceId, linkedinUrl)
    if (!match.ok) return { ok: false, reason: 'error', message: match.message }
    if (match.contactId) return { ok: true, contactId: match.contactId, created: false }
  }

  // Split on the LAST space: "Ada Byron King" is first "Ada", last
  // "Byron King" only if we split on the FIRST — and the surname is the half
  // that must stay intact for sorting and matching, so the last token wins.
  const { firstName, lastName } = splitName(fullName)

  const { data: created, error: insertError } = await supabase
    .from('contact')
    .insert({
      workspace_id: input.workspaceId,
      // Explicitly NULL, not omitted: the column is nullable and this is the
      // whole point of the function. An invented address here would cost a
      // real person a cold email.
      email: null,
      full_name: fullName || linkedinUrl || 'Unknown',
      first_name: firstName,
      last_name: lastName,
      job_title: input.jobTitle?.trim() || null,
      linkedin_url: linkedinUrl,
      company_id: input.companyId ?? null,
      source: 'prospecting',
      relationship_type: input.relationshipType,
      // 058 made 'private' the column default and gated SELECT/UPDATE on
      // `can_view_contact`/`can_edit_contact`. A prospecting save is a shared
      // account list, so 'workspace' matches what `findOrCreateContact` writes
      // and keeps the row visible to the team rather than to one member.
      visibility: 'workspace',
      // Ownership. Without it the row has no creator and, under a stricter
      // visibility, nobody at all could read it back.
      created_by_member_id: input.createdByMemberId ?? null,
    })
    .select('id')
    .single()

  if (insertError || !created) {
    console.error('[prospecting] prospect contact insert failed:', insertError?.message)
    return { ok: false, reason: 'error', message: insertError?.message }
  }
  return { ok: true, contactId: (created as { id: string }).id, created: true }
}

/**
 * Find an existing contact by LinkedIn profile, tolerating BOTH shapes the
 * column holds in practice.
 *
 * `normalizeLinkedInProfileUrl` produces the bare `linkedin.com/in/<slug>`
 * form, but every OTHER writer of this column stores whatever the source gave
 * it — `enrichContact` (`enrichment.ts`) writes Exa's value verbatim through
 * `columnCandidates`/`computeFillEmptyPatch`, which is typically
 * `https://www.linkedin.com/in/<slug>`. An exact-equality probe against the
 * normalized form therefore MISSES every already-enriched contact and inserts
 * a duplicate.
 *
 * So: exact match first (the cheap, index-friendly path for rows this function
 * itself wrote), then a slug `ilike` for the raw shapes. The slug is the
 * identity; the prefix is decoration.
 */
async function findByLinkedIn(
  supabase: SupabaseClient,
  workspaceId: string,
  linkedinUrl: string,
): Promise<{ ok: true; contactId: string | null } | { ok: false; message?: string }> {
  const exact = await supabase
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .eq('linkedin_url', linkedinUrl)
    .limit(1)
    .maybeSingle()
  if (exact.error) {
    console.error('[prospecting] linkedin dedup read failed:', exact.error.message)
    return { ok: false, message: exact.error.message }
  }
  if (exact.data) return { ok: true, contactId: (exact.data as { id: string }).id }

  // `%<slug>` rather than `%<slug>%`: the slug is the TAIL of the URL, and an
  // unanchored match would let `/in/ada` collide with `/in/adam`.
  const slug = linkedinUrl.split('/in/')[1]?.replace(/\/+$/, '') ?? ''
  // A slug with a wildcard metacharacter would widen the pattern; such a value
  // is not a real profile slug, so the exact probe above is the whole answer.
  if (!slug || /[%_,()"\\]/.test(slug)) return { ok: true, contactId: null }

  const loose = await supabase
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .ilike('linkedin_url', `%/in/${slug}`)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (loose.error) {
    console.error('[prospecting] linkedin slug dedup read failed:', loose.error.message)
    return { ok: false, message: loose.error.message }
  }
  return { ok: true, contactId: loose.data ? (loose.data as { id: string }).id : null }
}

/** First name is the first token; last name is EVERYTHING after the last
 *  space, so a multi-token surname survives intact. A single-token name has no
 *  last name rather than a duplicated one. */
export function splitName(fullName: string): {
  firstName: string | null
  lastName: string | null
} {
  const cleaned = fullName.trim().replace(/\s+/g, ' ')
  if (!cleaned) return { firstName: null, lastName: null }
  const cut = cleaned.lastIndexOf(' ')
  if (cut === -1) return { firstName: cleaned, lastName: null }
  return { firstName: cleaned.slice(0, cut), lastName: cleaned.slice(cut + 1) }
}

// ---------------------------------------------------------------------------
// promotePerson — the path chooser
// ---------------------------------------------------------------------------

export interface PromotePersonInput {
  workspaceId: string
  candidate: ProspectCandidate
  /** The promoted PARENT company id, or null when the person has no parent
   *  entry (hand-added, or an orphan). */
  companyId: string | null
  purpose: ProspectListPurpose
  /** The saving user's `member.id` — see {@link CreateProspectContactInput}. */
  createdByMemberId?: string | null
}

export type PromotePersonResult =
  | { ok: true; contactId: string; email: string | null }
  | { ok: false; reason: 'no_identity' | 'error'; message?: string }

/**
 * Promote one discovered PERSON to a CRM contact.
 *
 * With an email → `findOrCreateContact`, which inherits the secondary-email
 * OR-filter and the merge-tombstone exclusion, so a person reached at an
 * address that was folded into another contact attaches to the SURVIVOR rather
 * than spawning a duplicate. It refuses some names by design (the noise
 * filter); a refusal is reported as `no_identity`, not swallowed.
 *
 * Without an email → {@link createProspectContact}.
 *
 * EITHER WAY, an existing contact keeps its own `relationship_type`. Only a
 * freshly created row gets the purpose-derived value — a person already marked
 * 'customer' must not be demoted to 'lead' because they turned up in a
 * prospecting list.
 */
export async function promotePerson(
  supabase: SupabaseClient,
  input: PromotePersonInput,
): Promise<PromotePersonResult> {
  const { candidate } = input
  const email = typeof candidate.email === 'string' ? candidate.email.trim().toLowerCase() : ''
  const fullName = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  const jobTitle = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  const relationshipType = relationshipTypeForPurpose(input.purpose)

  if (email && email.includes('@')) {
    // `findOrCreateContact` holds the service client itself and takes no
    // supabase argument — that is its existing signature and not something
    // promotion should reshape. It also takes no relationship_type, so the
    // value is applied afterwards, and ONLY to a row this call created.
    const before = await findExistingByEmail(supabase, input.workspaceId, email)
    const contact = await findOrCreateContact(input.workspaceId, {
      email,
      fullName,
      jobTitle: jobTitle || undefined,
      companyName: candidate.company_name ?? undefined,
      source: 'prospecting',
      // Same 058 reasoning as the emailless path: a row this call creates must
      // be owned by, and visible to, the person who saved it.
      created_by_member_id: input.createdByMemberId ?? null,
      visibility: 'workspace',
    })
    if (!contact) return { ok: false, reason: 'no_identity' }
    if (!before) {
      // Newly created by that call: stamp the fields it has no argument for.
      // `company_id` is only set when the row has none — the autolink trigger
      // or the email-domain company may already have claimed it, and the
      // parent account is a weaker signal than either.
      await stampNewContact(supabase, {
        workspaceId: input.workspaceId,
        contactId: contact.id,
        relationshipType,
        linkedinUrl: normalizeLinkedInProfileUrl(candidate.linkedin_url),
        companyId: input.companyId,
      })
    }
    return { ok: true, contactId: contact.id, email }
  }

  const created = await createProspectContact(supabase, {
    workspaceId: input.workspaceId,
    fullName,
    linkedinUrl: candidate.linkedin_url,
    jobTitle: jobTitle || null,
    companyId: input.companyId,
    relationshipType,
    createdByMemberId: input.createdByMemberId ?? null,
  })
  if (!created.ok) return created
  return { ok: true, contactId: created.contactId, email: null }
}

/** Did a contact with this address already exist? Mirrors
 *  `findOrCreateContact`'s own lookup (primary OR secondary, never a
 *  tombstone) so "did that call create the row?" is answered honestly rather
 *  than guessed from a timestamp.
 *
 *  The address comes from an Exa/LLM candidate blob, i.e. untrusted text, and
 *  PostgREST's `.or()` argument is FILTER GRAMMAR, not a bound parameter: `,`
 *  and `)` are its delimiters, so `a@b.com,id.gt.0` would widen the probe to an
 *  unrelated row and make this report "already existed", silently skipping the
 *  stamp on a genuinely new contact. A value carrying grammar characters is not
 *  an email, so it is refused before it can reach the string. */
async function findExistingByEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  if (/[,()"\\]/.test(email)) {
    console.warn('[prospecting] refusing filter metacharacters in candidate email')
    // Conservative direction, as below: assume it existed rather than stamp a
    // row we cannot honestly identify.
    return true
  }
  const { data, error } = await supabase
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .or(`email.eq.${email},secondary_emails.cs.{"${email}"}`)
    .limit(1)
    .maybeSingle()
  if (error) {
    // A failed read makes us assume the contact EXISTED — the conservative
    // direction, because the only consequence is not stamping fields on a row
    // that might be new, versus overwriting a real person's relationship_type.
    console.error('[prospecting] pre-create contact read failed:', error.message)
    return true
  }
  return Boolean(data)
}

/** Apply the fields `findOrCreateContact` has no argument for, to a row it
 *  just created. Fill-empty on every column: this runs only for a new row, but
 *  a concurrent enrichment could still have populated one. */
async function stampNewContact(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    contactId: string
    relationshipType: ProspectRelationshipType
    linkedinUrl: string | null
    companyId: string | null
  },
): Promise<void> {
  const { data, error } = await supabase
    .from('contact')
    .select('id, linkedin_url, company_id')
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error || !data) return
  const row = data as { linkedin_url: string | null; company_id: string | null }

  const patch: Record<string, unknown> = { relationship_type: args.relationshipType }
  if (args.linkedinUrl && !row.linkedin_url) patch.linkedin_url = args.linkedinUrl
  if (args.companyId && !row.company_id) patch.company_id = args.companyId

  const { error: writeError } = await supabase
    .from('contact')
    .update(patch)
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
  if (writeError) {
    console.error('[prospecting] contact stamp failed:', writeError.message)
  }
}

// ---------------------------------------------------------------------------
// mergeResearchIntoContact — the same discipline as the company path
// ---------------------------------------------------------------------------

/** The contact columns a person's research blob can fill. The same set
 *  `enrichContact` writes, minus `full_name` (which the create path already
 *  set from the candidate and must not fight over). */
const PROMOTABLE_CONTACT_COLUMNS = {
  job_title: 'job_title',
  department: 'department',
  linkedin_url: 'linkedin_url',
} as const

/**
 * Fold an entry's pre-save `research` into the promoted contact row, with the
 * SAME discipline the company path uses and nothing new:
 *
 *   * `columnCandidates` — the high/medium gate. A demoted (low-confidence)
 *     field never reaches a column.
 *   * `computeFillEmptyPatch` — a populated column is never overwritten.
 *   * `mergeBlobFields` — additive and confidence-ranked, so a CRM-verified
 *     fact can never be displaced by a lower-confidence prospecting guess.
 *
 * Also stamps `metadata.prospecting = {list_id, entry_id, first_seen_at}`.
 * `first_seen_at` means the FIRST time, so an existing stamp is left alone.
 *
 * Returns false only on a WRITE failure. A person with no research at all
 * still succeeds — the stamp is worth writing on its own.
 */
export async function mergeResearchIntoContact(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    contactId: string
    research: unknown
    sources: unknown
    listId: string
    entryId: string
  },
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('contact')
    .select('id, job_title, department, linkedin_url, metadata')
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error || !row) {
    console.error('[prospecting] promote contact load failed:', error?.message)
    return false
  }
  const contact = row as unknown as Record<string, unknown>

  const research = readResearchFields(args.research)
  const now = new Date().toISOString()

  // ── columns ────────────────────────────────────────────────────────
  const gated = columnCandidates(
    Object.fromEntries(
      Object.entries(PROMOTABLE_CONTACT_COLUMNS).map(([field, column]) => [
        column,
        research[field] as never,
      ]),
    ),
  )
  const local: Record<string, unknown> = {}
  for (const column of Object.values(PROMOTABLE_CONTACT_COLUMNS)) local[column] = contact[column]
  const patch = computeFillEmptyPatch(local, gated)

  // ── blob + stamp ───────────────────────────────────────────────────
  const metadata = mergeProspectingMetadata({
    existing: contact.metadata,
    research,
    sources: args.sources,
    stamp: { list_id: args.listId, entry_id: args.entryId },
    now,
  })

  const { error: writeError } = await supabase
    .from('contact')
    .update({ ...patch, metadata, updated_at: now })
    .eq('id', args.contactId)
    .eq('workspace_id', args.workspaceId)
  if (writeError) {
    console.error('[prospecting] promote contact write failed:', writeError.message)
    return false
  }
  return true
}

/**
 * Build the `metadata` value for a promoted record: the additive
 * `enrichment.fields` merge, the deduped `enrichment.sources` list, and the
 * `prospecting` stamp — with every sibling key preserved
 * (`company_autolinked`, `hubspot_push_error`, …).
 *
 * Shared by the company and person paths so the two can never drift; the
 * company path passes `{list_id, run_id}` as its stamp and the person path
 * `{list_id, entry_id}`, which is the only difference between them.
 */
export function mergeProspectingMetadata(args: {
  existing: unknown
  research: Record<string, { value?: unknown; confidence?: unknown }>
  sources: unknown
  stamp: Record<string, unknown>
  now: string
}): Record<string, unknown> {
  const base =
    args.existing && typeof args.existing === 'object' && !Array.isArray(args.existing)
      ? { ...(args.existing as Record<string, unknown>) }
      : {}
  const enrichment =
    base.enrichment && typeof base.enrichment === 'object' && !Array.isArray(base.enrichment)
      ? { ...(base.enrichment as Record<string, unknown>) }
      : {}
  const previousFields =
    enrichment.fields && typeof enrichment.fields === 'object' && !Array.isArray(enrichment.fields)
      ? (enrichment.fields as Record<string, Record<string, unknown>>)
      : {}

  if (Object.keys(args.research).length > 0) {
    enrichment.fields = mergeBlobFields(
      previousFields,
      args.research as Record<string, unknown>,
      args.now,
    )
    if (Array.isArray(args.sources)) {
      const seen = new Set<string>()
      const merged: unknown[] = []
      const previousSources = Array.isArray(enrichment.sources) ? enrichment.sources : []
      for (const s of [...args.sources, ...previousSources]) {
        const url = (s as { url?: unknown } | null)?.url
        if (typeof url !== 'string' || seen.has(url)) continue
        seen.add(url)
        merged.push(s)
        if (merged.length >= 40) break
      }
      enrichment.sources = merged
    }
    base.enrichment = enrichment
  }

  // `first_seen_at` means the FIRST time, so an existing stamp is left alone;
  // only the list/entry of the first promotion is recorded.
  const existingStamp =
    base.prospecting && typeof base.prospecting === 'object' && !Array.isArray(base.prospecting)
      ? base.prospecting
      : null
  if (!existingStamp) {
    base.prospecting = { ...args.stamp, first_seen_at: args.now }
  }

  return base
}

/** The `research` blob has the SAME shape as `metadata.enrichment.fields`,
 *  which is what lets promotion reuse the whole write-back discipline. */
export function readResearchFields(
  raw: unknown,
): Record<string, { value?: unknown; confidence?: unknown }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, { value?: unknown; confidence?: unknown }> = {}
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    out[key] = entry as { value?: unknown; confidence?: unknown }
  }
  return out
}
