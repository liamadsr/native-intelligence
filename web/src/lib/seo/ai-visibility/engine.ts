/**
 * The AI visibility check, one step at a time. The background lane
 * (src/lib/inngest/seo-ai-visibility-functions.ts) runs these in order; each
 * is one step body, safe to run twice, reading what it needs from the store
 * (./store.ts, or the in-memory one in the tests).
 *
 *   prepare        claim the check (queued -> running, a compare-and-set),
 *                  decide who pays (./gate.ts), and split its answers into
 *                  batches: queued engines (ChatGPT, Gemini, AI Overviews) in
 *                  posts of up to 100 per engine, model engines (Claude,
 *                  Perplexity) in small groups asked live.
 *   post-N         one paid task post: the answers are claimed first
 *                  (pending -> asking, seo_ai_answers_begin), then posted
 *                  ONCE. A retried step finds them asking and posts nothing,
 *                  so nothing is ever paid twice. Accepted answers become
 *                  posted with their task id; refused ones fail.
 *   model-N        the same claim, then each answer asked live through the
 *                  model's own API, ONCE, and saved as it arrives. Up to
 *                  MODEL_ANSWERS_PER_STEP are asked at once, each reading the
 *                  same month's spend at the meter; when what is left of the
 *                  month is under twice the batch's estimate, they are asked
 *                  one after another instead, so the ceiling is overshot by
 *                  one answer at most.
 *   collect-N      after a sleep, one free read of every posted answer:
 *                  finished ones are saved (matched against the brands),
 *                  failed ones fail, the rest wait for the next read.
 *   finalize       what was sent and paid for but could not be recorded
 *                  (the step's own report, kept by the lane) fails as not
 *                  tracked, with its cost; what was never sent fails as not
 *                  sent, what never arrived as not arrived (a late read may
 *                  still fill it); the counts and cost are written, and the
 *                  check ends completed, or failed when the monthly ceiling
 *                  stopped it (with the ceiling's own words) or no answer
 *                  came back at all (saying what was charged, if anything).
 *   late-N         after the check, a free read of the answers that had not
 *                  arrived; one that has is saved, marked late.
 *
 * NEVER A BLIND RETRY. Every paid call is made once. A step that throws
 * before the call is retried and finds its claim; a step never throws after
 * the call (its writes are retried in place). When a write after a paid call
 * still fails, the answer is failed NOT_TRACKED with its cost, and the step
 * also returns it (`untracked`), so finalize can say so even when the
 * database refused every write of that step: an answer that was sent and
 * charged never ends as "not sent".
 */
import type { DataforseoClient } from '@/lib/seo/dataforseo'
import type {
  AiTrackingAnswer,
  PostedAiTrackingTask,
} from '@/lib/seo/dataforseo/ai-tracking'
import type { LlmResponseModelSlug } from '@/lib/seo/dataforseo/llm-models'
import { DataforseoChargedTaskError, isSeoError } from '@/lib/seo/errors'
import {
  aiEngineUsesModelApi,
  type AiEngine,
} from '@/lib/seo/shared/ai-visibility'
import { getIsoCountryCode } from '@/lib/seo/shared/keyword-locations'
import { MAX_TASKS_PER_POST } from '@/lib/seo/shared/rank-tracking'
import { aiAnswerUsd, formatUsd } from './cost'
import { parseDataforseoAnswer, parseLlmResponseAnswer } from './evidence'
import { sourceRowId } from './ids'
import { MODEL_ANSWERS_PER_STEP, TASK_READS_AT_ONCE } from './limits'
import { matchAiBrands, type ParsedAiAnswer } from './matching'
import type {
  AiAnswerStatus,
  AiBrandResult,
  AiRunBrand,
  AiRunStatus,
  AiRunTrigger,
} from './view'

export interface EngineRun {
  id: string
  workspace_id: string
  tracker_id: string
  trigger: AiRunTrigger
  status: AiRunStatus
  started_by: string | null
  engines: AiEngine[]
  location_code: number
  language_code: string
  brands: AiRunBrand[]
}

