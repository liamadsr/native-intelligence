/**
 * Dynamic workspace-tool resolver for the live-agent (LIVE-AGENT-DESIGN §4.1,
 * "Option B") — with PROGRESSIVE TOOL DISCLOSURE, the eve twin of the cloud
 * route's activeTools + prepareStep + search_tools.
 *
 * The live agent's real tools (createLiveAgentTools' staging tools + the chat
 * READ surface) are Next-coupled (Supabase, embeddings, the MCP client) and
 * cannot compile into this eve runtime. So this resolver builds one thin PROXY
 * per advertised tool: the real NAME + DESCRIPTION + input JSON Schema (off the
 * spec), and an execute that dispatches to POST /api/internal/live-agent/tool,
 * which runs the REAL tool under the turn's tenancy and RE-DERIVES the ceiling.
 *
 * ── Progressive disclosure ──────────────────────────────────────────────────
 *   • `session.started`: the spec's coreToolNames (every permitted staging tool
 *     + the core reads + get_package when packages are attached) + search_tools.
 *   • `step.started`: core ∪ discovered-from-state, re-derived every step (eve
 *     does not persist step tool metadata — only session/turn — so rebuilding
 *     from durable state each step is mandatory).
 *   • `search_tools.execute`: token-matches the query against the spec's FULL
 *     ceilingTools, writes matches into durable state, returns them; the NEXT
 *     step.started advertises them as callable proxies.
 *
 * ── The ceiling is STRUCTURAL (the F1 invariant) — three layers ─────────────
 *   1. A name outside the resolved set raises NoSuchToolError in eve.
 *   2. search_tools can only surface spec.ceilingTools, which the spec rebuild
 *      computed with computeLiveAgentCeiling for THIS turn type — discovery
 *      cannot widen it; every advertised name is also clamped to it here.
 *   3. The internal tool route re-derives the ceiling from the verified token
 *      and refuses anything outside it (403 TOOL_OUT_OF_CEILING).
 *
 * ── Names this resolver never proxies ───────────────────────────────────────
 *   • ask_user / say_to_user — their own files (tools/ask_user.ts,
 *     tools/say_to_user.ts), resolved only when the turn's ceiling holds them
 *     (a paired notes turn never does). Two dynamic resolvers must not emit the
 *     same name.
 *   • search_tools — minted natively here.
 *   • web_search — eve's own provider tool (tools/web_search.ts); a proxy of
 *     that name would shadow it. BUT when the spec says the turn has NO web
 *     access (an EVAL capture, or the USE_GATEWAY kill switch — the cloud route
 *     leaves web_search out of its map then), this resolver shadows it with a
 *     refusal stub on purpose: a dynamic tool overrides an authored one of the
 *     same name (verified in eve 0.66.3's tool loop, which assigns dynamic
 *     entries over the static+provider set), so no search can leave an eval
 *     turn. The same refusal is minted when the spec fetch FAILS (fail closed):
 *     web is live only when a spec says `webAccess: true`.
 *   • web_fetch — disabled outright (tools/web_fetch.ts): the cloud route never
 *     had a fetch tool, so the live agent's web surface is web_search alone.
 *     Never proxied either.
 *
 * ── Connected-app lookups ───────────────────────────────────────────────────
 * A copilot turn's read-only lookups in the person's connected apps
 * (`mcp__<server>__<tool>`) ride spec.ceilingTools like any other tool:
 * discoverable through search_tools, never core. Their proxies count calls in
 * durable session state and refuse a fourth (dispatchProxied); the tool route
 * re-derives the catalog and enforces the cap and a 5 s deadline itself.
 *
 * ── Replay safety ───────────────────────────────────────────────────────────
 * Each proxy's `execute` is an INLINE arrow capturing only serializable strings
 * (the tool name, the run token); the input schema is a plain JSON object off
 * the fetched spec; `dispatchLiveAgentTool` is module-level and rebuilds its
 * fetch per call.
 */
import { defineDynamic, defineTool } from 'eve/tools'
import { defineState } from 'eve/context'
import { z } from 'zod'
import {
  dispatchLiveAgentTool,
  fetchLiveAgentSpec,
  runTokenFromAuth,
  type LiveAgentSpec,
} from '../lib/spec-client.js'

