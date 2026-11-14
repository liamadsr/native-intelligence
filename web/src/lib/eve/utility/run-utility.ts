/**
 * runUtilityTask — run ONE one-shot generation on the eve `utility` agent.
 *
 * This is the only thing the ported call sites (capture/chat titles, skill
 * description, email drafts, knowledge briefs, claim extraction, the weaver's
 * judges) call instead of generateText / generateObject. Everything around the
 * model call stays at the call site, untouched: auth, usage-limit gates, DB
 * reads and writes, dedupe, provenance, prompt assembly, and the logUsage call
 * with its feature key and metadata. Only the model call moves.
 *
 * Shape (mirrors run-skill-eve.ts's runViaEve):
 *   1. resolve the kind's workspace model (unless the caller already did —
 *      the weaver resolves once per workspace);
 *   2. mint a signed utility token carrying { kind, workspace, user, model,
 *      params } — no prompt text;
 *   3. create a one-shot session (createTaskSession: one turn, read to its
 *      boundary, then retired) whose message is the caller's user prompt, with
 *      an outputSchema for the structured kinds;
 *   4. read the stream under an AbortController armed BEFORE the create POST,
 *      stopping at the turn's boundary (see readToBoundary). The
 *      timeout is enforced HERE, by racing every await against the abort —
 *      not delegated to eve honoring the signal — and a timed-out session is
 *      cancelled (best effort) so it stops spending. That includes a session
 *      whose create was still in flight at the deadline: the create POST is
 *      kept alive a little past it (its own signal), and if it then returns a
 *      session id, that session is cancelled too;
 *   5. return the text / schema-validated object, the model that ran, and the
 *      usage summed from step.completed events. Cost follows the eve rule:
 *      0-or-absent → null, so logUsage omits it and log_ai_usage prices the row
 *      from ai_model_costs.
 *
 * Throws on a failed session, a timeout, a transport error, or structured
 * output that does not match the schema — the same moments generateText /
 * generateObject used to throw, so every call site's existing catch applies.
 *
 * Once the answer (or the failure) has been read, the session is RETIRED in
 * the background (retireInBackground: never awaited, so it adds no latency;
 * bounded by RETIRE_TIMEOUT_MS): its run ends, and the utility agent's
 * `retention: 0` then deletes the run's stored data — the prompt included,
 * which can be mail text Native Intelligence must not keep. Never earlier: at retention 0
 * the purge races any read still in flight. A session whose create only
 * returned after the deadline is cancelled, then retired the same way.
 *
 * streamUtilityText is the streaming sibling for the one kind whose caller
 * streams its answer to the browser (note_continuation, /api/ai/complete, a
 * streamText call before the port): same session, token, timeout and cancel
 * rules, but the text is forwarded delta by delta as eve emits it.
 */
import { after } from 'next/server'
import { eveDispatchOrigin } from '@/lib/eve/dispatch-origin'
import { Client, isCurrentTurnBoundaryEvent } from 'eve/client'
import { classifyOneShot, createTurnBoundary, turnHasEnded } from '@/lib/eve/turn-boundary'
import type { HandleMessageStreamEvent } from 'eve/client'
import type { UserContent } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { mapEveTurnUsage } from '@/lib/chat/eve-usage'
import { createTaskSession, retireTaskSession } from '@/lib/eve/task-session'
import {
  mintUtilityToken,
  utilityInternalSecret,
  UTILITY_KIND_HEADER,
  UTILITY_SECRET_HEADER,
  UTILITY_TOKEN_HEADER,
  UTILITY_USER_HEADER,
  UTILITY_WORKSPACE_HEADER,
  type UtilityKind,
  type UtilityParams,
} from '@/lib/eve/utility-run-token'
import { PLAN_MODELS, planModelSlug } from '@/lib/chatgpt/plan-models'
import { resolveUtilityModel, utilityPlanModel, UTILITY_KIND_SPECS, type UtilityAgent } from './spec'

/** The named eve mount for the utility agent (see next.config.mjs). */
const UTILITY_MOUNT = '/eve/utility'
/** The web-research agent's mount: the kinds that need OpenAI's web search on the person's plan. */
const WEB_RESEARCH_MOUNT = '/eve/web-research'
const AGENT_MOUNTS: Record<UtilityAgent, string> = { 'web-research': WEB_RESEARCH_MOUNT }

