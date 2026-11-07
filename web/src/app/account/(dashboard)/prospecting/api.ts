/**
 * Client-side fetch layer for the Prospecting UI — one place that knows the
 * route shapes (src/app/api/account/prospecting/*) and the error envelope
 * ({ error, code, details } via src/lib/api-errors).
 *
 * Modelled on src/app/account/(dashboard)/sequences/api.ts, including the
 * thrown-error class carrying the parsed code, because the two surfaces share
 * exactly one non-generic failure shape each that the UI must branch on:
 * sequences has `step_guarded`, prospecting has `LIST_NAME_TAKEN`.
 *
 * ONE deliberate non-throw: `addEntryByDomain` returns `{status:'exists'}` on
 * a `UNIQUE (list_id, candidate_key)` collision with HTTP 200 and the existing
 * row. That is dedup layer 2 working (§6), not an error — the caller scrolls
 * to the row it already has rather than showing a failure.
 */

import type {
  IcpDraft,
} from '@/lib/prospecting/icp'
import type {
  PromotedEntry,
  ProspectListWithCounts,
  EntryStageCounts,
  SkippedEntry,
} from '@/lib/prospecting/lists'
import type { SourceCompanyResolvedBy, SourceCompanyRow } from '@/lib/prospecting/source-company'
import type { AngleTelemetryRow } from '@/lib/prospecting/telemetry'
import type {
  Icp,
  ProspectCandidateOutcome,
  ProspectDismissedReason,
  ProspectEntryStage,
  ProspectListPurpose,
  ProspectListRow,
  ProspectListEntryRow,
  ProspectingRunKind,
  ProspectRunCandidateRow,
  ProspectSuppressionSource,
  ProspectingRunRow,
} from '@/lib/prospecting/types'

// ── Shapes returned by the routes ────────────────────────────────────────

/** The three exclusion toggles' live counts (GET/POST /source). */
export interface ExclusionCountsPayload {
  crm_companies: number
  other_lists: number
  contacted_people: number
}

/** What `fireIcpCard` reported, echoed by POST /source. */
export interface IcpCardOutcome {
  status: 'fired' | 'skipped' | 'empty' | 'failed'
  reason?: string
  fields?: string[]
  error?: string
  cost?: number
  /** True only when THIS call reached Exa and merged at least one field, so a
   *  caller can say "we found who buys it" without re-deriving it from
   *  `status`. Every other outcome — skipped, empty, failed — is false. */
  fired?: boolean
  /** How many field keys the card contributed. 0 for every non-`fired`
   *  outcome. */
  fields_count?: number
}

export interface SourcePayload {
  source: SourceCompanyRow | null
  resolved_by: SourceCompanyResolvedBy
  /** One draft per purpose, so the sheet's template switcher never refetches. */
  icp_draft_by_purpose: Record<ProspectListPurpose, IcpDraft>
  counts: ExclusionCountsPayload
  /**
   * `companyDomainFromEmail(caller email)` when the resolver found NOTHING —
   * null for a personal/webmail address, and null whenever a source already
   * resolved. It exists so the "We don't know your company yet" card can
   * pre-fill the input from the address the user already signed in with: a
   * business signup should press one button, never type its own domain.
   */
  suggested_domain?: string | null
  /** POST only. */
  icp_card?: IcpCardOutcome
  /** POST only — whether this call CREATED/re-pointed the workspace company. */
  established?: boolean
  /** POST only — whether the full company enrichment was kicked, was already
   *  running/done, or was deliberately not attempted. */
  enrichment?: 'started' | 'already' | 'skipped'
}

export interface ListDetailPayload {
  list: ProspectListRow
  entries: ProspectListEntryRow[]
  entry_counts: EntryStageCounts
}

export interface AddEntryResult {
  entry: ProspectListEntryRow
  /** 'exists' means the candidate was already on this list — the collision is
   *  the dedup guarantee, and the UI reveals the existing row. */
  status: 'created' | 'exists'
}

