/**
 * What all three run kinds share (spec §7, §9).
 *
 * `discover`, `account_card` and `people` are three different loops over three
 * different units of work — angles, target companies, target companies again
 * — but they are the SAME run: the same row, the same CAS-claimed lifecycle,
 * the same two spend gates, the same cancel poll, and above all the same rule
 * that **every terminal write happens in the engine**. This module is that
 * common half, extracted from `run.ts` verbatim rather than reimplemented, so
 * a change to how a run parks or bills applies to all three at once.
 *
 * ---------------------------------------------------------------------------
 * WHAT LIVES HERE AND WHY
 * ---------------------------------------------------------------------------
 *   * {@link RunEngineDeps} / {@link RunEngineArgs} / {@link RunEngineOutcome}
 *     — the injected dependency bag, unchanged. All four dependencies are
 *     injected so the tests can run the REAL loops against a fake Supabase and
 *     fixture-backed Exa responses.
 *   * {@link BaseRunState} — the mutable half: progress, counts, spend, and
 *     the two writes (`write`, `finish`) nothing outside the engine may make.
 *   * {@link loadRun} / {@link loadList} — the two reads every kind starts with,
 *     including the resume guard that refuses to re-bill a terminal row.
 *   * {@link preflight} — the usage cap, the monthly ceiling and the source
 *     company, in that order and all BEFORE anything paid.
 *   * {@link isCanceling} — the between-units cancel poll. Inngest's `cancelOn`
 *     stops the function mid-flight and therefore never runs the terminal
 *     write; THIS is what turns a cancel into `canceled` WITH partial results.
 *
 * ---------------------------------------------------------------------------
 * WHAT DOES NOT LIVE HERE
 * ---------------------------------------------------------------------------
 * Anything a kind decides for itself: what to search, what the unit of work
 * is, what a stop condition means, and which estimate the budget gate reserves
 * against. Those stay in `run.ts`, `account-run.ts` and `people-run.ts`.
 */
import type { ProspectingRunMirror } from '@/lib/work/prospecting-run-mirror'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DomainProber } from './parked'
import type { DeepSearchArgs, DeepSearchResult } from '@/lib/exa/deep-search'
import { emptyRunCounts } from './exclusions'
import { normalizeIcp } from './icp'
import { resolveSourceCompany } from './source-company'
import {
  MONTHLY_CAP_ERROR,
  monthlyCapVerdict,
  monthStartIso,
  sumSpend,
} from './spend'
import type {
  Icp,
  ProspectListPurpose,
  ProspectingRunCounts,
  ProspectingRunProgress,
  ProspectingRunStage,
  ProspectingRunStatus,
} from './types'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything an engine touches that is not a pure function.
 *
 * All four are injected so the tests can run the REAL loop against a fake
 * Supabase and fixture-backed Exa responses. That is not a testing
 * convenience — the second-run test (§15) is the highest-value test in the
 * feature and it is only writable if two full runs can be executed in-process
 * against the same recorded responses.
 */
export interface RunEngineDeps {
  supabase: SupabaseClient
  /** `deepSearch` from `@/lib/exa/deep-search`, or a fixture-backed stand-in. */
  deepSearch: (args: DeepSearchArgs) => Promise<DeepSearchResult>
  /** Injected so the monthly window and every timestamp are deterministic. */
  now: () => Date
  /** `guardBackgroundUsage`. Throws NonRetriable when the user is over cap. */
  guardUsage: (userId: string | null | undefined) => Promise<void>
  /**
   * "Is this domain a live site?" for discovery's parked-domain gate — see
   * ./parked. Optional because only discovery probes; the engine falls back
   * to the real {@link probeParkedDomain}, and the tests inject a stub so no
   * run touches the network.
   */
  probeDomain?: DomainProber
  /**
   * The run's work-ledger projection (src/lib/work/prospecting-run-mirror.ts,
   * Sequence row 6): a step after each progress write, the settle after THE
   * terminal write. Optional and fail-soft — the Inngest function wires it; the
   * engine tests run without it.
   */
  work?: ProspectingRunMirror
}

export interface RunEngineArgs {
  runId: string
  workspaceId: string
  listId: string
  userId: string | null
}

