/**
 * Server-side usage metering for eve main-chat turns (WS-5a).
 *
 * The chat-agent's usage-meter hook (agents/chat-agent/hooks/usage-meter.ts)
 * sums each finished turn's `step.completed` usage INSIDE the eve runtime and
 * posts it to POST /api/internal/chat/usage (internal secret, plus the turn's
 * chat-run token when it has one). This module is that route's logic: validate
 * the report, resolve who pays, and bill it EXACTLY ONCE per turn.
 *
 * Before this, eve chat was billed from the BROWSER: the transport posted the
 * turn's events + model to /api/account/chat/eve-persist and the server billed
 * whatever the client said. A client could under-report its own bill, and the
 * cost it relayed could be Exa-contaminated. persistEveTurn no longer bills.
 *
 * ── Trust ───────────────────────────────────────────────────────────────────
 * The numbers come from our own eve runtime (the internal-secret holder), never
 * a browser. WHO PAYS is never taken from the body: it is the user of a chat-run
 * token whose HMAC verifies (expiry ignored — attribution, not admission), or —
 * when the token is absent or unverifiable — the OWNER of the eve session (chat_conversations.eve_session_id, the same record
 * the channel's ownership ACL uses). So whether a turn is billed no longer
 * depends on what header the browser sent. The cost rule is re-applied here
 * (defense in depth): eve's cost is kept only when it is > 0 and the turn
 * carried no Exa spend (eve-usage.ts, the rule of record) — otherwise costUsd is
 * omitted and log_ai_usage list-prices the tokens.
 *
 * ── Once per turn ───────────────────────────────────────────────────────────
 * eve hooks are at-least-once, and the hook re-sends a report whose POST failed
 * at a later turn's end. So the row is billed through logUsage's
 * `idempotencyKey` = `ai_chat:<eveSessionId>:<turnId>` (eve turn ids restart per
 * session; session ids are unique): log_ai_usage_once (migration 278) claims the
 * key and bills in ONE transaction, so a replay bills nothing and a failed bill
 * leaves no claim behind. If the bill is lost outright (RPC failed AND the
 * durable retry could not be queued) this throws, the route answers 500, and the
 * hook re-sends — the claim rolled back with the failed bill, so it can land.
 *
 * ── Compaction + the outbox ─────────────────────────────────────────────────
 * A report with `compaction` set bills eve's context-compaction model call
 * (which emits no step.completed) under `…:<turnId>:compaction:<id>`, from
 * eve's input estimate, list-priced and flagged usageEstimated. A report the
 * hook could not deliver reaches this same logic through the outbox sweep
 * (src/lib/inngest/chat-usage-outbox.ts) under the same key.
 *
 * Feature 'ai_chat' and existing metadata (toolCalls, steps, toolDiscoveries,
 * runtime, generationIds) retain the persist path's meaning. Server-authored
 * attribution links a parent turn to browser commands without adding bills;
 * timing boundaries and reported-usage flags distinguish observations from
 * unknown spend and catalog estimates.
 * Added only when present: webSearchCostUsd (as on the live-agent and device
 * rows) and the cache keys cache_read_input_tokens / cache_creation_input_tokens
 * (as liveTurnCacheMetadata sends them), which log_ai_usage reads to list-price
 * a cached Claude turn's cached input at the cache rates instead of full input.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logUsage } from '@/lib/ai/auth'
import { DEFAULT_MODEL, MAIN_MODEL, appModelIdFromGatewaySlug, usageProviderLabel } from '@/lib/ai/models'
import { parseModelRoute, type ModelRoute } from '@/lib/ai/model-route'
import { TURN_REPORT_TOKEN_GRACE_MS, verifyChatRunToken } from '@/lib/chat/chat-run-token'
import { chatParentRunId } from '@/lib/browser-agent/attribution'
import { planModelOfStep, planModelSlug } from '@/lib/chatgpt/plan-models'

/** The feature key eve chat rows bill under (unchanged from the persist path). */
export const CHAT_USAGE_FEATURE = 'ai_chat'

