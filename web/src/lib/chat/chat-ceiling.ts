/**
 * The chat's callable-tool ceiling — ONE definition, shared by both halves of the
 * eve chat runtime:
 *
 *   • the ADVERTISE half — `rebuildChatSpec` (chat-run-rebuild.ts), which tells the
 *     eve resolvers which tools exist for this conversation, and
 *   • the ENFORCE half — POST /api/internal/chat/tool, which re-derives the ceiling
 *     from the verified run token on EVERY dispatch and refuses anything outside it.
 *
 * The two used to carry their own copy of the same three lines (plus a third copy
 * in the deleted cloud route), kept in sync only by comments saying "must match".
 * A drift between them is exactly the F1 bug class: advertise one surface, enforce
 * another. Both now call this.
 *
 *   effectiveCeiling = (editionCeiling ∩ agentCeiling) ∪ externalMcpToolNames
 *                      — or null when BOTH sides impose no limit (inherit-all)
 *
 * `null` is "no limit", never collapsed to `[]`. The external-MCP union is the
 * user's own opt-in (they connected and enabled those servers), so an agent
 * allowlist or an edition never switches them off.
 *
 * The AGENT half is ONE pure function too — {@link agentCeilingFromConfig} — called
 * by resolveAgentToolCeiling (the tool route's read of the token's agent) AND by
 * buildChatSystemPrompt §4b-2 (the spec rebuild's read of the same row), so the
 * agent_config → ceiling semantics cannot drift between the halves either.
 *
 * /api/device/ask (the ESP32 one-shot) runs as a chat-agent task session, so
 * both halves serve it too: its token carries no agent, so the agent side is
 * null and the result is edition ∪ external — the ceiling that route always
 * had in-process — MINUS the surface's structural exclusions
 * ({@link SURFACE_EXCLUDED_TOOLS}), keyed on the verified token's `surface`.
 *
 * A TEAMMATE CHAT (bots v2: the token carries `teammateId`) has its own rule,
 * {@link composeTeammateChatCeiling}, reached by both halves through
 * {@link resolveTeammateChatCeiling} from the same bounds reader
 * ({@link resolveTeammateChatBounds}):
 *
 *   teammateChatCeiling = narrowToTeammate(edition ∩ persona, bounds)
 *                         − {the chat-native tools, ask_user, mcp_confirm_call}
 *                         − ATTENDED_ONLY_TOOL_NAMES
 *                         ∪ (the bot's follow-through grants ∩ edition)
 *                         ∪ {search_tools} ∪ {read_chat_file}
 *
 * The follow-through grants (bots v3 Phase 5, ./follow-through.ts) are the
 * attended-only writes a bot may use because of what it fronts (settle_card
 * for Captures and triage loops' bots, revise_email_draft for Mail and the
 * drafting pass's face, undo_extraction_pass for Captures), never because a persona
 * selected a category.
 *
 * — never null, and never unioned with the user's external MCP tools. The
 * chat derives its ceiling from the teammate, as work runs do
 * (docs/plans/bots-v2.md decision 3).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatRunServerPrincipal, ChatRunSurface, HomeTurnTokenReason } from './chat-run-token'
import { computeToolCeiling } from '@/lib/ai/tool-ceiling-core'
import { CHAT_FILE_TOOL_NAMES } from '@/lib/ai/tool-discovery'
import {
  ALL_TOOL_NAMES,
  ATTENDED_ONLY_TOOL_NAMES,
  CHAT_NATIVE_TOOL_NAMES,
  TOOL_CATEGORIES,
  getToolSideEffect,
} from '@/lib/ai/tool-registry'
import { resolveWorkspaceEdition, computeEditionToolCeiling, intersectCeilings } from '@/lib/editions'
import { narrowToTeammate, type TeammateToolBounds } from '@/lib/agent-run/teammate-bounds'
import { callerCanReachTeammate } from './teammate-access'
import { attendedOnlyToolsDeniedTo } from '@/lib/safety/caller'
import { isInternalTextTool } from '@/lib/safety/outside-text'
import { resolveFollowThrough } from './follow-through'

/**
 * Tools a token SURFACE can never reach — removed STRUCTURALLY from both halves
 * (the spec advertise step and the tool route's permission check), keyed on the
 * verified token's `surface`, never left to prompt text.
 *
 *   device_ask → mcp_confirm_call. The device ask is a one-shot, unattended task
 *   session: there is no person on the device to approve an approval-gated
 *   external MCP write, and no follow-up turn to carry a "yes". Without the
 *   confirm tool, an approval-gated external tool keeps answering
 *   `awaiting_user_approval` (adapter.ts), so a prompt injection in a fetched
 *   page or an external-MCP result cannot get the model to confirm a gated
 *   write by itself. The user approves such actions in the Dial8 app.
 *   The attended-only tools (ATTENDED_ONLY_TOOL_NAMES: settle_card,
 *   revise_email_draft, undo_extraction_pass, the loop builders
 *   create_flow / update_flow / delete_flow, the skill writers create_skill /
 *   update_skill, ...) are out for the same reason.
 *   So are the chat-native ones (CHAT_NATIVE_TOOL_NAMES: start_helper and
 *   stop_helper, and the main agent's relay to the bots, send_bot_message and
 *   wait_for_bot_reply): only the main chat runs them.
 */
