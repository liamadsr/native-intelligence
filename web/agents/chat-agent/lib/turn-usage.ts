/**
 * Pure per-turn usage accumulator for the chat-agent's usage meter
 * (../hooks/usage-meter.ts). The hook folds each usage-relevant stream event
 * into this accumulator (held in durable `defineState`, so it survives the
 * workflow step boundaries a turn crosses), and at the turn's end builds ONE
 * report that POST /api/internal/chat/usage bills.
 *
 * ── Keyed, not additive (a re-run step is counted once) ─────────────────────
 * eve 0.66.3 docs/guides/hooks.md: "if a step is interrupted and re-runs, the
 * turn re-emits its events as new events with new ids, and your hook runs
 * again for each one", and for "a charge" it prescribes keying on the event's
 * coordinates (turnId, stepIndex, sequence), which "a retry restores … from the
 * step's input". So nothing here is summed as events arrive: each
 * `step.completed` is stored under `<sequence>:<stepIndex>` (eve emits exactly
 * one per step — harness/step-hooks.js; stepIndex keeps counting across a steer
 * within a turn — harness/emission.js emitTurnPreamble / advanceStep, and
 * tool-loop.js finishSteeredStep), each requested action under its `callId`,
 * and each Exa cost under its result's `callId`. A re-emitted event overwrites
 * its own slot (the last attempt wins) and the report sums the slots. This does
 * NOT rely on eve discarding hook state on a step re-run (which its docs never
 * promise). An event without coordinates (never emitted by 0.66.3) gets a
 * unique slot, i.e. is counted, never dropped.
 *
 * ── Compaction (a model call with no step.completed) ────────────────────────
 * eve's context compaction MAY call the model directly (harness/compaction.js
 * compactMessages → generateText) OUTSIDE the step loop: no step.completed, and
 * the call's usage is discarded. Its only events are `compaction.requested`
 * {modelId, sequence, turnId, usageInputTokens} and `compaction.completed`
 * {modelId, sequence, turnId}. {@link compactionFromRequested} turns a MANUAL
 * compaction's pair into its own list-priced report; an AUTOMATIC one is not
 * billed (it often makes no model call — see there), only counted for the
 * turn's log line ({@link chatContextLogLine}).
 *
 * MIRRORS mapEveTurnUsage (src/lib/chat/eve-usage.ts) on streams WITHOUT a
 * re-run step — the eve runtime cannot import Next-side modules, so the
 * summation and the cost rule are restated here and pinned by
 * lib/__tests__/turn-usage.test.ts. The one known divergence: a replayed
 * step.completed (same sequence:stepIndex) counts once here and twice there
 * (mapEveTurnUsage is still additive — a follow-up; the divergence is pinned
 * by a test so that change flips it deliberately). The shared rule:
 *   - tokens (input INCLUDES cached; cache read/write tracked separately) and
 *     steps are summed over every `step.completed` of the turn;
 *   - eve 0.66.3's step `costUsd` is the Gateway's BILLED cost — $0 for BYOK
 *     tokens and it INCLUDES a provider-executed web_search's Exa charge. So
 *     the cost is reported only when every token-spending step carried a
 *     positive cost, the sum is > 0, and NO `action.result` carried an Exa
 *     `output.costDollars.total`; otherwise null (the server list-prices the
 *     tokens). The Exa spend is reported as `webSearchCostUsd`.
 *   - the model is the `step.started` modelId — the slug the steps actually ran
 *     on (the resolver's plan-clamped pick), never a client-reported value.
 *
 * Everything here is JSON-serializable (it lives in eve state) and total: a
 * malformed event degrades to "not counted", never a throw.
 */

import { BROWSER_TOOL_NAMES } from './browser-output.js'
import type { ContextParts } from './context-parts.js'

