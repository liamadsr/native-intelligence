/**
 * Starting and stopping AI visibility checks: the core behind the routes,
 * the tools and the schedule's cron.
 *
 *   - A check asks every active prompt on every engine of the tracker: one
 *     answer row per (prompt, engine), written together with the check
 *     (seo_ai_create_run), with the brands, engines and market copied onto
 *     the check so later edits never rewrite it.
 *   - One live check per tracker: a second start is refused with the live
 *     one. A check stuck far past its start is failed and replaced.
 *   - A manual check is the person's own request: it needs `confirmed` when
 *     its estimate is above CONFIRM_ABOVE_USD (CONFIRMATION_REQUIRED, with the
 *     estimate, and nothing starts), and passes the access check (../access.ts)
 *     before the check is written. A scheduled one goes through the gate in
 *     ./gate.ts instead (./schedule.ts).
 *   - The start only writes the rows and sends the event. The answers are
 *     bought in the background lane (src/lib/inngest/seo-ai-visibility-functions.ts).
 */
import {
  inngest,
  SEO_AI_VISIBILITY_RUN_CANCEL,
  SEO_AI_VISIBILITY_RUN_REQUESTED,
} from '@/lib/inngest/client'
import {
  checkSeoDataAccess,
  type SeoDataAccess,
  type SeoDataRefusal,
} from '@/lib/seo/access'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { estimateAiCost, formatUsd } from './cost'
import { answerRowId } from './ids'
import {
  CONFIRM_ABOVE_USD,
  STUCK_QUEUED_AFTER_MS,
  STUCK_RUN_AFTER_MS,
} from './limits'
import { aiPromptIsBranded } from './matching'
import {
  getLiveRun,
  getRunRow,
  getTrackerRow,
  listPrompts,
  RUN_FIELDS,
  runView,
  trackerBrands,
  trackerView,
  type RunRow,
  type TrackerRow,
} from './queries'
import {
  isLiveRun,
  type AiCostEstimate,
  type AiRunTrigger,
  type AiRunView,
} from './view'

export type SendEvent = (event: {
  name: string
  data: Record<string, unknown>
}) => Promise<unknown>

export interface RunDeps {
  send?: SendEvent
  checkAccess?: (who: {
    userId: string | null
    workspaceId?: string | null
    unattended?: boolean
  }) => Promise<SeoDataAccess>
  now?: () => Date
  newId?: () => string
}

export type CreateRunFailure =
  | { ok: false; code: 'NO_PROMPTS'; message: string }
  | {
      ok: false
      code: 'RUN_IN_PROGRESS'
      message: string
      run: AiRunView | null
    }
  | { ok: false; code: 'START_FAILED'; message: string }

const send = (deps: RunDeps): SendEvent =>
  deps.send ?? ((event) => inngest.send(event))

/** Fail a live check that has been stuck far longer than a check takes. Returns whether it did. */
export async function failIfStuck(
  svc: SupabaseClient,
  run: RunRow,
  now: Date,
): Promise<boolean> {
  const age = now.getTime() - Date.parse(run.started_at ?? run.created_at)
  const stuck =
    run.status === 'queued'
      ? age > STUCK_QUEUED_AFTER_MS
      : age > STUCK_RUN_AFTER_MS
  if (!stuck) return false
  console.warn('[seo-ai] failing a stuck check', {
    runId: run.id,
    status: run.status,
  })
  await settleRun(svc, run.id, run.workspace_id, {
    status: 'failed',
    error_code: 'STUCK',
    error_detail: 'The check stopped answering and was ended. Run it again.',
    answerCode: 'RUN_FAILED',
  })
  return true
}

/**
 * End a live check (canceled or failed): its row first (what a step in
 * flight reads), then every answer not settled yet, then the counts. Safe on
 * a check that already ended (changes nothing).
 */