/**
 * Pages in the chat: the device ask draws no cards (it answers in a line on
 * the desktop overlay), so neither show nor read_card has anywhere to go.
 */
const CARD_TOOLS = ['show', 'read_card']

/** The desktop browser's tools: nobody's desktop is on the other end of an outside channel or a server turn. */
const BROWSER_TOOLS: readonly string[] = TOOL_CATEGORIES.find((c) => c.id === 'browser')?.tools.map((t) => t.name) ?? []

/**
 * The tools that call back into the app as the person with their Supabase JWT
 * (createTools' accessToken). A server token never carries one (`cred`), so on
 * a channel turn they could only answer 401: removed instead of advertised.
 */
const JWT_TOOLS = ['generate_email_drafts', 'draft_followup_email']

/**
 * The chat-native tools the person keeps when they text the Dial8 number or
 * DM it on Slack (Liam, 2026-10-26): start and stop a background helper, and
 * message another person's agent. A helper's report and an agent's answer
 * come back to the channel they last used (the router's sticky channel,
 * src/lib/reach/route.ts); a message
 * to another agent is the person's approval card either way (texted with its
 * code, or posted as Slack blocks). Never a guest's: the tool route refuses
 * the relay on any guest token first.
 */
export const CHANNEL_TURN_NATIVE_TOOLS: ReadonlySet<string> = new Set(['start_helper', 'stop_helper', 'ask_agent'])

/** The chat-native tools an outside channel (SMS, Slack) still drops. */
const CHANNEL_EXCLUDED_NATIVE = [...CHAT_NATIVE_TOOL_NAMES].filter((name) => !CHANNEL_TURN_NATIVE_TOOLS.has(name))

/** True when a channel turn's token may use this chat-native tool (the person's own text or Slack DM). */
export function channelTurnMayUseNative(toolName: string, claims: { server?: string; surface?: string; guestId?: string; teammateId?: string; relay?: string }): boolean {
  return CHANNEL_TURN_NATIVE_TOOLS.has(toolName) && claims.server === 'channel_turn' && !claims.guestId && !claims.teammateId && !claims.relay &&
    (claims.surface === 'sms' || claims.surface === 'slack')
}

/**
 * Out of the device ask for its time budget alone, not for trust: the route
 * gives the whole ask 60 s (maxDuration), and enrich_contact waits up to 45 s
 * for its run. A text or a Slack DM keeps it: "pull details on Dana" works there.
 */
export const DEVICE_ONLY_EXCLUSIONS: readonly string[] = ['enrich_contact']