export interface OpenAnswer {
  id: string
  prompt_text: string
  engine: AiEngine
  status: AiAnswerStatus
  task_id: string | null
  error_code: string | null
}

export interface CollectedAnswer {
  id: string
  has_answer: boolean
  answer_markdown: string | null
  model_name: string | null
  brand_mentioned: boolean
  brand_cited: boolean
  brand_position: number | null
  brand_first_offset: number | null
  matches: AiBrandResult[]
  citation_count: number
  collected_at: string
  /** Set for an answer asked live (its price estimate); a queued answer's cost was written when posted. */
  cost_usd: number | null
  sources: Array<{
    id: string
    url: string
    domain: string
    title: string | null
    position: number
  }>
}

export interface RunCounts {
  answers_total: number
  answers_collected: number
  answers_no_answer: number
  answers_failed: number
  answers_late: number
  answers_open: number
  /** What the check's answers cost, as recorded on them (USD). */
  cost_usd: number
}

/** An answer that was sent and paid for, but whose result could not be written. */
export interface UntrackedAnswer {
  id: string
  cost_usd: number
}

/** Why an answer that was sent and charged has no result: its write failed. */
export const NOT_TRACKED = 'NOT_TRACKED'

export interface AiRunStore {
  getRun(runId: string): Promise<EngineRun | null>
  /** queued -> running (running accepted, so a redelivered attempt carries on). */
  claimRun(runId: string): Promise<boolean>
  getTracker(
    trackerId: string,
  ): Promise<{
    workspace_id: string
    created_by: string | null
    paused: boolean
    schedule_interval: string
  } | null>
  listAnswers(
    runId: string,
    filter: {
      statuses: AiAnswerStatus[]
      ids?: string[]
      errorCode?: string
      withTask?: boolean
    },
  ): Promise<OpenAnswer[]>
  /** seo_ai_answers_begin: pending -> asking, only while the check runs. Returns the ids claimed. */
  beginAnswers(runId: string, ids: string[]): Promise<string[]>
  /** asking -> posted, with the task id and what the post cost. */
  markPosted(
    runId: string,
    posted: Array<{ id: string; task_id: string; cost_usd: number }>,
  ): Promise<void>
  /** Write a collected answer and its sources. Only an answer still asking or posted (or, late, failed as not arrived) changes. */
  saveAnswer(
    runId: string,
    answer: CollectedAnswer,
    opts: { late: boolean },
  ): Promise<boolean>
  /** Fail the answers named (or every answer in `from` when ids is null) that are still in one of `from`. `costUsd`: what each one was charged, recorded on it. */
  failAnswers(
    runId: string,
    ids: string[] | null,
    code: string,
    from: AiAnswerStatus[],
    opts?: { costUsd?: number },
  ): Promise<number>
  refreshCounts(runId: string): Promise<RunCounts>
  /** End a live check (a compare-and-set from queued or running). */
  finishRun(
    runId: string,
    patch: {
      status: 'completed' | 'failed'
      error_code: string | null
      error_detail: string | null
    },
  ): Promise<boolean>
  touchTracker(trackerId: string, patch: { last_run_at: string }): Promise<void>
}

type AiSearchClient = Pick<DataforseoClient, 'aiSearch'>

export interface EngineDeps {
  /** The metered client the check spends through (the person's for a manual check, the workspace's for a scheduled one). */
  client: (run: EngineRun) => AiSearchClient
  /** The free read of a queued answer. */
  fetchTaskResult: (input: {
    engine: AiEngine
    taskId: string
  }) => Promise<{ status: 'pending' } | AiTrackingAnswer>
  resolveModelName: (slug: LlmResponseModelSlug) => Promise<string>
  /** Manual checks: may this person spend? */
  checkAccess: (who: {
    userId: string | null
    workspaceId?: string | null
    unattended?: boolean
  }) => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  /** Scheduled checks: may this tracker's schedule spend? */
  scheduledGate: (tracker: {
    workspace_id: string
    created_by: string | null
    paused: boolean
    schedule_interval: string
  }) => Promise<{ ok: true } | { ok: false; reason: string; message: string }>
  /** What is left of the workspace's monthly ceiling now (USD). A read that fails counts as nothing left. */
  remainingBudgetUsd: (run: EngineRun) => Promise<number>
  now?: () => Date
}

