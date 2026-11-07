/**
 * The `prospecting_run` data-access layer — the single implementation behind
 * the run routes under `src/app/api/account/prospecting/`, following the
 * `lists.ts` precedent in every respect that matters.
 *
 * The division of labour with the run ENGINE (`src/lib/prospecting/run.ts`,
 * driven by the `prospecting-run-execute` Inngest function) is deliberate and
 * load-bearing:
 *
 *   - THIS file creates the row (`status='queued'`) and emits
 *     `prospecting/run.requested`. It never calls Exa, never spends, and never
 *     writes a terminal status.
 *   - The ENGINE claims the row queued→running with a CAS update and owns
 *     EVERY terminal write (completed | failed | canceled | budget_exhausted).
 *
 * The only status this file writes after creation is `canceling`, which is the
 * one transition migration 248's `prospecting_run_member_update` policy exists
 * for ("members may cancel a run; the engine writes everything else
 * service-role"). Cancel is a REQUEST — the engine settles it as `canceled`
 * when its `cancelOn` fires.
 *
 * Every query carries an explicit `workspace_id` filter. The routes pass the
 * RLS-scoped client, so that filter is belt-and-braces here — but it is also
 * what makes these functions safe to call from the service-role lane later,
 * which is the same rule `lists.ts` states at its top.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'
import { mirrorProspectingRunQueued, settleProspectingWorkByRun } from '@/lib/work/prospecting-run-mirror'
import {
  inngest,
  PROSPECTING_RUN_CANCEL,
  PROSPECTING_RUN_REQUESTED,
  type ProspectingRunCancelEvent,
  type ProspectingRunRequestedEvent,
} from '@/lib/inngest/client'
import type {
  ProspectCandidateOutcome,
  ProspectRunCandidateRow,
  ProspectSuppressionSource,
  ProspectingRunKind,
  ProspectingRunRow,
  ProspectingRunStage,
  ProspectingRunStatus,
} from './types'
import {
  PROSPECT_SUPPRESSION_SOURCES,
  PROSPECTING_RUN_KINDS,
  PROSPECTING_RUN_LIVE_STATUSES,
} from './types'
import {
  MAX_ENTRIES_PER_TARGETED_RUN,
  MAX_RUN_BUDGET_DOLLARS,
  MIN_RUN_BUDGET_DOLLARS,
} from './spend'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Uniform failure shape, mirroring `ProspectingError` in `lists.ts`. The two
 *  are separate unions on purpose: a run failure can be RUN_ALREADY_LIVE or
 *  NOT_CANCELABLE, neither of which means anything to a list route. */
export interface ProspectingRunError {
  ok: false
  code:
    | 'NOT_FOUND'
    | 'INVALID_INPUT'
    | 'LIST_ARCHIVED'
    | 'RUN_ALREADY_LIVE'
    | 'NOT_CANCELABLE'
    | 'DB_ERROR'
  error: string
}

export type RunResult<T> = ({ ok: true } & T) | ProspectingRunError

function fail(code: ProspectingRunError['code'], error: string): ProspectingRunError {
  return { ok: false, code, error }
}

/** Every column of `prospecting_run`. */
const RUN_COLUMNS = '*'
/** Every column of `prospect_run_candidate`. */
const CANDIDATE_COLUMNS = '*'

/**
 * The event names are imported from the shared client, not re-declared here.
 * That import IS the naming contract: sender (this file) and receiver
 * (`src/lib/inngest/prospecting-functions.ts`) reference one literal, so a
 * rename breaks the build rather than producing a run that never happens and
 * never errors.
 */
export { PROSPECTING_RUN_CANCEL, PROSPECTING_RUN_REQUESTED }

/**
 * The live statuses. Identical to `AGENT_RUN_LIVE_STATUSES`
 * (`src/lib/agent-run/types.ts`) — `prospecting_run.status` is that vocabulary
 * minus `'pr_open'` plus `'budget_exhausted'`, and both of those divergences
 * are TERMINAL, so the live half is unchanged and `isAgentRunLive` is the same
 * predicate over it.
 */
const LIVE_STATUSES: readonly ProspectingRunStatus[] = PROSPECTING_RUN_LIVE_STATUSES

/**
 * The statuses {@link listActiveRuns} queries on — {@link LIVE_STATUSES} minus
 * `needs_input`. Kept as its own array rather than reusing LIVE_STATUSES so the
 * difference is stated where a reader can see it: v1 never parks a run at
 * `needs_input`, and putting an unreachable status in a `.in()` filter invites
 * the next reader to believe the UI handles one.
 */
const ACTIVE_RUN_STATUSES: readonly ProspectingRunStatus[] = ['queued', 'running', 'canceling']

/** True when the run is still in flight: poll it, and it is cancelable. */
export function isLive(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status)
}

/** A run row plus the derived flag every consumer would otherwise recompute. */
export interface ProspectingRunWithLive extends ProspectingRunRow {
  is_live: boolean
}

