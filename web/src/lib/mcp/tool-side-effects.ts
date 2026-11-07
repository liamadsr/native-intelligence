/**
 * Side-effect classes for the MCP-ONLY tools (Sequence step 2, plan A.2).
 *
 * Every registry tool carries its class in src/lib/ai/tool-registry.ts and the
 * MCP server bridges those by name. The hand-registered tools (workspace
 * navigation, GitHub PR links, library agents, the verdict commit, the
 * discovery dispatchers) had no class at all — the guard fell back to a name
 * regex. This map is their classification; `resolveMcpToolSideEffect` answers
 * registry first, then this map, and the regex is the guard's LAST resort, not
 * its source of truth.
 *
 * Bare names (no `dial8_` prefix). A hand-registered tool that is missing here
 * fails the registration test, so a new MCP-only tool cannot ship unclassified.
 */
import { getToolSideEffect, type ToolSideEffect } from '@/lib/ai/tool-registry'

export const MCP_TOOL_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffect>> = Object.freeze({
  // Workspace navigation — moves the session, mutates no workspace data.
  list_workspaces: 'read',
  get_workspace: 'read',
  set_workspace: 'read',
  // Discovery dispatchers — call_tool re-classifies the name it is asked to run.
  search_tools: 'read',
  call_tool: 'read',
  // GitHub PR links: a link row on the action; the PR itself lives on GitHub.
  link_pr: 'internal-write',
  get_pr_status: 'read',
  list_linked_prs: 'read',
  // Library agents (skills are bridged registry tools with their own classes).
  create_agent: 'automation-write',
  update_agent: 'automation-write',
  delete_agent: 'delete',
  delete_skill: 'delete',
})

/** The class of an MCP tool by bare or prefixed name: registry, then the MCP-only map. */
export function resolveMcpToolSideEffect(toolName: string): ToolSideEffect | undefined {
  const bare = toolName.replace(/^dial8_/, '')
  return getToolSideEffect(bare) ?? MCP_TOOL_SIDE_EFFECTS[bare]
}
