import { describe, it, expect } from 'vitest'
import { groupResults } from '../query-engine'
import type { GroupConfig } from '../types'

const statusGrouping: GroupConfig = { field: 'status_id', direction: 'asc' }

/** Build an action row with a joined workflow_state, like the query returns. */
function action(opts: {
  id: string
  team: string
  category: string
  name: string
  sort_order: number
}) {
  return {
    id: opts.id,
    team_id: opts.team,
    status_id: `${opts.team}-${opts.name}`,
    workflow_state: {
      id: `${opts.team}-${opts.name}`,
      name: opts.name,
      category: opts.category,
      sort_order: opts.sort_order,
    },
  }
}

describe('groupResults — status_id grouping', () => {
  describe('single-team board (mergeByCategory = false)', () => {
    it('keys columns by category::name and orders by sort_order', () => {
      const items = [
        action({ id: 'a', team: 't1', category: 'started', name: 'In Progress', sort_order: 2 }),
        action({ id: 'b', team: 't1', category: 'unstarted', name: 'Todo', sort_order: 1 }),
        action({ id: 'c', team: 't1', category: 'backlog', name: 'Backlog', sort_order: 0 }),
      ]
      const groups = groupResults(items, statusGrouping, null, false)
      expect(groups.map(g => g.key)).toEqual([
        'backlog::Backlog',
        'unstarted::Todo',
        'started::In Progress',
      ])
    })

    it('keeps distinct custom statuses in the same category separate', () => {
      const items = [
        action({ id: 'a', team: 't1', category: 'unstarted', name: 'Todo', sort_order: 1 }),
        action({ id: 'b', team: 't1', category: 'unstarted', name: 'Up Next', sort_order: 2 }),
      ]
      const groups = groupResults(items, statusGrouping, null, false)
      expect(groups.map(g => g.key)).toEqual(['unstarted::Todo', 'unstarted::Up Next'])
    })
  })

  describe('cross-team board (mergeByCategory = true)', () => {
    it('collapses all teams into one column per category', () => {
      const items = [
        action({ id: 'a', team: 't1', category: 'unstarted', name: 'Todo', sort_order: 1 }),
        action({ id: 'b', team: 't2', category: 'unstarted', name: 'Up Next', sort_order: 1 }),
        action({ id: 'c', team: 't1', category: 'started', name: 'In Progress', sort_order: 2 }),
      ]
      const groups = groupResults(items, statusGrouping, null, true)
      expect(groups.map(g => g.key)).toEqual(['unstarted', 'started'])
      // Both teams' unstarted actions land in the single 'unstarted' column.
      expect(groups.find(g => g.key === 'unstarted')!.items.map(i => i.id).sort()).toEqual(['a', 'b'])
    })

    it('orders columns by fixed canonical category order, not sort_order', () => {
      // Deliberately feed items in a scrambled order with mismatched sort_orders.
      const items = [
        action({ id: 'a', team: 't1', category: 'completed', name: 'Done', sort_order: 0 }),
        action({ id: 'b', team: 't2', category: 'backlog', name: 'Icebox', sort_order: 9 }),
        action({ id: 'c', team: 't1', category: 'started', name: 'In Progress', sort_order: 5 }),
        action({ id: 'd', team: 't2', category: 'unstarted', name: 'Todo', sort_order: 3 }),
        action({ id: 'e', team: 't1', category: 'canceled', name: 'Canceled', sort_order: 1 }),
      ]
      const groups = groupResults(items, statusGrouping, null, true)
      expect(groups.map(g => g.key)).toEqual([
        'backlog',
        'unstarted',
        'started',
        'completed',
        'canceled',
      ])
    })

    it('is deterministic regardless of which team appears first (the revert bug)', () => {
      // Two teams, same category, SAME sort_order — the tie that used to make
      // the merged column order non-deterministic across fetches.
      const order1 = groupResults(
        [
          action({ id: 'a', team: 't1', category: 'unstarted', name: 'Todo', sort_order: 1 }),
          action({ id: 'b', team: 't2', category: 'unstarted', name: 'Todo', sort_order: 1 }),
          action({ id: 'c', team: 't1', category: 'backlog', name: 'Backlog', sort_order: 0 }),
        ],
        statusGrouping,
        null,
        true,
      ).map(g => g.key)
      const order2 = groupResults(
        [
          action({ id: 'b', team: 't2', category: 'unstarted', name: 'Todo', sort_order: 1 }),
          action({ id: 'c', team: 't1', category: 'backlog', name: 'Backlog', sort_order: 0 }),
          action({ id: 'a', team: 't1', category: 'unstarted', name: 'Todo', sort_order: 1 }),
        ],
        statusGrouping,
        null,
        true,
      ).map(g => g.key)
      expect(order1).toEqual(['backlog', 'unstarted'])
      expect(order2).toEqual(order1)
    })

    it('uses human-readable category labels', () => {
      const items = [
        action({ id: 'a', team: 't1', category: 'unstarted', name: 'Up Next', sort_order: 1 }),
        action({ id: 'b', team: 't1', category: 'started', name: 'Doing', sort_order: 2 }),
      ]
      const groups = groupResults(items, statusGrouping, null, true)
      const labels = Object.fromEntries(groups.map(g => [g.key, g.label]))
      expect(labels.unstarted).toBe('Todo')
      expect(labels.started).toBe('In Progress')
    })
  })
})

describe('groupResults — date-only fields', () => {
  it('keys a bare YYYY-MM-DD by its own day west of UTC (not the UTC-midnight instant)', () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const groups = groupResults(
        [{ id: 'p1', target_date: '2026-10-21' }],
        { field: 'target_date', direction: 'asc' },
        null,
      )
      expect(groups.map((g) => g.key)).toEqual(['2026-10-21'])
    } finally {
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })
})
