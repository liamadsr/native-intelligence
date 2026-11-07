/**
 * Tests for the shared auto-apply gate — One Accept Authority W-1. The single
 * pure decision function both authorities call. Covers every entity class ×
 * explicitness × threshold × authority, the external/kill-switch/report-mode
 * short-circuits, and the two authorities' divergent entity/explicitness rules.
 */
import { describe, it, expect } from 'vitest'
import { decideAutoApply, type GateContext, type GateProposal } from '../auto-apply-gate'
import { DEFAULT_TRUST_POLICY, type TrustPolicy } from '../trust-policy'

const policy = (over: Partial<TrustPolicy> = {}): TrustPolicy => ({
  ...DEFAULT_TRUST_POLICY,
  actions: { ...DEFAULT_TRUST_POLICY.actions },
  decisions: { ...DEFAULT_TRUST_POLICY.decisions },
  milestones: { ...DEFAULT_TRUST_POLICY.milestones },
  claims: { ...DEFAULT_TRUST_POLICY.claims },
  ...over,
})

const prop = (over: Partial<GateProposal> = {}): GateProposal => ({
  change_type: 'create',
  entity_type: 'action',
  confidence: 0.95,
  ...over,
})

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  authority: 'extraction',
  mode: 'act',
  ...over,
})

describe('decideAutoApply — universal short-circuits (both authorities)', () => {
  it('stages in report mode no matter what', () => {
    expect(decideAutoApply(prop(), policy(), ctx({ mode: 'report', isMineExplicit: true }))).toBe('stage')
    expect(
      decideAutoApply(prop(), policy(), ctx({ authority: 'verdict', mode: 'report', isMineExplicit: true })),
    ).toBe('stage')
  })

  it('stages when the master kill-switch is off', () => {
    expect(
      decideAutoApply(prop(), policy({ enabled: false }), ctx({ isMineExplicit: true })),
    ).toBe('stage')
  })

  it('ALWAYS stages externals — even with allow_external on (invariant 5)', () => {
    // The pre-gate extraction path auto-FIRED these under allow_external; the
    // gate deliberately stages every external side effect for an explicit click.
    const email = prop({ change_type: 'send_email', entity_type: 'external' })
    expect(decideAutoApply(email, policy(), ctx({ isMineExplicit: true }))).toBe('stage')
    expect(
      decideAutoApply(email, policy({ allow_external: true }), ctx({ isMineExplicit: true })),
    ).toBe('stage')
    // send_email against a CONTACT entity is still an external side effect.
    const contactEmail = prop({ change_type: 'send_email', entity_type: 'contact', confidence: 1 })
    expect(
      decideAutoApply(contactEmail, policy({ allow_external: true }), ctx({ isMineExplicit: true })),
    ).toBe('stage')
  })

  it('stages an mcp_call (external side effect), allow_external or not', () => {
    const mcp = prop({ change_type: 'mcp_call', entity_type: 'external' })
    expect(decideAutoApply(mcp, policy(), ctx({ isMineExplicit: true }))).toBe('stage')
    expect(
      decideAutoApply(mcp, policy({ allow_external: true }), ctx({ isMineExplicit: true })),
    ).toBe('stage')
  })

  it('stages a CREATE for an entity the gate does not judge (project, contact, initiative)', () => {
    for (const entity_type of ['project', 'contact', 'initiative'] as const) {
      expect(
        decideAutoApply(prop({ entity_type }), policy(), ctx({ isMineExplicit: true })),
      ).toBe('stage')
    }
  })

  it('stages a null/NaN/undefined confidence (only scored items promote)', () => {
    for (const confidence of [null, undefined, Number.NaN]) {
      expect(
        decideAutoApply(prop({ confidence }), policy(), ctx({ authority: 'extraction', isMineExplicit: true })),
      ).toBe('stage')
      expect(
        decideAutoApply(prop({ confidence }), policy(), ctx({ authority: 'verdict', isMineExplicit: true })),
      ).toBe('stage')
    }
  })

  it('stages below the per-entity confidence floor', () => {
    // actions floor 0.8
    expect(
      decideAutoApply(prop({ confidence: 0.79 }), policy(), ctx({ isMineExplicit: true })),
    ).toBe('stage')
    expect(
      decideAutoApply(prop({ confidence: 0.8 }), policy(), ctx({ isMineExplicit: true })),
    ).toBe('apply')
  })

  it('stages when the entity rule is disabled even above threshold', () => {
    expect(
      decideAutoApply(
        prop(),
        policy({ actions: { enabled: false, min_confidence: 0.8, require_explicit: false } }),
        ctx({ isMineExplicit: true }),
      ),
    ).toBe('stage')
  })
})