export interface RunEngineOutcome {
  status: ProspectingRunStatus
  /** Set on every non-`completed` outcome. `monthly_cap` / `run_cap` are the
   *  two the UI branches on; anything else is a message. */
  error?: string | null
  counts: ProspectingRunCounts
  progress: ProspectingRunProgress
  /** New entries created by THIS run — the number the run summary leads with.
   *  For `people` that is the people inserted; for `account_card` it is 0,
   *  because an account card enriches rows that already exist. */
  new_entries: number
  spent_dollars: number
  exa_calls: number
  rounds_run: number
}

/** Page size for the monthly-spend read. Below PostgREST's default cap so a
 *  short page reliably means "last page". */
const MONTHLY_SPEND_PAGE = 500

/** A bound on the pager itself, so a pathological workspace cannot make
 *  preflight loop indefinitely. At this many rows the workspace is far past
 *  any sane ceiling, which is the only thing the sum decides. */
const MONTHLY_SPEND_MAX_ROWS = 20_000

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** The `prospecting_run` columns every kind reads at start. */
export const RUN_START_COLUMNS =
  'id, status, list_id, kind, icp_snapshot, target_entry_ids, budget_dollars, ' +
  'spent_dollars, exa_calls, counts, started_by'

export interface RunStartRow {
  id: string
  status: string
  list_id: string
  kind?: string | null
  icp_snapshot: unknown
  target_entry_ids?: string[] | null
  budget_dollars?: unknown
  spent_dollars?: unknown
  exa_calls?: unknown
  counts?: unknown
  started_by?: string | null
}

/** The `prospect_list` columns every kind reads. `people_per_company` is only
 *  meaningful to the people kind, but reading it unconditionally keeps ONE
 *  select string rather than three that drift. */
export const LIST_COLUMNS =
  'id, purpose, icp, icp_version, status, exclude_crm, exclude_other_lists, ' +
  'exclude_contacted, target_new_candidates, max_rounds, people_per_company, ' +
  'max_spend_dollars'

export interface ProspectListShape {
  id: string
  purpose: string | null
  icp: unknown
  icp_version: number | null
  status: string | null
  exclude_crm: boolean | null
  exclude_other_lists: boolean | null
  exclude_contacted: 'off' | 'active' | 'ever' | null
  target_new_candidates: number | null
  max_rounds: number | null
  people_per_company: number | null
  max_spend_dollars: number | null
}

// ---------------------------------------------------------------------------
// BaseRunState — the mutable half, and every write
// ---------------------------------------------------------------------------

/**
 * Progress, counts, spend, and THE two writes.
 *
 * Subclassed rather than instantiated directly: the discovery engine adds
 * per-identity dedup bookkeeping on top, and the two per-company engines add
 * nothing at all. What every kind shares is the invariant that
 * `completed | failed | canceled | budget_exhausted` are written HERE, by
 * {@link finish}, and nowhere else in the system.
 */
export class BaseRunState {
  readonly counts: ProspectingRunCounts = emptyRunCounts()
  readonly progress: ProspectingRunProgress
  spent = 0
  exaCalls = 0
  budget = 0
  newEntries = 0

  constructor(
    protected readonly deps: RunEngineDeps,
    protected readonly args: RunEngineArgs,
    /** The stage a non-completed terminal write reports. Each kind names its
     *  own, because a parked account-card run must not claim it stopped in
     *  `discover`. */
    protected readonly baseStage: ProspectingRunStage = 'discover',
  ) {
    this.progress = {
      stage: baseStage,
      round: 0,
      max_rounds: 0,
      angle_index: 0,
      found: 0,
      suppressed: 0,
      new: 0,
      invalid: 0,
      accounts_done: 0,
      accounts_total: 0,
      people_found: 0,
      people_target: 0,
      spent_dollars: 0,
      exa_calls: 0,
      updated_at: this.nowIso(),
    }
  }

  nowIso(): string {
    return this.deps.now().toISOString()
  }

  seedFromRow(row: { budget_dollars?: unknown; spent_dollars?: unknown; exa_calls?: unknown }) {
    this.budget = toAmount(row.budget_dollars)
    // A resumed run carries its earlier spend: the cap is over the RUN, not
    // over one invocation of it.
    this.spent = toAmount(row.spent_dollars)
    this.exaCalls = Math.max(0, Math.trunc(toAmount(row.exa_calls)))
    this.progress.spent_dollars = this.spent
    this.progress.exa_calls = this.exaCalls
  }

