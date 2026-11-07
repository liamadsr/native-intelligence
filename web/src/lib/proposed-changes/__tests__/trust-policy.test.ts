/**
 * Tests for the workspace trust policy — One Accept Authority W-2. The ONE
 * auto-apply authority (per-entity thresholds + enabled + D2 explicitness),
 * cloned from the auto_accept_policy pattern: normalize any
 * garbage to the default field-by-field, resolve fail-open, and — the fallback
 * unique to this policy — lift the legacy flat auto_accept_policy when the new
 * key is absent (kept readable for one release).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_TRUST_POLICY,
  normalizeTrustPolicy,
  resolveTrustPolicy,
  resolveTrustPolicyFromSettings,
  type TrustPolicy,
} from '../trust-policy'

describe('DEFAULT_TRUST_POLICY', () => {
  it("matches today's effective behavior: actions 0.8, decisions/milestones/claims 0.85, all enabled", () => {
    expect(DEFAULT_TRUST_POLICY).toEqual({
      enabled: true,
      actions: { enabled: true, min_confidence: 0.8, require_explicit: false },
      decisions: { enabled: true, min_confidence: 0.85, require_explicit: true },
      milestones: { enabled: true, min_confidence: 0.85, require_explicit: true },
      claims: { enabled: true, min_confidence: 0.85, require_explicit: false },
      allow_external: false,
    })
  })
})

describe('normalizeTrustPolicy', () => {
  it('returns a fresh default for null/undefined/non-object garbage', () => {
    expect(normalizeTrustPolicy(null)).toEqual(DEFAULT_TRUST_POLICY)
    expect(normalizeTrustPolicy(undefined)).toEqual(DEFAULT_TRUST_POLICY)
    expect(normalizeTrustPolicy('nope')).toEqual(DEFAULT_TRUST_POLICY)
    expect(normalizeTrustPolicy(42)).toEqual(DEFAULT_TRUST_POLICY)
  })

  it('never shares the default nested-rule objects (mutation isolation)', () => {
    const a = normalizeTrustPolicy(null)
    a.actions.min_confidence = 0.1
    expect(DEFAULT_TRUST_POLICY.actions.min_confidence).toBe(0.8)
    expect(normalizeTrustPolicy(null).actions.min_confidence).toBe(0.8)
  })

  it('accepts a full valid policy verbatim', () => {
    const p: TrustPolicy = {
      enabled: false,
      actions: { enabled: false, min_confidence: 0.5, require_explicit: true },
      decisions: { enabled: true, min_confidence: 0.9, require_explicit: false },
      milestones: { enabled: false, min_confidence: 0.7, require_explicit: true },
      claims: { enabled: false, min_confidence: 0.6, require_explicit: false },
      allow_external: true,
    }
    expect(normalizeTrustPolicy(p)).toEqual(p)
  })

  it('clamps out-of-range thresholds into [0,1]', () => {
    const got = normalizeTrustPolicy({
      actions: { min_confidence: 5 },
      decisions: { min_confidence: -2 },
    })
    expect(got.actions.min_confidence).toBe(1)
    expect(got.decisions.min_confidence).toBe(0)
  })

  it('fills each missing field from the default independently', () => {
    const got = normalizeTrustPolicy({ enabled: false, actions: { min_confidence: 0.6 } })
    expect(got.enabled).toBe(false)
    // actions keeps its supplied conf, inherits enabled/require_explicit from default
    expect(got.actions).toEqual({ enabled: true, min_confidence: 0.6, require_explicit: false })
    // decisions/milestones/claims fully default
    expect(got.decisions).toEqual(DEFAULT_TRUST_POLICY.decisions)
    expect(got.milestones).toEqual(DEFAULT_TRUST_POLICY.milestones)
    expect(got.claims).toEqual(DEFAULT_TRUST_POLICY.claims)
  })

  it('degrades a NaN threshold to the default', () => {
    const got = normalizeTrustPolicy({ actions: { min_confidence: Number.NaN } })
    expect(got.actions.min_confidence).toBe(0.8)
  })
})

// A minimal supabase stub whose .from().select().eq().maybeSingle() chain
// resolves to a fixed { data, error }, or throws when `throws` is set.
function stubClient(opts: { settings?: unknown; error?: unknown; throws?: boolean }): SupabaseClient {
  const maybeSingle = vi.fn(async () => {
    if (opts.throws) throw new Error('boom')
    if (opts.error) return { data: null, error: opts.error }
    return { data: { settings: opts.settings ?? {} }, error: null }
  })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from } as unknown as SupabaseClient
}

describe('resolveTrustPolicy', () => {
  const WS = 'ws-1'

  it('reads settings.trust_policy and normalizes it — marked EXPLICIT', async () => {
    const supabase = stubClient({
      settings: {
        trust_policy: {
          enabled: true,
          actions: { enabled: true, min_confidence: 0.7, require_explicit: false },
          decisions: { enabled: true, min_confidence: 0.9, require_explicit: true },
          milestones: { enabled: true, min_confidence: 0.9, require_explicit: true },
          allow_external: false,
        },
      },
    })
    const got = await resolveTrustPolicy(supabase, WS)
    expect(got.actions.min_confidence).toBe(0.7)
    expect(got.decisions.min_confidence).toBe(0.9)
    expect(got.explicit).toBe(true)
  })

  it('falls back to the legacy auto_accept_policy when trust_policy is absent — marked EXPLICIT', async () => {
    // Legacy flat shape: { enabled, claims, actions, decisions, allow_external }.
    const supabase = stubClient({
      settings: {
        auto_accept_policy: {
          enabled: true,
          claims: 0.9,
          actions: 0.7,
          decisions: 0.95,
          allow_external: true,
        },
      },
    })
    const got = await resolveTrustPolicy(supabase, WS)
    // Legacy actions threshold lifts into actions AND milestones (milestones were
    // historically bucketed into the actions threshold); require_explicit stays
    // OFF on the legacy read (the D2 rule ships via the migration fold).
    expect(got.actions).toEqual({ enabled: true, min_confidence: 0.7, require_explicit: false })
    expect(got.milestones).toEqual({ enabled: true, min_confidence: 0.7, require_explicit: false })
    expect(got.decisions).toEqual({ enabled: true, min_confidence: 0.95, require_explicit: false })
    expect(got.claims).toEqual({ enabled: true, min_confidence: 0.9, require_explicit: false })
    expect(got.allow_external).toBe(true)
    // Tuning the legacy key IS expressed intent — inheritance may fire.
    expect(got.explicit).toBe(true)
  })

  it('carries a legacy disabled kill-switch through the fallback', async () => {
    const supabase = stubClient({
      settings: { auto_accept_policy: { enabled: false, actions: 0.8, decisions: 0.85 } },
    })
    const got = await resolveTrustPolicy(supabase, WS)
    expect(got.enabled).toBe(false)
    expect(got.explicit).toBe(true)
  })

  it('prefers trust_policy over a stale legacy key when BOTH exist', async () => {
    const supabase = stubClient({
      settings: {
        trust_policy: {
          enabled: true,
          actions: { enabled: true, min_confidence: 0.6, require_explicit: false },
          decisions: { enabled: true, min_confidence: 0.85, require_explicit: true },
          milestones: { enabled: true, min_confidence: 0.85, require_explicit: true },
          allow_external: false,
        },
        auto_accept_policy: { enabled: true, actions: 0.99, decisions: 0.99 },
      },
    })
    const got = await resolveTrustPolicy(supabase, WS)
    expect(got.actions.min_confidence).toBe(0.6) // trust_policy wins
  })

  it('returns pure defaults marked NON-explicit when the row has neither key', async () => {
    const supabase = stubClient({ settings: {} })
    await expect(resolveTrustPolicy(supabase, WS)).resolves.toEqual({
      ...DEFAULT_TRUST_POLICY,
      explicit: false,
    })
  })

  it('fails open to non-explicit defaults on a query error (never throws)', async () => {
    const supabase = stubClient({ error: { message: 'rls' } })
    await expect(resolveTrustPolicy(supabase, WS)).resolves.toEqual({
      ...DEFAULT_TRUST_POLICY,
      explicit: false,
    })
  })

  it('fails open to non-explicit defaults when the client throws (never throws)', async () => {
    const supabase = stubClient({ throws: true })
    await expect(resolveTrustPolicy(supabase, WS)).resolves.toEqual({
      ...DEFAULT_TRUST_POLICY,
      explicit: false,
    })
  })
})

/**
 * The pure half of resolveTrustPolicy. Callers that already hold a
 * workspace.settings blob (the live-agent turn path resolves the trust policy,
 * the claims auto-accept policy, and the workspace edition off ONE read) go
 * through this. It must reproduce the fetching variant's resolution order and
 * its fail-open default exactly — otherwise a shared read would silently mean a
 * different policy than a per-resolver read.
 */
