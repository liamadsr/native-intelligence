/**
 * The cloud live agent's MODEL CALL on eve (LIVE-AGENT-DESIGN §8, §9, WS-1 Steps
 * 3–5): everything `POST /api/ai/live-agent` needs to run one turn as an eve
 * task session and hand the result to its unchanged `finalize()`.
 *
 *   - liveAgentEveClient ...... the server-to-server client for the `live-agent`
 *                               mount, carrying the per-turn run token
 *   - startLiveTurnSession .... the create POST, abandonable without orphaning
 *                               the session the server may already have started
 *   - readLiveTurn ............ reads the session to its terminal boundary,
 *                               counting steps and cancelling at the step
 *                               ceiling (eve has no step-count stop — §9.1)
 *   - toGenResult ............. the adapter: eve events → the GenResult shape
 *                               finalize() reads (text, steps, usage, cost)
 *   - createLiveTurnSseTranslator
 *                               eve events → the panel's existing SSE contract
 *                               ({type:'text'|'tool'}; the route adds done/error)
 *
 * Pure except for the client construction and readLiveTurn's iteration, so the
 * adapter and translator are unit-tested on synthetic eve events.
 */
import { Client } from 'eve/client'
import type { MessageResponse, MessageStreamEvent } from 'eve/client'
import { cancelTaskSession, createTaskSession } from '@/lib/eve/task-session'
import { classifyOneShot, createTurnBoundary } from '@/lib/eve/turn-boundary'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mapEveTurnUsage } from '@/lib/chat/eve-usage'
import { CHATGPT_PLAN_PROVIDER, planModelOfStep } from '@/lib/chatgpt/plan-models'
import { harvestWebSearchCost } from '@/lib/ai/tools/web-search'
import { extractStreamingStringValue } from './streaming-json'
import {
  LIVE_AGENT_TOKEN_HEADER,
  LIVE_AGENT_USER_HEADER,
  LIVE_AGENT_WORKSPACE_HEADER,
} from './live-agent-run-token'
import { LIVE_TURN_BUDGETS } from './turn-budget'

/** The named eve mount for the live agent (see next.config.mjs). */
const LIVE_AGENT_MOUNT = '/eve/live-agent'

/**
 * Tool-step ceilings per turn (turn-budget.ts LIVE_TURN_BUDGETS: a window's
 * tick and the batch; a person's record turn has its own, smaller one). A batch
 * run extracts from the whole meeting in one turn, so it needs many more tool
 * steps than an incremental live turn. Re-declared by src/lib/evals/
 * run-trial.ts (a flush that ends AT the ceiling with finish_reason
 * 'tool-calls' measured the budget, not the prompt).
 */
export const LIVE_STEP_CEILING = LIVE_TURN_BUDGETS.tick.maxSteps
export const BATCH_STEP_CEILING = LIVE_TURN_BUDGETS.batch.maxSteps

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * The app's own origin for the server-to-server create. On Vercel, THIS
 * deployment (the live-agent mount ships with the same commit); otherwise
 * NEXT_PUBLIC_APP_URL, else local dev's default.
 */
export function liveAgentAppBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/** Lets a same-deployment call through Vercel Deployment Protection on previews. */
function protectionBypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  return secret ? { 'x-vercel-protection-bypass': secret } : {}
}

/**
 * The eve client for ONE live turn. The shared secret authenticates us to the
 * internal-only channel (agents/live-agent/lib/auth.ts); the run token rides a
 * header the channel stamps onto the session principal, where the mount's
 * resolvers read it and forward it to /api/internal/live-agent/{spec,tool}.
 * The workspace/user headers are observability echoes only — the token is
 * authoritative. redirect:'error' so the credentialed headers never follow a
 * cross-origin redirect.
 */
export function liveAgentEveClient(a: {
  runToken: string
  workspaceId: string
  userId: string
  secret: string
}): Client {
  return new Client({
    host: `${liveAgentAppBaseUrl()}${LIVE_AGENT_MOUNT}`,
    auth: { bearer: a.secret },
    headers: {
      [LIVE_AGENT_TOKEN_HEADER]: a.runToken,
      [LIVE_AGENT_WORKSPACE_HEADER]: a.workspaceId,
      [LIVE_AGENT_USER_HEADER]: a.userId,
      ...protectionBypassHeaders(),
    },
    redirect: 'error',
  })
}

// ── Starting the session ─────────────────────────────────────────────────────

/**
 * How long an abandoned turn keeps its in-flight create POST alive to learn the
 * session id it must cancel (the same budget run-utility's cancelWhenCreated
 * and a session cancel get).
 */
