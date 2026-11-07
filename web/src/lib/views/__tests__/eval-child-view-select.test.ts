/**
 * EVAL_CASE_VIEW_SELECT and EVAL_RUN_VIEW_SELECT — what a case row and a run
 * row carry into the suite detail page's Cases and Runs tabs.
 *
 * A select is the quietest thing in the views system to get wrong. A missing
 * column does not throw and does not log: the cell renders blank, the filter
 * returns nothing, and the board collapses to one column. So both selects are
 * pinned from both directions — what must be there, and what must NOT be.
 *
 * THE OMISSIONS ARE THE POINT ON THESE TWO. Both tables carry fields that are
 * megabytes in aggregate — a case's script and frozen chunks, a run's whole
 * frozen system prompt — and neither is read by any row cell. Selecting them
 * would work perfectly and quietly ship a twenty-case suite's entire transcript
 * corpus on every page of the list.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery } from '@/lib/views/query-engine'
import type { ViewEntityType } from '@/lib/views/types'

let tables: string[] = []

/** A Supabase query builder that records the select string it was handed. */
function makeSupabase() {
  const selects: string[] = []
  const chain = {
    select: vi.fn((columns: string) => {
      selects.push(columns)
      return chain
    }),
    eq: vi.fn(() => chain),
    or: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  }
  return {
    supabase: {
      from: vi.fn((t: string) => {
        tables.push(t)
        return chain
      }),
    },
    selects,
  }
}

function columnsFor(entityType: ViewEntityType): string[] {
  tables = []
  const { supabase, selects } = makeSupabase()
  buildEntityQuery(supabase as never, entityType, 'ws-1', 'user-1')
  return selects[0].split(',').map((c) => c.trim())
}

describe('EVAL_CASE_VIEW_SELECT', () => {
  it('queries the eval_case table, scoped to the workspace', () => {
    tables = []
    const { supabase } = makeSupabase()
    const q = buildEntityQuery(supabase as never, 'eval_case', 'ws-1', 'user-1')
    expect(tables).toEqual(['eval_case'])
    expect(q.eq).toHaveBeenCalledWith('workspace_id', 'ws-1')
  })

  it('ships the two denormalized summary columns (migration 257)', () => {
    // Same job the suite's four do: a derived value can be DISPLAYED but never
    // grouped, filtered or sorted on, because PostgREST predicates run in the
    // database. These two are why the Cases tab can have an outcome board.
    const columns = columnsFor('eval_case')
    expect(columns).toContain('last_outcome')
    expect(columns).toContain('last_run_at')
  })

  it('ships the scope column and the default sort column', () => {
    const columns = columnsFor('eval_case')
    // `suite_id` is the fixed scope the suite page locks.
    expect(columns).toContain('suite_id')
    // `sort_order` is the Cases list's DEFAULT sort field (see defaultConfig
    // in use-view). Ordering on a column the response does not carry is the
    // kind of wrong that looks like "the sort does nothing".
    expect(columns).toContain('sort_order')
  })

  it('keeps every field the row and the filters read', () => {
    const columns = columnsFor('eval_case')
    for (const column of [
      'id', 'workspace_id', 'name',
      'polarity', 'modes', 'visibility',
      'created_by', 'created_at', 'updated_at',
    ]) {
      expect(columns).toContain(column)
    }
  })

  it('OMITS script, chunks and expected — megabytes nothing on a row reads', () => {
    // A case's script is a full synthetic meeting transcript and `chunks` its
    // frozen flush windows. The single-case GET returns them (that is what the
    // editor opens); a LIST must not, or a twenty-case suite ships its whole
    // transcript corpus to render a column of names.
    const columns = columnsFor('eval_case')
    for (const column of ['script', 'chunks', 'expected']) {
      expect(columns).not.toContain(column)
    }
  })

  it('embeds nothing — the summary is on the row, so there is no join to make', () => {
    expect(columnsFor('eval_case').join(',')).not.toContain('(')
  })
})

describe('EVAL_RUN_VIEW_SELECT', () => {
  it('queries the eval_run table, scoped to the workspace', () => {
    tables = []
    const { supabase } = makeSupabase()
    const q = buildEntityQuery(supabase as never, 'eval_run', 'ws-1', 'user-1')
    expect(tables).toEqual(['eval_run'])
    expect(q.eq).toHaveBeenCalledWith('workspace_id', 'ws-1')
  })

  it('ships the fields a run ROW renders', () => {
    const columns = columnsFor('eval_run')
    for (const column of [
      // Identity: a run has no name, so the row COMPOSES one from these two.
      'id', 'mode', 'started_at',
      // The scope, and the verdict the board groups on.
      'suite_id', 'outcome',
      // The tally line, and the two numbers beside it.
      'scores', 'cost_usd', 'duration_ms',
      // Liveness: `is_live` is the server's own generated column, and it is
      // what the status cell spins its orb on rather than guessing from
      // `status` alone.
      'status', 'is_live', 'progress',
      // The rest of the filterable + displayable set.
      'speed', 'driver', 'trials_per_case', 'target_prompt_hash',
      'target_model', 'baseline_run_id', 'ended_at', 'error_code',
      'estimated_cost_usd', 'tokens_in', 'tokens_out', 'workspace_id',
    ]) {
      expect(columns).toContain(column)
    }
  })

  it('OMITS the frozen prompt and the error sentence', () => {
    // `target_system_prompt` is the whole prompt under test — the single
    // largest thing on the row, read only by the run detail's compare view.
    // `error_message` is a sentence the detail shows; the row has `error_code`.
    const columns = columnsFor('eval_run')
    for (const column of [
      'target_system_prompt',
      'target_agent_config',
      'error_message',
      'max_cost_usd',
    ]) {
      expect(columns).not.toContain(column)
    }
  })

  it('does NOT select created_at, because eval_run has no such column', () => {
    // Pinned as an omission rather than left implicit: it is the same fact
    // that forces the entity's default ordering exception, and a select that
    // asked for it would 42703 the whole list.
    expect(columnsFor('eval_run')).not.toContain('created_at')
  })

  it('embeds nothing — a run row makes no join', () => {
    expect(columnsFor('eval_run').join(',')).not.toContain('(')
  })
})
