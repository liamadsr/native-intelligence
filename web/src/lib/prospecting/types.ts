/**
 * Shared row types for Prospecting, mirroring migration 248_prospecting.sql —
 * the source of truth for enums and columns.
 *
 * The const arrays below are the SINGLE source for both the TypeScript unions
 * and the schema-lockstep test (`__tests__/schema-lockstep.test.ts`), which
 * reads the migrations' text and asserts every CHECK list equals the
 * corresponding array here. Adding a value in one place and not the other
 * fails that test rather than producing a runtime 23514 in production.
 *
 * 248 is the source of truth for every vocabulary EXCEPT `suppressed_by`,
 * which migration 251 widened; the lockstep test reads 251 for that one
 * column and 248 for the rest.
 */

// ---------------------------------------------------------------------------
// Enum vocabularies — in lockstep with the CHECK constraints in 248 (and, for
// `suppressed_by`, in 251)
// ---------------------------------------------------------------------------

/** `prospect_list.purpose`. Seeds the ICP draft and picks angle templates; it
 *  never branches the pipeline. */
export const PROSPECT_LIST_PURPOSES = [
  'buyers',
  'investors',
  'partners',
  'talent',
  'custom',
] as const
export type ProspectListPurpose = (typeof PROSPECT_LIST_PURPOSES)[number]

/**
 * The one-word chip label for each purpose, shared by every surface that shows
 * a list (the index rows, the list-detail header, the sheet).
 *
 * IT LIVES IN `lib`, not in the prospecting page folder, because the views
 * system renders it: `src/components/views/list/entity-row.tsx` draws the
 * purpose chip on a `prospect_list` row, and a shared component importing from
 * `src/app/account/(dashboard)/prospecting/*` is the wrong direction — the
 * page may import the views system, never the reverse. `ui-helpers.ts`
 * re-exports it so every existing page import is unchanged.
 */
export const PROSPECT_PURPOSE_LABELS: Record<ProspectListPurpose, string> = {
  buyers: 'Customers',
  investors: 'Investors',
  partners: 'Partners',
  talent: 'Talent',
  custom: 'Custom',
}

/** `prospect_list.status`. */
export const PROSPECT_LIST_STATUSES = ['active', 'archived'] as const
export type ProspectListStatus = (typeof PROSPECT_LIST_STATUSES)[number]

/** `prospect_list.exclude_contacted` — a TRI-STATE, not a boolean. 'ever'
 *  hides anyone ever enrolled; 'active' hides only current enrollments, which
 *  is what a re-engagement list needs; 'off' ignores enrollment entirely. */
export const PROSPECT_EXCLUDE_CONTACTED = ['off', 'active', 'ever'] as const
export type ProspectExcludeContacted = (typeof PROSPECT_EXCLUDE_CONTACTED)[number]

/** `prospect_list_entry.stage`. Note what is NOT here: 'contacted'. That is
 *  derived at read time from `sequence_enrollment`, never shadowed in a
 *  column that would drift the moment someone enrolls from the CRM. */
export const PROSPECT_ENTRY_STAGES = [
  'discovered',
  'shortlisted',
  'saved',
  'dismissed',
] as const
export type ProspectEntryStage = (typeof PROSPECT_ENTRY_STAGES)[number]

/** `prospect_list_entry.kind`. */
export const PROSPECT_ENTRY_KINDS = ['company', 'person'] as const
export type ProspectEntryKind = (typeof PROSPECT_ENTRY_KINDS)[number]

/** `prospect_list_entry.identity_state`. 'anchored' means at least one field
 *  survived `demoteUnrelatedPersonSources` at high/medium against the company
 *  domain; 'needs_review' is excluded from bulk save and needs a per-row
 *  confirm. */
export const PROSPECT_IDENTITY_STATES = [
  'resolved',
  'unresolved',
  'anchored',
  'needs_review',
] as const
export type ProspectIdentityState = (typeof PROSPECT_IDENTITY_STATES)[number]

/** `prospect_list_entry.dismissed_reason`. `competitor` and `already_customer`
 *  suppress WORKSPACE-WIDE (decision 3); the rest are list-relative. */