describe('resolveTrustPolicyFromSettings', () => {
  it('reads settings.trust_policy and normalizes it — marked EXPLICIT', () => {
    const got = resolveTrustPolicyFromSettings({
      trust_policy: {
        enabled: true,
        actions: { enabled: true, min_confidence: 0.7, require_explicit: false },
        decisions: { enabled: true, min_confidence: 0.9, require_explicit: true },
      },
    })
    expect(got.actions.min_confidence).toBe(0.7)
    expect(got.decisions.min_confidence).toBe(0.9)
    expect(got.explicit).toBe(true)
  })

  it('lifts the legacy auto_accept_policy when trust_policy is absent — marked EXPLICIT', () => {
    const got = resolveTrustPolicyFromSettings({
      auto_accept_policy: {
        enabled: true,
        claims: 0.9,
        actions: 0.7,
        decisions: 0.95,
        allow_external: true,
      },
    })
    expect(got.actions).toEqual({ enabled: true, min_confidence: 0.7, require_explicit: false })
    expect(got.milestones).toEqual({ enabled: true, min_confidence: 0.7, require_explicit: false })
    expect(got.decisions).toEqual({ enabled: true, min_confidence: 0.95, require_explicit: false })
    expect(got.claims).toEqual({ enabled: true, min_confidence: 0.9, require_explicit: false })
    expect(got.allow_external).toBe(true)
    expect(got.explicit).toBe(true)
  })

  it('prefers trust_policy over a stale legacy key when BOTH exist', () => {
    const got = resolveTrustPolicyFromSettings({
      trust_policy: {
        enabled: true,
        actions: { enabled: true, min_confidence: 0.6, require_explicit: false },
      },
      auto_accept_policy: { enabled: true, actions: 0.99, decisions: 0.99 },
    })
    expect(got.actions.min_confidence).toBe(0.6)
  })

  it('returns pure defaults marked NON-explicit for an empty settings blob', () => {
    expect(resolveTrustPolicyFromSettings({})).toEqual({
      ...DEFAULT_TRUST_POLICY,
      explicit: false,
    })
  })

  it('returns pure defaults marked NON-explicit for null/undefined/garbage settings', () => {
    // A failed shared read hands `null` here; it must degrade EXACTLY like the
    // fetching variant's catch block, not throw.
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(resolveTrustPolicyFromSettings(bad)).toEqual({
        ...DEFAULT_TRUST_POLICY,
        explicit: false,
      })
    }
  })

  it('never shares the default nested-rule objects (mutation isolation)', () => {
    const a = resolveTrustPolicyFromSettings(null)
    a.actions.min_confidence = 0.1
    expect(DEFAULT_TRUST_POLICY.actions.min_confidence).toBe(0.8)
    expect(resolveTrustPolicyFromSettings(null).actions.min_confidence).toBe(0.8)
  })

  it('agrees with resolveTrustPolicy on the same settings blob', async () => {
    // The one-read path and the per-resolver path must be interchangeable.
    for (const settings of [
      {},
      { trust_policy: { enabled: false } },
      { auto_accept_policy: { enabled: true, claims: 0.9, actions: 0.7 } },
      { trust_policy: 'garbage' },
    ]) {
      expect(resolveTrustPolicyFromSettings(settings)).toEqual(
        await resolveTrustPolicy(stubClient({ settings }), 'ws-1'),
      )
    }
  })
})