/** How many gateway generation ids a turn keeps (same cap as eve-usage.ts). */
const MAX_GENERATION_IDS = 50
const MAX_BROWSER_COMMAND_IDS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One completed step's usage (the last attempt's, keyed by its coordinates). */
export interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** The step's positive eve cost, else null (BYOK 0 / absent). */
  costUsd: number | null
  generationId: string | null
  /** Browser dispatch retries already included in this step's aggregate usage. */
  generationIds?: string[]
  inputTokensReported?: boolean
  outputTokensReported?: boolean
  /** The step reported a cache-read count (0 included): telemetry tells unknown from zero. */
  cacheReadTokensReported?: boolean
}

export interface TurnUsageAcc {
  /** The turn these slots belong to; null before any turn-scoped event. */
  turnId: string | null
  /** ISO `meta.at` of the first event seen for the turn (duration start). */
  startedAt: string | null
  /** The last step's `step.started` modelId (Gateway slug). */
  modelId: string | null
  /** `<sequence>:<stepIndex>` of the last `step.started` (a compaction's step). */
  lastStepKey: string | null
  /** step.completed usage by `<sequence>:<stepIndex>` (insertion = step order). */
  steps: Record<string, StepUsage>
  /**
   * Gateway generation ids of step attempts a re-run SUPERSEDED (the slot kept
   * only the last attempt). Not billed, but kept so a Gateway /v1/report
   * reconciliation can explain the unmatched generation. Capped.
   */
  superseded?: string[]
  /** Requested tool calls by callId → true when it is a search_tools discovery. */
  calls: Record<string, boolean>
  /** Exa `costDollars.total` by the web_search result's callId. */
  exa: Record<string, number>
  /** IDs returned by owned browser commands, including later-turn waits. */
  browserCommandIds?: string[]
  /**
   * Automatic compactions eve completed inside this turn's steps, by step key
   * (at most one per step). Telemetry only: never billed (see
   * {@link compactionFromRequested}), and a trim-only compaction counts too.
   */
  compactions?: Record<string, true>
  /**
   * eve's pre-compaction input estimate (`compaction.requested`
   * usageInputTokens) of each automatic compaction requested inside this
   * turn's steps, by step key. Telemetry only.
   */
  compactionInputs?: Record<string, number>
  /** Counter for the unique slot of an event that carries no coordinates. */
  anon: number
}

/** A compaction to bill, captured at `compaction.requested`. */
export interface CompactionUsage {
  turnId: string
  /** The Gateway slug eve summarized with (the turn model unless overridden). */
  modelId: string | null
  /** eve's pre-compaction context estimate (usageInputTokens). */
  inputTokens: number
  /** Only manual compactions are billed (see {@link compactionFromRequested}). */
  trigger: 'manual'
  /** Key suffix for this occurrence (see {@link compactionFromRequested}). */
  id: string
  /** ISO `meta.at` of the request (duration start). */
  startedAt: string | null
}

/** What the meter posts for one finished turn (the route's ChatTurnUsageReport). */
export interface TurnUsageReport {
  sessionId: string
  turnId: string
  outcome: 'completed' | 'failed' | 'cancelled'
  modelId: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
  webSearchCostUsd: number | null
  steps: number
  toolCalls: number
  toolDiscoveries: number
  generationIds: string[]
  /** Generation ids of superseded step attempts (not billed; reconciliation only). */
  supersededGenerationIds?: string[]
  durationMs: number
  firstEventAt?: string | null
  terminalAt?: string | null
  inputTokensReported?: boolean
  outputTokensReported?: boolean
  browserCommandIds?: string[]
  /** Set on a compaction report (its own key and metadata on the route). */
  compaction: { trigger: 'automatic' | 'manual'; id: string } | null
  /** Tokens the `cards` turn-context section cost this turn (0 when not sent); absent when unmeasured. */
  cardContextTokens?: number
  /**
   * The agent's own parts of the turn's context, estimated (lib/context-parts.ts):
   * the system prompt, its skills section, the tools advertised to the last
   * model call, the recalled memory. Absent when the turn's prompt was not measured.
   */
  contextParts?: ContextParts
  /**
   * The parent eve session when this turn ran in a quick helper's child
   * session (A4 slice 3: ctx.session.parent.sessionId), so a conversation's
   * cost includes its helpers. Absent on the main chat's own turns.
   */
  helperOf?: string
  /**
   * How big the context was, per model call: the first, last and largest
   * step's input (each the call's whole input, cached included). `inputTokens`
   * above is SUMMED over the steps, so it is not a context size (a 6-step turn
   * at 130K bills ~780K). `last` is what the next turn starts from, and what
   * compaction decides on (lib/compaction-window.ts). Absent when no step
   * reported an input.
   */
  contextTokens?: ContextTokens
  /**
   * eve's automatic compactions inside this turn, in step order: `before` is
   * eve's estimate when it was requested, `after` the same step's input once
   * its model call ran on the compacted history (null when that step reported
   * none). Absent when there were none.
   */
  autoCompactions?: AutoCompaction[]
  /**
   * How the turn's model was chosen (the spec's `modelRoute`, auto model
   * selection), for ai_usage_logs.metadata.model_route. Absent when the spec
   * carried none.
   */
  modelRoute?: ReportedModelRoute
}