export const CREATE_CANCEL_GRACE_MS = 5_000

/** Thrown when the turn was abandoned before its session create returned. */
export class LiveTurnAbandonedError extends Error {
  constructor() {
    super('live-agent turn abandoned before its eve session was created')
    this.name = 'LiveTurnAbandonedError'
  }
}

/**
 * Keeps a create that is still pending after the grace alive, so its session is
 * cancelled whenever its id arrives instead of being orphaned. `run` hands the
 * work to something that outlives the response (the route passes next/server's
 * after(): on a client disconnect the response is over, but the invocation is
 * not); `until` is the epoch-ms function deadline — past it the POST is aborted.
 */
export interface DeferredCreateCancel {
  run: (work: Promise<void>) => void
  until: number
}

/** cancelTaskSession, with a warning naming the session when the cancel failed. */
export async function cancelLiveTurnSession(client: Client, sessionId: string): Promise<boolean> {
  const ok = await cancelTaskSession(client, sessionId)
  if (!ok) {
    console.warn(`[live-agent] cancel of eve session ${sessionId} failed — it may run on unobserved until its own limits stop it`)
  }
  return ok
}

/**
 * Start the turn's TASK session. `signal` (client gone / wall clock) abandons
 * it — but the create POST does NOT run on that signal: the eve create route
 * dispatches the durable session before it answers, so aborting the POST would
 * lose the one thing that can stop it (its id), and the session would run the
 * whole turn unobserved — no usage row, and propose_change / write_summary
 * writing to a capture whose window a superseding turn is already extracting.
 * use-streaming-extraction aborts the in-flight stream on every new start and
 * on unmount, and the create window includes the mount's cold start, so this
 * is the common disconnect, not a corner.
 *
 * So the POST runs on its own controller. When `signal` wins the race, the POST
 * is given CREATE_CANCEL_GRACE_MS more to settle: a session id → cancelled; a
 * create that failed on its own → nothing started. Still pending after that:
 * with `defer`, the POST keeps running in the deferred work until `defer.until`
 * and its session is cancelled whenever the id arrives (the create is only
 * aborted, with a warning, if the function deadline comes first); without
 * `defer`, the POST is aborted now with that warning. Either way this then
 * throws LiveTurnAbandonedError (nothing ran that we observed — no usage).
 * A create that fails before `signal` fires rejects with its own error.
 */
export async function startLiveTurnSession(
  client: Client,
  opts: { message: string; signal: AbortSignal; defer?: DeferredCreateCancel },
): Promise<MessageResponse<unknown>> {
  const createController = new AbortController()
  const created = createTaskSession(client, {
    message: opts.message,
    signal: opts.signal,
    createSignal: createController.signal,
  })
  created.catch(() => {})

  const ABANDONED = Symbol('abandoned')
  let onAbort: (() => void) | undefined
  const abandoned = new Promise<typeof ABANDONED>((resolve) => {
    if (opts.signal.aborted) return resolve(ABANDONED)
    onAbort = () => resolve(ABANDONED)
    opts.signal.addEventListener('abort', onAbort, { once: true })
  })
  let winner: MessageResponse<unknown> | typeof ABANDONED
  try {
    winner = await Promise.race([created, abandoned])
  } finally {
    if (onAbort) opts.signal.removeEventListener('abort', onAbort)
  }
  if (winner !== ABANDONED) return winner

  const createdId = created.then(
    (r) => r.sessionId,
    () => null,
  )
  const outcome = await settleWithin(createdId, CREATE_CANCEL_GRACE_MS)
  if (outcome === PENDING) {
    const budget = opts.defer ? opts.defer.until - Date.now() : 0
    if (opts.defer && budget > 0) {
      opts.defer.run(
        settleWithin(createdId, budget).then(async (late) => {
          if (late === PENDING) abortPendingCreate(createController, CREATE_CANCEL_GRACE_MS + budget)
          else if (late) await cancelLiveTurnSession(client, late)
        }),
      )
    } else {
      abortPendingCreate(createController, CREATE_CANCEL_GRACE_MS)
    }
  } else if (outcome) {
    await cancelLiveTurnSession(client, outcome)
  }
  throw new LiveTurnAbandonedError()
}

const PENDING = Symbol('pending')

