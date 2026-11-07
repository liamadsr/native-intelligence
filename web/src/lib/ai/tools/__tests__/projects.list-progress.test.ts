/**
 * list_projects' progress counts the actions that count as work (the shared
 * predicate, src/lib/actions/open-work.ts): top level and not dismissed. They
 * counted sub-actions and dismissed proposals, and read one request's worth of
 * rows (PostgREST stops at 1,000), so a big workspace's bars silently stopped
 * short. Rows are now read a page at a time up to PROJECT_STATS_MAX_ROWS, and
 * past that the result says the counts are partial.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createProjectTools, PROJECT_STATS_MAX_ROWS, PROJECT_STATS_PAGE } from '../projects'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type Call = [string, ...unknown[]]

/** A chain that records calls; `pageOf(from, to)` answers a `.range()`d read, else `rows`. */
function chain(rows: Row[], calls: Call[] = [], pageOf?: (from: number, to: number) => Row[]) {
  let range: [number, number] | null = null
  let proxy: Record<string, unknown>
  const self: Record<string, unknown> = {
    range: (from: number, to: number) => {
      calls.push(['range', from, to])
      range = [from, to]
      return proxy
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: range && pageOf ? pageOf(range[0], range[1]) : rows, error: null }).then(resolve),
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

const PROJECT = { id: 'p-1', workspace_id: 'ws-1', name: 'Atlas', status: 'active', target_date: null, lead: null, initiative: null }
const state = (category: string) => ({ category })

function setup(pageOf: (from: number, to: number) => Row[]) {
  const actionCalls: Call[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'projects') return chain([PROJECT])
      if (table === 'actions') return chain([], actionCalls, pageOf)
      return chain([])
    }),
  }
  const t = createProjectTools('u-1', supabase as never, 'ws-1')
  const run = async () =>
    (await t.list_projects.execute!({ include_archived: false, status: 'all', time_field: 'created_at' } as never, EXEC)) as {
      projects: Array<{ progress_pct: number; actions: string }>
      progress_partial?: string
    }
  return { run, actionCalls }
}

describe('list_projects — progress', () => {
  it('counts top-level, non-dismissed actions only', async () => {
    const rows: Row[] = [
      { project_id: 'p-1', parent_id: null, confirmation: 'confirmed', workflow_state: state('completed') },
      { project_id: 'p-1', parent_id: null, confirmation: 'suggested', workflow_state: state('unstarted') },
      { project_id: 'p-1', parent_id: null, confirmation: 'confirmed', workflow_state: state('canceled') },
      { project_id: 'p-1', parent_id: null, confirmation: 'confirmed', workflow_state: null },
      // Left out even if the query let them through:
      { project_id: 'p-1', parent_id: 'a-1', confirmation: 'confirmed', workflow_state: state('completed') },
      { project_id: 'p-1', parent_id: null, confirmation: 'dismissed', workflow_state: state('unstarted') },
    ]
    const { run, actionCalls } = setup((from) => (from === 0 ? rows : []))
    const res = await run()

    expect(actionCalls).toContainEqual(['is', 'parent_id', null])
    expect(actionCalls).toContainEqual(['neq', 'confirmation', 'dismissed'])
    expect(res.projects[0].actions).toBe('1/4 (1 canceled)')
    expect(res.projects[0].progress_pct).toBe(33)
    expect(res).not.toHaveProperty('progress_partial')
  })

  it('reads every page in a stable order, past the 1,000-row request cap', async () => {
    const done = { project_id: 'p-1', parent_id: null, confirmation: 'confirmed', workflow_state: state('completed') }
    const { run, actionCalls } = setup((from) => (from === 0 ? Array(PROJECT_STATS_PAGE).fill(done) : from === PROJECT_STATS_PAGE ? [done, done] : []))
    const res = await run()

    expect(actionCalls).toContainEqual(['order', 'id', { ascending: true }])
    expect(actionCalls.filter((c) => c[0] === 'range')).toEqual([
      ['range', 0, PROJECT_STATS_PAGE - 1],
      ['range', PROJECT_STATS_PAGE, 2 * PROJECT_STATS_PAGE - 1],
    ])
    expect(res.projects[0].actions).toBe(`${PROJECT_STATS_PAGE + 2}/${PROJECT_STATS_PAGE + 2} (0 canceled)`)
    expect(res).not.toHaveProperty('progress_partial')
  })

  it(`stops at ${PROJECT_STATS_MAX_ROWS} rows and says the counts are partial`, async () => {
    const open = { project_id: 'p-1', parent_id: null, confirmation: 'confirmed', workflow_state: state('unstarted') }
    const { run, actionCalls } = setup(() => Array(PROJECT_STATS_PAGE).fill(open))
    const res = await run()

    expect(actionCalls.filter((c) => c[0] === 'range')).toHaveLength(PROJECT_STATS_MAX_ROWS / PROJECT_STATS_PAGE)
    expect(res.projects[0].actions).toBe(`0/${PROJECT_STATS_MAX_ROWS} (0 canceled)`)
    expect(res.progress_partial).toMatch(/first 5000 actions/)
  })
})
