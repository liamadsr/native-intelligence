/** roles.ts — the closed role / expects vocabulary and its normaliser (step 2). */
import { describe, it, expect } from 'vitest'
import { DEFAULT_EXPECTS_BY_ROLE, WORK_EXPECTS_MAX, WORK_ROLES, isWorkRole, normalizeWorkExpects, evaluateExpects, describeExpectation, DELEGABLE_WORK_ROLES } from '../roles'

describe('roles', () => {
  it('the four roles, and only those', () => {
    expect([...WORK_ROLES]).toEqual(['researcher', 'writer', 'developer', 'correspondent'])
    expect(isWorkRole('writer')).toBe(true)
    expect(isWorkRole('Writer')).toBe(false)
    expect(isWorkRole(null)).toBe(false)
  })

  it('every role has a default expectation of a real deliverable type', () => {
    for (const role of WORK_ROLES) expect(DEFAULT_EXPECTS_BY_ROLE[role].length).toBeGreaterThan(0)
    expect(DEFAULT_EXPECTS_BY_ROLE.developer).toEqual([{ type: 'entity', entity_type: 'pr', min: 1 }])
  })
})

describe('normalizeWorkExpects', () => {
  it('keeps well-formed entries, drops the rest, caps the count, null when nothing survives', () => {
    expect(normalizeWorkExpects([{ type: 'document', min: 1 }, { type: 'pdf' }, { type: 'entity', entity_type: 'pr' }, 'x', { type: 'action', min: -1 }])).toEqual([
      { type: 'document', min: 1 },
      { type: 'entity', entity_type: 'pr' },
    ])
    expect(normalizeWorkExpects([{ type: 'nope' }])).toBeNull()
    expect(normalizeWorkExpects('document')).toBeNull()
    expect(normalizeWorkExpects(undefined)).toBeNull()
    const many = normalizeWorkExpects(Array.from({ length: 10 }, () => ({ type: 'document' })))
    expect(many?.length).toBe(WORK_EXPECTS_MAX)
  })

  it('clamps min and entity_type', () => {
    expect(normalizeWorkExpects([{ type: 'document', min: 999 }])).toEqual([{ type: 'document', min: 20 }])
    expect(normalizeWorkExpects([{ type: 'entity', entity_type: 'x'.repeat(100) }])![0].entity_type).toHaveLength(40)
    expect(normalizeWorkExpects([{ type: 'document', min: 1.5 }])).toBeNull()
  })
})

describe('evaluateExpects (row 13)', () => {
  it('each expectation needs at least min deliverables of its type', () => {
    expect(evaluateExpects([{ type: 'document', min: 2 }], [{ type: 'document' }, { type: 'document' }])).toEqual({ met: true, unmet: [] })
    expect(evaluateExpects([{ type: 'document', min: 2 }], [{ type: 'document' }, { type: 'email_draft' }])).toEqual({ met: false, unmet: ['2 documents'] })
    expect(evaluateExpects([{ type: 'email_draft' }], [])).toEqual({ met: false, unmet: ['1 email draft'] })
  })

  it('an entity_type narrows an entity expectation', () => {
    const pr = [{ type: 'entity', entity_type: 'pr', min: 1 }] as const
    expect(evaluateExpects(pr, [{ type: 'entity', entity_type: 'action' }]).unmet).toEqual(['1 pr'])
    expect(evaluateExpects(pr, [{ type: 'entity', entity_type: 'pr' }]).met).toBe(true)
  })

  it('no expectation is always met', () => {
    expect(evaluateExpects(null, [])).toEqual({ met: true, unmet: [] })
    expect(evaluateExpects([], null)).toEqual({ met: true, unmet: [] })
  })

  it('names every shortfall in words', () => {
    expect(describeExpectation({ type: 'action', min: 3 })).toBe('3 actions')
    expect(describeExpectation({ type: 'document' })).toBe('1 document')
  })

  it('the Developer cannot take a handoff (its deliverable needs a coding run)', () => {
    expect(DELEGABLE_WORK_ROLES).toEqual(['researcher', 'writer', 'correspondent'])
  })
})
