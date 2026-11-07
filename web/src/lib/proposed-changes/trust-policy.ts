/**
 * Trust policy — the ONE workspace-level judgment authority for auto-apply
 * (One Accept Authority, W-2). "Proposals never silently become board truth.
 * Exactly one gate decides." (docs/loop-engine/NORTH-STAR.md invariant 1;
 * design docs/loop-engine/ONE-ACCEPT-AUTHORITY-DESIGN.md, D3.)
 *
 * Before this, two config surfaces judged the same mutation independently:
 * `workspace.settings.auto_accept_policy` (extraction) and per-flow `trust`
 * (verdict). They didn't know about each other — a user who tightened loop
 * trust changed nothing about the channel that files most items. This is the
 * single source: `workspace.settings.trust_policy`, resolved here, consumed by
 * the shared gate (auto-apply-gate.ts). A flow's own `trust` config overrides
 * it where set (D3).
 *
 * Cloned from the auto_accept_policy pattern
 * (src/lib/knowledge/auto-accept.ts): a jsonb
 * blob on the existing workspace.settings column — no new table, member-readable
 * via RLS — normalized field-by-field to the default so any shape of garbage
 * degrades rather than throwing, and a fail-open resolve so callers can treat
 * the result as authoritative without try/catch.
 *
 * Migration 205 folds existing auto_accept_policy values in; resolve still reads
 * the legacy key as a fallback for one release (design trap: keep old key
 * readable).
 *
 * There is no settings surface for it any more (Liam, 2026-10-17: opinionated
 * platform, no configuration fatigue): the Trust page and its write API are
 * gone, migration 354 removed every workspace's stored override, and nothing
 * writes the key. Every workspace resolves DEFAULT_TRUST_POLICY (explicit:
 * false), so external actions always wait for a person (allow_external false).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The entity classes the gate judges. Everything else stages unconditionally. */
export type TrustEntity = 'actions' | 'decisions' | 'milestones'

/** Per-entity-class trust rule: confidence floor + whether it's enabled at all. */
export interface TrustEntityRule {
  /** When false, this entity class never auto-applies (regardless of threshold). */
  enabled: boolean
  /** Confidence floor in [0,1]. An item at or above this MAY auto-apply. */
  min_confidence: number
  /**
   * D2 — require the extraction model to mark the item explicitly stated in the
   * source ("we decided X"), not inferred ("they seemed to lean toward X"),
   * before it can auto-apply. Consumed by the gate's extraction authority for
   * decisions/milestones; actions carry their own ownership/explicitness path
   * (is_mine_explicit / speaker-map + self-binding) so this stays false for them
   * to preserve today's action behavior.
   */
  require_explicit: boolean
}

export interface TrustPolicy {
  /** Master kill-switch. When false, nothing auto-applies regardless of rules. */
  enabled: boolean
  actions: TrustEntityRule
  decisions: TrustEntityRule
  milestones: TrustEntityRule
  /**
   * Knowledge claims (facts/commitments extracted into the knowledge graph).
   * NOT judged by the shared gate — claims don't go through proposed_change.
   * The claim consumers (tools.ts record_commitment, inngest
   * claim-extraction/knowledge-weaver) read this rule through
   * resolveClaimsAutoAcceptPolicy (knowledge/auto-accept.ts).
   */
  claims: TrustEntityRule
  /**
   * Whether to auto-apply proposals with EXTERNAL side effects (send_email,
   * mcp_call). Off by default — firing an email/ticket from confidence alone is
   * risky; those wait for an explicit human click. Hard-false in the verdict
   * path (allow_external is fixed there); this key governs the extraction path.
   */
  allow_external: boolean
}

/**
 * Defaults matching today's EFFECTIVE behavior (verified 2026-07-19):
 *   - actions 0.8, decisions 0.85, claims 0.85 (auto_accept_policy
 *     DEFAULT_POLICY).
 *   - milestones bucketed into the actions (0.8) threshold historically; the
 *     One-Accept track raises milestones to 0.85 alongside decisions AND gives
 *     both the D2 explicitness rule (their intended, documented change).
 *   - actions carry require_explicit:false HERE because their explicitness runs
 *     through the ownership path (is_mine_explicit for verdict; speaker-map +
 *     self-binding for extraction), not this flag — preserving action behavior.
 *   - enabled on by default with a single master kill-switch.
 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  enabled: true,
  actions: { enabled: true, min_confidence: 0.8, require_explicit: false },
  decisions: { enabled: true, min_confidence: 0.85, require_explicit: true },
  milestones: { enabled: true, min_confidence: 0.85, require_explicit: true },
  claims: { enabled: true, min_confidence: 0.85, require_explicit: false },
  allow_external: false,
}

/** Clamp an unknown value into a [0,1] threshold, falling back to `fallback`. */
function threshold(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return fallback
  return Math.min(1, Math.max(0, v))
}

/** Merge a raw entity rule against its default, field-by-field. */
function normalizeRule(raw: unknown, fallback: TrustEntityRule): TrustEntityRule {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const r = raw as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled,
    min_confidence: threshold(r.min_confidence, fallback.min_confidence),
    require_explicit:
      typeof r.require_explicit === 'boolean'
        ? r.require_explicit
        : fallback.require_explicit,
  }
}

/**
 * Merge a raw settings blob into a complete, validated policy. Defensive: any
 * shape of garbage in `settings.trust_policy` degrades to DEFAULT_TRUST_POLICY
 * field-by-field rather than throwing (mirrors normalizePolicy).
 */