/** `p`'s value if it settles within `ms`, else PENDING. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  let wait: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<typeof PENDING>((resolve) => {
        wait = setTimeout(() => resolve(PENDING), ms)
      }),
    ])
  } finally {
    clearTimeout(wait)
  }
}

function abortPendingCreate(createController: AbortController, waitedMs: number): void {
  createController.abort()
  console.warn(
    `[live-agent] turn abandoned and its session create had not returned ${waitedMs}ms later — a session it started (if any) was not cancelled`,
  )
}

// ── The adapter (§8) ─────────────────────────────────────────────────────────

/** One completed model step, narrowed to what finalize() reads. */
export interface LiveTurnStep {
  /** The tool calls the step requested. `input` is the call's INPUT, never its result. */
  toolCalls: Array<{ toolName: string; input?: unknown }>
  /**
   * The results of those calls. `output` is the tool's JSON output — for the
   * provider-executed web_search, Exa's raw result, whose `costDollars.total`
   * harvestWebSearchCost reads.
   */
  toolResults: Array<{ toolName: string; output: unknown; isError?: boolean }>
  finishReason?: string
}

/** Resolved generation output — the ONLY thing finalize() reads from the model call. */
export interface LiveTurnGen {
  text: string
  /**
   * Summed across EVERY completed step (the tokens really spent). inputTokens
   * includes the cached share; cacheReadTokens / cacheWriteTokens are that share,
   * which log_ai_usage needs in its metadata to price a 'claude' row
   * cache-aware (a 0.9 cache-read ratio is ~5x cheaper than list-pricing it all).
   */
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens: number; cacheWriteTokens: number }
  steps: LiveTurnStep[]
  /** Gateway generation ids (the /v1/report join key), for the usage row's metadata. */
  generationIds: string[]
  /** The largest output-token count any completed step reported (the usage row's metadata). */
  maxStepOutputTokens: number
  /**
   * eve's own cost, only when it is a real non-zero number (the Vercel-credits
   * path) AND the turn ran no Exa-billed web_search (whose charge eve's cost
   * includes — see toGenResult). 0/absent (BYOK, anthropic-direct) or Exa spend
   * → undefined → logUsage omits it and log_ai_usage prices the row from
   * ai_model_costs. Never trust eve's 0.
   */
  costUsd?: number
}

type RequestedAction = MessageStreamEvent & { type: 'actions.requested' }

/** A requested action that is a TOOL call (not a skill load or a subagent call). */
function toolCallsOf(ev: RequestedAction): Array<{ callId: string; toolName: string; input: unknown }> {
  const out: Array<{ callId: string; toolName: string; input: unknown }> = []
  for (const action of ev.data.actions) {
    if (action.kind !== 'tool-call' && action.kind !== 'workflow-tool-call') continue
    out.push({ callId: action.callId, toolName: action.toolName, input: action.input })
  }
  return out
}

/**
 * Rebuild the AI-SDK-shaped `steps` array from eve's events: one entry per
 * `step.completed` (a step that never completed is not a step, exactly as the
 * SDK's `steps` only holds finished ones), in completion order.
 *
 *   - toolCalls come from `actions.requested`, whose `input` is the call's
 *     validated INPUT. NEVER from `action.result`: the Evals trace reads
 *     `tool_call_details[].args` as what the agent ASKED for (run-trial.ts's
 *     commitmentsOf documents that trap), and a result is a different object.
 *   - toolResults come from `action.result` (kind 'tool-result'), attached to the
 *     step that REQUESTED the call — matched by callId, with the event's own
 *     stepIndex as the fallback for a result whose request was never seen.
 *   - Calls are de-duplicated by callId: eve may announce a step's calls
 *     incrementally across several `actions.requested` events.
 */
export function reconstructSteps(events: readonly MessageStreamEvent[]): LiveTurnStep[] {
  return reconstructIndexedSteps(events).map(({ step }) => step)
}

/** reconstructSteps with each step's eve stepIndex, in completion order. */
function reconstructIndexedSteps(events: readonly MessageStreamEvent[]): Array<{ index: number; step: LiveTurnStep }> {
  const byStep = new Map<number, LiveTurnStep>()
  const stepOfCall = new Map<string, number>()
  const completed: number[] = []
  const step = (i: number): LiveTurnStep => {
    let s = byStep.get(i)
    if (!s) {
      s = { toolCalls: [], toolResults: [] }
      byStep.set(i, s)
    }
    return s
  }

  for (const ev of events) {
    if (ev.type === 'actions.requested') {
      for (const call of toolCallsOf(ev)) {
        if (stepOfCall.has(call.callId)) continue
        stepOfCall.set(call.callId, ev.data.stepIndex)
        step(ev.data.stepIndex).toolCalls.push({ toolName: call.toolName, input: call.input })
      }
    } else if (ev.type === 'action.result') {
      const r = ev.data.result
      if (r.kind !== 'tool-result') continue
      const i = stepOfCall.get(r.callId) ?? ev.data.stepIndex
      step(i).toolResults.push({ toolName: r.toolName, output: r.output, ...(r.isError ? { isError: true } : {}) })
    } else if (ev.type === 'step.completed') {
      step(ev.data.stepIndex).finishReason = ev.data.finishReason
      if (!completed.includes(ev.data.stepIndex)) completed.push(ev.data.stepIndex)
    }
  }
  return completed.map((i) => ({ index: i, step: byStep.get(i)! }))
}

