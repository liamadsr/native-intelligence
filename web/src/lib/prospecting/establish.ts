/**
 * "Learn about my company" — the establish + enrich + ICP-card sequence, in
 * ONE place, called by BOTH the HTTP route and the Scout agent tool.
 *
 * This used to live inline in `POST /api/account/prospecting/source`. It moved
 * here for a single reason: the Scout skill's `research_my_company` tool has to
 * do EXACTLY what the "Learn about my company" button does, and the only way to
 * guarantee that is for them to run the same function rather than two
 * implementations that agree today. A tool that called the route over HTTP
 * would be worse still — it would need a session cookie the agent does not
 * have, re-authenticate work `requireWorkspace` already did, and turn a
 * function call into a network hop that can time out halfway through a paid
 * search.
 *
 * The four steps, in this order and no other (spec §4 step 4):
 *
 *   1. RESOLVE. `resolveSourceCompany` on the SERVICE client — `company`'s
 *      SELECT policy (migration 059) is visibility-aware and the workspace's
 *      own company routinely has exactly one contact, so a plain member's RLS
 *      client can silently fail to see it and mis-seed every ICP in the
 *      workspace. Membership is proven by the CALLER before we get here.
 *   2. ESTABLISH when the caller named a domain (first setup, or the "Not your
 *      company?" re-point) or when nothing resolved at all. A personal-webmail
 *      caller with no domain typed gets `NEEDS_DOMAIN` — the one case we
 *      genuinely cannot guess, and an honest error beats a silent no-op.
 *   3. ENRICH. The SAME mark-pending + `crm/enrich-company.manual` the CRM's
 *      Sparkles button sends. This is what fills `what_we_sell`, industry and
 *      description — everything the ICP pre-fill reads. It runs for a
 *      just-established company AND for a resolved-but-never-enriched one.
 *   4. CARD. `fireIcpCard`, which is idempotent: an already-carded company
 *      comes back `skipped: 'already_present'` having spent nothing, which is
 *      what makes this safe to call from a retry, a second list, an impatient
 *      double-click — or an agent that decided to check.
 *
 * Then the source is RE-READ, so the drafts seed from the row as it now stands
 * rather than as it stood before the card landed.
 *
 * WRITES RUN ON THE SERVICE CLIENT for the same reason the reads do: a member
 * who cannot SELECT the row cannot UPDATE it either, and the workspace-company
 * flag flip would silently no-op. Every one of those writes carries its own
 * `workspace_id` filter, so nothing outside the verified workspace is
 * reachable.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { hasPermanentFailure } from '@/lib/crm/enrichment'
import { fireIcpCard, type FireIcpCardOutcome } from './research'
import {
  establishSourceCompany,
  resolveSourceCompany,
  suggestedDomainFor,
  type EstablishSourceCompanyError,
  type ResolveSourceCompanyResult,
} from './source-company'

/**
 * How the full company enrichment ended up, from the caller's point of view.
 * `already` = the row is enriched or a run is already queued; `skipped` = we
 * refused to spend (a permanent failure marker, or a read that failed).
 */
export type EnrichmentOutcome = 'started' | 'already' | 'skipped'

/**
 * Why the sequence refused. `NEEDS_DOMAIN` is the personal-webmail case and is
 * the ONLY one that means "ask the user a question"; the rest describe a domain
 * that was supplied and rejected.
 */
export type EstablishAndResearchError = EstablishSourceCompanyError | 'NEEDS_DOMAIN'

export type EstablishAndResearchResult =
  | {
      ok: true
      /** The source company as it stands AFTER the card, re-read. */
      source: ResolveSourceCompanyResult['company']
      resolved_by: ResolveSourceCompanyResult['resolved_by']
      /** The id the enrichment and the card were fired against. Non-null on
       *  success by construction. */
      company_id: string
      /** True when THIS call established (created or re-pointed) the company. */
      established: boolean
      enrichment: EnrichmentOutcome
      icp_card: FireIcpCardOutcome
    }
  | { ok: false; code: EstablishAndResearchError; error: string }

export interface EstablishAndResearchArgs {
  workspaceId: string
  userId: string
  /** The caller's email address, used to guess the domain when none is given.
   *  A service-role client has no session to read it from, so it is passed. */
  userEmail: string | null
  /** The domain to establish. `null`/absent means "use what you already know
   *  about me", falling back to the email domain when nothing resolves. */
  domain?: string | null
}