/** The discovery meta-tool — minted natively here, never proxied. */
const SEARCH_TOOLS_NAME = 'search_tools'
/** Resolved by their own files (tools/ask_user.ts, tools/say_to_user.ts). */
const OWN_FILE_TOOL_NAMES = new Set(['ask_user', 'say_to_user'])
/** eve's provider web tool — never proxied; shadowed by a refusal when web is off. */
const NATIVE_WEB_TOOL_NAMES = ['web_search'] as const
/** Web tool names this resolver never mints a proxy for (web_fetch is disabled outright). */
const NEVER_PROXIED_WEB_NAMES = new Set<string>([...NATIVE_WEB_TOOL_NAMES, 'web_fetch'])

/** Permissive FALLBACK schema — only when the spec carries no real one. */
const passThroughInput = z.record(z.string(), z.unknown())

/** How many matches search_tools reveals per call (mirrors the cloud registry cap). */
const SEARCH_RESULT_LIMIT = 15

/**
 * Durable per-session memory of the tool names the model discovered via
 * search_tools. step.started re-derives the advertised set from this.
 */
const discoveredTools = defineState<string[]>('live-agent.discovered-tools', () => [])

/** A connected-app lookup's name prefix (`mcp__<server>__<tool>`). */
const MCP_TOOL_PREFIX = 'mcp__'
/**
 * Connected-app lookups per session (one session per turn). Mirrors
 * LIVE_MCP_CALLS_PER_TURN in src/lib/live-agent/mcp-lookups.ts, which the tool
 * route enforces per token in memory; this durable count makes the cap exact
 * per session whichever route instance serves the calls.
 */
const MCP_LOOKUPS_PER_TURN = 3
const MCP_LIMIT_OUTPUT = {
  refused: 'mcp_limit',
  message: "This call's 3 lookups are used. Answer with what you have.",
} as const
const mcpLookupCount = defineState<number>('live-agent.mcp-lookups', () => 0)

/**
 * Dispatch one proxied call. A connected-app lookup past the session's cap is
 * refused here with a normal tool result and never reaches the route.
 */
function dispatchProxied(name: string, runToken: string, input: unknown): Promise<unknown> | unknown {
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    if (mcpLookupCount.get() >= MCP_LOOKUPS_PER_TURN) return MCP_LIMIT_OUTPUT
    mcpLookupCount.update((n) => n + 1)
  }
  return dispatchLiveAgentTool(name, runToken, input)
}

type CeilingTool = LiveAgentSpec['ceilingTools'][number]
type ToolEntry = ReturnType<typeof defineTool>
type ToolMap = Record<string, ToolEntry>

/** True when a name may be minted as a workspace proxy by THIS resolver. */
function isProxyable(name: string): boolean {
  return name !== SEARCH_TOOLS_NAME && !OWN_FILE_TOOL_NAMES.has(name) && !NEVER_PROXIED_WEB_NAMES.has(name)
}

/** One inline-execute proxy per name that is proxyable AND in the ceiling surface. */
function buildProxies(names: Iterable<string>, available: Map<string, CeilingTool>, runToken: string): ToolMap {
  const entries: ToolMap = {}
  for (const name of names) {
    if (!isProxyable(name)) continue
    const entry = available.get(name)
    if (entry === undefined) continue // outside this turn's ceiling — never built
    entries[name] = defineTool({
      description: entry.description,
      inputSchema: entry.inputSchema ?? passThroughInput,
      execute: (input) => dispatchProxied(name, runToken, input),
    }) as ToolEntry
  }
  return entries
}

/**
 * Token-based search over the spec's ceiling tools (a dependency-free twin of
 * the cloud registry search): +3 per query token in the name, +2 in the
 * description, +2 when the name starts with a token. Only ceiling tools are
 * searched, so a match can never widen the ceiling.
 */