  /** Add one call's real cost. `costDollars` is `number | null` — a response
   *  that reported nothing still counts as a call. */
  bill(cost: number | null | undefined) {
    this.spent = round6(this.spent + toAmount(cost))
    this.exaCalls += 1
    this.progress.spent_dollars = this.spent
    this.progress.exa_calls = this.exaCalls
  }

  /** Write progress + counts + spend. Called after EVERY paid unit and at
   *  every phase boundary, because §9's poll rehydrates entirely from this
   *  row. */
  async write(patch: Record<string, unknown>): Promise<void> {
    this.progress.updated_at = this.nowIso()
    const { error } = await this.deps.supabase
      .from('prospecting_run')
      .update({
        spent_dollars: this.spent,
        exa_calls: this.exaCalls,
        progress: { ...this.progress },
        counts: { ...this.counts },
        ...patch,
      })
      .eq('id', this.args.runId)
      .eq('workspace_id', this.args.workspaceId)
    if (error) throw new Error(`prospecting_run update failed: ${error.message}`)
    // A progress write (or a phase start) is a live step on the ledger row; the
    // terminal write settles it in finish() instead.
    if (patch.status === undefined || patch.status === 'running') {
      await this.deps.work?.progress({ ...this.progress })
    }
  }

  /** THE terminal write. Nothing else in the system sets a terminal status. */
  async finish(status: ProspectingRunStatus, error: string | null): Promise<RunEngineOutcome> {
    // A parked or cancelled run KEEPS its partial results and reports the
    // stage it actually reached; only a completed run claims 'done'.
    this.progress.stage = status === 'completed' ? 'done' : this.progress.stage
    await this.write({
      status,
      stage: status === 'completed' ? 'done' : this.baseStage,
      error,
      finished_at: this.nowIso(),
    })
    await this.deps.work?.settle({ status, error, newEntries: this.newEntries, progress: { ...this.progress } })
    return this.bare(status, error)
  }

  /** The outcome object without touching the database — for the paths where
   *  there is no row to write to. */
  bare(status: ProspectingRunStatus, error: string | null): RunEngineOutcome {
    return {
      status,
      error,
      counts: { ...this.counts },
      progress: { ...this.progress },
      new_entries: this.newEntries,
      spent_dollars: this.spent,
      exa_calls: this.exaCalls,
      rounds_run: this.progress.round,
    }
  }
}

// ---------------------------------------------------------------------------
// The two reads every kind starts with
// ---------------------------------------------------------------------------

/**
 * Load the run row and apply the resume guard.
 *
 * Returns `{ row }` when the caller should proceed, or `{ terminal }` when it
 * must not: a missing row (nothing to write a status onto) or a row that
 * already reached a terminal state. The latter is resume-safety — a re-entry
 * after the row settled must not re-bill. The wrapper's CAS claim is the
 * primary guard; this is the one that survives a direct call.
 */
export async function loadRun(
  deps: RunEngineDeps,
  args: RunEngineArgs,
): Promise<
  | { row: RunStartRow; terminal?: undefined }
  | { row?: undefined; terminal: { status: ProspectingRunStatus; error: string | null } }
> {
  const { data, error } = await deps.supabase
    .from('prospecting_run')
    .select(RUN_START_COLUMNS)
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`prospecting_run read failed: ${error.message}`)
  if (!data) {
    // A missing row is not transient and there is nothing to write a status
    // onto. Report it rather than throwing into a retry loop.
    return { terminal: { status: 'failed', error: 'run_not_found' } }
  }
  const row = data as unknown as RunStartRow
  if (isTerminal(row.status as ProspectingRunStatus)) {
    return { terminal: { status: row.status as ProspectingRunStatus, error: null } }
  }
  return { row }
}

/** The list, workspace-scoped. RLS is never the only boundary in this lib: the
 *  engine runs under a service-role client, where RLS does not apply at all. */
export async function loadList(
  deps: RunEngineDeps,
  args: RunEngineArgs,
): Promise<ProspectListShape | null> {
  const { data, error } = await deps.supabase
    .from('prospect_list')
    .select(LIST_COLUMNS)
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`prospect_list read failed: ${error.message}`)
  return (data as unknown as ProspectListShape) ?? null
}

