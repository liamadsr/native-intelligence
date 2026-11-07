/**
 * The workspace's agent-autonomy policy — the kill switch, the attempt budgets
 * and the delegation caps — as ONE jsonb blob on `workspace.settings.agent_autonomy`
 * (docs/plans/agent-orchestration-followup.md §B.2; Sequence step 2 of
 * docs/plans/agent-orchestration-product.md).
 *
 * Normalised field-by-field to defaults exactly like the trust and auto-accept
 * policies (proposed-changes/trust-policy.ts, knowledge/auto-accept.ts): garbage degrades,
 * never throws, and an absent blob is the pure default. The default mode is
 * 'attempt' (Liam, 2026-10-17: opinionated platform, no configuration fatigue):
 * agents make a first pass on drafting work unless the workspace switched them
 * Off. The deliberate asymmetries are FAIL-CLOSED: a policy that asks for
 * `mode: 'attempt'` (stored or by default) but carries a malformed number
 * (non-finite, negative, a string, …) is answered with `mode: 'propose'`,
 * because an attempt loop whose budget cannot be read must not run unattended;
 * and a settings read that FAILS is answered the same way
 * (resolveAgentAutonomyPolicy). Absent numbers are not malformed — they take
 * the defaults.
 *
 * Read at runtime by the auto-attempt gate (Sequence step 3,
 * src/lib/work/auto-attempt.ts, under the AGENT_AUTO_ATTEMPT_ENABLED env kill
 * switch); `delegate_work` (step 13), the kill switch doors (agent-paused.ts)
 * and Settings → Autonomy are its other consumers. The kill switch's cancel
 * fan-out (`workspace/autonomy.off`, src/lib/agent-run/cancel-workspace-runs.ts)
 * is what the settings write emits when `mode` flips to 'off'.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DELEGABLE_WORK_ROLES, WORK_ROLES, type WorkRole } from './roles'

export const AGENT_AUTONOMY_MODES = ['off', 'propose', 'attempt'] as const
export type AgentAutonomyMode = (typeof AGENT_AUTONOMY_MODES)[number]

export interface AgentAutonomyPolicy {
  /**
   * The kill switch. 'attempt' (the default) = drafting work starts on its own;
   * 'off' = the agent starts nothing on its own and in-flight attempted runs are
   * cancelled; 'propose' = cards with Start only, which is what a malformed
   * policy or a failed read falls back to (Settings no longer offers it).
   */
  mode: AgentAutonomyMode
  /** Roles main chat may start; each teammate's own handoffs keep can_delegate_to. */
  chat_can_delegate_to: WorkRole[]
  /** Chat-requested root runs, separately budgeted from unattended first passes. */
  max_chat_delegations_per_day: number
  max_chat_delegations_per_conversation: number
  /**
   * The confidence a work proposal needs for an unattended attempt, in [0,1].
   * null uses the triage flow's own trust floor (min_confidence), which also
   * gates auto-applying board actions; this lowers or raises only the attempt
   * bar.
   */
  attempt_min_confidence: number | null
  /** Attempted runs per capture. */
  max_attempts_per_capture: number
  /** Attempted runs per workspace per UTC day. */
  max_attempts_per_day: number
  /** Runs per root work item, delegations included. */
  max_attempts_per_root: number
  /** How deep a delegation chain may go (launch value 2). */
  max_delegation_depth: number
  /** How many children one run may have open at once (launch value 3). */
  max_fan_out: number
  /**
   * §B.1 row 6, the role's circuit breaker: pause a role's attempts when its
   * last N attempted items were all dismissed. ANY dismissal counts (the ledger
   * records no "opened", so read and unread dismissals are the same signal).
   * 0 disables the breaker.
   */
  role_breaker_window: number
  /**
   * The breaker's automatic reset: only attempts from the last this-many days
   * count, so a paused role tries again after a quiet period. Default 7.
   */
  role_breaker_quiet_days: number
  /**
   * The breaker's MANUAL reset, per role (ISO timestamps): attempts created
   * before a role's entry do not count. The settings surface's "Resume role"
   * action writes it (plan Part 5 row 9); the gate honours it now.
   */
  role_breaker_resumed_at: Partial<Record<WorkRole, string>>
}

/** The numeric fields, in one place, so the normaliser and the tests agree. */
export const AGENT_AUTONOMY_NUMERIC_KEYS = [
  'max_chat_delegations_per_day',
  'max_chat_delegations_per_conversation',
  'max_attempts_per_capture',
  'max_attempts_per_day',
  'max_attempts_per_root',
  'max_delegation_depth',
  'max_fan_out',
  'role_breaker_window',
  'role_breaker_quiet_days',
] as const satisfies readonly (keyof AgentAutonomyPolicy)[]

/**
 * The defaults. `mode: 'attempt'`: agents act by default (Liam, 2026-10-17:
 * opinionated platform, no configuration fatigue), within budgets that keep an
 * unattended loop cheap (one first pass per meeting, ten a day, a role pauses
 * after three dismissals in a row). Depth 2 and fan-out 3 are the launch values.
 */
