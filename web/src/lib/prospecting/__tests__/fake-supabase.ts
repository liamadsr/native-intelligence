/**
 * Recording fake Supabase client for the prospecting lib tests.
 *
 * Same shape as `src/lib/sequences/__tests__/mutations.test.ts`'s fake — every
 * `from()` is captured with its op, payload and filters, and the test's handler
 * maps a captured query to its canned result. Zero network, zero DB.
 *
 * The point of RECORDING rather than stubbing is that these tests assert on the
 * filters as much as the results: every prospecting query must carry an
 * explicit `workspace_id`, and the only way to prove that is to look at what
 * was actually sent.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface Captured {
  /** The table — or `rpc:<function>` for a `client.rpc()` call. */
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc'
  /** The insert/update payload, or the rpc's argument object. */
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}

export interface FakeResult {
  data?: unknown
  error?: { message: string; code?: string } | null
  count?: number | null
}

export function makeFakeSupabase(
  handler: (q: Captured) => FakeResult,
  opts: {
    user?: { id: string; email?: string } | null
    /**
     * `auth.admin.getUserById` results, keyed by user id. Present because
     * `member` has NO email column (migration 013) — emails live on
     * `auth.users`, so the engine resolves them through the admin API. A key
     * mapped to `null` models a lookup that failed for that one member.
     */
    authUsers?: Record<string, { email?: string | null } | null>
    /** Every `getUserById` id the code under test asked for, in order. */
    adminLookups?: string[]
  } = {},
) {
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
    // Every builder is a thenable, so an UPDATE that ends at `.eq(...)` with
    // no `.select()` — which is what a progress write looks like — is
    // awaitable exactly as PostgREST's is. `select` after `insert`/`update`
    // still works because `select` returns the same builder.
    Object.assign(b, {
      select: (...args: unknown[]) => {
        q.filters.push({ method: 'select', args })
        return b
      },
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
      delete: () => {
        q.op = 'delete'
        return b
      },
      eq: chain('eq'),
      // `neq` is the "every OTHER row" half of the workspace-company flag
      // re-point in source-company.ts. Recorded so a test can prove the clear
      // excluded the row about to be flagged — 248's partial unique index
      // makes a clear that also cleared the target silently wrong.
      neq: chain('neq'),
      // `gte` is the monthly-spend window filter in run.ts (`created_at >=
      // month start`). Recorded like every other filter so a test can assert
      // the run actually scoped its ceiling read to the calendar month.
      gte: chain('gte'),
      is: chain('is'),
      // `or` is the secondary-email OR-filter promotion's pre-create probe
      // uses, mirroring findOrCreateContact's own lookup. Recorded like every
      // other filter so a test can assert the tombstone exclusion travelled
      // with it.
      or: chain('or'),
      // `ilike` is the LinkedIn slug fallback in promote.ts: the column holds
      // both the normalized bare form and the raw `https://www.linkedin.com/...`
      // one, so dedup probes for both. Recorded so a test can assert the
      // pattern is slug-ANCHORED rather than an open `%slug%`.
      ilike: chain('ilike'),
      in: chain('in'),
      // `contains` is the array-containment probe deleteList uses to find the
      // CRM rows in a list's group (`prospect_list_ids @> ARRAY[list]`).
      contains: chain('contains'),
      not: chain('not'),
      lt: chain('lt'),
      lte: chain('lte'),
      gt: chain('gt'),
      limit: chain('limit'),
      order: chain('order'),
      // `range` both records the window AND settles, so a paginated read
      // (`readAll` in exclusions.ts) is awaitable at the end of the chain.
      // The handler decides what a page contains; a handler that ignores the
      // range returns the same rows every time, so tests that exercise paging
      // must slice on `filterArgs(q, 'range')` themselves.
      range: (...args: unknown[]) => {
        q.filters.push({ method: 'range', args })
        return b
      },
      maybeSingle: settle,
      single: settle,
      then: (onFulfilled: (v: FakeResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        settle().then(onFulfilled, onRejected),
    })
    return b
  }

  /** `client.rpc(fn, args)` — recorded as table `rpc:<fn>` with the argument
   *  object as `payload`, answered by the same handler. Publish/unpublish
   *  mark the CRM rows through two SQL functions (migration 259). */
  function rpc(fn: string, args: unknown) {
    const q: Captured = { table: `rpc:${fn}`, op: 'rpc', payload: args, filters: [] }
    queries.push(q)
    const settle = async () => ({ error: null, data: null, count: null, ...handler(q) })
    return {
      then: (onFulfilled: (v: FakeResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        settle().then(onFulfilled, onRejected),
    }
  }

  const client = {
    from,
    rpc,
    auth: {
      getUser: async () => ({ data: { user: opts.user ?? null }, error: null }),
      // The service-role surface. Only present when a test supplies
      // `authUsers`, so a test that does not opt in still exercises the
      // engine's "no admin API → no member emails" degradation.
      ...(opts.authUsers
        ? {
            admin: {
              getUserById: async (id: string) => {
                opts.adminLookups?.push(id)
                const found = opts.authUsers?.[id]
                if (!found) return { data: { user: null }, error: { message: 'not found' } }
                return { data: { user: found }, error: null }
              },
            },
          }
        : {}),
    },
  } as unknown as SupabaseClient

  return { client, queries }
}

/** Every argument list a given filter method was called with, on one query. */
export function filterArgs(q: Captured, method: string): unknown[][] {
  return q.filters.filter((f) => f.method === method).map((f) => f.args)
}

/** True when the query carried `.eq('workspace_id', <id>)`. Asserted on every
 *  read and write — RLS is never the only boundary in this lib. */
export function hasWorkspaceFilter(q: Captured, workspaceId: string): boolean {
  return filterArgs(q, 'eq').some(([col, val]) => col === 'workspace_id' && val === workspaceId)
}