/**
 * One promoted entry and the CRM record it became — re-exported under the name
 * the UI uses, because two of its fields are the whole reason the save route
 * returns per-entry outcomes at all (§8): `kind` says whether the row became a
 * `company` or a `contact`, and `email` is the ONLY authority on whether that
 * contact can be enrolled. A person promoted through `findOrCreateContact` may
 * have matched an EXISTING contact that already held an address the discovered
 * candidate never carried, so reading it off the pre-save `candidate` blob
 * would routinely exclude people who are perfectly enrollable.
 */
export type SavedEntry = PromotedEntry

export interface SaveResult {
  saved: SavedEntry[]
  skipped: SkippedEntry[]
}

// ── Errors ───────────────────────────────────────────────────────────────

export interface ProspectingApiError {
  message: string
  /** The envelope code ('LIST_NAME_TAKEN', 'INVALID_DOMAIN', 'BAD_REQUEST', …). */
  code: string
  details: Record<string, unknown> | null
  status: number
}

export class ProspectingRequestError extends Error {
  apiError: ProspectingApiError
  constructor(apiError: ProspectingApiError) {
    super(apiError.message)
    this.name = 'ProspectingRequestError'
    this.apiError = apiError
  }
}

async function parseError(res: Response): Promise<ProspectingApiError> {
  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const details =
    body.details && typeof body.details === 'object'
      ? (body.details as Record<string, unknown>)
      : null
  return {
    message: typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    // The envelope's own `code` is the contract (@/lib/api-errors); `details.code`
    // is only a fallback for any route that still tucks it in there.
    code:
      (typeof body.code === 'string' && body.code !== 'BAD_REQUEST' ? body.code : null) ??
      (details && typeof details.code === 'string' ? details.code : null) ??
      (typeof body.code === 'string' ? body.code : 'UNKNOWN'),
    details,
    status: res.status,
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ProspectingRequestError(await parseError(res))
  return (await res.json()) as T
}

/** The parsed code for a thrown request error, or null for anything else. */
export function errorCode(err: unknown): string | null {
  return err instanceof ProspectingRequestError ? err.apiError.code : null
}

/** A message safe to show the user for any thrown value. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ProspectingRequestError) return err.apiError.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// ── Source company + ICP drafts ──────────────────────────────────────────

/** The workspace's own company, one ICP draft per purpose, and the live
 *  exclusion counts — everything the New-list sheet needs, in one trip. */
export async function fetchSource(): Promise<SourcePayload> {
  return jsonOrThrow<SourcePayload>(await fetch('/api/account/prospecting/source'))
}

/**
 * Establish and/or research the workspace's own company, returning the
 * refreshed source + drafts.
 *
 * With NO domain this is the original behaviour: fire `COMPANY_CARD_ICP`
 * against the already-resolved company. Idempotent server-side — an
 * already-carded company comes back `skipped: 'already_present'` having spent
 * nothing, which is what makes the button safe to press twice.
 *
 * WITH a domain it is also the step-4 path §4 always specified and PROD never
 * had: the route creates the company from the domain, flags it
 * `is_workspace_company`, links the caller's self-contact, and kicks the same
 * full enrichment the CRM's Enrich button does. Passing a domain that differs
 * from the currently flagged company RE-POINTS the workspace — the visible
 * "Not your company?" correction.
 *
 * Throws {@link ProspectingRequestError} with code `NEEDS_DOMAIN`,
 * `PERSONAL_DOMAIN` or `INVALID_DOMAIN`; see {@link sourceDomainErrorMessage}.
 */
export async function researchSource(domain?: string | null): Promise<SourcePayload> {
  const trimmed = typeof domain === 'string' ? domain.trim() : ''
  return jsonOrThrow<SourcePayload>(
    await fetch('/api/account/prospecting/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // An empty body would be `{}` either way; sending the domain only when
      // there is one keeps "research what you already resolved" and "establish
      // this domain" distinguishable in a network log.
      body: JSON.stringify(trimmed ? { domain: trimmed } : {}),
    }),
  )
}

/**
 * Save what the company sells, in the user's own words.
 *
 * The escape hatch for the state the production report named: enrichment
 * FINISHED and still could not tell what the company sells, so the empty state
 * asks in one line rather than leaving "we know your company but not what it
 * sells" on screen with nothing to do about it.
 *
 * It PATCHes `company.description` — deliberately NOT a prospecting-only
 * field — because `buildIcpDraft`'s `what_we_sell` chain is
 * `blob.products_and_services → company.description → company.industry`, so
 * one sentence typed here seeds every ICP draft on the next GET /source, and
 * shows up on the company record in the CRM where the user would look for it.
 */
