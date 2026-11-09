/**
 * HubSpot → Native Intelligence CRM mapping + upsert engine.
 *
 * Curated CRM data from a connected HubSpot portal is imported into Native Intelligence's
 * existing `company` / `contact` tables, ENRICHING what's already there rather
 * than clobbering it. All the decision logic (bucketing numeric ranges, the
 * fill-empty merge, which match wins, archived skip) is expressed as PURE
 * functions so it's directly unit-testable; the DB I/O wrappers below just
 * apply those decisions via getServiceClient().
 *
 * HubSpot rows deliberately BYPASS the contact-noise-filter — unlike email/
 * calendar auto-creation, this is data a human curated in a CRM, so we import
 * every contact (see 'hubspot_sync' provenance) without shouldAutoCreateContact.
 *
 * v1 scope: creates + enrichment only. HubSpot deletions/archival are NOT
 * propagated (archived records are skipped as no-ops) — deletion propagation
 * is a future concern.
 */
import { getServiceClient } from '@/lib/admin'
import type { HubspotObject } from '@/lib/integrations/hubspot-api'

// ---------------------------------------------------------------------------
// Provenance constants (Fixed contracts — see design brief §"Fixed contracts")
// ---------------------------------------------------------------------------

export const HUBSPOT_SOURCE_PROVIDER = 'hubspot'
export const HUBSPOT_CONTACT_SOURCE = 'hubspot_sync'

/**
 * `contact.metadata` key carrying a PERMANENT contact-push failure marker,
 * written by hubspot-push-contact when HubSpot answers 401 (the token predates
 * crm.objects.contacts.write). Shape: `{ code: 'unauthorized', at: <ISO> }`.
 *
 * Such a contact keeps `source_provider = NULL`, so without this marker it stays
 * eligible for every future sweep and gets re-pushed — and re-401'd — forever.
 * The retroactive sweep therefore EXCLUDES marked contacts on its routine
 * (cron) fires and INCLUDES them only when explicitly asked to retry
 * (`includeFailed`, sent by the settings PATCH after a reconnect/scope change).
 * hubspot-push-contact clears the marker on any successful push or claim.
 */
export const HUBSPOT_PUSH_ERROR_KEY = 'hubspot_push_error'
/**
 * The push HOLD marker an UNATTENDED create stamps (Sequence step 2, plan A.1) —
 * see ./hubspot-push-hold.ts. Re-exported here so the two markers read together.
 */
export { HUBSPOT_PUSH_HOLD_KEY } from './hubspot-push-hold'

// Personal-domain set mirrors contacts.ts — a personal email domain (gmail etc.)
// must never become a company via domain-claim.
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'live.com', 'me.com', 'mail.com',
  'ymail.com', 'msn.com', 'zoho.com', 'fastmail.com',
])

// ---------------------------------------------------------------------------
// Pure: numeric → text-range bucketing
// ---------------------------------------------------------------------------

/**
 * Bucket a raw HubSpot `numberofemployees` value into the existing
 * company.employee_count_range text column. Returns null for absent/invalid
 * input so we never overwrite with a bogus range.
 */
export function bucketEmployeeCount(raw: string | number | null | undefined): string | null {
  const n = toFiniteNumber(raw)
  if (n === null || n <= 0) return null
  if (n <= 10) return '1-10'
  if (n <= 50) return '11-50'
  if (n <= 200) return '51-200'
  if (n <= 1000) return '201-1000'
  return '1000+'
}

/**
 * Bucket a raw HubSpot `annualrevenue` value (in whole currency units) into the
 * company.annual_revenue_range text column. Returns null for absent/invalid
 * input.
 */
export function bucketAnnualRevenue(raw: string | number | null | undefined): string | null {
  const n = toFiniteNumber(raw)
  if (n === null || n < 0) return null
  if (n < 1_000_000) return '<$1M'
  if (n < 10_000_000) return '$1M-$10M'
  if (n < 100_000_000) return '$10M-$100M'
  return '$100M+'
}

function toFiniteNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Pure: fill-empty merge
// ---------------------------------------------------------------------------

