import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_POLICY,
  normalizePolicy,
  shouldAutoAccept,
  resolveAutoAcceptPolicy,
  resolveClaimsAutoAcceptPolicy,
  resolveClaimsAutoAcceptPolicyFromSettings,
} from '../auto-accept'

describe('normalizePolicy', () => {
  it('returns defaults for null/garbage input', () => {
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY)
    expect(normalizePolicy(undefined)).toEqual(DEFAULT_POLICY)
    expect(normalizePolicy('nonsense')).toEqual(DEFAULT_POLICY)
    expect(normalizePolicy(42)).toEqual(DEFAULT_POLICY)
  })

  it('fills missing fields from defaults', () => {
    expect(normalizePolicy({ claims: 0.95 })).toEqual({
      ...DEFAULT_POLICY,
      claims: 0.95,
    })
  })

  it('clamps thresholds into [0,1]', () => {
    expect(normalizePolicy({ claims: 5, actions: -3 })).toMatchObject({
      claims: 1,
      actions: 0,
    })
  })

  it('respects an explicit disabled flag', () => {
    expect(normalizePolicy({ enabled: false }).enabled).toBe(false)
  })

  it('defaults allow_external to false and respects an explicit true', () => {
    expect(normalizePolicy({}).allow_external).toBe(false)
    expect(normalizePolicy({ allow_external: true }).allow_external).toBe(true)
    // garbage → default
    expect(normalizePolicy({ allow_external: 'yes' }).allow_external).toBe(false)
  })

  it('ignores non-numeric / NaN thresholds', () => {
    const p = normalizePolicy({ claims: 'high', actions: NaN })
    expect(p.claims).toBe(DEFAULT_POLICY.claims)
    expect(p.actions).toBe(DEFAULT_POLICY.actions)
  })
})

describe('shouldAutoAccept', () => {
  const policy = { enabled: true, claims: 0.85, actions: 0.8, decisions: 0.85, allow_external: false }

  it('accepts at or above the per-kind threshold', () => {
    expect(shouldAutoAccept('claims', 0.85, policy)).toBe(true)
    expect(shouldAutoAccept('claims', 0.99, policy)).toBe(true)
    expect(shouldAutoAccept('actions', 0.8, policy)).toBe(true)
  })

  it('rejects below the threshold', () => {
    expect(shouldAutoAccept('claims', 0.84, policy)).toBe(false)
    expect(shouldAutoAccept('actions', 0.5, policy)).toBe(false)
  })

  it('never accepts null/undefined/NaN confidence', () => {
    expect(shouldAutoAccept('claims', null, policy)).toBe(false)
    expect(shouldAutoAccept('claims', undefined, policy)).toBe(false)
    expect(shouldAutoAccept('claims', NaN, policy)).toBe(false)
  })

  it('the kill-switch disables everything regardless of confidence', () => {
    const off = { ...policy, enabled: false }
    expect(shouldAutoAccept('claims', 1, off)).toBe(false)
    expect(shouldAutoAccept('actions', 1, off)).toBe(false)
  })

  it('uses the right per-kind threshold', () => {
    // actions threshold (0.8) is lower than claims (0.85): 0.82 accepts as an
    // action but not as a claim.
    expect(shouldAutoAccept('actions', 0.82, policy)).toBe(true)
    expect(shouldAutoAccept('claims', 0.82, policy)).toBe(false)
  })
})

describe('resolveAutoAcceptPolicy', () => {
  function clientReturning(settings: unknown) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { settings }, error: null }),
          }),
        }),
      }),
    } as never
  }

  it('reads settings.auto_accept_policy and normalizes it', async () => {
    const policy = await resolveAutoAcceptPolicy(
      clientReturning({ auto_accept_policy: { enabled: true, claims: 0.9 } }),
      'ws-1',
    )
    expect(policy).toEqual({ ...DEFAULT_POLICY, claims: 0.9 })
  })

  it('falls back to defaults when settings has no policy', async () => {
    const policy = await resolveAutoAcceptPolicy(clientReturning({}), 'ws-1')
    expect(policy).toEqual(DEFAULT_POLICY)
  })

  it('falls back to defaults on a thrown query (never throws)', async () => {
    const throwingClient = {
      from: () => {
        throw new Error('boom')
      },
    } as never
    await expect(
      resolveAutoAcceptPolicy(throwingClient, 'ws-1'),
    ).resolves.toEqual(DEFAULT_POLICY)
  })
})

/**
 * PR-2 (One Accept Authority): the CLAIM auto-accept policy now reads the ONE
 * trust policy (trust_policy.claims), NOT the legacy auto_accept_policy. The flat
 * AutoAcceptPolicy shape the claim consumers read is preserved; only the source
 * moved. These prove the read is trust_policy-sourced, honors both kill-switches,
 * and stays fail-open.
 */
