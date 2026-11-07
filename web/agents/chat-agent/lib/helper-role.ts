/**
 * The quick helper's tool surface (A4 slice 3, docs/plans/always-on-agent.md
 * §4): which of the conversation's tools a `helper` child session advertises.
 *
 * A helper holds read plus drafts only (Liam, 2026-10-14): no external writes,
 * no approval cards mid-run, nothing that draws in the chat, no browser, no
 * memory. The classification lives in the Next app (src/lib/chat/helpers-gate.ts,
 * from the tool registry's side effects) and rides the spec as
 * `helperToolNames`; this side intersects the conversation's ceiling with it
 * and drops a fixed belt of names besides, so a drifted or older app can never
 * hand a helper a card, the browser or the relay. An app that sends no
 * `helperToolNames` gives a helper no workspace tools at all (fail closed). The
 * internal tool route re-checks every helper-marked call.
 */
import { BROWSER_TOOL_NAMES } from './browser-output.js'
import type { ChatSpec } from './spec-client.js'

/** Who a workspace-tool resolver serves: the main chat, or a quick helper. */
export type ToolRole = 'root' | 'helper'

/**
 * Never advertised to a helper, whatever the spec says: the cards (`show`,
 * `read_card`, `suggest_changes` markers) and the browser, which only the
 * main chat's turn can draw or drive; `remember` (the evidence rule needs the
 * person's own words, and a helper's task is the main agent's text);
 * `update_now` (the person's Now file is the main agent's sketchpad: what a
 * helper needs of it is in its brief);
 * `ask_user` (no one answers a helper); the MCP approval half; and the relay,
 * delegation and local-agent tools, which are the main chat's alone.
 */
export const HELPER_DROPPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'show',
  'read_card',
  'suggest_changes',
  'remember',
  'update_now',
  'ask_user',
  'mcp_confirm_call',
  'delegate_work',
  'send_bot_message',
  'wait_for_bot_reply',
  // The local agents on the person's Mac (docs/plans/local-agents.md): the main chat's alone.
  'local_agents',
  'start_local_agent',
  'message_local_agent',
  'read_local_agent',
  'stop_local_agent',
  // Its cloud counterpart (docs/plans/environments.md E2): the main chat's alone too.
  'start_cloud_coding_run',
  // A guest's answer (guest access): the main chat's alone too.
  'answer_guest',
  // Asking a linked person's agent (agent links): the main chat's alone too.
  'ask_agent',
  ...BROWSER_TOOL_NAMES,
])

type CeilingTool = ChatSpec['ceilingTools'][number]

/**
 * The ceiling tools a role may see. The root sees the whole discoverable
 * surface; a helper sees `spec.helperToolNames` ∩ that surface, minus the
 * belt. Order follows `ceilingTools`.
 */
export function ceilingToolsForRole(spec: Pick<ChatSpec, 'ceilingTools' | 'helperToolNames'>, role: ToolRole): CeilingTool[] {
  if (role === 'root') return spec.ceilingTools
  const allowed = new Set(Array.isArray(spec.helperToolNames) ? spec.helperToolNames.filter((n) => typeof n === 'string') : [])
  return spec.ceilingTools.filter((t) => allowed.has(t.name) && !HELPER_DROPPED_TOOL_NAMES.has(t.name))
}