export const SURFACE_EXCLUDED_TOOLS: Readonly<Record<ChatRunSurface, ReadonlySet<string>>> = {
  // The attended-only tools the trust authority denies the person away from
  // the app (caller.ts: the device ask is person_remote).
  device_ask: new Set(['mcp_confirm_call', ...CHAT_NATIVE_TOOL_NAMES, ...attendedOnlyToolsDeniedTo('person_remote'), ...CARD_TOOLS, ...DEVICE_ONLY_EXCLUSIONS]),
  /**
   * A Slack DM from the person (a channel turn, docs/plans/slack-connect.md):
   * nothing that needs a screen, whatever the caller class allows. No
   * external-MCP confirm, no quick helpers and no chat-native tool but
   * {@link CHANNEL_TURN_NATIVE_TOOLS} (background helpers and messages to
   * another person's agent, whose results follow them back to Slack), no attended-only tools (they act on what is on
   * the person's screen), no cards (Slack draws none), the desktop browser
   * (nobody's desktop is there) and the tools that need their JWT (a channel
   * turn's server token carries none). ask_user is native: on a channel turn
   * it answers with a plain-text note instead of parking
   * (agents/chat-agent/tools/ask_user.ts).
   */
  slack: new Set(['mcp_confirm_call', 'helpers', ...CHANNEL_EXCLUDED_NATIVE, ...ATTENDED_ONLY_TOOL_NAMES, ...CARD_TOOLS, ...BROWSER_TOOLS, ...JWT_TOOLS]),
  /**
   * A text the person sent the Dial8 number (docs/plans/text-and-calling.md):
   * the device ask's set (no external-MCP confirm, no chat-native tool but
   * {@link CHANNEL_TURN_NATIVE_TOOLS}, none of the attended-only tools the trust authority denies the
   * person away from the app (caller.ts: a text from their verified phone is
   * person_remote), no cards: an SMS draws nothing), plus the desktop browser
   * (they are on their phone) and the tools that need their JWT (a text
   * turn's server token carries none). ask_user is native: on a text turn it
   * answers with a plain-text note instead of parking
   * (agents/chat-agent/tools/ask_user.ts).
   */
  sms: new Set(['mcp_confirm_call', ...CHANNEL_EXCLUDED_NATIVE, ...attendedOnlyToolsDeniedTo('person_remote'), ...CARD_TOOLS, ...BROWSER_TOOLS, ...JWT_TOOLS]),
  /**
   * Another Dial8 user's agent over an agent link (migration 435): always a
   * guest's turn, held to that guest's own ceiling by the tool route
   * (src/lib/guests/guest-tools.ts) before this set is ever read. It still
   * excludes everything the text set does, and every attended-only tool.
   */
  dial8: new Set(['mcp_confirm_call', 'helpers', ...CHAT_NATIVE_TOOL_NAMES, ...ATTENDED_ONLY_TOOL_NAMES, ...CARD_TOOLS, ...BROWSER_TOOLS, ...JWT_TOOLS]),
  /**
   * What the person said on a call to the Dial8 number (the GPT-Live spike,
   * src/lib/calls/): the text set, and no helpers or chat-native tool at all.
   * Someone is on the line waiting, and a helper's report or another agent's
   * answer would come back by text or Slack (the router's sticky channel), not
   * on the call.
   */
  call: new Set(['mcp_confirm_call', 'helpers', ...CHAT_NATIVE_TOOL_NAMES, ...attendedOnlyToolsDeniedTo('person_remote'), ...CARD_TOOLS, ...BROWSER_TOOLS, ...JWT_TOOLS]),
  /**
   * The person @-mentioning their agent in team chat (migration 474,
   * src/lib/team-chat/): Slack's channel-thread set, and no chat-native tool
   * at all (no background helper or message to another person's agent: what
   * came back would have nowhere in the channel to go). Others in the channel
   * read the reply; nothing there draws cards.
   */
  team_chat: new Set(['mcp_confirm_call', 'helpers', ...CHAT_NATIVE_TOOL_NAMES, ...ATTENDED_ONLY_TOOL_NAMES, ...CARD_TOOLS, ...BROWSER_TOOLS, ...JWT_TOOLS]),
}

/**
 * Registry tools a SERVER turn never holds even though they read (A4 slice
 * 5): the chat-native relay and delegation, the attended-only tools, the
 * external-MCP confirm, `read_card` (no person's cards on a server turn), the
 * tools that call back into the app as the person (they need a JWT a server
 * token never carries), and the browser (kept to turns the person is in: they
 * watch it, take it over and approve its writes).
 */
export const SERVER_TURN_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  ...CHAT_NATIVE_TOOL_NAMES,
  // The quick `helpers` tool needs the person in the chat (helpers-gate.ts
  // refuses a server token too: quick helpers have no budget to hold them
  // to). A background helper is the one exception, through
  // serverTurnMayCall below, not this read-only set.
  'helpers',
  'start_helper',
  'stop_helper',
  // The attended-only tools the trust authority denies an unattended caller
  // (caller.ts: a server turn is agent_unattended).
  ...attendedOnlyToolsDeniedTo('agent_unattended'),
  'mcp_confirm_call',
  'read_card',
  ...JWT_TOOLS,
  ...BROWSER_TOOLS,
])

/**
 * True when `toolName` is in a server turn's READ-ONLY set: registry tools
 * classified 'read', minus
 * {@link SERVER_TURN_EXCLUDED_TOOLS}, plus the `search_tools` discovery
 * meta-tool. An external-MCP tool has no registry entry, so it is never a
 * server turn's. Enforced by the internal tool route on every dispatch.
 *
 * The spec rebuild deliberately does NOT narrow what it ADVERTISES for a
 * server turn: the tool list is part of the cached prompt prefix the person's
 * own turns share, and a different list on every background update would
 * re-bill the whole home thread uncached. The model is told the turn is
 * read-only (the message and the instructions), and the route refuses
 * anything else with SERVER_TURN_READ_ONLY (a home turn: serverTurnMayCall).
 */
export function isServerTurnTool(toolName: string): boolean {
  if (toolName === 'search_tools') return true
  if (SERVER_TURN_EXCLUDED_TOOLS.has(toolName)) return false
  return getToolSideEffect(toolName) === 'read'
}

/**
 * The local-agent tools a HOME turn may call (docs/plans/local-agents.md,
 * decision 6): a local agent on the person's Mac reports to the Dial8 agent,
 * so its background update may read how they are doing, stop one, and answer
 * one's open question. message_local_agent is admitted here and refused by
 * its handler unless that session's last_signal is 'ask' (the chat tool
 * route). Never start_local_agent: a start waits for a turn the person typed
 * (decision 8).
 */
