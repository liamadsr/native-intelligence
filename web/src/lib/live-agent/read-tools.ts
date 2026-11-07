import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolSet } from 'ai'
import { createTools, type CreateToolsOptions } from '@/lib/ai/tools'
import { LIVE_AGENT_READ_TOOLS, LIVE_AGENT_CORE_READ_TOOLS } from './read-tool-names'

/**
 * Server-only builder for the live agent's READ tool set.
 *
 * The live agent's contract is "propose, never mutate": every change it wants to
 * make flows through `propose_change` / `propose_mcp_call` into the review queue +
 * confidence gate (see `createLiveAgentTools`). What it historically LACKED was
 * the ability to look things up. This builds the FULL read surface of the chat
 * agent's tool set, but NOTHING that writes — the same `createTools()` the chat
 * route uses, filtered to LIVE_AGENT_READ_TOOLS.
 *
 * NOTE: this module imports `createTools`, which transitively pulls in
 * server-only code (next/headers). Import it only from server code (the route).
 * Anything that just needs the tool NAMES (e.g. a 'use client' module) must
 * import from `./read-tool-names` instead, which has no heavy deps.
 *
 * The allowlist + curation policy live in `./read-tool-names`; re-exported here so
 * existing server call sites can keep importing both from one place.
 */
export { LIVE_AGENT_READ_TOOLS, LIVE_AGENT_CORE_READ_TOOLS }

/**
 * Build the read-only subset of the full chat tool set, scoped to this user +
 * workspace. Returns the same `tool()` objects `createTools` produces (RLS-bound
 * via the user's Supabase client), filtered to `LIVE_AGENT_READ_TOOLS`. Any
 * allowlisted name that doesn't correspond to a real tool is simply absent —
 * filtering by intersection means a stale entry can never inject a phantom tool.
 *
 * `options` passes straight through to `createTools`. The route sets
 * `omitPrivateCaptures: true` for an EVAL capture: an eval trace is
 * workspace-member readable and is shown to the judge, so a private capture
 * paraphrased into one would leak (docs/plans/evals.md §5.1/§5.3).
 */
export function buildLiveAgentReadTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  accessToken?: string,
  options?: CreateToolsOptions,
): ToolSet {
  // The search tools keep the all-time default every non-chat caller has; the
  // agent narrows with since / until and opts into transcripts and attachments
  // per call (search-scope.ts).
  const all = createTools(userId, supabase, workspaceId, accessToken, options) as ToolSet
  const out: ToolSet = {}
  for (const [name, def] of Object.entries(all)) {
    if (LIVE_AGENT_READ_TOOLS.has(name)) out[name] = def
  }
  return out
}