export interface Batch {
  engine: AiEngine
  ids: string[]
}

export type PrepareOutcome =
  | { kind: 'skip'; reason: 'not_claimable' | 'missing' }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'ok'; queue: Batch[]; model: Batch[] }

export interface PaidStepOutcome {
  /** Answers sent (posted, or asked live). */
  sent: number
  collected: number
  failed: number
  /** The monthly ceiling refused a call: its own words. */
  spend_limit: string | null
  /** Sent and paid for, but the result could not be written: finalize fails them NOT_TRACKED. */
  untracked: UntrackedAnswer[]
}

const nowOf = (deps: Pick<EngineDeps, 'now'>) => deps.now?.() ?? new Date()

function errorCodeOf(err: unknown): string {
  return isSeoError(err) ? err.code : 'INTERNAL_ERROR'
}

function spendLimitOf(err: unknown): string | null {
  if (!isSeoError(err) || err.code !== 'SPEND_LIMIT_REACHED') return null
  return err.message && err.message !== err.code
    ? err.message
    : 'This workspace has reached its search data limit for the month.'
}

/** A write after a paid call: retried in place, never thrown (the call is already paid for). Returns whether it was written. */
async function afterPaid(
  what: string,
  write: () => Promise<unknown>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await write()
      return true
    } catch (err) {
      if (attempt === 3)
        console.error(`[seo-ai] ${what} failed after a paid call`, err)
    }
  }
  return false
}

/** Fail sent-and-charged answers NOT_TRACKED, each with its cost (grouped by cost: one write per amount). Never throws. */
async function failUntracked(
  store: AiRunStore,
  runId: string,
  untracked: UntrackedAnswer[],
): Promise<void> {
  const byCost = new Map<number, string[]>()
  for (const u of untracked) {
    const cost = Math.max(0, Number(u.cost_usd) || 0)
    byCost.set(cost, [...(byCost.get(cost) ?? []), u.id])
  }
  for (const [cost, ids] of byCost)
    await afterPaid('fail untracked answers', () =>
      store.failAnswers(runId, ids, NOT_TRACKED, ['asking'], {
        costUsd: cost,
      }),
    )
}

const noOutcome = (): PaidStepOutcome => ({
  sent: 0,
  collected: 0,
  failed: 0,
  spend_limit: null,
  untracked: [],
})

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/** Split a check's answers into paid batches, by engine. */
export function planBatches(
  answers: Array<Pick<OpenAnswer, 'id' | 'engine'>>,
): { queue: Batch[]; model: Batch[] } {
  const queue: Batch[] = []
  const model: Batch[] = []
  const engines = [...new Set(answers.map((a) => a.engine))]
  for (const engine of engines) {
    const ids = answers.filter((a) => a.engine === engine).map((a) => a.id)
    const target = aiEngineUsesModelApi(engine) ? model : queue
    for (const part of chunk(
      ids,
      aiEngineUsesModelApi(engine)
        ? MODEL_ANSWERS_PER_STEP
        : MAX_TASKS_PER_POST,
    ))
      target.push({ engine, ids: part })
  }
  return { queue, model }
}

