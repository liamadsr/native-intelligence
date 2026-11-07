import { describe, it, expect } from 'vitest'
import {
  countsAsWork,
  filterOpenWork,
  isOpenStateCategory,
  isOpenWork,
  loadClosedStates,
  OPEN_STATE_CATEGORIES,
} from '../open-work'

type Call = [string, ...unknown[]]

function recorder(rows: unknown[] = [], calls: Call[] = []) {
  let proxy: Record<string, unknown>
  const self: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  }
  proxy = new Proxy(self, {
    get: (t, p: string) =>
      p in t
        ? t[p]
        : (...args: unknown[]) => {
            calls.push([p, ...args])
            return proxy
          },
  })
  return proxy
}

describe('isOpenWork', () => {
  const open = { parent_id: null, confirmation: 'confirmed', category: 'unstarted' }

  it('open states count; closed ones do not; a missing state counts as open', () => {
    for (const c of OPEN_STATE_CATEGORIES) expect(isOpenStateCategory(c)).toBe(true)
    expect(isOpenStateCategory('completed')).toBe(false)
    expect(isOpenStateCategory('canceled')).toBe(false)
    expect(isOpenStateCategory(null)).toBe(true)
    expect(isOpenWork({ ...open, category: undefined })).toBe(true)
  })

  it('a sub-action or a dismissed proposal is never open work', () => {
    expect(isOpenWork(open)).toBe(true)
    expect(isOpenWork({ ...open, parent_id: 'a-1' })).toBe(false)
    expect(isOpenWork({ ...open, confirmation: 'dismissed' })).toBe(false)
  })

  it('suggested counts unless the caller asks for confirmed only', () => {
    expect(isOpenWork({ ...open, confirmation: 'suggested' })).toBe(true)
    expect(isOpenWork({ ...open, confirmation: 'suggested' }, { confirmedOnly: true })).toBe(false)
    expect(isOpenWork(open, { confirmedOnly: true })).toBe(true)
  })

  it('countsAsWork ignores the state', () => {
    expect(countsAsWork({ parent_id: null, confirmation: 'confirmed' })).toBe(true)
    expect(countsAsWork({ parent_id: 'x', confirmation: 'confirmed' })).toBe(false)
    expect(countsAsWork({ parent_id: null, confirmation: 'dismissed' })).toBe(false)
  })
})

describe('filterOpenWork', () => {
  it('top level, not dismissed, closed states excluded with NULL kept', () => {
    const calls: Call[] = []
    filterOpenWork(recorder([], calls) as never, { closedStateIds: ['s-done', 's-canceled'] })
    expect(calls).toEqual([
      ['is', 'parent_id', null],
      ['neq', 'confirmation', 'dismissed'],
      ['or', 'status_id.is.null,status_id.not.in.(s-done,s-canceled)'],
    ])
  })

  it('confirmed only and one person through action_assignee', () => {
    const calls: Call[] = []
    filterOpenWork(recorder([], calls) as never, { closedStateIds: [], confirmedOnly: true, memberId: 'm-1' })
    expect(calls).toEqual([
      ['is', 'parent_id', null],
      ['eq', 'confirmation', 'confirmed'],
      ['eq', 'assigned.member_id', 'm-1'],
    ])
  })
})

describe('loadClosedStates', () => {
  it("reads the workspace teams' completed and canceled states", async () => {
    const stateCalls: Call[] = []
    const supabase = {
      from: (table: string) =>
        table === 'team'
          ? recorder([{ id: 't-1' }, { id: 't-2' }])
          : recorder([{ id: 's-done', category: 'completed' }, { id: 's-canceled', category: 'canceled' }], stateCalls),
    }
    expect(await loadClosedStates(supabase as never, 'ws-1')).toEqual({ ids: ['s-done', 's-canceled'], completedIds: ['s-done'] })
    expect(stateCalls).toContainEqual(['in', 'team_id', ['t-1', 't-2']])
    expect(stateCalls).toContainEqual(['in', 'category', ['completed', 'canceled']])
  })

  it('no teams, no states', async () => {
    const supabase = { from: () => recorder([]) }
    expect(await loadClosedStates(supabase as never, 'ws-1')).toEqual({ ids: [], completedIds: [] })
  })
})