function withLive(row: ProspectingRunRow): ProspectingRunWithLive {
  return { ...row, is_live: isLive(row.status) }
}

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

/**
 * The band a per-run budget is clamped into.
 *
 * IMPORTED, not redeclared: `spend.ts` owns every money constant in this
 * feature, and the engine's own gates read the same two numbers. Two copies of
 * a dollar figure is precisely the thing that drifts — one raised, the other
 * not, and a run admitted by the route that the engine then refuses.
 *
 * 0.25 is below the measured cost of one round (~$0.11 × 4 angles) only as a
 * floor for a deliberately tiny probe run. Both ends match `clampSpend` in
 * lists.ts.
 */
function clampBudget(raw: unknown, fallback: number): number {
  const base = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  const clamped = Math.min(MAX_RUN_BUDGET_DOLLARS, Math.max(MIN_RUN_BUDGET_DOLLARS, base))
  // 4dp, matching `prospecting_run.budget_dollars` numeric(10,4).
  return Math.round(clamped * 1e4) / 1e4
}

export interface CreateRunArgs {
  workspaceId: string
  /** Who pressed the button. NULL for a run the engine chained itself (the
   *  profile run discovery hands off to); `started_by` is nullable for it. */
  userId: string | null
  listId: string
  /** Optional per-run override of the list's `max_spend_dollars`, clamped to
   *  0.25..20 exactly as the list's own field is. */
  budgetDollars?: unknown
  /**
   * Which of the three runs this is. Defaults to `discover`, so every
   * pre-existing caller — the Find button, the tests — is byte-identical.
   */
  kind?: unknown
  /**
   * The companies an `account_card` or `people` run acts on. REQUIRED for both
   * of those kinds and rejected on `discover`, which chooses its own targets by
   * searching. Validated here rather than in the route so the service-role lane
   * gets the same rules: an entry must belong to THIS list, be a company, and
   * not be dismissed, and there may be at most
   * {@link MAX_ENTRIES_PER_TARGETED_RUN} of them.
   */
  entryIds?: unknown
  /** Set by {@link chainProfileRun} only: this profile run is one pass of a
   *  hand-off, and the engine may chain the next pass after it. Rides on the
   *  event, never on the row. */
  handoff?: { before: string }
}

/** The stage a run of each kind starts at — written on the row at creation so
 *  the poll has something honest to render before the engine's first write. */
const START_STAGE: Record<ProspectingRunKind, ProspectingRunStage> = {
  discover: 'discover',
  account_card: 'account_card',
  people: 'people',
}

/** A run kind, or null for anything unrecognized. An ABSENT kind is
 *  `discover`; a PRESENT but invalid one is an error, because silently
 *  running a discovery search for someone who asked for people would spend
 *  their money on the wrong thing. */
function readKind(raw: unknown): ProspectingRunKind | null {
  if (raw === undefined || raw === null || raw === '') return 'discover'
  return (PROSPECTING_RUN_KINDS as readonly string[]).includes(raw as string)
    ? (raw as ProspectingRunKind)
    : null
}

/** The requested entry ids, de-duplicated and order-preserving. Returns null
 *  when the value is present but not an array of non-empty strings. */
function readEntryIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string' || value.trim() === '') return null
    const id = value.trim()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Create the run row and ask the engine to execute it.
 *
 * `round_index` is `(max for this list) + 1`, computed here rather than by a
 * DB default because the counter is PER-LIST and MONOTONIC: the second run of
 * a list two weeks later is round 2, a continuation, not a repeat. A missing
 * previous run means round 1.
 *
 * Two presses of Find race, and the loser is decided by the DATABASE:
 * `prospecting_run_one_live_per_list` is a partial unique index over
 * `status IN ('queued','running')`, so the second INSERT raises 23505 and this
 * function reports RUN_ALREADY_LIVE for the route to render as a 409. This is
 * caught rather than pre-checked for the same reason `createList` catches its
 * own 23505: a check-then-insert races itself, and Inngest's concurrency key
 * serializes EXECUTION but not ENQUEUEING, so a race that got past this would
 * bill four discovery searches to find nothing.
 *
 * The event is sent AFTER the insert commits. The reverse order would hand the
 * engine a runId that does not exist yet; a send that fails after a successful
 * insert is reported as DB_ERROR with the row already `queued`, which the
 * engine's own CAS claim makes safe to re-request.
 *
 * ONE EVENT FOR ALL THREE KINDS. `prospecting/run.requested` carries only ids;
 * the Inngest function reads `run.kind` off the row it claims and dispatches.
 * A per-kind event name would need three triggers sharing one concurrency lane
 * and one `cancelOn`, and the lane is the thing that bounds spend per
 * workspace — so the kind travels in the ROW, which is also the only place a
 * redelivered attempt could read it from anyway.
 */
