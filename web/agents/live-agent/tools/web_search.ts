/**
 * web_search — eve's provider-managed web search, pinned to Exa.
 *
 * The cloud route gives every non-eval live turn Exa-backed `web_search`
 * (src/lib/ai/tools/web-search.ts); this is its eve twin — same provider, same
 * name, so the shared WEB_ACCESS_GUIDANCE prompt text holds on both runtimes.
 * Provider-executed: no local executor to wrap; the only configuration is the
 * provider pin.
 *
 * NOT unconditional: on a turn with no web access (an EVAL capture — searching
 * the live web is non-deterministic and its spend is invisible under
 * skipBilling — or the USE_GATEWAY kill switch), tools/workspace_tools.ts
 * shadows this tool with a refusal of the same name (a dynamic tool overrides
 * an authored one), mirroring the cloud route leaving web_search out of its map.
 *
 * TRAP: `web_search` must never appear in a live-agent spec's ceilingTools /
 * coreToolNames as a PROXY — the resolver refuses to mint one, since it would
 * shadow this provider tool with a round trip to a route that has no such tool.
 */
import { webSearch } from 'eve/tools/web_search'

export default webSearch({ provider: 'exa' })