/** A parsed answer, matched against the check's brands, ready to save. */
export function collectedAnswer(
  answerId: string,
  parsed: ParsedAiAnswer,
  brands: AiRunBrand[],
  extra: { model_name: string | null; cost_usd: number | null; now: Date },
): CollectedAnswer {
  const matches = matchAiBrands(parsed, brands)
  const own = matches.find((m) => m.own)
  return {
    id: answerId,
    has_answer: parsed.answerMarkdown !== null,
    answer_markdown: parsed.answerMarkdown,
    model_name: extra.model_name,
    brand_mentioned: own?.mentioned ?? false,
    brand_cited: own?.cited ?? false,
    brand_position: own?.position ?? null,
    brand_first_offset: own?.first_mention ?? null,
    matches,
    citation_count: parsed.citations.length,
    collected_at: parsed.collectedAt ?? extra.now.toISOString(),
    cost_usd: extra.cost_usd,
    sources: parsed.citations.map((c) => ({
      id: sourceRowId(answerId, c.url),
      url: c.url,
      domain: c.domain,
      title: c.title,
      position: c.position,
    })),
  }
}

/** prepare: claim, decide who pays, plan the batches. */
export async function prepareRun(
  store: AiRunStore,
  runId: string,
  deps: EngineDeps,
): Promise<PrepareOutcome> {
  const before = await store.getRun(runId)
  if (!before) return { kind: 'skip', reason: 'missing' }
  if (!(await store.claimRun(runId)))
    return { kind: 'skip', reason: 'not_claimable' }
  const run = (await store.getRun(runId)) ?? before

  let refusal: { code: string; message: string } | null = null
  if (run.trigger === 'manual') {
    const access = await deps.checkAccess({
      userId: run.started_by,
      workspaceId: run.workspace_id,
    })
    if (!run.started_by)
      refusal = {
        code: 'NO_PERSON',
        message: 'The person who started this check no longer has an account.',
      }
    else if (!access.ok)
      refusal = { code: access.code, message: access.message }
  } else {
    const tracker = await store.getTracker(run.tracker_id)
    const gate = tracker
      ? await deps.scheduledGate(tracker)
      : {
          ok: false as const,
          reason: 'missing',
          message: 'The tracker no longer exists.',
        }
    if (!gate.ok)
      refusal = { code: gate.reason.toUpperCase(), message: gate.message }
  }
  if (refusal) {
    await store.failAnswers(run.id, null, 'NOT_SENT', ['pending', 'asking'])
    await store.refreshCounts(run.id)
    await store.finishRun(run.id, {
      status: 'failed',
      error_code: refusal.code.slice(0, 60),
      error_detail: refusal.message,
    })
    return { kind: 'refused', ...refusal }
  }
  const pending = await store.listAnswers(run.id, { statuses: ['pending'] })
  return { kind: 'ok', ...planBatches(pending) }
}