export async function createRun(
  supabase: SupabaseClient,
  args: CreateRunArgs,
): Promise<
  RunResult<{
    run: ProspectingRunWithLive
    /** Present when the companies JOINED the people run already live on the
     *  list instead of getting a run of their own (queue-on-click): `run` is
     *  that live run, `appended` the ids that were new to it. */
    joined?: { appended: string[] }
  }>
> {
  // ── Validate the kind and the selection BEFORE touching the database ──
  const kind = readKind(args.kind)
  if (!kind) return fail('INVALID_INPUT', 'Unknown run kind')

  const entryIds = readEntryIds(args.entryIds)
  if (!entryIds) return fail('INVALID_INPUT', 'entry_ids must be an array of entry ids')

  const targeted = kind !== 'discover'
  if (targeted && entryIds.length === 0) {
    return fail('INVALID_INPUT', 'Select at least one company')
  }
  if (targeted && entryIds.length > MAX_ENTRIES_PER_TARGETED_RUN) {
    return fail(
      'INVALID_INPUT',
      `Select at most ${MAX_ENTRIES_PER_TARGETED_RUN} companies for one run`,
    )
  }
  if (!targeted && entryIds.length > 0) {
    // Not merely unused — a discovery run that silently ignored a selection
    // would look to the user like it had honoured one.
    return fail('INVALID_INPUT', 'entry_ids is only valid for account_card and people runs')
  }

  const { data: list, error: listError } = await supabase
    .from('prospect_list')
    .select('id, status, icp, max_spend_dollars')
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (listError) {
    console.error('[prospecting] run list load failed:', listError.message)
    return fail('DB_ERROR', 'Failed to load list')
  }
  if (!list) return fail('NOT_FOUND', 'List not found')

  const listRow = list as unknown as {
    id: string
    status: string
    icp: unknown
    max_spend_dollars: number
  }

  // An archived list is a decision the user put away. Running it would refill
  // a list they cannot see and spend real money doing it.
  if (listRow.status === 'archived') {
    return fail('LIST_ARCHIVED', 'This list is archived; restore it before running')
  }

  // ── The selection must actually be this list's, and runnable ─────────
  //
  // Read rather than trusted, and read HERE rather than in the engine: a run
  // that reaches the lane and then discovers its targets are foreign has
  // already taken the one-live-per-list lock and shows the user a failed run
  // for what is a plain 400. The three rules are the contract's: this list,
  // kind `company`, not dismissed.
  if (targeted) {
    const { data: rows, error: entryError } = await supabase
      .from('prospect_list_entry')
      .select('id, kind, stage')
      .eq('workspace_id', args.workspaceId)
      .eq('list_id', args.listId)
      .in('id', entryIds)
    if (entryError) {
      console.error('[prospecting] run target load failed:', entryError.message)
      return fail('DB_ERROR', 'Failed to load selected companies')
    }
    const found = new Map(
      ((rows ?? []) as Array<{ id: string; kind: string; stage: string }>).map((r) => [r.id, r]),
    )
    for (const id of entryIds) {
      const row = found.get(id)
      // A cross-list or cross-workspace id is INVALID_INPUT, not NOT_FOUND:
      // confirming which of the two it was would tell the caller whether an
      // entry exists in a list they cannot see.
      if (!row) return fail('INVALID_INPUT', 'One or more selected entries are not in this list')
      if (row.kind !== 'company') {
        return fail('INVALID_INPUT', 'Only companies can be researched')
      }
      if (row.stage === 'dismissed') {
        return fail('INVALID_INPUT', 'Dismissed companies cannot be researched')
      }
    }
  }

  // Highest round on the list, live or terminal — the counter never resets.
  const { data: lastRun, error: roundError } = await supabase
    .from('prospecting_run')
    .select('round_index')
    .eq('workspace_id', args.workspaceId)
    .eq('list_id', args.listId)
    .order('round_index', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (roundError) {
    console.error('[prospecting] run round lookup failed:', roundError.message)
    return fail('DB_ERROR', 'Failed to load run history')
  }
  const roundIndex = ((lastRun as { round_index?: number } | null)?.round_index ?? 0) + 1

  const insertRow = {
    workspace_id: args.workspaceId,
    list_id: args.listId,
    kind,
    round_index: roundIndex,
    status: 'queued',
    stage: START_STAGE[kind],
    // The ICP AS RUN. `prospect_list.icp_version` says entries drifted; this
    // says what was actually searched.
    icp_snapshot: listRow.icp ?? {},
    // The companies the engine will loop over, in the order the user picked
    // them. NULL for a discovery run, which chooses its own.
    target_entry_ids: targeted ? entryIds : null,
    budget_dollars: clampBudget(args.budgetDollars, listRow.max_spend_dollars),
    spent_dollars: 0,
    exa_calls: 0,
    progress: {},
    counts: {},
    // Written by preflight, once the set is actually built.
    exclusion_snapshot: {},
    started_by: args.userId,
  }
  const insert = () =>
    supabase.from('prospecting_run').insert(insertRow).select(RUN_COLUMNS).single()

  // ── The insert — and, for a PEOPLE run, the join ─────────────────────
  //
  // QUEUE-ON-CLICK (Liam, 2026-09-06). The one-live-run-per-list index still
  // decides who wins, but a people request that loses to a LIVE PEOPLE RUN no
  // longer gets a 409: its companies are appended to that run's
  // `target_entry_ids`, which the engine re-reads before every search
  // (people-run.ts), so a Find people pressed on another row simply queues
  // behind the one going. Every other collision — a discovery or profile run
  // in flight, an account_card request against a people run — is the 409 it
  // always was. The insert is still attempted FIRST so the race is settled by
  // the database rather than by a check that could itself race.
  let inserted = await insert()
  if (inserted.error?.code === '23505' && kind === 'people') {
    const join = await joinLivePeopleRun(supabase, {
      workspaceId: args.workspaceId,
      listId: args.listId,
      entryIds,
    })
    if (join.outcome === 'joined') {
      return { ok: true, run: withLive(join.run), joined: { appended: join.appended } }
    }
    if (join.outcome === 'failed') return fail(join.code, join.error)
    // The live run settled between the insert and the read: this request gets
    // its own run after all. (`other_kind` falls through to the 409.)
    if (join.outcome === 'settled') inserted = await insert()
  }
  const { data, error } = inserted

  if (error) {
    if (error.code === '23505') {
      return fail('RUN_ALREADY_LIVE', 'This list already has a run in progress')
    }
    console.error('[prospecting] run create failed:', error.message)
    return fail('DB_ERROR', 'Failed to start run')
  }

  const run = data as unknown as ProspectingRunRow

  // The run's Activity row, queued from the moment the run exists (Sequence
  // row 6). Service client: the caller may hold the user's, and `tracked_job`
  // has no client write policy. Fail-soft.
  await mirrorProspectingRunQueued(getServiceClient(), {
    id: run.id,
    workspace_id: args.workspaceId,
    list_id: args.listId,
    kind,
    started_by: args.userId ?? null,
  })

  try {
    const event: ProspectingRunRequestedEvent = {
      name: PROSPECTING_RUN_REQUESTED,
      data: {
        runId: run.id,
        workspaceId: args.workspaceId,
        listId: args.listId,
        userId: args.userId,
        ...(args.handoff ? { handoff: args.handoff } : {}),
      },
    }
    await inngest.send(event)
  } catch (err) {
    // The row is `queued` and holds the live-run lock. Surface the failure
    // rather than returning a run that will never move: the engine's CAS claim
    // makes a re-request idempotent once the user retries.
    console.error(
      '[prospecting] run.requested send failed:',
      err instanceof Error ? err.message : String(err),
    )
    return fail('DB_ERROR', 'Run was created but could not be queued')
  }

  return { ok: true, run: withLive(run) }
}

type JoinOutcome =
  | { outcome: 'joined'; run: ProspectingRunRow; appended: string[] }
  /** The live run is a discovery or profile run — nothing to join. */
  | { outcome: 'other_kind' }
  /** No live run any more: it settled between the caller's insert and this read. */
  | { outcome: 'settled' }
  | { outcome: 'failed'; code: Parameters<typeof fail>[0]; error: string }

/**
 * Add companies to the people run that is live on this list — the
 * queue-on-click behind a Find people pressed while another one is going.
 *
 * COMPARE-AND-SWAP ON THE TARGET LIST ITSELF. Two presses a moment apart both
 * read the same list; each writes `current + fresh` filtered on
 * `target_entry_ids = current`, so the second write's literal no longer
 * matches, it re-reads, and appends onto the first's result. PostgREST takes
 * the Postgres array literal for `eq` on a uuid[] column (probed on DEV,
 * 2026-09-06: a matching literal updates one row, a stale one none). The write
 * is filtered on the live statuses too, so a run that settled between the
 * read and the write is not written to. Either miss re-reads, three times at
 * most; a run gone by then means the caller gets its own.
 *
 * Never sends an event: the engine is already running, and re-reads the
 * target list before each search. Ids already on the run are a no-op join —
 * the caller still gets the run to follow.
 */
async function joinLivePeopleRun(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string; entryIds: string[] },
): Promise<JoinOutcome> {
  const LIVE_STATUSES = ['queued', 'running']
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('prospecting_run')
      .select(RUN_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('list_id', args.listId)
      .in('status', LIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error('[prospecting] live run read failed:', error.message)
      return { outcome: 'failed', code: 'DB_ERROR', error: 'Failed to load the running search' }
    }
    const live = data as unknown as ProspectingRunRow | null
    if (!live) return { outcome: 'settled' }
    if (live.kind !== 'people') return { outcome: 'other_kind' }

    const current = (live.target_entry_ids ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )
    const fresh = args.entryIds.filter((id) => !current.includes(id))
    if (fresh.length === 0) return { outcome: 'joined', run: live, appended: [] }
    if (current.length + fresh.length > MAX_ENTRIES_PER_TARGETED_RUN) {
      return {
        outcome: 'failed',
        code: 'INVALID_INPUT',
        error: `The running search already has ${current.length} companies; at most ${MAX_ENTRIES_PER_TARGETED_RUN} fit in one — wait for it to finish`,
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('prospecting_run')
      .update({ target_entry_ids: [...current, ...fresh] })
      .eq('id', live.id)
      .eq('workspace_id', args.workspaceId)
      .in('status', LIVE_STATUSES)
      .eq('target_entry_ids', `{${current.join(',')}}`)
      .select(RUN_COLUMNS)
      .maybeSingle()
    if (updateError) {
      console.error('[prospecting] live run append failed:', updateError.message)
      return { outcome: 'failed', code: 'DB_ERROR', error: 'Failed to add to the running search' }
    }
    if (updated) {
      return { outcome: 'joined', run: updated as unknown as ProspectingRunRow, appended: fresh }
    }
    // Lost the swap to another append, or the run settled: read again.
  }
  return { outcome: 'other_kind' }
}

// ---------------------------------------------------------------------------
// The hand-off: discovery → profile
// ---------------------------------------------------------------------------

/**
 * Start the next pass of the hand-off: the profile run a settled DISCOVERY
 * run hands off to, or the pass that follows a profile pass which hit the cap.
 *
 * "Find companies" means find AND score (Liam, 2026-09-06): the user should
 * see the companies land, then watch scores arrive and the list re-sort
 * hottest first, with nothing to press in between — for the FULL list. So the
 * Inngest function calls this in the step after discovery's terminal write,
 * and again after each chained profile pass, until nothing is left. A pass
 * targets every company on the list that has no score yet and was not carded
 * since `before` — the ones just found, plus any older row a card never
 * scored — newest first, capped at the targeted-run ceiling.
 *
 * `before` IS WHAT MAKES THE PASSES TERMINATE. A card that comes back with no
 * usable score leaves `fit_score` NULL; picking on the score alone would
 * target that company on every pass, forever. Every card stamps
 * `candidate.account_card_at`, so a company carded after the hand-off began
 * is one this hand-off already paid for and is never picked again — the set
 * strictly shrinks by at least the pass size, and the last pass finds nothing.
 * A company carded BEFORE `before` (an old row from before scores existed) is
 * fair game exactly once.
 *
 * NEVER THROWS. The run before it already completed and its verdict is
 * written; a pass that could not start is logged and reported as `skipped`,
 * and the strip's "Enrich · N" fallback is the user's way to run it by hand.
 * Another run started in the gap — a user pressing Find people on a
 * still-warm list — wins the one-live lock, correctly.
 */
export async function chainProfileRun(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    listId: string
    userId: string | null
    /** The instant the hand-off began (ISO). Defaults to now for the first
     *  pass; a later pass carries the first pass's value on its event. */
    before?: string
  },
): Promise<{ runId: string | null; targets: number; skipped: string | null; before: string }> {
  const before = args.before ?? new Date().toISOString()
  const { data, error } = await supabase
    .from('prospect_list_entry')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('list_id', args.listId)
    .eq('kind', 'company')
    .neq('stage', 'dismissed')
    .is('fit_score', null)
    // Never carded, or carded before this hand-off began. ISO timestamps
    // compare correctly as text, which is all PostgREST offers on a jsonb path.
    .or(`candidate->>account_card_at.is.null,candidate->>account_card_at.lt.${before}`)
    .order('created_at', { ascending: false })
    .limit(MAX_ENTRIES_PER_TARGETED_RUN)
  if (error) {
    console.error('[prospecting] hand-off target read failed:', error.message)
    return { runId: null, targets: 0, skipped: 'read_failed', before }
  }
  const entryIds = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  if (entryIds.length === 0) return { runId: null, targets: 0, skipped: 'nothing_to_score', before }

  const created = await createRun(supabase, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    listId: args.listId,
    kind: 'account_card',
    entryIds,
    handoff: { before },
  })
  if (!created.ok) {
    console.error('[prospecting] hand-off run start failed:', created.code, created.error)
    return { runId: null, targets: entryIds.length, skipped: created.code, before }
  }
  return { runId: created.run.id, targets: entryIds.length, skipped: null, before }
}

