/**
 * One kill switch (A5 slice 5; docs/plans/always-on-agent.md §6 "One kill
 * switch for everything"). A workspace whose `settings.agent_autonomy.mode` is
 * 'off' has its agent paused: nothing the agent starts on its own runs.
 *
 * The switch is the existing autonomy policy (owner/admin only, PATCH
 * /api/account/workspace/agent-autonomy). Turning it off cancels in-flight
 * work runs and expires pending approvals (the off fan-out,
 * workspace-autonomy-functions.ts → stopPausedWorkspaceExtras), and
 * delegations refuse AUTONOMY_OFF in their RPC. These doors ask the switch
 * before they act:
 *   - flow_dispatch: the three flow dispatchers (src/lib/inngest/flow-functions.ts),
 *     before runFlow: status-change, schedule/calendar and capture-processed
 *     fires. The scheduler (cron/flow-schedule) emits as usual, so every paused
 *     fire is recorded here as a skip (ledgerPausedFires, at most one row per
 *     flow per hour);
 *   - skill_run_tool: an unattended loop run's tool calls
 *     (/api/internal/skill-run/tool). A loop already running when the switch
 *     flips loses every tool at its next call, which is how a running loop
 *     session stops (its eve session id is never stored while it runs);
 *   - email_pass: the 05:00 email pass (cron/email-management), before it
 *     drafts (sync and contact linking keep running: they act on nothing);
 *   - helper_start: start_helper (src/lib/chat/start-helper.ts), through
 *     helperStartPaused;
 *   - router: the A6 event router's entry, through routerPaused;
 *   - manual_fire: a person's own Run now on a loop (flows/[id]/fire) is
 *     refused up front with a clear error, since every tool the run would call
 *     is refused anyway.
 *
 * What it deliberately does NOT stop (Liam's default, morning-decisions A5):
 * sequence sends the person launched, idle compaction, the capture pass and
 * knowledge extraction. They are the person's own acts or housekeeping. A
 * work item's Start and a chat ask are the person's and are not gated here.
 *
 * FAIL OPEN on a failed read, with a log line. Why, for a safety switch:
 *   - the read is one row on `workspace`; when it fails, the door's own reads
 *     and writes (flow, flow_run, tracked_job, email_draft) on the same
 *     database almost always fail too, so failing open rarely lets anything
 *     through that could otherwise have run;
 *   - failing closed would turn every settings-read blip into silently skipped
 *     loops and a lost morning of drafts, with no cause anyone can see;
 *   - the switch's hard stops do not depend on this read: turning it off
 *     cancels in-flight work runs through its own fan-out
 *     (cancel-workspace-runs.ts), and delegation re-reads the policy inside
 *     its RPC.
 * It matches resolveAgentAutonomyPolicy, whose failed read is 'propose' (no
 * unattended first passes, but not paused). readAgentPausedState keeps the three states apart
 * for a caller that wants to tell "could not read" from "on": the doors that
 * SPEND MONEY on their own read it and fail CLOSED ('unknown' counts as
 * paused): the mail arrival drafts, the 05:00 safety net's drafting, the
 * router, home turns, the daily digest and meeting prep (A6 review). A pass
 * skipped on a blip is caught by the next one.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAgentAutonomyPolicyFromSettings } from './agent-autonomy-policy'

/** The unattended doors that ask the switch (see the header). */
export type AgentPauseDoor =
  | 'flow_dispatch'
  | 'skill_run_tool'
  | 'email_pass'
  | 'helper_start'
  | 'router'
  | 'manual_fire'
  | 'flow_step'

/** 'unknown': the settings row could not be read. */
export type AgentPausedState = 'paused' | 'active' | 'unknown'

/** What a refused door tells the model or the ledger. */
export const AGENT_PAUSED_REASON = 'Agent work is switched off for this workspace (autonomy off)'

/** The code a refusing door returns, so callers and tests match one string. */
export const AGENT_PAUSED_CODE = 'AGENT_PAUSED'

