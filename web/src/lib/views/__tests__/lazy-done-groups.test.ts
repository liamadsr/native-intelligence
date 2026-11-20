/**
 * The client-side half of the lazy finished groups (lib/views/lazy-done-groups.ts):
 * how a status grouping keys them, a refetch keeping what the person opened,
 * a group's page merged in, and the count following a card.
 */
import { describe, it, expect } from 'vitest'
import {
  carryLazyItems,
  groupCount,
  isLazyGroup,
  mergeGroupPage,
  planLazyDoneGroups,
  wantsLazyDoneGroups,
  withCountDelta,
} from '@/lib/views/lazy-done-groups'
import { CATEGORY_LABELS } from '@/lib/views/query-engine'

const states = [
  { id: 'd-a', name: 'Done', category: 'completed', sort_order: 4, team_id: 'team-a' },
  { id: 'c-a', name: 'Canceled', category: 'canceled', sort_order: 5, team_id: 'team-a' },
  { id: 'd-b', name: 'Shipped', category: 'completed', sort_order: 4, team_id: 'team-b' },
  { id: 'd-b2', name: 'Done', category: 'completed', sort_order: 6, team_id: 'team-b' },
]

const row = (id: string) => ({ id, title: id })
type G = { key: string; label: string; items: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }
const lazy = (key: string, items: Array<Record<string, unknown>>, count: number): G => ({ key, label: key, items, metadata: { lazy: true, count, status_ids: ['s'] } })
const open = (key: string, items: Array<Record<string, unknown>>): G => ({ key, label: key, items })

describe('planLazyDoneGroups', () => {
  it('cross-team: one group per category, every team\'s states in it, each team\'s first as its drop target', () => {
    const plans = planLazyDoneGroups(states, true, CATEGORY_LABELS)
    expect(plans.map((p) => [p.key, p.label])).toEqual([['canceled', 'Canceled'], ['completed', 'Done']])
    const done = plans.find((p) => p.key === 'completed')!
    expect(done.statusIds).toEqual(['d-a', 'd-b', 'd-b2'])
    expect(done.statusIdByTeam).toEqual({ 'team-a': 'd-a', 'team-b': 'd-b' })
  })

  it('one team: keyed category::name, as groupResults keys a team board', () => {
    const plans = planLazyDoneGroups(states.filter((s) => s.team_id === 'team-b'), false, CATEGORY_LABELS)
    expect(plans.map((p) => p.key)).toEqual(['completed::Shipped', 'completed::Done'])
    expect(plans.map((p) => p.label)).toEqual(['Shipped', 'Done'])
  })
})

describe('wantsLazyDoneGroups', () => {
  it('actions grouped by status, without a sub-grouping', () => {
    expect(wantsLazyDoneGroups({ entity_type: 'action', grouping: { field: 'status_id' } })).toBe(true)
    expect(wantsLazyDoneGroups({ entity_type: 'action', grouping: { field: 'status_id' }, sub_grouping: { field: 'priority' } })).toBe(false)
    expect(wantsLazyDoneGroups({ entity_type: 'action', grouping: { field: 'priority' } })).toBe(false)
    expect(wantsLazyDoneGroups({ entity_type: 'action', grouping: null })).toBe(false)
    expect(wantsLazyDoneGroups({ entity_type: 'project', grouping: { field: 'status_id' } })).toBe(false)
  })
})

describe('groupCount', () => {
  it('a lazy group shows the server count; any other group its rows', () => {
    expect(groupCount(lazy('completed', [row('a')], 312))).toBe(312)
    expect(groupCount(open('todo', [row('a'), row('b')]))).toBe(2)
    expect(isLazyGroup(open('todo', []))).toBe(false)
  })
})

describe('carryLazyItems — a refetch never collapses what the person opened', () => {
  it('keeps the rows an opened finished group had', () => {
    const prev = [open('todo', [row('t1')]), lazy('completed', [row('d1'), row('d2')], 2)]
    const next = [open('todo', [row('t1')]), lazy('completed', [], 3)]
    const out = carryLazyItems(prev, next)
    expect(out[1].items.map((r) => r.id)).toEqual(['d1', 'd2'])
    expect(out[1].metadata!.count).toBe(3)
  })

  it('drops a row the fresh page has in an open group (it was reopened)', () => {
    const prev = [open('todo', []), lazy('completed', [row('d1'), row('d2')], 2)]
    const next = [open('todo', [row('d2')]), lazy('completed', [], 1)]
    const out = carryLazyItems(prev, next)
    expect(out[0].items.map((r) => r.id)).toEqual(['d2'])
    expect(out[1].items.map((r) => r.id)).toEqual(['d1'])
  })

  it('leaves the open groups exactly as the fresh page has them', () => {
    const next = [open('todo', [row('t1'), row('t2')]), lazy('completed', [], 0)]
    expect(carryLazyItems([], next)[0]).toBe(next[0])
  })
})

describe('mergeGroupPage', () => {
  it('appends the next page, never a row twice, never an open row', () => {
    const groups = [open('todo', [row('t1')]), lazy('completed', [row('d1')], 4)]
    const out = mergeGroupPage(groups, 'completed', [row('d1'), row('d2'), row('t1')], { replace: false })
    expect(out[1].items.map((r) => r.id)).toEqual(['d1', 'd2'])
    expect(out[0]).toBe(groups[0])
  })

  it('a reload replaces what the group held', () => {
    const groups = [lazy('completed', [row('old')], 1)]
    expect(mergeGroupPage(groups, 'completed', [row('d1')], { replace: true })[0].items.map((r) => r.id)).toEqual(['d1'])
  })
})

describe('withCountDelta', () => {
  it('a card dragged to Done adds one to the count; out of it, takes one off; never below zero', () => {
    expect(withCountDelta(lazy('completed', [], 312), 1).metadata!.count).toBe(313)
    expect(withCountDelta(lazy('completed', [], 0), -1).metadata!.count).toBe(0)
    const plain = open('todo', [])
    expect(withCountDelta(plain, 1)).toBe(plain)
  })
})