// ---------------------------------------------------------------------------
// listRuns / getRun
// ---------------------------------------------------------------------------

/** Every run of one list, newest first. The list is loaded first so a
 *  cross-workspace id is NOT_FOUND rather than an empty history that reads as
 *  "this list has never been run". */
export async function listRuns(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string; limit?: number },
): Promise<RunResult<{ runs: ProspectingRunWithLive[] }>> {
  const { data: list, error: listError } = await supabase
    .from('prospect_list')
    .select('id')
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (listError) {
    console.error('[prospecting] run history list check failed:', listError.message)
    return fail('DB_ERROR', 'Failed to load list')
  }
  if (!list) return fail('NOT_FOUND', 'List not found')

  const limit = Math.min(100, Math.max(1, Math.round(args.limit ?? 25)))
  const { data, error } = await supabase
    .from('prospecting_run')
    .select(RUN_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('list_id', args.listId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[prospecting] run history failed:', error.message)
    return fail('DB_ERROR', 'Failed to load runs')
  }
  return { ok: true, runs: ((data ?? []) as unknown as ProspectingRunRow[]).map(withLive) }
}

/** The cap on how many live runs one call reports. A workspace with more than
 *  fifty runs in flight has a bigger problem than a truncated list, and the
 *  consumers (a nav dot, a set of list-card badges) need "which lists are
 *  busy", not an unbounded ledger. */
const MAX_ACTIVE_RUNS = 50

/** A live run, plus the name of the list it is filling. */
export interface ActiveRunWithList extends ProspectingRunWithLive {
  list_name: string
}

/**
 * Every run still in flight ACROSS THE WHOLE WORKSPACE, newest first.
 *
 * The existing reads are all per-list (`listRuns`) or per-run (`getRun`), which
 * is why a run started from the chat, or from another tab, was invisible until
 * you reloaded the page it belonged to. This is the one read that answers "is
 * anything happening right now?" — the Prospecting nav dot, the index's live
 * list-card badges, and the list page's adoption of a run it did not start all
 * hang off it.
 *
 * `canceling` is included alongside `queued`/`running`: a cancel that has been
 * requested but not yet honoured is still a run doing work, and dropping it
 * here would make the dot blink off a beat before the run actually stopped.
 * `needs_input` is deliberately NOT here even though {@link isLive} counts it —
 * v1 never parks a run there, and a status nothing can produce should not shape
 * a query.
 *
 * The list name comes from an EMBEDDED select rather than a second read: the
 * consumers are polling this every 5 seconds and a per-run follow-up query
 * would multiply that by the number of live runs.
 */
export async function listActiveRuns(
  supabase: SupabaseClient,
  args: { workspaceId: string },
): Promise<RunResult<{ runs: ActiveRunWithList[] }>> {
  const { data, error } = await supabase
    .from('prospecting_run')
    .select(`${RUN_COLUMNS}, prospect_list!inner(name)`)
    .eq('workspace_id', args.workspaceId)
    .in('status', ACTIVE_RUN_STATUSES)
    .order('created_at', { ascending: false })
    .limit(MAX_ACTIVE_RUNS)
  if (error) {
    console.error('[prospecting] active runs load failed:', error.message)
    return fail('DB_ERROR', 'Failed to load active runs')
  }

  const rows = (data ?? []) as unknown as Array<
    ProspectingRunRow & { prospect_list?: { name?: string } | Array<{ name?: string }> | null }
  >
  return {
    ok: true,
    runs: rows.map((row) => {
      // PostgREST returns an embedded to-one as an object, but the generated
      // types (and older PostgREST versions) model it as an array. Read both
      // rather than casting to whichever one today's client produces.
      const { prospect_list, ...run } = row
      const embedded = Array.isArray(prospect_list) ? prospect_list[0] : prospect_list
      return {
        ...withLive(run as ProspectingRunRow),
        list_name: typeof embedded?.name === 'string' ? embedded.name : 'Untitled list',
      }
    }),
  }
}

/** One run. A cross-workspace id is NOT_FOUND, never 403 — a run the caller
 *  cannot see must not be confirmable by its id. */
export async function getRun(
  supabase: SupabaseClient,
  args: { workspaceId: string; runId: string },
): Promise<RunResult<{ run: ProspectingRunWithLive }>> {
  const { data, error } = await supabase
    .from('prospecting_run')
    .select(RUN_COLUMNS)
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] run load failed:', error.message)
    return fail('DB_ERROR', 'Failed to load run')
  }
  if (!data) return fail('NOT_FOUND', 'Run not found')
  return { ok: true, run: withLive(data as unknown as ProspectingRunRow) }
}

