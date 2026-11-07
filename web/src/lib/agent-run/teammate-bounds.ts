/**
 * A teammate's own tool bounds (ai_team_member, migration 280) and the one
 * narrowing step that applies them — pure set arithmetic over the tool
 * registry, with no DB, prompt or model dependency, so both runtimes that
 * narrow to a teammate share it:
 *
 *   • work runs (run-work-spec-rebuild.ts ceilingForWorkRun): an UNATTENDED
 *     run done by a teammate, narrowed from the drafting ceiling;
 *   • teammate chats (src/lib/chat/chat-ceiling.ts composeTeammateChatCeiling,
 *     bots v2): a conversation with one teammate, narrowed from the edition ∩
 *     persona ceiling.
 *
 * It lived in run-work-spec-rebuild.ts until the chat needed it; that module
 * re-exports both names, so its callers are unchanged.
 */
import { getToolDefinition } from '@/lib/ai/tool-registry'

/**
 * A teammate's own bounds: the tool classes it may call, and an optional
 * per-tool narrowing inside them.
 */
export interface TeammateToolBounds {
  allowed_side_effects?: string[] | null
  tool_allowlist?: string[] | null
}

/**
 * `ceiling` ∩ the teammate's bounds. Missing or malformed classes read as
 * `{read}` (the column's default: a teammate never configured can only look),
 * so a bad row narrows, never widens. A name the registry doesn't classify
 * (search_tools, ask_user, an external MCP tool) is dropped: fail closed.
 */
export function narrowToTeammate(ceiling: Iterable<string>, teammate: TeammateToolBounds): Set<string> {
  const classes = new Set(
    Array.isArray(teammate.allowed_side_effects) ? teammate.allowed_side_effects.filter((c) => typeof c === 'string') : ['read'],
  )
  const allow = Array.isArray(teammate.tool_allowlist) ? new Set(teammate.tool_allowlist) : null
  const out = new Set<string>()
  for (const name of ceiling) {
    const cls = getToolDefinition(name)?.sideEffect
    if (!cls || !classes.has(cls)) continue
    if (allow && !allow.has(name)) continue
    out.add(name)
  }
  return out
}
