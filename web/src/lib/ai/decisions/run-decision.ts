import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { getServiceClient } from '@/lib/admin'
import { checkUsageLimits, extractGatewayCost, logUsage, type LogUsageParams } from '@/lib/ai/auth'
import { gatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'
import { usageProviderLabel } from '@/lib/ai/models'
import { isChatGptPlanUsage, PLAN_HELPER_MODEL, planModelSlug } from '@/lib/chatgpt/plan-models'
import { decisionTasks, type DecisionKind } from './registry'
import { evaluateJev, JEV_MODEL } from './providers/jev'
import { decideOnPlan, PLAN_DECISIONS } from './plan-decision'
import { browserErrorDiagnostics, writeBrowserDebugTrace } from '@/lib/browser-agent/local-debug-trace'
import { probability, type DecisionContext, type DecisionMetrics, type DecisionResult, type DecisionTask, type Evaluation } from './contracts'

type Input<K extends DecisionKind> = Parameters<(typeof decisionTasks)[K]['prepare']>[0]
type Value<K extends DecisionKind> = NonNullable<ReturnType<(typeof decisionTasks)[K]['accept']>>
const active = new Map<string, number>()
/**
 * Circuits: 3 provider failures stop calls for 30 s. Shared by every task,
 * except a task with `isolatedCircuit` (action.review), which has its own so a
 * flaky reviewer can't stop the other decisions and they can't stop it.
 */
const circuits = new Map<string, { failures: number; until: number }>()
function circuitOf(key: string): { failures: number; until: number } {
  let circuit = circuits.get(key)
  if (!circuit) { circuit = { failures: 0, until: 0 }; circuits.set(key, circuit) }
  return circuit
}

/** Rejects when `signal` aborts (with its reason), never resolves: raced against a call that may not stop at once. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** Catalog price checked 2026-10-03. Gateway cost takes precedence. Configurable for price changes. */
export function jevFallbackCost(inputTokens: number): number {
  const configured = Number(process.env.JEV_INPUT_USD_PER_MILLION ?? '0.042')
  if (!Number.isFinite(configured) || configured < 0) throw new Error('Invalid Jev price')
  return inputTokens * configured / 1_000_000
}

/**
 * Answer one decision: Jev on the Gateway, or, for a person on their own
 * ChatGPT plan (the free tier), the plan's helper model for the kinds that run
 * there (./plan-decision.ts, PLAN_DECISION_DEADLINES); Jev is Dial8-paid and
 * never runs for them, so their other kinds escalate `budget_unavailable` as
 * before. Either way the task's own accept() decides, and the call is metered.
 */
export async function runDecision<K extends DecisionKind>(kind: K, raw: Input<K>, ctx: DecisionContext): Promise<DecisionResult<Value<K>>> {
  const started = performance.now()
  const metrics: DecisionMetrics = { timingMs: { preparation: 0, authorization: 0, cache: 0,
    budget: 0, provider: 0, acceptance: 0, accounting: 0, total: 0 } }
  const elapsed = (since: number) => Math.max(0, Math.round(performance.now() - since))
  let preparing = true
  const finish = (result: DecisionResult<Value<K>>): DecisionResult<Value<K>> => {
    if (preparing) metrics.timingMs.preparation = elapsed(started)
    metrics.timingMs.total = elapsed(started)
    return { ...result, metrics: { ...metrics, timingMs: { ...metrics.timingMs } } }
  }
  const escalate = (reason: string, inferenceId?: string) => finish({ status: 'escalate', reason, ...(inferenceId ? { inferenceId } : {}) })
  const timed = async <T>(stage: Exclude<keyof DecisionMetrics['timingMs'], 'total'>, work: () => PromiseLike<T>): Promise<T> => {
    const since = performance.now()
    try { return await work() } finally { metrics.timingMs[stage] += elapsed(since) }
  }
  if (ctx.signal?.aborted) return finish({ status: 'cancelled', reason: 'caller_cancelled' })
  const task = decisionTasks[kind] as DecisionTask<Input<K>, Value<K>>
  // The decision's clock includes authorization/cache work, not just inference.
  // A decision on the person's ChatGPT plan gets its kind's longer deadline,
  // from the same start, once the budget says so (extendDeadline).
  let deadlineMs = task.deadlineMs
  const deadline = new AbortController()
  const onDeadline = () => deadline.abort(new DOMException('Decision deadline exceeded', 'TimeoutError'))
  let deadlineTimer = setTimeout(onDeadline, deadlineMs)
  deadlineTimer.unref?.()
  const extendDeadline = (ms: number) => {
    if (ms <= deadlineMs || deadline.signal.aborted) return
    deadlineMs = ms
    clearTimeout(deadlineTimer)
    deadlineTimer = setTimeout(onDeadline, Math.max(0, started + ms - performance.now()))
    deadlineTimer.unref?.()
  }
  const signal = AbortSignal.any([deadline.signal, ...(ctx.signal ? [ctx.signal] : [])])
  // Check the monotonic clock too: timer delivery can lag behind a busy event
  // loop even when a promise has already resolved.
  const expired = () => signal.aborted || performance.now() - started >= deadlineMs
  const assertLive = () => {
    signal.throwIfAborted()
    if (expired()) throw new DOMException('Decision deadline exceeded', 'TimeoutError')
  }
  // Read-only work can be abandoned safely. Pass the signal to PostgREST as
  // well, but do not depend on a transport honoring it to release the caller.
  const read = <T>(work: () => PromiseLike<T>): Promise<T> => {
    assertLive()
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve().then(() => { assertLive(); return work() }).then(value => {
        assertLive()
        resolve(value)
      }).catch(reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }
  const parsed = task.schema.safeParse(raw)
  if (!parsed.success) return escalate('invalid_input')
  const prepared = task.prepare(parsed.data)
  if (!prepared || prepared.state.length > task.maxStateChars) return escalate('incomplete_evidence')
  const encoder = new TextEncoder()
  const questionSizes = Object.values(prepared.questions).map(q => encoder.encode(JSON.stringify(q)).length)
  metrics.stateBytes = encoder.encode(prepared.state).length
  metrics.questionBytes = encoder.encode(JSON.stringify(prepared.questions)).length
  metrics.questionCount = questionSizes.length
  if (!questionSizes.length || questionSizes.length > 4 || metrics.stateBytes + Math.max(...questionSizes) > 28000) return escalate('question_budget')
  // Which circuit applies is known once the budget says whether this person
  // is on their plan (below): Jev's (shared, or the task's own), or theirs.
  let circuit = circuitOf(task.isolatedCircuit ? kind : 'shared')
  // A task that bypasses the per-user cap neither waits on it nor counts toward it.
  const counted = !task.bypassConcurrencyCap
  if (counted && (active.get(ctx.userId) ?? 0) >= 2) return escalate('temporarily_unavailable')
  if (counted) active.set(ctx.userId, (active.get(ctx.userId) ?? 0) + 1)
  const inferenceId = randomUUID()
  let invoked = false
  let received: Evaluation | undefined
  /** Set when the decision ran on the person's ChatGPT plan: the model it ran on. */
  let planModel: string | null = null
  const cacheKey = createHash('sha256').update(JSON.stringify([ctx.userId, ctx.workspaceId, kind, task.version, prepared.state])).digest('hex')
  metrics.timingMs.preparation = elapsed(started)
  preparing = false
  const beforeAccounting = () => {
    const { accounting: _accounting, total: _total, ...stages } = metrics.timingMs
    return { ...stages, total_before_accounting: elapsed(started) }
  }
  const usageParams = (outcome: string, extra: Record<string, unknown> = {}): LogUsageParams => ({
    // On the plan: its provider (logUsage bills it at $0), never Jev's.
    provider: planModel ? usageProviderLabel(planModel) : 'typesafe-ai', model: planModel ?? JEV_MODEL, feature: `decision.${kind}`,
    inputTokens: metrics.usage?.inputTokens ?? 0, outputTokens: metrics.usage?.outputTokens ?? 0,
    // request_duration_ms includes service preparation/authorization. Use the provider span for Gateway latency.
    durationMs: elapsed(started), costUsd: metrics.usage?.costUsd ?? (received ? undefined : 0),
    idempotencyKey: `decision:${inferenceId}`,
    metadata: { workspace_id: ctx.workspaceId, inference_id: inferenceId, decision_version: task.version,
      run_id: ctx.runId, decision_mode: ctx.mode ?? 'enforce',
      ...(ctx.shadowQuestions?.length ? { shadow_questions: [...ctx.shadowQuestions] } : {}),
      ...(ctx.messageId ? { message_id: ctx.messageId.slice(0, 120) } : {}),
      resolved_model: received?.response.modelId, provider_request_id: received?.response.id,
      usage_unknown: !metrics.usage?.known, cost_unknown: metrics.usage?.costUsd === undefined,
      cost_source: metrics.usage?.costSource ?? 'unknown',
      decision_timing_ms: beforeAccounting(),
      decision_input: { state_bytes: metrics.stateBytes, question_bytes: metrics.questionBytes, question_count: metrics.questionCount },
      outcome, ...extra },
  })
  try {
    const db = getServiceClient()
    const { data: member, error } = await timed('authorization', () => read(() => db.from('member').select('id').eq('user_id', ctx.userId).eq('workspace_id', ctx.workspaceId).abortSignal(signal).maybeSingle()))
    if (error || !member) return escalate('not_authorized')
    assertLive()
    if (task.cache) {
      const { data: cached } = await timed('cache', () => read(() => db.from('ai_usage_logs').select('metadata').eq('user_id', ctx.userId)
        .eq('feature', `decision.${kind}`).contains('metadata', { decision_cache_key: cacheKey })
        .gte('created_at', new Date(Date.now() - 86400000).toISOString()).order('created_at', { ascending: false }).limit(1).abortSignal(signal).maybeSingle()))
      // Reapply the current acceptance policy to the stored answer, never trust an arbitrary cached value.
      assertLive()
      if (cached?.metadata?.decision_answer) {
        const since = performance.now()
        const value = task.accept(cached.metadata.decision_answer, parsed.data)
        metrics.timingMs.acceptance += elapsed(since)
        assertLive()
        if (value !== null) return finish({ status: 'accepted', value, version: task.version, inferenceId: cached.metadata.inference_id, cached: true })
      }
    }
    // Opted in to the ChatGPT free tier: a person on their own plan passes,
    // and their decision runs there or not at all (Jev is Dial8's).
    const allowance = await timed('budget', () => read(() => checkUsageLimits(ctx.userId, signal, { chatgptPlan: true })))
    if (!allowance?.allowed) return escalate('budget_unavailable')
    const onPlan = isChatGptPlanUsage(allowance)
    const planDecision = PLAN_DECISIONS[kind]
    if (onPlan && !planDecision) return escalate('budget_unavailable')
    // Its own circuit on the plan: one person's plan outage never pauses Jev
    // for everyone, and a Jev outage never stops a person on their plan.
    if (onPlan) circuit = circuitOf(`chatgpt_plan:${ctx.userId}`)
    if (circuit.until > Date.now()) return escalate('temporarily_unavailable')
    assertLive()
    if (kind.startsWith('browser.')) await writeBrowserDebugTrace(ctx, 'jev.input', {
      inferenceId, version: task.version, state: prepared.state, questions: prepared.questions,
    })
    assertLive()
    invoked = true
    if (onPlan && planDecision) {
      extendDeadline(planDecision.deadlineMs)
      // Named before the call, so a failed or cut attempt is metered as the
      // plan's (at no cost), never as Jev's.
      planModel = planModelSlug(PLAN_HELPER_MODEL)
      const call = decideOnPlan(prepared, {
        userId: ctx.userId, workspaceId: ctx.workspaceId, signal, timeoutMs: started + deadlineMs - performance.now(),
        ...(planDecision.recordOnly ? { recordOnly: planDecision.recordOnly } : {}),
      })
      // The session's cancel may outlive the deadline (run-utility waits for
      // it); the decision never does.
      call.catch(() => undefined)
      const decided = await timed('provider', () => Promise.race([call, rejectOnAbort(signal)]))
      planModel = decided.model
      received = decided.evaluation
    } else {
      received = await timed('provider', () => evaluateJev(prepared.state, prepared.questions, signal,
        gatewayTelemetryValues(ctx.userId, `decision.${kind}`, { workspaceId: ctx.workspaceId, runtime: 'eve', extraTags: [`inference:${inferenceId}`] })))
    }
    const result = received
    if (kind.startsWith('browser.')) await writeBrowserDebugTrace(ctx, 'jev.output', {
      inferenceId, answers: result.answers,
      confidence: result.providerMetadata?.typesafe?.confidence ?? null,
      usage: result.usage,
    })
    const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    const inputTokens = validCount(result.usage.inputTokens) ? result.usage.inputTokens : undefined
    const outputTokens = validCount(result.usage.outputTokens) ? result.usage.outputTokens : undefined
    metrics.usage = { inputTokens, outputTokens, known: inputTokens !== undefined && outputTokens !== undefined, costSource: 'unknown' }
    if (planModel) {
      // The person's own plan pays: nothing to Dial8.
      metrics.usage.costUsd = 0
      metrics.usage.costSource = 'chatgpt_plan'
    } else {
      const gatewayCost = extractGatewayCost(result)
      const cost = gatewayCost ?? (inputTokens !== undefined ? jevFallbackCost(inputTokens) : undefined)
      metrics.usage.costUsd = cost
      metrics.usage.costSource = gatewayCost !== undefined ? 'gateway' : cost !== undefined ? 'catalog' : 'unknown'
    }
    if (kind.startsWith('browser.')) {
      // The browser trace pairs each choice with the control it named.
      const confidence = result.providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined
      metrics.answers = Object.fromEntries(Object.entries(result.answers).flatMap(([key, answer]) => {
        if (answer.type !== 'choice' || typeof answer.choice !== 'string') return []
        const chance = answer.probabilities?.[answer.choice]
        return [[key, { choice: answer.choice.slice(0, 120), ...(probability(chance) ? { probability: chance } : {}),
          ...(probability(confidence?.[key]) ? { confidence: confidence[key] as number } : {}) }]]
      }))
    }
    const since = performance.now()
    let value: Value<K> | null
    try { value = task.accept(result, parsed.data) } finally { metrics.timingMs.acceptance += elapsed(since) }
    // Await provider settlement and durable accounting even if the deadline
    // elapsed, so a late response's known usage is never lost. Billing may
    // outlast the decision deadline; that caller still cannot use the answer.
    // An answer accepted before the deadline remains valid for a later freshly
    // authorized cache request, even if recording its bill took longer.
    const outcome = await timed('accounting', () => logUsage(ctx.userId, usageParams(ctx.signal?.aborted ? 'cancelled' : expired() ? 'deadline_exceeded' : value === null ? 'escalate' : 'accepted', {
      answers: Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key,
        answer.type === 'choice' ? { choice: answer.choice, probability: answer.probabilities?.[answer.choice] } : answer])),
      provider_confidence: result.providerMetadata?.typesafe?.confidence,
      ...(task.cache && metrics.usage?.known && value !== null && !expired() ? { decision_cache_key: cacheKey,
        // Choice acceptance also validates provider confidence. Preserve only
        // that metadata (no source text or arbitrary provider response data).
        decision_answer: { answers: result.answers,
          providerMetadata: { typesafe: { confidence: result.providerMetadata?.typesafe?.confidence ?? {} } } } } : {}),
    })))
    circuit.failures = 0
    if (ctx.signal?.aborted) return finish({ status: 'cancelled', reason: 'caller_cancelled', inferenceId })
    if (expired()) return escalate('deadline_exceeded', inferenceId)
    if (!metrics.usage.known || outcome === 'lost') return escalate('accounting_unavailable', inferenceId)
    return value === null ? escalate('uncertain', inferenceId) : finish({ status: 'accepted', value, inferenceId, version: task.version })
  } catch (error) {
    if (kind.startsWith('browser.')) await writeBrowserDebugTrace(ctx, 'jev.error', {
      inferenceId, invoked, received: !!received, expired: expired(), callerCancelled: ctx.signal?.aborted === true,
      ...browserErrorDiagnostics(error),
    })
    if (invoked) {
      // Retain any reported usage even if acceptance/accounting failed. Unknown attempts remain reconcilable.
      metrics.usage ??= { known: false, costSource: 'unknown' }
      await timed('accounting', () => logUsage(ctx.userId, usageParams(ctx.signal?.aborted ? 'cancelled' : 'unavailable'))).catch(() => {})
      if (++circuit.failures >= 3) { circuit.until = Date.now() + 30000; circuit.failures = 0 }
    }
    return ctx.signal?.aborted ? finish({ status: 'cancelled', reason: 'caller_cancelled', inferenceId }) : escalate(expired() ? 'deadline_exceeded' : 'unavailable', inferenceId)
  } finally {
    clearTimeout(deadlineTimer)
    if (counted) {
      const remaining = (active.get(ctx.userId) ?? 1) - 1
      if (remaining) active.set(ctx.userId, remaining); else active.delete(ctx.userId)
    }
  }
}