/**
 * True when a local column value is "empty" and should therefore be filled from
 * HubSpot: null, undefined, or an all-whitespace string. A populated value
 * (including 0 / false, which the CRM never stores in these text columns) is
 * NOT empty and must be preserved.
 */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

/**
 * Compute the fill-empty patch: for each incoming field, include it in the
 * result ONLY when the corresponding local value is empty AND the incoming
 * value is non-empty. Never clobbers a populated local value.
 *
 * `alwaysSync` names fields that DO overwrite when HubSpot's value differs (the
 * company name/domain exception in the brief) — still gated on a non-empty
 * incoming value, and only emitted when it actually changed.
 */
export function computeFillEmptyPatch(
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  alwaysSync: readonly string[] = [],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const always = new Set(alwaysSync)

  for (const [key, incomingVal] of Object.entries(incoming)) {
    if (isEmptyValue(incomingVal)) continue // nothing to contribute
    const localVal = local[key]

    if (always.has(key)) {
      // name/domain: sync from HubSpot when it changed. Compare loosely on the
      // trimmed string form so whitespace-only diffs don't churn.
      if (String(localVal ?? '').trim() !== String(incomingVal).trim()) {
        patch[key] = incomingVal
      }
      continue
    }

    if (isEmptyValue(localVal)) patch[key] = incomingVal
  }

  return patch
}

// ---------------------------------------------------------------------------
// Pure: normalize HubSpot objects → Native Intelligence field shapes
// ---------------------------------------------------------------------------

export interface MappedCompany {
  // Index signature keeps the shape assignable to the Record<string, unknown>
  // the fill-empty merge takes, without losing the named-field documentation.
  [key: string]: string | null
  name: string | null
  domain: string | null
  website: string | null
  industry: string | null
  description: string | null
  employee_count_range: string | null
  annual_revenue_range: string | null
  city: string | null
  state: string | null
  country: string | null
}

/** Map a HubSpot company object → Native Intelligence company field shape (all nullable). */
export function mapCompany(obj: HubspotObject): MappedCompany {
  const p = obj.properties ?? {}
  return {
    name: cleanStr(p.name),
    domain: normalizeDomain(p.domain ?? p.website),
    website: cleanStr(p.website),
    industry: cleanStr(p.industry),
    description: cleanStr(p.description),
    employee_count_range: bucketEmployeeCount(p.numberofemployees),
    annual_revenue_range: bucketAnnualRevenue(p.annualrevenue),
    city: cleanStr(p.city),
    state: cleanStr(p.state),
    country: cleanStr(p.country),
  }
}

export interface MappedContact {
  [key: string]: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  full_name: string | null
  phone: string | null
  job_title: string | null
}

/** Map a HubSpot contact object → Native Intelligence contact field shape. */
export function mapContact(obj: HubspotObject): MappedContact {
  const p = obj.properties ?? {}
  const first = cleanStr(p.firstname)
  const last = cleanStr(p.lastname)
  const email = normalizeEmail(p.email)
  const fullName = [first, last].filter(Boolean).join(' ').trim() || null
  return {
    email,
    first_name: first,
    last_name: last,
    // Fall back to email when there's no name at all so full_name (a NOT NULL
    // column) always has a value on insert.
    full_name: fullName || email,
    phone: cleanStr(p.phone) ?? cleanStr(p.mobilephone),
    job_title: cleanStr(p.jobtitle),
  }
}

/**
 * Recompute a contact's full_name from HubSpot ONLY when the local value is
 * effectively empty — empty string, or equal to the local email (the
 * placeholder findOrCreateContact stores when it has no real name). A
 * human-entered name is preserved.
 */
export function shouldRecomputeFullName(
  localFullName: string | null | undefined,
  localEmail: string | null | undefined,
): boolean {
  if (isEmptyValue(localFullName)) return true
  const fn = String(localFullName).trim().toLowerCase()
  const em = String(localEmail ?? '').trim().toLowerCase()
  return em !== '' && fn === em
}

/**
 * The single company id a contact should associate to, from HubSpot's
 * association expansion. First associated company only (v1). Null when no
 * association data is present (e.g. search-path results, which don't carry
 * associations).
 */