/** A turn's context size per model call (see TurnUsageReport.contextTokens). */
export interface ContextTokens {
  first: number
  last: number
  peak: number
}

/** One automatic compaction's context, before and after (see TurnUsageReport.autoCompactions). */
export interface AutoCompaction {
  before: number | null
  after: number | null
}

/** A turn's model route as it rides the report (src/lib/ai/model-route.ts ModelRoute). */
export type ReportedModelRoute = { tier: string; by: string; signals: string[]; reasoning?: string; model?: string }

/**
 * A spec's `modelRoute`, shape-guarded for the report: a known tier and
 * decider, short rule names, nothing else. Null when it is not one. The usage
 * route checks it again (parseModelRoute).
 */
export function validModelRoute(v: unknown): ReportedModelRoute | null {
  const r = rec(v)
  if (!r) return null
  if (typeof r.tier !== 'string' || !['fast', 'think', 'strong'].includes(r.tier)) return null
  if (typeof r.by !== 'string' || !['rule', 'jev', 'timeout', 'cap', 'fixed', 'agent'].includes(r.by)) return null
  const signals = Array.isArray(r.signals)
    ? r.signals.filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(x)).slice(0, 12)
    : []
  const reasoning = typeof r.reasoning === 'string' && /^[a-z-]{1,16}$/.test(r.reasoning) ? r.reasoning : undefined
  // A helper's roster key (HELPER_MODEL_KEYS); the usage route checks it against the roster.
  const model = typeof r.model === 'string' && /^[a-z][a-z0-9-]{0,19}$/.test(r.model) ? r.model : undefined
  return { tier: r.tier, by: r.by, signals, ...(reasoning ? { reasoning } : {}), ...(model ? { model } : {}) }
}

/**
 * The Gateway slug a step or compaction ran on, from eve's `modelId`. eve
 * names a live LanguageModel selection that carries an explicit context window
 * `${provider}/${modelId}` (runtime/agent/resolve-model.js, eve 0.79), so the
 * browser-dispatch model, a Gateway model (provider `gateway`), reports
 * `gateway/deepseek/deepseek-v4-flash`. Billing keys on the slug.
 */
export function gatewaySlugOf(modelId: string): string {
  return modelId.startsWith('gateway/') ? modelId.slice('gateway/'.length) : modelId
}