export const HOME_TURN_LOCAL_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'local_agents',
  'read_local_agent',
  'stop_local_agent',
  'message_local_agent',
])

/**
 * True when a server-minted token may call `toolName`: the read-only set
 * ({@link isServerTurnTool}), plus `start_helper` on a home turn (Liam,
 * 2026-10-15: away helpers, read and draft only). That start is fenced in
 * startChatHelper: the generic helper only (reads and drafts, the drafting
 * ceiling), never a named agent, within the server-helper budget (migration
 * 340, kind 'home_turn': 1 working and 6 a day per person; 355 lifts the
 * daily cap for meeting preps only, never for these), past the kill switch.
 * And, on a home turn, the local-agent tools of {@link HOME_TURN_LOCAL_AGENT_TOOLS}
 * (an answer only to an open question), and answer_guest (guest access: a
 * guest_ask update's answers, only to this owner's own pending asks), and
 * ask_agent (agent links: held as the person's card, which alone sends it).
 * And since 2026-10-26 a home turn minted for an acting reason
 * ({@link HOME_TURN_ACTING_REASONS}: its token's `homeTurnReason`) acts on
 * its own ({@link homeTurnMayAct}): its Dial8 writes run, and the gate holds
 * anything that leaves Dial8 as the person's card. A helper's report never
 * starts a helper. Any other server turn stays read-only. The check-in has
 * its own, narrower set ({@link checkInMayCall}), decided before all of it.
 */
export function serverTurnMayCall(
  toolName: string,
  server: ChatRunServerPrincipal | undefined,
  homeTurnReason?: HomeTurnTokenReason,
): boolean {
  // The check-in (docs/plans/now-file.md "Who may write the note"): its own
  // allow-list and nothing else, before every rule below (the local agents,
  // answer_guest and ask_agent a home turn holds included).
  if (server === 'home_turn' && homeTurnReason === 'check_in') return checkInMayCall(toolName)
  // A channel turn is the person speaking (decision 14): not held to reads
  // here. Its ceiling is the person's own minus its surface's exclusions,
  // enforced by the tool route's permission check like any other surface's,
  // under the caller policy, the reviewer and the outward gate.
  if (server === 'channel_turn') return true
  // A helper's report never starts another helper (no report-helper chains).
  if (server === 'home_turn' && toolName === 'start_helper') return homeTurnReason !== 'helper_report'
  // Some home turns act on their own (Liam, 2026-10-26;
  // HOME_TURN_ACTING_REASONS): any registry tool or the person's
  // connected-app tools, minus what a server turn never holds. Their writes
  // inside Dial8 run; everything that leaves Dial8 is held as the person's
  // card by the gate (action-review.ts, GateRequest.homeTurn).
  if (server === 'home_turn' && homeTurnActs(homeTurnReason) && homeTurnMayAct(toolName)) return true
  if (server === 'home_turn' && HOME_TURN_LOCAL_AGENT_TOOLS.has(toolName)) return true
  // Guest access (429): a guest_ask update's answers. The route answers only this owner's pending asks.
  if (server === 'home_turn' && toolName === 'answer_guest') return true
  // Agent links (435): a message to another person's agent, held as the person's card (the route never sends it).
  if (server === 'home_turn' && toolName === 'ask_agent') return true
  return isServerTurnTool(toolName)
}

/**
 * The check-in's two writes (docs/plans/now-file.md "The check-in"): the
 * person's Now file (update_now, which the tool route grants it alone among
 * server turns) and one light helper for a stalled item (start_helper, kind
 * 'check_in', held by migration 443's caps).
 */
export const CHECK_IN_WRITE_TOOLS: ReadonlySet<string> = new Set(['update_now', 'start_helper'])

/**
 * Reads the code counts as internal that a check-in still never holds:
 * get_document (a document made from a file reads as outside text), and the
 * same text through a revision or a canon document; and show, whose card a
 * check-in's text-only reply can't carry.
 */
export const CHECK_IN_REFUSED_READS: ReadonlySet<string> = new Set(['get_document', 'get_document_revision', 'read_canon', 'show'])

/**
 * True when the check-in may call `toolName`: its two writes, and the plain
 * reads a server turn holds ({@link isServerTurnTool}) whose result is
 * workspace text by name (isInternalTextTool, the one fail-closed definition
 * the route's outside-text judgment uses: mail, find, search and anything
 * unlisted count as outside), minus {@link CHECK_IN_REFUSED_READS}. Never a
 * local-agent tool, answer_guest, ask_agent, an outward or connected-app
 * tool, or any other write: its context holds only the note, Dial8's body
 * and these reads, so it may write the note.
 */
export function checkInMayCall(toolName: string): boolean {
  if (CHECK_IN_WRITE_TOOLS.has(toolName)) return true
  if (CHECK_IN_REFUSED_READS.has(toolName)) return false
  return isServerTurnTool(toolName) && isInternalTextTool(toolName)
}