/** Step `lastStep`'s assistant text (the SDK's `result.text`), '' when there is none. */
function stepText(events: readonly MessageStreamEvent[], lastStep: number | null): string {
  if (lastStep === null) return ''
  let text = ''
  for (const ev of events) {
    if (ev.type === 'message.completed' && ev.data.stepIndex === lastStep && ev.data.message) {
      text += ev.data.message
    }
  }
  return text
}

/**
 * eve events → the GenResult finalize() consumes.
 *
 *   - `steps` / `text` are what the AI-SDK `stopWhen: isStepCount(maxSteps)`
 *     produced: at most the first `maxSteps` completed steps, and the text of
 *     the last of THOSE. The ceiling cancel is fire-and-forget, so step N+1 can
 *     still complete before it lands; counting it would report steps_used N+1
 *     and a non-'tool-calls' finish, which run-trial.ts would grade as an
 *     untruncated turn.
 *   - `usage` is SUMMED across EVERY completed step, that late one included —
 *     its tokens were spent (the AI-SDK path billed the final step only, which
 *     under-counted every multi-step turn). Cost follows the eve rule via
 *     mapEveTurnUsage: 0-or-absent → null → omitted here.
 */
export function toGenResult(events: readonly MessageStreamEvent[], opts: { maxSteps?: number } = {}): LiveTurnGen {
  const usage = mapEveTurnUsage(events)
  const all = reconstructIndexedSteps(events)
  const kept = opts.maxSteps !== undefined ? all.slice(0, Math.max(0, opts.maxSteps)) : all
  // eve's step cost is the Gateway's billed `cost`, and a step that ran the
  // provider-executed web_search is billed the Exa search too. Measured on eve
  // 0.66.3 (a BYOK Anthropic model, one step, 8.1k input tokens): step costUsd
  // 0.007 == the result's costDollars.total 0.007 — the tokens were billed 0
  // (BYOK) and the whole "cost" was Exa. Trusting it would bill the turn's
  // tokens at nothing (and, on credits, fold Exa into a figure the row also
  // reports as webSearchCostUsd). So a turn with Exa spend drops eve's cost:
  // the RPC list-prices the tokens and the Exa spend rides in metadata, as it
  // did before the port. Read over EVERY step (usage sums them all).
  const webSpend = harvestWebSearchCost(all.map(({ step }) => step)) !== null
  return {
    text: stepText(events, kept.length ? kept[kept.length - 1].index : null),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    steps: kept.map(({ step }) => step),
    generationIds: usage.generationIds,
    maxStepOutputTokens: maxStepOutputTokens(events),
    ...(usage.costUsd !== null && !webSpend ? { costUsd: usage.costUsd } : {}),
  }
}

/**
 * The usage-row metadata log_ai_usage prices a row's cached tokens from
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`, its keys) — only
 * when there are any, so an uncached row carries no noise.
 */
export function liveTurnCacheMetadata(usage: LiveTurnGen['usage']): Record<string, number> {
  return {
    ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens > 0 ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  }
}

/**
 * A failed first attempt's spend, folded into the gen of the attempt that
 * replaced it (turn-budget.ts shouldRetryLiveTurn): its tokens were spent, so
 * the one usage row the turn logs counts them. eve's cost survives only when
 * BOTH attempts carried a real one (summed); otherwise it is dropped and the
 * RPC list-prices the summed tokens, as for any turn whose cost is not trusted.
 */
