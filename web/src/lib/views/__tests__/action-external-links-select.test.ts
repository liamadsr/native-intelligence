/**
 * `external_links` on the action view select — the plumbing that lets every
 * action row draw its platform mark without asking a question of its own.
 *
 * The whole point is what is NOT here: no per-row fetch, no enrichment pass, no
 * second query. It is one embedded join in the select the view already runs, so
 * the links arrive in the same response that draws the row.
 *
 * Two things are worth pinning, and both are cheap to break by accident:
 *
 *  1. THE JOIN EXISTS AND IS THIN. `provider` and nothing else — the urls,
 *     titles and ids live behind the menu, which fetches them when it opens.
 *     Widening this select is how a board of 500 rows starts carrying 500 rows
 *     of link metadata nobody renders.
 *  2. IT IS SCOPED TO ACTIONS. No other entity has external tasks, and adding
 *     the join to a select whose table has no such relationship is a PostgREST
 *     error rather than an empty array — the query would 500, not degrade.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery } from '@/lib/views/query-engine'
import { ACTION_LIST_SELECT } from '@/lib/views/action-list-select'
import type { ViewEntityType } from '@/lib/views/types'

/** A Supabase query builder that records the select string it was handed. */
function makeSupabase() {
  const selects: string[] = []
  const chain = {
    select: vi.fn((columns: string) => {
      selects.push(columns)
      return chain
    }),
    eq: vi.fn(() => chain),
    // Capture queries carry the visibility predicate (see capture-visibility.test.ts).
    or: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  }
  return {
    supabase: { from: vi.fn(() => chain) },
    selects,
  }
}

function selectFor(entityType: ViewEntityType): string {
  const { supabase, selects } = makeSupabase()
  buildEntityQuery(supabase as never, entityType, 'ws-1', 'user-1')
  return selects[0]
}

describe('ACTION_VIEW_SELECT — external_links', () => {
  it('joins action_external_task onto every action row', () => {
    expect(selectFor('action')).toContain('external_links:action_external_task(provider)')
  })

  it('selects the PROVIDER ONLY — the icon needs nothing else', () => {
    // The menu fetches the full rows (ids, urls, titles) when it opens. Carrying
    // them here would put link metadata nobody renders on every row of a board.
    const select = selectFor('action')
    const join = select.match(/external_links:action_external_task\(([^)]*)\)/)
    expect(join).toBeTruthy()
    expect(join![1].split(',').map((c) => c.trim())).toEqual(['provider'])
  })

  it('rides the SAME query as the rest of the row — no second round trip', () => {
    const { supabase, selects } = makeSupabase()
    buildEntityQuery(supabase as never, 'action', 'ws-1', 'user-1')
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(selects).toHaveLength(1)
  })

  it('is on ACTIONS ONLY', () => {
    // action_external_task has no relationship to these tables; a stray join
    // would be a PostgREST error, not an empty array.
    for (const entityType of ['capture', 'contact', 'project', 'document'] as ViewEntityType[]) {
      expect(selectFor(entityType)).not.toContain('action_external_task')
    }
  })

  it('leaves the rest of the action select intact', () => {
    // The join was inserted next to `labels`, which follows the same embedded
    // shape — a careless edit there would take a column with it.
    const select = selectFor('action')
    for (const column of ['id', 'identifier', 'title', 'status_id', 'workflow_state:', 'labels:']) {
      expect(select).toContain(column)
    }
  })
})

/**
 * REGRESSION (review finding: "Lazy-loaded subtask rows lack external_links —
 * icon claims Dial8-only for linked subtasks").
 *
 * Tree children in an ungrouped action list do NOT come from the view query
 * engine — they are fetched from GET /api/account/actions?parent_id=…, whose
 * own select never got the join. Child rows render through the identical
 * EntityRow → ActionPlatformCell path, where a missing `external_links` folds to
 * [] and the icon draws the AFFIRMATIVE Dial8 mark ("Dial8 action — send it to
 * a task app"). So a Jira-linked subtask sat directly under its correctly-marked
 * parent using the opposite convention for the same fact.
 *
 * The two selects have to carry the same join or they drift again, which is
 * what this pins.
 */
describe('ACTION_LIST_SELECT — external_links', () => {
  it('joins action_external_task, exactly as the view select does', () => {
    expect(ACTION_LIST_SELECT).toContain('external_links:action_external_task(provider)')
  })

  it('is thin for the same reason — a parent can have many children', () => {
    const join = ACTION_LIST_SELECT.match(/external_links:action_external_task\(([^)]*)\)/)
    expect(join).toBeTruthy()
    expect(join![1].split(',').map((c) => c.trim())).toEqual(['provider'])
  })
})