/**
 * The background updates that act on their own (Liam, 2026-10-26): a
 * helper's report, an event (mail, a meeting, a teammate's ask), another
 * agent's answer, and a call the person approved having run (445: the agent
 * carries on with what they asked for). A guest's ask and the daily digest
 * stay read-only, as their guidance says: a guest's words never drive a
 * write, and the digest only reports. So does a home token that names no
 * reason.
 */
export const HOME_TURN_ACTING_REASONS: ReadonlySet<string> = new Set<HomeTurnTokenReason>(['helper_report', 'event', 'agent_answer', 'approval'])

/** True when a home turn minted for `reason` acts on its own ({@link HOME_TURN_ACTING_REASONS}). */
export function homeTurnActs(reason: HomeTurnTokenReason | undefined): boolean {
  return !!reason && HOME_TURN_ACTING_REASONS.has(reason)
}

/**
 * The person's review items a background update never settles, whatever it
 * may write: confirming or dismissing a suggested action, a decision, a
 * claim, a proposal or prospect entries is the person's call ("never settle
 * or approve anything on their behalf"). settle_card and settle_work_item are
 * attended-only already. A contact's web enrichment (enrich_contact,
 * 2026-10-27) is held back here too: a paid search that runs only on the
 * person's own yes, so a background update (the meeting prep's report offering
 * it, say) never claims that yes for them; the turn they type their answer in
 * runs it.
 */
export const HOME_TURN_SETTLE_TOOLS: ReadonlySet<string> = new Set([
  'enrich_contact',
  'accept_proposal',
  'confirm_action',
  'confirm_all_decisions',
  'confirm_claim',
  'confirm_decision',
  'dismiss_action',
  'dismiss_claim',
  'dismiss_decision',
  'dismiss_proposal',
  'dismiss_prospect_entries',
])

/**
 * True when an acting HOME turn may call `toolName` beyond the read-only
 * set: a registry tool of any class, or an external connected-app tool
 * (`mcp__…`), except {@link SERVER_TURN_EXCLUDED_TOOLS} (the chat-native
 * relay and delegation, the attended-only tools, the external-MCP confirm,
 * the cards, the JWT tools and the browser) and {@link HOME_TURN_SETTLE_TOOLS}.
 * The gate holds what leaves Dial8.
 */
export function homeTurnMayAct(toolName: string): boolean {
  if (SERVER_TURN_EXCLUDED_TOOLS.has(toolName) || HOME_TURN_SETTLE_TOOLS.has(toolName)) return false
  return getToolSideEffect(toolName) !== undefined || toolName.startsWith('mcp__')
}

/**
 * The side effects a team chat turn may have (migration 474): reading, and
 * changing the person's own Dial8 items. Other members' messages ride the
 * turn as context, and the reply is read by the whole channel, so nothing
 * that deletes, sets up an automation, leaves Dial8 (mail, connected apps,
 * every `mcp__…` tool) or would wait on an approval card the channel can't
 * show is reachable from it: the person asks for that in their own chat.
 */
const TEAM_CHAT_SIDE_EFFECTS: ReadonlySet<string> = new Set(['read', 'internal-write'])

/**
 * True when a team chat turn may never call `toolName`: a connected app's
 * (`mcp__…`), or a registry tool past its side effects. A tool with no side
 * effect class (search_tools) is left to the surface's own set.
 */
export function teamChatExcludes(toolName: string): boolean {
  if (toolName.startsWith('mcp__')) return true
  const effect = getToolSideEffect(toolName)
  return effect !== undefined && !TEAM_CHAT_SIDE_EFFECTS.has(effect)
}

/** True when `toolName` is structurally excluded for this token surface. */
export function isToolExcludedForSurface(toolName: string, surface: ChatRunSurface | undefined): boolean {
  if (!surface) return false
  if (SURFACE_EXCLUDED_TOOLS[surface].has(toolName)) return true
  return surface === 'team_chat' && teamChatExcludes(toolName)
}

/**
 * The external-MCP tool names a surface may reach (the user's connected tools
 * minus the surface's exclusions). Both halves pass THIS list to
 * {@link resolveChatCeiling} and use it for their inherit-all branch, so the
 * exclusion holds whether or not the edition/agent impose a ceiling.
 */
export function surfaceExternalToolNames(
  externalMcpToolNames: readonly string[],
  surface: ChatRunSurface | undefined,
): string[] {
  // Team chat reaches no connected app at all (teamChatExcludes), whatever the tool is called.
  if (surface === 'team_chat') return []
  return externalMcpToolNames.filter((name) => !isToolExcludedForSurface(name, surface))
}