export function withFailedAttemptUsage(gen: LiveTurnGen, failed: readonly MessageStreamEvent[]): LiveTurnGen {
  const spent = mapEveTurnUsage(failed)
  if (!spent.inputTokens && !spent.outputTokens && spent.generationIds.length === 0) return gen
  const { costUsd, ...rest } = gen
  const bothCosted = costUsd !== undefined && spent.costUsd !== null
  return {
    ...rest,
    usage: {
      inputTokens: (gen.usage.inputTokens ?? 0) + spent.inputTokens,
      outputTokens: (gen.usage.outputTokens ?? 0) + spent.outputTokens,
      cacheReadTokens: gen.usage.cacheReadTokens + spent.cacheReadTokens,
      cacheWriteTokens: gen.usage.cacheWriteTokens + spent.cacheWriteTokens,
    },
    generationIds: [...new Set([...spent.generationIds, ...gen.generationIds])],
    maxStepOutputTokens: Math.max(gen.maxStepOutputTokens, maxStepOutputTokens(failed)),
    ...(bothCosted ? { costUsd: costUsd + (spent.costUsd as number) } : {}),
  }
}

/** The largest output-token count any completed step of the turn reported (0 when none did). */
export function maxStepOutputTokens(events: readonly MessageStreamEvent[]): number {
  let max = 0
  for (const ev of events) {
    if (ev.type !== 'step.completed') continue
    const out = ev.data.usage?.outputTokens
    if (typeof out === 'number' && out > max) max = out
  }
  return max
}

// ── An eval turn's real cost ─────────────────────────────────────────────────

/** log_ai_usage's conservative per-million fallback when a model has no price row. */
const FALLBACK_INPUT_PER_M = 15
const FALLBACK_OUTPUT_PER_M = 75

/**
 * The LIST price of a turn's tokens, from ai_model_costs — the same table and
 * the same formula log_ai_usage prices a row with when no cost is passed
 * (supabase/migrations/199_subscription_aligned_allowance_reset.sql):
 *
 *   - a price row for provider+model, provider 'claude', and cached tokens →
 *     the RPC's cache-aware branch: regular input (input − read − write) at
 *     1x, cache writes at 1.25x, cache reads at 0.1x, output at the output rate
 *     (the Gateway's marketCost the AI-SDK path logged was cache-aware too);
 *   - a price row otherwise → every input token at the input rate;
 *   - no price row → the RPC's $15/$75 per-million conservative fallback, on
 *     all input tokens (the RPC's fallback ignores caching too).
 *
 * Only an EVAL turn needs this app-side: its usage row is logged with
 * skipBilling, so the RPC prices nothing, and the trial's spend (run-trial.ts
 * readBackUsage → max_cost_usd, the monthly cap) is read from
 * `metadata.realCostUsd`. The AI-SDK path filled that with the Gateway's
 * marketCost; eve surfaces no marketCost and its own cost is 0 under BYOK, so
 * without this an Anthropic-model eval would report $0 and never trip its
 * budget. Null only when the price read itself fails.
 *
 * A turn on the person's own ChatGPT plan (`chatgpt-plan/<model>`, the free
 * tier) is $0: their plan pays, and no price row exists for it, so the
 * fallback above would invent $15/$75 per million and stop their eval run on
 * its $0 ceiling (start-run.ts), or count against the workspace's monthly cap.
 */
export async function listPriceCostUsd(
  supabase: SupabaseClient,
  a: {
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): Promise<number | null> {
  if (a.provider === CHATGPT_PLAN_PROVIDER || planModelOfStep(a.model)) return 0
  try {
    const { data, error } = await supabase
      .from('ai_model_costs')
      .select('input_cost_per_million, output_cost_per_million')
      .eq('provider', a.provider)
      .eq('model', a.model)
      .is('effective_until', null)
      .limit(1)
      .maybeSingle()
    if (error) return null
    const row = data as { input_cost_per_million?: number | string | null; output_cost_per_million?: number | string | null } | null
    const inPerM = row ? Number(row.input_cost_per_million) : FALLBACK_INPUT_PER_M
    const outPerM = row ? Number(row.output_cost_per_million) : FALLBACK_OUTPUT_PER_M
    if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) return null
    const read = Math.max(0, a.cacheReadTokens ?? 0)
    const write = Math.max(0, a.cacheWriteTokens ?? 0)
    const perM = (tokens: number, rate: number) => (tokens / 1_000_000) * rate
    const cost =
      row && a.provider === 'claude' && (read > 0 || write > 0)
        ? perM(Math.max(a.inputTokens - read - write, 0), inPerM) +
          perM(write, inPerM * 1.25) +
          perM(read, inPerM * 0.1) +
          perM(a.outputTokens, outPerM)
        : perM(a.inputTokens, inPerM) + perM(a.outputTokens, outPerM)
    return Math.round(cost * 1e8) / 1e8
  } catch {
    return null
  }
}

