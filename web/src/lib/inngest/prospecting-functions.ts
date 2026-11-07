/**
 * The Prospecting run lane — one Inngest function for all THREE run kinds
 * (spec §7).
 *
 * ONE function, `prospecting-run-execute`, triggered by
 * `prospecting/run.requested` and cancellable by `prospecting/run.cancel`.
 *
 * ---------------------------------------------------------------------------
 * ONE EVENT, THREE ENGINES
 * ---------------------------------------------------------------------------
 * `discover`, `account_card` and `people` share this function, this lane, this
 * claim and this failure handling, and differ only in which engine the claimed
 * row is handed to. The kind travels on the ROW (`prospecting_run.kind`), not
 * in the event, and {@link ENGINES} dispatches on it after the claim.
 *
 * That is deliberate rather than incidental. Three event names would mean three
 * triggers that must share one `concurrency` key and one `cancelOn` to keep
 * their guarantees — and the lane is the only thing bounding paid Exa calls per
 * workspace, while `cancelOn` is the only thing that stops a run between steps.
 * Splitting them would give three chances to get either wrong. Reading the kind
 * from the row also means a REDELIVERED attempt reads the same kind the first
 * one did, even if the event payload were ever to change shape.
 *
 * An UNKNOWN kind is refused rather than defaulted: a `discover` run fired for
 * someone who asked for people would spend their budget on the wrong thing,
 * which is worse than a run that visibly did nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY ITS OWN LANE
 * ---------------------------------------------------------------------------
 * `concurrency: [{ limit: 1, key: 'event.data.workspaceId' }]`. One at a time
 * per workspace, because a run is a sequence of paid Exa searches against a
 * shared workspace budget and two concurrent runs would race the monthly
 * ceiling check in preflight — both would read a spend total that neither had
 * written yet. The partial unique index `prospecting_run_one_live_per_list`
 * refuses two live runs on ONE list at the database; this lane is what bounds
 * spend across DIFFERENT lists in the same workspace.
 *
 * It is deliberately NOT the `crm/enrich-*` lane (limit 2 per workspace).
 * That lane is what a user's own Enrich click uses, and a discovery run
 * sitting in it would make an interactive click wait minutes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES AND DOES NOT DO
 * ---------------------------------------------------------------------------
 * It sequences steps, CLAIMS the row and picks the engine. That is all. Every
 * decision and every terminal write lives in the engines themselves
 * (`run.ts`, `account-run.ts`, `people-run.ts`, over the shared lifecycle in
 * `run-shared.ts`) — the crm-enrichment precedent, adopted for the same
 * reason: a run that RETURNS has already persisted its outcome, so a run
 * that THROWS is transient by construction and Inngest's retries are always
 * retrying something that might succeed.
 *
 * The one exception is a throw that ESCAPES the engine. Inngest will retry it
 * `PROSPECTING_INNGEST_RETRIES` times and then give up — leaving the row stuck
 * at `running` forever, which the poll renders as a spinner that never stops.
 *
 * ---------------------------------------------------------------------------
 * WHO WRITES `failed` WHEN THE HANDLER THROWS — AND WHY IT IS `onFailure`
 * ---------------------------------------------------------------------------
 * There are exactly two paths, and they are not the same.
 *
 * 1. `NonRetriableError` (the usage cap). By definition there is no later
 *    attempt, so the handler catches it and writes `failed` inline. That write
 *    cannot disable a retry because there is none.
 *
 * 2. Everything else. The handler does NOT write a status; it rethrows and
 *    lets Inngest retry. When the retries are exhausted, Inngest emits
 *    `inngest/function.failed` and runs {@link prospectingRunOnFailure}, which
 *    writes `failed` ONCE.
 *
 * This used to be decided in-handler by comparing `ctx.attempt` against
 * `PROSPECTING_INNGEST_RETRIES` ("am I the last attempt?"). That inference was
 * WRONG IN PRODUCTION: observed live, a run whose only step threw
 * `ExaNotConfiguredError` on every attempt exhausted its retries under the real
 * Inngest dev server (inngest ^4.0.0 / inngest-cli 1.44) without the
 * last-attempt branch ever firing, and the row sat at `running` forever. The
 * handler does not reliably know which execution is the final one, so it must
 * stop guessing. `onFailure` is Inngest's own documented answer: it runs after
 * — and only after — all retries are exhausted, exactly once.
 *
 * Why the eager write is still not an option (this is the trap `onFailure`
 * exists to avoid): writing `failed` on every attempt looks harmless, since a
 * successful retry would overwrite it. But the engine's resume guard treats
 * `failed` as TERMINAL and returns without doing any work, so attempt 2 of a
 * run that hit one transient Exa hiccup would find a row the wrapper itself
 * had marked dead and give up. Between attempts the row must stay `running`.
 * That is also why the claim accepts `running` — see the claim comment.
 *
 * `onFailure`'s write is filtered `.in('status', ['queued','running',
 * 'canceling'])` so it can never clobber a terminal status the engine wrote:
 * a run that finished `completed` and then failed a later step still reads
 * `completed`.
 *
 * ---------------------------------------------------------------------------
 * STEP DISCIPLINE — the thing that silently breaks
 * ---------------------------------------------------------------------------
 * Every `step.run` call in this file is made from the TOP LEVEL of the
 * handler. Nothing calls `step.*` from inside a `step.run` callback: that does
 * not throw in production, it hangs for minutes having done nothing (the
 * hubspot-push-sweep incident). `createStepMock()` in
 * `src/test/inngest-step-mock.ts` has an AsyncLocalStorage tripwire for
 * exactly this, and it is mandatory in this function's tests.
 *
 * The engine itself is ONE step, not one per angle or per company. That is a deliberate
 * departure from §7's "each per-company card and people search is its own
 * step.run": splitting the discovery loop across steps would require the loop
 * to live in the handler, and the loop's stop conditions depend on state
 * (new-this-run, the in-memory exclusion set, spend) that Inngest would have to
 * serialize and replay between every angle. The resumability that buys is also
 * worth less than it sounds: a replayed angle re-bills its Exa call anyway,
 * because memoization stores the STEP's result and the money was already spent.
 * Durability comes instead from the engine writing progress, spend and entries
 * after every angle, so a crashed run's partial results are all on the row.
 */