/** The mount of the agent that runs a kind: its own (UtilityKindSpec.agent), else the utility agent's. */
export function utilityMountFor(kind: UtilityKind): string {
  const agent = UTILITY_KIND_SPECS[kind].agent
  return agent ? AGENT_MOUNTS[agent] : UTILITY_MOUNT
}

/**
 * The pages a session's web searches read, from its stream, de-duplicated in
 * order: a search's `sources` (OpenAI returns them on request, which the plan
 * proxy passes through) and a page it opened (`action.url`, an `openPage` or
 * `findInPage`). Empty when the stream names none, which callers must allow
 * for: a search's sources aren't always returned.
 */
export function webSearchSourcesOf(events: readonly HandleMessageStreamEvent[]): string[] {
  const seen = new Set<string>()
  const add = (url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) seen.add(url)
  }
  for (const output of webSearchOutputsOf(events)) {
    const o = output as { sources?: unknown; action?: { url?: unknown } } | null | undefined
    for (const source of Array.isArray(o?.sources) ? o.sources : []) add((source as { url?: unknown } | null)?.url)
    add(o?.action?.url)
  }
  return [...seen]
}

/** The outputs of a session's web searches (its `web_search` action results), in order. */
function webSearchOutputsOf(events: readonly HandleMessageStreamEvent[]): unknown[] {
  const outputs: unknown[] = []
  for (const event of events) {
    if (event.type !== 'action.result') continue
    const result = (event.data as { result?: { toolName?: unknown; output?: unknown } } | undefined)?.result
    if (result?.toolName === 'web_search') outputs.push(result.output)
  }
  return outputs
}

/**
 * A utility session that ended without completing (failed / parked / stream
 * closed early). The message keeps the `[utility] <kind> session <status>`
 * shape callers already match on; `code` and `semanticErrorId` carry eve's
 * failure classification when the session reported one.
 */
export class UtilitySessionError extends Error {
  constructor(
    readonly kind: UtilityKind,
    readonly status: 'failed' | 'waiting' | 'ended-early',
    readonly code: string | null,
    readonly semanticErrorId: string | null,
  ) {
    super(`[utility] ${kind} session ${status}${code ? ` (${code}${semanticErrorId ? `: ${semanticErrorId}` : ''})` : ''}`)
    this.name = 'UtilitySessionError'
  }

  /**
   * The model returned no text at all — e.g. a reasoning model spending its
   * whole output cap on thinking. The pre-port generateText returned '' in
   * that case instead of throwing; callers that treated '' as "nothing to
   * write" can keep doing so.
   */
  get isEmptyModelResponse(): boolean {
    return this.semanticErrorId === 'empty-model-response'
  }
}

export interface UtilityRunUsage {
  /** INCLUDES the cached tokens below (eve reports the provider's total). */
  inputTokens: number
  outputTokens: number
  /** Cached share of inputTokens; ride usage metadata via usageCacheMetadata. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** null → logUsage omits costUsd → the RPC prices from ai_model_costs. */
  costUsd: number | null
  steps: number
}

/** Content-free usage from the one dispatched utility session, including failed reads. */
export interface UtilityUsageReport {
  model: string
  usage: UtilityRunUsage
  complete: boolean
  inputTokensReported: boolean
  outputTokensReported: boolean
  generationIds: string[]
  /** Where the call's wall time went (see utilityTimeline). */
  timeline?: UtilityTimeline
}

/**
 * Where one utility call's wall time went, in ms. App-side spans use the
 * app's clock; `eve` offsets are eve's own event stamps (meta.at) relative to
 * session.started, so they need no clock agreement. A missing stamp is left
 * out, never estimated.
 */
export interface UtilityTimeline {
  /** Workspace model lookup before dispatch. */
  modelLookupMs: number
  /** POST create until the session id came back. */
  createMs?: number
  /** Session id until the turn boundary was read from the stream. */
  streamMs?: number
  eve?: { turnStarted?: number; stepStarted?: number; firstOutput?: number; stepCompleted?: number; boundary?: number }
}