describe('decideAutoApply — VERDICT authority', () => {
  const vctx = (over: Partial<GateContext> = {}) => ctx({ authority: 'verdict', ...over })

  it('applies a create:action when explicit-mine + confident', () => {
    expect(decideAutoApply(prop(), policy(), vctx({ isMineExplicit: true }))).toBe('apply')
  })

  it('applies an update:action when explicit-mine + confident', () => {
    expect(
      decideAutoApply(prop({ change_type: 'update' }), policy(), vctx({ isMineExplicit: true })),
    ).toBe('apply')
  })

  it('stages a create:action when NOT explicit-mine, even at max confidence', () => {
    expect(
      decideAutoApply(prop({ confidence: 1 }), policy(), vctx({ isMineExplicit: false })),
    ).toBe('stage')
    expect(decideAutoApply(prop({ confidence: 1 }), policy(), vctx())).toBe('stage') // undefined
  })

  it('stages delete:action and assign:action even at max confidence + explicit', () => {
    for (const change_type of ['delete', 'assign'] as const) {
      expect(
        decideAutoApply(
          prop({ change_type, confidence: 1 }),
          policy(),
          vctx({ isMineExplicit: true }),
        ),
      ).toBe('stage')
    }
  })

  it('ALWAYS stages decisions and milestones (never a personal commitment)', () => {
    for (const entity_type of ['decision', 'milestone'] as const) {
      // even explicit + explicitly-stated + max confidence
      expect(
        decideAutoApply(
          prop({ entity_type, confidence: 1 }),
          policy(),
          vctx({ isMineExplicit: true, isExplicitlyStated: true }),
        ),
      ).toBe('stage')
    }
  })
})

describe('decideAutoApply — EXTRACTION authority', () => {
  const ectx = (over: Partial<GateContext> = {}) => ctx({ authority: 'extraction', ...over })

  it('applies a verified-mine create:action', () => {
    expect(decideAutoApply(prop(), policy(), ectx({ isMineExplicit: true }))).toBe('apply')
  })

  it('stages an action that is not verified-mine', () => {
    expect(
      decideAutoApply(prop({ confidence: 1 }), policy(), ectx({ isMineExplicit: false })),
    ).toBe('stage')
  })

  it('applies a non-mine-gated action (update) — caller passes isMineExplicit:true', () => {
    // The route passes isMineExplicit:true for a non-assignable action (update),
    // matching today: only create:action / assign:action were me-gated.
    expect(
      decideAutoApply(prop({ change_type: 'update' }), policy(), ectx({ isMineExplicit: true })),
    ).toBe('apply')
  })

  describe('update:project rides the actions rule (historic behavior, F5)', () => {
    const projectUpdate = (confidence: number) =>
      prop({ change_type: 'update', entity_type: 'project', confidence })

    it('applies at/above the actions threshold, no explicitness required', () => {
      expect(
        decideAutoApply(projectUpdate(0.8), policy(), ectx({ isMineExplicit: true })),
      ).toBe('apply')
    })

    it('stages below the actions threshold', () => {
      expect(
        decideAutoApply(projectUpdate(0.79), policy(), ectx({ isMineExplicit: true })),
      ).toBe('stage')
    })

    it('stages when the actions class is disabled', () => {
      expect(
        decideAutoApply(
          projectUpdate(0.95),
          policy({ actions: { enabled: false, min_confidence: 0.8, require_explicit: false } }),
          ectx({ isMineExplicit: true }),
        ),
      ).toBe('stage')
    })

    it('does NOT extend to project creates/deletes/assigns', () => {
      for (const change_type of ['create', 'delete', 'assign'] as const) {
        expect(
          decideAutoApply(
            prop({ change_type, entity_type: 'project', confidence: 1 }),
            policy(),
            ectx({ isMineExplicit: true }),
          ),
        ).toBe('stage')
      }
    })

    it('stays VERDICT-staged — the verdict authority never auto-applies projects', () => {
      expect(
        decideAutoApply(
          projectUpdate(1),
          policy(),
          ctx({ authority: 'verdict', isMineExplicit: true }),
        ),
      ).toBe('stage')
    })
  })

  describe('decisions/milestones — the D2 explicitness rule', () => {
    for (const entity_type of ['decision', 'milestone'] as const) {
      it(`${entity_type}: applies when explicitly stated + at/above 0.85`, () => {
        expect(
          decideAutoApply(
            prop({ entity_type, confidence: 0.85 }),
            policy(),
            ectx({ isExplicitlyStated: true }),
          ),
        ).toBe('apply')
      })

      it(`${entity_type}: STAGES when inferred (not explicitly stated), even at max confidence`, () => {
        expect(
          decideAutoApply(
            prop({ entity_type, confidence: 1 }),
            policy(),
            ectx({ isExplicitlyStated: false }),
          ),
        ).toBe('stage')
        // undefined explicitness ⇒ treated as not-explicit ⇒ stage
        expect(
          decideAutoApply(prop({ entity_type, confidence: 1 }), policy(), ectx()),
        ).toBe('stage')
      })

      it(`${entity_type}: STAGES below the 0.85 floor even when explicitly stated`, () => {
        expect(
          decideAutoApply(
            prop({ entity_type, confidence: 0.84 }),
            policy(),
            ectx({ isExplicitlyStated: true }),
          ),
        ).toBe('stage')
      })

      it(`${entity_type}: applies on confidence alone when the policy drops require_explicit`, () => {
        const relaxed = policy({
          [entity_type === 'decision' ? 'decisions' : 'milestones']: {
            enabled: true,
            min_confidence: 0.85,
            require_explicit: false,
          },
        } as Partial<TrustPolicy>)
        expect(
          decideAutoApply(
            prop({ entity_type, confidence: 0.9 }),
            relaxed,
            ectx({ isExplicitlyStated: false }),
          ),
        ).toBe('apply')
      })
    }
  })
})

