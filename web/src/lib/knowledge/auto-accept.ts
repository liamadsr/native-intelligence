/**
 * Auto-accept policy — confidence-gated promotion of AI suggestions.
 *
 * Today the AI produces a confidence score for claims, actions, and decisions
 * but it gates nothing: every suggestion sits in a manual review queue. This
 * module turns confidence into a control signal. When a workspace enables
 * auto-accept and an item's confidence clears the per-type threshold, the item
 * is created already-confirmed (claims) or applied (action items) — while
 * everything stays fully reversible (the user can un-accept, dismiss, delete).
 *
 * Policy lives in `workspace.settings.auto_accept_policy` (a jsonb blob on the
 * existing settings column — no new table, member-readable via RLS). Missing or
 * partial policy falls back to DEFAULT_POLICY, so the feature is on by default
 * with conservative thresholds and a single `enabled` kill-switch.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveTrustPolicy,
  resolveTrustPolicyFromSettings,
  type TrustPolicy,
} from '@/lib/proposed-changes/trust-policy'

export type AutoAcceptKind = 'claims' | 'actions' | 'decisions'

export interface AutoAcceptPolicy {
  /** Master kill-switch. When false, nothing auto-accepts regardless of thresholds. */
  enabled: boolean
  /** Per-type confidence thresholds in [0,1]. An item with confidence >= threshold auto-accepts. */
  claims: number
  actions: number
  decisions: number
  /**
   * Whether to auto-apply suggestions with EXTERNAL side effects (send_email,
   * mcp_call to Jira/Linear/etc.). Off by default — firing an email/ticket from
   * confidence alone is risky; those wait for an explicit human click.
   */
  allow_external: boolean
}

/**
 * Conservative defaults. Tuned so only clearly-explicit extractions clear the
 * bar — the AI calibrates "how explicit was the source" into confidence, and
 * 0.80–0.85 corresponds to "the source stated this directly". A workspace can
 * raise these (stricter) or lower them (more aggressive) via settings.
 */
export const DEFAULT_POLICY: AutoAcceptPolicy = {
  enabled: true,
  claims: 0.85,
  actions: 0.8,
  decisions: 0.85,
  allow_external: false,
}

/** Clamp an unknown value into a [0,1] threshold, falling back to `fallback`. */
function threshold(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return fallback
  return Math.min(1, Math.max(0, v))
}

/**
 * Merge a raw settings blob into a complete, validated policy. Defensive: any
 * shape of garbage in `settings.auto_accept_policy` degrades to DEFAULT_POLICY
 * field-by-field rather than throwing.
 */
export function normalizePolicy(raw: unknown): AutoAcceptPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLICY }
  const p = raw as Record<string, unknown>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_POLICY.enabled,
    claims: threshold(p.claims, DEFAULT_POLICY.claims),
    actions: threshold(p.actions, DEFAULT_POLICY.actions),
    decisions: threshold(p.decisions, DEFAULT_POLICY.decisions),
    allow_external:
      typeof p.allow_external === 'boolean'
        ? p.allow_external
        : DEFAULT_POLICY.allow_external,
  }
}

/**
 * Read the effective auto-accept policy for a workspace. Never throws — on any
 * error (missing row, RLS, network) it returns DEFAULT_POLICY so callers can
 * treat the result as authoritative without try/catch. Works with both a
 * user-session client (RLS) and a service-role client (extraction jobs).
 *
 * @deprecated for the CLAIM auto-accept path — use resolveClaimsAutoAcceptPolicy,
 * which reads the ONE trust policy (One Accept Authority, W-2). Still the reader
 * for anything genuinely on the flat legacy shape, but the claim consumers
 * (tools.ts record_commitment, claim-extraction, knowledge-weaver) have moved
 * off it (PR-2). No runtime claim consumer should call this after that move.
 */
