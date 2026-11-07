/**
 * The settings surface's write side for `workspace.settings.agent_autonomy`
 * (plan Part 5 row 9, follow-up §B.4 PR 5): validating what the page sends,
 * merging it over the stored policy, and the one read-modify-write both the
 * policy PATCH and "Resume role" go through.
 *
 * The normaliser (agent-autonomy-policy.ts) stays the reader's safety net: it
 * turns a malformed stored blob into a safe policy. The page gets a stricter
 * contract: a bad number is a 400 naming the field, never a silent fall back to
 * 'propose' that the person would read as "saved".
 */
import { DELEGABLE_WORK_ROLES, type WorkRole } from './roles'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AGENT_AUTONOMY_MODES,
  AGENT_AUTONOMY_NUMERIC_KEYS,
  isConfidence,
  normalizeAgentAutonomyPolicy,
  resolveAgentAutonomyPolicyFromSettings,
  type AgentAutonomyMode,
  type AgentAutonomyPolicy,
} from './agent-autonomy-policy'

/**
 * The origins switching autonomy 'off' stops (the kill switch's cancel fan-out,
 * cancel-workspace-runs.ts): work nobody pressed Start on. Attempts now, and
 * delegations once they exist (step 13). A person's own runs are theirs to stop.
 */
export const AUTONOMY_OFF_ORIGINS = ['attempt', 'delegation', 'chat'] as const

/** The fields a settings PATCH may set. `role_breaker_resumed_at` is Resume's alone. */
export type AgentAutonomyPatch = Partial<Omit<AgentAutonomyPolicy, 'role_breaker_resumed_at'>>

/** Upper bounds on what the page may set; the gate has none of its own. */
export const AGENT_AUTONOMY_MAX: Record<(typeof AGENT_AUTONOMY_NUMERIC_KEYS)[number], number> = {
  max_chat_delegations_per_day: 500,
  max_chat_delegations_per_conversation: 500,
  max_attempts_per_capture: 20,
  max_attempts_per_day: 500,
  max_attempts_per_root: 20,
  max_delegation_depth: 5,
  max_fan_out: 10,
  role_breaker_window: 20,
  role_breaker_quiet_days: 90,
}

export function validateAgentAutonomyPatch(
  raw: unknown,
): { ok: true; patch: AgentAutonomyPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Expected a `policy` object' }
  const body = raw as Record<string, unknown>
  const patch: AgentAutonomyPatch = {}
  if (body.mode !== undefined) {
    if (typeof body.mode !== 'string' || !(AGENT_AUTONOMY_MODES as readonly string[]).includes(body.mode)) {
      return { ok: false, error: `mode must be one of ${AGENT_AUTONOMY_MODES.join(', ')}` }
    }
    patch.mode = body.mode as AgentAutonomyMode
  }
  if (body.chat_can_delegate_to !== undefined) {
    if (!Array.isArray(body.chat_can_delegate_to) || !body.chat_can_delegate_to.every((r) => DELEGABLE_WORK_ROLES.includes(r))) {
      return { ok: false, error: 'chat_can_delegate_to must contain only researcher, writer and correspondent' }
    }
    patch.chat_can_delegate_to = [...new Set(body.chat_can_delegate_to)] as WorkRole[]
  }
  if (body.attempt_min_confidence !== undefined) {
    if (body.attempt_min_confidence !== null && !isConfidence(body.attempt_min_confidence)) {
      return { ok: false, error: 'attempt_min_confidence must be a number from 0 to 1, or null for the flow’s own bar' }
    }
    patch.attempt_min_confidence = body.attempt_min_confidence
  }
  for (const key of AGENT_AUTONOMY_NUMERIC_KEYS) {
    const v = body[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > AGENT_AUTONOMY_MAX[key]) {
      return { ok: false, error: `${key} must be a whole number from 0 to ${AGENT_AUTONOMY_MAX[key]}` }
    }
    patch[key] = v
  }
  return { ok: true, patch }
}

/** The patch over the stored policy. The stored resumes always survive. */
export function mergeAgentAutonomyPolicy(current: AgentAutonomyPolicy, patch: AgentAutonomyPatch): AgentAutonomyPolicy {
  return normalizeAgentAutonomyPolicy({ ...current, ...patch, role_breaker_resumed_at: current.role_breaker_resumed_at })
}

/**
 * Read the workspace's settings, let `next` compute the new policy from the
 * stored one, and write it back, leaving every other settings key intact.
 *
 * On the SERVICE client, after the caller's owner/admin gate: `workspace`
 * UPDATE is owner-only under RLS (migration 013), so an admin's session write
 * would update 0 rows and report success (the compute and trust routes make the
 * same choice). `.select('id')` turns a 0-row write into an error.
 *
 * Read-modify-write, like its sibling settings routes: two writes racing on the
 * same workspace can lose one. The page writes one field at a time.
 */
export async function writeAgentAutonomyPolicy(
  service: SupabaseClient,
  workspaceId: string,
  next: (current: AgentAutonomyPolicy) => AgentAutonomyPolicy,
): Promise<{ previous: AgentAutonomyPolicy; policy: AgentAutonomyPolicy } | { error: string }> {
  const { data, error } = await service.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { error: 'Workspace not found' }
  const settings = ((data as { settings?: unknown }).settings ?? {}) as Record<string, unknown>
  const previous = resolveAgentAutonomyPolicyFromSettings(settings)
  const policy = next(previous)
  const { data: updated, error: writeErr } = await service
    .from('workspace')
    .update({ settings: { ...settings, agent_autonomy: policy } })
    .eq('id', workspaceId)
    .select('id')
  if (writeErr) return { error: writeErr.message }
  if (!updated || (updated as unknown[]).length === 0) return { error: 'The autonomy policy update affected no rows' }
  return { previous, policy }
}