export function normalizeTrustPolicy(raw: unknown): TrustPolicy {
  if (!raw || typeof raw !== 'object') return structuredCloneDefault()
  const p = raw as Record<string, unknown>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_TRUST_POLICY.enabled,
    actions: normalizeRule(p.actions, DEFAULT_TRUST_POLICY.actions),
    decisions: normalizeRule(p.decisions, DEFAULT_TRUST_POLICY.decisions),
    milestones: normalizeRule(p.milestones, DEFAULT_TRUST_POLICY.milestones),
    claims: normalizeRule(p.claims, DEFAULT_TRUST_POLICY.claims),
    allow_external:
      typeof p.allow_external === 'boolean'
        ? p.allow_external
        : DEFAULT_TRUST_POLICY.allow_external,
  }
}

/** A fresh deep copy of the default (its nested rule objects are never shared). */
function structuredCloneDefault(): TrustPolicy {
  return {
    enabled: DEFAULT_TRUST_POLICY.enabled,
    actions: { ...DEFAULT_TRUST_POLICY.actions },
    decisions: { ...DEFAULT_TRUST_POLICY.decisions },
    milestones: { ...DEFAULT_TRUST_POLICY.milestones },
    claims: { ...DEFAULT_TRUST_POLICY.claims },
    allow_external: DEFAULT_TRUST_POLICY.allow_external,
  }
}

/**
 * The legacy auto_accept_policy shape had FLAT per-type thresholds
 * ({ enabled, claims, actions, decisions, allow_external }). When a workspace
 * has only the old key (pre-migration read, or the resolve fallback), lift it
 * into the new shape so behavior is continuous. Milestones inherit the legacy
 * actions threshold with require_explicit off (their exact pre-track behavior),
 * NOT the new 0.85 default — a legacy read must reproduce what the workspace had.
 */
function liftLegacyPolicy(raw: unknown): TrustPolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const enabled = typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_TRUST_POLICY.enabled
  const actionsConf = threshold(p.actions, DEFAULT_TRUST_POLICY.actions.min_confidence)
  const decisionsConf = threshold(p.decisions, DEFAULT_TRUST_POLICY.decisions.min_confidence)
  const claimsConf = threshold(p.claims, DEFAULT_TRUST_POLICY.claims.min_confidence)
  return {
    enabled,
    actions: { enabled: true, min_confidence: actionsConf, require_explicit: false },
    // Legacy decisions had NO explicitness gate (confidence alone). Preserve
    // that on the fallback path — the D2 rule ships via the migration fold,
    // whose merge sets require_explicit deliberately, not via a legacy read.
    decisions: { enabled: true, min_confidence: decisionsConf, require_explicit: false },
    milestones: { enabled: true, min_confidence: actionsConf, require_explicit: false },
    claims: { enabled: true, min_confidence: claimsConf, require_explicit: false },
    allow_external:
      typeof p.allow_external === 'boolean'
        ? p.allow_external
        : DEFAULT_TRUST_POLICY.allow_external,
  }
}

/**
 * A resolved policy plus its PROVENANCE. `explicit` distinguishes a workspace
 * that expressed intent (a trust_policy key, or a legacy auto_accept_policy
 * lifted) from one running on pure defaults. Consumers that must preserve
 * per-channel historic defaults for untuned workspaces (verdict-apply's
 * resolveTrust: extraction defaulted 0.8 but the verdict gate defaulted 0.85)
 * inherit workspace values ONLY when explicit — otherwise a tuned-nothing
 * workspace would silently loosen the verdict gate to the extraction default.
 */
export interface ResolvedTrustPolicy extends TrustPolicy {
  explicit: boolean
}

/**
 * The PURE half of `resolveTrustPolicy`: given an already-read
 * `workspace.settings` blob, produce the effective policy. Never throws — any
 * garbage (including `null`/a non-object) degrades to the pure default.
 *
 * Split out so a caller that already holds the settings row — notably the
 * live-agent turn path, which resolves the trust policy, the claims
 * auto-accept policy, and the workspace edition off the SAME row on a route
 * that fires every ~3s during a recording — can normalize all of them from one
 * read instead of one `select('settings')` per resolver.
 *
 * Resolution order: settings.trust_policy (the source of truth, explicit), else
 * the legacy settings.auto_accept_policy lifted into the new shape (explicit —
 * the workspace tuned SOMETHING; kept readable for one release per the design),
 * else DEFAULT_TRUST_POLICY (explicit: false — pure defaults, so per-channel
 * historic defaults stay authoritative downstream).
 */
export function resolveTrustPolicyFromSettings(settings: unknown): ResolvedTrustPolicy {
  if (!settings || typeof settings !== 'object') {
    return { ...structuredCloneDefault(), explicit: false }
  }
  const s = settings as Record<string, unknown>
  if (s.trust_policy != null) {
    return { ...normalizeTrustPolicy(s.trust_policy), explicit: true }
  }
  const legacy = liftLegacyPolicy(s.auto_accept_policy)
  if (legacy) return { ...legacy, explicit: true }
  return { ...structuredCloneDefault(), explicit: false }
}

/**
 * Read the effective trust policy for a workspace. Never throws — on any error
 * (missing row, RLS, network) it returns the pure default so callers can treat
 * the result as authoritative without try/catch. Works with both a user-session
 * client (RLS) and a service-role client (extraction jobs, the run_skill
 * executor).
 *
 * Thin fetch over `resolveTrustPolicyFromSettings`, which holds the resolution
 * order.
 */
export async function resolveTrustPolicy(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<ResolvedTrustPolicy> {
  try {
    const { data } = await supabase
      .from('workspace')
      .select('settings')
      .eq('id', workspaceId)
      .maybeSingle()
    return resolveTrustPolicyFromSettings(data?.settings)
  } catch {
    return { ...structuredCloneDefault(), explicit: false }
  }
}
