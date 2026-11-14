/**
 * The live meeting agent's per-turn TOOL CEILING — names only, no heavy imports.
 *
 * Computed by this ONE function on every runtime that serves the cloud live
 * agent: the spec rebuild that tells the eve `live-agent` mount what to
 * advertise (./live-agent-spec.ts), and the internal tool route that RE-DERIVES
 * it from a verified run token before executing anything (both via
 * assembleLiveAgentToolSet / computeLiveAgentCeiling in ./turn-composition).
 * `POST /api/ai/live-agent` no longer builds a tools map at all: its model call
 * runs on eve (LIVE-AGENT-DESIGN §12 Step 3), so the old inline twin in route.ts
 * is gone and this is the only ceiling. Chat's ceiling is reimplemented in three
 * places and has drifted; this one is ONE (§4.2).
 *
 * The ceiling is the SECURITY boundary (the F1 invariant): a tool outside it is
 * absent from the tools map, never merely un-advertised. It is
 *
 *     staging tools (minus the turn type's exclusions)
 *   ∪ the two pinned resolver reads (list_workspace_members, list_labels)
 *   ∪ the live READ allowlist, narrowed by the selected agent's tool selection
 *   ∪ a copilot turn's read-only lookups in the person's connected apps
 *     (./mcp-lookups.ts; discoverable, never core)
 *
 * `search_tools` (read-only discovery) and web access (read-only, provider-
 * executed) are NOT part of it — the eve mount mints both natively, exactly as
 * pickPermittedTools always exempted them.
 *
 * Dependency-free on purpose (read-tool-names.ts + the registry only), so the
 * membership tests can run without the server import graph.
 */
import {
  ASSIST_ONLY_EXCLUDED_TOOLS,
  LIVE_AGENT_CORE_READ_TOOLS,
  LIVE_AGENT_READ_TOOLS,
  LIVE_COPILOT_ONLY_TOOLS,
  LIVE_NOTES_EXCLUDED_TOOLS,
  LIVE_MCP_TOOL_PREFIX,
  PAIRED_COPILOT_ONLY_TOOLS,
  narrowReadToolsByAgent,
  type AgentToolSelection,
} from './read-tool-names'
import { isChatNativeTool } from '@/lib/ai/tool-registry'
import { CALL_CAPTURE_READ_TOOLS, CALL_CAPTURE_STAGING_TOOLS, callCaptureFenceApplies } from './call-capture-fence'
import { attendedOnlyToolsDeniedTo } from '@/lib/safety/caller'

/**
 * The three live-agent turn types — the mode × live_role cross product the
 * cloud route resolves before it does anything else:
 *   - 'copilot': a live turn by the capture's live agent (may be assist-only)
 *   - 'notes':   the PAIRED note-taker's live turn (writes the record, never talks)
 *   - 'batch':   end-of-meeting / Reprocess / evals — one pass over the whole call
 */
export type LiveAgentTurnType = 'copilot' | 'notes' | 'batch'

export const LIVE_AGENT_TURN_TYPES: readonly LiveAgentTurnType[] = ['copilot', 'notes', 'batch']

/** The booleans the route derives from a turn type (route.ts's own names). */
export function liveTurnFlags(turnType: LiveAgentTurnType): {
  isBatch: boolean
  notesRole: boolean
  writesRecord: boolean
} {
  const isBatch = turnType === 'batch'
  const notesRole = turnType === 'notes'
  return { isBatch, notesRole, writesRecord: isBatch || notesRole }
}

/**
 * The route's request fields → turn type. `live_role` is ignored in batch mode
 * (and defaults to 'copilot'), exactly as the route has always read it.
 */
export function liveTurnTypeFromRequest(
  mode: 'live' | 'batch' | undefined,
  liveRole: 'copilot' | 'notes' | undefined,
): LiveAgentTurnType {
  if (mode === 'batch') return 'batch'
  return liveRole === 'notes' ? 'notes' : 'copilot'
}