export const DEFAULT_AGENT_AUTONOMY_POLICY: AgentAutonomyPolicy = Object.freeze({
  mode: 'attempt',
  chat_can_delegate_to: [...DELEGABLE_WORK_ROLES],
  max_chat_delegations_per_day: 10,
  max_chat_delegations_per_conversation: 3,
  attempt_min_confidence: null,
  max_attempts_per_capture: 1,
  max_attempts_per_day: 10,
  max_attempts_per_root: 3,
  max_delegation_depth: 2,
  max_fan_out: 3,
  role_breaker_window: 3,
  role_breaker_quiet_days: 7,
  role_breaker_resumed_at: Object.freeze({}),
})

/** A fresh copy of the defaults (the frozen resumed-at map is copied too). */
function defaultPolicy(): AgentAutonomyPolicy {
  return { ...DEFAULT_AGENT_AUTONOMY_POLICY, chat_can_delegate_to: [...DEFAULT_AGENT_AUTONOMY_POLICY.chat_can_delegate_to], role_breaker_resumed_at: {} }
}

/** A budget is a finite, non-negative integer. Anything else is malformed. */
function isBudget(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0
}

/**
 * The per-role manual reset map. Only known roles with a parseable timestamp
 * survive (stored as ISO); anything else is dropped. A bad entry never refuses
 * attempt: dropping it only makes the breaker count more, which is the safe side.
 */
function normalizeResumedAt(v: unknown): Partial<Record<WorkRole, string>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Partial<Record<WorkRole, string>> = {}
  for (const role of WORK_ROLES) {
    const raw = (v as Record<string, unknown>)[role]
    if (typeof raw !== 'string') continue
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) out[role] = new Date(ms).toISOString()
  }
  return out
}

/** A confidence bar is a finite number in [0,1]. */
export function isConfidence(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

function isMode(v: unknown): v is AgentAutonomyMode {
  return typeof v === 'string' && (AGENT_AUTONOMY_MODES as readonly string[]).includes(v)
}

/**
 * Merge a raw `agent_autonomy` blob into a complete policy. Every field falls
 * back on its own; a malformed number additionally refuses `mode: 'attempt'`
 * (→ 'propose'). 'off' is never widened: a malformed blob that says 'off'
 * stays 'off'.
 */
export function normalizeAgentAutonomyPolicy(raw: unknown): AgentAutonomyPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultPolicy()
  const p = raw as Record<string, unknown>
  const out: AgentAutonomyPolicy = { ...defaultPolicy(), role_breaker_resumed_at: normalizeResumedAt(p.role_breaker_resumed_at) }
  // A malformed explicit allowlist grants nobody; absence takes launch defaults.
  if (p.chat_can_delegate_to !== undefined) {
    out.chat_can_delegate_to = Array.isArray(p.chat_can_delegate_to) && p.chat_can_delegate_to.every((r) => DELEGABLE_WORK_ROLES.includes(r))
      ? [...new Set(p.chat_can_delegate_to)] : []
  }
  let malformed = false
  // A bad attempt bar falls back to the flow's floor (today's bar), and like a
  // bad budget it refuses 'attempt'.
  if (p.attempt_min_confidence !== undefined && p.attempt_min_confidence !== null) {
    if (isConfidence(p.attempt_min_confidence)) out.attempt_min_confidence = p.attempt_min_confidence
    else malformed = true
  }
  for (const key of AGENT_AUTONOMY_NUMERIC_KEYS) {
    const v = p[key]
    if (v === undefined) continue
    const isChatCap = key === 'max_chat_delegations_per_day' || key === 'max_chat_delegations_per_conversation'
    if (isBudget(v) && (!isChatCap || v <= 500)) out[key] = v
    else {
      malformed = true
      // The SQL admission gate refuses malformed chat caps too. Never show an
      // explicit role grant while the stored chat budget cannot be honored.
      if (isChatCap) out.chat_can_delegate_to = []
    }
  }
  const mode = isMode(p.mode) ? p.mode : DEFAULT_AGENT_AUTONOMY_POLICY.mode
  // Fail closed: an attempt policy whose budgets cannot be read is a propose policy.
  out.mode = mode === 'attempt' && malformed ? 'propose' : mode
  return out
}

/** The pure half: the policy from an already-fetched `workspace.settings` blob. */
export function resolveAgentAutonomyPolicyFromSettings(settings: unknown): AgentAutonomyPolicy {
  if (!settings || typeof settings !== 'object') return defaultPolicy()
  return normalizeAgentAutonomyPolicy((settings as Record<string, unknown>).agent_autonomy)
}

/**
 * The fetching half. Never throws. A workspace with no settings (or no
 * `agent_autonomy` key) gets the default policy, which attempts; a read that
 * FAILS gets the default numbers with `mode: 'propose'`. The default attempts,
 * so failing open here would let an unattended run start on a policy nobody
 * could read: like a malformed budget, an unreadable policy refuses attempt.
 * 'propose' is not 'off', so the kill switch doors (agent-paused.ts, which keep
 * their own read) are unaffected.
 */
export async function resolveAgentAutonomyPolicy(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AgentAutonomyPolicy> {
  try {
    const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
    if (error) return { ...defaultPolicy(), mode: 'propose' }
    return resolveAgentAutonomyPolicyFromSettings((data as { settings?: unknown } | null)?.settings ?? null)
  } catch {
    return { ...defaultPolicy(), mode: 'propose' }
  }
}
