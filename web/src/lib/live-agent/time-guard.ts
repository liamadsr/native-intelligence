/**
 * The live agent's TIME GUARD: research that lands after the moment has passed
 * is worse than silence, so a slow copilot tick stops researching and a stale
 * nudge is dropped. Pure arithmetic over the run token's claims (no DB read),
 * run by POST /api/internal/live-agent/tool before it executes a tool.
 *
 *   - past LIVE_RESEARCH_CUTOFF_MS a READ tool (LIVE_AGENT_READ_TOOLS) is
 *     refused with an ordinary tool result (not an error, so nothing retries
 *     it), on an ASSIST-ONLY copilot only: that turn only talks, so research
 *     past the moment is all it could be doing. A copilot that is not
 *     assist-only also writes the record (directives.ts turnWritesRecord), and
 *     its prompt resolves assignees with list_workspace_members and dedupes
 *     with list_actions; refusing those (and telling it to stay silent) would
 *     end the turn before it staged what it heard, so it keeps its reads.
 *     say_to_user and the staging/write tools always run. A connected-app
 *     lookup (`mcp__*`, ./mcp-lookups.ts) is a read too: refused by the same
 *     rule when its name is in the turn's lookup catalog (prefix AND
 *     membership, so the prefix alone never decides).
 *   - past LIVE_NUDGE_EXPIRY_MS say_to_user is dropped as stale on EVERY
 *     copilot tick: no chat row, no broadcast, so the "already told them" list
 *     never holds a nudge the person never saw.
 *
 * Copilot ticks only. A record turn is a person's own directive (they are
 * waiting on it, and it has its own 40 s deadline), the batch reads the whole
 * meeting after it ended, and the paired note-taker never speaks (its reads
 * serve the record, which has no moment to miss).
 *
 * Only the SERVER clock is ever compared: the client sends the window's AGE
 * (taken just before its fetch), and the route turns it into a server-clock
 * flush time (windowStartFromAge). A client clock that runs slow or fast can
 * never make every nudge look stale.
 *
 * web_search is eve's provider-executed tool and never reaches the tool route,
 * so it is outside this guard (the tick's 75 s deadline still bounds it).
 *
 * Dependency-free (names and constants only), so the tests import it bare.
 */
import type { LiveAgentTurnType } from './ceiling'
import { LIVE_AGENT_READ_TOOLS, LIVE_MCP_TOOL_PREFIX } from './read-tool-names'
import { LIVE_NUDGE_EXPIRY_MS, LIVE_RESEARCH_CUTOFF_MS, type LiveTurnKind } from './turn-budget'

/** What the model reads when a read tool is refused past the research cutoff. */
export const TIME_UP_MESSAGE = 'This moment has passed. Say what you have now in one line, or stay silent.'

/** What the model reads when its nudge is dropped as stale. */
export const STALE_NUDGE_MESSAGE =
  'Not shown: the moment this was for has passed. Do not send it again; stay silent unless something new comes up.'

export type LiveTimeGuardVerdict =
  | { action: 'run' }
  | { action: 'refuse'; ageMs: number; output: { refused: 'time_up'; message: string } }
  | { action: 'drop'; ageMs: number; output: { dropped: 'stale'; delivered: false; message: string } }

/**
 * The guard's verdict for one tool call.
 *
 * @param windowStartedAt epoch ms the window's clock starts at: the client's
 *                        flush time, else the turn's start
 *                        (live-agent-run-token.ts liveWindowStartedAt)
 */
export function liveTimeGuard(a: {
  toolName: string
  turnKind: LiveTurnKind | undefined
  turnType: LiveAgentTurnType
  /** The resolved persona is assist-only: the turn talks and writes nothing. */
  assistOnly: boolean
  /** The turn's connected-app lookup names (the ceiling's mcpLookups). */
  mcpLookups?: ReadonlySet<string>
  windowStartedAt: number
  now: number
}): LiveTimeGuardVerdict {
  if (a.turnKind !== 'tick' || a.turnType !== 'copilot') return { action: 'run' }
  const ageMs = Math.max(0, a.now - a.windowStartedAt)
  if (a.toolName === 'say_to_user') {
    return ageMs > LIVE_NUDGE_EXPIRY_MS
      ? { action: 'drop', ageMs, output: { dropped: 'stale', delivered: false, message: STALE_NUDGE_MESSAGE } }
      : { action: 'run' }
  }
  const isRead =
    LIVE_AGENT_READ_TOOLS.has(a.toolName) ||
    (a.toolName.startsWith(LIVE_MCP_TOOL_PREFIX) && a.mcpLookups?.has(a.toolName) === true)
  if (a.assistOnly && ageMs > LIVE_RESEARCH_CUTOFF_MS && isRead) {
    return { action: 'refuse', ageMs, output: { refused: 'time_up', message: TIME_UP_MESSAGE } }
  }
  return { action: 'run' }
}

/** The oldest a client-reported window age may be before it is clamped. */
export const WINDOW_AGE_MAX_MS = 10 * 60 * 1000

/**
 * A window's flush time on the SERVER clock, from the age the client measured
 * on its own clock just before the fetch (`window_age_ms`): `now` minus the
 * age clamped to [0, WINDOW_AGE_MAX_MS]. Undefined for anything that is not a
 * finite number (absent, a string, NaN, garbage). Ages never compare two
 * clocks, so client clock skew cannot reach the guard.
 */
export function windowStartFromAge(rawAgeMs: unknown, now: number): number | undefined {
  if (typeof rawAgeMs !== 'number' || !Number.isFinite(rawAgeMs)) return undefined
  return now - Math.min(WINDOW_AGE_MAX_MS, Math.max(0, Math.round(rawAgeMs)))
}