/** post-N: claim the batch, post it once, record what the provider took. */
export async function postQueueBatch(
  store: AiRunStore,
  runId: string,
  batch: Batch,
  deps: EngineDeps,
): Promise<PaidStepOutcome> {
  const none = noOutcome()
  const run = await store.getRun(runId)
  if (!run || run.status !== 'running') return none
  const claimed = await store.beginAnswers(runId, batch.ids)
  if (claimed.length === 0) return none
  const answers = await store.listAnswers(runId, {
    statuses: ['asking'],
    ids: claimed,
  })
  if (answers.length === 0) return none

  let posted: PostedAiTrackingTask[]
  try {
    posted = await deps.client(run).aiSearch.trackingTaskPost({
      engine: batch.engine,
      tasks: answers.map((a) => ({ tag: a.id, prompt: a.prompt_text })),
      locationCode: run.location_code,
      languageCode: run.language_code,
    })
  } catch (err) {
    const spend = spendLimitOf(err)
    if (!spend)
      console.error('[seo-ai] task post failed', {
        runId,
        engine: batch.engine,
        err,
      })
    await afterPaid('fail refused post', () =>
      store.failAnswers(
        runId,
        answers.map((a) => a.id),
        spend ? 'SPEND_LIMIT_REACHED' : errorCodeOf(err),
        ['asking'],
      ),
    )
    return {
      ...noOutcome(),
      failed: answers.length,
      spend_limit: spend,
    }
  }
  const mine = new Set(answers.map((a) => a.id))
  const accepted = posted.filter((p) => mine.has(p.tag))
  const recorded = await afterPaid('record post', () =>
    store.markPosted(
      runId,
      accepted.map((p) => ({
        id: p.tag,
        task_id: p.taskId,
        cost_usd: p.costUsd,
      })),
    ),
  )
  // Posted and paid for, but the task ids are lost: these can never be read.
  // Those still asking (markPosted may have written some) end NOT_TRACKED
  // with their cost, and the lane keeps the list for finalize in case this
  // write fails too.
  let untracked: UntrackedAnswer[] = []
  if (!recorded) {
    untracked = accepted.map((p) => ({
      id: p.tag,
      cost_usd: Math.max(0, p.costUsd),
    }))
    console.error('[seo-ai] posted answers could not be recorded', {
      runId,
      engine: batch.engine,
      answers: untracked.length,
    })
    await failUntracked(store, runId, untracked)
  }
  const rejected = answers
    .filter((a) => !accepted.some((p) => p.tag === a.id))
    .map((a) => a.id)
  if (rejected.length)
    await afterPaid('fail rejected tasks', () =>
      store.failAnswers(runId, rejected, 'NOT_ACCEPTED', ['asking']),
    )
  return {
    sent: accepted.length,
    collected: 0,
    failed: rejected.length,
    spend_limit: null,
    untracked,
  }
}

/** Live model answers are long: the provider's ceiling, so a reasoning model still leaves visible text. */
const MODEL_MAX_OUTPUT_TOKENS = 4096

/** model-N: claim the batch, ask each answer once through the model's API, save each as it comes. */
export async function askModelBatch(
  store: AiRunStore,
  runId: string,
  batch: Batch,
  deps: EngineDeps,
): Promise<PaidStepOutcome> {
  const none = noOutcome()
  if (!aiEngineUsesModelApi(batch.engine)) return none
  const slug = batch.engine
  const run = await store.getRun(runId)
  if (!run || run.status !== 'running') return none
  // The model's name comes from the provider's free catalog: read it before claiming, so a failure here leaves nothing claimed.
  const modelName = await deps.resolveModelName(slug)
  const claimed = await store.beginAnswers(runId, batch.ids)
  if (claimed.length === 0) return none
  const answers = await store.listAnswers(runId, {
    statuses: ['asking'],
    ids: claimed,
  })
  const client = deps.client(run)
  const country = getIsoCountryCode(run.location_code).toUpperCase()
  const usd = aiAnswerUsd(batch.engine)
  const outcome: PaidStepOutcome = { ...noOutcome(), sent: answers.length }

  // Asked at once, every answer passes the meter on the same month's total.
  // Near the ceiling, ask them one by one so each sees the one before it.
  let left = 0
  try {
    left = await deps.remainingBudgetUsd(run)
  } catch (err) {
    console.warn('[seo-ai] month spend read failed: asking one by one', {
      runId,
      err,
    })
  }
  const oneByOne = !(left >= 2 * answers.length * usd)

  const ask = async (answer: OpenAnswer) => {
    let saved: CollectedAnswer
    try {
      const result = await client.aiSearch.llmResponse({
        modelSlug: slug,
        modelName,
        userPrompt: answer.prompt_text,
        webSearch: true,
        webSearchCountryCode: country,
        maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
      })
      saved = collectedAnswer(
        answer.id,
        parseLlmResponseAnswer(result),
        run.brands,
        {
          model_name: result.model_name ?? modelName,
          cost_usd: usd,
          now: nowOf(deps),
        },
      )
    } catch (err) {
      const spend = spendLimitOf(err)
      if (spend) outcome.spend_limit = spend
      else
        console.warn('[seo-ai] live answer failed', {
          runId,
          answerId: answer.id,
          code: errorCodeOf(err),
        })
      // A failure the provider still billed: its cost goes on the answer.
      const charged =
        err instanceof DataforseoChargedTaskError
          ? Math.max(0, Number(err.billing.costUsd) || 0)
          : 0
      const written = await afterPaid('fail live answer', () =>
        store.failAnswers(
          runId,
          [answer.id],
          spend ? 'SPEND_LIMIT_REACHED' : errorCodeOf(err),
          ['asking'],
          charged > 0 ? { costUsd: charged } : undefined,
        ),
      )
      if (!written && charged > 0)
        outcome.untracked.push({ id: answer.id, cost_usd: charged })
      outcome.failed++
      return
    }
    if (
      await afterPaid('save live answer', () =>
        store.saveAnswer(runId, saved, { late: false }),
      )
    ) {
      outcome.collected++
      return
    }
    // Asked and paid for, but the answer could not be saved.
    const lost = { id: answer.id, cost_usd: usd }
    outcome.untracked.push(lost)
    await failUntracked(store, runId, [lost])
    outcome.failed++
  }

  if (oneByOne) {
    for (const answer of answers) {
      if (outcome.spend_limit) {
        // The ceiling refused one: the rest are not asked.
        await afterPaid('fail live answer past the ceiling', () =>
          store.failAnswers(runId, [answer.id], 'SPEND_LIMIT_REACHED', [
            'asking',
          ]),
        )
        outcome.failed++
        continue
      }
      await ask(answer)
    }
  } else {
    await Promise.all(answers.map(ask))
  }
  return outcome
}

