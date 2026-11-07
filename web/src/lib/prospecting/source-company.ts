/**
 * "Our own company" — the row every ICP is seeded from (spec §4).
 *
 * Before migration 248 this was a pure heuristic; the migration makes it
 * explicit with `company.is_workspace_company` plus a partial unique index
 * enforcing at most one per workspace. But the flag is not always set (the
 * backfill covers existing workspaces; a brand-new one may reach here before
 * anything sets it), so the resolver walks the SAME four-step order the
 * backfill's SQL implements:
 *
 *   1. the `is_workspace_company` row, if set;
 *   2. the caller's member SELF-CONTACT's `company_id` — this is what
 *      onboarding links first (verified against
 *      `src/app/api/internal/crm-enrichment/route.ts`, which links the
 *      caller's self-contact to the created company when it has no company yet);
 *   3. `companyDomainFromEmail(user.email)` → the company with that domain;
 *   4. nothing — `establishSourceCompany` (below) CREATES the company from a
 *      domain: the caller's typed one, or their own email domain. Before this
 *      existed, step 4 was a dead end: a business-email signup whose workspace
 *      had no company rows got "We don't know your company yet" and a button
 *      that returned 200 with a null source and did nothing.
 *
 * ORDER MATTERS. Matching on the email domain alone mis-seeds on real
 * workspaces where the owner's self-contact was manually re-linked, and a
 * WRONG source company silently mis-seeds every ICP in the workspace — which
 * is why `resolved_by` comes back with the row and the UI renders a visible
 * "Not your company?" correction affordance from day one.
 *
 * Every query carries an explicit `workspace_id` filter: this runs on whatever
 * client the caller holds (routes pass the RLS-scoped one), and RLS alone is
 * never the boundary for a lib function that a service-role caller may also
 * reach.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { getServiceClient } from '@/lib/admin'
import {
  companyDomainFromEmail,
  ensureCompanyForDomain,
  normalizeDomain,
} from '@/lib/crm/enrichment'

/** `ensureCompanyForDomain` is typed against the service client. This module
 *  takes a plain `SupabaseClient` (routes hand it whichever one is correct for
 *  the read), so the one call site widens explicitly rather than every caller
 *  being forced to hold a service client. */
type ServiceClient = ReturnType<typeof getServiceClient>

/** The company columns the ICP draft and the source panel read. */
export const SOURCE_COMPANY_COLUMNS =
  'id, workspace_id, name, domain, website, industry, description, ' +
  'employee_count_range, annual_revenue_range, city, state, country, ' +
  'is_workspace_company, enrichment_status, metadata'

/** A company row as this module reads it. `metadata` stays `unknown` — the
 *  enrichment blob is parsed by `icp.ts`, never cast blind. */
export interface SourceCompanyRow {
  id: string
  workspace_id: string
  name: string | null
  domain: string | null
  website?: string | null
  industry?: string | null
  description?: string | null
  employee_count_range?: string | null
  annual_revenue_range?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  is_workspace_company?: boolean | null
  /**
   * Where the full CRM enrichment stands: null / 'pending' / 'enriched' /
   * 'failed' / 'skipped'.
   *
   * Carried on the row — and therefore out through GET /source — because the
   * empty state's "Researching…" line has to know when the SLOW half is done,
   * not just when the $0.012 ICP card landed. Polling on the card alone stops
   * while `what_we_sell` is still empty, which is exactly the "it was loading
   * but I wasn't sure what it was loading" report.
   */
  enrichment_status?: string | null
  metadata?: unknown
}

/** Which of §4's four steps produced the row. `none` means step 4: nothing
 *  resolved and the sheet must ask for a domain. */
export type SourceCompanyResolvedBy =
  | 'is_workspace_company'
  | 'self_contact'
  | 'email_domain'
  | 'none'

export interface ResolveSourceCompanyResult {
  company: SourceCompanyRow | null
  resolved_by: SourceCompanyResolvedBy
}

export interface ResolveSourceCompanyArgs {
  workspaceId: string
  userId: string
  /**
   * The caller's email address. Optional: when absent, step 3 is attempted
   * from `auth.getUser()` — but routes already hold the user and should pass
   * it, since a service-role client has no session to read.
   */
  userEmail?: string | null
}

/**
 * One workspace-scoped company read, by an additional equality filter. Kept in
 * one place so all three steps share the identical column list and the same
 * "an error is not a match" behaviour.
 */