export async function settleRun(
  svc: SupabaseClient,
  runId: string,
  workspaceId: string,
  patch: {
    status: 'canceled' | 'failed'
    error_code: string | null
    error_detail: string | null
    answerCode: string
  },
): Promise<boolean> {
  const now = new Date().toISOString()
  const { data, error } = await svc
    .from('seo_ai_run')
    .update({
      status: patch.status,
      error_code: patch.error_code,
      error_detail: patch.error_detail,
      completed_at: now,
      updated_at: now,
    })
    .eq('id', runId)
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running'])
    .select('id')
  if (error) throw new Error(`seo ai run settle failed: ${error.message}`)
  if ((data ?? []).length === 0) return false
  const { error: answersError } = await svc
    .from('seo_ai_answer')
    .update({ status: 'failed', error_code: patch.answerCode, updated_at: now })
    .eq('run_id', runId)
    .eq('workspace_id', workspaceId)
    .in('status', ['pending', 'asking', 'posted'])
  if (answersError)
    console.error('[seo-ai] settle: answers not failed', answersError.message)
  const { error: countError } = await svc.rpc('seo_ai_refresh_run_counts', {
    p_run: runId,
  })
  if (countError)
    console.error('[seo-ai] settle: counts not refreshed', countError.message)
  return true
}

/**
 * Write a check of this tracker with its answer rows. Refused with the live
 * check when one is running (or the due time already started one).
 */
export async function createRun(
  svc: SupabaseClient,
  tracker: TrackerRow,
  opts: {
    trigger: AiRunTrigger
    startedBy: string | null
    scheduledFor: string | null
    runId: string
  },
): Promise<
  { ok: true; run: AiRunView; estimate: AiCostEstimate } | CreateRunFailure
> {
  const prompts = (
    await listPrompts(svc, tracker.workspace_id, tracker.id)
  ).filter((p) => p.active)
  if (prompts.length === 0)
    return {
      ok: false,
      code: 'NO_PROMPTS',
      message:
        'This tracker has no active prompts. Add or turn on a prompt first.',
    }
  const view = trackerView(tracker)
  const brands = trackerBrands(view)
  const own = brands[0]
  const estimate = estimateAiCost({
    promptCount: prompts.length,
    engines: view.engines,
    scheduleInterval: view.schedule_interval,
    locationCode: view.location_code,
  })
  const answers = prompts.flatMap((prompt) =>
    view.engines.map((engine) => ({
      id: answerRowId(opts.runId, prompt.id, engine),
      prompt_id: prompt.id,
      prompt_text: prompt.text,
      engine,
      branded: aiPromptIsBranded(prompt.text, own),
    })),
  )
  const { error } = await svc.rpc('seo_ai_create_run', {
    p_run: {
      id: opts.runId,
      tracker_id: tracker.id,
      workspace_id: tracker.workspace_id,
      started_by: opts.startedBy,
      trigger: opts.trigger,
      scheduled_for: opts.scheduledFor,
      engines: view.engines,
      location_code: view.location_code,
      language_code: view.language_code,
      brands,
      estimate_usd: estimate.run_usd,
    },
    p_answers: answers,
  })
  if (error) {
    if (error.code === '23505') {
      const live = await getLiveRun(svc, tracker.workspace_id, tracker.id)
      return {
        ok: false,
        code: 'RUN_IN_PROGRESS',
        message:
          'A check of this tracker is already running. Read it instead of starting another.',
        run: live ? runView(live) : null,
      }
    }
    console.error('[seo-ai] create run failed', error.message)
    return {
      ok: false,
      code: 'START_FAILED',
      message: 'Could not start the check just now. Try again in a moment.',
    }
  }
  const row = await getRunRow(svc, tracker.workspace_id, opts.runId)
  if (!row)
    return {
      ok: false,
      code: 'START_FAILED',
      message: 'Could not start the check just now. Try again in a moment.',
    }
  return { ok: true, run: runView(row), estimate }
}

/** Send the lane's event for a check just written; on failure the check is written failed so it never sits at "queued". */
export async function dispatchRun(
  svc: SupabaseClient,
  run: { id: string; workspace_id?: string },
  workspaceId: string,
  deps: RunDeps = {},
): Promise<boolean> {
  try {
    await send(deps)({
      name: SEO_AI_VISIBILITY_RUN_REQUESTED,
      data: { runId: run.id, workspaceId },
    })
    return true
  } catch (err) {
    console.error('[seo-ai] start: event send failed', err)
    await settleRun(svc, run.id, workspaceId, {
      status: 'failed',
      error_code: 'START_FAILED',
      error_detail:
        'The check could not be started. Nothing was charged. Run it again.',
      answerCode: 'NOT_SENT',
    }).catch((e) =>
      console.error('[seo-ai] start: could not fail the check', e),
    )
    return false
  }
}