/** The usage route's 401 code for a rejected internal secret (the hook keeps the report). */
export const INTERNAL_SECRET_REJECTED = 'INTERNAL_SECRET_REJECTED'
/** The usage route's 409 code for a token-less report whose session no conversation owns yet. */
export const SESSION_UNREGISTERED = 'SESSION_UNREGISTERED'

/** Max gateway generation ids retained per row (same cap as eve-usage.ts). */
const MAX_GENERATION_IDS = 50
/** Upper bound on an id we accept in the key (eve ids are short). */
const MAX_ID_LENGTH = 200

/** One finished eve turn's usage, as the chat-agent's usage meter reports it. */
export interface ChatTurnUsageReport {
  /** The eve session id (turn ids restart per session). */
  sessionId: string
  /** The eve turn id (`turn_<n>`). */
  turnId: string
  /** How the turn ended — all three spent tokens on their completed steps. */
  outcome: 'completed' | 'failed' | 'cancelled'
  /** The Gateway slug the steps ran on (step.started modelId), null if unseen. */
  modelId: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** eve's summed cost when the runtime's rule trusted it, else null. */
  costUsd: number | null
  /** Exa spend from web_search results this turn, null when none. */
  webSearchCostUsd: number | null
  steps: number
  toolCalls: number
  toolDiscoveries: number
  generationIds: string[]
  /**
   * Generation ids of step attempts an eve re-run superseded (the report bills
   * only each step's last attempt). Not billed; kept in metadata so a Gateway
   * /v1/report reconciliation can explain the unmatched generation.
   */
  supersededGenerationIds?: string[]
  durationMs: number
  /** Runtime event boundaries; these do not measure browser prompt-to-render. */
  firstEventAt?: string | null
  terminalAt?: string | null
  /** Absent on older reports; never interpret normalized zeroes as known usage. */
  inputTokensReported?: boolean
  outputTokensReported?: boolean
  browserCommandIds?: string[]
  /**
   * Set when this report is a CONTEXT COMPACTION, not a turn's steps: eve's
   * summarization model call, which emits no step.completed (see
   * agents/chat-agent/lib/turn-usage.ts). null / absent for a turn report.
   */
  compaction: ChatCompactionRef | null
  /**
   * Tokens the `cards` turn-context section cost this turn, 0 when the diff
   * left it out (docs/plans/one-agent-and-chat-pages.md: measured). Metadata
   * only; absent from a runtime that does not measure it.
   */
  cardContextTokens?: number
  /**
   * The agent's own parts of the turn's context, estimated
   * (agents/chat-agent/lib/context-parts.ts): its system prompt, the skills
   * section, the tools advertised to the last model call, the recalled
   * memory. Metadata only (`context_parts`): what the side panel's Context
   * card shows beside the conversation (src/lib/chat/context-usage.ts).
   */
  contextParts?: ChatContextParts
  /**
   * The parent eve session when the turn ran in a quick helper's child session
   * (A4 slice 3, agents/chat-agent/hooks/usage-meter.ts helperOfSession).
   * Metadata only (`helper_of`): who pays still comes from the token.
   */
  helperOf?: string
  /**
   * How the turn's model was chosen (auto model selection: the spec's
   * modelRoute, as the agent kept it). Metadata only (`model_route`).
   */
  modelRoute?: ModelRoute
  /**
   * The context size per model call: the first, last and largest step's input
   * (agents/chat-agent/lib/turn-usage.ts contextTokensOf). `inputTokens` is
   * summed over the steps, so it is not a context size. Metadata only
   * (`context_*_step_input_tokens`): what compaction decides on.
   */
  contextTokens?: { first: number; last: number; peak: number }
  /**
   * eve's automatic compactions in the turn, before and after (eve's estimate
   * at the request, the same step's input after). Metadata only
   * (`auto_compactions`).
   */
  autoCompactions?: Array<{ before: number | null; after: number | null }>
}

