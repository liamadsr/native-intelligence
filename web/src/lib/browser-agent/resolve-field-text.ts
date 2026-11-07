import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { checkUsageLimits, logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { runUtilityTask, type UtilityTimeline, type UtilityUsageReport } from '@/lib/eve/utility/run-utility'
import { browserTaskSchema, observationSchema, type BrowserObservation, type BrowserTask, browserSourceMessages } from './task-contract'
import { writeBrowserDebugTrace } from './local-debug-trace'
import { isChatGptPlanUsage } from '@/lib/chatgpt/plan-models'

export interface BrowserFieldTextMetrics {
  /** A utility session was dispatched; preflight refusals incur no generation. */
  invoked: boolean
  model?: string
  timingMs: { authorization: number; budget: number; generation: number; accounting: number; total: number }
  /** Where the eve utility round trip (timingMs.generation) went. */
  generationTimeline?: UtilityTimeline
  usage: {
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
    costSource: 'gateway' | 'unknown'
    /** Complete reported token counts, not a claim that cost is known. */
    known: boolean
  }
}

type BrowserFieldTextOutcome =
  | { status: 'accepted'; value: string }
  | { status: 'escalate' | 'cancelled'; reason: string }
export type BrowserFieldTextResult = BrowserFieldTextOutcome & { metrics: BrowserFieldTextMetrics }

const answerSchema = z.object({
  value: z.string().min(1).max(2000).nullable(),
  goalQuote: z.string().min(1).max(2000).nullable(),
}).strict().refine(answer => (answer.value === null) === (answer.goalQuote === null), 'Supply both a value and quote, or refuse both.')
const SECRET_FIELD = /\b(password|passcode|one[- ]time|verification code|security code|cvv|cvc|credit card|card number|private key|api key|access token|social security)\b/i
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * Generate text for exactly one observed editable field. No tools, navigation,
 * page body, ambient account data, or independent retry is available here.
 * The route and native executor still own permissions, freshness and execution.
 */
export async function resolveBrowserFieldText(
  input: { task: BrowserTask; observation: BrowserObservation; ref: string; history: readonly string[] },
  ctx: { userId: string; workspaceId: string; runId: string; signal?: AbortSignal; deadline: number },
): Promise<BrowserFieldTextResult> {
  const started = performance.now()
  const deadline = Math.min(ctx.deadline, Date.now() + 8_000)
  const metrics: BrowserFieldTextMetrics = {
    invoked: false,
    timingMs: { authorization: 0, budget: 0, generation: 0, accounting: 0, total: 0 },
    usage: { known: false, costSource: 'unknown' },
  }
  const stop = (): { status: 'escalate' | 'cancelled'; reason: string } | undefined => {
    if (!Number.isFinite(deadline) || Date.now() >= deadline) return { status: 'escalate', reason: 'deadline_exceeded' }
    if (ctx.signal?.aborted) return { status: 'cancelled', reason: 'user_stopped' }
  }
  const finish = (result: BrowserFieldTextOutcome): BrowserFieldTextResult => {
    metrics.timingMs.total = Math.max(0, Math.round(performance.now() - started))
    return { ...(stop() ?? result), metrics } as BrowserFieldTextResult
  }
  const reject = (reason: string) => finish({ status: 'escalate', reason })
  if (stop()) return finish(stop()!)
  const task = browserTaskSchema.safeParse(input.task)
  const observation = observationSchema.safeParse(input.observation)
  if (!task.success || !observation.success || task.data.goalDriven !== true) return reject('invalid_input')
  const fields = observation.data.elements.filter(element => element.ref === input.ref)
  const field = fields[0]
  if (fields.length !== 1 || !field?.canType || field.disabled || field.forbidden || field.sensitive ||
    SECRET_FIELD.test(`${field.role} ${field.name} ${field.context} ${field.dialog ?? ''}`)) return reject('invalid_target')
  if (!ctx.userId || !ctx.workspaceId || !ctx.runId || !Array.isArray(input.history) ||
    input.history.some(entry => typeof entry !== 'string')) return reject('invalid_input')

  const controller = new AbortController()
  const abort = () => controller.abort()
  ctx.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
  const read = <T>(work: () => PromiseLike<T>): Promise<T> => new Promise((resolve, rejectRead) => {
    const fail = () => rejectRead(new Error('cancelled'))
    if (controller.signal.aborted || stop()) { fail(); return }
    controller.signal.addEventListener('abort', fail, { once: true })
    Promise.resolve().then(() => {
      if (controller.signal.aborted || stop()) throw new Error('cancelled')
      return work()
    }).then(resolve, rejectRead).finally(() => controller.signal.removeEventListener('abort', fail))
  })
  const timed = async <T>(key: Exclude<keyof BrowserFieldTextMetrics['timingMs'], 'total'>, work: () => Promise<T>) => {
    const at = performance.now()
    try { return await work() } finally { metrics.timingMs[key] += Math.max(0, Math.round(performance.now() - at)) }
  }
  const inferenceId = randomUUID()
  let report: UtilityUsageReport | undefined
  let refusalCode: 'invalid_shape' | 'helper_refused' | 'ungrounded_quote' | 'empty_value' | 'secret_like_value' | 'control_characters' | 'unchanged_value' | 'generation_unavailable' | undefined
  let outcome: BrowserFieldTextOutcome = { status: 'escalate', reason: 'generation_unavailable' }
  try {
    const db = getServiceClient()
    const membership = await timed('authorization', () => read(() => db.from('member').select('id')
      .eq('user_id', ctx.userId).eq('workspace_id', ctx.workspaceId).abortSignal(controller.signal).maybeSingle()))
    if (membership.error || !membership.data) return reject('not_authorized')
    // Opted in to the ChatGPT free tier: a free user's field text runs on their own plan.
    const budget = await timed('budget', () => read(() => checkUsageLimits(ctx.userId, controller.signal, { chatgptPlan: true })))
    if (!budget?.allowed) return reject('budget_unavailable')
    const chatgptPlan = isChatGptPlanUsage(budget)
    if (stop()) return finish(stop()!)
    const humanRequests = browserSourceMessages(task.data)
    const helperInput = {
      userGoal: humanRequests?.at(-1) ?? task.data.goal,
      ...(humanRequests?.length && humanRequests.length > 1 ? { priorHumanContext: humanRequests.slice(0, -1) } : {}),
      untrustedSelectedField: { role: field.role, name: field.name, value: field.value, context: field.context, dialog: field.dialog ?? null,
        ...(field.expanded !== undefined ? { expanded: field.expanded } : {}),
        ...(field.input ? { input: field.input } : {}) },
      // Same-dialog suggestion labels explain an editable picker's state.
      // This is a visible subset, never proof that no other choices exist.
      ...(field.role === 'combobox' && field.dialog ? { untrustedPickerState: {
        loading: observation.data.loading === true,
        visibleSuggestions: observation.data.elements.filter(option => option.role === 'option' && option.dialog === field.dialog &&
          !option.disabled && !option.forbidden && !option.sensitive).slice(0, 10).map(option => ({ name: option.name,
          ...(option.selected !== undefined ? { selected: option.selected } : {}) })),
        suggestionsScope: 'visible_subset',
      } } : {}),
      // Names/roles disambiguate short field labels without exposing other
      // fields' values, executable refs or unrelated page content.
      untrustedPeerFields: observation.data.elements.filter(peer => peer.ref !== field.ref && peer.canType &&
        !peer.disabled && !peer.forbidden && !peer.sensitive && (!field.dialog || peer.dialog === field.dialog) &&
        !SECRET_FIELD.test(peer.name)).slice(0, 10).map(peer => ({ role: peer.role, name: peer.name,
          ...(peer.input ? { inputType: peer.input.type, placeholder: peer.input.placeholder } : {}) })),
      untrustedRecentActions: input.history.slice(-6).map(entry => entry.slice(0, 160)),
    }
    await writeBrowserDebugTrace(ctx, 'helper.input', { inferenceId, input: helperInput })
    if (stop()) return finish(stop()!)
    const generated = await timed('generation', () => runUtilityTask({
      kind: 'browser_field_text', workspaceId: ctx.workspaceId, userId: ctx.userId, supabase: db, chatgptPlan,
      signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()),
      message: JSON.stringify(helperInput),
      onUsage: value => { report = value; metrics.invoked = true; metrics.model = value.model
        if (value.timeline) metrics.generationTimeline = value.timeline },
    }))
    let raw: unknown
    try { raw = JSON.parse(generated.text) } catch { raw = null }
    const answer = answerSchema.safeParse(raw)
    if (!answer.success) refusalCode = 'invalid_shape'
    else if (answer.data.value === null || answer.data.goalQuote === null) refusalCode = 'helper_refused'
    else if (!(humanRequests ?? [task.data.goal]).some(request => request.includes(answer.data.goalQuote!))) refusalCode = 'ungrounded_quote'
    else if (!normalized(answer.data.value)) refusalCode = 'empty_value'
    else if (SECRET_VALUE.test(answer.data.value)) refusalCode = 'secret_like_value'
    else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(answer.data.value)) refusalCode = 'control_characters'
    if (refusalCode || !answer.success || answer.data.value === null) {
      outcome = { status: 'escalate', reason: refusalCode === 'helper_refused' ? 'text_not_supplied' : 'text_unresolved' }
    } else if (normalized(answer.data.value) === normalized(field.value)) {
      refusalCode = 'unchanged_value'
      outcome = { status: 'escalate', reason: 'text_unchanged' }
    } else {
      outcome = { status: 'accepted', value: answer.data.value }
    }
  } catch {
    refusalCode = 'generation_unavailable'
    // Never log a provider/transport error carrying request or page content.
    outcome = stop() ?? { status: 'escalate', reason: 'generation_unavailable' }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', abort)
  }
  if (report) {
    // A stopped session may have known subtotals; its unreported final generation
    // remains unknown. Never turn an absent report into a zero-cost success.
    const usage = report.usage
    const completeTokens = report.complete && report.inputTokensReported && report.outputTokensReported
    const cost = report.complete && usage.costUsd !== null && usage.costUsd > 0 ? usage.costUsd : undefined
    metrics.usage = {
      ...(report.inputTokensReported ? { inputTokens: usage.inputTokens } : {}),
      ...(report.outputTokensReported ? { outputTokens: usage.outputTokens } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      costSource: cost === undefined ? 'unknown' : 'gateway', known: completeTokens,
    }
    try {
      const logged = await timed('accounting', () => logUsage(ctx.userId, {
        provider: usageProviderLabel(report!.model), model: report!.model, feature: 'browser.field_text',
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        ...(cost === undefined ? {} : { costUsd: cost }),
        idempotencyKey: `browser-field-text:${inferenceId}`,
        metadata: {
          workspace_id: ctx.workspaceId, run_id: ctx.runId, inference_id: inferenceId,
          utility_kind: 'browser_field_text', outcome: (stop() ?? outcome).status,
          usage_unknown: !completeTokens, cost_unknown: cost === undefined, cost_source: metrics.usage.costSource,
          input_tokens_reported: report!.complete && report!.inputTokensReported,
          output_tokens_reported: report!.complete && report!.outputTokensReported,
          gateway_generation_ids: report!.generationIds,
          ...(report!.timeline ? { generation_timeline_ms: report!.timeline } : {}),
          ...usageCacheMetadata(usage),
        },
      }))
      if (logged === 'lost') outcome = { status: 'escalate', reason: 'accounting_unavailable' }
    } catch { outcome = { status: 'escalate', reason: 'accounting_unavailable' } }
  }
  const result = finish(outcome)
  // Retain only validated text and bounded metrics, never a raw utility
  // response that might contain credentials or provider transport data.
  await writeBrowserDebugTrace(ctx, 'helper.output', { inferenceId, result, ...(refusalCode ? { refusalCode } : {}) })
  return result
}