/** Read each answer once (free), TASK_READS_AT_ONCE at a time; a failed read counts as still pending. */
async function readTasks(
  answers: OpenAnswer[],
  deps: EngineDeps,
  onResult: (
    answer: OpenAnswer,
    result: { status: 'pending' } | AiTrackingAnswer,
  ) => Promise<void>,
) {
  for (const part of chunk(
    answers.filter((a) => a.task_id),
    TASK_READS_AT_ONCE,
  )) {
    const outcomes = await Promise.allSettled(
      part.map((a) =>
        deps.fetchTaskResult({ engine: a.engine, taskId: a.task_id as string }),
      ),
    )
    for (const [i, outcome] of outcomes.entries())
      await onResult(
        part[i],
        outcome.status === 'fulfilled' ? outcome.value : { status: 'pending' },
      )
  }
}

async function saveQueued(
  store: AiRunStore,
  run: EngineRun,
  answer: OpenAnswer,
  result: AiTrackingAnswer,
  deps: EngineDeps,
  late: boolean,
): Promise<'saved' | 'failed'> {
  if (result.status === 'failed') {
    console.warn('[seo-ai] queued answer failed', {
      runId: run.id,
      answerId: answer.id,
      message: result.message,
    })
    if (!late)
      await store.failAnswers(run.id, [answer.id], result.code, ['posted'])
    return 'failed'
  }
  const parsed = parseDataforseoAnswer(result.result, answer.engine)
  if (!parsed) {
    console.error('[seo-ai] answer in a shape we cannot read', {
      runId: run.id,
      answerId: answer.id,
    })
    if (!late)
      await store.failAnswers(run.id, [answer.id], 'UNREADABLE', ['posted'])
    return 'failed'
  }
  await store.saveAnswer(
    run.id,
    collectedAnswer(answer.id, parsed, run.brands, {
      model_name: null,
      cost_usd: null,
      now: nowOf(deps),
    }),
    { late },
  )
  return 'saved'
}

/** collect-N: one free read of every posted answer. Returns how many are still on their way. */
export async function collectRound(
  store: AiRunStore,
  runId: string,
  deps: EngineDeps,
): Promise<{ pending: number; collected: number; failed: number }> {
  const run = await store.getRun(runId)
  if (!run || run.status !== 'running')
    return { pending: 0, collected: 0, failed: 0 }
  const posted = await store.listAnswers(runId, { statuses: ['posted'] })
  let pending = 0
  let collected = 0
  let failed = 0
  await readTasks(posted, deps, async (answer, result) => {
    if (result.status === 'pending') {
      pending++
      return
    }
    if ((await saveQueued(store, run, answer, result, deps, false)) === 'saved')
      collected++
    else failed++
  })
  return { pending, collected, failed }
}

