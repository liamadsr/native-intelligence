import { describe, it, expect } from 'vitest'
import { inFeedScope, removeWorkRow, upsertWorkRow } from '../patch-rows'
import type { WorkItem } from '../types'

const TRIAGE = { id: 'tm-1', name: 'Triage', is_system: true, system_key: 'triage', bot_character: 'triage' }

const at = (h: number) => `2026-09-26T${String(h).padStart(2, '0')}:00:00.000Z`
/** The columns the merge reads; the rest of a ledger row is irrelevant here. */
const row = (id: string, h: number, over: Partial<WorkItem> = {}) =>
  ({ id, created_at: at(h), member_id: 'm1', status: 'running', ...over }) as WorkItem

describe('upsertWorkRow', () => {
  it('replaces in place and keeps newest-first order', () => {
    const list = [row('c', 12), row('b', 11), row('a', 10)]
    const out = upsertWorkRow(list, row('b', 11, { status: 'done' }))
    expect(out.list.map((i) => [i.id, i.status])).toEqual([
      ['c', 'running'],
      ['b', 'done'],
      ['a', 'running'],
    ])
    expect(out.needsTeammate).toBe(false)
    // The input list is not mutated.
    expect(list[1].status).toBe('running')
  })

  it('inserts a new row at its created position', () => {
    const out = upsertWorkRow([row('c', 12), row('a', 10)], row('b', 11))
    expect(out.list.map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('carries the teammate (its name and its bot) from the row it replaces, or from any row naming the same teammate', () => {
    const list = [row('a', 10, { ai_team_member_id: 'tm-1', teammate: TRIAGE })]
    const same = upsertWorkRow(list, row('a', 10, { ai_team_member_id: 'tm-1', status: 'done' }))
    expect(same.list[0].teammate).toEqual(TRIAGE)
    expect(same.needsTeammate).toBe(false)
    const sibling = upsertWorkRow(list, row('b', 11, { ai_team_member_id: 'tm-1' }))
    expect(sibling.list[0].teammate).toEqual(TRIAGE)
    expect(sibling.needsTeammate).toBe(false)
  })

  it('reports a teammate it cannot name, and drops a stale one when the teammate changed', () => {
    const list = [row('a', 10, { ai_team_member_id: 'tm-1', teammate: TRIAGE })]
    const out = upsertWorkRow(list, row('a', 10, { ai_team_member_id: 'tm-2' }))
    expect(out.list[0].teammate).toBeNull()
    expect(out.needsTeammate).toBe(true)
  })

  it('a row with no teammate needs none', () => {
    const out = upsertWorkRow([], row('a', 10, { ai_team_member_id: null }))
    expect(out.list[0].teammate).toBeNull()
    expect(out.needsTeammate).toBe(false)
  })
})

describe('removeWorkRow', () => {
  it('drops the row, and returns the same array when it was not there', () => {
    const list = [row('a', 10), row('b', 11)]
    expect(removeWorkRow(list, 'a').map((i) => i.id)).toEqual(['b'])
    expect(removeWorkRow(list, 'zz')).toBe(list)
  })
})

describe('inFeedScope', () => {
  it('admits only rows whose member the feed answered for; nothing before the first answer', () => {
    const scope = new Set(['m1', 'm2'])
    expect(inFeedScope({ member_id: 'm2' }, scope)).toBe(true)
    expect(inFeedScope({ member_id: 'm9' }, scope)).toBe(false)
    expect(inFeedScope({ member_id: null as unknown as string }, scope)).toBe(false)
    expect(inFeedScope({ member_id: 'm1' }, null)).toBe(false)
  })
})