// ── Reading a turn (§9.1) ────────────────────────────────────────────────────

/**
 * How a live turn's session ended, from the route's point of view:
 *   - completed ... turn.completed, then the session parks (eve 0.67+), or
 *                   session.completed
 *   - ceiling ..... the route cancelled it at the step ceiling — a NORMAL end
 *                   (the AI-SDK path's stopWhen), finalized like `completed`
 *   - failed ...... turn.failed / turn.cancelled / session.failed (or a
 *                   boundary-less end)
 *   - waiting ..... the turn parked on a person (turn.waiting): a live turn
 *                   should never ask
 *   - aborted ..... the caller stopped reading (client disconnect / wall clock)
 */
export type LiveTurnOutcome = 'completed' | 'ceiling' | 'failed' | 'waiting' | 'aborted'

/**
 * Which budget ended a `ceiling` turn: the step count, the streamed output of
 * one step or of the whole turn, one step's reasoning, or the turn's
 * wall-clock deadline.
 */
export type LiveTurnBudgetHit = 'steps' | 'step-output' | 'turn-output' | 'step-reasoning' | 'deadline'

export interface LiveTurnRead {
  events: MessageStreamEvent[]
  outcome: LiveTurnOutcome
  /** step.completed events seen. */
  stepsCompleted: number
  /**
   * Whether eve itself reported the turn over: turn.completed / failed /
   * cancelled or session.completed / failed (classifyOneShot's turnEnded), or —
   * after a budget cancel — turn.cancelled. False for a boundary-less stream
   * end, a turn parked on a person (still alive), an abort, and a budget
   * wind-down that timed out (the cancel may never have landed). A non-terminal
   * turn must be cancelled by the caller, or its session keeps calling tools
   * (and the model) unobserved.
   */
  terminal: boolean
  /** Set on a `ceiling` outcome: the budget that ended the turn. */
  budgetHit?: LiveTurnBudgetHit
  /** Characters of output streamed (assistant text, tool input), the whole turn. */
  outputChars: number
  /** Characters of reasoning streamed, the whole turn. */
  reasoningChars: number
}

/** The per-turn budgets readLiveTurn enforces beside the step ceiling (all optional). */
export interface LiveTurnReadBudget {
  /** Streamed output (text + tool input) one step may produce, in characters. */
  maxStepOutputChars?: number
  /** Streamed output (text + tool input) the whole turn may produce, in characters. */
  maxTurnOutputChars?: number
  /** Streamed reasoning one step may produce, in characters (its own allowance). */
  maxStepReasoningChars?: number
  /** Wall clock from the start of the read, in ms. */
  deadlineMs?: number | null
}

/** How long to keep reading after a budget cancel for the turn to wind down. */
export const CEILING_WIND_DOWN_MS = 10_000

/** The output (text, tool input) or reasoning a streamed delta event carries, in characters; null for any other event. */
function streamedChars(ev: MessageStreamEvent): { stepIndex: number; chars: number; reasoning: boolean } | null {
  if (ev.type === 'message.appended') return { stepIndex: ev.data.stepIndex, chars: ev.data.messageDelta.length, reasoning: false }
  if (ev.type === 'reasoning.appended') return { stepIndex: ev.data.stepIndex, chars: ev.data.reasoningDelta.length, reasoning: true }
  if (ev.type === 'action.input.appended') return { stepIndex: ev.data.stepIndex, chars: ev.data.inputTextDelta.length, reasoning: false }
  return null
}

/**
 * Read a live turn's session to its terminal boundary.
 *
 * Why not `response.result()`: it reads until the STREAM closes, and eve keeps
 * the stream open for seconds after `session.completed` (a live local run on
 * 0.66.3 measured ~8s — run-utility.ts's readToBoundary). eve's own
 * collectTurnEvents breaks at the boundary; so does this.
 *
 * BUDGETS: eve has no step-count stop and no per-call output cap, so the route
 * enforces both here (turn-budget.ts):
 *   - the step ceiling: the ceiling-th step ends asking for more tools
 *     (finishReason 'tool-calls');
 *   - the output budget: one step's streamed output (assistant text, reasoning
 *     and tool input deltas) passes `maxStepOutputChars`, or the turn's passes
 *     `maxTurnOutputChars`. That is a runaway generation, stopped before its
 *     tool call ever runs;
 *   - the deadline: `deadlineMs` after the read started.
 * Whichever comes first, the turn is cancelled (`cancel`) and read for up to
 * CEILING_WIND_DOWN_MS more (to its boundary or its `turn.cancelled`), and
 * reported as `ceiling` with `budgetHit` naming the budget. Every step that
 * completed before the cancel stands (its tools already ran). At the step
 * ceiling the last step's finish reason stays 'tool-calls', exactly what the
 * AI-SDK stopWhen produced.
 *
 * `signal` aborts the read (the caller then decides whether to cancel the
 * session). `onEvent` sees every event as it arrives (the SSE relay).
 */