/**
 * The ICP a run actually searched with.
 *
 * The run's OWN snapshot is authoritative, not the list's live ICP: the user
 * may have edited the ICP after pressing Find, and run history must stay
 * honest about what was actually searched.
 */
export function icpForRun(run: RunStartRow, list: ProspectListShape): Icp {
  return normalizeIcp(run.icp_snapshot ?? list.icp)
}

export function purposeOf(list: ProspectListShape): ProspectListPurpose {
  return (list.purpose ?? 'buyers') as ProspectListPurpose
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightResult {
  /** Set when the run must park before spending anything. */
  parked?: { status: ProspectingRunStatus; error: string | null }
  /** The source company's domain — "us", for the systemPrompt's referent and
   *  for the `self` exclusion source. */
  sourceDomain?: string | null
}

/**
 * The two free gates plus the source company, in this order.
 *
 * 1. The AI usage cap, BEFORE anything paid. Throws NonRetriable, which
 *    propagates: Inngest stops cleanly rather than burning retries against a
 *    cap that will not lift mid-run, and the wrapper turns it into a terminal
 *    `failed` write.
 * 2. The monthly workspace ceiling. Parked, not failed: the work is legitimate
 *    and will be possible next month or at a raised cap. The UI offers "raise
 *    the cap", not "retry".
 * 3. The source company, which every kind needs — discovery for its exclusion
 *    set, the account card for the "why would they buy from US" systemPrompt.
 */
export async function preflight(
  deps: RunEngineDeps,
  args: RunEngineArgs,
  icp: Icp,
): Promise<PreflightResult> {
  await deps.guardUsage(args.userId)

  const monthly = await readMonthlySpend(deps.supabase, args.workspaceId, args.runId, deps.now())
  if (!monthlyCapVerdict(monthly).ok) {
    return { parked: { status: 'budget_exhausted', error: MONTHLY_CAP_ERROR } }
  }

  const source = await resolveSourceCompany(deps.supabase, {
    workspaceId: args.workspaceId,
    userId: args.userId ?? '',
    userEmail: null,
  })
  return { sourceDomain: source.company?.domain ?? icp.source.domain ?? null }
}

/**
 * The workspace's prospecting spend for the current UTC calendar month,
 * EXCLUDING this run.
 *
 * Excluding this run is not a nicety: a retry of a run that already spent $3
 * would otherwise count that $3 against itself and park at the ceiling for
 * money it is about to re-report.
 */
export async function readMonthlySpend(
  supabase: SupabaseClient,
  workspaceId: string,
  runId: string,
  now: Date,
): Promise<number> {
  const monthStart = monthStartIso(now)
  let total = 0

  // PAGED, deliberately. A single unbounded select silently truncates at
  // PostgREST's default row limit, and truncating this particular read
  // UNDER-counts the month's spend — which admits a run the ceiling exists to
  // refuse. Cheap $0 rows (parked, canceled, budget_exhausted) accumulate
  // faster than paid ones, so the row count is not bounded by the dollar cap.
  // `prospecting_run_workspace_created_idx` covers the ordered range scan.
  for (let offset = 0; offset < MONTHLY_SPEND_MAX_ROWS; offset += MONTHLY_SPEND_PAGE) {
    const { data, error } = await supabase
      .from('prospecting_run')
      .select('id, spent_dollars')
      .eq('workspace_id', workspaceId)
      .gte('created_at', monthStart)
      // A stable order is what makes the pages disjoint; without it PostgREST
      // may return the same row on two pages and double-count it.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + MONTHLY_SPEND_PAGE - 1)
    if (error) {
      // FAIL CLOSED, unlike guardBackgroundUsage. That gate protects a cap the
      // user can see and raise; this one protects real money against a number
      // we could not read. Throwing lets Inngest retry a transient read rather
      // than spending on the assumption that $0 has been spent.
      throw new Error(`monthly spend read failed: ${error.message}`)
    }
    const page = (data ?? []) as Array<{ id?: string; spent_dollars?: unknown }>
    // Excluding THIS run is not a nicety — see the doc comment above.
    total += sumSpend(page.filter((row) => row?.id !== runId))
    // A short page is the last page.
    if (page.length < MONTHLY_SPEND_PAGE) return total
  }

  // The pager itself is bounded, so a workspace past the ceiling by tens of
  // thousands of rows cannot spin here. Whatever it has already summed is far
  // past the cap anyway, which is the only decision this number feeds.
  return total
}

/**
 * How many member rows we will resolve an email for.
 *
 * The emails feed ONE thing: the `self` exclusion source, which turns each
 * member's employer domain into "us, don't prospect us". A workspace with more
 * members than this has long since had its own domain covered by the first
 * handful, so the tail buys nothing and would cost one GoTrue round trip each.
 */
const MEMBER_EMAIL_LIMIT = 50

/** How many `getUserById` calls are in flight at once. Matches the ceiling the
 *  workspace route uses for the same fan-out, for the same reason: an
 *  unbounded `Promise.all` bursts one simultaneous GoTrue admin request per
 *  member and trips per-project Auth API throttling. */
const MEMBER_EMAIL_CONCURRENCY = 10

/**
 * Every member's email, for the `self` exclusion source.
 *
 * There is NO `member.email` column — `member` (migration 013) holds
 * `user_id`, `role` and `display_name`, and the email lives on `auth.users`.
 * Selecting it is not a soft failure that returns nothing: PostgREST rejects
 * the whole query with `column member.email does not exist`, which is how this
 * silently disabled the `self` exclusion in production. So we read `user_id`
 * and resolve each through the admin API, the same way
 * `src/app/api/account/workspace/route.ts` does. Deliberately NOT a listUsers
 * page: that walks the entire product user base to map a handful of members.
 *
 * Failure at every level degrades to fewer emails rather than an exception: a
 * missing member email costs one wasted candidate, while failing the run costs
 * the whole search.
 */
export async function readMemberEmails(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('member')
    .select('user_id')
    .eq('workspace_id', workspaceId)
  if (error) {
    console.error('[prospecting] member read failed:', error.message)
    return []
  }

  const all = ((data ?? []) as Array<{ user_id?: string | null }>)
    .map((row) => row?.user_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  const ids = all.slice(0, MEMBER_EMAIL_LIMIT)
  if (all.length > ids.length) {
    console.warn(
      `[prospecting] workspace ${workspaceId} has ${all.length} members; ` +
        `resolving emails for the first ${ids.length} only`,
    )
  }

  // The admin API is only present on a service-role client. The engine always
  // runs under one, but a caller that injected a plain client should lose the
  // `self` exclusion rather than crash the run.
  const admin = (supabase as SupabaseClient).auth?.admin
  if (typeof admin?.getUserById !== 'function') return []

  const emails: string[] = []
  for (let i = 0; i < ids.length; i += MEMBER_EMAIL_CONCURRENCY) {
    const chunk = ids.slice(i, i + MEMBER_EMAIL_CONCURRENCY)
    const resolved = await Promise.all(
      chunk.map(async (id) => {
        try {
          const { data: got, error: getError } = await admin.getUserById(id)
          if (getError) return null
          return got?.user?.email ?? null
        } catch {
          // A misconfigured service-role key (preview/dev) must not fail a run.
          return null
        }
      }),
    )
    for (const email of resolved) {
      if (typeof email === 'string' && email.includes('@')) emails.push(email)
    }
  }
  return emails
}

/**
 * Has someone pressed Cancel since the last call?
 *
 * Checked BETWEEN units rather than relied on from Inngest's `cancelOn`, which
 * stops the function mid-flight and therefore never runs the terminal write.
 * This read is what makes a cancel produce `status='canceled'` WITH the partial
 * results, rather than a run frozen at `canceling` forever.
 *
 * A read failure is NOT a cancel: we return false and let the run continue,
 * because a transient error must not silently abort a paid run.
 */
export async function isCanceling(
  supabase: SupabaseClient,
  runId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('prospecting_run')
    .select('status')
    .eq('id', runId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] cancel check failed:', error.message)
    return false
  }
  return (data as { status?: string } | null)?.status === 'canceling'
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function isTerminal(status: ProspectingRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'budget_exhausted'
  )
}

export function toAmount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(numberOr(value, fallback))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