export function emptyTurnUsage(turnId: string | null = null, startedAt: string | null = null): TurnUsageAcc {
  return { turnId, startedAt, modelId: null, lastStepKey: null, steps: {}, superseded: [], calls: {}, exa: {}, anon: 0 }
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const reportedCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/** The event's ISO `meta.at`, or null. */
function atOf(event: unknown): string | null {
  const at = rec(rec(event)?.meta)?.at
  return typeof at === 'string' ? at : null
}

/** The turn id an event carries (`data.turnId`), or null. */
function turnIdOf(event: unknown): string | null {
  const t = rec(rec(event)?.data)?.turnId
  return typeof t === 'string' && t.length > 0 ? t : null
}

/** `<sequence>:<stepIndex>` from an event's data, or null when either is missing. */
function stepKeyOf(data: Rec): string | null {
  const seq = intOrNull(data.sequence)
  const step = intOrNull(data.stepIndex)
  return seq === null || step === null ? null : `${seq}:${step}`
}

/**
 * Exa `costDollars.total` on an `action.result` (matched by shape, like
 * eve-usage.ts), or null. Only a POSITIVE total counts: a zero / negative /
 * non-finite value is not Exa spend, and a negative one would make the report
 * invalid (the route rejects a negative webSearchCostUsd) and void the whole
 * turn's token bill.
 */
export function exaCostOfResult(data: unknown): number | null {
  const total = num(rec(rec(rec(rec(data)?.result)?.output)?.costDollars)?.total)
  return total > 0 ? total : null
}

/** A tool call's name across eve's action shapes. */
function actionName(a: unknown): unknown {
  const r = rec(a)
  return r?.toolName ?? r?.name ?? rec(r?.tool)?.name
}

/**
 * The model wrapper sums known retry usage into the final finish event. Keep
 * its generation identities for reconciliation, but NEVER add the attempt
 * counts again. An aborted attempt without terminal usage makes the aggregate
 * incomplete even when the successful retry reports every token it spent.
 */
function browserDispatchUsage(metadata: unknown): { generationIds: string[]; complete: boolean } | null {
  const dispatch = rec(rec(metadata)?.browserDispatch)
  if (dispatch?.version !== 1) return null
  const attempts = Array.isArray(dispatch.attempts) ? dispatch.attempts : []
  const bounded = attempts.slice(0, 2)
  return {
    generationIds: [...new Set(bounded.flatMap(value => {
      const id = rec(value)?.generationId
      return typeof id === 'string' && id.trim().length > 0 && id.trim().length <= 200 ? [id.trim()] : []
    }))],
    complete: dispatch.usageUnknown === false && attempts.length > 0 && attempts.length <= 2 && bounded.every(value => {
      const attempt = rec(value)
      return attempt?.usageKnown === true && reportedCount(attempt.inputTokens) && reportedCount(attempt.outputTokens)
    }),
  }
}

function stepGenerationIds(step: StepUsage | undefined): string[] {
  return step?.generationIds ?? (step?.generationId ? [step.generationId] : [])
}

/**
 * Fold one stream event into the accumulator. `turn.started` opens a fresh
 * turn; any turn-scoped event for a DIFFERENT turn than the accumulator's also
 * starts fresh (a meter that missed turn.started — e.g. deployed mid-turn —
 * still meters what it sees). Events without a turn id are ignored. A replayed
 * event overwrites its own slot (see the module doc).
 */
export function foldTurnUsageEvent(acc: TurnUsageAcc, event: unknown): TurnUsageAcc {
  const e = rec(event)
  if (!e) return acc
  const type = e.type
  const turnId = turnIdOf(event)
  if (!turnId) return acc
  if (type === 'turn.started') return emptyTurnUsage(turnId, atOf(event))
  if (type === 'compaction.requested' || type === 'compaction.completed') {
    return foldCompaction(acc, turnId, type, rec(e.data) ?? {})
  }
  if (type !== 'step.started' && type !== 'step.completed' && type !== 'actions.requested' && type !== 'action.result') {
    return acc
  }
  const base = acc.turnId === turnId ? acc : emptyTurnUsage(turnId, atOf(event))
  const next: TurnUsageAcc = {
    ...base,
    steps: { ...base.steps },
    superseded: [...(base.superseded ?? [])],
    calls: { ...base.calls },
    exa: { ...base.exa },
    browserCommandIds: [...(base.browserCommandIds ?? [])],
  }
  const data = rec(e.data) ?? {}
  const slot = (key: string | null, suffix = ''): string => {
    if (key) return `${key}${suffix}`
    next.anon += 1
    return `anon:${next.anon}`
  }

  if (type === 'step.started') {
    if (typeof data.modelId === 'string' && data.modelId) next.modelId = gatewaySlugOf(data.modelId)
    next.lastStepKey = stepKeyOf(data)
  } else if (type === 'step.completed') {
    const u = rec(data.usage)
    const cost = u?.costUsd
    const gid = rec(rec(data.providerMetadata)?.gateway)?.generationId
    const key = slot(stepKeyOf(data))
    const generationId = typeof gid === 'string' && gid.trim() ? gid.trim() : null
    const dispatch = browserDispatchUsage(data.providerMetadata)
    const generationIds = [...new Set([...(dispatch?.generationIds ?? []), ...(generationId ? [generationId] : [])])]
    for (const prior of stepGenerationIds(next.steps[key])) {
      if (!generationIds.includes(prior) && !next.superseded!.includes(prior) && next.superseded!.length < MAX_GENERATION_IDS) {
        next.superseded!.push(prior)
      }
    }
    next.steps[key] = {
      inputTokens: num(u?.inputTokens),
      outputTokens: num(u?.outputTokens),
      cacheReadTokens: num(u?.cacheReadTokens),
      cacheWriteTokens: num(u?.cacheWriteTokens),
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : null,
      generationId,
      ...(dispatch ? { generationIds } : {}),
      inputTokensReported: reportedCount(u?.inputTokens) && dispatch?.complete !== false,
      outputTokensReported: reportedCount(u?.outputTokens) && dispatch?.complete !== false,
      ...(reportedCount(u?.cacheReadTokens) ? { cacheReadTokensReported: true } : {}),
    }
  } else if (type === 'actions.requested') {
    const actions = Array.isArray(data.actions) ? data.actions : []
    const stepKey = stepKeyOf(data)
    actions.forEach((a, i) => {
      const callId = rec(a)?.callId
      const key = typeof callId === 'string' && callId ? `call:${callId}` : stepKey ? `${stepKey}:${i}` : null
      next.calls[slot(key)] = actionName(a) === 'search_tools'
    })
  } else {
    // Only our browser tool's completed result envelope can assert this link.
    // Never collect run_id from actions.requested (model input), page content,
    // or unrelated tools. A completed invocation can report a failed task.
    const result = rec(data.result)
    const commandId = rec(result?.output)?.browser_command_id
    const name = actionName(result)
    if (data.status === 'completed' && result?.kind === 'tool-result' && typeof name === 'string' && BROWSER_TOOL_NAMES.has(name) &&
        typeof commandId === 'string' && UUID.test(commandId) && next.browserCommandIds!.length < MAX_BROWSER_COMMAND_IDS &&
        !next.browserCommandIds!.includes(commandId.toLowerCase())) {
      next.browserCommandIds!.push(commandId.toLowerCase())
    }
    const exa = exaCostOfResult(data)
    if (exa !== null) {
      const callId = result?.callId
      next.exa[slot(typeof callId === 'string' && callId ? `call:${callId}` : stepKeyOf(data))] = exa
    }
  }
  return next
}

/**
 * Note an automatic compaction: one inside a step of the accumulator's turn
 * (the same in-step test as compactionFromRequested). `compaction.requested`
 * keeps eve's input estimate, `compaction.completed` counts it. A manual one
 * (between turns) or one for another turn leaves the accumulator as it is.
 */
function foldCompaction(acc: TurnUsageAcc, turnId: string, type: string, data: Rec): TurnUsageAcc {
  const seq = intOrNull(data.sequence)
  const key = acc.lastStepKey
  if (acc.turnId !== turnId || key === null || seq === null || !key.startsWith(`${seq}:`)) return acc
  if (type === 'compaction.requested') {
    return { ...acc, compactionInputs: { ...acc.compactionInputs, [key]: Math.floor(num(data.usageInputTokens)) } }
  }
  return { ...acc, compactions: { ...acc.compactions, [key]: true } }
}

/**
 * The report for a finished turn, or null when there is nothing to bill (no
 * completed step and no tokens) or the accumulator holds a different turn.
 * Sums the keyed slots under the cost rule (module doc of eve-usage.ts).
 */
export function buildTurnUsageReport(
  acc: TurnUsageAcc,
  end: { sessionId: string; turnId: string; outcome: TurnUsageReport['outcome']; endedAt: string | null },
): TurnUsageReport | null {
  if (acc.turnId !== end.turnId) return null
  const steps = Object.values(acc.steps)
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let costSum = 0
  let sawCost = false
  let uncostedStep = false
  const generationIds: string[] = []
  for (const s of steps) {
    inputTokens += s.inputTokens
    outputTokens += s.outputTokens
    cacheReadTokens += s.cacheReadTokens
    cacheWriteTokens += s.cacheWriteTokens
    if (s.costUsd !== null) {
      costSum += s.costUsd
      sawCost = true
    } else if (s.inputTokens + s.outputTokens > 0) {
      uncostedStep = true
    }
    for (const id of stepGenerationIds(s)) {
      if (generationIds.length < MAX_GENERATION_IDS && !generationIds.includes(id)) generationIds.push(id)
    }
  }
  if (steps.length === 0 && inputTokens === 0 && outputTokens === 0) return null
  const exa = Object.values(acc.exa)
  const webSearchCostUsd = exa.length > 0 ? exa.reduce((a, b) => a + b, 0) : null
  const costUsd = sawCost && !uncostedStep && costSum > 0 && webSearchCostUsd === null ? costSum : null
  const calls = Object.values(acc.calls)
  const superseded = (acc.superseded ?? []).filter((g) => !generationIds.includes(g))
  const contextTokens = contextTokensOf(acc)
  const autoCompactions = autoCompactionsOf(acc)
  return {
    sessionId: end.sessionId,
    turnId: end.turnId,
    outcome: end.outcome,
    modelId: acc.modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    webSearchCostUsd,
    steps: steps.length,
    toolCalls: calls.length,
    toolDiscoveries: calls.filter(Boolean).length,
    generationIds,
    ...(superseded.length > 0 ? { supersededGenerationIds: superseded } : {}),
    durationMs: durationBetween(acc.startedAt, end.endedAt),
    firstEventAt: acc.startedAt,
    terminalAt: end.endedAt,
    inputTokensReported: steps.every((s) => s.inputTokensReported === true),
    outputTokensReported: steps.every((s) => s.outputTokensReported === true),
    ...(acc.browserCommandIds?.length ? { browserCommandIds: acc.browserCommandIds } : {}),
    compaction: null,
    ...(contextTokens ? { contextTokens } : {}),
    ...(autoCompactions.length > 0 ? { autoCompactions } : {}),
  }
}

/**
 * The context size per model call, from the steps in order (insertion order
 * is step order): the first, last and largest input. A step that reported no
 * input (a local browser handoff, a provider that sent none) is skipped. null
 * with none.
 */
export function contextTokensOf(acc: TurnUsageAcc): ContextTokens | null {
  const inputs = Object.values(acc.steps)
    .map((s) => s.inputTokens)
    .filter((n) => n > 0)
  if (inputs.length === 0) return null
  return { first: inputs[0], last: inputs[inputs.length - 1], peak: Math.max(...inputs) }
}

/**
 * The automatic compactions eve completed in this turn, in step order: eve's
 * estimate at the request, then the same step's input (eve compacts after a
 * step's `step.started` and before its model call, so that call already read
 * the compacted history).
 */
export function autoCompactionsOf(acc: TurnUsageAcc): AutoCompaction[] {
  return Object.keys(acc.compactions ?? {}).map((key) => {
    const before = acc.compactionInputs?.[key]
    const after = acc.steps[key]?.inputTokens
    return { before: before && before > 0 ? before : null, after: after && after > 0 ? after : null }
  })
}

function durationBetween(startedAt: string | null, endedAt: string | null): number {
  const start = startedAt ? Date.parse(startedAt) : NaN
  const stop = endedAt ? Date.parse(endedAt) : NaN
  return Number.isFinite(start) && Number.isFinite(stop) && stop >= start ? stop - start : 0
}

/**
 * Capture a MANUAL `compaction.requested` for billing, or null when it is
 * automatic, malformed, or estimates no input.
 *
 * TRIGGER (eve 0.79.1). An AUTOMATIC compaction runs inside a step, after
 * that step's `step.started` and before its model call
 * (harness/model-call/call.js → harness/compaction/step.js maybeCompact).
 * A MANUAL one (POST /session/:id/compact; compactHistory, `force`) runs
 * between turns under the NEXT turn's id (`turn_<sequence>`) with no step of
 * its own.
 *
 * ONLY MANUAL IS BILLED. maybeCompact emits the requested/completed pair for
 * an automatic compaction that makes NO model call: engine.js compactMessages
 * returns without a summary call when there is nothing older to summarize, or
 * when toolResultCapHeuristic's trim of old tool results is enough
 * ('within-limit', common for this tool-heavy agent), and maybeCompact also
 * emits the pair when only memory canonicalization runs (no compaction at
 * all). The compaction EVENTS still can't tell these apart from a real
 * summarization (compaction.completed carries only `modelId`), and
 * usageInputTokens is the WHOLE pre-compaction context, so billing them from
 * the events would charge a context window's worth of list-priced input for a
 * trim that cost nothing. A MANUAL one always calls the model: `force` skips
 * the heuristics and the early return, and an empty summary throws before
 * completed.
 *
 * KEY. Several manual compactions can share the next turn's id, so each is
 * keyed by the request event's `meta.id` (a re-run of that control step
 * re-calls the model, so a second row there is real spend).
 *
 * ESTIMATE. What is billed today: the input is eve's own "best available
 * input-token count" for the context being compacted (engine.js
 * getInputTokenCount → usageInputTokens); a forced compaction summarizes all
 * but the last message, so this is a close upper bound, and the output is not
 * billed. The route list-prices it and marks the row usageEstimated.
 *
 * WHAT eve 0.79.1 ALREADY REPORTS (billing has not caught up: a follow-up).
 * Since 0.75.1 the summary call's provider usage is ADDED to the session's
 * running total: maybeCompact collects each summary call's usage and adds it
 * with harness/turn-tag-state.js addTurnUsage (automatic, to the turn it ran
 * in) or addUsageOutsideTurns (manual, between turns). That total is the
 * `usage` on `turn.waiting` / `session.waiting` (docs/concepts/
 * sessions-runs-and-streaming.md still says compaction calls are left out; the
 * code adds them). So billing could use the real numbers: the session total
 * after a manual compaction's `session.waiting` minus the total before it is
 * that summary's tokens and cost; for an automatic one, the turn's total minus
 * the sum of its steps' usage, which is also the "did it call the model" flag
 * (zero for a trim). Not done here: billing is unchanged in P11.
 */
export function compactionFromRequested(acc: TurnUsageAcc, event: unknown): CompactionUsage | null {
  const e = rec(event)
  if (!e || e.type !== 'compaction.requested') return null
  const turnId = turnIdOf(event)
  const data = rec(e.data) ?? {}
  const inputTokens = Math.floor(num(data.usageInputTokens))
  if (!turnId || inputTokens <= 0) return null
  const seq = intOrNull(data.sequence)
  const inStep =
    acc.turnId === turnId && acc.lastStepKey !== null && seq !== null && acc.lastStepKey.startsWith(`${seq}:`)
  // Automatic (inside a step): possibly no model call — not billed (see above).
  if (inStep) return null
  const metaId = rec(e.meta)?.id
  const id = typeof metaId === 'string' && metaId ? `m${metaId}` : null
  if (!id || !/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) return null
  return {
    turnId,
    modelId: typeof data.modelId === 'string' && data.modelId ? gatewaySlugOf(data.modelId) : null,
    inputTokens,
    trigger: 'manual',
    id,
    startedAt: atOf(event),
  }
}

/**
 * The report for a compaction whose `compaction.completed` arrived (a failed
 * summary emits none, and bills nothing). null when `completed` is for a
 * different turn than the captured request.
 */
export function buildCompactionReport(
  c: CompactionUsage,
  end: { sessionId: string; turnId: string | null; endedAt: string | null },
): TurnUsageReport | null {
  if (end.turnId !== c.turnId) return null
  return {
    sessionId: end.sessionId,
    turnId: c.turnId,
    outcome: 'completed',
    modelId: c.modelId,
    inputTokens: c.inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    webSearchCostUsd: null,
    steps: 1,
    toolCalls: 0,
    toolDiscoveries: 0,
    generationIds: [],
    durationMs: durationBetween(c.startedAt, end.endedAt),
    firstEventAt: c.startedAt,
    terminalAt: end.endedAt,
    inputTokensReported: false,
    outputTokensReported: false,
    compaction: { trigger: c.trigger, id: c.id },
  }
}

/**
 * One server log line per settled report, so prompt-cache hits and context
 * size are visible per turn:
 *   [chat-context] session=… turn=… model=… outcome=completed steps=3 input=41200 cached=38900 hit=0.94 written=0 first=12100 last=14800 peak=14800 output=820 compactions=1 compactedInput=181000 compacted=181000>52000
 * `input` includes `cached` (the AI SDK's total input, summed over the steps);
 * `hit` is cached/input. Both read `-` when no step reported a cache-read
 * count (unknown, not zero), and `hit` also with no input. `first`, `last` and
 * `peak` are single steps' inputs: how big the context was (the same figures
 * the usage row keeps, contextTokensOf). `compactions` counts eve's automatic
 * compactions in the turn (trim-only ones included); `compactedInput` sums
 * eve's input estimate when each was requested, and `compacted` lists each as
 * before>after (`-` for an unknown side). A manual compaction's report logs as
 * `compaction=manual` with eve's input estimate. Counts and ids only: no
 * prompt text, no tool input, no user data.
 */
export function chatContextLogLine(report: TurnUsageReport, acc: TurnUsageAcc | null): string {
  const head = `[chat-context] session=${report.sessionId} turn=${report.turnId} model=${report.modelId ?? 'unknown'}`
  if (report.compaction) return `${head} compaction=${report.compaction.trigger} estimatedInput=${report.inputTokens}`
  const own = acc?.turnId === report.turnId ? acc : null
  const steps = own ? Object.values(own.steps) : []
  const context = own ? contextTokensOf(own) : null
  const done = own ? Object.keys(own.compactions ?? {}) : []
  const compactedInput = done.reduce((sum, key) => sum + (own?.compactionInputs?.[key] ?? 0), 0)
  const compacted = own ? autoCompactionsOf(own).map((c) => `${c.before ?? '-'}>${c.after ?? '-'}`) : []
  const cacheKnown = steps.some((s) => s.cacheReadTokensReported === true)
  return [
    head,
    `outcome=${report.outcome}`,
    `steps=${report.steps}`,
    `input=${report.inputTokens}`,
    `cached=${cacheKnown ? report.cacheReadTokens : '-'}`,
    `hit=${cacheKnown ? cacheHitRate(report.inputTokens, report.cacheReadTokens) : '-'}`,
    `written=${report.cacheWriteTokens}`,
    `first=${context?.first ?? 0}`,
    `last=${context?.last ?? 0}`,
    `peak=${context?.peak ?? 0}`,
    `output=${report.outputTokens}`,
    `compactions=${done.length}`,
    `compactedInput=${compactedInput}`,
    ...(compacted.length > 0 ? [`compacted=${compacted.join(',')}`] : []),
  ].join(' ')
}

/** cached / input to two places (capped at 1), or `-` with no input. */
export function cacheHitRate(inputTokens: number, cacheReadTokens: number): string {
  if (!(inputTokens > 0)) return '-'
  return Math.min(1, Math.max(0, cacheReadTokens) / inputTokens).toFixed(2)
}
