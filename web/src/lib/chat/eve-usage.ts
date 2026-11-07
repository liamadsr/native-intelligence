/**
 * eve main-chat usage mapping (Phase 4, Stage 3 — usage wiring).
 *
 * Turns a turn's eve stream events into the fields logUsage / the log_ai_usage
 * RPC need. Shared by every eve caller that bills from its own stream read
 * (utility, live-agent, device ask, skill runs via sumEveUsage). eve chat itself
 * is metered SERVER-SIDE by the chat-agent's usage-meter hook →
 * POST /api/internal/chat/usage, never from these numbers relayed by a browser.
 * eve's own cost is trusted only under the rule below; otherwise the log_ai_usage
 * RPC list-prices the tokens.
 *
 * ── When eve's costUsd is trusted (eve 0.66.3 — the rule of record) ───────────
 * On eve 0.66.3 `step.completed.usage.costUsd` IS populated: it is the Gateway's
 * BILLED `cost` for that model call (no `marketCost`/list price rides the event).
 * Two consequences make it unusable as-is:
 *
 *   1. BYOK: the Gateway bills our own provider key, so the token part of that
 *      cost is $0. A BYOK step's `costUsd` is 0 (or absent) even though real
 *      tokens were spent.
 *   2. EXA CONTAMINATION: a step that ran the provider-executed `web_search`
 *      (Exa via the Gateway) is billed the search too, so its `costUsd` INCLUDES
 *      the Exa spend. Measured live on 0.66.3 (BYOK Anthropic, one step, 8.1k
 *      input tokens): step costUsd 0.007 == the web_search result's
 *      costDollars.total 0.007 — the tokens contributed $0 and the whole "cost"
 *      was Exa. Trusting it would bill the turn's tokens at nothing (and, on the
 *      credits path, fold Exa into the token figure).
 *
 * So eve's cost is trusted ONLY when (a) no `action.result` in the turn carries
 * an Exa `output.costDollars.total`, (b) every token-spending step carried a
 * positive cost, and (c) the sum is > 0. Otherwise costUsd is null → logUsage
 * OMITS it → the log_ai_usage RPC prices the summed tokens from ai_model_costs
 * (list price / cache-aware). The Exa spend is surfaced separately as
 * `webSearchCostUsd` so callers record it in the usage row's metadata (the
 * key the live-agent / device-ask rows already use). The same rule lives in the
 * live-agent route (toGenResult) and the chat-agent's server-side usage meter
 * (agents/chat-agent/lib/turn-usage.ts — the eve runtime cannot import this
 * module, so it mirrors the rule; both are pinned by tests).
 *
 * ── durationMs (logUsage-required, no native event) ─────────────────────────
 * eve has no "turn wall clock" event. Every stream event carries an optional
 * `meta.at` (ISO timestamp, stamped at durable-write time). We bracket the turn
 * by the FIRST and LAST timestamped event and take the delta. Absent/unparseable
 * timestamps → 0 (the RPC accepts 0; duration is not price-bearing for token
 * models). A caller that already tracked its own wall clock may pass `wallMs` to
 * override — preferred when available (a `Date.now() - startTime` wall).
 */
import type { HandleMessageStreamEvent } from 'eve/client'

export interface EveTurnUsage {
  /** Summed across steps. INCLUDES the cached tokens below (eve reports the provider's total). */
  inputTokens: number
  outputTokens: number
  /**
   * The cached share of inputTokens, summed across steps (`usage.cacheReadTokens`
   * / `cacheWriteTokens` on step.completed; 0 when a step reports none). The
   * log_ai_usage RPC prices these at 0.1x / 1.25x of input for provider 'claude'
   * when they ride its metadata as cache_read_input_tokens /
   * cache_creation_input_tokens.
   */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** null → logUsage omits costUsd → RPC prices from ai_model_costs (see doc). */
  costUsd: number | null
  /**
   * Exa web-search spend: the sum of every `action.result` output's
   * `costDollars.total` this turn, or null when no result carried one. Non-null
   * forces `costUsd` to null (eve's step cost already includes it — see doc).
   * Callers put it in usage metadata as `webSearchCostUsd`.
   */
  webSearchCostUsd: number | null
  durationMs: number
  steps: number
  toolCalls: number
  /** search_tools invocations (the cloud route's `toolDiscoveries` metadata). */
  toolDiscoveries: number
  /**
   * Distinct Vercel AI Gateway generation ids from this turn's `step.completed`
   * events (`providerMetadata.gateway.generationId`), deduped + order-preserving,
   * capped at 50. These are the join key back to the Gateway's /v1/report rows,
   * so retaining them lets a row be reconciled against the authoritative gateway
   * cost even though eve never surfaces that cost in-band. Empty when the event
   * shape carries none (absent metadata, older eve stream version).
   */
  generationIds: string[]
}

