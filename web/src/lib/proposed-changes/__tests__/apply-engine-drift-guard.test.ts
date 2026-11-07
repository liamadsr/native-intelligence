/**
 * Drift alarm: every change_type × entity_type combo the extractor can PROPOSE
 * must be one the apply engine can EXECUTE.
 *
 * When the two drift apart, extraction stages a proposal whose card renders a
 * one-click Accept that can only dead-end on "Unsupported change: …" — the prod
 * outage this PR fixes (live pending queue held update:decision ×8, update:contact
 * ×2, create:contact ×1, delete:milestone ×1, none of which had a handler).
 *
 * The proposable combos are the CARTESIAN PRODUCT of the two zod enums the
 * extraction schema exposes:
 *   - change_type: z.enum([...])  — src/lib/live-agent/tools.ts (propose_change)
 *   - entity_type: z.enum([...])  — same source
 * These arrays are copied here verbatim. If someone widens either enum WITHOUT
 * adding a handler (or a normalization) in apply-engine.ts, this test fails —
 * forcing the handler to land in the same change. Keep these lists in lockstep
 * with the enums; a mismatch on the enum contents is itself a signal to re-check.
 */
import { describe, it, expect } from 'vitest'
import { canApplyChange } from '../apply-engine'

// Verbatim from the propose_change inputSchema (src/lib/live-agent/tools.ts).
// 'mcp_call' × 'external'
// is proposed through a SEPARATE tool (propose_external_action), not this schema,
// and is included below so the guard covers the full staged-proposal surface.
const EXTRACTION_CHANGE_TYPES = ['create', 'update', 'delete', 'assign', 'send_email'] as const
const EXTRACTION_ENTITY_TYPES = [
  'action',
  'project',
  'decision',
  'milestone',
  'initiative',
  'contact',
] as const

// The extractor cannot reach every cell of the cartesian product in practice
// (e.g. send_email:decision is nonsensical), but the SCHEMA permits any pairing,
// so the apply engine must not hard-fail any of them at accept time. A combo the
// engine legitimately cannot execute (e.g. delete:initiative — no initiative
// delete handler exists yet) is allowed to be UNSUPPORTED, but then the card layer
// must never offer a one-click Accept for it (enforced by isUnsupportedChange in
// derive-ui, which delegates to canApplyChange). So this test asserts the specific
// invariant that matters: every combo OBSERVED in prod, plus the ones this PR now
// handles, is appliable — and it documents which cartesian cells remain
// deliberately unsupported so a future widening is a conscious choice.

// Combos this PR guarantees are appliable (the four dead ones + everything that
// already worked). If any of these regresses to unsupported, the guard fails.
const MUST_BE_APPLIABLE: Array<[string, string]> = [
  ['create', 'action'],
  ['create', 'decision'],
  ['create', 'contact'],
  ['create', 'milestone'],
  ['update', 'project'],
  ['update', 'action'],
  ['update', 'decision'], // was dead in prod (×8)
  ['update', 'contact'], // was dead in prod (×2)
  ['update', 'milestone'],
  ['assign', 'action'],
  // Target-less assign of ANY entity normalizes to create:action (prod: a
  // "connect with Nikhil's son" follow-up staged as assign:contact, capture
  // 3261a80c, dead-ended on "Unsupported: assign contact").
  ['assign', 'project'],
  ['assign', 'decision'],
  ['assign', 'milestone'],
  ['assign', 'initiative'],
  ['assign', 'contact'],
  ['delete', 'action'],
  ['delete', 'milestone'], // was dead in prod (×1)
  ['send_email', 'action'],
  ['send_email', 'contact'],
]

// Cartesian cells the apply engine deliberately does NOT execute yet. The card
// layer hides the one-click Accept for these (isUnsupportedChange), so they can
// only be dismissed or handled manually — never a dead-end Accept. Listed
// explicitly so that if the extractor starts producing one, the reviewer sees it
// here and decides: add a handler, or confirm the disabled-card path is right.
const KNOWN_UNSUPPORTED = new Set<string>([
  'create:project',
  'create:initiative',
  'update:initiative',
  'delete:project',
  'delete:decision',
  'delete:contact',
  'delete:initiative',
  'send_email:project',
  'send_email:decision',
  'send_email:milestone',
  'send_email:initiative',
])

describe('apply-engine drift guard', () => {
  it('every combo this PR handles satisfies canApplyChange', () => {
    for (const [ct, et] of MUST_BE_APPLIABLE) {
      expect(
        canApplyChange({ change_type: ct, entity_type: et }),
        `${ct}:${et} must be appliable but canApplyChange returned false`,
      ).toBe(true)
    }
  })

  it('every proposable combo is EITHER appliable OR explicitly known-unsupported', () => {
    // The drift alarm: a new proposable cell that is neither handled nor listed as
    // deliberately-unsupported means someone widened extraction without deciding
    // how the apply engine treats it. Fail loudly with the offending combo.
    const unclassified: string[] = []
    for (const ct of EXTRACTION_CHANGE_TYPES) {
      for (const et of EXTRACTION_ENTITY_TYPES) {
        const key = `${ct}:${et}`
        const appliable = canApplyChange({ change_type: ct, entity_type: et })
        if (!appliable && !KNOWN_UNSUPPORTED.has(key)) {
          unclassified.push(key)
        }
      }
    }
    expect(
      unclassified,
      `Unclassified proposable combos (add a handler in apply-engine.ts or list them in ` +
        `KNOWN_UNSUPPORTED after confirming the disabled-card path is intended): ${unclassified.join(', ')}`,
    ).toEqual([])
  })

  it('a TARGETED assign of a non-action entity stays unsupported', () => {
    // With an entity_id there is a real row to re-point and no handler for it —
    // the normalization only rescues the target-less form, so the card must
    // still render disabled rather than offering an Accept that dead-ends.
    for (const et of ['project', 'decision', 'milestone', 'initiative', 'contact']) {
      expect(
        canApplyChange({ change_type: 'assign', entity_type: et, entity_id: 'row-1' }),
        `targeted assign:${et} must NOT be appliable`,
      ).toBe(false)
    }
    // assign:action with a target has its own handler.
    expect(canApplyChange({ change_type: 'assign', entity_type: 'action', entity_id: 'row-1' })).toBe(true)
  })

  it('an appliable combo and a known-unsupported combo never overlap', () => {
    // Sanity: KNOWN_UNSUPPORTED must not name a combo that actually has a handler,
    // or the list would be lying about the engine's real capability.
    for (const key of KNOWN_UNSUPPORTED) {
      const [ct, et] = key.split(':')
      expect(
        canApplyChange({ change_type: ct, entity_type: et }),
        `${key} is listed as unsupported but canApplyChange says it's appliable — remove it from KNOWN_UNSUPPORTED`,
      ).toBe(false)
    }
  })
})