/**
 * Every staging tool `createLiveAgentTools` builds, in its key order. Pinned to
 * the real factory's keys by __tests__/ceiling.test.ts (both directions), so a
 * new staging tool can't slip into the map without being named here.
 *
 * Three of these are hand-rolled READ resolvers, not write tools
 * (search_projects, search_contacts, get_project_details — the live-only half of
 * LIVE_AGENT_RESOLVER_TOOL_NAMES in tool-registry.ts).
 */
export const LIVE_AGENT_STAGING_TOOL_NAMES: readonly string[] = [
  'propose_change',
  'say_to_user',
  'ask_user',
  'edit_proposal',
  'dismiss_proposal',
  'record_commitment',
  'search_projects',
  'search_contacts',
  'propose_mcp_call',
  'get_project_details',
  'set_capture_title',
  'write_summary',
  'update_summary',
  'direct_notes',
  'load_skill',
]

/**
 * The two resolver READS every live turn is granted whatever the persona's tool
 * selection says: the agent resolves assignees and labels with them before it
 * proposes an action, so a narrowed persona must not lose them. They used to be
 * hand-rolled copies inside createLiveAgentTools (and so part of the
 * never-narrowed staging half); those copies were shadowed by the registry read
 * tools of the same names and have been deleted. The REGISTRY implementation
 * (buildLiveAgentReadTools) serves them now, on every turn — including one whose
 * persona narrowed them out of the read allowlist below. Neither is in either
 * exclusion set, so no turn type withholds them.
 */
export const LIVE_AGENT_PINNED_READ_TOOL_NAMES: readonly string[] = ['list_workspace_members', 'list_labels']

export interface LiveAgentCeilingInput {
  turnType: LiveAgentTurnType
  /** The RESOLVED persona is assist-only. Only ever true on a copilot turn. */
  assistOnly: boolean
  /**
   * The turn's tool selection — `personaToolSelection(recipe)`: the resolved
   * persona row's agent_config (null → core-only), or the built-in Assistant's
   * inherit-all selection when no persona row resolved.
   */
  agentConfig: AgentToolSelection | null | undefined
  /**
   * The turn's read-only lookups in the person's connected apps
   * (`mcp__<server>__<tool>`, ./mcp-lookups.ts), re-derived by the caller from
   * the live rows. Discoverable through search_tools, never in the core set.
   * Honored on a copilot turn only, and only for an `mcp__` name.
   */
  mcpLookups?: readonly string[]
  /**
   * The turn is on a call's capture (./call-capture-fence.ts: read from the
   * capture row, never the request): it keeps only what writing the shared
   * notes needs.
   */
  callCapture?: boolean
}

export interface LiveAgentCeiling {
  /** The permitted staging tool names, in LIVE_AGENT_STAGING_TOOL_NAMES order. */
  staging: string[]
  /** LIVE_AGENT_PINNED_READ_TOOL_NAMES — granted on every turn, never narrowed. */
  pinnedReads: string[]
  /** The agent-narrowed read allowlist. */
  read: Set<string>
  /** The connected-app lookups this turn may call (empty off a copilot turn). */
  mcpLookups: Set<string>
  /** staging ∪ pinnedReads ∪ read ∪ mcpLookups — the full callable surface for this turn. */
  ceiling: Set<string>
}

/**
 * The structural ceiling for one live-agent turn.
 *
 *   - ASSIST-ONLY (copilot only): every tool that writes the RECORD is withheld
 *     (ASSIST_ONLY_EXCLUDED_TOOLS) — the agent keeps the talk tools + reads.
 *   - NOTES: the mirror strip — the talk tools (say_to_user, ask_user) are
 *     withheld so two agents on one call can't both speak.
 *   - Only an assist-only turn holds the relay to the note-taker
 *     (PAIRED_COPILOT_ONLY_TOOLS): every other turn writes the record itself.
 *   - Only a copilot turn holds load_skill (LIVE_COPILOT_ONLY_TOOLS): the
 *     call playbook says what to tell the person, and the note-taker and the
 *     batch pass tell no one.
 *   - The read half is LIVE_AGENT_READ_TOOLS narrowed by the persona's
 *     enabled/disabled selection (narrowReadToolsByAgent — can only NARROW,
 *     never widen; a present-but-empty `enabled_tools: []` narrows to nothing).
 *     The staging half is never narrowed by the selection: it IS the propose-
 *     only write mechanism. Neither are the two pinned resolver reads.
 *
 * assistOnly is honored only on a copilot turn: the route's safety net makes it
 * impossible on a writer turn (batch/notes), and this keeps that true even for a
 * caller that passes it wrongly — a writer turn must never lose its write tools.
 */