/**
 * The chat's own uploads are always readable, whatever a persona or a bot is
 * limited to: read_chat_file is how the model reads a file the person attached
 * and the ONLY way it sees a photo they attached (a photo never rides the
 * message: an eve file part starts a sandbox). It reads the caller's own chat
 * uploads alone. The edition still caps it, as it does every tool.
 */
function withChatFileTools(ceiling: Set<string>, editionCeiling: Set<string> | null): Set<string> {
  for (const name of CHAT_FILE_TOOL_NAMES) {
    if (!editionCeiling || editionCeiling.has(name)) ceiling.add(name)
  }
  return ceiling
}

/**
 * Pure composition: (edition ∩ agent) ∪ external-MCP names ∪ the chat-file
 * tools, or null when neither the edition nor the agent imposes a limit.
 */
export function composeChatCeiling(
  editionCeiling: Set<string> | null,
  agentCeiling: Set<string> | null,
  externalMcpToolNames: readonly string[],
): Set<string> | null {
  const combined = intersectCeilings(editionCeiling, agentCeiling)
  return combined ? withChatFileTools(new Set<string>([...combined, ...externalMcpToolNames]), editionCeiling) : null
}

/**
 * The chat ceiling for a workspace: resolves the workspace EDITION's ceiling (once)
 * and composes it with the caller-supplied agent ceiling + external-MCP names.
 * The spec rebuild and the tool route call this with the same inputs derived from
 * the same verified token, so what is advertised is what is enforced.
 * `workspaceSettings` is the workspace's `settings` blob when the caller already
 * read it (the spec rebuild reads it once for all its consumers); absent, the
 * edition read here does its own.
 */
export async function resolveChatCeiling(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    agentToolCeiling: Set<string> | null
    externalMcpToolNames: readonly string[]
    workspaceSettings?: unknown
  },
): Promise<Set<string> | null> {
  const editionCeiling = computeEditionToolCeiling(
    (await resolveWorkspaceEdition(supabase, args.workspaceId, args.workspaceSettings)).edition,
  )
  return composeChatCeiling(editionCeiling, args.agentToolCeiling, args.externalMcpToolNames)
}

/** The agent_config shape the ceiling reads (recipe rows with category 'agent'). */
export type AgentToolConfig = {
  enabled_tools?: string[] | null
  disabled_tools?: string[] | null
} | null | undefined

/**
 * The agent (persona) half of the ceiling from an agent row's `agent_config` —
 * the ONE place that semantics lives. The enabled/disabled arrays pass THROUGH
 * when the key is present — including a present-but-empty [] (core-only, which
 * computeToolCeiling narrows to CORE_TOOL_NAMES) — and collapse to undefined ONLY
 * when the key is absent/null, so [] can never be misread as inherit-all and
 * silently widen the gate. Null = inherit-all (every category on, nothing
 * disabled — computeToolCeiling's rule).
 */
export function agentCeilingFromConfig(cfg: AgentToolConfig): Set<string> | null {
  return computeToolCeiling(cfg?.enabled_tools ?? undefined, cfg?.disabled_tools ?? undefined)
}

/**
 * The agent (persona) half of the ceiling, read from the agent's recipe row. Null
 * for no agent, an unknown/non-agent id, or an inherit-all agent. The config →
 * ceiling step is {@link agentCeilingFromConfig}, the same call
 * buildChatSystemPrompt §4b-2 makes on the spec side.
 */
export async function resolveAgentToolCeiling(
  supabase: SupabaseClient,
  agentId: string | undefined,
): Promise<Set<string> | null> {
  if (!agentId) return null
  const { data: agent } = await supabase
    .from('recipe')
    .select('agent_config, category')
    .eq('id', agentId)
    .eq('category', 'agent')
    .maybeSingle<{ agent_config: AgentToolConfig }>()
  if (!agent) return null
  return agentCeilingFromConfig(agent.agent_config)
}

// ── Teammate chats (bots v2) ──────────────────────────────────────────────────

/**
 * Tools a teammate chat never reaches, whatever the teammate's bounds say
 * (docs/plans/bots-v2.md decision 3):
 *   the chat-native tools (CHAT_NATIVE_TOOL_NAMES):
 *     start_helper, stop_helper
 *                    — a teammate doesn't start or stop helpers from its own
 *                      bubble (the main chat directs them, always-on-agent §4);
 *     send_bot_message, wait_for_bot_reply
 *                    — only the main agent relays to a bot (bots-v4 Phase
 *                      A3): a bot never calls back into the main agent or
 *                      another bot, from its thread, a bot conversation or a
 *                      loop run's chat (skill-run-chat-ceiling.ts);
 *   ask_user         — the bubble has no picker (the native tool also answers
 *                      instead of parking on a teammate token,
 *                      agents/chat-agent/tools/ask_user.ts);
 *   mcp_confirm_call — no external MCP tools at all, so nothing to confirm.
 * ask_user and mcp_confirm_call are not registry tools, so narrowToTeammate
 * drops them anyway; listing them keeps the rule in one readable place.
 */