export async function readLiveTurn(
  response: AsyncIterable<MessageStreamEvent>,
  opts: {
    stepCeiling: number
    cancel: () => Promise<unknown>
    signal?: AbortSignal
    onEvent?: (event: MessageStreamEvent) => void
    budget?: LiveTurnReadBudget
  },
): Promise<LiveTurnRead> {
  const events: MessageStreamEvent[] = []
  let stepsCompleted = 0
  let budgetHit: LiveTurnBudgetHit | undefined
  let windDown: Promise<'wind-down'> | null = null
  let windDownTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let outputChars = 0
  let reasoningChars = 0
  const stepOutputChars = new Map<number, number>()
  const stepReasoningChars = new Map<number, number>()
  const aborted = abortPromise(opts.signal)
  const endsTurn = createTurnBoundary()
  const iterator = response[Symbol.asyncIterator]()
  const budget = opts.budget ?? {}

  // Stop the turn at a budget: cancel it, then give it CEILING_WIND_DOWN_MS to end.
  const hit = (which: LiveTurnBudgetHit) => {
    if (budgetHit) return
    budgetHit = which
    opts.cancel().catch((err) => {
      console.warn(`[live-agent] ${which} budget cancel failed:`, err instanceof Error ? err.message : err)
    })
    windDown = new Promise((resolve) => {
      windDownTimer = setTimeout(() => resolve('wind-down'), CEILING_WIND_DOWN_MS)
    })
  }
  // The deadline fires on its own, while a read may be pending on a silent stream.
  const deadlineMs = budget.deadlineMs ?? 0
  const deadline =
    deadlineMs > 0
      ? new Promise<'deadline'>((resolve) => {
          deadlineTimer = setTimeout(() => resolve('deadline'), deadlineMs)
        })
      : null
  const result = (outcome: LiveTurnOutcome, terminal: boolean): LiveTurnRead => ({
    events,
    outcome,
    stepsCompleted,
    terminal,
    outputChars,
    reasoningChars,
    ...(outcome === 'ceiling' && budgetHit ? { budgetHit } : {}),
  })

  try {
    let pending: Promise<IteratorResult<MessageStreamEvent>> | null = null
    for (;;) {
      // The SAME pending read survives a deadline wake-up: a second next()
      // would lose an event.
      if (!pending) {
        pending = iterator.next()
        // If the abort / wind-down wins the race, this read may still reject
        // later (the aborted stream fetch) — never leave that rejection unhandled.
        pending.catch(() => {})
      }
      const racers: Array<Promise<IteratorResult<MessageStreamEvent> | 'aborted' | 'wind-down' | 'deadline'>> = [
        pending,
        aborted,
      ]
      if (windDown) racers.push(windDown)
      if (deadline && !budgetHit) racers.push(deadline)
      const next = await Promise.race(racers)
      if (next === 'aborted') return result('aborted', false)
      if (next === 'wind-down') return result('ceiling', false)
      if (next === 'deadline') {
        hit('deadline')
        continue
      }
      pending = null
      if (next.done) return result(budgetHit ? 'ceiling' : 'failed', false)

      const ev = next.value
      events.push(ev)
      opts.onEvent?.(ev)

      const streamed = streamedChars(ev)
      if (streamed?.reasoning) {
        reasoningChars += streamed.chars
        const forStep = (stepReasoningChars.get(streamed.stepIndex) ?? 0) + streamed.chars
        stepReasoningChars.set(streamed.stepIndex, forStep)
        if (budget.maxStepReasoningChars !== undefined && forStep > budget.maxStepReasoningChars) hit('step-reasoning')
      } else if (streamed) {
        outputChars += streamed.chars
        const forStep = (stepOutputChars.get(streamed.stepIndex) ?? 0) + streamed.chars
        stepOutputChars.set(streamed.stepIndex, forStep)
        if (budget.maxStepOutputChars !== undefined && forStep > budget.maxStepOutputChars) hit('step-output')
        else if (budget.maxTurnOutputChars !== undefined && outputChars > budget.maxTurnOutputChars) hit('turn-output')
      }

      if (ev.type === 'step.completed') {
        stepsCompleted++
        if (stepsCompleted >= opts.stepCeiling && ev.data.finishReason === 'tool-calls') hit('steps')
      }
      if (budgetHit && ev.type === 'turn.cancelled') return result('ceiling', true)
      if (endsTurn(ev)) {
        // eve 0.67+ parks the session after the turn instead of completing it:
        // the turn's own end says how it went and that nothing is left running.
        const turn = classifyOneShot(ev, events)!
        if (budgetHit) return result('ceiling', turn.turnEnded)
        return result(turn.status, turn.turnEnded)
      }
    }
  } finally {
    clearTimeout(windDownTimer)
    clearTimeout(deadlineTimer)
    // Release the stream (a hung one may never settle — don't await it).
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

/** Resolves 'aborted' when `signal` aborts (never otherwise). */
function abortPromise(signal: AbortSignal | undefined): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
}

/** The failure a failed session reported, for logs. */
export function liveTurnFailure(events: readonly MessageStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'session.failed' || ev.type === 'turn.failed' || ev.type === 'step.failed') {
      return `${ev.type} ${ev.data.code}: ${ev.data.message}`
    }
  }
  return null
}

