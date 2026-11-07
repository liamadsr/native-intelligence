/**
 * POST /api/internal/crm-enrichment
 *
 * INTERNAL-ONLY. The eve `onboarding-researcher` agent calls this to run the
 * app's REAL CRM enrichment pipeline (src/lib/crm/enrichment.ts) during a signup
 * research run. The agent tree cannot import src/, and we refuse to grow a
 * second, drifting copy of the Exa deep-search + write-back logic inside the
 * agent bundle — so the agent reaches back over HTTP and the ONE pipeline stays
 * the only implementation.
 *
 * Signup is the one place enrichment runs without a click (Liam, 10-28): the
 * person's own company and their own contact, once each, during the research
 * run. Everywhere else it runs only on request (the Enrich button, the chat's
 * enrich_contact, the pre-call offer: src/lib/crm/manual-enrichment.ts). Keep
 * this route when narrowing that further; prospecting starts from the company
 * it enriches (src/lib/prospecting/source-company.ts).
 *
 * Two things happen here that the agent could never do safely on its own:
 *   1. the company row is created/linked and enriched with the same fill-empty
 *      column write-back + `metadata.enrichment` blob the CRM's own Sparkles
 *      button produces (so onboarding and manual enrichment agree byte for byte);
 *   2. tenancy is re-verified server-side. The body names a workspaceId+userId
 *      and the research session asking, and they are only honoured while that
 *      pair's live `member` row has a research run in progress
 *      (`onboarding_progress.research`, see researchInProgress below).
 *      Nothing the model says can widen scope.
 *
 * Auth: the shared internal secret (constant-time, `x-agent-run-secret`) proves
 * the caller is our own eve runtime — the same outer gate as
 * /api/internal/agent-run/*. There is no signed run token here (an onboarding
 * research session is not an `agent_run` row), so the run binding is the
 * tenancy gate: holding the secret alone names no one outside a signup's own
 * research window, which ends with the run (finish_research writes done /
 * skipped).
 *
 * maxDuration 300: a company enrichment runs up to three Exa deep searches in
 * SEQUENCE (own-domain core card, open-web fallback, details card), each
 * allowed 60s (DEEP_SEARCH_TIMEOUT_MS), plus the write-back — ~185s worst case.
 * A contact runs two cards in parallel (~65s worst case).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { extractInternalSecret, verifyInternalSecret } from '@/lib/agent-run/agent-run-token'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import {
  companyDomainFromEmail,
  enrichCompany,
  enrichContact,
  ensureCompanyForDomain,
  normalizeDomain,
} from '@/lib/crm/enrichment'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BodySchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  /** The eve session of the research run asking (its `ctx.session.id`). */
  sessionId: z.string().min(1).max(200),
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('company'),
      domain: z.string().min(1),
      name: z.string().optional(),
    }),
    z.object({ kind: z.literal('self_contact') }),
  ]),
})

/**
 * How long the kickoff's `starting` claim counts as a run about to record its
 * session: the kickoff's own STALE_STARTING_MS
 * (src/app/api/account/onboarding/research/route.ts), past which it treats the
 * claim as dead and lets a new kickoff take it.
 */
const STARTING_CLAIM_FRESH_MS = 10 * 60 * 1000
/** Clock skew a `starting` claim's startedAt may run ahead by. */
const STARTED_AT_SKEW_MS = 60 * 1000

interface StoredResearch {
  sessionId?: unknown
  status?: unknown
  startedAt?: unknown
}

/**
 * Whether the member's stored research is the run `sessionId` asking for:
 *   - `running` with exactly this sessionId recorded; or
 *   - the kickoff's `starting` claim, with no session recorded yet and claimed
 *     within STARTING_CLAIM_FRESH_MS. The kickoff writes that claim, creates the
 *     eve session with the brief already in it, and only then records the id,
 *     so the run's first step (enrich_company is its first tool call) can land
 *     in between, and it stays `starting` if that record fails.
 * A different recorded session, `done`, `skipped`, `error` or no research is
 * not a run in progress.
 */
function researchInProgress(research: StoredResearch | undefined, sessionId: string, now = Date.now()): boolean {
  if (!research) return false
  const recorded = research.sessionId
  if (recorded !== undefined && recorded !== null && recorded !== sessionId) return false
  if (research.status === 'running') return recorded === sessionId
  if (research.status !== 'starting' || (recorded !== undefined && recorded !== null)) return false
  const started = typeof research.startedAt === 'string' ? Date.parse(research.startedAt) : Number.NaN
  if (!Number.isFinite(started)) return false
  const age = now - started
  return age > -STARTED_AT_SKEW_MS && age < STARTING_CLAIM_FRESH_MS
}

/** The company columns the agent gets back to write its brief from. */
const COMPANY_VIEW =
  'id, name, domain, website, industry, description, employee_count_range, ' +
  'annual_revenue_range, city, state, country, address, phone, contact_email, metadata'

/** The contact columns the agent gets back. */
const CONTACT_VIEW =
  'id, full_name, email, job_title, department, linkedin_url, company_id, notes, metadata'

/** Pull the `metadata.enrichment` blob out of a freshly re-read row. */
function enrichmentBlob(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') return null
  return (metadata as Record<string, unknown>).enrichment ?? null
}