/** Why a check with no answers failed, and what it was charged (the recorded cost of its answers). */
export function noAnswersDetail(costUsd: number): string {
  return costUsd > 0
    ? `None of the answers came back. The answers that were sent were charged about ${formatUsd(costUsd)}. Run the check again later.`
    : 'None of the answers came back, and nothing was charged. Run the check again later.'
}

/** finalize: settle what never came, write the counts, end the check. */
export async function finalizeRun(
  store: AiRunStore,
  runId: string,
  opts: { spendLimit: string | null; untracked?: UntrackedAnswer[] },
): Promise<{ status: AiRunStatus; counts: RunCounts; late_pending: number }> {
  // Sent and charged but never recorded: never "not sent".
  if (opts.untracked?.length)
    await failUntracked(store, runId, opts.untracked)
  await store.failAnswers(runId, null, 'NOT_SENT', ['pending', 'asking'])
  await store.failAnswers(runId, null, 'NOT_ARRIVED', ['posted'])
  const counts = await store.refreshCounts(runId)
  const run = await store.getRun(runId)
  if (!run) return { status: 'failed', counts, late_pending: 0 }
  const settled = counts.answers_collected + counts.answers_no_answer
  const patch = opts.spendLimit
    ? {
        status: 'failed' as const,
        error_code: 'SPEND_LIMIT_REACHED',
        error_detail: opts.spendLimit,
      }
    : settled === 0
      ? {
          status: 'failed' as const,
          error_code: 'NO_ANSWERS',
          error_detail: noAnswersDetail(Number(counts.cost_usd) || 0),
        }
      : { status: 'completed' as const, error_code: null, error_detail: null }
  const ended = await store.finishRun(runId, patch)
  if (ended)
    await store.touchTracker(run.tracker_id, {
      last_run_at: new Date().toISOString(),
    })
  const status = ended
    ? patch.status
    : ((await store.getRun(runId))?.status ?? run.status)
  const late =
    status === 'completed'
      ? await store.listAnswers(runId, {
          statuses: ['failed'],
          errorCode: 'NOT_ARRIVED',
          withTask: true,
        })
      : []
  return { status, counts, late_pending: late.length }
}

/** late-N: read the answers that had not arrived; one that has fills in, marked late. Returns how many are still missing. */
export async function collectLate(
  store: AiRunStore,
  runId: string,
  deps: EngineDeps,
): Promise<{ pending: number; collected: number }> {
  const run = await store.getRun(runId)
  if (!run || run.status !== 'completed') return { pending: 0, collected: 0 }
  const missing = await store.listAnswers(runId, {
    statuses: ['failed'],
    errorCode: 'NOT_ARRIVED',
    withTask: true,
  })
  let pending = 0
  let collected = 0
  await readTasks(missing, deps, async (answer, result) => {
    if (result.status === 'pending') {
      pending++
      return
    }
    // A failed task keeps its not-arrived reason.
    if ((await saveQueued(store, run, answer, result, deps, true)) === 'saved')
      collected++
  })
  if (collected) await store.refreshCounts(runId)
  return { pending, collected }
}

/** The lane's failure path: the check ends failed and nothing stays open. */
export async function failRunFromLane(
  store: AiRunStore,
  runId: string,
  message: string,
): Promise<void> {
  await store.failAnswers(runId, null, 'RUN_FAILED', [
    'pending',
    'asking',
    'posted',
  ])
  await store.refreshCounts(runId)
  await store.finishRun(runId, {
    status: 'failed',
    error_code: 'RUN_FAILED',
    error_detail: message,
  })
}