export function computeLiveAgentCeiling(input: LiveAgentCeilingInput): LiveAgentCeiling {
  const { notesRole, writesRecord } = liveTurnFlags(input.turnType)
  const assistOnly = input.assistOnly && !writesRecord
  const staging = LIVE_AGENT_STAGING_TOOL_NAMES.filter((name) => {
    if (assistOnly && ASSIST_ONLY_EXCLUDED_TOOLS.has(name)) return false
    if (notesRole && LIVE_NOTES_EXCLUDED_TOOLS.has(name)) return false
    if (!assistOnly && PAIRED_COPILOT_ONLY_TOOLS.has(name)) return false
    if (input.turnType !== 'copilot' && LIVE_COPILOT_ONLY_TOOLS.has(name)) return false
    return true
  })
  const pinnedReads = [...LIVE_AGENT_PINNED_READ_TOOL_NAMES]
  const read = narrowReadToolsByAgent(input.agentConfig, LIVE_AGENT_READ_TOOLS)
  // Only the main chat runs a chat-native tool (start_helper, the relay). The read
  // allowlist has none today; this keeps one from ever entering the ceiling.
  for (const name of read) if (isChatNativeTool(name)) read.delete(name)
  // Nor a bot's attended-only write (bots v3 Phase 5): the live agent never
  // holds one. A live turn is unattended (caller.ts), and the trust authority
  // denies that class every attended-only tool.
  for (const name of attendedOnlyToolsDeniedTo('agent_unattended')) read.delete(name)
  // Connected-app lookups: a copilot turn only (the note-taker and the batch
  // write the record; their job is not a live answer), and only by prefix, so
  // a caller can never smuggle a workspace tool in through this list.
  const mcpLookups = new Set<string>(
    input.turnType === 'copilot'
      ? (input.mcpLookups ?? []).filter((name) => name.startsWith(LIVE_MCP_TOOL_PREFIX))
      : [],
  )
  // A call's capture: the record's own writers and three structural reads, nothing else
  // (./call-capture-fence.ts says why, and what it costs). Applied last, so it only narrows.
  if (input.callCapture && callCaptureFenceApplies(input.turnType)) {
    const fencedStaging = staging.filter((name) => CALL_CAPTURE_STAGING_TOOLS.has(name))
    const fencedPinned = pinnedReads.filter((name) => CALL_CAPTURE_READ_TOOLS.has(name))
    const fencedRead = new Set([...read].filter((name) => CALL_CAPTURE_READ_TOOLS.has(name)))
    return {
      staging: fencedStaging,
      pinnedReads: fencedPinned,
      read: fencedRead,
      mcpLookups: new Set<string>(),
      ceiling: new Set<string>([...fencedStaging, ...fencedPinned, ...fencedRead]),
    }
  }
  return {
    staging,
    pinnedReads,
    read,
    mcpLookups,
    ceiling: new Set<string>([...staging, ...pinnedReads, ...read, ...mcpLookups]),
  }
}

/**
 * The tools advertised from the FIRST model call (the rest of the ceiling is
 * discovered through search_tools): every permitted staging tool, the pinned
 * resolver reads, the core reads, and — when the call has a non-empty
 * attached-package manifest — get_package, so the pull the manifest asks for
 * needs no discovery round-trip. Every entry is clamped to the ceiling (a core
 * read the persona narrowed away stays away) and listed once. search_tools and
 * web_search are never here: eve mints those natively.
 */
export function computeLiveAgentCoreToolNames(
  ceiling: LiveAgentCeiling,
  hasPackageManifest: boolean,
): string[] {
  const names = [
    ...ceiling.staging,
    ...ceiling.pinnedReads,
    ...LIVE_AGENT_CORE_READ_TOOLS,
    ...(hasPackageManifest ? ['get_package'] : []),
  ].filter((name) => ceiling.ceiling.has(name))
  return [...new Set(names)]
}