/**
 * Kick the SAME enrichment the CRM's manual Sparkles button kicks —
 * `src/app/api/account/companies/[id]/enrich/route.ts`: mark the row pending,
 * then send `crm/enrich-company.manual` (the interactive lane, so this doesn't
 * queue behind the cron sweep).
 *
 * Unlike that route this is NOT a re-enrichment affordance: it runs as a side
 * effect of establishing the company, so an already-enriched or already-pending
 * row is left alone rather than re-billed. The user has an explicit Enrich
 * button on the company record for that.
 */
async function kickCompanyEnrichment(
  supabase: SupabaseClient,
  args: { companyId: string; workspaceId: string; userId: string },
): Promise<EnrichmentOutcome> {
  const { companyId, workspaceId, userId } = args

  const { data: row, error } = await supabase
    .from('company')
    .select('id, enrichment_status, metadata')
    .eq('id', companyId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error || !row) return 'skipped'

  const company = row as { enrichment_status: string | null; metadata: unknown }
  // A permanent failure will not succeed on retry — the manual route answers
  // 409 for exactly this; here it is one of several steps, so it degrades.
  if (hasPermanentFailure(company.metadata)) return 'skipped'
  if (company.enrichment_status === 'enriched' || company.enrichment_status === 'pending') {
    return 'already'
  }

  const { error: markErr } = await supabase
    .from('company')
    .update({ enrichment_status: 'pending' })
    .eq('id', companyId)
    .eq('workspace_id', workspaceId)
  if (markErr) {
    console.error('[prospecting] marking the company pending failed:', markErr.message)
    return 'skipped'
  }

  await inngest.send({
    name: 'crm/enrich-company.manual',
    data: { companyId, workspaceId, userId },
  })
  return 'started'
}

/**
 * Establish the workspace's own company and research it — the whole "Learn
 * about my company" act.
 *
 * `service` must be a SERVICE-ROLE client, and the caller must have proved
 * workspace membership first (`requireWorkspace` in a route; the tool factory's
 * constructor-bound `workspaceId` in the agent lane). Every query below carries
 * an explicit `workspace_id` filter regardless.
 */
export async function establishAndResearchSourceCompany(
  service: SupabaseClient,
  args: EstablishAndResearchArgs,
): Promise<EstablishAndResearchResult> {
  const { workspaceId, userId, userEmail } = args
  const requestedDomain =
    typeof args.domain === 'string' && args.domain.trim() !== '' ? args.domain.trim() : null

  const resolved = await resolveSourceCompany(service, { workspaceId, userId, userEmail })

  let companyId = resolved.company?.id ?? null
  let established = false

  // Establish when the caller named a domain (a first setup OR the "Not your
  // company?" re-point), or when nothing resolved at all (§4 step 4).
  const needsEstablish = requestedDomain !== null || !resolved.company
  if (needsEstablish) {
    const domain = requestedDomain ?? suggestedDomainFor(userEmail)
    if (!domain) {
      // A personal-webmail signup with nothing in the workspace: there is
      // genuinely nothing to guess from, so ASK rather than return a success
      // that looks like a no-op.
      return { ok: false, code: 'NEEDS_DOMAIN', error: "Tell us your company's website" }
    }

    const outcome = await establishSourceCompany(service, { workspaceId, userId, domain })
    if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error }
    companyId = outcome.companyId
    established = true
  }

  // Unreachable in practice (establish either succeeded or returned above),
  // but the type says `string | null` and a null here must not become a silent
  // no-op ever again.
  if (!companyId) {
    return { ok: false, code: 'CREATE_FAILED', error: 'Could not resolve a source company' }
  }

  const enrichment = await kickCompanyEnrichment(service, { companyId, workspaceId, userId })

  const icpCard = await fireIcpCard(service, { workspaceId, userId, companyId })

  // Re-read AFTER the card so anything seeded from this result reads the row
  // as it now stands.
  const refreshed = await resolveSourceCompany(service, { workspaceId, userId, userEmail })

  return {
    ok: true,
    source: refreshed.company,
    resolved_by: refreshed.resolved_by,
    company_id: companyId,
    established,
    enrichment,
    icp_card: icpCard,
  }
}