export const TEAMMATE_CHAT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([...CHAT_NATIVE_TOOL_NAMES, 'ask_user', 'mcp_confirm_call'])

/**
 * What a teammate chat's ceiling is built from: the teammate's own bounds
 * (allowed_side_effects ∩ tool_allowlist) and its persona recipe's
 * agent_config (null when the recipe has none, or is not this workspace's own
 * or a system one).
 */
export interface TeammateChatBounds extends TeammateToolBounds {
  agentConfig: AgentToolConfig
  /**
   * A work bot (`fronts_only`, migration 302), or the Assistant system
   * teammate (migration 310): its chat is read plus the propose-only tools
   * ({@link WORK_BOT_PROPOSE_TOOLS}), whatever its row says.
   */
  frontsOnly?: boolean
}

/**
 * What a work bot may do in chat beyond reading (bots-v3 Phase 3): stage a
 * change for the person's click, never make one. A document edit lands as a
 * proposal to review in the app (`propose_document_edit`). Not
 * `create_email_draft`: it writes a real draft to the person's mailbox, and
 * with `previous_draft_id` deletes one, with no click. Still capped by the
 * edition and the persona half.
 */
export const WORK_BOT_PROPOSE_TOOLS: ReadonlySet<string> = new Set(['propose_document_edit'])

/** A work bot's narrowing: the read tools of `base`, plus the propose-only ones `base` holds. */
export function narrowToWorkBot(base: Iterable<string>): Set<string> {
  const pool = [...base]
  const out = narrowToTeammate(pool, { allowed_side_effects: ['read'], tool_allowlist: null })
  for (const name of pool) if (WORK_BOT_PROPOSE_TOOLS.has(name)) out.add(name)
  return out
}

/**
 * The persona (recipe) half of a TEAMMATE chat's ceiling. Unlike
 * {@link agentCeilingFromConfig}, a recipe that makes NO tool selection (no
 * config, or no `enabled_tools` key) means every registry tool (minus any it
 * disables), not the core-only set: most teammates' recipes carry no config,
 * and core-only would leave a Correspondent without its email tools. The
 * teammate's own bounds are the cap (composeTeammateChatCeiling). A present
 * selection — `[]` included — reads exactly as the chat's agent half does.
 */
export function teammatePersonaCeiling(cfg: AgentToolConfig): Set<string> {
  if (cfg?.enabled_tools == null) {
    const disabled = new Set(cfg?.disabled_tools ?? [])
    return new Set(ALL_TOOL_NAMES.filter((name) => !disabled.has(name)))
  }
  return agentCeilingFromConfig(cfg) ?? new Set(ALL_TOOL_NAMES)
}

/**
 * Pure composition of a teammate chat's ceiling:
 *
 *   narrowToTeammate(edition ∩ persona, bounds) − TEAMMATE_CHAT_EXCLUDED_TOOLS ∪ {search_tools}
 *     ∪ the chat-file tools (read_chat_file, edition-capped: withChatFileTools)
 *
 * The narrowing runs AFTER the persona half, whose selection path unions
 * CORE_TOOL_NAMES in (computeToolCeiling) — so a read-only teammate does NOT
 * keep the core board writes (create_action, update_action, complete_action).
 * Never null (null would mean inherit-all), and no external MCP names: they
 * are unclassified, so the teammate's bounds could not admit them anyway.
 */
export function composeTeammateChatCeiling(
  editionCeiling: Set<string> | null,
  bounds: TeammateChatBounds,
  followThrough: Iterable<string> = [],
): Set<string> {
  const persona = teammatePersonaCeiling(bounds.agentConfig)
  const base = intersectCeilings(editionCeiling, persona) ?? persona
  const ceiling = bounds.frontsOnly ? narrowToWorkBot(base) : narrowToTeammate(base, bounds)
  for (const name of TEAMMATE_CHAT_EXCLUDED_TOOLS) ceiling.delete(name)
  // A bot's attended-only writes come from its grants alone (./follow-through.ts),
  // capped by the edition, never from its persona's categories or bounds.
  // They are the trust authority's one standing grant (caller.ts
  // DecideOptions.granted): they reach a turn the main agent relays too.
  for (const name of ATTENDED_ONLY_TOOL_NAMES) ceiling.delete(name)
  for (const name of followThrough) {
    if (ATTENDED_ONLY_TOOL_NAMES.has(name) && (!editionCeiling || editionCeiling.has(name))) ceiling.add(name)
  }
  ceiling.add('search_tools')
  return withChatFileTools(ceiling, editionCeiling)
}

/**
 * The teammate's bounds for a teammate chat, from the token's (workspaceId,
 * teammateId, userId) — the ONE reader both halves use. Fenced to the
 * workspace (a service-role caller), and the persona recipe to this
 * workspace's own or a system one (the loadAgentPersona rule). Null when the
 * teammate is gone, in another workspace, out of the token user's reach (the
 * private-team rule, {@link teammateChatReachable}), or a read fails: both
 * halves then fail closed.
 */