export async function resolveAutoAcceptPolicy(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AutoAcceptPolicy> {
  try {
    const { data } = await supabase
      .from('workspace')
      .select('settings')
      .eq('id', workspaceId)
      .maybeSingle()
    const settings = (data?.settings ?? {}) as Record<string, unknown>
    return normalizePolicy(settings.auto_accept_policy)
  } catch {
    return { ...DEFAULT_POLICY }
  }
}

/**
 * Resolve the CLAIM auto-accept policy from the ONE workspace trust policy (One
 * Accept Authority, PR-2). Claims don't go through proposed_change / the shared
 * gate, so they keep the flat AutoAcceptPolicy shape the claim consumers
 * (shouldAutoAccept / shouldPromoteByCorroboration) already read — but the SOURCE
 * is now `settings.trust_policy` (via resolveTrustPolicy), NOT the legacy
 * `settings.auto_accept_policy`. This retires the last runtime reader of the
 * legacy key (nothing writes it any more).
 *
 * Only the claims-relevant fields are projected:
 *   - enabled     ← master kill-switch AND the claims class's own enabled flag
 *                   (either OFF means claims don't auto-accept).
 *   - claims      ← trust_policy.claims.min_confidence.
 *   - actions/decisions/allow_external are filled from the claims rule / false so
 *     the shape is complete, but the claim path only reads `enabled` + `claims`.
 *
 * Never throws (resolveTrustPolicy is fail-open → DEFAULT_TRUST_POLICY). Works
 * with a user-session or service-role client.
 */
export async function resolveClaimsAutoAcceptPolicy(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AutoAcceptPolicy> {
  return projectClaimsPolicy(await resolveTrustPolicy(supabase, workspaceId))
}

/**
 * The PURE half of `resolveClaimsAutoAcceptPolicy`: given an already-read
 * `workspace.settings` blob, project the claims policy out of the trust policy
 * it contains. Never throws (both halves are total functions over garbage).
 *
 * Exists so a caller holding the settings row — the live-agent turn path, which
 * also needs the trust policy and the workspace edition off that SAME row — can
 * derive all three from one read instead of three serial `select('settings')`
 * round-trips on a route that fires every ~3s during a recording.
 */
export function resolveClaimsAutoAcceptPolicyFromSettings(settings: unknown): AutoAcceptPolicy {
  return projectClaimsPolicy(resolveTrustPolicyFromSettings(settings))
}

/** The one projection from a resolved trust policy to the flat claims shape, so
 *  the fetching and settings-accepting variants can never disagree. */
function projectClaimsPolicy(trust: TrustPolicy): AutoAcceptPolicy {
  return {
    // Either the master switch or the claims class being off means claims wait.
    enabled: trust.enabled && trust.claims.enabled,
    claims: trust.claims.min_confidence,
    // Claims read only `enabled` + `claims`; the rest complete the shape.
    actions: trust.actions.min_confidence,
    decisions: trust.decisions.min_confidence,
    allow_external: trust.allow_external,
  }
}

/**
 * The core decision. Returns true when an item of `kind` with the given
 * confidence should be auto-accepted under `policy`.
 *
 * A NULL/undefined confidence never auto-accepts — we only promote items the
 * model was willing to score. (Decision-mirrored claims and some agent-created
 * claims carry null confidence; those correctly stay in review.)
 */
export function shouldAutoAccept(
  kind: AutoAcceptKind,
  confidence: number | null | undefined,
  policy: AutoAcceptPolicy,
): boolean {
  if (!policy.enabled) return false
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return false
  return confidence >= policy[kind]
}

/** Distinct evidence rows required before corroboration can promote a claim. */
export const CORROBORATION_MIN_SOURCES = 2

/**
 * How far below the per-type threshold corroboration reaches. Independent
 * re-assertion is itself evidence, so a multiply-sourced claim clears a
 * slightly lower confidence bar than a single-source one.
 */
export const CORROBORATION_CONFIDENCE_SLACK = 0.15

/**
 * Corroboration-based promotion: a `suggested` claim that has accumulated
 * several distinct evidence rows (the same fact asserted by independent
 * sources) gets promoted at a relaxed threshold. Same doctrine as
 * shouldAutoAccept otherwise: the kill-switch wins, and unscored (null
 * confidence) claims stay in review no matter how many sources they have.
 */
export function shouldPromoteByCorroboration(
  kind: AutoAcceptKind,
  confidence: number | null | undefined,
  distinctSources: number,
  policy: AutoAcceptPolicy,
): boolean {
  if (!policy.enabled) return false
  if (distinctSources < CORROBORATION_MIN_SOURCES) return false
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return false
  return confidence >= policy[kind] - CORROBORATION_CONFIDENCE_SLACK
}