/** eve-side offsets from session.started for a call's collected events. */
export function utilityEveOffsets(events: readonly HandleMessageStreamEvent[]): UtilityTimeline['eve'] {
  // Diagnostics only: a missing or malformed stamp must never throw, because
  // this runs while the call's usage is being reported.
  const stamp = (event: HandleMessageStreamEvent | undefined) => {
    const at = typeof event?.meta?.at === 'string' ? Date.parse(event.meta.at) : NaN
    return Number.isFinite(at) ? at : undefined
  }
  const start = stamp(events.find(event => event.type === 'session.started'))
  if (start === undefined) return undefined
  const offset = (event: HandleMessageStreamEvent | undefined) => {
    const at = stamp(event)
    return at === undefined ? undefined : Math.max(0, at - start)
  }
  const first = (types: readonly string[]) => events.find(event => types.includes(event.type))
  const offsets = {
    turnStarted: offset(first(['turn.started'])),
    stepStarted: offset(first(['step.started'])),
    firstOutput: offset(first(['message.appended', 'reasoning.appended', 'result.completed'])),
    stepCompleted: offset(first(['step.completed'])),
    boundary: offset(events.find(event => isCurrentTurnBoundaryEvent(event))),
  }
  return Object.fromEntries(Object.entries(offsets).filter(([, value]) => value !== undefined))
}

export interface UtilityRunBase {
  kind: UtilityKind
  workspaceId: string | null
  /** Attribution for Gateway telemetry; null for unattributed background work. */
  userId: string | null
  /**
   * The user prompt — rides as the eve task message, verbatim. UserContent
   * (text + file parts) for the kinds that send a document, e.g. the
   * reference-ingest PDF; file data must be a data: or https URL string.
   */
  message: string | UserContent
  /** Small per-call facts the kind's system prompt is templated on. */
  params?: UtilityParams
  /**
   * The bare app model id, when the caller already resolved it through
   * resolveUtilityModel. Omit to resolve here.
   */
  model?: string
  /**
   * The person runs on their own ChatGPT plan (the free tier): their usage
   * check opted in and said so (src/lib/chatgpt/plan-route.ts). The call then
   * runs on the kind's plan model through the plan proxy, never the Gateway,
   * whatever `model` says; the result's `model` is `chatgpt-plan/<model>`,
   * which logUsage logs at no cost. Needs `userId`: a call with no person has
   * no plan to run on, and is refused rather than run on Native Intelligence's models.
   */
  chatgptPlan?: boolean
  /**
   * On the plan, which of its models runs (a PLAN_MODELS id: the reviewer,
   * which must differ from the plan model that wrote); else the kind's own
   * (utilityPlanModel). Ignored off the plan.
   */
  planModel?: string
  /** Client for the workspace-settings read when resolving the model. */
  supabase?: SupabaseClient
  /** Override the kind's default wall clock. */
  timeoutMs?: number
  /** Caller cancellation stops the local read AND cancels the durable task session. */
  signal?: AbortSignal
  /** Called exactly once for a dispatched session, even on failure; never includes content. */
  onUsage?: (report: UtilityUsageReport) => void
}

export interface UtilityTextResult {
  text: string
  /** The bare app model id the session ran on — what logUsage records. */
  model: string
  usage: UtilityRunUsage
  /** The pages a web-research session's searches returned (webSearchSourcesOf); absent elsewhere. */
  webSources?: string[]
  /** How many web searches a web-research session ran; absent elsewhere. */
  webSearches?: number
}

export interface UtilityObjectResult<T> extends UtilityTextResult {
  object: T
}

/**
 * The app's own origin for the server-to-server create: NEXT_PUBLIC_APP_URL,
 * else local dev's default.
 */
export function utilityAppBaseUrl(): string {
  return eveDispatchOrigin()
}

/**
 * The eve client for ONE utility call: same-origin server-to-server, with the
 * shared secret authenticating us to the internal-only channel, a freshly
 * minted token scoping the call, and redirect:'error' so the credentialed
 * headers never follow a cross-origin redirect.
 */
