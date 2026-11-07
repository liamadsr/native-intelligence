/**
 * Fixtures shared by the Prospecting UI suites.
 *
 * The ICP draft is built by the REAL `buildIcpDraft` against a fixture company
 * row rather than hand-typed, so a change to what `buildIcpDraft` seeds — or
 * to which paths it records provenance for — moves these tests instead of
 * leaving them asserting a shape the server no longer produces.
 */

import { buildIcpDraft, type IcpDraft } from '@/lib/prospecting/icp'
import type { SourceCompanyRow } from '@/lib/prospecting/source-company'
import {
  PROSPECT_LIST_PURPOSES,
  type ProspectListPurpose,
  type ProspectListEntryRow,
  type ProspectListRow,
} from '@/lib/prospecting/types'

/** A workspace company that HAS been through the ICP card — the happy path
 *  the empty state's "You sell X to Y" sentence exists to render. */
export const CARDED_COMPANY: SourceCompanyRow = {
  id: 'company-1',
  workspace_id: 'ws-1',
  name: 'Dial8',
  domain: 'dial8.ai',
  industry: 'Software',
  description: 'A workspace for revenue teams.',
  is_workspace_company: true,
  // Terminal — the full enrichment finished. Both halves of the poll's stop
  // condition are satisfied by this fixture, which is what makes it the
  // "everything landed" company.
  enrichment_status: 'enriched',
  metadata: {
    enrichment: {
      fields: {
        // The ICP card's own value promise. It is FIRST in the
        // `what_we_sell` seed chain (own-domain by construction, since
        // `fireIcpCard` runs `includeDomains: [domain]`), so this is the
        // string the sheet pre-fills "Our product" with.
        value_proposition: {
          value: 'an AI meeting-capture and CRM workspace',
          source_url: 'https://dial8.ai/product',
          confidence: 'high',
        },
        // Kept so the fixture still exercises the open-web DETAILS card, but
        // it now sits BELOW the value proposition and the description column
        // in the seed order and must not be what gets seeded.
        products_and_services: {
          value: 'Cocktail bar and event space',
          source_url: 'https://dial8-namesake.example/about',
          confidence: 'high',
        },
        target_customer: {
          value: 'revenue teams at 20–500 person B2B software companies',
          source_url: 'https://dial8.ai',
          confidence: 'high',
        },
        known_customers: {
          value: 'Acme, Globex',
          source_url: 'https://dial8.ai/customers',
          confidence: 'medium',
        },
        buyer_titles: {
          value: 'VP Sales, Head of Revenue Operations',
          source_url: 'https://dial8.ai',
          confidence: 'medium',
        },
      },
    },
  },
}

/** The same company BEFORE the ICP card ran: columns only, no card fields.
 *  Enrichment is TERMINAL here — this is the "the job finished and still told
 *  us nothing new" row, not a row mid-flight. */
export const UNCARDED_COMPANY: SourceCompanyRow = {
  id: 'company-1',
  workspace_id: 'ws-1',
  name: 'Dial8',
  domain: 'dial8.ai',
  industry: 'Software',
  description: 'A workspace for revenue teams.',
  is_workspace_company: true,
  enrichment_status: 'enriched',
  metadata: {},
}

/**
 * A company row the instant it is established: flagged, but nothing known
 * about it yet and the full enrichment still `pending`.
 *
 * This is the row the "Researching…" line exists for, and the one that proves
 * the poll's second half: the ICP card can land against it while
 * `enrichment_status` is still 'pending' and `description` still empty, which
 * is exactly the state the old card-only stop condition mistook for done.
 */
export const ENRICHING_COMPANY: SourceCompanyRow = {
  id: 'company-1',
  workspace_id: 'ws-1',
  name: 'Dial8',
  domain: 'dial8.ai',
  industry: null,
  description: null,
  is_workspace_company: true,
  enrichment_status: 'pending',
  metadata: {},
}

/** Enrichment finished and could not say what the company sells — the state
 *  the inline "Tell us in a sentence" prompt answers. */
export const NO_WHAT_WE_SELL_COMPANY: SourceCompanyRow = {
  ...ENRICHING_COMPANY,
  enrichment_status: 'enriched',
}

export function draftsFor(
  company: SourceCompanyRow | null,
): Record<ProspectListPurpose, IcpDraft> {
  const out = {} as Record<ProspectListPurpose, IcpDraft>
  for (const purpose of PROSPECT_LIST_PURPOSES) out[purpose] = buildIcpDraft(company, purpose)
  return out
}

/**
 * A GET /source body.
 *
 * `suggestedDomain` is the second argument because it is only ever meaningful
 * in the no-company case: the route returns `companyDomainFromEmail(caller)`
 * ONLY when the resolver found nothing, and null for a personal/webmail
 * address. Defaulting it to null keeps every existing caller honest — a
 * workspace with a company has no suggestion to make.
 */
export function sourcePayload(
  company: SourceCompanyRow | null,
  suggestedDomain: string | null = null,
) {
  return {
    source: company,
    resolved_by: company ? ('is_workspace_company' as const) : ('none' as const),
    icp_draft_by_purpose: draftsFor(company),
    counts: { crm_companies: 412, other_lists: 3, contacted_people: 38 },
    suggested_domain: company ? null : suggestedDomain,
  }
}

export const LIST: ProspectListRow = {
  id: 'list-1',
  workspace_id: 'ws-1',
  name: 'Customers like us',
  description: null,
  purpose: 'buyers',
  icp: buildIcpDraft(CARDED_COMPANY, 'buyers').icp,
  icp_version: 1,
  source_company_id: 'company-1',
  exclude_crm: true,
  exclude_other_lists: false,
  exclude_contacted: 'active',
  max_spend_dollars: 2,
  target_new_candidates: 50,
  max_rounds: 2,
  people_per_company: 3,
  status: 'active',
  created_by: 'user-1',
  published_at: null,
  published_by: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

export function entry(overrides: Partial<ProspectListEntryRow> = {}): ProspectListEntryRow {
  return {
    id: 'entry-1',
    workspace_id: 'ws-1',
    list_id: 'list-1',
    kind: 'company',
    candidate_key: 'acme.com',
    candidate: { name: 'Acme', domain: 'acme.com' },
    company_id: null,
    contact_id: null,
    published_at: null,
    parent_entry_id: null,
    stage: 'discovered',
    identity_state: 'resolved',
    fit_score: null,
    fit_rationale: null,
    dismissed_reason: null,
    dismissed_by: null,
    dismissed_at: null,
    icp_version: 1,
    discovered_by_run_id: null,
    discovery_angle: null,
    research: null,
    sources: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

export const EMPTY_COUNTS = {
  discovered: 0,
  shortlisted: 0,
  saved: 0,
  dismissed: 0,
  total: 0,
}
