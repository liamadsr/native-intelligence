/**
 * The "Completed issues" window (lib/views/completed-window.ts): the choices,
 * what a NEW action list opens on versus what a SAVED view keeps, the older
 * `recent` value, the way a window is stored while the view table's CHECK
 * (migration 039) cannot hold it, and the SQL shape applyCompletedFilter
 * sends for each choice.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  COMPLETED_FILTER_OPTIONS,
  DEFAULT_ACTION_COMPLETED_FILTER,
  completedFilterForStorage,
  completedFilterOfView,
  completedWindowStart,
  normalizeCompletedFilter,
  VIEW_COLUMN_TAKES_COMPLETED_WINDOWS,
} from '@/lib/views/completed-window'
import { applyCompletedFilter, COMPLETED_AT_COLUMN } from '@/lib/views/query-engine'
import { defaultConfig } from '@/components/views/hooks/use-view'

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-a' }))

const NOW = new Date('2026-11-20T12:00:00.000Z')

type Call = { method: string; args: unknown[] }
function recorder(result: unknown = { data: [], error: null }) {
  const calls: Call[] = []
  const chain: Record<string, unknown> = { then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb) }
  for (const method of ['select', 'eq', 'in', 'not', 'or']) {
    chain[method] = vi.fn((...args: unknown[]) => { calls.push({ method, args }); return chain })
  }
  return { chain, calls }
}
function client(states: Array<{ id: string; ws: string }>) {
  const { chain, calls } = recorder({ data: states.map((s) => ({ id: s.id, team: { workspace_id: s.ws } })), error: null })
  const tables: string[] = []
  return { supabase: { from: (t: string) => { tables.push(t); return chain } } as never, calls, tables }
}

describe('the choices', () => {
  it('offers Past day, Past week, Past month, All and None, in that order', () => {
    expect(COMPLETED_FILTER_OPTIONS.map((o) => o.label)).toEqual(['Past day', 'Past week', 'Past month', 'All', 'None'])
  })

  it('a NEW action list opens on the past week; every other entity keeps all', () => {
    expect(DEFAULT_ACTION_COMPLETED_FILTER).toBe('past_week')
    expect(defaultConfig('action').completed_filter).toBe('past_week')
    expect(defaultConfig('action', true).completed_filter).toBe('past_week')
    expect(defaultConfig('project').completed_filter).toBe('all')
    expect(defaultConfig('capture').completed_filter).toBe('all')
  })

  it('anything unrecognised reads as all, never fewer rows than asked for', () => {
    expect(normalizeCompletedFilter(undefined)).toBe('all')
    expect(normalizeCompletedFilter('yesterday')).toBe('all')
    expect(normalizeCompletedFilter(7)).toBe('all')
    expect(normalizeCompletedFilter('past_month')).toBe('past_month')
  })
})

describe('the windows', () => {
  it('are rolling, from now', () => {
    expect(completedWindowStart('past_day', NOW)).toBe('2026-11-19T12:00:00.000Z')
    expect(completedWindowStart('past_week', NOW)).toBe('2026-11-13T12:00:00.000Z')
    expect(completedWindowStart('past_month', NOW)).toBe('2026-10-20T12:00:00.000Z')
  })

  it("the older 'recent' keeps its meaning: the past 2 weeks", () => {
    expect(completedWindowStart('recent', NOW)).toBe('2026-11-06T12:00:00.000Z')
  })

  it('all and none have no window', () => {
    expect(completedWindowStart('all', NOW)).toBeNull()
    expect(completedWindowStart('none', NOW)).toBeNull()
  })
})

describe('a saved view keeps exactly what it stores', () => {
  it('an old all stays all, none stays none, recent stays recent', () => {
    expect(completedFilterOfView({ completed_filter: 'all', metadata: {} })).toBe('all')
    expect(completedFilterOfView({ completed_filter: 'none' })).toBe('none')
    expect(completedFilterOfView({ completed_filter: 'recent', metadata: {} })).toBe('recent')
    expect(completedFilterOfView({ completed_filter: null })).toBe('all')
  })

  it('a window saved before migration 672 is read back from metadata', () => {
    expect(completedFilterOfView({ completed_filter: 'recent', metadata: { completed_window: 'past_day' } })).toBe('past_day')
  })

  it('the column wins when older code wrote something else over it', () => {
    expect(completedFilterOfView({ completed_filter: 'none', metadata: { completed_window: 'past_day' } })).toBe('none')
  })

  it('a window in the column itself (after 672) reads as is', () => {
    expect(completedFilterOfView({ completed_filter: 'past_week', metadata: {} })).toBe('past_week')
  })
})

describe('storage', () => {
  it("before 672: a window is written as 'recent' with the window in metadata, other keys kept", () => {
    expect(completedFilterForStorage('past_week', { action_scope: 'assigned' }, { columnTakesWindows: false })).toEqual({
      completed_filter: 'recent',
      metadata: { action_scope: 'assigned', completed_window: 'past_week' },
    })
  })

  it('a value the column takes is written as is, and a stale window key is dropped', () => {
    expect(completedFilterForStorage('none', { completed_window: 'past_day', table: { x: 1 } }, { columnTakesWindows: false })).toEqual({
      completed_filter: 'none',
      metadata: { table: { x: 1 } },
    })
  })

  it('this build writes the window in the column (migration 672 applied)', () => {
    expect(VIEW_COLUMN_TAKES_COMPLETED_WINDOWS).toBe(true)
  })

  it('after 672: the window goes in the column', () => {
    expect(completedFilterForStorage('past_month', null, { columnTakesWindows: true })).toEqual({
      completed_filter: 'past_month',
      metadata: {},
    })
  })

  it('round-trips every choice either way', () => {
    for (const { value } of COMPLETED_FILTER_OPTIONS) {
      for (const columnTakesWindows of [false, true]) {
        expect(completedFilterOfView(completedFilterForStorage(value, {}, { columnTakesWindows }))).toBe(value)
      }
    }
  })
})

describe('applyCompletedFilter — the SQL shape', () => {
  const states = [{ id: 's-done', ws: 'ws-a' }, { id: 's-cancel', ws: 'ws-a' }]

  it('past week: every open action, and the finished ones finished in the past 7 days', async () => {
    const c = client(states)
    const q = recorder()
    await applyCompletedFilter(c.supabase, q.chain as never, 'past_week', true, 'ws-a', { now: NOW })
    expect(q.calls).toEqual([{
      method: 'or',
      args: ['status_id.not.in.(s-done,s-cancel),and(status_id.in.(s-done,s-cancel),completed_at.gte.2026-11-13T12:00:00.000Z)'],
    }])
  })

  it('measures on completed_at (migration 672), not updated_at, which any edit moves', () => {
    expect(COMPLETED_AT_COLUMN).toBe('completed_at')
  })

  it("'recent' still means 14 days", async () => {
    const c = client(states)
    const q = recorder()
    await applyCompletedFilter(c.supabase, q.chain as never, 'recent', true, 'ws-a', { now: NOW })
    expect(String(q.calls[0].args[0])).toContain('.gte.2026-11-06T12:00:00.000Z')
  })

  it('none (or Show completed off) excludes them all', async () => {
    for (const [filter, shown] of [['none', true], ['past_week', false]] as const) {
      const c = client(states)
      const q = recorder()
      await applyCompletedFilter(c.supabase, q.chain as never, filter, shown, 'ws-a', { now: NOW })
      expect(q.calls).toEqual([{ method: 'not', args: ['status_id', 'in', '(s-done,s-cancel)'] }])
    }
  })

  it('all reads nothing and adds nothing', async () => {
    const c = client(states)
    const q = recorder()
    await applyCompletedFilter(c.supabase, q.chain as never, 'all', true, 'ws-a', { now: NOW })
    expect(c.tables).toEqual([])
    expect(q.calls).toEqual([])
  })

  it('a workspace with no finished states adds no empty in.() list', async () => {
    const c = client([])
    const q = recorder()
    await applyCompletedFilter(c.supabase, q.chain as never, 'past_day', true, 'ws-a', { now: NOW })
    expect(q.calls).toEqual([])
  })
})
