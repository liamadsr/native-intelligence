/**
 * Quick helpers (A4 slice 3, docs/plans/always-on-agent.md §4): who may start
 * them, and what a helper may call.
 *
 * The main chat's blocking `helpers` tool (agents/chat-agent/tools/helpers.ts)
 * starts 1–4 copies of a declared `helper` subagent inside one turn. Workflow
 * tools are static in eve 0.66.3, so the tool cannot be hidden per session:
 * the gate is this flag, computed by the internal spec route from the VERIFIED
 * run token and read by the tool's first step. It doubles as a kill switch
 * (CHAT_HELPERS_DISABLED).
 *
 * A helper runs read plus drafts only (Liam, 2026-10-14): no external writes,
 * no approval cards in the middle of a run, nothing that draws in the chat.
 * The set is computed here, where the tool classification lives, and rides
 * the spec as `helperToolNames`; the helper's tool resolver advertises only
 * those, and the internal tool route refuses anything else on a call the
 * helper marks as its own.
 */
import { computeDraftingCeiling } from '@/lib/agent-run/run-work-spec-rebuild'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'

/** Why a conversation can't start helpers: the tool hands this to the model verbatim. */
export type HelpersGate = { allowed: true } | { allowed: false; reason: string }

/** The env var that turns quick helpers off everywhere ('1' or 'true'). */
export const HELPERS_KILL_SWITCH_ENV = 'CHAT_HELPERS_DISABLED'

function killSwitchOn(): boolean {
  const v = process.env[HELPERS_KILL_SWITCH_ENV]
  return v === '1' || v === 'true'
}

/**
 * Helpers run only in an attended main-chat conversation: the person's own
 * chat (a side chat or an area-focused one included), never a device ask, a
 * bot's thread or conversation, a relayed turn, or a token the server minted
 * for itself (idle compaction). Read only from claims whose HMAC verified.
 */
export function helpersGate(
  claims: Pick<ChatRunTokenClaims, 'surface' | 'teammateId' | 'relay' | 'server'>,
): HelpersGate {
  if (killSwitchOn()) return { allowed: false, reason: 'Helpers are switched off right now. Do the work yourself, step by step.' }
  if (claims.surface) {
    return { allowed: false, reason: `Helpers are not available on ${claims.surface === 'device_ask' ? 'a device ask' : claims.surface === 'sms' ? 'a text message' : claims.surface === 'call' ? 'a phone call' : claims.surface === 'dial8' ? "another person's agent's message" : claims.surface === 'team_chat' ? 'a team chat mention' : `a message from ${claims.surface === 'slack' ? 'Slack' : 'outside the app'}`}. Do the work yourself.` }
  }
  if (claims.relay) return { allowed: false, reason: 'Helpers are not available on a relayed turn. Do the work yourself.' }
  if (claims.teammateId) return { allowed: false, reason: "Helpers are only for the person's main chat, not an agent's conversation. Do the work yourself." }
  if (claims.server) return { allowed: false, reason: 'Helpers need the person in the chat; this turn was started by the server. Do the work yourself.' }
  return { allowed: true }
}

/**
 * Tools a helper never holds, whatever their class:
 *   - anything that draws in the chat (`show`, `read_card`, `suggest_changes`
 *     markers): a helper's output is text the main agent reads, so a card
 *     would be invisible;
 *   - the browser (one per person and workspace, which parallel helpers would
 *     fight over).
 * `remember`, the loop and skill writers and the bots' tools are attended-only
 * and the relay is chat-native, so the drafting ceiling already leaves them
 * out; external writes, deletes and automation writes are outside it too.
 */
export const HELPER_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'show',
  'read_card',
  'suggest_changes',
  ...(TOOL_CATEGORIES.find((c) => c.id === 'browser')?.tools.map((t) => t.name) ?? []),
])

let draftingCeiling: Set<string> | null = null

/**
 * True when a helper may call `name`: a registry tool in the drafting ceiling
 * (reads and artifact writes such as drafts and documents, never an external
 * write, a delete or an automation write, never an attended-only or
 * chat-native tool), minus HELPER_EXCLUDED_TOOL_NAMES. An external-MCP tool
 * has no registry entry, so it is never a helper's (its approval card would
 * stall the run).
 */
export function isHelperTool(name: string): boolean {
  draftingCeiling ??= computeDraftingCeiling()
  return draftingCeiling.has(name) && !HELPER_EXCLUDED_TOOL_NAMES.has(name)
}

/** The conversation's discoverable tools a helper may call, in the spec's order. */
export function helperToolNames(ceilingTools: ReadonlyArray<{ name: string }>): string[] {
  return ceilingTools.map((t) => t.name).filter(isHelperTool)
}

/** The spec fields the route adds: the gate, its reason, and the helper's tools. */
export function helperSpecFields(
  claims: Pick<ChatRunTokenClaims, 'surface' | 'teammateId' | 'relay' | 'server'>,
  ceilingTools: ReadonlyArray<{ name: string }>,
): { helpersAllowed: boolean; helpersRefusal?: string; helperToolNames: string[] } {
  const gate = helpersGate(claims)
  return gate.allowed
    ? { helpersAllowed: true, helperToolNames: helperToolNames(ceilingTools) }
    : { helpersAllowed: false, helpersRefusal: gate.reason, helperToolNames: [] }
}
