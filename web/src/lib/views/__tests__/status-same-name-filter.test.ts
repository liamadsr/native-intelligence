/**
 * Status `is` / `is not` on actions: the chip holds ONE workflow_state id, but
 * states are per team and the picker offers one option per name. The engine
 * widens the id to every in-scope state with the same name and category, so a
 * "Status is Todo" view keeps every team's Todo actions.
 */
import { describe, it, expect } from 'vitest'
import { applyFilters } from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

function makeQuerySpy() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args })
          return proxy
        }
      },
    },
  )
  return { query: proxy, calls }
}

const STATES = [
  { id: 'todo-a', name: 'Todo', category: 'unstarted', team: { workspace_id: 'ws-1' } },
  { id: 'todo-b', name: 'Todo', category: 'unstarted', team: { workspace_id: 'ws-1' } },
  { id: 'todo-other-ws', name: 'Todo', category: 'unstarted', team: { workspace_id: 'ws-2' } },
  { id: 'done-a', name: 'Done', category: 'completed', team: { workspace_id: 'ws-1' } },
]

/** Every `.eq` the workflow_state reads issued, in order. */
const stateEqs: Array<[string, unknown]> = []

/** workflow_state reads: `.eq('id')` + maybeSingle, or `.eq('name').eq('category')` awaited. */
function fakeSupabase() {
  stateEqs.length = 0
  return {
    from: () => {
      const eqs: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          eqs[col] = v
          stateEqs.push([col, v])
          return chain
        },
        maybeSingle: async () => ({ data: STATES.find((s) => s.id === eqs.id) ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: STATES.filter((s) => s.name === eqs.name && s.category === eqs.category),
            error: null,
          }),
      }
      return chain
    },
  }
}

async function run(operator: 'is' | 'is_not', value: string) {
  const { query, calls } = makeQuerySpy()
  const f: ViewFilter = { id: 'f', field: 'status_id', operator, value }
  await applyFilters(query as never, 'action', [f], fakeSupabase() as never, 'ws-1')
  return calls.filter((c) => c.args[0] === 'status_id')
}

describe('status is / is not across teams', () => {
  it('`is` matches every same-named state in the workspace', async () => {
    expect(await run('is', 'todo-a')).toEqual([{ method: 'in', args: ['status_id', ['todo-a', 'todo-b']] }])
  })

  it('`is not` excludes every same-named state in the workspace', async () => {
    expect(await run('is_not', 'todo-b')).toEqual([
      { method: 'not', args: ['status_id', 'in', '(todo-b,todo-a)'] },
    ])
  })

  it('the same-name read is fenced to the workspace in SQL, not read across tenants', async () => {
    await run('is', 'todo-a')
    expect(stateEqs).toContainEqual(['team.workspace_id', 'ws-1'])
  })

  it('an id that does not resolve still filters on itself', async () => {
    expect(await run('is', 'gone')).toEqual([{ method: 'in', args: ['status_id', ['gone']] }])
  })
})
