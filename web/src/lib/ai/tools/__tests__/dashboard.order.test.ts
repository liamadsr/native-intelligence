/**
 * get_dashboard_summary: the person's open work, the same set `list_actions`
 * returns for assignee 'me' + confirmation 'confirmed' (the shared predicate in
 * src/lib/actions/open-work.ts), with its overdue and in-progress lists capped
 * at 10, so the order decides which rows the model sees: most urgent first,
 * then earliest due.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createDashboardTools } from '../dashboard'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type Call = [string, ...unknown[]]

/** A chain that records every builder call and resolves to `rows` (and `count`). */
function chain(rows: Row[], calls: Call[] = [], count?: number) {
  let proxy: Record<string, unknown>
  const self: Record<string, unknown> = {
    single: async () => ({ data: rows[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null, count: count ?? null }).then(resolve),
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

const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
const started = { name: 'In Progress', category: 'started' }
const todo = { name: 'Todo', category: 'unstarted' }
const done = { name: 'Done', category: 'completed' }
const mine = { parent_id: null, confirmation: 'confirmed' }

function setup(actions: Row[], opts: { completedCount?: number } = {}) {
  const actionQueries: Call[][] = []
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'member') return chain([{ id: 'm-1', display_name: 'Me' }])
      if (table === 'team') return chain([{ id: 't-1' }])
      if (table === 'workflow_state') return chain([{ id: 'state-done', category: 'completed' }, { id: 'state-canceled', category: 'canceled' }])
      if (table === 'actions') {
        const calls: Call[] = []
        actionQueries.push(calls)
        // The first actions query is the open list; the second, the done-this-week count.
        return actionQueries.length === 1 ? chain(actions, calls) : chain([], calls, opts.completedCount ?? 0)
      }
      return chain([])
    }),
  }
  const t = createDashboardTools('u-1', supabase as never, 'ws-1')
  const run = async () =>
    (await t.get_dashboard_summary.execute!({} as never, EXEC)) as {
      overdue_count: number
      in_progress_count: number
      upcoming_count: number
      recently_completed_count: number
      overdue_actions: Array<{ identifier: string }>
      in_progress_actions: Array<{ identifier: string }>
    }
  return { run, actionQueries }
}

describe('get_dashboard_summary — order', () => {
  it('lists overdue and in-progress work urgent first, then earliest due', async () => {
    const { run } = setup([
      { ...mine, identifier: 'O-NONE', title: 'a', priority: 'none', due_at: past(9), workflow_state: started },
      { ...mine, identifier: 'O-URGENT-NEW', title: 'b', priority: 'urgent', due_at: past(1), workflow_state: started },
      { ...mine, identifier: 'O-URGENT-OLD', title: 'c', priority: 'urgent', due_at: past(5), workflow_state: started },
      { ...mine, identifier: 'O-HIGH', title: 'd', priority: 'high', due_at: past(2), workflow_state: started },
      { ...mine, identifier: 'P-LOW', title: 'e', priority: 'low', due_at: null, workflow_state: started },
      { ...mine, identifier: 'P-URGENT', title: 'f', priority: 'urgent', due_at: null, workflow_state: started },
    ])
    const res = await run()

    expect(res.overdue_actions.map((a) => a.identifier)).toEqual(['O-URGENT-OLD', 'O-URGENT-NEW', 'O-HIGH', 'O-NONE'])
    expect(res.in_progress_actions.map((a) => a.identifier)).toEqual(['P-URGENT', 'P-LOW'])
  })
})

describe('get_dashboard_summary — the open-work predicate', () => {
  it('reads open, confirmed, top-level work assigned through action_assignee, closed states excluded', async () => {
    const { run, actionQueries } = setup([])
    await run()
    const open = actionQueries[0]

    const select = open.find((c) => c[0] === 'select')!
    expect(select[1]).toContain('assigned:action_assignee!inner(member_id)')
    expect(open).toContainEqual(['eq', 'assigned.member_id', 'm-1'])
    expect(open).toContainEqual(['is', 'parent_id', null])
    expect(open).toContainEqual(['eq', 'confirmation', 'confirmed'])
    expect(open).toContainEqual(['or', 'status_id.is.null,status_id.not.in.(state-done,state-canceled)'])
    // Never the assignee_id column alone: it holds only the first assignee.
    expect(open).not.toContainEqual(['eq', 'assignee_id', 'm-1'])
  })

  it('counts done-this-week from completed states only, for the same person', async () => {
    const { run, actionQueries } = setup([], { completedCount: 4 })
    const res = await run()
    const count = actionQueries[1]

    expect(res.recently_completed_count).toBe(4)
    expect(count).toContainEqual(['in', 'status_id', ['state-done']])
    expect(count).toContainEqual(['eq', 'assigned.member_id', 'm-1'])
    expect(count).toContainEqual(['eq', 'confirmation', 'confirmed'])
    expect(count).toContainEqual(['is', 'parent_id', null])
  })

  it('leaves out suggested, dismissed, sub-actions and closed rows even when the query let them through', async () => {
    const { run } = setup([
      { ...mine, identifier: 'OPEN-OVERDUE', title: 'a', priority: 'none', due_at: past(1), workflow_state: todo },
      { ...mine, identifier: 'OPEN-LATER', title: 'b', priority: 'none', due_at: future(3), workflow_state: todo },
      { ...mine, identifier: 'NO-STATE', title: 'c', priority: 'none', due_at: null, workflow_state: null },
      { ...mine, confirmation: 'suggested', identifier: 'SUGGESTED', title: 'd', priority: 'none', due_at: past(1), workflow_state: todo },
      { ...mine, confirmation: 'dismissed', identifier: 'DISMISSED', title: 'e', priority: 'none', due_at: past(1), workflow_state: todo },
      { ...mine, parent_id: 'parent', identifier: 'SUB', title: 'f', priority: 'none', due_at: past(1), workflow_state: todo },
      { ...mine, identifier: 'DONE', title: 'g', priority: 'none', due_at: past(1), workflow_state: done },
    ])
    const res = await run()

    expect(res.overdue_actions.map((a) => a.identifier)).toEqual(['OPEN-OVERDUE'])
    expect(res.overdue_count).toBe(1)
    // An action whose state didn't resolve still counts as open work.
    expect(res.upcoming_count).toBe(2)
    expect(res.in_progress_count).toBe(0)
  })
})