// ---------------------------------------------------------------------------
// requestCancel
// ---------------------------------------------------------------------------

/** Only these two accept a cancel. `needs_input` is live but v1 never parks a
 *  run there, and `canceling` is already canceling — re-emitting the event for
 *  it would be a no-op that reads to the user as a second cancel. */
const CANCELABLE_STATUSES: readonly ProspectingRunStatus[] = ['queued', 'running']

/**
 * Ask a live run to stop.
 *
 * Two things happen, in this order and no other: the status flips to
 * `canceling` so the UI reflects the press immediately, then
 * `prospecting/run.cancel` is emitted for the engine's `cancelOn` to match on
 * `data.runId`. The engine writes the terminal `canceled` — this function
 * never does, because a run that is mid-Exa-call has partial results to keep.
 *
 * The flip is CAS-guarded on `status IN ('queued','running')` (the same guard
 * `/api/account/actions/[id]/agent-runs/[runId]/cancel` applies): a run that
 * settled in the gap since the read must not be resurrected to `canceling`,
 * which the engine would then finalize as `canceled`, clobbering a completed
 * run's results. An empty update result is a 409, not a retry.
 */
export async function requestCancel(
  supabase: SupabaseClient,
  args: { workspaceId: string; runId: string },
): Promise<RunResult<{ run: ProspectingRunWithLive }>> {
  const existing = await getRun(supabase, args)
  if (!existing.ok) return existing
  if (!(CANCELABLE_STATUSES as readonly string[]).includes(existing.run.status)) {
    return fail(
      'NOT_CANCELABLE',
      existing.run.status === 'canceling'
        ? 'This run is already canceling'
        : 'This run has already finished',
    )
  }

  // A QUEUED run has no engine to notice `canceling`. The engine is the only
  // thing that ever writes `canceled`, and it does so from its between-units
  // poll — which a run that was never claimed never reaches. Inngest's
  // `cancelOn` would stop the function before `execute-run`, and Inngest does
  // not run a hook on cancellation, so `canceling` would be the row's last
  // word: the rail says "Cancelling…" forever, Find stays disabled, the nav
  // dot stays lit. So a queued run is settled HERE, atomically on its status:
  // queued → canceled. If the engine claims it in the gap the update matches
  // nothing and we fall through to the ordinary `canceling` path; if we win,
  // the engine's claim (`.in('status', CLAIMABLE_STATUSES)`) refuses the row
  // and exits idempotently. Both orders are correct, because both writes are
  // conditional on the status they saw.
  if (existing.run.status === 'queued') {
    const { data: settled, error: settleError } = await supabase
      .from('prospecting_run')
      .update({ status: 'canceled', finished_at: new Date().toISOString() })
      .eq('id', args.runId)
      .eq('workspace_id', args.workspaceId)
      .eq('status', 'queued')
      .select(RUN_COLUMNS)
    if (settleError) {
      console.error('[prospecting] queued run cancel failed:', settleError.message)
      return fail('DB_ERROR', 'Failed to cancel run')
    }
    const settledRows = (settled ?? []) as unknown as ProspectingRunRow[]
    if (settledRows.length > 0) {
      await settleProspectingWorkByRun(getServiceClient(), args.runId, { status: 'canceled' })
      // Best effort: lets Inngest drop a function run still waiting on the
      // workspace lane rather than have it wake up, fail the claim and exit.
      // The row is already terminal, so a failed send changes nothing.
      try {
        const event: ProspectingRunCancelEvent = {
          name: PROSPECTING_RUN_CANCEL,
          data: { runId: args.runId },
        }
        await inngest.send(event)
      } catch (err) {
        console.error(
          '[prospecting] run.cancel send failed after settling a queued run:',
          err instanceof Error ? err.message : String(err),
        )
      }
      return { ok: true, run: withLive(settledRows[0]) }
    }
  }

  const { data, error } = await supabase
    .from('prospecting_run')
    .update({ status: 'canceling' })
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .in('status', CANCELABLE_STATUSES as unknown as string[])
    .select(RUN_COLUMNS)
  if (error) {
    console.error('[prospecting] run cancel failed:', error.message)
    return fail('DB_ERROR', 'Failed to cancel run')
  }
  const rows = (data ?? []) as unknown as ProspectingRunRow[]
  if (rows.length === 0) {
    // Settled in the gap. Emitting the event now would settle a finished run
    // as canceled.
    return fail('NOT_CANCELABLE', 'This run has already finished')
  }

  try {
    const event: ProspectingRunCancelEvent = {
      name: PROSPECTING_RUN_CANCEL,
      data: { runId: args.runId },
    }
    await inngest.send(event)
  } catch (err) {
    // The row already says `canceling`, which is honest: the request was
    // recorded. Report the failure so the caller can retry rather than
    // watching a run that nobody told to stop.
    console.error(
      '[prospecting] run.cancel send failed:',
      err instanceof Error ? err.message : String(err),
    )
    return fail('DB_ERROR', 'Cancel was recorded but could not be delivered')
  }

  return { ok: true, run: withLive(rows[0]) }
}

