/** card-entity.ts — the entity an attention card is about, from its payload (step 2). */
import { describe, it, expect } from 'vitest'
import { cardEntityRef } from '../card-entity'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('cardEntityRef', () => {
  it('a proposal-backed card takes the payload entity pair and capture', () => {
    expect(cardEntityRef('action_card', { entity_type: 'action', entity_id: A, capture_id: C })).toEqual({
      entityType: 'action',
      entityId: A,
      captureId: C,
    })
  })

  it('a work proposal takes the first id-bearing resource, never a package', () => {
    expect(
      cardEntityRef('work_proposal', {
        task: 'x',
        capture_id: C,
        resources: [{ type: 'package', id: A, label: 'kb' }, { type: 'contact', label: 'Randy' }, { type: 'contact', id: B, label: 'Randy' }],
      }),
    ).toEqual({ entityType: 'contact', entityId: B, captureId: C })
  })

  it('non-uuid ids and empty types stay null; a card can legitimately be about nothing', () => {
    expect(cardEntityRef('question', { entity_type: 'action', entity_id: 'GEN-42', capture_id: 'nope' })).toEqual({
      entityType: null,
      entityId: null,
      captureId: null,
    })
    expect(cardEntityRef('work_proposal', { task: 'x' })).toEqual({ entityType: null, entityId: null, captureId: null })
    // resources only count for work proposals
    expect(cardEntityRef('question', { resources: [{ type: 'contact', id: B, label: 'r' }] }).entityId).toBeNull()
  })
})