export const PROSPECT_DISMISSED_REASONS = [
  'not_icp',
  'too_small',
  'too_big',
  'competitor',
  'already_customer',
  'no_contact',
  'other',
] as const
export type ProspectDismissedReason = (typeof PROSPECT_DISMISSED_REASONS)[number]

/** The two reasons whose dismissal suppresses in EVERY list, not just the one
 *  it happened in (decision 3). `not_icp` / `too_small` are genuinely
 *  list-relative and stay per-list. */
export const PROSPECT_GLOBAL_DISMISS_REASONS = [
  'competitor',
  'already_customer',
] as const satisfies readonly ProspectDismissedReason[]

/**
 * The bands `prospect_list_entry.fit_score` — the MATCH SCORE — is read in.
 * Thresholds and labels live in `fit.ts` (`fitLabel`); this is the type both
 * sides share.
 *
 * NOT hot/warm/cold, though that is the vocabulary Exa's own demo uses
 * (Liam, 2026-09-06): the CRM's relationship strength already speaks it, and
 * a "hot" list row beside a "cold" contact was two scales wearing one word.
 *
 * There is no tier column any more. Discovery does not score at all (a
 * substring match over a one-line blurb measured as noise, 2026-09-05), the
 * full profile scores ONCE with the whole card in hand, and the number is the
 * model's 0–100 rating, not a rule engine's.
 */
export const PROSPECT_FIT_LABELS = ['strong', 'good', 'partial', 'weak'] as const
export type ProspectFitLabel = (typeof PROSPECT_FIT_LABELS)[number]

/**
 * `prospecting_run.status`. This is the `AgentRunStatus` vocabulary
 * (src/lib/agent-run/types.ts) MINUS 'pr_open' (coding-run only) PLUS
 * 'budget_exhausted'. The divergence is deliberate and otherwise silent — a
 * test pins it. `isAgentRunLive` still applies to the shared values, so the
 * poll's isLive(status) gate is the same predicate.
 */
export const PROSPECTING_RUN_STATUSES = [
  'queued',
  'running',
  'needs_input',
  'canceling',
  'completed',
  'failed',
  'canceled',
  'budget_exhausted',
] as const
export type ProspectingRunStatus = (typeof PROSPECTING_RUN_STATUSES)[number]

/**
 * The statuses of a run that is still in flight — pollable, cancelable, and
 * a reason to refuse deleting its list (the engine re-reads the list's rows
 * per iteration). The same predicate `isAgentRunLive` applies over the shared
 * agent-run vocabulary; this is the prospecting subset spelled out.
 */
export const PROSPECTING_RUN_LIVE_STATUSES: readonly ProspectingRunStatus[] = [
  'queued',
  'running',
  'needs_input',
  'canceling',
]

/** `prospecting_run.stage` and `ProspectingRunProgress.stage`. */
export const PROSPECTING_RUN_STAGES = [
  'discover',
  'score',
  'account_card',
  'people',
  'done',
] as const
export type ProspectingRunStage = (typeof PROSPECTING_RUN_STAGES)[number]

/** `prospecting_run.kind`. */
export const PROSPECTING_RUN_KINDS = ['discover', 'account_card', 'people'] as const
export type ProspectingRunKind = (typeof PROSPECTING_RUN_KINDS)[number]

/** `prospect_run_candidate.outcome`. */
export const PROSPECT_CANDIDATE_OUTCOMES = ['new', 'suppressed', 'invalid'] as const
export type ProspectCandidateOutcome = (typeof PROSPECT_CANDIDATE_OUTCOMES)[number]

/** `prospect_run_candidate.suppressed_by` — the exclusion rule that caught the
 *  candidate. Exactly the keys of {@link ProspectingRunCounts}.
 *
 *  In lockstep with migration **251**, not 248: 251 widened the CHECK with
 *  `over_cap` and `noise_host`, the two reasons that previously had to
 *  borrow a value that misdescribed them (a person turned away by
 *  `people_per_company` was reported as `this_list`; a linkedin.com result
 *  host as `personal_domain`). New values go at the END — the lockstep test
 *  asserts ORDER, and 251's CHECK list appends rather than reshuffles so the
 *  diff of a future widening stays readable. */