// ---------------------------------------------------------------------------
// listRunCandidates — the transparency ledger
// ---------------------------------------------------------------------------

/**
 * Where the UI can send the user for a suppressed candidate.
 *
 * Only three of the ten suppression sources are backed by a row the user can
 * open. The rest are deliberately unlinked rather than faked:
 *   - `contacted` → `sequence_enrollment.id`, a join row with no page.
 *   - `opted_out` → `outreach_suppression.id`, likewise.
 *   - `self` / `personal_domain` / `noise_host` → no row at all; `ref_id` is
 *     NULL by construction in `buildExclusionSet` / `admitCandidates`.
 *   - `over_cap` → the person was seen, not stored; there is nothing to open.
 */
export interface CandidateLinkTarget {
  kind: 'entry' | 'company' | 'contact'
  id: string
}

export interface RunCandidateView extends ProspectRunCandidateRow {
  /** Resolved from `suppressed_ref_id` (or `entry_id` for a `new` candidate),
   *  or null when the reason is not row-backed. */
  link: CandidateLinkTarget | null
}

/** One `suppressed_by` bucket. `reason` is null for the `new` and `invalid`
 *  groups, which have no suppression rule. */
export interface RunCandidateGroup {
  outcome: ProspectCandidateOutcome
  reason: ProspectSuppressionSource | null
  count: number
  candidates: RunCandidateView[]
}