/** The agent's own parts of a turn's context, in tokens (ChatTurnUsageReport.contextParts). */
export interface ChatContextParts {
  system: number
  skills: number
  tools: number
  memory: number
}

/** The context parts, or null when absent or malformed (metadata only: never a reason to refuse). */
function parseContextParts(v: unknown): ChatContextParts | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const system = count(c.system)
  const skills = count(c.skills)
  const tools = count(c.tools)
  const memory = count(c.memory)
  if (system === null || skills === null || tools === null || memory === null) return null
  return { system, skills, tools, memory }
}

/** How many automatic compactions a turn row records, at most (eve runs at most one per step). */
const MAX_AUTO_COMPACTIONS = 20

/** The context sizes, or null when absent or malformed (metadata only: never a reason to refuse). */
function parseContextTokens(v: unknown): ChatTurnUsageReport['contextTokens'] | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const first = count(c.first)
  const last = count(c.last)
  const peak = count(c.peak)
  if (first === null || last === null || peak === null || peak < first || peak < last) return null
  return { first, last, peak }
}

/** The automatic compactions, capped; a malformed entry is dropped. */
function parseAutoCompactions(v: unknown): NonNullable<ChatTurnUsageReport['autoCompactions']> {
  if (!Array.isArray(v)) return []
  const side = (n: unknown): number | null | undefined => (n === null ? null : (count(n) ?? undefined))
  const out: NonNullable<ChatTurnUsageReport['autoCompactions']> = []
  for (const entry of v.slice(0, MAX_AUTO_COMPACTIONS)) {
    if (!entry || typeof entry !== 'object') continue
    const before = side((entry as Record<string, unknown>).before)
    const after = side((entry as Record<string, unknown>).after)
    if (before === undefined || after === undefined) continue
    out.push({ before, after })
  }
  return out
}

/**
 * Which compaction a report bills. `trigger`: 'automatic' (eve compacted inside
 * a step as the context filled) or 'manual' (POST /session/:id/compact).
 * `id`: the occurrence's key suffix, stable across a hook replay.
 */
export interface ChatCompactionRef {
  trigger: 'automatic' | 'manual'
  id: string
}

/** A compaction occurrence id: short, key-safe. */
const COMPACTION_ID = /^[A-Za-z0-9_.:-]{1,120}$/

function parseCompaction(v: unknown): ChatCompactionRef | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') return undefined
  const c = v as Record<string, unknown>
  if (c.trigger !== 'automatic' && c.trigger !== 'manual') return undefined
  if (typeof c.id !== 'string' || !COMPACTION_ID.test(c.id)) return undefined
  return { trigger: c.trigger, id: c.id }
}

export type MeterChatTurnResult =
  | { billed: true }
  | { billed: false; reason: 'empty' | 'duplicate' }

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH
}

/** A finite, non-negative number, floored to an integer when `int`. */
function count(v: unknown, int = true): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return int ? Math.floor(v) : v
}

/** null / absent → null; otherwise a finite non-negative number or invalid. */
function nullableCost(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null
  return count(v, false) ?? undefined
}

/** Short ids from an array (deduped, capped); anything else → []. */
function idList(v: unknown): string[] {
  const ids = Array.isArray(v) ? v : []
  return [...new Set(ids.filter((g): g is string => isId(g)))].slice(0, MAX_GENERATION_IDS)
}

function eventTimestamp(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null
}

/**
 * Parse + validate a usage report body. Every token / step count must be
 * finite and non-negative; ids must be short non-empty strings. A malformed
 * body is a 400 (never billed on a guess).
 *
 * The two DOLLAR fields are the exception — neither can void the bill: an
 * invalid `costUsd` becomes null (the tokens are list-priced), and an invalid
 * `webSearchCostUsd` becomes null AND forces costUsd to null (something
 * Exa-shaped was present, so eve's cost may include it — the Exa rule). A
 * report is never rejected over a figure that only chooses the pricing path
 * or rides metadata: rejecting it would drop the turn's whole token bill.
 */