export const PROSPECT_SUPPRESSION_SOURCES = [
  'this_list',
  'crm',
  'other_list',
  'dismissed_global',
  'contacted',
  'opted_out',
  'personal_domain',
  'self',
  /** A person the company's `people_per_company` cap turned away. The row is
   *  RECORDED, never dropped: "show me the other four" is the obvious next
   *  question and the ledger has to be able to answer it. */
  'over_cap',
  /** A platform/aggregator host — linkedin.com, crunchbase.com, a recruiter
   *  site. Distinct from `personal_domain`, which means webmail. */
  'noise_host',
] as const
export type ProspectSuppressionSource = (typeof PROSPECT_SUPPRESSION_SOURCES)[number]

/** How a candidate reached us: synthesized by Exa's output schema, or lifted
 *  free from `results[].entities[]`. */
export const PROSPECT_FOUND_VIA = ['synthesized', 'result_entity'] as const
export type ProspectFoundVia = (typeof PROSPECT_FOUND_VIA)[number]

// ---------------------------------------------------------------------------
// The ICP object (§4)
// ---------------------------------------------------------------------------

/**
 * `prospect_list.icp`, versioned by `icp_version`. Prose-shaped, not
 * filter-shaped: Exa's deep search consumes a query string and a systemPrompt,
 * so every structured filter would be flattened back to prose before the call
 * — a filter UI would be a lossy intermediate the user tunes and cannot debug.
 *
 * Every field is seeded from the workspace's own enriched company row and is
 * editable. The seed is a proposal, never a commitment.
 */
export interface Icp {
  source: {
    company_id: string
    name: string
    domain: string
    /** `products_and_services` from the enrichment blob, falling back to
     *  `company.description`, then `industry`. */
    what_we_sell: string
    /** `knownCustomers` from COMPANY_CARD_ICP, split into names. */
    our_customers: string[]
  }
  target: {
    /** THE field. Everything else is optional narrowing. */
    description: string
    industries: string[]
    /** '11-50' | '51-200' | '201-1000' | '1000+' and friends — free text, not
     *  pinned to EMPLOYEE_COUNT_RANGES, because it is prose in a prompt. */
    employee_bands: string[]
    geographies: string[]
    /** Drives the people stage's query. */
    buyer_titles: string[]
    use_cases: string[]
    competitors: string[]
    /** Named companies/portfolios the angles cite as evidence. Seeded from the
     *  ICP card's competitors + our_customers, and user-editable. It exists
     *  because the investor angles need portfolio evidence (§7). */
    comparables: string[]
  }
  anti: {
    exclude_industries: string[]
    exclude_keywords: string[]
    notes: string
  }
  /** Free text appended to every angle — the power-user escape hatch. */
  search_hint: string
}

