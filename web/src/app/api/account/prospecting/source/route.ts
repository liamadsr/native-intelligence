/**
 * /api/account/prospecting/source — the workspace's own company, and the ICP
 * drafts seeded from it (§4).
 *
 * GET returns `{source, resolved_by, suggested_domain, icp_draft_by_purpose,
 * counts}` — enough for the New-list sheet to render every template pre-filled,
 * with provenance, and the three exclusion toggles carrying real numbers, in
 * ONE round trip. `suggested_domain` is the caller's own email domain when the
 * resolver found NOTHING, so the empty state can pre-fill the field it asks
 * them to fill instead of making a business-email user type dial8.ai by hand.
 *
 * POST is §4 step 4 made real. It used to answer "no source company" with a
 * 200 and a null source, which the UI rendered as a button that did nothing —
 * the production bug this route now fixes. It:
 *
 *   1. takes an optional `{ domain }` (the "Not your company?" correction, and
 *      the empty state's field), falling back to the caller's email domain;
 *   2. `establishSourceCompany`s it — create/adopt the company row, flag it as
 *      the workspace company (clearing any previous flag), link the caller's
 *      self-contact;
 *   3. kicks the SAME full enrichment the CRM's Sparkles button kicks, so
 *      "what we sell" actually fills in;
 *   4. fires the ICP card (idempotent, $0.012 at most once per company).
 *
 * Steps 1–4 live in `src/lib/prospecting/establish.ts`
 * (`establishAndResearchSourceCompany`), not here, because the Scout agent's
 * `research_my_company` tool has to do EXACTLY what this button does and the
 * only way to guarantee that is ONE implementation. This route keeps the HTTP
 * shape — body parsing, the error→status mapping, and the ICP-draft projection
 * — and nothing else.
 *
 * A caller on a personal webmail address with no domain typed gets 400
 * NEEDS_DOMAIN — the one case where we genuinely cannot guess, and the UI must
 * ask. That is an honest error, not a silent no-op.
 *
 * WHY THE SERVICE CLIENT FOR THE COMPANY READS. `company`'s SELECT policy
 * (migration 059) is VISIBILITY-AWARE: a non-admin member only sees companies
 * that have at least one contact they can view. The workspace's own company
 * routinely has exactly one contact — the caller's own self-contact — but a
 * teammate's private contact, or none at all, makes the row invisible to a
 * plain member and `resolveSourceCompany` would then silently fall through to
 * "no source company" and mis-seed every ICP in the workspace. So the source
 * resolution runs on the service client with an EXPLICIT workspace filter
 * (`resolveSourceCompany` carries one on every query), after `requireWorkspace`
 * has already proved membership — the same shape
 * `/api/internal/crm-enrichment` uses, and the rule documented at the top of
 * `src/lib/crm/delete-companies.ts`. Nothing outside the verified workspace is
 * reachable, and the response exposes one company row the member is entitled
 * to see because it is their own employer.
 *
 * The WRITES in step 2 run on the service client for the same reason: a member
 * who cannot SELECT the row cannot UPDATE it either, and the flag flip would
 * silently no-op. Every one of those writes carries its own `workspace_id`
 * filter.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { establishAndResearchSourceCompany } from '@/lib/prospecting/establish'
import { buildIcpDraft, type IcpDraft } from '@/lib/prospecting/icp'
import { exclusionCounts } from '@/lib/prospecting/lists'
import { resolveSourceCompany, suggestedDomainFor } from '@/lib/prospecting/source-company'
import type { ProspectListPurpose } from '@/lib/prospecting/types'
import { PROSPECT_LIST_PURPOSES } from '@/lib/prospecting/types'

export const maxDuration = 120

const EMPTY_COUNTS = { crm_companies: 0, other_lists: 0, contacted_people: 0 }

/** One draft per purpose, so the sheet's template switcher is instant and the
 *  user can compare "Customers like us" against "Investors" without a fetch. */
function draftsByPurpose(
  company: Parameters<typeof buildIcpDraft>[0],
): Record<ProspectListPurpose, IcpDraft> {
  const out = {} as Record<ProspectListPurpose, IcpDraft>
  for (const purpose of PROSPECT_LIST_PURPOSES) {
    out[purpose] = buildIcpDraft(company, purpose)
  }
  return out
}

/** `suggested_domain` is only meaningful when nothing resolved: once we know
 *  the company, a stale email-domain hint would invite the user to "correct"
 *  a correct row. */
function suggestedDomain(
  resolvedCompany: unknown,
  userEmail: string | null | undefined,
): string | null {
  return resolvedCompany ? null : suggestedDomainFor(userEmail)
}

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const service = getServiceClient()
  const { company, resolved_by } = await resolveSourceCompany(service, {
    workspaceId,
    userId: user.id,
    userEmail: user.email ?? null,
  })

  // Counts run on the RLS client: they describe what the CALLER's exclusion
  // toggles would hide, and a member who cannot see a contact should not be
  // told it exists.
  const counts = await exclusionCounts(supabase, { workspaceId })
  if (!counts.ok) return serverError()

  return NextResponse.json({
    source: company,
    resolved_by,
    suggested_domain: suggestedDomain(company, user.email),
    icp_draft_by_purpose: draftsByPurpose(company),
    counts: counts.counts,
  })
}

export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  // The body is optional: the empty state posts `{domain}`, "Research my
  // company" on a resolved workspace posts nothing at all.
  let requestedDomain: string | null = null
  try {
    const raw: unknown = await request.json()
    if (raw && typeof raw === 'object') {
      const value = (raw as Record<string, unknown>).domain
      if (typeof value === 'string' && value.trim()) requestedDomain = value.trim()
      else if (value !== undefined && value !== null && typeof value !== 'string') {
        return badRequest('domain must be a string')
      }
    }
  } catch {
    // No body / unparseable body is the "just research what you already know
    // about me" call. Not an error.
  }

  const service = getServiceClient()
  const outcome = await establishAndResearchSourceCompany(service, {
    workspaceId,
    userId: user.id,
    userEmail: user.email ?? null,
    domain: requestedDomain,
  })
  if (!outcome.ok) {
    if (outcome.code === 'CREATE_FAILED') return serverError(outcome.error)
    return apiError(outcome.error, { status: 400, code: outcome.code })
  }

  // Counts run on the RLS client for the same reason GET's do: they describe
  // what the CALLER's exclusion toggles would hide.
  const counts = await exclusionCounts(supabase, { workspaceId })

  return NextResponse.json({
    source: outcome.source,
    resolved_by: outcome.resolved_by,
    suggested_domain: suggestedDomain(outcome.source, user.email),
    established: outcome.established,
    enrichment: outcome.enrichment,
    icp_card: outcome.icp_card,
    icp_draft_by_purpose: draftsByPurpose(outcome.source),
    counts: counts.ok ? counts.counts : EMPTY_COUNTS,
  })
}