export async function resolveTeammateChatBounds(
  supabase: SupabaseClient,
  workspaceId: string,
  teammateId: string,
  userId: string,
): Promise<TeammateChatBounds | null> {
  const { data, error } = await supabase
    .from('ai_team_member')
    .select(TEAMMATE_CHAT_BOUNDS_SELECT)
    .eq('id', teammateId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as unknown as TeammateChatBoundsRow
  try {
    if (!(await teammateChatReachable(supabase, row, { userId, workspaceId }))) return null
  } catch {
    return null
  }
  return teammateChatBoundsFromRow(row, workspaceId)
}

/**
 * The private-team rule for a teammate chat's token user, on the service
 * client: the row's `is_system` / `team_id` through callerCanReachTeammate
 * (teammate-access.ts). Both halves check it after reading the row, since the
 * token outlives a change of team membership. Throws on a query error.
 */
export function teammateChatReachable(
  supabase: SupabaseClient,
  row: Pick<TeammateChatBoundsRow, 'is_system' | 'team_id'>,
  scope: { userId: string; workspaceId: string },
): Promise<boolean> {
  return callerCanReachTeammate(supabase, {
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    teammate: { isSystem: row.is_system === true, teamId: row.team_id ?? null },
  })
}

/**
 * The ai_team_member columns a teammate chat's bounds come from. The spec
 * side selects them beside the teammate's name in one read
 * (chat-system-prompt.ts loadTeammateLayer) and maps them with
 * {@link teammateChatBoundsFromRow}, the same step this module's reader
 * takes, so the two halves cannot read the bounds differently. `is_system`
 * and `team_id` feed the private-team rule ({@link teammateChatReachable}).
 */
export const TEAMMATE_CHAT_BOUNDS_SELECT =
  'is_system, system_key, team_id, fronts_only, allowed_side_effects, tool_allowlist, agent:agent_recipe_id(agent_config, workspace_id, is_system)'

/** The row {@link TEAMMATE_CHAT_BOUNDS_SELECT} reads. */
export interface TeammateChatBoundsRow {
  /** The private-team rule's inputs (teammateChatReachable), not the bounds. */
  is_system?: boolean | null
  team_id?: string | null
  /** Which system teammate it is: the Assistant (migration 310) chats propose-only, as a work bot does. */
  system_key?: string | null
  /** A work bot (migration 302): its chat is read plus propose-only. */
  fronts_only?: boolean | null
  allowed_side_effects: string[] | null
  tool_allowlist: string[] | null
  agent: { agent_config: AgentToolConfig; workspace_id: string | null; is_system: boolean | null } | null
}

/**
 * A teammate row → its chat bounds. The persona recipe counts only when it is
 * this workspace's own or a system one (the loadAgentPersona fence); any
 * other recipe contributes no selection, and the teammate's own bounds still
 * cap the result. The Assistant (bots-v4.md Phase 5) chats as a work bot
 * does, read plus propose-only ({@link narrowToWorkBot}), whatever its row says.
 */
export function teammateChatBoundsFromRow(row: TeammateChatBoundsRow, workspaceId: string): TeammateChatBounds {
  const agent = row.agent && (row.agent.is_system === true || row.agent.workspace_id === workspaceId) ? row.agent : null
  const proposeOnly = row.fronts_only === true || (row.is_system === true && row.system_key === 'assistant')
  return {
    allowed_side_effects: row.allowed_side_effects,
    tool_allowlist: row.tool_allowlist,
    agentConfig: agent?.agent_config ?? null,
    ...(proposeOnly ? { frontsOnly: true } : {}),
  }
}

/**
 * A teammate chat's ceiling for a workspace: the workspace EDITION's ceiling
 * composed with the teammate's bounds, plus the bot's follow-through grants
 * (resolveFollowThrough, read live for `teammateId`). Both halves call this
 * with bounds from {@link resolveTeammateChatBounds}; null bounds (the
 * teammate is gone) give an EMPTY set — no tools, not even search_tools.
 */
export async function resolveTeammateChatCeiling(
  supabase: SupabaseClient,
  args: { workspaceId: string; teammateId: string; bounds: TeammateChatBounds | null; workspaceSettings?: unknown },
): Promise<Set<string>> {
  if (!args.bounds) return new Set()
  const [edition, followThrough] = await Promise.all([
    resolveWorkspaceEdition(supabase, args.workspaceId, args.workspaceSettings),
    resolveFollowThrough(supabase, { workspaceId: args.workspaceId, teammateId: args.teammateId }),
  ])
  return composeTeammateChatCeiling(computeEditionToolCeiling(edition.edition), args.bounds, followThrough)
}