export function firstAssociatedCompanyId(obj: HubspotObject): string | null {
  const results = obj.associations?.companies?.results
  if (!results?.length) return null
  return results[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Pure: match-priority decision (for tests + readability)
// ---------------------------------------------------------------------------

export type MatchKind = 'hubspot_id' | 'domain' | 'email' | 'insert'

/**
 * Decide how a HubSpot COMPANY resolves against local rows. Priority:
 * hubspot-id match > domain match > insert. Pure — takes the boolean outcomes
 * of the two lookups the DB layer performs.
 */
export function decideCompanyMatch(opts: {
  hubspotIdMatch: boolean
  domainMatch: boolean
}): Extract<MatchKind, 'hubspot_id' | 'domain' | 'insert'> {
  if (opts.hubspotIdMatch) return 'hubspot_id'
  if (opts.domainMatch) return 'domain'
  return 'insert'
}

/**
 * Decide how a HubSpot CONTACT resolves against local rows. Priority:
 * hubspot-id match > email/secondary match > insert.
 */
export function decideContactMatch(opts: {
  hubspotIdMatch: boolean
  emailMatch: boolean
}): Extract<MatchKind, 'hubspot_id' | 'email' | 'insert'> {
  if (opts.hubspotIdMatch) return 'hubspot_id'
  if (opts.emailMatch) return 'email'
  return 'insert'
}

/** Skip archived HubSpot records in v1 (no deletion propagation). */
export function shouldSkip(obj: HubspotObject): boolean {
  return obj.archived === true
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function cleanStr(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const t = v.trim()
  return t === '' ? null : t
}

function normalizeEmail(v: string | null | undefined): string | null {
  const s = cleanStr(v)
  if (!s) return null
  const lower = s.toLowerCase()
  // A display label ("Smith, John <j@x.com>") is not an address, and its
  // commas/quotes would rewrite the `.or()` email match.
  return lower.includes('@') && !/[,()"\\\s<>]/.test(lower) ? lower : null
}

/**
 * Lowercase a domain, stripping a scheme + path when a website URL is passed.
 * Personal domains are still returned (the caller decides whether to claim a
 * company from one); returns null for empty/invalid input.
 */
export function normalizeDomain(v: string | null | undefined): string | null {
  const s = cleanStr(v)
  if (!s) return null
  let d = s.toLowerCase().trim()
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '')
  d = d.split('/')[0].split('?')[0].split('#')[0]
  d = d.trim()
  if (!d || !d.includes('.')) return null
  return d
}

// ===========================================================================
// DB I/O — apply the pure decisions. Upsert one HubSpot object at a time so a
// single bad row can't abort a whole page.
// ===========================================================================

type ServiceClient = ReturnType<typeof getServiceClient>

export interface UpsertResult {
  action: 'inserted' | 'updated' | 'skipped'
  id: string | null
}

/**
 * Postgres unique-violation SQLSTATE. A concurrent writer (email-sync creating
 * the same company/contact, or an overlapping sync invocation) can INSERT the
 * conflicting row in the window between our match SELECTs and our INSERT — the
 * INSERT then trips one of the unique constraints (hubspot-id partial index, or
 * the pre-existing UNIQUE(workspace_id, domain) / UNIQUE(workspace_id, email)).
 * We retry the whole match+act flow ONCE on this code: the conflicting row now
 * exists, so the retry lands in the claim/fill-empty update branch instead of
 * silently dropping the record. Any other error keeps the skip-and-log behavior.
 */
const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === PG_UNIQUE_VIOLATION
}

/**
 * Upsert a single HubSpot company into the workspace.
 *
 * 1. hubspot-id match (workspace + source_provider='hubspot' + provider_company_id)
 *    → fill-empty update, name/domain sync from HubSpot.
 * 2. else domain match (workspace_id, domain) → claim it (set source_provider +
 *    provider_company_id) + fill-empty.
 * 3. else INSERT.
 *
 * Returns the local company id (for contact→company linking) and what happened.
 */
export async function upsertHubspotCompany(
  supabase: ServiceClient,
  workspaceId: string,
  obj: HubspotObject,
): Promise<UpsertResult & { companyId: string | null }> {
  if (shouldSkip(obj)) return { action: 'skipped', id: null, companyId: null }

  const mapped = mapCompany(obj)
  const hubspotId = obj.id

  // Run the full match+act flow, retrying ONCE if the INSERT loses a unique-
  // constraint race to a concurrent writer (see PG_UNIQUE_VIOLATION). On the
  // retry the conflicting row is visible, so a match wins and we update instead
  // of dropping the record. Bounded to a single retry so a pathological repeat
  // conflict can't loop forever — it degrades to a logged skip.
  let attempt = 0
  while (true) {
    const outcome = await matchAndActCompany(supabase, workspaceId, hubspotId, mapped)
    if (outcome.kind !== 'insert_conflict') return outcome.result
    if (attempt >= 1) {
      console.error(
        '[hubspot-sync] company insert conflicted twice for hs',
        hubspotId,
        '- skipping',
      )
      return { action: 'skipped', id: null, companyId: null }
    }
    attempt++
  }
}

/**
 * One pass of the company match+act flow. Returns either the terminal result or
 * an `insert_conflict` signal (23505 on INSERT) telling the caller to re-run.
 */
async function matchAndActCompany(
  supabase: ServiceClient,
  workspaceId: string,
  hubspotId: string,
  mapped: MappedCompany,
): Promise<{ kind: 'done'; result: UpsertResult & { companyId: string | null } } | { kind: 'insert_conflict' }> {
  // 1. hubspot-id match
  const { data: byHsId } = await supabase
    .from('company')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_provider', HUBSPOT_SOURCE_PROVIDER)
    .eq('provider_company_id', hubspotId)
    .maybeSingle()

  if (byHsId) {
    const patch = computeFillEmptyPatch(byHsId, mapped, ['name', 'domain'])
    const outcome = await applyUpdate(supabase, 'company', byHsId.id, patch)
    if (outcome === 'conflict') return { kind: 'insert_conflict' }
    return {
      kind: 'done',
      result: {
        action: outcome === 'ok' ? 'updated' : 'skipped',
        id: byHsId.id,
        companyId: byHsId.id,
      },
    }
  }

  // 2. domain match (only for a real, non-personal domain)
  if (mapped.domain && !PERSONAL_DOMAINS.has(mapped.domain)) {
    const { data: byDomain } = await supabase
      .from('company')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('domain', mapped.domain)
      .maybeSingle()

    if (byDomain) {
      const patch = computeFillEmptyPatch(byDomain, mapped, ['name', 'domain'])
      // Claim it for HubSpot (only if not already claimed by another provider).
      if (isEmptyValue(byDomain.source_provider)) {
        patch.source_provider = HUBSPOT_SOURCE_PROVIDER
        patch.provider_company_id = hubspotId
      } else if (byDomain.source_provider === HUBSPOT_SOURCE_PROVIDER && isEmptyValue(byDomain.provider_company_id)) {
        patch.provider_company_id = hubspotId
      }
      const outcome = await applyUpdate(supabase, 'company', byDomain.id, patch)
      if (outcome === 'conflict') return { kind: 'insert_conflict' }
      return {
        kind: 'done',
        result: {
          action: outcome === 'ok' ? 'updated' : 'skipped',
          id: byDomain.id,
          companyId: byDomain.id,
        },
      }
    }
  }

  // 3. insert. name is NOT NULL — fall back to the domain when HubSpot has none.
  const insertName = mapped.name || mapped.domain || 'Unknown Company'
  const { data: inserted, error } = await supabase
    .from('company')
    .insert({
      workspace_id: workspaceId,
      name: insertName,
      domain: mapped.domain,
      website: mapped.website,
      industry: mapped.industry,
      description: mapped.description,
      employee_count_range: mapped.employee_count_range,
      annual_revenue_range: mapped.annual_revenue_range,
      city: mapped.city,
      state: mapped.state,
      country: mapped.country,
      source_provider: HUBSPOT_SOURCE_PROVIDER,
      provider_company_id: hubspotId,
    })
    .select('id')
    .maybeSingle()

  if (error) {
    // A concurrent writer won the race — re-run so the now-visible row matches.
    if (isUniqueViolation(error)) return { kind: 'insert_conflict' }
    console.error('[hubspot-sync] company insert failed for hs', hubspotId, error.message)
    return { kind: 'done', result: { action: 'skipped', id: null, companyId: null } }
  }
  return {
    kind: 'done',
    result: { action: 'inserted', id: inserted?.id ?? null, companyId: inserted?.id ?? null },
  }
}

/**
 * Resolve the local company id for a HubSpot company id (used when linking a
 * contact via its association). Returns null when that company hasn't been
 * imported yet.
 */
export async function resolveLocalCompanyId(
  supabase: ServiceClient,
  workspaceId: string,
  hubspotCompanyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('company')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source_provider', HUBSPOT_SOURCE_PROVIDER)
    .eq('provider_company_id', hubspotCompanyId)
    .maybeSingle()
  return data?.id ?? null
}

/**
 * Upsert a single HubSpot contact into the workspace.
 *
 * 1. hubspot-id match → fill-empty update (full_name recomputed only when the
 *    local value is empty or equals the local email).
 * 2. else email/secondary match (merged-tombstone-filtered) → claim + fill-empty.
 * 3. else INSERT with source 'hubspot_sync' (NO noise filter). No-email contacts
 *    match by hubspot id only; otherwise INSERT with email null.
 *
 * `company_id` is set from the association ONLY when currently null.
 */
export async function upsertHubspotContact(
  supabase: ServiceClient,
  workspaceId: string,
  obj: HubspotObject,
): Promise<UpsertResult> {
  if (shouldSkip(obj)) return { action: 'skipped', id: null }

  const mapped = mapContact(obj)
  const hubspotId = obj.id

  // Retry the full match+act flow ONCE on a lost INSERT race (see
  // PG_UNIQUE_VIOLATION / upsertHubspotCompany for the rationale). Bounded to a
  // single retry; a repeat conflict degrades to a logged skip.
  let attempt = 0
  while (true) {
    const outcome = await matchAndActContact(supabase, workspaceId, hubspotId, mapped, obj)
    if (outcome.kind !== 'insert_conflict') return outcome.result
    if (attempt >= 1) {
      console.error(
        '[hubspot-sync] contact insert conflicted twice for hs',
        hubspotId,
        '- skipping',
      )
      return { action: 'skipped', id: null }
    }
    attempt++
  }
}

/**
 * One pass of the contact match+act flow. Returns either the terminal result or
 * an `insert_conflict` signal (23505 on INSERT) telling the caller to re-run.
 */
async function matchAndActContact(
  supabase: ServiceClient,
  workspaceId: string,
  hubspotId: string,
  mapped: MappedContact,
  obj: HubspotObject,
): Promise<{ kind: 'done'; result: UpsertResult } | { kind: 'insert_conflict' }> {
  // Resolve the associated local company id (only if the object carries an
  // association — search-path results don't).
  const assocHsCompanyId = firstAssociatedCompanyId(obj)
  const localCompanyId = assocHsCompanyId
    ? await resolveLocalCompanyId(supabase, workspaceId, assocHsCompanyId)
    : null

  // 1. hubspot-id match
  const { data: byHsId } = await supabase
    .from('contact')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_provider', HUBSPOT_SOURCE_PROVIDER)
    .eq('provider_contact_id', hubspotId)
    .maybeSingle()

  if (byHsId) {
    const patch = buildContactPatch(byHsId, mapped, localCompanyId)
    const outcome = await applyUpdate(supabase, 'contact', byHsId.id, patch)
    if (outcome === 'conflict') return { kind: 'insert_conflict' }
    return {
      kind: 'done',
      result: { action: outcome === 'ok' ? 'updated' : 'skipped', id: byHsId.id },
    }
  }

  // 2. email / secondary match (tombstone-filtered) — only when we have an email.
  if (mapped.email) {
    const { data: byEmail } = await supabase
      .from('contact')
      .select('*')
      .eq('workspace_id', workspaceId)
      .is('merged_into_contact_id', null)
      .or(`email.eq.${mapped.email},secondary_emails.cs.{"${mapped.email}"}`)
      .limit(1)
      .maybeSingle()

    if (byEmail) {
      const patch = buildContactPatch(byEmail, mapped, localCompanyId)
      // Claim for HubSpot if unclaimed.
      if (isEmptyValue(byEmail.provider_contact_id)) {
        patch.source_provider = HUBSPOT_SOURCE_PROVIDER
        patch.provider_contact_id = hubspotId
      }
      const outcome = await applyUpdate(supabase, 'contact', byEmail.id, patch)
      if (outcome === 'conflict') return { kind: 'insert_conflict' }
      return {
        kind: 'done',
        result: { action: outcome === 'ok' ? 'updated' : 'skipped', id: byEmail.id },
      }
    }
  }

  // 3. INSERT — HubSpot data bypasses the noise filter (curated CRM data).
  // No-email contacts insert with email null (unique(workspace_id,email)
  // permits multiple NULLs; the hubspot-id partial index prevents re-sync dupes).
  const { data: inserted, error } = await supabase
    .from('contact')
    .insert({
      workspace_id: workspaceId,
      email: mapped.email,
      full_name: mapped.full_name || mapped.email || 'Unknown Contact',
      first_name: mapped.first_name,
      last_name: mapped.last_name,
      phone: mapped.phone,
      job_title: mapped.job_title,
      company_id: localCompanyId,
      source: HUBSPOT_CONTACT_SOURCE,
      source_provider: HUBSPOT_SOURCE_PROVIDER,
      provider_contact_id: hubspotId,
      relationship_type: 'contact',
      visibility: 'workspace',
    })
    .select('id')
    .maybeSingle()

  if (error) {
    // A concurrent writer won the race — re-run so the now-visible row matches.
    if (isUniqueViolation(error)) return { kind: 'insert_conflict' }
    console.error('[hubspot-sync] contact insert failed for hs', hubspotId, error.message)
    return { kind: 'done', result: { action: 'skipped', id: null } }
  }
  return { kind: 'done', result: { action: 'inserted', id: inserted?.id ?? null } }
}

/**
 * Build the contact fill-empty patch, applying the full_name recompute rule and
 * the "company_id only when currently null" association rule. Exposed for tests.
 */
export function buildContactPatch(
  local: Record<string, unknown>,
  mapped: MappedContact,
  localCompanyId: string | null,
): Record<string, unknown> {
  // full_name is handled specially, so exclude it from the generic fill-empty.
  const { full_name: mappedFullName, ...rest } = mapped
  const patch = computeFillEmptyPatch(local, rest)

  if (
    mappedFullName &&
    shouldRecomputeFullName(local.full_name as string | null, local.email as string | null)
  ) {
    patch.full_name = mappedFullName
  }

  // company_id from association ONLY when currently null.
  if (localCompanyId && isEmptyValue(local.company_id)) {
    patch.company_id = localCompanyId
  }

  return patch
}

/**
 * Outcome of an applyUpdate call:
 *  - 'ok'       : the update landed (or was a no-op with an empty patch).
 *  - 'conflict' : a 23505 unique violation — a concurrent writer claimed the
 *                 provider id (e.g. contact_hubspot_id_key) between our match
 *                 SELECT and this UPDATE. The caller re-runs the full match path
 *                 ONCE (reusing the insert-conflict retry machinery) so the
 *                 now-visible row wins the hubspot-id match instead.
 *  - 'skipped'  : any other DB error — logged and swallowed, but the caller must
 *                 NOT report the record as 'updated' (nothing was written).
 */
type ApplyUpdateOutcome = 'ok' | 'conflict' | 'skipped'

/**
 * Apply a patch (no-op when empty), stamping updated_at. Returns an error-aware
 * outcome so callers can react to a 23505 (re-match) vs a plain failure (skip)
 * instead of silently treating every update as a success.
 */
async function applyUpdate(
  supabase: ServiceClient,
  table: 'company' | 'contact',
  id: string,
  patch: Record<string, unknown>,
): Promise<ApplyUpdateOutcome> {
  if (Object.keys(patch).length === 0) return 'ok'
  const { error } = await supabase
    .from(table)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    // A concurrent writer claimed the provider id (unique index) in the window
    // between our match SELECT and this UPDATE — re-run the match path once so
    // the now-visible row matches by hubspot id.
    if (isUniqueViolation(error)) return 'conflict'
    console.error(`[hubspot-sync] ${table} update failed for`, id, error.message)
    return 'skipped'
  }
  return 'ok'
}