describe('decideAutoApply — deletes/assigns ALWAYS stage (every authority)', () => {
  // Destructive/ownership ops require a human click no matter the authority,
  // confidence, or explicitness (NORTH-STAR: a card for anything irreversible).
  // Without this shared guard, extraction's decisions/milestones buckets had no
  // change_type filter and is_explicitly_stated is stamped for ANY milestone
  // proposal — so a high-confidence "explicitly stated" delete:milestone would
  // auto-fire an unrecoverable hard DELETE with no human click.

  it('extraction: stages an explicit max-confidence delete:milestone (the data-loss case)', () => {
    expect(
      decideAutoApply(
        prop({ change_type: 'delete', entity_type: 'milestone', confidence: 1 }),
        policy(),
        ctx({ authority: 'extraction', isMineExplicit: true, isExplicitlyStated: true }),
      ),
    ).toBe('stage')
  })

  it('extraction: stages every delete/assign across gate-judged entities', () => {
    for (const change_type of ['delete', 'assign'] as const) {
      for (const entity_type of ['action', 'decision', 'milestone'] as const) {
        expect(
          decideAutoApply(
            prop({ change_type, entity_type, confidence: 1 }),
            policy(),
            ctx({ authority: 'extraction', isMineExplicit: true, isExplicitlyStated: true }),
          ),
          `extraction ${change_type}:${entity_type} must stage`,
        ).toBe('stage')
      }
    }
  })

  it('verdict: outcomes unchanged — delete/assign staged before AND after the shared guard', () => {
    // decideVerdict already staged both via its create|update-only rule; the
    // shared guard must not change any verdict outcome (it fires first, but
    // yields the same 'stage' the verdict branch would have).
    for (const change_type of ['delete', 'assign'] as const) {
      for (const entity_type of ['action', 'decision', 'milestone'] as const) {
        expect(
          decideAutoApply(
            prop({ change_type, entity_type, confidence: 1 }),
            policy(),
            ctx({ authority: 'verdict', isMineExplicit: true, isExplicitlyStated: true }),
          ),
          `verdict ${change_type}:${entity_type} must stage`,
        ).toBe('stage')
      }
    }
  })

  it('does not disturb the non-destructive auto-apply paths (create/update still apply)', () => {
    expect(
      decideAutoApply(prop(), policy(), ctx({ authority: 'extraction', isMineExplicit: true })),
    ).toBe('apply')
    expect(
      decideAutoApply(
        prop({ change_type: 'update' }),
        policy(),
        ctx({ authority: 'verdict', isMineExplicit: true }),
      ),
    ).toBe('apply')
  })
})