function searchCeiling(query: string, ceilingTools: CeilingTool[]): CeilingTool[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((t) => t.length > 1)
  if (tokens.length === 0) return []
  const scored: Array<{ tool: CeilingTool; score: number }> = []
  for (const tool of ceilingTools) {
    if (!isProxyable(tool.name)) continue
    const nameLower = tool.name.toLowerCase()
    const descLower = tool.description.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (nameLower.includes(token)) score += 3
      if (descLower.includes(token)) score += 2
      if (nameLower.startsWith(token)) score += 2
    }
    if (score > 0) scored.push({ tool, score })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((s) => s.tool)
}

/** The native search_tools meta-tool. Captures only the run token (a string). */
function buildSearchTools(runToken: string) {
  return defineTool({
    description:
      'Discover additional workspace tools by searching with a natural language query. ' +
      'Use this when you need a tool not currently available to you (e.g. "email drafts", ' +
      '"milestones", "CRM contacts"). Matching tools become callable on your next step.',
    inputSchema: z.object({
      query: z.string().describe('Natural language description of the capability you need.'),
    }),
    execute: async ({ query }) => {
      const spec = await fetchLiveAgentSpec(runToken)
      if (!spec) {
        return { tools: [], hint: 'Tool discovery is unavailable right now. Work with the tools you already have.' }
      }
      const matches = searchCeiling(query, spec.ceilingTools)
      if (matches.length === 0) {
        return { tools: [], hint: 'No matching tools found. Try a different query.' }
      }
      const names = matches.map((m) => m.name)
      discoveredTools.update((prev) => {
        const set = new Set(prev)
        for (const n of names) set.add(n)
        return [...set]
      })
      return {
        tools: matches.map((m) => ({ name: m.name, description: m.description })),
        hint: 'These tools are now available. Call them directly (they appear on your next step).',
      }
    },
  })
}

/**
 * A refusal standing in for web_search on a turn with no web access. It
 * OVERRIDES the authored framework tool of the same name, so the provider
 * search never runs. Captures nothing.
 */
function buildWebRefusal(name: string) {
  return defineTool({
    description: `Unavailable for this meeting — do not call ${name}. Web access is off here; work from the conversation and the workspace tools.`,
    inputSchema: passThroughInput,
    execute: () => ({
      error: 'Web access is disabled for this meeting. Work from the conversation and the workspace tools only.',
    }),
  })
}

/** The web name shadowed by a refusal — the no-web surface. */
function webRefusals(): ToolMap {
  const entries: ToolMap = {}
  for (const name of NATIVE_WEB_TOOL_NAMES) entries[name] = buildWebRefusal(name) as ToolEntry
  return entries
}

/**
 * Resolve the advertised set: (core ∪ extra) proxies clamped to the ceiling
 * surface, plus search_tools, plus the web_search refusal when web is off.
 *
 * FAIL CLOSED on web: with no spec (unknown token, route 5xx/timeout, missing
 * secret) there is no workspace proxy and no search_tools — but web_search is
 * STILL shadowed by a refusal. The static web_search is live by default, and an
 * eval turn is only known to be one through its spec, so web is reachable only
 * when a spec affirmatively says `webAccess: true`. (The model resolver fails
 * such a session before its first model call anyway — this is the second
 * layer.)
 */
async function resolveAdvertised(auth: unknown, extraNames: Iterable<string>): Promise<ToolMap> {
  const runToken = runTokenFromAuth(auth as never)
  const spec = await fetchLiveAgentSpec(runToken)
  if (!spec) return webRefusals()

  const available = new Map(spec.ceilingTools.map((t) => [t.name, t]))
  const names = new Set<string>([...spec.coreToolNames, ...extraNames])
  const entries = buildProxies(names, available, runToken)
  entries[SEARCH_TOOLS_NAME] = buildSearchTools(runToken) as ToolEntry
  if (spec.webAccess !== true) Object.assign(entries, webRefusals())
  return entries
}

export default defineDynamic({
  events: {
    // Durable baseline: core proxies + search_tools (+ the web_search refusal).
    'session.started': async (_event, ctx) => resolveAdvertised(ctx.session.auth, []),
    // Per model call: core ∪ discovered-from-state, re-derived every step.
    'step.started': async (_event, ctx) => resolveAdvertised(ctx.session.auth, discoveredTools.get()),
  },
})