export function parseChatTurnUsageReport(
  raw: unknown,
): { ok: true; report: ChatTurnUsageReport } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid body' }
  const b = raw as Record<string, unknown>
  if (!isId(b.sessionId)) return { ok: false, error: 'missing sessionId' }
  if (!isId(b.turnId)) return { ok: false, error: 'missing turnId' }
  const outcome = b.outcome
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') {
    return { ok: false, error: 'invalid outcome' }
  }
  const nums = {
    inputTokens: count(b.inputTokens),
    outputTokens: count(b.outputTokens),
    cacheReadTokens: count(b.cacheReadTokens ?? 0),
    cacheWriteTokens: count(b.cacheWriteTokens ?? 0),
    steps: count(b.steps),
    toolCalls: count(b.toolCalls ?? 0),
    toolDiscoveries: count(b.toolDiscoveries ?? 0),
    durationMs: count(b.durationMs ?? 0),
  }
  for (const [k, v] of Object.entries(nums)) {
    if (v === null) return { ok: false, error: `invalid ${k}` }
  }
  const webSearch = nullableCost(b.webSearchCostUsd)
  const webSearchCostUsd = webSearch ?? null
  const costUsd = webSearch === undefined ? null : (nullableCost(b.costUsd) ?? null)
  const generationIds = idList(b.generationIds)
  const supersededGenerationIds = idList(b.supersededGenerationIds)
  const modelId = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : null
  const compaction = parseCompaction(b.compaction)
  const browserCommandIds = idList(b.browserCommandIds).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  if (compaction === undefined) return { ok: false, error: 'invalid compaction' }
  // Metadata only: a malformed route is dropped, never a reason to refuse the bill.
  const modelRoute = parseModelRoute(b.modelRoute)
  const contextTokens = parseContextTokens(b.contextTokens)
  const contextParts = parseContextParts(b.contextParts)
  const autoCompactions = parseAutoCompactions(b.autoCompactions)
  return {
    ok: true,
    report: {
      sessionId: b.sessionId,
      turnId: b.turnId,
      outcome,
      modelId,
      inputTokens: nums.inputTokens!,
      outputTokens: nums.outputTokens!,
      cacheReadTokens: nums.cacheReadTokens!,
      cacheWriteTokens: nums.cacheWriteTokens!,
      costUsd,
      webSearchCostUsd,
      steps: nums.steps!,
      toolCalls: nums.toolCalls!,
      toolDiscoveries: nums.toolDiscoveries!,
      generationIds,
      ...(supersededGenerationIds.length > 0 ? { supersededGenerationIds } : {}),
      durationMs: nums.durationMs!,
      firstEventAt: eventTimestamp(b.firstEventAt),
      terminalAt: eventTimestamp(b.terminalAt),
      inputTokensReported: b.inputTokensReported === true,
      outputTokensReported: b.outputTokensReported === true,
      ...(browserCommandIds.length ? { browserCommandIds } : {}),
      compaction,
      // Metadata only: a bad figure is dropped, never a reason to refuse the bill.
      ...(count(b.cardContextTokens ?? null) !== null ? { cardContextTokens: count(b.cardContextTokens)! } : {}),
      ...(isId(b.helperOf) ? { helperOf: b.helperOf } : {}),
      ...(modelRoute ? { modelRoute } : {}),
      ...(contextTokens ? { contextTokens } : {}),
      ...(contextParts ? { contextParts } : {}),
      ...(autoCompactions.length > 0 ? { autoCompactions } : {}),
    },
  }
}

/**
 * The durable once-only key for one eve chat turn. eve session ids are unique
 * and turn ids restart per session, so (session, turn) names one turn whichever
 * way the payer was resolved. A compaction bills under its own key beside the
 * turn's (`…:<turnId>:compaction:<id>`), so it never collides with the turn row.
 */