/**
 * The run's candidate ledger, grouped the way the collapsed "17 skipped" row
 * expands (§6): by outcome, and within `suppressed`, by the rule that caught
 * the candidate.
 *
 * Group ORDER is the `PROSPECT_SUPPRESSION_SOURCES` order, which is the
 * precedence order `buildExclusionSet` claims keys in — so the most actionable
 * reason ("already in this list") is the first thing the user reads.
 *
 * The link resolution costs at most two extra reads for the whole ledger, both
 * workspace-scoped: one `company` probe and one `contact` probe over the
 * distinct `crm` ref ids. `crm` is the one source whose ref points at either
 * table depending on whether the candidate was a company or a person, and
 * guessing from `raw` would be a lie the moment the people stage lands — so it
 * is resolved by asking.
 */
export async function listRunCandidates(
  supabase: SupabaseClient,
  args: { workspaceId: string; runId: string },
): Promise<
  RunResult<{
    run: ProspectingRunWithLive
    groups: RunCandidateGroup[]
    total: number
  }>
> {
  const runResult = await getRun(supabase, args)
  if (!runResult.ok) return runResult

  const { data, error } = await supabase
    .from('prospect_run_candidate')
    .select(CANDIDATE_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('run_id', args.runId)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[prospecting] run candidates failed:', error.message)
    return fail('DB_ERROR', 'Failed to load run candidates')
  }
  const rows = (data ?? []) as unknown as ProspectRunCandidateRow[]

  // -- resolve the `crm` refs ------------------------------------------------
  const crmRefs = Array.from(
    new Set(
      rows
        .filter((r) => r.suppressed_by === 'crm' && r.suppressed_ref_id)
        .map((r) => r.suppressed_ref_id as string),
    ),
  )
  const companyIds = new Set<string>()
  const contactIds = new Set<string>()
  if (crmRefs.length > 0) {
    const [companies, contacts] = await Promise.all([
      supabase.from('company').select('id').eq('workspace_id', args.workspaceId).in('id', crmRefs),
      supabase.from('contact').select('id').eq('workspace_id', args.workspaceId).in('id', crmRefs),
    ])
    if (companies.error || contacts.error) {
      // A ledger without links is still the audit trail; losing the whole
      // response over a link probe would be the wrong trade.
      console.error(
        '[prospecting] candidate link probe failed:',
        companies.error?.message ?? contacts.error?.message,
      )
    }
    for (const row of ((companies.data ?? []) as Array<{ id: string }>)) companyIds.add(row.id)
    for (const row of ((contacts.data ?? []) as Array<{ id: string }>)) contactIds.add(row.id)
  }

  function linkFor(row: ProspectRunCandidateRow): CandidateLinkTarget | null {
    // A `new` candidate points at the entry it became — the row the user
    // actually wants to see.
    if (row.outcome === 'new') return row.entry_id ? { kind: 'entry', id: row.entry_id } : null
    const ref = row.suppressed_ref_id
    if (!ref) return null
    switch (row.suppressed_by) {
      case 'this_list':
      case 'other_list':
      case 'dismissed_global':
        return { kind: 'entry', id: ref }
      case 'crm':
        if (companyIds.has(ref)) return { kind: 'company', id: ref }
        if (contactIds.has(ref)) return { kind: 'contact', id: ref }
        // The CRM row was deleted since the run: the entry survives, the link
        // does not.
        return null
      default:
        // contacted / opted_out / self / personal_domain / noise_host /
        // over_cap — see the doc above.
        return null
    }
  }

  const views: RunCandidateView[] = rows.map((row) => ({ ...row, link: linkFor(row) }))

  // -- group ----------------------------------------------------------------
  const groups: RunCandidateGroup[] = []
  const push = (
    outcome: ProspectCandidateOutcome,
    reason: ProspectSuppressionSource | null,
    candidates: RunCandidateView[],
  ) => {
    if (candidates.length > 0) groups.push({ outcome, reason, count: candidates.length, candidates })
  }

  push('new', null, views.filter((v) => v.outcome === 'new'))
  for (const reason of PROSPECT_SUPPRESSION_SOURCES) {
    push('suppressed', reason, views.filter((v) => v.outcome === 'suppressed' && v.suppressed_by === reason))
  }
  // A suppressed row whose `suppressed_by` is NULL should not exist, but the
  // column is nullable and the ledger's job is to hide nothing.
  push('suppressed', null, views.filter((v) => v.outcome === 'suppressed' && !v.suppressed_by))
  push('invalid', null, views.filter((v) => v.outcome === 'invalid'))

  return { ok: true, run: runResult.run, groups, total: views.length }
}