/** The candidate identity itself, carried in `prospect_list_entry.candidate`. */
export interface ProspectCandidate {
  name?: string | null
  domain?: string | null
  linkedin_url?: string | null
  email?: string | null
  title?: string | null
  seniority?: string | null
  one_liner?: string | null
  /** Stable Exa id from `https://exa.ai/library/organization/<id>`. */
  exa_entity_id?: string | null
  found_via?: ProspectFoundVia
  /**
   * PERSON ONLY, and DENORMALISED at insert by the people stage.
   *
   * A person entry's `company_id` is NULL by construction (248's CHECK:
   * person ⇒ company_id NULL) and the shared views select
   * (`PROSPECT_ENTRY_VIEW_SELECT`, src/lib/views/query-engine.ts) carries no
   * join, so the parent account's name cannot be read off the row any other
   * way. The People tab's row and its detail panel both need it, and a
   * self-join on `parent_entry_id` inside the shared query engine would be a
   * feature-specific join in generic code for one cell. `candidate.domain` on
   * a person is the employer's domain (the search was anchored to it) and is
   * the fallback when this is absent.
   */
  company_name?: string | null
  /**
   * COMPANY ONLY. When the account-card stage (Stage 3b) last completed for
   * this entry, ISO-8601.
   *
   * THE STAMP EXISTS BECAUSE "HAS RESEARCH" IS NOT "HAS BEEN RESEARCHED".
   * Discovery already writes a `research` blob — `name`, `domain`, `signal`,
   * `one_liner`, `why_match`, `founded_year`, `employee_range` — so a gate
   * keyed on "the blob is non-empty" reports every discovered company as
   * researched and offers the account card to nobody. It was observed live:
   * 44 discovered companies read as researched and one hand-added company
   * (the only entry with a genuinely empty blob) was the whole research
   * queue.
   *
   * An explicit stamp is the only honest signal, because the two stages write
   * to the SAME column and merge additively — there is no key whose presence
   * distinguishes them for certain, only a heuristic (see `hasAccountCard` in
   * `lists.ts`, which keeps that heuristic as the fallback for rows written
   * before this field existed).
   */
  account_card_at?: string | null
  /**
   * When the people search last ran for this company — written by the people
   * engine after each company's one call, whether or not anyone was found.
   * The list page reads it against the live run's start time to take the
   * searching orb off a row whose search is over. Nothing else keys off it: a
   * company where nobody was found is still offered Find people, on purpose —
   * "try again" is the user's call, not the engine's.
   */
  people_searched_at?: string | null
  /**
   * COMPANY ONLY. What the LAST people search for this company saw, written
   * beside `people_searched_at` by the people engine (`stampSearched`).
   *
   * The ledger (`prospect_run_candidate`) is the record; this is the row's
   * own summary of it, so the list row and the entry panel can say "1 found,
   * already in this list" without a second fetch. It exists because a search
   * whose every hit was a duplicate read as "No people found yet", and the
   * user retried it three times at $0.012 a go (Solenne Ventures, 2026-09-07:
   * the one person Exa returned already sat under a ghost row of the same
   * firm). Read through `readPeopleSearch` in ./people-search.
   */
  people_search?: ProspectPeopleSearch | null
}

/** How many known people the stamp names. The ledger holds the rest. */
export const PEOPLE_SEARCH_KNOWN_CAP = 10

/** `candidate.people_search` — see {@link ProspectCandidate.people_search}. */
export interface ProspectPeopleSearch {
  /** When the search finished — the same instant as `people_searched_at`. */
  at: string
  /** Everyone the search returned. */
  found: number
  /** New person rows written under this company. */
  added: number
  /** People the search returned that were turned away as already known: the
   *  rule that turned each away, and the row they duplicate when it is on
   *  this list (null for a CRM contact or an outreach record). At most
   *  {@link PEOPLE_SEARCH_KNOWN_CAP}. */
  known: Array<{ name: string | null; by: ProspectSuppressionSource; ref_id: string | null }>
  /** People `people_per_company` had no room for. */
  capped: number
  /** Results with no usable identity. */
  invalid: number
}

// ---------------------------------------------------------------------------
// Typed run state (§3) — the contract most likely to break silently
// ---------------------------------------------------------------------------

/**
 * `prospecting_run.progress`. This and the two below are the interface between
 * the Inngest writer and the polling UI; untyped jsonb here produces a
 * permanently blank progress bar that no test catches.
 */
export interface ProspectingRunProgress {
  stage: ProspectingRunStage
  round: number
  max_rounds: number
  angle_index: number
  found: number
  suppressed: number
  new: number
  invalid: number
  accounts_done: number
  accounts_total: number
  people_found: number
  people_target: number
  spent_dollars: number
  exa_calls: number
  updated_at: string
}

/** Per-reason suppression tally, written to `prospecting_run.counts`. Keys are
 *  exactly the `suppressed_by` enum ({@link PROSPECT_SUPPRESSION_SOURCES}). */
export interface ProspectingRunCounts {
  this_list: number
  crm: number
  other_list: number
  dismissed_global: number
  contacted: number
  opted_out: number
  self: number
  personal_domain: number
  over_cap: number
  noise_host: number
}