export function chatUsageIdempotencyKey(
  report: Pick<ChatTurnUsageReport, 'sessionId' | 'turnId'> & { compaction?: ChatCompactionRef | null },
): string {
  const base = `${CHAT_USAGE_FEATURE}:${report.sessionId}:${report.turnId}`
  return report.compaction ? `${base}:compaction:${report.compaction.id}` : base
}

/** Who a turn is billed to, and how that was established. */
export interface ChatUsagePayer {
  userId: string
  conversationId?: string
  workspaceId?: string
  /** 'token' = the verified chat-run token; 'session-owner' = chat_conversations.eve_session_id. */
  via: 'token' | 'session-owner'
  /**
   * The bot the turn ran as (the verified token's `teammateId`), when it did:
   * its own thread, or a main-chat conversation with it as the agent (bots v4
   * Phase C). Billed to the person like any chat turn; the row only names it.
   */
  teammate?: { id: string; in: 'thread' | 'chat' }
  /**
   * A relayed turn in the bot's thread (the verified token's `relay`, bots v4
   * Phase A4): the main chat's assistant passed the person's message on. The
   * relay row's id. Still billed to the person as `ai_chat`, like any turn of
   * theirs in that thread; the row only notes it.
   */
  relay?: string
}

export type ChatUsagePayerResolution =
  | { kind: 'payer'; payer: ChatUsagePayer }
  /** A device-ask (surface) run: /api/device/ask bills it as 'device_ask'. */
  | { kind: 'surface' }
  /** No verifiable token and no conversation registers the session (yet). */
  | { kind: 'unregistered' }

/**
 * Resolve who pays for a reported turn — never from the body.
 *  1. A chat-run token whose HMAC verifies → its user; a SURFACE token (a device
 *     ask, which /api/device/ask bills as 'device_ask') → not billed here.
 *     Expiry gates new work, not attribution (verifyChatRunToken allowExpired),
 *     but only for TURN_REPORT_TOKEN_GRACE_MS past it: a turn's report comes at
 *     its end, so a token older than that says nothing trustworthy about who
 *     pays, and is treated as absent. Within the grace, a first turn that
 *     outlived the 60-minute TTL on a session its client never registered is
 *     still billed to the minting user. A token whose signature does NOT verify
 *     is ignored entirely: its surface claim can never skip a bill (a forged
 *     'device_ask' claim is not a free turn).
 *  2. Otherwise (no token, an unverifiable one, or one past the grace) → the
 *     owner of the eve session on chat_conversations (owner-derivation). The
 *     route and the outbox sweep (src/lib/inngest/chat-usage-outbox.ts) both
 *     resolve here, so neither door takes a stale token's word.
 *  3. No owner row → 'unregistered' (the caller keeps the report for a retry).
 * Throws on a lookup error (the caller answers 5xx so the meter retries).
 */
export async function resolveChatUsagePayer(
  supabase: SupabaseClient,
  token: string | null,
  report: Pick<ChatTurnUsageReport, 'sessionId'>,
  now: number = Date.now(),
): Promise<ChatUsagePayerResolution> {
  const verified = verifyChatRunToken(token, { allowExpired: true })
  const claims = verified && verified.exp > now - TURN_REPORT_TOKEN_GRACE_MS ? verified : null
  if (claims) {
    // Only the device ask bills itself; a channel turn ('slack', 'sms') is
    // the person's own turn, billed here as `ai_chat` like any other.
    return claims.surface === 'device_ask' ? { kind: 'surface' } : {
      kind: 'payer',
      payer: {
        userId: claims.userId,
        conversationId: claims.conversationId,
        workspaceId: claims.workspaceId,
        via: 'token',
        ...(claims.teammateId ? { teammate: { id: claims.teammateId, in: claims.teammateIn === 'chat' ? 'chat' : 'thread' } } : {}),
        ...(claims.teammateId && claims.relay ? { relay: claims.relay } : {}),
      },
    }
  }
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id,user_id,workspace_id')
    .eq('eve_session_id', report.sessionId)
    .limit(1)
    .maybeSingle<{ id: string; user_id: string; workspace_id: string }>()
  if (error) throw new Error(`chat usage: session owner lookup failed: ${error.message}`)
  if (!data?.user_id) return { kind: 'unregistered' }
  return { kind: 'payer', payer: { userId: data.user_id, conversationId: data.id, workspaceId: data.workspace_id, via: 'session-owner' } }
}

