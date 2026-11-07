/**
 * The delegate model's person rule (decision 9): who holds an action after a
 * write that may set its agent.
 */
import { describe, it, expect } from 'vitest'
import { responsibleAssigneeIds } from '../delegate'

describe('responsibleAssigneeIds', () => {
  it('a write that sets no agent passes its own list through', () => {
    expect(responsibleAssigneeIds({ delegating: false, requested: ['m2'], current: ['m1'], delegatorMemberId: 'me' })).toEqual(['m2'])
    expect(responsibleAssigneeIds({ delegating: false, requested: undefined, current: ['m1'], delegatorMemberId: 'me' })).toBeUndefined()
    expect(responsibleAssigneeIds({ delegating: false, requested: [], current: ['m1'], delegatorMemberId: 'me' })).toEqual([])
  })

  it('a delegation that names people writes exactly those people', () => {
    expect(responsibleAssigneeIds({ delegating: true, requested: ['m2'], current: [], delegatorMemberId: 'me' })).toEqual(['m2'])
  })

  it('a delegation that names nobody keeps the people already there', () => {
    expect(responsibleAssigneeIds({ delegating: true, requested: undefined, current: ['m1'], delegatorMemberId: 'me' })).toBeUndefined()
  })

  it('with nobody there, the delegator becomes the person responsible', () => {
    expect(responsibleAssigneeIds({ delegating: true, requested: undefined, current: [], delegatorMemberId: 'me' })).toEqual(['me'])
    expect(responsibleAssigneeIds({ delegating: true, requested: [], current: ['m1'], delegatorMemberId: 'me' })).toEqual(['me'])
  })

  it('without a delegator row it leaves the request as it was', () => {
    expect(responsibleAssigneeIds({ delegating: true, requested: undefined, current: [], delegatorMemberId: null })).toBeUndefined()
  })
})