describe('resolveClaimsAutoAcceptPolicy', () => {
  function clientReturning(settings: unknown) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { settings }, error: null }),
          }),
        }),
      }),
    } as never
  }

  it('reads trust_policy.claims.min_confidence as the claims threshold', async () => {
    const policy = await resolveClaimsAutoAcceptPolicy(
      clientReturning({
        trust_policy: {
          enabled: true,
          actions: { enabled: true, min_confidence: 0.8, require_explicit: false },
          decisions: { enabled: true, min_confidence: 0.85, require_explicit: true },
          milestones: { enabled: true, min_confidence: 0.85, require_explicit: true },
          claims: { enabled: true, min_confidence: 0.9, require_explicit: false },
          allow_external: false,
        },
      }),
      'ws-1',
    )
    expect(policy.claims).toBe(0.9)
    expect(policy.enabled).toBe(true)
  })

  it('is DISABLED when the master kill-switch is off (even if the claims class is on)', async () => {
    const policy = await resolveClaimsAutoAcceptPolicy(
      clientReturning({
        trust_policy: {
          enabled: false,
          claims: { enabled: true, min_confidence: 0.85, require_explicit: false },
        },
      }),
      'ws-1',
    )
    expect(policy.enabled).toBe(false)
    // shouldAutoAccept must therefore refuse any confidence.
    expect(shouldAutoAccept('claims', 0.99, policy)).toBe(false)
  })

  it('is DISABLED when the claims CLASS is off (even if the master switch is on)', async () => {
    const policy = await resolveClaimsAutoAcceptPolicy(
      clientReturning({
        trust_policy: {
          enabled: true,
          claims: { enabled: false, min_confidence: 0.85, require_explicit: false },
        },
      }),
      'ws-1',
    )
    expect(policy.enabled).toBe(false)
  })

  it('a legacy-only workspace resolves through resolveTrustPolicy, which LIFTS the legacy key (values preserved)', async () => {
    // The source is resolveTrustPolicy, not a raw flat read of the legacy key —
    // and resolveTrustPolicy's fallback deliberately lifts auto_accept_policy
    // into the trust shape (kept readable for one release), so a workspace that
    // tuned claims to 0.9 keeps 0.9 rather than snapping to the 0.85 default.
    const policy = await resolveClaimsAutoAcceptPolicy(
      clientReturning({ auto_accept_policy: { enabled: true, claims: 0.9 } }),
      'ws-1',
    )
    expect(policy.claims).toBe(0.9)
    expect(policy.enabled).toBe(true)
  })

  it('falls back to trust defaults (claims 0.85, enabled) when no policy is set', async () => {
    const policy = await resolveClaimsAutoAcceptPolicy(clientReturning({}), 'ws-1')
    expect(policy.claims).toBe(0.85)
    expect(policy.enabled).toBe(true)
  })

  it('never throws — a thrown query yields the fail-open default (claims enabled 0.85)', async () => {
    const throwingClient = {
      from: () => {
        throw new Error('boom')
      },
    } as never
    const policy = await resolveClaimsAutoAcceptPolicy(throwingClient, 'ws-1')
    expect(policy.enabled).toBe(true)
    expect(policy.claims).toBe(0.85)
  })
})

/**
 * The pure half of resolveClaimsAutoAcceptPolicy. The live-agent turn path
 * derives this, the trust policy, and the workspace edition from ONE read of
 * workspace.settings (that route fires every ~3s during a recording), so the
 * settings-accepting variant must project exactly what the fetching one does —
 * including on a failed read, which hands it `null`.
 */
describe('resolveClaimsAutoAcceptPolicyFromSettings', () => {
  it('reads trust_policy.claims.min_confidence as the claims threshold', () => {
    const policy = resolveClaimsAutoAcceptPolicyFromSettings({
      trust_policy: {
        enabled: true,
        claims: { enabled: true, min_confidence: 0.9, require_explicit: false },
      },
    })
    expect(policy.claims).toBe(0.9)
    expect(policy.enabled).toBe(true)
  })

  it('is DISABLED when the master kill-switch is off', () => {
    const policy = resolveClaimsAutoAcceptPolicyFromSettings({
      trust_policy: {
        enabled: false,
        claims: { enabled: true, min_confidence: 0.85, require_explicit: false },
      },
    })
    expect(policy.enabled).toBe(false)
    expect(shouldAutoAccept('claims', 0.99, policy)).toBe(false)
  })

  it('is DISABLED when the claims CLASS is off', () => {
    const policy = resolveClaimsAutoAcceptPolicyFromSettings({
      trust_policy: {
        enabled: true,
        claims: { enabled: false, min_confidence: 0.85, require_explicit: false },
      },
    })
    expect(policy.enabled).toBe(false)
  })

  it('lifts a legacy-only workspace through the trust policy fallback', () => {
    const policy = resolveClaimsAutoAcceptPolicyFromSettings({
      auto_accept_policy: { enabled: true, claims: 0.9 },
    })
    expect(policy.claims).toBe(0.9)
    expect(policy.enabled).toBe(true)
  })

  it('falls back to the DEFAULT thresholds for null/garbage settings (never throws)', () => {
    for (const bad of [null, undefined, {}, 'nope', 42]) {
      expect(resolveClaimsAutoAcceptPolicyFromSettings(bad)).toEqual(DEFAULT_POLICY)
    }
  })

  it('agrees with resolveClaimsAutoAcceptPolicy on the same settings blob', async () => {
    function clientReturning(settings: unknown) {
      return {
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { settings }, error: null }) }),
          }),
        }),
      } as never
    }
    for (const settings of [
      {},
      { trust_policy: { enabled: true, claims: { enabled: true, min_confidence: 0.7 } } },
      { trust_policy: { enabled: false } },
      { auto_accept_policy: { enabled: true, claims: 0.9, actions: 0.7 } },
    ]) {
      expect(resolveClaimsAutoAcceptPolicyFromSettings(settings)).toEqual(
        await resolveClaimsAutoAcceptPolicy(clientReturning(settings), 'ws-1'),
      )
    }
  })
})