/**
 * The cost logUsage may receive: eve's figure only when it is > 0 and the turn
 * ran no Exa-billed search (eve's billed cost includes it). Else null → omitted
 * → log_ai_usage prices the tokens from ai_model_costs.
 */
export function trustedChatCost(report: Pick<ChatTurnUsageReport, 'costUsd' | 'webSearchCostUsd'>): number | null {
  return report.webSearchCostUsd === null && report.costUsd !== null && report.costUsd > 0
    ? report.costUsd
    : null
}

/** log_ai_usage's cache keys (migration 199), only when the turn used the cache. */
function cacheMetadata(report: Pick<ChatTurnUsageReport, 'cacheReadTokens' | 'cacheWriteTokens'>): Record<string, number> {
  return {
    ...(report.cacheReadTokens > 0 ? { cache_read_input_tokens: report.cacheReadTokens } : {}),
    ...(report.cacheWriteTokens > 0 ? { cache_creation_input_tokens: report.cacheWriteTokens } : {}),
  }
}

/**
 * Bill one eve chat turn exactly once to `payer`. Throws only when the bill was
 * LOST (the RPC failed and the durable retry could not be queued) — the claim
 * rolled back with it, so the caller answers 5xx and the meter's retry can bill.
 */
export async function meterChatTurn(payer: ChatUsagePayer, report: ChatTurnUsageReport): Promise<MeterChatTurnResult> {
  // A turn with no completed step and no tokens spent nothing billable.
  if (report.steps === 0 && report.inputTokens === 0 && report.outputTokens === 0) {
    return { billed: false, reason: 'empty' }
  }

  // A turn on the person's own ChatGPT plan (the free tier, its steps named
  // `chatgpt-plan/<model>`, or `openai/<model>` on the search model) is logged
  // under the plan's name, so its provider is the plan's and logUsage logs it
  // at no cost: nothing accrues to a plan or a wallet. List pricing would
  // book a model with no ai_model_costs row at the fallback rate.
  const planModel = planModelOfStep(report.modelId)
  // A report naming no model is priced as what most likely ran: a helper's
  // default (Flash), else the main chat's own (MAIN_MODEL), never cheaper.
  const model = planModel ? planModelSlug(planModel) : appModelIdFromGatewaySlug(report.modelId) ?? (report.helperOf ? DEFAULT_MODEL : MAIN_MODEL)
  const costUsd = planModel ? null : trustedChatCost(report)
  const outcome = await logUsage(payer.userId, {
    provider: usageProviderLabel(model),
    model,
    feature: CHAT_USAGE_FEATURE,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    durationMs: report.durationMs,
    // null → omitted → the RPC prices from ai_model_costs (list price).
    ...(costUsd !== null ? { costUsd } : {}),
    metadata: {
      toolCalls: report.toolCalls,
      steps: report.steps,
      toolDiscoveries: report.toolDiscoveries,
      runtime: 'eve',
      // One parent row may serve several browser tasks. Join by identity, never
      // by timestamps, and count this usage_key only once across those tasks.
      attribution_version: 1,
      usage_scope: report.compaction ? 'eve_compaction' : 'eve_turn',
      parent_run_id: chatParentRunId(report.sessionId, report.turnId),
      usage_key: chatUsageIdempotencyKey(report),
      eve_session_id: report.sessionId,
      eve_turn_id: report.turnId,
      conversation_id: payer.conversationId ?? null,
      workspace_id: payer.workspaceId ?? null,
      // The bot the turn ran as, when it did (its thread, or a main-chat
      // conversation with it as the agent, bots v4 Phase C): the row names it.
      ...(payer.teammate ? { teammate_id: payer.teammate.id, teammate_in: payer.teammate.in } : {}),
      // A turn the main chat's assistant relayed to the bot (bots v4 Phase A4): the relay row.
      ...(payer.relay ? { relay_id: payer.relay } : {}),
      outcome: report.outcome,
      runtime_first_event_at: report.firstEventAt ?? null,
      runtime_terminal_at: report.terminalAt ?? null,
      timing_scope: report.compaction ? 'eve_compaction_events' : 'eve_turn_events',
      cost_source: planModel ? 'chatgpt_plan' : costUsd !== null ? 'eve_reported' : 'catalog',
      input_tokens_reported: !report.compaction && report.inputTokensReported === true,
      output_tokens_reported: !report.compaction && report.outputTokensReported === true,
      // Failed/cancelled and superseded attempts may have spent tokens that the
      // terminal event did not report. Existing billing remains unchanged.
      usage_unknown: !!report.compaction || report.inputTokensReported !== true || report.outputTokensReported !== true ||
        report.outcome !== 'completed' || !!report.supersededGenerationIds?.length,
      ...(report.browserCommandIds?.length ? { browser_command_ids: report.browserCommandIds } : {}),
      // What the cards turn-context note cost this turn (0 when not sent).
      ...(report.cardContextTokens !== undefined ? { card_context_tokens: report.cardContextTokens } : {}),
      // A quick helper's turn (A4 slice 3): the parent session, so a conversation's cost includes its helpers.
      ...(report.helperOf ? { helper_of: report.helperOf } : {}),
      // How the turn's model was chosen: tier, decider, the rules that fired, reasoning.
      ...(report.modelRoute ? { model_route: report.modelRoute } : {}),
      // The context size per model call (input_tokens is summed over the
      // steps): what compaction decides on (agents/chat-agent/lib/compaction-window.ts).
      ...(report.contextTokens
        ? {
            context_first_step_input_tokens: report.contextTokens.first,
            context_last_step_input_tokens: report.contextTokens.last,
            context_peak_step_input_tokens: report.contextTokens.peak,
          }
        : {}),
      // The agent's own parts of that context, estimated: the side panel's Context card.
      ...(report.contextParts ? { context_parts: report.contextParts } : {}),
      // eve's automatic compactions in the turn, before and after.
      ...(report.autoCompactions?.length
        ? { auto_compactions: report.autoCompactions.map((c) => ({ before_tokens: c.before, after_tokens: c.after })) }
        : {}),
      // Gateway /v1/report join key — only when present.
      ...(report.generationIds.length > 0 ? { generationIds: report.generationIds } : {}),
      // Superseded attempts of re-run steps (NOT billed) — reconciliation only.
      ...(report.supersededGenerationIds?.length ? { supersededGenerationIds: report.supersededGenerationIds } : {}),
      // Exa spend rides metadata (never in costUsd) — only when present.
      ...(report.webSearchCostUsd !== null ? { webSearchCostUsd: report.webSearchCostUsd } : {}),
      // Cached input (INCLUDED in inputTokens) — log_ai_usage prices it at the
      // cache rates on the list-price path. Only when present.
      ...cacheMetadata(report),
      // A compaction row: its input is eve's pre-compaction context estimate
      // and its output is not billed, so the row is list-priced from an
      // estimate (eve 0.79.1 adds the summary call's real usage to the
      // session total; billing from it is a follow-up, see
      // agents/chat-agent/lib/turn-usage.ts compactionFromRequested). Only when set.
      ...(report.compaction
        ? {
            compaction: true,
            compactionTrigger: report.compaction.trigger,
            usageEstimated: true,
            outputTokensReported: false,
          }
        : {}),
    },
    idempotencyKey: chatUsageIdempotencyKey(report),
  })
  if (outcome === 'duplicate') return { billed: false, reason: 'duplicate' }
  if (outcome === 'lost') {
    throw new Error(`chat usage for ${report.sessionId}/${report.turnId} was not recorded and could not be queued`)
  }
  return { billed: true }
}
