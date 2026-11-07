/**
 * Recording fake Supabase client for the evals lib tests.
 *
 * Same shape as `src/lib/prospecting/__tests__/fake-supabase.ts` — every
 * `from()` is captured with its op, payload and filters, and the test's handler
 * maps a captured query to its canned result. Zero network, zero DB.
 *
 * RECORDING rather than stubbing is what these tests need: almost everything
 * worth asserting about `createEvalCase` and `cloneTrialCapture` is in the
 * PAYLOAD they send. "The clone carries `is_eval` and no `contact_id`" is not
 * observable from a return value — only from what actually went over the wire.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface Captured {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}

export interface FakeResult {
  data?: unknown
  error?: { message: string; code?: string } | null
  count?: number | null
}

export function makeFakeSupabase(handler: (q: Captured) => FakeResult) {
  const queries: Captured[] = []

  function from(table: string) {
    const q: Captured = { table, op: 'select', filters: [] }
    queries.push(q)
    const b: Record<string, unknown> = {}
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        q.filters.push({ method: name, args })
        return b
      }
    const settle = async () => ({ error: null, data: null, count: null, ...handler(q) })
    Object.assign(b, {
      select: chain('select'),
      insert: (payload: unknown) => {
        q.op = 'insert'
        q.payload = payload
        return b
      },
      update: (payload: unknown) => {
        q.op = 'update'
        q.payload = payload
        return b
      },
      upsert: (payload: unknown, options?: unknown) => {
        q.op = 'upsert'
        q.payload = payload
        q.filters.push({ method: 'upsert', args: [options] })
        return b
      },
      delete: () => {
        q.op = 'delete'
        return b
      },
      eq: chain('eq'),
      neq: chain('neq'),
      in: chain('in'),
      is: chain('is'),
      or: chain('or'),
      filter: chain('filter'),
      gte: chain('gte'),
      lte: chain('lte'),
      limit: chain('limit'),
      order: chain('order'),
      range: chain('range'),
      maybeSingle: settle,
      single: settle,
      then: (onFulfilled: (v: FakeResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        settle().then(onFulfilled, onRejected),
    })
    return b
  }

  const client = { from } as unknown as SupabaseClient
  return { client, queries }
}

/** Every argument list a given filter method was called with, on one query. */
export function filterArgs(q: Captured, method: string): unknown[][] {
  return q.filters.filter((f) => f.method === method).map((f) => f.args)
}

/** True when the query carried `.eq('workspace_id', <id>)`. */
export function hasWorkspaceFilter(q: Captured, workspaceId: string): boolean {
  return filterArgs(q, 'eq').some(([col, val]) => col === 'workspace_id' && val === workspaceId)
}

/** The first captured query against `table` with the given op. */
export function findQuery(
  queries: Captured[],
  table: string,
  op: Captured['op'],
): Captured | undefined {
  return queries.find((q) => q.table === table && q.op === op)
}

/** Every captured query against `table` with the given op. */
export function findQueries(
  queries: Captured[],
  table: string,
  op: Captured['op'],
): Captured[] {
  return queries.filter((q) => q.table === table && q.op === op)
}