export async function saveCompanyDescription(
  companyId: string,
  description: string,
): Promise<void> {
  await jsonOrThrow<{ company: unknown }>(
    await fetch(`/api/account/companies/${companyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    }),
  )
}

// ── Lists ────────────────────────────────────────────────────────────────

export async function fetchLists(includeArchived = false): Promise<ProspectListWithCounts[]> {
  const qs = includeArchived ? '?include_archived=true' : ''
  const data = await jsonOrThrow<{ lists: ProspectListWithCounts[] }>(
    await fetch(`/api/account/prospecting/lists${qs}`),
  )
  return data.lists
}

export interface CreateListBody {
  name: string
  description?: string | null
  purpose: ProspectListPurpose
  icp: Icp
  source_company_id?: string | null
  exclude_crm?: boolean
  exclude_other_lists?: boolean
  exclude_contacted?: 'off' | 'active' | 'ever'
}

export async function createList(body: CreateListBody): Promise<ProspectListRow> {
  const data = await jsonOrThrow<{ list: ProspectListRow }>(
    await fetch('/api/account/prospecting/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return data.list
}

export async function fetchList(id: string): Promise<ListDetailPayload> {
  return jsonOrThrow<ListDetailPayload>(await fetch(`/api/account/prospecting/lists/${id}`))
}

/** PATCH the list. An ICP edit bumps `icp_version` server-side only when the
 *  normalized ICP actually differs — `icp_version_bumped` says whether it did,
 *  so the UI can be honest rather than drifting every entry badge on a no-op. */
/**
 * The run-shaping fields `updateProspectList` accepts but `CreateListBody`
 * does not name: they are not part of creating a list (the sheet's Advanced
 * disclosure sets them from defaults), but the run surface edits them —
 * "Raise cap" on a `budget_exhausted` outcome is a `max_spend_dollars` PATCH.
 * Every one is clamped server-side (src/lib/prospecting/lists.ts:453).
 */
export interface ListRunSettings {
  max_spend_dollars: number
  target_new_candidates: number
  max_rounds: number
  people_per_company: number
}

export async function patchList(
  id: string,
  body: Partial<CreateListBody> &
    Partial<ListRunSettings> & { status?: 'active' | 'archived' },
): Promise<{ list: ProspectListRow; icp_version_bumped: boolean }> {
  return jsonOrThrow<{ list: ProspectListRow; icp_version_bumped: boolean }>(
    await fetch(`/api/account/prospecting/lists/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

// ── Entries ──────────────────────────────────────────────────────────────

/**
 * Hand-add one company by domain. A 200 with `status:'exists'` is the dedup
 * guarantee firing, NOT a failure — see the module header.
 */
export async function addEntryByDomain(
  listId: string,
  domain: string,
  name?: string | null,
): Promise<AddEntryResult> {
  return jsonOrThrow<AddEntryResult>(
    await fetch(`/api/account/prospecting/lists/${listId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, name: name ?? null }),
    }),
  )
}

export async function fetchEntry(entryId: string): Promise<ProspectListEntryRow> {
  const data = await jsonOrThrow<{ entry: ProspectListEntryRow }>(
    await fetch(`/api/account/prospecting/entries/${entryId}`),
  )
  return data.entry
}

/** Set an entry's stage. `saved` is refused by the route — that stage asserts
 *  a CRM record exists, which only `saveEntries` can make true. */
export async function patchEntryStage(
  entryId: string,
  stage: Exclude<ProspectEntryStage, 'saved'>,
  dismissedReason?: ProspectDismissedReason,
): Promise<ProspectListEntryRow> {
  const data = await jsonOrThrow<{ entry: ProspectListEntryRow }>(
    await fetch(`/api/account/prospecting/entries/${entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, dismissed_reason: dismissedReason }),
    }),
  )
  return data.entry
}

/**
 * Promote entries into the CRM. Returns PER-ENTRY outcomes, never a count —
 * the caller reconciles its selection against both arrays (§8). An empty
 * `saved` with a full `skipped` is a correct 200, not an error.
 *
 * `includeUnverified` is the ONE-ROW ESCAPE HATCH for a `needs_review` person
 * (§8): the people stage could not confirm the employer from the company's own
 * domain, so bulk save holds them back with `reason: 'needs_review'` and the
 * UI offers a per-row confirm that re-sends THAT SINGLE ID with the flag. It
 * is deliberately not a bulk control — waving through twenty unconfirmed
 * identities in one click is exactly the Devin Marsh failure at scale, and
 * the flag defaults to false server-side.
 */
/**
 * Save — keep these entries ON THE LIST (curation; never a CRM write, as of
 * migration 259). Same per-entry outcome shape as Publish, so the page
 * reconciles both with one loop.
 */
export async function saveEntries(entryIds: string[]): Promise<SaveResult> {
  return jsonOrThrow<SaveResult>(
    await fetch('/api/account/prospecting/entries/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry_ids: entryIds }),
    }),
  )
}