import { NonRetriableError } from 'inngest'
import { probeParkedDomain } from '@/lib/prospecting/parked'
import {
  inngest,
  PROSPECTING_RUN_CANCEL,
  PROSPECTING_RUN_REQUESTED,
  type ProspectingRunCancelEvent,
  type ProspectingRunRequestedEvent,
} from './client'
import { guardBackgroundUsage, guardBackgroundUsageOnPlan } from './usage-guard'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { planDeepSearch } from '@/lib/web-research/plan-deep-search'
import { getServiceClient } from '@/lib/supabase/service'
import { deepSearch } from '@/lib/exa/deep-search'
import { executeAccountCardRun } from '@/lib/prospecting/account-run'
import { executePeopleRun } from '@/lib/prospecting/people-run'
import { executeDiscoveryRun } from '@/lib/prospecting/run'
import { chainProfileRun } from '@/lib/prospecting/runs'
import { createProspectingRunMirror, settleProspectingWorkByRun } from '@/lib/work/prospecting-run-mirror'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  RunEngineArgs,
  RunEngineDeps,
  RunEngineOutcome,
} from '@/lib/prospecting/run-shared'
import type { ProspectingRunKind } from '@/lib/prospecting/types'

/**
 * Retries for the discovery lane.
 *
 * ONE. A discovery run's failures are overwhelmingly upstream-Exa or database
 * hiccups, and a second attempt is cheap relative to the run — but every
 * attempt after the first re-runs preflight and re-bills any angle that had
 * not yet written its entries, so a high retry count multiplies real money.
 * Shared as a constant because the test asserts against it rather than a
 * literal.
 */
export const PROSPECTING_INNGEST_RETRIES = 1

/**
 * The statuses a claim (and a failure write) may act on.
 *
 * Everything that is NOT terminal. `queued` is the first attempt; `running` is
 * a redelivered attempt finding its own row mid-flight; `canceling` is a
 * cancel the engine has not yet converted to `canceled`. A terminal status
 * (`completed`, `failed`, `canceled`, `budget_exhausted`) is absent on
 * purpose: it is the engine's word on the run, and nothing here may overwrite
 * it.
 */
export const CLAIMABLE_STATUSES = ['queued', 'running', 'canceling'] as const

/**
 * The statuses the claim may flip to `running`: CLAIMABLE_STATUSES without
 * `canceling`. A cancel pressed before this attempt claimed the row (or
 * between a retry's attempts) must not be overwritten with `running`; that row
 * is claimed as it stands, and the engine's pre-call cancel check settles it
 * as `canceled`.
 */
export const RUNNABLE_STATUSES = ['queued', 'running'] as const

/** The two payloads, re-exported from their home in `client.ts` so a reader of
 *  this file does not have to go looking for the contract. */