/** `prospecting_run.exclusion_snapshot` — written at preflight so the UI can
 *  say "excluding 412 domains you already know." */
export interface ExclusionSnapshot {
  domain_count: number
  sources: Partial<Record<keyof ProspectingRunCounts, number>>
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ProspectListRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  purpose: ProspectListPurpose
  /** jsonb — parse/validate into {@link Icp} rather than casting blind. */
  icp: unknown
  icp_version: number
  source_company_id: string | null
  exclude_crm: boolean
  exclude_other_lists: boolean
  exclude_contacted: ProspectExcludeContacted
  /** numeric(10,4) — PostgREST returns numerics as JS numbers here. */
  max_spend_dollars: number
  target_new_candidates: number
  max_rounds: number
  people_per_company: number
  status: ProspectListStatus
  created_by: string | null
  /** When the list was last PUBLISHED into the CRM (migration 259) — the
   *  moment its saved entries became a group of CRM rows. NULL for a list
   *  that has only ever been curated. */
  published_at: string | null
  published_by: string | null
  created_at: string
  updated_at: string
}

export interface ProspectListEntryRow {
  id: string
  workspace_id: string
  list_id: string
  kind: ProspectEntryKind
  /** The identity. See src/lib/prospecting/keys.ts. */
  candidate_key: string
  /** jsonb; shape is {@link ProspectCandidate}. */
  candidate: unknown
  /** NULL until Publish. ON DELETE SET NULL — the entry outlives the CRM row. */
  company_id: string | null
  contact_id: string | null
  parent_entry_id: string | null
  /** `saved` = ON THE LIST (curation, no CRM write). The CRM row exists only
   *  once the list is published — see `published_at`. */
  stage: ProspectEntryStage
  identity_state: ProspectIdentityState
  /** When this entry last went into the CRM group (migration 259). NULL while
   *  it is saved but unpublished, and cleared when it leaves `saved`, so
   *  "pending publish" is always `stage = 'saved' AND published_at IS NULL`. */
  published_at: string | null
  /** NULL until the full profile has scored the company (or an ICP anti-rule
   *  matched at discovery, which writes 0). Read through `fitLabel`. */
  fit_score: number | null
  /** The "why": discovery's why-match sentence, replaced by the profile's
   *  why-fit paragraph, or the anti-rule that zeroed the score. */
  fit_rationale: string | null
  dismissed_reason: ProspectDismissedReason | null
  dismissed_by: string | null
  dismissed_at: string | null
  icp_version: number
  discovered_by_run_id: string | null
  discovery_angle: string | null
  /** jsonb, SAME SHAPE as `company.metadata.enrichment.fields`, so promotion
   *  merges it with the existing columnCandidates / mergeBlobFields
   *  discipline and `readBlob` renders it with no new display code. */
  research: unknown
  sources: unknown
  created_at: string
  updated_at: string
}

export interface ProspectingRunRow {
  id: string
  workspace_id: string
  list_id: string
  kind: ProspectingRunKind
  round_index: number
  status: ProspectingRunStatus
  stage: ProspectingRunStage
  /** The ICP AS RUN — run history stays honest about what was searched. */
  icp_snapshot: unknown
  target_entry_ids: string[] | null
  budget_dollars: number
  spent_dollars: number
  exa_calls: number
  /** jsonb; shape is {@link ProspectingRunProgress}. */
  progress: unknown
  /** jsonb; shape is {@link ProspectingRunCounts}. */
  counts: unknown
  /** jsonb; shape is {@link ExclusionSnapshot}. */
  exclusion_snapshot: unknown
  error: string | null
  started_by: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export interface ProspectRunCandidateRow {
  id: string
  workspace_id: string
  run_id: string
  list_id: string
  identity_key: string
  display_name: string | null
  raw: unknown
  discovery_angle: string | null
  outcome: ProspectCandidateOutcome
  suppressed_by: ProspectSuppressionSource | null
  /** The CRM record or entry that caused the suppression, for the UI's link. */
  suppressed_ref_id: string | null
  entry_id: string | null
  created_at: string
}