/** What a publish did: Save's per-entry outcomes plus the lists it touched
 *  and the stamp it wrote (null when nothing landed). */
export interface PublishResult extends SaveResult {
  list_ids: string[]
  published_at: string | null
  /** The list-level publish names the list; the entry-level one does not. */
  list_name?: string | null
}

/**
 * Publish SPECIFIC entries into the CRM — the per-row `needs_review` confirm
 * (one id, `includeUnverified`) and Add-to-sequence, which needs contact ids
 * now. Everything else publishes the whole list through {@link publishList}.
 */
export async function publishEntries(
  entryIds: string[],
  includeUnverified = false,
): Promise<PublishResult> {
  const body: Record<string, unknown> = { entry_ids: entryIds }
  if (includeUnverified) body.include_unverified = true
  return jsonOrThrow<PublishResult>(
    await fetch('/api/account/prospecting/entries/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/** Publish everything pending on the list — the header's Publish button. */
export async function publishList(listId: string): Promise<PublishResult> {
  return jsonOrThrow<PublishResult>(
    await fetch(`/api/account/prospecting/lists/${listId}/publish`, { method: 'POST' }),
  )
}

// ── Sequenced state (derived, never stored) ──────────────────────────────

/**
 * One saved contact's sequence membership, as the route derives it from
 * `sequence_enrollment` joined to `sequence`. There is NO `stage='contacted'`
 * and no column on the entry: the enrollment table is the single owner, and
 * anything cached on the entry would go stale the moment a sequence is edited
 * elsewhere (§8, "the Sequenced chip is derived at read time").
 */
export interface SequencedState {
  status: 'active' | 'exited'
  sequence_id: string
  sequence_name: string
}

/** contact_id → membership, for every SAVED contact on this list. Contacts
 *  with no enrollment are simply absent from the map. */
export type SequencedMap = Record<string, SequencedState>

export async function fetchSequenced(listId: string): Promise<SequencedMap> {
  // The route answers `{ sequenced: {...} }`, NOT a bare map — unwrap it here.
  // `jsonOrThrow` is an unchecked cast, so typing the body as the map compiles
  // cleanly and then misses on every lookup at runtime: no chip would ever
  // render and nothing would fail loudly. `?? {}` keeps a malformed body from
  // taking the page down; the chip is decoration, not load-bearing.
  const body = await jsonOrThrow<{ sequenced?: SequencedMap }>(
    await fetch(`/api/account/prospecting/lists/${listId}/sequenced`),
  )
  return body?.sequenced ?? {}
}

// ── Runs ─────────────────────────────────────────────────────────────────

/**
 * `is_live` comes from the SERVER, not from a client-side status list. The
 * `prospecting_run` vocabulary diverges from `AgentRunStatus` (no `pr_open`,
 * plus `budget_exhausted`), and a poll loop that recomputed liveness locally
 * would spin forever on a budget-exhausted run.
 */
export interface RunPayload extends ProspectingRunRow {
  is_live: boolean
}

export interface RunCandidateLink {
  kind: 'entry' | 'company' | 'contact'
  id: string
}

export interface RunCandidatePayload extends ProspectRunCandidateRow {
  link: RunCandidateLink | null
}

export interface RunCandidateGroupPayload {
  outcome: ProspectCandidateOutcome
  /** null for the `new` and `invalid` groups, which have no suppression rule. */
  reason: ProspectSuppressionSource | null
  count: number
  candidates: RunCandidatePayload[]
}

export interface RunCandidatesPayload {
  run: RunPayload
  groups: RunCandidateGroupPayload[]
  total: number
}

/**
 * What one kickoff asks for. ONE route and ONE event serve all three kinds
 * (§14 PR 5) — the Inngest function reads `run.kind` and dispatches — so the
 * only thing that varies here is which entries the paid per-company stages are
 * allowed to touch.
 *
 * `entry_ids` is REQUIRED for `account_card` and `people` and is the whole
 * cost guarantee (§9, "Explicit target_entry_ids selection"): those stages run
 * only on the entries the user picked at the gate, never the whole list. The
 * route enforces company-kind, this-list, not-dismissed and a 50-per-run cap.
 */
export interface StartRunOptions {
  kind?: ProspectingRunKind
  /** Required for `account_card` and `people`; ignored for `discover`. */
  entryIds?: string[]
  /** Overrides the list's `max_spend_dollars` for this run only, clamped
   *  server-side to 0.25..20. */
  budgetDollars?: number
}

/**
 * Kick off a run.
 *
 * A second press while a run is live throws with code `RUN_ALREADY_LIVE` (409)
 * — that is the partial unique index doing its job, and the UI should surface
 * the run already in flight rather than a failure. The index is per LIST, not
 * per kind: an account-card run and a people run cannot overlap either, which
 * is why the gate commits one at a time.
 *
 * Overload kept for the discovery callers written before the other two kinds
 * existed: `startRun(listId, 2)` still means "a discovery run capped at $2".
 */
export async function startRun(
  listId: string,
  optionsOrBudget?: StartRunOptions | number,
): Promise<RunPayload> {
  const options: StartRunOptions =
    typeof optionsOrBudget === 'number'
      ? { budgetDollars: optionsOrBudget }
      : (optionsOrBudget ?? {})

  const body: Record<string, unknown> = {}
  if (options.kind && options.kind !== 'discover') body.kind = options.kind
  if (options.entryIds && options.entryIds.length > 0) body.entry_ids = options.entryIds
  if (options.budgetDollars !== undefined) body.budget_dollars = options.budgetDollars

  const data = await jsonOrThrow<{ run: RunPayload }>(
    await fetch(`/api/account/prospecting/lists/${listId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return data.run
}

/** This list's run history, newest first. */
export async function fetchRuns(listId: string, limit?: number): Promise<RunPayload[]> {
  const qs = limit === undefined ? '' : `?limit=${limit}`
  const data = await jsonOrThrow<{ runs: RunPayload[] }>(
    await fetch(`/api/account/prospecting/lists/${listId}/runs${qs}`),
  )
  return data.runs
}

/** One run — the 3s poll target. Re-arm the timeout only while `is_live`. */
export async function fetchRun(runId: string): Promise<RunPayload> {
  const data = await jsonOrThrow<{ run: RunPayload }>(
    await fetch(`/api/account/prospecting/runs/${runId}`),
  )
  return data.run
}

/**
 * Ask a live run to stop. The returned run reads `canceling`, not `canceled`:
 * the engine settles it once it stops between steps, keeping partial results.
 * A run that already finished throws with code `NOT_CANCELABLE` (409).
 */
export async function cancelRun(runId: string): Promise<RunPayload> {
  const data = await jsonOrThrow<{ run: RunPayload }>(
    await fetch(`/api/account/prospecting/runs/${runId}/cancel`, { method: 'POST' }),
  )
  return data.run
}

/** The run's candidate ledger — the collapsed "17 skipped" row's contents,
 *  grouped by outcome and suppression reason. */
export async function fetchRunCandidates(runId: string): Promise<RunCandidatesPayload> {
  return jsonOrThrow<RunCandidatesPayload>(
    await fetch(`/api/account/prospecting/runs/${runId}/candidates`),
  )
}

// ── Monthly spend (§9, the workspace ceiling) ────────────────────────────

/**
 * The workspace's prospecting spend for the current UTC calendar month, the
 * ceiling it is measured against, and when that ceiling resets.
 *
 * WHY THIS IS ITS OWN ROUTE and not a field on the lists index: the ceiling is
 * a WORKSPACE fact, not a list fact, and it is read from two places that have
 * no list in hand (the Prospecting index header, and the Find dialog before a
 * run exists). Widening the lists payload would put a workspace number on
 * every card and still leave the dialog with nothing to read on a list that
 * has never been run.
 *
 * `resets_at` is the first instant of the NEXT UTC month, computed server-side
 * from the same `monthStartIso` boundary the engine sums against — a client
 * that derived it from its own clock would say "resets Oct 1" to a user whose
 * timezone has already rolled over while the ceiling has not.
 */
export interface SpendPayload {
  month_spent_dollars: number
  cap_dollars: number
  /** ISO — the first instant of the next UTC calendar month. */
  resets_at: string
}

export async function fetchSpend(): Promise<SpendPayload> {
  return jsonOrThrow<SpendPayload>(await fetch('/api/account/prospecting/spend'))
}

// ── Per-angle telemetry (§7, the four angles) ────────────────────────────

/**
 * One discovery angle's yield on this list, across every run.
 *
 * `found` is candidates the angle produced (`prospect_run_candidate`, all
 * outcomes), `new` is the entries that survived dedup, `saved` is how many of
 * THOSE reached the CRM. The three narrow monotonically, which is the whole
 * point: an angle with a big `found` and a zero `saved` is generating noise,
 * and that is a fact about the ICP the user can act on by editing it.
 */
/**
 * Aliased to the server's own row type rather than re-declared, so a renamed
 * column moves the compile here instead of leaving the table silently
 * rendering `undefined` under four correct-looking headers.
 */
export type AngleStatsPayload = AngleTelemetryRow

export async function fetchAngles(listId: string): Promise<AngleStatsPayload[]> {
  // The route answers `{ angles: [...] }`, NOT a bare array — unwrap it here.
  // `jsonOrThrow` is an unchecked cast, so typing the body as the array would
  // compile cleanly and then hand every caller an object with no `.map`, which
  // is a render crash rather than a missing section. `?? []` keeps a malformed
  // body from taking the run-history popover down over its own footnote.
  const body = await jsonOrThrow<{ angles?: AngleStatsPayload[] }>(
    await fetch(`/api/account/prospecting/lists/${listId}/angles`),
  )
  return Array.isArray(body?.angles) ? body.angles : []
}

// ── Active runs, workspace-wide (§B5) ────────────────────────────────────

/**
 * A live run anywhere in the workspace, carrying the name of the list it
 * belongs to.
 *
 * WHY `list_name` RIDES ON THE RUN and is not looked up client-side: the two
 * consumers that need it (the nav dot's tooltip and the index header line)
 * have no `prospect_list` row in hand — the nav rail never loads the lists
 * index at all. Joining server-side costs nothing and removes a whole class of
 * "the run is live but we don't know whose it is" state.
 */
export interface ActiveRunPayload extends RunPayload {
  list_name: string
}

/**
 * Every queued/running/canceling run in this workspace, newest first.
 *
 * The ONE workspace-wide run read. It exists because a run can now be started
 * by Scout in the chat strip, or by the same user in another tab, and nothing
 * on the page would otherwise learn about it: `useRunPoll` only resumes an
 * unknown run at MOUNT, and the index fetched each list's newest run exactly
 * once. Polling one small route beats N per-list history probes on a cadence.
 */
export async function fetchActiveRuns(): Promise<ActiveRunPayload[]> {
  // `{ runs: [...] }`, not a bare array — `jsonOrThrow` is an unchecked cast,
  // so typing this as the array would compile and then hand every consumer an
  // object with no `.map`. `?? []` keeps a malformed body from taking down a
  // page whose live dot is decoration.
  const body = await jsonOrThrow<{ runs?: ActiveRunPayload[] }>(
    await fetch('/api/account/prospecting/runs/active'),
  )
  return Array.isArray(body?.runs) ? body.runs : []
}