export type ProspectingRunRequestedData = ProspectingRunRequestedEvent['data']
export type ProspectingRunCancelData = ProspectingRunCancelEvent['data']

type ProspectingStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
}

/**
 * The narrow slice of the Supabase client {@link writeRunFailure} uses.
 *
 * Spelled out structurally rather than importing `SupabaseClient` so the
 * failure writer can be handed a test double without casting: the write is
 * one filtered update, and this is exactly its shape.
 */
type FailureWriteClient = {
  from: (table: string) => {
    update: (payload: Record<string, unknown>) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          in: (
            column: string,
            values: readonly string[],
          ) => PromiseLike<{ error: { message: string } | null }>
        }
      }
    }
  }
}

/**
 * The three engines, keyed by `prospecting_run.kind`.
 *
 * A `Record` over the kind union rather than a switch, so adding a kind to
 * `PROSPECTING_RUN_KINDS` without adding an engine here is a TYPE ERROR rather
 * than a run that claims its row and then quietly does nothing.
 *
 * All three have the same signature by construction — they share
 * `RunEngineDeps`, `RunEngineArgs` and `RunEngineOutcome` from `run-shared`,
 * which is the whole reason those live in a module of their own.
 */
const ENGINES: Record<
  ProspectingRunKind,
  (deps: RunEngineDeps, args: RunEngineArgs) => Promise<RunEngineOutcome>
> = {
  discover: executeDiscoveryRun,
  account_card: executeAccountCardRun,
  people: executePeopleRun,
}