export async function POST(request: Request) {
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return unauthorized()
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return badRequest('Invalid request body', parsed.error.flatten())
  }
  const { workspaceId, userId, sessionId, target } = parsed.data

  const supabase = getServiceClient()

  // TENANCY GATE. The secret proves "our infrastructure"; this proves "this
  // user really belongs to this workspace, and is in the middle of the
  // research run that asks". Every write below is scoped to the verified pair,
  // so the service-role client never reaches outside it.
  const { data: member, error: memberErr } = await supabase
    .from('member')
    .select('id, onboarding_progress')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (memberErr) return serverError(`member lookup failed: ${memberErr.message}`)
  if (!member) return forbidden('Not a workspace member')
  const row = member as { id: string; onboarding_progress?: { research?: StoredResearch } | null }
  if (!researchInProgress(row.onboarding_progress?.research, sessionId)) {
    return forbidden('No research run in progress for this session')
  }
  const memberId = row.id

  try {
    if (target.kind === 'company') {
      return await handleCompany({ supabase, workspaceId, userId, memberId, target })
    }
    return await handleSelfContact({ supabase, workspaceId, userId, memberId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[internal/crm-enrichment] failed', { workspaceId, kind: target.kind, message })
    return serverError(message)
  }
}

type ServiceClient = ReturnType<typeof getServiceClient>

async function handleCompany(args: {
  supabase: ServiceClient
  workspaceId: string
  userId: string
  memberId: string
  target: { kind: 'company'; domain: string; name?: string }
}) {
  const { supabase, workspaceId, userId, memberId, target } = args

  const domain = normalizeDomain(target.domain)
  if (!domain) return badRequest('Unusable company domain', { code: 'invalid_domain' })
  // A consumer webmail domain is not a company. companyDomainFromEmail drops
  // exactly those, so feeding it a synthetic address is the cheapest way to
  // reuse the app's single PERSONAL_DOMAINS list rather than duplicating it.
  if (!companyDomainFromEmail(`x@${domain}`)) {
    return badRequest('personal_domain', { code: 'personal_domain' })
  }

  const companyId = await ensureCompanyForDomain(supabase, {
    workspaceId,
    domain,
    name: target.name?.trim() || null,
  })
  if (!companyId) return serverError('company create failed')

  // Link the caller's own CRM contact (created by ensureMemberContact at signup)
  // to the company, but only when it has no company yet: an existing link is the
  // user's own truth and onboarding must not overwrite it.
  let contactLinked = false
  const { data: selfContact } = await supabase
    .from('contact')
    .select('id, company_id')
    .eq('workspace_id', workspaceId)
    .eq('member_id', memberId)
    .limit(1)
    .maybeSingle()
  const self = selfContact as { id: string; company_id: string | null } | null
  if (self && !self.company_id) {
    const { error: linkErr } = await supabase
      .from('contact')
      .update({ company_id: companyId, updated_at: new Date().toISOString() })
      .eq('id', self.id)
      .eq('workspace_id', workspaceId)
    contactLinked = !linkErr
  }

  const outcome = await enrichCompany({ companyId, workspaceId, userId })

  // Re-read AFTER enrichment so the agent sees the row as it now stands
  // (enrichCompany writes columns + the metadata blob in place).
  const { data: row } = await supabase
    .from('company')
    .select(COMPANY_VIEW)
    .eq('id', companyId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const company = (row ?? {}) as Record<string, unknown>

  return NextResponse.json({
    companyId,
    domain,
    contactLinked,
    outcome,
    company: {
      name: company.name ?? null,
      domain: company.domain ?? null,
      website: company.website ?? null,
      industry: company.industry ?? null,
      description: company.description ?? null,
      employee_count_range: company.employee_count_range ?? null,
      annual_revenue_range: company.annual_revenue_range ?? null,
      city: company.city ?? null,
      state: company.state ?? null,
      country: company.country ?? null,
      address: company.address ?? null,
      phone: company.phone ?? null,
      contact_email: company.contact_email ?? null,
    },
    enrichment: enrichmentBlob(company.metadata),
  })
}

async function handleSelfContact(args: {
  supabase: ServiceClient
  workspaceId: string
  userId: string
  memberId: string
}) {
  const { supabase, workspaceId, userId, memberId } = args

  const { data: found, error: findErr } = await supabase
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('member_id', memberId)
    .limit(1)
    .maybeSingle()
  if (findErr) return serverError(`contact lookup failed: ${findErr.message}`)
  if (!found) return notFound('No self-contact for this member')
  const contactId = (found as { id: string }).id

  // allowSelf: the self-contact is normally skipped ('workspace_member_self_contact')
  // because sweeping your own teammates is useless. Onboarding is the exception —
  // enriching the new user's OWN card is the entire point.
  const outcome = await enrichContact({ contactId, workspaceId, userId, allowSelf: true })

  const { data: row } = await supabase
    .from('contact')
    .select(CONTACT_VIEW)
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const contact = (row ?? {}) as Record<string, unknown>

  return NextResponse.json({
    contactId,
    outcome,
    contact: {
      full_name: contact.full_name ?? null,
      email: contact.email ?? null,
      job_title: contact.job_title ?? null,
      department: contact.department ?? null,
      linkedin_url: contact.linkedin_url ?? null,
      company_id: contact.company_id ?? null,
      notes: contact.notes ?? null,
    },
    enrichment: enrichmentBlob(contact.metadata),
  })
}