async function loadCompany(
  supabase: SupabaseClient,
  workspaceId: string,
  column: 'is_workspace_company' | 'id' | 'domain',
  value: string | boolean,
): Promise<SourceCompanyRow | null> {
  const { data, error } = await supabase
    .from('company')
    .select(SOURCE_COMPANY_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq(column, value)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] source company lookup failed:', error.message)
    return null
  }
  return (data as SourceCompanyRow | null) ?? null
}

/**
 * Resolve the workspace's own company, in §4's order.
 *
 * Never throws: a query error at any step is logged and treated as "this step
 * found nothing", so a transient failure degrades to the next step rather than
 * failing the whole New-list sheet.
 */
export async function resolveSourceCompany(
  supabase: SupabaseClient,
  args: ResolveSourceCompanyArgs,
): Promise<ResolveSourceCompanyResult> {
  const { workspaceId, userId } = args

  // ── Step 1: the explicit flag ────────────────────────────────────────
  const flagged = await loadCompany(supabase, workspaceId, 'is_workspace_company', true)
  if (flagged) return { company: flagged, resolved_by: 'is_workspace_company' }

  // ── Step 2: the caller's self-contact's company ──────────────────────
  // `contact.member_id` is the self-contact link (ensureMemberContact writes
  // one per workspace member); the member row is resolved from the user id.
  const { data: memberRow, error: memberError } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (memberError) {
    console.error('[prospecting] member lookup failed:', memberError.message)
  }
  const memberId = (memberRow as { id: string } | null)?.id ?? null

  if (memberId) {
    // Mirrors 248's backfill LATERAL for this same step exactly: skip
    // company-less and tombstoned (merged-away) self-contacts, and break ties
    // by created_at then id. Without the filters a member whose self-contact
    // was merged away — or who has a second, company-less one — resolves to
    // null here and silently falls through to the email-domain step, while the
    // backfill had already flagged the company this step names.
    const { data: selfContact, error: contactError } = await supabase
      .from('contact')
      .select('company_id')
      .eq('workspace_id', workspaceId)
      .eq('member_id', memberId)
      .not('company_id', 'is', null)
      .is('merged_into_contact_id', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (contactError) {
      console.error('[prospecting] self-contact lookup failed:', contactError.message)
    }
    const companyId = (selfContact as { company_id: string | null } | null)?.company_id ?? null
    if (companyId) {
      const linked = await loadCompany(supabase, workspaceId, 'id', companyId)
      if (linked) return { company: linked, resolved_by: 'self_contact' }
    }
  }

  // ── Step 3: the caller's email domain ────────────────────────────────
  // companyDomainFromEmail returns null for personal/webmail domains, so a
  // gmail.com signup can never seed the workspace with "gmail.com".
  let email = args.userEmail ?? null
  if (email === undefined || email === null) {
    const { data } = await supabase.auth.getUser()
    email = data?.user?.email ?? null
  }
  const domain = companyDomainFromEmail(email)
  if (domain) {
    const byDomain = await loadCompany(supabase, workspaceId, 'domain', domain)
    if (byDomain) return { company: byDomain, resolved_by: 'email_domain' }
  }

  // ── Step 4: nothing ──────────────────────────────────────────────────
  return { company: null, resolved_by: 'none' }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 4, made real: establishing the source company from a domain.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The domain the UI should pre-fill the "Research my company" field with when
 * the resolver found nothing: the caller's own email domain, or null when that
 * is a consumer webmail address (nobody's company is gmail.com).
 *
 * Split out of `resolveSourceCompany` deliberately — GET returns it ALONGSIDE
 * a null source, and the resolver's own step 3 must keep returning `none`
 * rather than inventing a row.
 */
export function suggestedDomainFor(userEmail: string | null | undefined): string | null {
  return companyDomainFromEmail(userEmail ?? null)
}

/** Why an establish attempt refused, in the vocabulary the route maps to HTTP. */
export type EstablishSourceCompanyError =
  | 'PERSONAL_DOMAIN'
  | 'INVALID_DOMAIN'
  | 'CREATE_FAILED'

export type EstablishSourceCompanyResult =
  | {
      ok: true
      companyId: string
      domain: string
      /** True when this call created the row (as opposed to adopting one that
       *  already carried the domain). Purely informational. */
      created: boolean
      /** True when the caller's self-contact had no company and now points here. */
      contactLinked: boolean
    }
  | { ok: false; code: EstablishSourceCompanyError; error: string }

export interface EstablishSourceCompanyArgs {
  workspaceId: string
  userId: string
  /** Free-form: 'dial8.ai', 'https://www.dial8.ai/pricing' — normalized here. */
  domain: string
}

/**
 * §4 step 4: turn a domain into THE workspace's company.
 *
 * Four writes, in this order, each one idempotent on its own:
 *
 *   1. `ensureCompanyForDomain` — the SAME helper the onboarding internal route
 *      (`/api/internal/crm-enrichment`, `handleCompany`) uses, including its
 *      name-derivation fallback to the domain when `company.name` (NOT NULL)
 *      has nothing better. A second implementation would drift from its
 *      unique-constraint handling.
 *   2. clear `is_workspace_company` on every OTHER row in the workspace, then
 *      set it here. Order matters: migration 248's partial unique index allows
 *      exactly one flagged row per workspace, so flagging first would collide
 *      with the row being re-pointed away from. This clear-then-set IS the
 *      "Not your company?" correction path.
 *   3. link the caller's self-contact when — and only when — it has no company
 *      yet. Mirrors `handleCompany` exactly: an existing link is the user's own
 *      truth and this must not overwrite it.
 *
 * Enrichment is NOT kicked here. That is the route's job (it owns the Inngest
 * dependency), and keeping this function write-only over Supabase is what lets
 * it be tested against the fake client with zero mocking of the job queue.
 */
export async function establishSourceCompany(
  supabase: SupabaseClient,
  args: EstablishSourceCompanyArgs,
): Promise<EstablishSourceCompanyResult> {
  const { workspaceId, userId } = args

  const domain = normalizeDomain(args.domain)
  if (!domain) {
    return { ok: false, code: 'INVALID_DOMAIN', error: "That doesn't look like a website" }
  }
  // A consumer webmail domain is not a company. Feeding a synthetic address to
  // companyDomainFromEmail reuses the app's single PERSONAL_DOMAINS list rather
  // than duplicating it — the same trick `handleCompany` uses.
  if (!companyDomainFromEmail(`x@${domain}`)) {
    return {
      ok: false,
      code: 'PERSONAL_DOMAIN',
      error: 'That is a personal email provider, not a company website',
    }
  }

  const existingId = await companyIdForDomain(supabase, workspaceId, domain)
  const companyId = await ensureCompanyForDomain(supabase as ServiceClient, {
    workspaceId,
    domain,
    name: null,
  })
  if (!companyId) {
    return { ok: false, code: 'CREATE_FAILED', error: 'Could not create the company' }
  }

  await pointWorkspaceCompanyAt(supabase, workspaceId, companyId)
  const contactLinked = await linkSelfContact(supabase, workspaceId, userId, companyId)

  return { ok: true, companyId, domain, created: existingId !== companyId, contactLinked }
}

/** The company id already carrying this domain, if any. Read before the
 *  ensure so the result can honestly report whether a row was created. */
async function companyIdForDomain(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('company')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('domain', domain)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/**
 * Move the `is_workspace_company` flag onto one row. CLEAR FIRST, then SET:
 * 248's partial unique index (`ON company (workspace_id) WHERE
 * is_workspace_company`) means a set-before-clear ordering fails outright when
 * another row already holds the flag — which is exactly the re-point case this
 * exists for.
 */
async function pointWorkspaceCompanyAt(
  supabase: SupabaseClient,
  workspaceId: string,
  companyId: string,
): Promise<void> {
  const { error: clearErr } = await supabase
    .from('company')
    .update({ is_workspace_company: false })
    .eq('workspace_id', workspaceId)
    .eq('is_workspace_company', true)
    .neq('id', companyId)
  if (clearErr) {
    console.error('[prospecting] clearing the workspace company flag failed:', clearErr.message)
  }

  const { error: setErr } = await supabase
    .from('company')
    .update({ is_workspace_company: true })
    .eq('id', companyId)
    .eq('workspace_id', workspaceId)
  if (setErr) {
    console.error('[prospecting] setting the workspace company flag failed:', setErr.message)
  }
}

/**
 * Link the caller's member self-contact to the company when it has none.
 * Byte-for-byte the same rule as `/api/internal/crm-enrichment`'s
 * `handleCompany`: an existing `company_id` is the user's own truth.
 */
async function linkSelfContact(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const { data: memberRow } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  const memberId = (memberRow as { id: string } | null)?.id ?? null
  if (!memberId) return false

  const { data: selfContact } = await supabase
    .from('contact')
    .select('id, company_id')
    .eq('workspace_id', workspaceId)
    .eq('member_id', memberId)
    .limit(1)
    .maybeSingle()
  const self = selfContact as { id: string; company_id: string | null } | null
  if (!self || self.company_id) return false

  const { error } = await supabase
    .from('contact')
    .update({ company_id: companyId, updated_at: new Date().toISOString() })
    .eq('id', self.id)
    .eq('workspace_id', workspaceId)
  return !error
}
