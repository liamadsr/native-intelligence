/**
 * normalizeProposedChange / canApplyChange — the ONE set of combo rules the
 * apply engine (dispatch), propose_change (staging), and the card layer
 * (appliability) all share. If these three ever disagree, a proposal can be
 * staged in a form the engine cannot run, or a card can offer an Accept that
 * dead-ends — the "Unsupported: assign contact" prod card.
 */
import { describe, it, expect } from 'vitest'
import { HANDLED_COMBOS, canApplyChange, normalizeProposedChange } from '../appliable-combos'

describe('normalizeProposedChange', () => {
  it('rewrites a target-less assign of ANY entity to create:action', () => {
    for (const et of ['action', 'project', 'decision', 'milestone', 'initiative', 'contact']) {
      expect(normalizeProposedChange({ change_type: 'assign', entity_type: et, entity_id: null })).toEqual({
        change_type: 'create',
        entity_type: 'action',
        changed: true,
      })
      // entity_id omitted entirely counts as target-less too.
      expect(normalizeProposedChange({ change_type: 'assign', entity_type: et }).changed).toBe(true)
    }
  })

  it('leaves a TARGETED assign untouched', () => {
    expect(normalizeProposedChange({ change_type: 'assign', entity_type: 'action', entity_id: 'a-1' })).toEqual({
      change_type: 'assign',
      entity_type: 'action',
      changed: false,
    })
    expect(normalizeProposedChange({ change_type: 'assign', entity_type: 'contact', entity_id: 'c-1' }).changed).toBe(false)
  })

  it('rewrites a target-less update:decision to create:decision, and only that update', () => {
    expect(normalizeProposedChange({ change_type: 'update', entity_type: 'decision', entity_id: null })).toEqual({
      change_type: 'create',
      entity_type: 'decision',
      changed: true,
    })
    expect(normalizeProposedChange({ change_type: 'update', entity_type: 'decision', entity_id: 'd-1' }).changed).toBe(false)
    expect(normalizeProposedChange({ change_type: 'update', entity_type: 'action', entity_id: null }).changed).toBe(false)
    expect(normalizeProposedChange({ change_type: 'update', entity_type: 'contact', entity_id: null }).changed).toBe(false)
  })

  it('passes every other combo through unchanged', () => {
    for (const key of HANDLED_COMBOS) {
      const [ct, et] = key.split(':')
      if (ct === 'assign') continue
      if (key === 'update:decision') continue
      expect(normalizeProposedChange({ change_type: ct, entity_type: et, entity_id: 'x' }).changed).toBe(false)
    }
  })
})

describe('canApplyChange', () => {
  it('is true for every handled combo regardless of entity_id', () => {
    for (const key of HANDLED_COMBOS) {
      const [ct, et] = key.split(':')
      expect(canApplyChange({ change_type: ct, entity_type: et, entity_id: null })).toBe(true)
      expect(canApplyChange({ change_type: ct, entity_type: et, entity_id: 'x' })).toBe(true)
    }
  })

  it('is true for a combo only reachable through normalization', () => {
    expect(canApplyChange({ change_type: 'assign', entity_type: 'contact', entity_id: null })).toBe(true)
    expect(canApplyChange({ change_type: 'assign', entity_type: 'project' })).toBe(true)
  })

  it('is false for a targeted combo with no handler (normalization does not apply)', () => {
    expect(canApplyChange({ change_type: 'assign', entity_type: 'contact', entity_id: 'c-1' })).toBe(false)
    expect(canApplyChange({ change_type: 'delete', entity_type: 'contact', entity_id: 'c-1' })).toBe(false)
    expect(canApplyChange({ change_type: 'create', entity_type: 'initiative' })).toBe(false)
  })
})