/** How many gateway generation ids to retain per turn (bounds row metadata size). */
const MAX_GENERATION_IDS = 50

/** Events carry an optional `meta.at` ISO timestamp (message.d.ts). */
type WithMeta = { meta?: { at?: string } }

/**
 * The usage-row metadata log_ai_usage prices cached input from
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`, mig 199): read at
 * 0.1x and write at 1.25x of the input rate for provider 'claude'. Only the
 * non-zero keys, so an uncached row carries no noise. Every eve usage site
 * spreads this into its metadata; without it a BYOK Claude row whose eve cost
 * is null bills its cached input at the full input rate.
 */
export function usageCacheMetadata(usage: {
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): Record<string, number> {
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  return {
    ...(read > 0 ? { cache_read_input_tokens: read } : {}),
    ...(write > 0 ? { cache_creation_input_tokens: write } : {}),
  }
}

/**
 * Map a turn's eve events into logUsage-ready usage. Pure + total: any missing
 * field degrades to a safe zero/null (never throws) so a malformed stream can't
 * wedge persistence.
 */
export function mapEveTurnUsage(
  events: readonly HandleMessageStreamEvent[],
  opts?: { wallMs?: number },
): EveTurnUsage {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let costSum = 0
  let sawCost = false
  // A step that spent tokens but carried no POSITIVE cost (absent, or the 0 a
  // BYOK step reports — "cost unavailable", not "free"). Its tokens are in the
  // sums above, but its cost is not in costSum — so costSum is a PARTIAL turn
  // cost, and handing it to log_ai_usage (which takes p_cost_usd verbatim and
  // ignores the tokens) would bill only the steps that happened to carry one.
  // A Gateway BYOK→credits fallback on one step of a multi-step turn is the
  // mixed case.
  let uncostedStep = false
  let steps = 0
  let toolCalls = 0
  let toolDiscoveries = 0
  let webSearchCost = 0
  let sawWebSearchCost = false
  let firstAt: number | null = null
  let lastAt: number | null = null
  // Insertion-ordered de-dup for gateway generation ids (Set preserves order).
  const generationIds = new Set<string>()

  for (const ev of events) {
    // Bracket the turn by the first/last timestamped event.
    const at = (ev as WithMeta).meta?.at
    if (typeof at === 'string') {
      const t = Date.parse(at)
      if (Number.isFinite(t)) {
        if (firstAt === null || t < firstAt) firstAt = t
        if (lastAt === null || t > lastAt) lastAt = t
      }
    }

    if (ev.type === 'step.completed') {
      steps += 1
      const u = ev.data.usage
      if (u) {
        inputTokens += u.inputTokens ?? 0
        outputTokens += u.outputTokens ?? 0
        cacheReadTokens += u.cacheReadTokens ?? 0
        cacheWriteTokens += u.cacheWriteTokens ?? 0
        if (typeof u.costUsd === 'number' && u.costUsd > 0) {
          costSum += u.costUsd
          sawCost = true
        } else if ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) > 0) {
          uncostedStep = true
        }
      }
      // Gateway generation id rides the EVENT's data (ev.data.providerMetadata),
      // NOT the usage object — see StepCompletedProviderMetadata in
      // eve/dist/src/protocol/message.d.ts. Read defensively: it's an external
      // contract and older stream versions may omit the field entirely.
      if (generationIds.size < MAX_GENERATION_IDS) {
        const gid = extractGenerationId(ev.data)
        if (gid) generationIds.add(gid)
      }
    } else if (ev.type === 'actions.requested') {
      // Each requested action is a tool call (mirrors run-skill-eve.countEveToolCalls).
      for (const action of ev.data.actions) {
        toolCalls += 1
        // search_tools is the read-only discovery meta-tool — count it like the
        // cloud route's discoveryCount. Match on the action's tool name across
        // the possible shapes eve uses.
        if (isSearchToolsAction(action)) toolDiscoveries += 1
      }
    } else if (ev.type === 'action.result') {
      // Exa spend rides the provider-executed web_search result's output.
      const exa = exaCostOf(ev.data)
      if (exa !== null) {
        webSearchCost += exa
        sawWebSearchCost = true
      }
    }
  }

  // 0 (BYOK), never-reported, positive on only SOME token-spending steps (the
  // rest 0 or absent), or Exa-contaminated (any web_search result carried
  // costDollars) → null → the RPC prices the fully summed tokens (list /
  // cache-aware; see doc above). eve's cost is trusted only when every step
  // with usage carried one AND the turn ran no Exa-billed search.
  const webSearchCostUsd = sawWebSearchCost ? webSearchCost : null
  const costUsd =
    sawCost && !uncostedStep && costSum > 0 && webSearchCostUsd === null ? costSum : null

  // Prefer the caller's own wall clock (matches the cloud route). Otherwise the
  // event-timestamp bracket; otherwise 0.
  const durationMs =
    typeof opts?.wallMs === 'number' && opts.wallMs >= 0
      ? opts.wallMs
      : firstAt !== null && lastAt !== null && lastAt >= firstAt
        ? lastAt - firstAt
        : 0

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    webSearchCostUsd,
    durationMs,
    steps,
    toolCalls,
    toolDiscoveries,
    generationIds: [...generationIds],
  }
}

