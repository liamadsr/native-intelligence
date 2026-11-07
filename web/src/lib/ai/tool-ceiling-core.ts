/**
 * The tool ceiling, and the core tool names it is seeded from — as pure data
 * and set arithmetic, with NO dependency on `zod` or the `ai` SDK.
 *
 * Split out of tool-discovery.ts for bundle reasons, not taste. The editions
 * module (`@/lib/editions`) needs `computeToolCeiling` to answer what an
 * edition may use, and the editions module is imported by the nav rail, the
 * tab context and the calendar — i.e. by the client, on the landing view.
 * Importing it from tool-discovery dragged that module's `import { tool } from
 * 'ai'` and `import { z } from 'zod'` into the first-load bundle, so every
 * dashboard visitor parsed the AI SDK and zod (~17MB installed, ~1.6MB in the
 * client chunk) to render a sidebar.
 *
 * Nothing here needs either package: the ceiling is a set union over the tool
 * registry, which is plain data. tool-discovery.ts re-exports both symbols, so
 * server-side callers keep importing from where they always did.
 */

import { ALL_CATEGORY_IDS, getToolNamesForCategories } from './tool-registry'

/** Tools always visible to the model — no search needed. */
export const CORE_TOOL_NAMES: string[] = [
  'get_dashboard_summary',
  // `find` is the unified retrieval front door (knowledge-recall Phase 2). It
  // replaces search/deep_search in the core set; those stay implemented and
  // discoverable via search_tools (and on MCP) as deprecated fallbacks.
  'find',
  'list_actions',
  'create_action',
  'update_action',
  'complete_action',
  // Recommending a change stages it as a one-click suggestion instead of prose
  // (docs/plans/suggestions-everywhere.md), so it is always in reach.
  'suggest_changes',
  'get_calendar_events',
  'list_captures',
  'get_notifications',
  // Pages in the chat: when the answer is a set of records, the agent shows
  // the page instead of listing rows (docs/plans/one-agent-and-chat-pages.md).
  'show',
  'search_tools',
  // Always available so the model can ask clarifying questions (rendered as the
  // in-chat picker) without first discovering the tool via search_tools.
  'ask_user',
]

/**
 * Resolve an agent's tool allowlist into the hard ceiling of tool names it may
 * use. Returns `null` for "inherit all" (no ceiling) — i.e. when every category
 * is enabled and nothing is disabled.
 *
 * CORE_TOOL_NAMES are always part of the ceiling: they're the irreducible
 * baseline (orientation + the core action tools) every agent gets regardless of
 * its allowlist. The allowlist only gates non-core tools.
 */
export function computeToolCeiling(
  enabledCategoryIds: string[] | undefined,
  disabledTools: string[] | undefined,
): Set<string> | null {
  const enabled = enabledCategoryIds ?? []
  const disabled = disabledTools ?? []

  // Inherit-all: all categories on, nothing disabled → no ceiling.
  const allEnabled = ALL_CATEGORY_IDS.every((id) => enabled.includes(id))
  if (allEnabled && disabled.length === 0) return null

  const ceiling = new Set<string>(CORE_TOOL_NAMES)
  const disabledSet = new Set(disabled)
  for (const name of getToolNamesForCategories(enabled)) {
    if (!disabledSet.has(name)) ceiling.add(name)
  }
  return ceiling
}