function utilityClient(a: {
  kind: UtilityKind
  workspaceId: string | null
  userId: string | null
  model: string
  params: UtilityParams
  secret: string
}): Client {
  const token = mintUtilityToken({
    kind: a.kind,
    workspaceId: a.workspaceId,
    userId: a.userId,
    model: a.model,
    params: a.params,
  })
  return new Client({
    host: `${utilityAppBaseUrl()}${utilityMountFor(a.kind)}`,
    auth: { bearer: a.secret },
    headers: {
      [UTILITY_SECRET_HEADER]: a.secret,
      [UTILITY_TOKEN_HEADER]: token,
      [UTILITY_KIND_HEADER]: a.kind,
      ...(a.workspaceId ? { [UTILITY_WORKSPACE_HEADER]: a.workspaceId } : {}),
      ...(a.userId ? { [UTILITY_USER_HEADER]: a.userId } : {}),
    },
    redirect: 'error',
  })
}

/**
 * The signed model for a call on the person's ChatGPT plan
 * (`chatgpt-plan/<model>`, the spec route runs it on the plan), or null for a
 * call on Native Intelligence's models. Throws for a plan call with no person.
 */
function utilityPlanSlug(args: Pick<UtilityRunBase, 'kind' | 'userId' | 'chatgptPlan' | 'planModel'>): string | null {
  if (!args.chatgptPlan) return null
  if (!args.userId) throw new Error(`[utility] ${args.kind} on a ChatGPT plan needs the person whose plan runs it`)
  return planModelSlug(args.planModel && PLAN_MODELS.has(args.planModel) ? args.planModel : utilityPlanModel(args.kind))
}

