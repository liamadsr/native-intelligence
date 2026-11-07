/**
 * get_project_context's actions: the project's OPEN actions, most urgent first.
 *
 * Regression (2026-10-14 audit): it read `.order('priority').limit(20)` and
 * dropped completed/canceled rows afterwards. The priority enum sorts
 * none → urgent, so it took the 20 LEAST urgent rows, and finished rows inside
 * that cap left fewer than 20, under-reporting open work. The state filter now
 * runs in the query before the cap, priority sorts descending, and the result
 * says how many open actions there are in all.
 *
 * The open set is the shared predicate (src/lib/actions/open-work.ts): closed
 * states are excluded rather than open ones inner-joined, so an action whose
 * state doesn't resolve is kept, and each row says its confirmation.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createProjectTools } from '../projects'

const USER_ID = 'user-1'
const WS_ID = 'ws-1'
const PROJECT_ID = 'p-1'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Call = [string, ...unknown[]]
type Row = Record<string, unknown>

/** A chain that records every builder call and resolves to `rows` (and `count`). */
function recordingChain(rows: Row[], calls: Call[], count?: number) {
  let proxy: Record<string, unknown>
  const self: Record<string, unknown> = {
    single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null, count: count ?? rows.length }).then(resolve),
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

const action = (i: number, priority: string, confirmation = 'confirmed') => ({
  id: `a-${i}`,
  identifier: `GEN-${i}`,
  title: `Action ${i}`,
  priority,
  due_at: null,
  confirmation,
  workflow_state: { name: 'Todo', category: 'unstarted' },
})

function setup(actionRows: Row[], openTotal: number) {
  const actionCalls: Call[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'projects') {
        return recordingChain([{ id: PROJECT_ID, workspace_id: WS_ID, name: 'Atlas', status: 'active' }], [])
      }
      if (table === 'actions') return recordingChain(actionRows, actionCalls, openTotal)
      if (table === 'team') return recordingChain([{ id: 't-1' }], [])
      if (table === 'workflow_state') {
        return recordingChain([{ id: 'state-done', category: 'completed' }, { id: 'state-canceled', category: 'canceled' }], [])
      }
      return recordingChain([], [])
    }),
  }
  const t = createProjectTools(USER_ID, supabase as never, WS_ID)
  const run = async () =>
    (await t.get_project_context.execute!({ project_id: PROJECT_ID } as never, EXEC)) as Record<string, unknown>
  return { run, actionCalls }
}

describe('get_project_context — open actions', () => {
  it('excludes closed states in the query, before the cap, keeping rows whose state does not resolve', async () => {
    const { run, actionCalls } = setup([action(1, 'urgent')], 1)
    await run()

    const names = actionCalls.map((c) => c[0])
    const select = actionCalls.find((c) => c[0] === 'select')!
    // A left embed: an inner join would drop a row whose state doesn't resolve.
    expect(select[1]).toContain('workflow_state:workflow_state!status_id(')
    expect(select[1]).not.toContain('!inner')
    expect(select[1]).toContain('confirmation')
    expect(select[2]).toEqual({ count: 'exact' })
    expect(actionCalls).toContainEqual(['or', 'status_id.is.null,status_id.not.in.(state-done,state-canceled)'])
    expect(actionCalls).toContainEqual(['eq', 'project_id', PROJECT_ID])
    expect(actionCalls).toContainEqual(['is', 'parent_id', null])
    expect(actionCalls).toContainEqual(['neq', 'confirmation', 'dismissed'])
    // The state filter and the order come before the limit.
    expect(names.indexOf('or')).toBeLessThan(names.indexOf('limit'))
    expect(actionCalls).toContainEqual(['limit', 20])
  })

  it('returns each row with its confirmation', async () => {
    const { run } = setup([action(1, 'urgent'), action(2, 'low', 'suggested')], 2)
    const res = await run()
    expect((res.active_actions as Row[]).map((a) => a.confirmation)).toEqual(['confirmed', 'suggested'])
  })

  it('orders urgent first, then earliest due, undated last', async () => {
    const { run, actionCalls } = setup([], 0)
    await run()
    expect(actionCalls.filter((c) => c[0] === 'order')).toEqual([
      ['order', 'priority', { ascending: false, nullsFirst: false }],
      ['order', 'due_at', { ascending: true, nullsFirst: false }],
    ])
  })

  it('reports the open total and says to page list_actions when more exist than it lists', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => action(i, 'high'))
    const { run } = setup(rows, 57)
    const res = await run()

    expect(res.success).toBe(true)
    expect(res.active_actions as Row[]).toHaveLength(20)
    expect(res.open_actions_total).toBe(57)
    expect(res.more_open_actions).toMatch(/20 most urgent of 57 open actions/)
    expect(res.more_open_actions).toMatch(new RegExp(`list_actions with project_id ${PROJECT_ID}`))
  })

  it('says nothing more when every open action is listed', async () => {
    const { run } = setup([action(1, 'urgent'), action(2, 'low')], 2)
    const res = await run()

    expect(res.open_actions_total).toBe(2)
    expect(res).not.toHaveProperty('more_open_actions')
    expect((res.active_actions as Row[]).map((a) => a.identifier)).toEqual(['GEN-1', 'GEN-2'])
  })
})
