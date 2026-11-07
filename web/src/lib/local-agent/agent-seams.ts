/**
 * Where C1 (the Mac body's server access, docs/plans/teammate-agent.md) meets
 * the workstreams built beside it: C4's teammate tools (WS-C) and L5's
 * unattended review (WS-D, src/lib/local-agent/unattended.ts), both wired.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

// ── C4 (WS-C): the Mac body's teammate tools ────────────────────────────────
// `message_teammate`, a message to the cloud body, and `report_to_person`, a
// note in the session's own thread. On the Mac body only: in its ceiling, its
// spec's ceilingTools and coreToolNames, and dispatched by its tool route with
// no reviewer (neither writes outside Dial8; each keys on eve's ids).
export {
  isMacTeammateTool as isMacNativeTool,
  macTeammateToolEntries as macNativeToolEntries,
  runMacTeammateTool as runMacNativeTool,
  type MacBodyContext,
  type MacTeammateLaunch as MacNativeLaunch,
  type MacTeammateToolResult as MacNativeToolResult,
} from '@/lib/chat/local-agent-tools'

// ── L5 (WS-D): a job a loop started ─────────────────────────────────────────
// Null for a job the person (or their typed chat turn) started. For a job a
// loop started: its class, and the reviewer's evidence (the loop step's
// SAVED request, never the rendered text), blocking, on the loop's run; or a
// refusal (the kill switch or the pause reached it: it is asked to stop).
export {
  unattendedToolReview,
  type UnattendedToolRefusal,
  type UnattendedToolReview,
} from '@/lib/local-agent/unattended'
