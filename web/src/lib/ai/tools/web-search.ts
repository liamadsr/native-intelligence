/**
 * `web_search` — public web search via Exa, as an ALWAYS-ON capability.
 *
 * Web access is not a per-agent allowlist toggle: every agent gets it, the same
 * way the eve chat agent does (agents/chat-agent/tools/web_fetch.ts —
 * "Web access is always on for chat agents (no toggle, matching how Anthropic's
 * own agents browse)"). That is why this module lives OUTSIDE
 * `createTools()`/`tool-registry.ts`:
 *
 *   • `createTools()` is pinned name-for-name to the registry by
 *     `src/lib/ai/__tests__/tool-registry-sync.test.ts` (both directions), and
 *     the registry is the per-agent allowlist surface. Adding `web_search`
 *     there would make it toggleable — the opposite of the intent — and would
 *     also leak the name into the eve spec builders' `ceilingTools` /
 *     `coreToolNames`, where it would collide with eve's NATIVE provider tool
 *     of the same name (a workspace proxy named `web_search` would shadow it).
 *     See ALWAYS_ON_CAPABILITY_TOOL_NAMES in ../tool-discovery.ts.
 *
 * The tool is PROVIDER-EXECUTED: it has no `execute`, the Gateway runs the
 * search server-side and hands the model the results directly. Consequently it
 * only exists on the Gateway path — when the `USE_GATEWAY=false` kill switch is
 * flipped, `createWebSearchTool()` returns `{}` and the classic routes simply
 * run without web access rather than throwing.
 *
 * Name parity matters: eve's built-in provider tool is also called `web_search`,
 * so a model's habits (and our prompt guidance) transfer between the two
 * runtimes unchanged.
 */

import { gateway } from 'ai'

/**
 * The Exa provider tool's own type. Written as a lookup off `gateway.tools` so
 * it tracks the SDK rather than restating the shape.
 */
type ExaSearchTool = ReturnType<typeof gateway.tools.exaSearch>

/**
 * The return shape of {@link createWebSearchTool}: an INDEX-SIGNATURE record,
 * not `{ web_search?: ExaSearchTool }`.
 *
 * The distinction is load-bearing. An inferred return (or an optional property)
 * makes `web_search` a KNOWN key whose type includes `undefined` once the
 * Gateway-off branch is in the union — and `undefined` is not assignable to the
 * SDK's `ToolSet` index signature, so every `streamText`/`generateText` call
 * site that spreads this would fail to typecheck. An index signature contributes
 * a compatible `ToolSet` shape in both branches. Call sites reach the tool
 * through `name in tools` / `activeTools`, which never needed the literal key.
 */
export type WebSearchToolMap = Record<string, ExaSearchTool>

/**
 * Results per search. Matches eve 0.47's built-in `web_search` default
 * (harness/provider-tools.js hardcodes `numResults: 10`) so the two runtimes
 * return the same breadth.
 */
const WEB_SEARCH_NUM_RESULTS = 10

/**
 * Highlight budget per result. Also eve's built-in default
 * (`contents.highlights.maxCharacters: 1000`). Highlights (not full text) are
 * the payload: they keep a 10-result turn inside a sane token budget.
 */
const WEB_SEARCH_HIGHLIGHT_MAX_CHARACTERS = 1000

/**
 * Bound on a single Exa live crawl. The search runs provider-side inside the
 * model step, so a page that never finishes loading otherwise stalls the whole
 * step with no way for us to interrupt just that fetch. Proven in the original
 * CRM enrichment search loop (since replaced by Exa Deep Search): a slow site
 * costs one result, not the turn.
 */
const WEB_SEARCH_LIVECRAWL_TIMEOUT_MS = 10_000

/**
 * How stale Exa's cached content may be before it re-crawls. A week: preferring
 * the cache is what keeps the search fast and cheap, and interactive chat
 * questions are rarely hour-sensitive. (CRM enrichment uses a 24h target on its
 * own Deep Search request — see src/lib/exa/deep-search.ts.)
 */
const WEB_SEARCH_MAX_AGE_HOURS = 168

/**
 * Whether the Exa-backed `web_search` tool is available.
 *
 * Exa is a Gateway-provided tool — it has no direct-provider equivalent — so it
 * exists only while Gateway routing is on. Mirrors `isGatewayEnabled()` in
 * ../gateway.ts (kept local rather than exported from there so this module owns
 * its own availability story and can be unit-tested on its own).
 */
export function isWebSearchAvailable(): boolean {
  return process.env.USE_GATEWAY !== 'false'
}

/**
 * The always-on web-search tool map, ready to spread into a `tools` object.
 *
 * Returns `{}` when Gateway is disabled, so callers can spread unconditionally:
 *
 *   const allTools = { ...createWebSearchTool(), search_tools: ..., ...baseTools }
 */
export function createWebSearchTool(): WebSearchToolMap {
  if (!isWebSearchAvailable()) return {}

  return {
    web_search: gateway.tools.exaSearch({
      numResults: WEB_SEARCH_NUM_RESULTS,
      contents: {
        highlights: { maxCharacters: WEB_SEARCH_HIGHLIGHT_MAX_CHARACTERS },
        livecrawlTimeout: WEB_SEARCH_LIVECRAWL_TIMEOUT_MS,
        maxAgeHours: WEB_SEARCH_MAX_AGE_HOURS,
      },
    }),
  }
}

/** One provider tool result, narrowed to what the cost harvest reads. */
type LooseToolResult = { output?: unknown }

/**
 * Sum the `costDollars.total` Exa reports across every web-search result in a
 * finished run's steps. Defensive shape-checking only — the model consumes the
 * results itself; we only want the spend.
 *
 * Matched by SHAPE, not by tool name. The name
 * would be tempting (`toolName === 'web_search'`), but it is the SDK's map KEY,
 * not anything the provider guarantees — the original CRM enrichment loop
 * registered the very same Exa tool under `exa_search`, and a future SDK/Gateway that echoed the provider
 * tool id instead would silently make a name filter match nothing, dropping
 * every Exa cost with no test going red. `costDollars.total` on a tool result is
 * unambiguous enough on its own: no other tool in any of these maps emits it.
 *
 * Returns `null` when the run made no web searches or none reported a cost, so
 * a caller can skip logging entirely rather than logging a misleading $0.
 */
export function harvestWebSearchCost(
  steps: ReadonlyArray<{ toolResults?: ReadonlyArray<unknown> }> | undefined | null,
): number | null {
  let cost = 0
  let sawCost = false

  for (const step of steps ?? []) {
    for (const raw of step?.toolResults ?? []) {
      const tr = raw as LooseToolResult
      const out = tr?.output as { costDollars?: { total?: unknown } } | undefined
      if (!out || typeof out !== 'object') continue
      const total = out.costDollars?.total
      if (typeof total === 'number' && Number.isFinite(total)) {
        cost += total
        sawCost = true
      }
    }
  }

  return sawCost ? cost : null
}