/**
 * Pull the Vercel AI Gateway `generationId` off a `step.completed` event's
 * `data` (`data.providerMetadata.gateway.generationId`). Defensive by design —
 * `providerMetadata` is optional in the eve contract and older stream versions
 * omit it, so every hop is guarded and any non-string / empty value yields null
 * (never throws). Returns the trimmed id or null.
 */
function extractGenerationId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const meta = (data as Record<string, unknown>).providerMetadata
  if (!meta || typeof meta !== 'object') return null
  const gateway = (meta as Record<string, unknown>).gateway
  if (!gateway || typeof gateway !== 'object') return null
  const gid = (gateway as Record<string, unknown>).generationId
  if (typeof gid !== 'string') return null
  const trimmed = gid.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The Exa `costDollars.total` on one `action.result` event's data
 * (`data.result.output.costDollars.total`), or null. Matched by SHAPE, not tool
 * name (same reasoning as harvestWebSearchCost in src/lib/ai/tools/web-search.ts:
 * no other tool emits `costDollars`, and a name filter could silently match
 * nothing). Defensive: any malformed hop → null, never throws.
 */
export function exaCostOf(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const result = (data as Record<string, unknown>).result
  if (!result || typeof result !== 'object') return null
  const output = (result as Record<string, unknown>).output
  if (!output || typeof output !== 'object') return null
  const costDollars = (output as Record<string, unknown>).costDollars
  if (!costDollars || typeof costDollars !== 'object') return null
  const total = (costDollars as Record<string, unknown>).total
  return typeof total === 'number' && Number.isFinite(total) ? total : null
}

/**
 * Whether an `actions.requested` action is a `search_tools` call. eve action
 * shapes vary by kind; probe the common name-bearing fields defensively (never
 * throws — an unrecognized shape just isn't counted as a discovery).
 */
function isSearchToolsAction(action: unknown): boolean {
  if (!action || typeof action !== 'object') return false
  const a = action as Record<string, unknown>
  const name = a.toolName ?? a.name ?? (a.tool as Record<string, unknown> | undefined)?.name
  return name === 'search_tools'
}