export const prospectingRunExecute = inngest.createFunction(
  {
    id: 'prospecting-run-execute',
    retries: PROSPECTING_INNGEST_RETRIES,
    // Its own lane. See the header: one paid run per workspace at a time.
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }],
    // Stop the function the moment a cancel for THIS run arrives. Note that
    // Inngest cancellation does NOT run the engine's terminal write, so the
    // cancel ROUTE writes `canceling` before sending the event and the engine
    // ALSO polls for it between angles — a cancel that lands mid-step becomes
    // `canceled` with partial results by the engine's own check, and a cancel
    // that lands between steps is caught by Inngest here.
    cancelOn: [{ event: PROSPECTING_RUN_CANCEL, match: 'data.runId' }],
    // Runs ONCE, after every retry is exhausted. This — not an `attempt`
    // comparison inside the handler — is what stops a run spinning at
    // `running` forever. See the header and `prospectingRunOnFailure`.
    onFailure: (ctx: unknown) =>
      prospectingRunOnFailure(ctx as Parameters<typeof prospectingRunOnFailure>[0]),
    triggers: [{ event: PROSPECTING_RUN_REQUESTED }],
  },
  async ({ event, step }: { event: { data: unknown }; step: ProspectingStep }) => {
    const data = event.data as Partial<ProspectingRunRequestedData> | null
    if (!data?.runId || !data?.workspaceId || !data?.listId) {
      return { skipped: 'missing_ids' }
    }
    const { runId, workspaceId, listId } = data
    const userId = data.userId ?? null

    const supabase = getServiceClient()

    // ── 1. CLAIM the row, queued|running → running (canceling as is) ────
    //
    // A compare-and-set, not a read-then-write: the status filter is the
    // CONDITION, and PostgREST's returned rows tell us whether we won.
    // Losing means the row already reached a TERMINAL status (completed,
    // failed, canceled, budget_exhausted), so we exit IDEMPOTENTLY rather
    // than executing it a second time and re-billing every angle.
    //
    // `running` is in the accepted set, and that is load-bearing rather than
    // sloppy. Attempt 1 leaves the row at `running` on purpose: a retriable
    // throw must NOT mark the row failed while an attempt is still pending,
    // because the engine's resume guard reads `failed` as terminal. So the
    // redelivered attempt 2 necessarily finds `running` — its own row, mid
    // flight — and a claim that only accepted `queued` would refuse it and
    // return `not_queued`, silently converting `retries: 1` into no retry at
    // all. The row is scoped by `id` + `workspace_id`, so accepting `running`
    // admits exactly one run: this one, on redelivery. Cross-run overlap is
    // still refused by the `prospecting_run_one_live_per_list` partial unique
    // index and by this function's `concurrency: 1` per workspace.
    const claimed = await step.run('claim-run', async () => {
      const { data: rows, error } = await supabase
        .from('prospecting_run')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', runId)
        .eq('workspace_id', workspaceId)
        .in('status', RUNNABLE_STATUSES)
        // `kind` comes back WITH the claim rather than in a second read: the
        // claim is the moment this attempt takes ownership of the row, and
        // reading the kind separately would open a window in which the row it
        // claimed and the row it dispatched on are not provably the same one.
        .select('id, kind')
      if (error) throw new Error(`prospecting_run claim failed: ${error.message}`)
      const row = (rows ?? [])[0] as { id?: string; kind?: string } | undefined
      if (row) return { claimed: true as const, kind: row.kind ?? 'discover' }
      // Not queued or running. A `canceling` row is still this run's to
      // finish (with its partial results), but its status stays `canceling`:
      // the engine checks it before every paid call and writes `canceled`.
      const { data: canceling, error: readError } = await supabase
        .from('prospecting_run')
        .select('id, kind')
        .eq('id', runId)
        .eq('workspace_id', workspaceId)
        .eq('status', 'canceling')
        .maybeSingle()
      if (readError) throw new Error(`prospecting_run claim failed: ${readError.message}`)
      const held = canceling as { id?: string; kind?: string } | null
      return held ? { claimed: true as const, kind: held.kind ?? 'discover' } : { claimed: false as const }
    })

    if (!claimed.claimed) {
      return { skipped: 'not_claimable', runId }
    }

    // ── 2. DISPATCH on the row's kind ───────────────────────────────────
    const engine = ENGINES[claimed.kind as ProspectingRunKind]
    if (!engine) {
      // Not retriable and not the engine's to write: nothing will make an
      // unrecognized kind valid on a second attempt, and the engine that would
      // own the terminal write is the very thing we could not choose. So the
      // wrapper writes `failed` itself, filtered to the non-terminal statuses.
      await step.run('record-unknown-kind', () =>
        recordFailure(supabase, {
          runId,
          workspaceId,
          message: `unknown run kind: ${String(claimed.kind)}`,
        }),
      )
      return { status: 'failed', error: 'unknown_kind', runId }
    }

    // ── 3. The run itself ───────────────────────────────────────────────
    //
    // A person on their own ChatGPT plan (the free tier): the run's searches go
    // to their plan instead of Exa (planDeepSearch), gated with the plan
    // opt-in. A plan that can't be read throws (retriable), never an Exa run
    // for them; a run with no person is Exa's, as before.
    const onPlan = await step.run('chatgpt-plan', () => chatgptPlanFor(userId, { attempts: 2, failClosed: true }))
    const planSearcher = onPlan && userId ? { userId, workspaceId } : null
    try {
      const outcome = await step.run('execute-run', () =>
        engine(
          {
            supabase,
            deepSearch: planSearcher ? (args) => planDeepSearch(args, planSearcher) : deepSearch,
            now: () => new Date(),
            guardUsage: planSearcher ? async (id) => { await guardBackgroundUsageOnPlan(id) } : guardBackgroundUsage,
            // Discovery's parked-domain gate — one GET per candidate domain,
            // so a for-sale page never becomes a row (see ./parked).
            probeDomain: probeParkedDomain,
            // The run's Activity row (Sequence row 6): a step per progress
            // write, the settle at the engine's terminal write. Fail-soft.
            work: createProspectingRunMirror(supabase, {
              id: runId,
              workspaceId,
              listId,
              kind: claimed.kind as ProspectingRunKind,
            }),
          },
          { runId, workspaceId, listId, userId },
        ),
      )

      // ── 4. The hand-off ────────────────────────────────────────────────
      //
      // "Find companies" means find AND score, for the FULL list: every
      // company discovery found gets its full profile (and THE score) without
      // anyone pressing a button, and the page re-sorts hottest first as the
      // scores land. Its own step, AFTER the engine's terminal write, so the
      // one-live-per-list lock is free and a retry of this step can never
      // re-run the search. Two cases chain:
      //   • a DISCOVERY that finished (completed, or stopped early with
      //     results) starts the first profile pass;
      //   • a profile pass that was itself chained (`data.handoff`) and
      //     completed starts the next pass, because one pass is capped at the
      //     targeted-run ceiling and a big discovery needs more than one.
      //     The pass carries the hand-off's `before` so the set of targets
      //     strictly shrinks (see chainProfileRun) and the last pass finds
      //     nothing. A profile run a PERSON started never chains — that is
      //     the manual catch-up path, and it does what it was asked.
      // A cancelled or failed run hands off nothing: the user stopped it, or
      // it never found anything to score.
      const finished = outcome.status === 'completed' || outcome.status === 'budget_exhausted'
      const chainsNext =
        finished &&
        (claimed.kind === 'discover' ||
          (claimed.kind === 'account_card' && Boolean(data.handoff) && outcome.status === 'completed'))
      if (chainsNext) {
        const before = data.handoff?.before
        const handoff = await step.run('chain-profile-run', () =>
          chainProfileRun(supabase, { workspaceId, listId, userId, before }),
        )
        return { ...outcome, chained_run_id: handoff.runId }
      }
      return outcome
    } catch (err) {
      // The engine owns every terminal write it can reach. This is the path it
      // cannot: something threw out of it.
      //
      // A RETRIABLE error is NOT written here. It rethrows, Inngest retries,
      // and if the retries run out `onFailure` below writes `failed` exactly
      // once. Writing it here would leave the row `failed` while an attempt is
      // still pending, and the engine's resume guard reads `failed` as
      // terminal and returns without searching — quietly converting every
      // retriable error into a permanent failure.
      if (!(err instanceof NonRetriableError)) throw err

      // NonRetriable (the usage cap) is the exception: Inngest will not retry
      // it, so there is no later attempt to protect and no `onFailure` to wait
      // for. Mark it now or the row stays `running` forever.
      const message = err.message
      await step.run('record-failure', () =>
        recordFailure(supabase, { runId, workspaceId, message }),
      )
      return { status: 'failed', error: message, runId }
    }
  },
)