describe('decideAutoApply — EDITION scope (allowedEntityTypes)', () => {
  // Persona editions narrow what AUTOMATION may create unattended. The gate
  // COMPOSES with the trust policy: the edition can only ever turn an 'apply'
  // into a 'stage', never the reverse — and a disallowed type is staged (still
  // a card a human can accept), never dropped.

  it('is a no-op when absent or "all" (today: every workspace)', () => {
    // The exact case that would auto-apply without any edition context…
    const base = ctx({ authority: 'extraction', isMineExplicit: true })
    expect(decideAutoApply(prop(), policy(), base)).toBe('apply')
    // …decides identically with 'all' and with the field left undefined.
    expect(
      decideAutoApply(prop(), policy(), { ...base, allowedEntityTypes: 'all' }),
    ).toBe('apply')
    expect(
      decideAutoApply(prop(), policy(), { ...base, allowedEntityTypes: undefined }),
    ).toBe('apply')
  })

  it('preserves prior decisions under "all" across authorities and entity classes', () => {
    const cases: Array<[GateProposal, GateContext]> = [
      [prop(), ctx({ authority: 'extraction', isMineExplicit: true })],
      [prop({ change_type: 'update' }), ctx({ authority: 'verdict', isMineExplicit: true })],
      [
        prop({ entity_type: 'decision', confidence: 0.9 }),
        ctx({ authority: 'extraction', isMineExplicit: true, isExplicitlyStated: true }),
      ],
      // A staging case stays staged: 'all' adds nothing in either direction.
      [prop({ entity_type: 'contact' }), ctx({ authority: 'extraction', isMineExplicit: true })],
    ]
    for (const [p, c] of cases) {
      expect(
        decideAutoApply(p, policy(), { ...c, allowedEntityTypes: 'all' }),
        `${c.authority} ${p.change_type}:${p.entity_type} must match its no-edition decision`,
      ).toBe(decideAutoApply(p, policy(), c))
    }
  })

  it('STAGES an entity type outside the edition set (notes: no contacts)', () => {
    // The `notes` edition allows action + decision only. A contact create that
    // the trust policy would have judged never auto-fires — it waits as a card.
    const notes = ['action', 'decision']
    expect(
      decideAutoApply(
        prop({ entity_type: 'contact', confidence: 1 }),
        policy(),
        ctx({ authority: 'extraction', isMineExplicit: true, allowedEntityTypes: notes }),
      ),
    ).toBe('stage')
  })

  it('STAGES an otherwise-applying decision when the edition excludes decisions', () => {
    // Same proposal, same policy — only the edition set differs, and it alone
    // flips apply → stage. (An action-only edition, e.g. a future persona.)
    const p = prop({ entity_type: 'decision', confidence: 0.9 })
    const c = ctx({ authority: 'extraction', isMineExplicit: true, isExplicitlyStated: true })
    expect(decideAutoApply(p, policy(), c)).toBe('apply')
    expect(decideAutoApply(p, policy(), { ...c, allowedEntityTypes: ['action'] })).toBe('stage')
  })

  it('an ALLOWED type still has to clear the trust policy (compose, not override)', () => {
    const allowed = ['action', 'decision', 'contact']
    // Below the confidence floor: allowing the type does not promote it.
    expect(
      decideAutoApply(
        prop({ confidence: 0.1 }),
        policy(),
        ctx({ authority: 'extraction', isMineExplicit: true, allowedEntityTypes: allowed }),
      ),
    ).toBe('stage')
    // Kill-switch off: still staged.
    expect(
      decideAutoApply(
        prop(),
        policy({ enabled: false }),
        ctx({ authority: 'extraction', isMineExplicit: true, allowedEntityTypes: allowed }),
      ),
    ).toBe('stage')
    // Not verified-mine: still staged.
    expect(
      decideAutoApply(
        prop(),
        policy(),
        ctx({ authority: 'extraction', isMineExplicit: false, allowedEntityTypes: allowed }),
      ),
    ).toBe('stage')
    // And the clean case still applies — the edition didn't block it.
    expect(
      decideAutoApply(
        prop(),
        policy(),
        ctx({ authority: 'extraction', isMineExplicit: true, allowedEntityTypes: allowed }),
      ),
    ).toBe('apply')
  })

  it('never turns a staged decision INTO an apply (one-way narrowing)', () => {
    // An edition listing an entity the gate refuses to judge (contact) cannot
    // grant it auto-apply — the unmapped-bucket branch runs first.
    expect(
      decideAutoApply(
        prop({ entity_type: 'contact', confidence: 1 }),
        policy(),
        ctx({
          authority: 'extraction',
          isMineExplicit: true,
          allowedEntityTypes: ['action', 'contact', 'decision'],
        }),
      ),
    ).toBe('stage')
    // Nor can it unstage an external side effect.
    expect(
      decideAutoApply(
        prop({ change_type: 'send_email', entity_type: 'contact', confidence: 1 }),
        policy({ allow_external: true }),
        ctx({
          authority: 'extraction',
          isMineExplicit: true,
          allowedEntityTypes: ['action', 'contact', 'decision'],
        }),
      ),
    ).toBe('stage')
  })

  it('the verdict authority honors the edition too — on CREATES', () => {
    const p = prop({ change_type: 'create' })
    const c = ctx({ authority: 'verdict', isMineExplicit: true })
    expect(decideAutoApply(p, policy(), c)).toBe('apply')
    expect(decideAutoApply(p, policy(), { ...c, allowedEntityTypes: ['decision'] })).toBe('stage')
  })

  // ── CREATES ONLY ─────────────────────────────────────────────────────────
  // `autoCreateEntities` names what automation may bring into EXISTENCE. Keying
  // the check on entity_type alone also staged UPDATES of entities the
  // workspace already has — a restriction nothing asked for, and one that
  // contradicted the gate's own "never auto-CREATES" doc.

  it('does NOT apply the edition set to an UPDATE of an existing entity', () => {
    const p = prop({ change_type: 'update', entity_type: 'action' })
    const c = ctx({ authority: 'extraction', isMineExplicit: true })
    // An edition that grants nothing at all still leaves updates to the policy.
    expect(decideAutoApply(p, policy(), { ...c, allowedEntityTypes: [] })).toBe('apply')
    expect(decideAutoApply(p, policy(), { ...c, allowedEntityTypes: ['decision'] })).toBe('apply')
    // Verdict authority, same rule.
    const v = ctx({ authority: 'verdict', isMineExplicit: true })
    expect(decideAutoApply(p, policy(), { ...v, allowedEntityTypes: [] })).toBe('apply')
  })

  it('keeps update:project auto-applying under an enumerated edition set', () => {
    // The regression this guards: `project` reaches the ACTIONS bucket via
    // extractionBucket, but no feature contributes 'project' to a create set
    // before the projects feature grants it — so an entity_type-keyed check
    // silently stopped project updates auto-applying in EVERY workspace with
    // any feature switched off (i.e. any enumerated autoCreateEntities).
    const p = prop({ change_type: 'update', entity_type: 'project' })
    const c = ctx({ authority: 'extraction', isMineExplicit: true })
    expect(decideAutoApply(p, policy(), c)).toBe('apply')
    expect(
      decideAutoApply(p, policy(), { ...c, allowedEntityTypes: ['action', 'decision'] }),
    ).toBe('apply')
  })

  it('still STAGES a create the edition excludes, alongside those updates', () => {
    // The two halves together: same entity class, create staged, update applied.
    const allowed = ['action', 'decision']
    const c = ctx({ authority: 'extraction', isMineExplicit: true })
    expect(
      decideAutoApply(prop({ change_type: 'create', entity_type: 'contact', confidence: 1 }), policy(), {
        ...c,
        allowedEntityTypes: allowed,
      }),
    ).toBe('stage')
    expect(
      decideAutoApply(prop({ change_type: 'create', entity_type: 'action' }), policy(), {
        ...c,
        allowedEntityTypes: allowed,
      }),
    ).toBe('apply')
  })
})

describe('decideAutoApply — purity', () => {
  it('does not mutate the proposal, policy, or context', () => {
    const p = prop()
    const pol = policy()
    const c = ctx({ authority: 'verdict', isMineExplicit: true })
    const pSnap = JSON.stringify(p)
    const polSnap = JSON.stringify(pol)
    const cSnap = JSON.stringify(c)
    decideAutoApply(p, pol, c)
    expect(JSON.stringify(p)).toBe(pSnap)
    expect(JSON.stringify(pol)).toBe(polSnap)
    expect(JSON.stringify(c)).toBe(cSnap)
  })
})