/** Read the switch: 'paused' when `agent_autonomy.mode` is 'off'. Never throws. */
export async function readAgentPausedState(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AgentPausedState> {
  try {
    const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
    if (error) return 'unknown'
    const settings = (data as { settings?: unknown } | null)?.settings ?? null
    return resolveAgentAutonomyPolicyFromSettings(settings).mode === 'off' ? 'paused' : 'active'
  } catch {
    return 'unknown'
  }
}

/**
 * Whether the workspace's agent is paused. Fails open on a failed read (see the
 * header), logging which door could not tell.
 */
export async function isAgentPaused(
  supabase: SupabaseClient,
  workspaceId: string,
  door?: AgentPauseDoor,
): Promise<boolean> {
  const state = await readAgentPausedState(supabase, workspaceId)
  if (state === 'unknown') {
    console.warn('[agent-paused] could not read the kill switch; continuing', { workspaceId, door: door ?? null })
  }
  return state === 'paused'
}

/**
 * The door-shaped call: true when the door must not act, logging the refusal
 * once so a paused workspace's quiet loops have a visible cause.
 */
export async function checkAgentPaused(
  supabase: SupabaseClient,
  workspaceId: string,
  door: AgentPauseDoor,
  opts: { failClosed?: boolean } = {},
): Promise<boolean> {
  const paused = opts.failClosed ? (await readAgentPausedState(supabase, workspaceId)) !== 'active' : await isAgentPaused(supabase, workspaceId, door)
  if (paused) console.info('[agent-paused] refused', { workspaceId, door, ...(opts.failClosed ? { failClosed: true } : {}) })
  return paused
}

/**
 * A4's helper start asks this before it starts a helper (start_helper is not on
 * this branch yet). Refuse with AGENT_PAUSED_CODE / AGENT_PAUSED_REASON.
 */
export function helperStartPaused(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  return checkAgentPaused(supabase, workspaceId, 'helper_start')
}

/**
 * The A6 router's entry asks this before an event reaches the agent. It FAILS
 * CLOSED (A6 review): past it the router calls Jev and asks for home turns,
 * both of which spend money. Paused rows route quiet and are never terminal,
 * so a blip costs nothing: the away section and the digest still show them.
 */
export function routerPaused(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  return checkAgentPaused(supabase, workspaceId, 'router', { failClosed: true })
}

/**
 * A per-tick memo for doors that loop over many rows of a few workspaces (the
 * email pass): one checkAgentPaused per workspace per tick.
 */
export function agentPausedCache(
  supabase: SupabaseClient,
  door: AgentPauseDoor,
  opts: { failClosed?: boolean } = {},
): (workspaceId: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>()
  return (workspaceId) => {
    let paused = seen.get(workspaceId)
    if (!paused) {
      paused = checkAgentPaused(supabase, workspaceId, door, opts)
      seen.set(workspaceId, paused)
    }
    return paused
  }
}

/**
 * When autonomy flips to off, what else stops beyond the work-run cancel
 * (workspace/autonomy.off, src/lib/inngest/workspace-autonomy-functions.ts):
 *   - running loop sessions: nothing to sweep (their eve session ids are never
 *     stored while they run); the skill-run tool route refuses their next call
 *     (door skill_run_tool), so they end within one step;
 *   - pending LOOP and MCP-door approvals (A5 slice 3, `tool_approval`):
 *     expired with their cards (expirePendingApprovals), so nothing an
 *     unattended run raised before the switch can run after it (accepting one
 *     also re-checks the switch). The person's own chat-door approvals stay.
 * Returns what it did, for the Inngest step's output. Throws on a failed
 * approvals read or write, so the step retries.
 */
export async function stopPausedWorkspaceExtras(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ loopSessions: 'refused_at_next_tool_call'; approvals: 'expired' }> {
  // Loaded here, not at the top: approvals.ts pulls in the whole tool surface,
  // and the doors that import this module (start-helper among them) are part
  // of that surface. Only the off fan-out needs it.
  const { expirePendingApprovals } = await import('@/lib/safety/approvals')
  await expirePendingApprovals(supabase, workspaceId)
  return { loopSessions: 'refused_at_next_tool_call', approvals: 'expired' }
}