/**
 * The failure write, shared by the NonRetriable path and {@link
 * prospectingRunOnFailure}.
 *
 * Two invariants, both deliberate:
 *  - the MESSAGE, never the stack. This string is rendered to the user in the
 *    run history; a stack would leak file paths into the UI.
 *  - `.in('status', CLAIMABLE_STATUSES)`. The engine's terminal statuses are
 *    absent from that list, so a run that already wrote `completed`,
 *    `canceled` or `budget_exhausted` keeps it. A late failure must never
 *    rewrite a finished run's verdict.
 *
 * Never throws: a failed failure-write is logged, because the caller is
 * already on an error path and throwing there buys nothing.
 */
export async function writeRunFailure(
  supabase: FailureWriteClient,
  args: { runId: string; workspaceId: string; message: string },
): Promise<{ written: boolean }> {
  const { error } = await supabase
    .from('prospecting_run')
    .update({
      status: 'failed',
      error: args.message.slice(0, 500),
      finished_at: new Date().toISOString(),
    })
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .in('status', CLAIMABLE_STATUSES)
  if (error) {
    console.error('[prospecting] failure write failed:', error.message)
    return { written: false }
  }
  return { written: true }
}

/**
 * Inngest's post-retry failure hook — the ONLY thing that marks a retriable
 * failure `failed`.
 *
 * Inngest runs this after the function has exhausted every retry, by emitting
 * the internal `inngest/function.failed` event. Its payload (confirmed against
 * `FailureEventPayload` in `node_modules/inngest/types.d.ts`, inngest 4.0.0)
 * nests the ORIGINAL event one level down:
 *
 *   { event: { name: 'inngest/function.failed',
 *              data: { function_id, run_id, error, event: <original> } },
 *     error: Error }
 *
 * — so the ids live at `event.data.event.data`, NOT at `event.data`. Reading
 * the wrong level is the whole reason this is spelled out here.
 *
 * Exported so a test can invoke it directly with a synthetic failure event;
 * it is also wired into this function's `onFailure` option above.
 */
export async function prospectingRunOnFailure({
  event,
  error,
}: {
  event: { data?: { event?: { data?: unknown } | null } | null }
  error: { message?: string } | null
}): Promise<{ skipped?: string; runId?: string; written?: boolean }> {
  const original = event?.data?.event?.data as Partial<ProspectingRunRequestedData> | null
  if (!original?.runId || !original?.workspaceId) {
    // Nothing to write onto. Log rather than throw: throwing out of a failure
    // hook only produces a second failure.
    console.error('[prospecting] onFailure: no runId on the original event')
    return { skipped: 'missing_ids' }
  }

  const message = typeof error?.message === 'string' && error.message ? error.message : 'run failed'

  const { written } = await recordFailure(getServiceClient(), {
    runId: original.runId,
    workspaceId: original.workspaceId,
    message,
  })
  return { runId: original.runId, written }
}

/** The failure write, then the run's Activity row (Sequence row 6). The ledger
 *  fail is safe after a lost write: see settleProspectingWorkByRun. */
async function recordFailure(
  supabase: SupabaseClient,
  args: { runId: string; workspaceId: string; message: string },
): Promise<{ written: boolean }> {
  const result = await writeRunFailure(supabase, args)
  if (result.written) {
    await settleProspectingWorkByRun(supabase, args.runId, { status: 'failed', error: args.message.slice(0, 500) })
  }
  return result
}
