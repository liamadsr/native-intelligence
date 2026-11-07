/**
 * needsMineCheck: the live agent's auto-apply verifies an action proposal as
 * "mine" whenever a member is named, even when an agent is also named (the
 * person stays responsible beside a delegate, decision 9).
 */
import { describe, it, expect } from 'vitest'
import { needsMineCheck } from '../mine-check'

const create = (over: Record<string, unknown> = {}) => ({ change_type: 'create', entity_type: 'action', assignee_member_id: null, extra: null, ...over })

describe('needsMineCheck', () => {
  it('an assignable proposal with a member assignee is checked', () => {
    expect(needsMineCheck(create({ assignee_member_id: 'mem-2' }))).toBe(true)
  })

  it('still checked when an agent is also named', () => {
    expect(needsMineCheck(create({ assignee_member_id: 'mem-2', extra: { assignee_ai_member_id: 'ai-1' } }))).toBe(true)
  })

  it('an agent alone auto-creates (nobody else’s action)', () => {
    expect(needsMineCheck(create({ extra: { assignee_ai_member_id: 'ai-1' } }))).toBe(false)
  })

  it('an unowned proposal is checked; a non-assignable one is not', () => {
    expect(needsMineCheck(create())).toBe(true)
    expect(needsMineCheck({ change_type: 'update', entity_type: 'action', assignee_member_id: 'mem-2' })).toBe(false)
  })
})