export function runUtilityTask(args: UtilityRunBase): Promise<UtilityTextResult>
export function runUtilityTask<T>(
  args: UtilityRunBase & { outputSchema: z.ZodType<T> },
): Promise<UtilityObjectResult<T>>
export async function runUtilityTask<T>(
  args: UtilityRunBase & { outputSchema?: z.ZodType<T> },
): Promise<UtilityTextResult | UtilityObjectResult<T>> {
  const { kind, workspaceId, userId, message, outputSchema } = args
  const secret = utilityInternalSecret()
  if (!secret) {
    throw new Error('[utility] UTILITY_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
  }

  const timeoutMs = args.timeoutMs ?? UTILITY_KIND_SPECS[kind].timeoutMs
  const controller = new AbortController()
  const onAbort = () => controller.abort(args.signal?.reason)
  if (args.signal?.aborted) onAbort()
  else args.signal?.addEventListener('abort', onAbort, { once: true })
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs))
  const assertLive = () => {
    if (Date.now() >= deadline) controller.abort()
    if (controller.signal.aborted) throw new Error('aborted')
  }
  const aborted = abortRejection(controller.signal)
  const events: HandleMessageStreamEvent[] = []
  let model: string | undefined
  let client: Client | undefined
  let created: ReturnType<typeof createTaskSession<T>> | undefined
  let sessionId: string | undefined
  let complete = false
  // Keep create alive briefly after cancellation so a late session id can be cancelled.
  const createController = new AbortController()
  const startedAt = performance.now()
  let createAt: number | undefined, sessionAt: number | undefined, boundaryAt: number | undefined
  try {
    assertLive()
    model = utilityPlanSlug(args) ?? args.model ?? await Promise.race([
      resolveUtilityModel(kind, args.supabase ?? getServiceClient(), workspaceId), aborted,
    ])
    createAt = performance.now()
    assertLive()
    client = utilityClient({ kind, workspaceId, userId, model, params: args.params ?? {}, secret })
    created = createTaskSession<T>(client, {
      message,
      signal: controller.signal,
      createSignal: createController.signal,
      ...(outputSchema ? { outputSchema } : {}),
    })
    created.catch(() => {})
    const response = await Promise.race([created, aborted])
    sessionId = response.sessionId
    sessionAt = performance.now()
    const result = await readToBoundary(response, aborted, events)
    boundaryAt = performance.now()
    if (result.status !== 'completed') {
      throw new UtilitySessionError(kind, result.status, result.failureCode, result.semanticErrorId)
    }
    assertLive()
    complete = true
    const turn = mapEveTurnUsage(events)
    const base: UtilityTextResult = {
      text: result.message ?? '', model,
      usage: {
        inputTokens: turn.inputTokens, outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens, cacheWriteTokens: turn.cacheWriteTokens,
        costUsd: turn.costUsd, steps: turn.steps,
      },
      ...(UTILITY_KIND_SPECS[kind].agent === 'web-research'
        ? { webSources: webSearchSourcesOf(events), webSearches: webSearchOutputsOf(events).length }
        : {}),
    }
    if (!outputSchema) return base
    const parsed = outputSchema.safeParse(result.data)
    if (!parsed.success) throw new Error(`[utility] ${kind} returned no valid structured output`)
    return { ...base, object: parsed.data }
  } catch (err) {
    const wasAborted = controller.signal.aborted
    // eve 0.67+: a one-shot's turn ends (turn.completed / failed / cancelled)
    // and the session parks; nothing is left running to cancel.
    const terminal = turnHasEnded(events)
    // A disconnected/ended stream does not terminate Eve's durable generation.
    // Cancel it just as for a deadline, but never re-cancel an observed terminal.
    if (client && sessionId && !terminal) await cancelBestEffort(client, sessionId, kind)
    else if (client && created && !sessionId && wasAborted) await cancelWhenCreated(client, created, createController, kind)
    if (wasAborted) {
      complete = false
      throw new Error(args.signal?.aborted
        ? `[utility] ${kind} cancelled`
        : `[utility] ${kind} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener('abort', onAbort)
    // The answer (or the failure) has been read, and any cancel above has run:
    // end the session now so retention 0 purges its data (the prompt) at once
    // instead of when the 10-minute session timeout fires. In the background:
    // the caller (some race a deadline) never waits on it.
    if (client && sessionId) retireInBackground(client, sessionId, kind)
    if (created && model && args.onUsage) {
      const turn = mapEveTurnUsage(events)
      const steps = events.filter(event => event.type === 'step.completed')
      const reported = (key: 'inputTokens' | 'outputTokens') => steps.length > 0 && steps.every(event => {
        const value = event.data.usage?.[key]
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
      })
      // The callback is accounting-only. Its failure cannot change session execution.
      try {
        args.onUsage({
          model, complete, inputTokensReported: reported('inputTokens'), outputTokensReported: reported('outputTokens'),
          generationIds: turn.generationIds,
          usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens,
            cacheReadTokens: turn.cacheReadTokens, cacheWriteTokens: turn.cacheWriteTokens,
            costUsd: turn.costUsd, steps: turn.steps },
          timeline: {
            modelLookupMs: Math.round((createAt ?? performance.now()) - startedAt),
            ...(createAt !== undefined && sessionAt !== undefined ? { createMs: Math.round(sessionAt - createAt) } : {}),
            ...(sessionAt !== undefined && boundaryAt !== undefined ? { streamMs: Math.round(boundaryAt - sessionAt) } : {}),
            ...(() => { const eve = utilityEveOffsets(events); return eve ? { eve } : {} })(),
          },
        })
      } catch { console.warn(`[utility] ${kind} usage observer failed`) }
    }
  }
}

export interface UtilityStreamArgs extends Omit<UtilityRunBase, 'message' | 'signal' | 'onUsage'> {
  /**
   * Plain text only. The streamed kinds take their message from a browser
   * request body; file parts (UserContent) are for server-built messages and
   * go through runUtilityTask.
   */
  message: string
  /**
   * Runs once, when the session COMPLETES — after the last text delta and
   * before the stream closes (awaited, so a serverless function is not frozen
   * mid-write). Gets the whole text, the model and the usage summed from
   * step.completed, exactly what runUtilityTask returns. Not called when the
   * session fails, times out, or the reader cancels. A throw is logged, never
   * surfaced to the reader: the text has already been delivered.
   */
  onCompleted?: (result: UtilityTextResult) => Promise<void> | void
}

export interface UtilityTextStream {
  /** The model's text, one chunk per eve `message.appended` delta, in order. */
  stream: ReadableStream<string>
  /** The bare app model id the session runs on. */
  model: string
  sessionId: string
}

/**
 * streamUtilityText — a TEXT kind on the utility agent, streamed.
 *
 * Same session as runUtilityTask (one-shot, signed token, same client, same
 * timeout and cancel rules) but the answer is handed back as it is written:
 * every `message.appended` event's `messageDelta` is enqueued as soon as it
 * arrives — the un-buffered forwarding eve-chat-transport.ts does for chat.
 * A `message.completed` carrying text the deltas did not (a provider that
 * does not stream) is enqueued as one final chunk, so nothing is dropped.
 * Reasoning deltas are not text and are never forwarded.
 *
 * Resolves once the session is CREATED — a failed create, a missing secret or
 * a timeout before that throws here, so the caller can answer with an error
 * status instead of an empty 200. After that, failures surface on the stream:
 *   - session failed / parked / stream ended without a boundary → the stream
 *     errors with a UtilitySessionError;
 *   - the timeout (the kind's, covering create + stream) → the session is
 *     cancelled (best effort, ≤ 5s) and the stream errors;
 *   - the reader cancels (the browser went away) → reading stops and the
 *     session is cancelled, so it stops spending with nobody reading it.
 * The stream stops at the session's terminal event, like readToBoundary: the
 * live stream stays open for seconds after it.
 */
export async function streamUtilityText(args: UtilityStreamArgs): Promise<UtilityTextStream> {
  const { kind, workspaceId, userId, message, onCompleted } = args
  // The type says string; a caller that casts a request body must not get
  // file parts into the session anyway.
  if (typeof message !== 'string') {
    throw new TypeError(`[utility] ${kind} streams a text message only`)
  }
  const secret = utilityInternalSecret()
  if (!secret) {
    throw new Error('[utility] UTILITY_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
  }

  const model =
    utilityPlanSlug(args) ?? args.model ?? (await resolveUtilityModel(kind, args.supabase ?? getServiceClient(), workspaceId))
  const client = utilityClient({ kind, workspaceId, userId, model, params: args.params ?? {}, secret })

  const timeoutMs = args.timeoutMs ?? UTILITY_KIND_SPECS[kind].timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const aborted = abortRejection(controller.signal)
  // Own signal for the create POST, for the same reason as runUtilityTask.
  const createController = new AbortController()
  const created = createTaskSession(client, {
    message,
    signal: controller.signal,
    createSignal: createController.signal,
  })
  created.catch(() => {})

  let response: Awaited<typeof created>
  try {
    response = await Promise.race([created, aborted])
  } catch (err) {
    clearTimeout(timer)
    if (controller.signal.aborted) {
      await cancelWhenCreated(client, created, createController, kind)
      throw new Error(`[utility] ${kind} timed out after ${timeoutMs}ms`)
    }
    throw err
  }

  const sessionId = response.sessionId
  const iterator = response[Symbol.asyncIterator]()
  const events: HandleMessageStreamEvent[] = []
  const endsTurn = createTurnBoundary()
  let text = ''
  /** The session reached its boundary, failed, timed out, or the reader left. */
  let done = false
  let readerCancelled = false

  const stop = () => {
    done = true
    clearTimeout(timer)
    // Release the stream (a hung one may never settle — don't await it).
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
  // Retire the session once, in the background — only after the boundary was
  // read or reading was given up (failure, timeout, reader gone). See
  // runUtilityTask.
  let retired = false
  const retire = () => {
    if (retired) return
    retired = true
    retireInBackground(client, sessionId, kind)
  }

  const stream = new ReadableStream<string>({
    async pull(ctrl) {
      if (done) return
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted])
          if (readerCancelled) return
          if (next.done) {
            throw new UtilitySessionError(kind, 'ended-early', null, null)
          }
          const ev = next.value
          events.push(ev)
          const boundary = endsTurn(ev)
          if (ev.type === 'message.appended') {
            const delta = ev.data.messageDelta
            if (!delta) continue
            text += delta
            ctrl.enqueue(delta)
            return
          }
          if (ev.type === 'message.completed' && ev.data.finishReason !== 'tool-calls') {
            const full = ev.data.message ?? ''
            if (full.length > text.length && full.startsWith(text)) {
              const rest = full.slice(text.length)
              text = full
              ctrl.enqueue(rest)
              return
            }
            continue
          }
          if (boundary) {
            stop()
            const outcome = classifyBoundary(ev, events)
            if (outcome.status !== 'completed') {
              throw new UtilitySessionError(kind, outcome.status, outcome.failureCode, outcome.semanticErrorId)
            }
            // Every delta is in `text` now: retire (in the background, held
            // open past the response by after()).
            retire()
            if (onCompleted) {
              const turn = mapEveTurnUsage(events)
              try {
                await onCompleted({
                  text,
                  model,
                  usage: {
                    inputTokens: turn.inputTokens,
                    outputTokens: turn.outputTokens,
                    cacheReadTokens: turn.cacheReadTokens,
                    cacheWriteTokens: turn.cacheWriteTokens,
                    costUsd: turn.costUsd,
                    steps: turn.steps,
                  },
                })
              } catch (err) {
                console.error(`[utility] ${kind} onCompleted failed:`, err instanceof Error ? err.message : err)
              }
            }
            ctrl.close()
            return
          }
        }
      } catch (err) {
        if (readerCancelled) return
        const timedOut = controller.signal.aborted
        stop()
        if (timedOut) {
          await cancelBestEffort(client, sessionId, kind)
          retire()
          ctrl.error(new Error(`[utility] ${kind} timed out after ${timeoutMs}ms`))
          return
        }
        retire()
        ctrl.error(err)
      }
    },
    async cancel() {
      if (done) return
      readerCancelled = true
      stop()
      await cancelBestEffort(client, sessionId, kind)
      retire()
    },
  })

  return { stream, model, sessionId }
}

/** How long the post-timeout cancel may take before we give up on it. */
export const CANCEL_TIMEOUT_MS = 5_000

/** How long retiring a read session may take before we give up on it. */
export const RETIRE_TIMEOUT_MS = 1_500

/**
 * End a utility session whose answer (or failure) has been read, so its run
 * finishes and the agent's `retention: 0` deletes the run's data now. Best
 * effort and bounded: a failure logs one line and never changes the result —
 * the 10-minute session timeout is the backstop.
 */
async function retireBestEffort(client: Client, sessionId: string, kind: UtilityKind): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const retired = await Promise.race([
      retireTaskSession(client, sessionId, { timeoutMs: RETIRE_TIMEOUT_MS, reason: 'utility one-shot read' }),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), RETIRE_TIMEOUT_MS) }),
    ])
    if (!retired) console.warn(`[utility] ${kind} retiring session ${sessionId} failed`)
  } catch {
    console.warn(`[utility] ${kind} retiring session ${sessionId} failed`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Retire without making anyone wait: start retireBestEffort and hand it to
 * Next's after(), which keeps the invocation alive until it settles once the
 * response is sent. Outside a request scope (Inngest functions, crons, tests)
 * after() throws, and the promise just floats. A lost retire is fine: the
 * 10-minute session timeout ends the run anyway, and retention 0 purges it.
 */
function retireInBackground(client: Client, sessionId: string, kind: UtilityKind): void {
  const work = retireBestEffort(client, sessionId, kind).catch(() => {
    console.warn(`[utility] ${kind} retiring session ${sessionId} failed`)
  })
  try {
    after(work)
  } catch {
    void work
  }
}

/**
 * A promise that rejects when `signal` aborts (never resolves). Raced against
 * every await so a create or a stream that ignores the signal still times out.
 * Pre-caught so an un-raced rejection is never "unhandled".
 */
function abortRejection(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error('aborted'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
  p.catch(() => {})
  return p
}

/**
 * Cancel a timed-out session's active turn. No turnId: eve cancels whichever
 * turn is active, so this works even if our read never saw turn.started.
 * Best effort and bounded — a failure is logged, never thrown over the
 * timeout error.
 */
async function cancelBestEffort(
  client: Client,
  sessionId: string,
  kind: UtilityKind,
  budgetMs: number = CANCEL_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.sessions.attach(sessionId).cancel({ signal: AbortSignal.timeout(budgetMs) }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('cancel deadline')), budgetMs) }),
    ])
  } catch {
    console.warn(`[utility] ${kind} cancelling session ${sessionId} failed`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The timeout fired before the create POST returned. The server may still have
 * created the session (a slow response), and that session would run to
 * completion unread and uncancelled. Wait — within the same CANCEL_TIMEOUT_MS
 * budget a post-create cancel gets, the WHOLE post-timeout path included — for
 * the create to settle; if it yields a session id, cancel that session with
 * whatever budget is left.
 *
 * The create POST runs on `createController`, which only this function aborts.
 * (A separate timer aborting it would make the fetch reject — indistinguishable
 * from a create that failed on its own — and the one case that can orphan a
 * session would pass silently.) So:
 *   - the create fails on its own (non-2xx, no id) → no session, nothing to do;
 *   - it names a session → cancel it within the remaining budget, then retire
 *     it in the background (so retention 0 purges its prompt now, not at the
 *     10-minute session timeout);
 *   - still pending when the budget runs out → abort the POST and warn: the
 *     server may have started a session nobody will cancel.
 */
async function cancelWhenCreated(
  client: Client,
  created: Promise<{ sessionId: string }>,
  createController: AbortController,
  kind: UtilityKind,
): Promise<void> {
  const deadline = Date.now() + CANCEL_TIMEOUT_MS
  const PENDING = Symbol('pending')
  let wait: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    created.then(
      (r) => r.sessionId,
      // Only a rejection we did not cause can land here (we abort after
      // PENDING wins, below); treat one we did cause as unknown, never clean.
      () => (createController.signal.aborted ? PENDING : null),
    ),
    new Promise<typeof PENDING>((resolve) => {
      wait = setTimeout(() => resolve(PENDING), CANCEL_TIMEOUT_MS)
    }),
  ])
  clearTimeout(wait)
  if (outcome === PENDING) {
    createController.abort()
    console.warn(
      `[utility] ${kind} timed out and its session create had not returned ${CANCEL_TIMEOUT_MS}ms later — a session it started (if any) was not cancelled`,
    )
    return
  }
  if (!outcome) return
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    console.warn(
      `[utility] ${kind} timed out and its session ${outcome} was created at the end of the ${CANCEL_TIMEOUT_MS}ms cancel budget — it was not cancelled`,
    )
    // Retiring (a reset) still ends its run, and costs the caller nothing.
    retireInBackground(client, outcome, kind)
    return
  }
  await cancelBestEffort(client, outcome, kind, remaining)
  retireInBackground(client, outcome, kind)
}

interface BoundaryResult {
  status: 'completed' | 'failed' | 'waiting' | 'ended-early'
  /** turn.failed's or session.failed's `code` / `details.semanticErrorId`, when present. */
  failureCode: string | null
  semanticErrorId: string | null
  message: string | undefined
  data: unknown
  events: HandleMessageStreamEvent[]
}

/**
 * Consume a task session's events up to its turn's boundary
 * (createTurnBoundary: session.waiting / .completed / .failed, or a
 * turn.waiting on a person) and stop there; classifyOneShot reads how the
 * turn ended (eve 0.67+ parks a one-shot after its turn instead of
 * completing the session).
 *
 * Why not `response.result()`: it reads until the STREAM closes, and a live
 * local run (eve 0.66.3 dev) showed the stream staying open ~8s after
 * session.completed — a 2s generation took 10s end to end. eve's own
 * collectTurnEvents breaks at the same boundary; this mirrors it and
 * summarizes the way result() does (final non-tool-call message.completed,
 * last result.completed). A stream that ends WITHOUT a boundary is a failure,
 * never a silent success.
 */
async function readToBoundary(
  response: AsyncIterable<HandleMessageStreamEvent>,
  aborted: Promise<never>,
  events: HandleMessageStreamEvent[] = [],
): Promise<BoundaryResult> {
  let boundary: HandleMessageStreamEvent | undefined
  let message: string | undefined
  let data: unknown
  const iterator = response[Symbol.asyncIterator]()
  const endsTurn = createTurnBoundary()
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) break
      const ev = next.value
      events.push(ev)
      if (ev.type === 'message.completed' && ev.data.finishReason !== 'tool-calls') {
        message = ev.data.message ?? undefined
      } else if (ev.type === 'result.completed') {
        data = ev.data.result
      }
      if (endsTurn(ev)) {
        boundary = ev
        break
      }
    }
  } finally {
    // Release the stream (a hung one may never settle — don't await it).
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
  return { ...classifyBoundary(boundary, events), message, data, events }
}

/** How the one-shot turn ended, from its boundary and the events before it (none → ended early). */
function classifyBoundary(
  boundary: HandleMessageStreamEvent | undefined,
  events: readonly HandleMessageStreamEvent[],
): Pick<BoundaryResult, 'status' | 'failureCode' | 'semanticErrorId'> {
  const outcome = classifyOneShot(boundary, events)
  if (!outcome) return { status: 'ended-early', failureCode: null, semanticErrorId: null }
  return { status: outcome.status, failureCode: outcome.failureCode, semanticErrorId: outcome.semanticErrorId }
}