// ── Streaming to the panel (§9.2) ────────────────────────────────────────────

/** The SSE events the stream relays live (`done` / `error` are the route's). */
export type LiveTurnSseEvent = { type: 'text'; text: string } | { type: 'tool'; tool: string }

/**
 * The tools whose streamed INPUT is typed into the editor, and the key whose
 * value is the text. Only write_summary: the model writes the meeting summary
 * as its `ai_summary` argument, not as assistant prose. update_summary makes
 * SURGICAL edits (a fragment inserted somewhere in the existing summary), so
 * appending its text to the preview would be wrong — its result reaches the
 * editor via Realtime like every other tool's.
 */
const SUMMARY_KEY_FOR: Record<string, string> = {
  write_summary: 'ai_summary',
}

/**
 * A stateful translator from eve events to the panel's SSE contract, unchanged
 * from the AI-SDK relay (use-streaming-extraction.ts reads it):
 *
 *   - assistant text (`message.appended`) is IGNORED — it is the model's
 *     narration, not summary content;
 *   - the first `action.input.appended` of a call announces its tool
 *     ({type:'tool'}); for write_summary the accumulated argument JSON is run
 *     through extractStreamingStringValue and only the NEWLY revealed part of
 *     `ai_summary` is emitted ({type:'text'});
 *   - `actions.requested` is the fallback for calls that streamed no input: a
 *     summary tool with nothing typed yet emits its whole value, any other tool
 *     emits its activity hint (the provider-executed web_search never streams
 *     input, so its hint arrives here).
 *
 * Accumulation is keyed by callId, never one string: two calls can stream their
 * input interleaved in one step, and a single buffer would corrupt both.
 */
export function createLiveTurnSseTranslator(): (event: MessageStreamEvent) => LiveTurnSseEvent[] {
  const calls = new Map<string, { tool: string; argJson: string; emittedLen: number }>()

  return (ev) => {
    const out: LiveTurnSseEvent[] = []
    if (ev.type === 'action.input.appended') {
      const { callId, toolName, inputTextDelta } = ev.data
      let state = calls.get(callId)
      if (!state) {
        state = { tool: toolName, argJson: '', emittedLen: 0 }
        calls.set(callId, state)
        out.push({ type: 'tool', tool: toolName })
      }
      const key = SUMMARY_KEY_FOR[state.tool]
      if (!key) return out // not a summary tool — don't stream its args
      state.argJson += inputTextDelta
      const value = extractStreamingStringValue(state.argJson, key)
      if (value.length > state.emittedLen) {
        out.push({ type: 'text', text: value.slice(state.emittedLen) })
        state.emittedLen = value.length
      }
    } else if (ev.type === 'actions.requested') {
      for (const call of toolCallsOf(ev)) {
        const key = SUMMARY_KEY_FOR[call.toolName]
        const state = calls.get(call.callId)
        if (key && (!state || state.emittedLen === 0)) {
          const val = (call.input as Record<string, unknown> | undefined)?.[key]
          if (typeof val === 'string' && val) {
            out.push({ type: 'text', text: val })
            if (state) state.emittedLen = val.length
          }
        } else if (!key && !state) {
          out.push({ type: 'tool', tool: call.toolName })
        }
      }
    }
    return out
  }
}