export type StartRunResult =
  | { ok: true; run: AiRunView; estimate: AiCostEstimate }
  | CreateRunFailure
  | SeoDataRefusal
  | { ok: false; code: 'NOT_FOUND'; message: string }
  | {
      ok: false
      code: 'CONFIRMATION_REQUIRED'
      message: string
      estimate: AiCostEstimate
    }

/**
 * A person starts a check now. Above CONFIRM_ABOVE_USD it needs `confirmed`;
 * then the access check; then the rows and the event.
 */
export async function startManualRun(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string; unattended?: boolean },
  trackerId: string,
  opts: { confirmed?: boolean } = {},
  deps: RunDeps = {},
): Promise<StartRunResult> {
  const tracker = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!tracker)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That tracker doesn’t exist.',
    }
  const view = trackerView(tracker)
  const active = (await listPrompts(svc, who.workspaceId, trackerId)).filter(
    (p) => p.active,
  ).length
  if (active === 0)
    return {
      ok: false,
      code: 'NO_PROMPTS',
      message:
        'This tracker has no active prompts. Add or turn on a prompt first.',
    }
  const estimate = estimateAiCost({
    promptCount: active,
    engines: view.engines,
    scheduleInterval: view.schedule_interval,
    locationCode: view.location_code,
  })
  if (estimate.run_usd > CONFIRM_ABOVE_USD && !opts.confirmed) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `This check asks ${estimate.answers} answers (${active} prompts on ${view.engines.length} engines) and costs about ${formatUsd(estimate.run_usd)}. Confirm to start it.`,
      estimate,
    }
  }
  const access = await (deps.checkAccess ?? checkSeoDataAccess)({
    userId: who.userId,
    workspaceId: who.workspaceId,
    unattended: who.unattended,
  })
  if (!access.ok) return access

  const now = deps.now?.() ?? new Date()
  const live = await getLiveRun(svc, who.workspaceId, trackerId)
  if (live && !(await failIfStuck(svc, live, now))) {
    return {
      ok: false,
      code: 'RUN_IN_PROGRESS',
      message:
        'A check of this tracker is already running. Read it instead of starting another.',
      run: runView(live),
    }
  }
  const created = await createRun(svc, tracker, {
    trigger: 'manual',
    startedBy: who.userId,
    scheduledFor: null,
    runId: deps.newId?.() ?? crypto.randomUUID(),
  })
  if (!created.ok) return created
  if (!(await dispatchRun(svc, created.run, who.workspaceId, deps))) {
    return {
      ok: false,
      code: 'START_FAILED',
      message:
        'Could not start the check just now. Nothing was charged. Try again in a moment.',
    }
  }
  return created
}

export type CancelRunResult =
  | { ok: true; run: AiRunView }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING'; message: string }

/** Stop a queued or running check. Answers already collected stay; the rest are not bought. */
export async function cancelRun(
  svc: SupabaseClient,
  who: { workspaceId: string },
  runId: string,
  deps: RunDeps = {},
): Promise<CancelRunResult> {
  const run = await getRunRow(svc, who.workspaceId, runId)
  if (!run)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That check doesn’t exist.',
    }
  if (!isLiveRun(run.status))
    return {
      ok: false,
      code: 'NOT_RUNNING',
      message: 'That check already ended.',
    }
  await settleRun(svc, runId, who.workspaceId, {
    status: 'canceled',
    error_code: null,
    error_detail: null,
    answerCode: 'CANCELED',
  })
  try {
    await send(deps)({ name: SEO_AI_VISIBILITY_RUN_CANCEL, data: { runId } })
  } catch (err) {
    // The status alone already stops the lane at its next step.
    console.error('[seo-ai] cancel: event send failed', err)
  }
  const { data } = await svc
    .from('seo_ai_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', who.workspaceId)
    .eq('id', runId)
    .maybeSingle()
  return {
    ok: true,
    run: data
      ? runView(data as RunRow)
      : { ...runView(run), status: 'canceled' },
  }
}
