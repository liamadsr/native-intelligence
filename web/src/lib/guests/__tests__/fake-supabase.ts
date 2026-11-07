/**
 * A small chainable stand-in for the service client in the guest tests: every
 * query records its table, operation and filters, and resolves to what the
 * test's handler answers for it.
 */
export interface FakeQuery {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  values?: unknown
  columns?: string
  head?: boolean
  filters: Array<[string, string, unknown]>
}

export type FakeAnswer = { data?: unknown; error?: { message: string; code?: string } | null; count?: number }

export function fakeSupabase(answer: (q: FakeQuery) => FakeAnswer | undefined) {
  const queries: FakeQuery[] = []
  const from = (table: string) => {
    const q: FakeQuery = { table, op: 'select', filters: [] }
    const result = () => {
      const a = answer(q) ?? {}
      return { data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }
    }
    const chain: Record<string, unknown> = {}
    const filter = (kind: string) => (col: string, val?: unknown) => {
      q.filters.push([kind, col, val])
      return chain
    }
    Object.assign(chain, {
      select: (columns?: string, opts?: { head?: boolean; count?: string }) => {
        if (q.op === 'select') q.columns = columns
        if (opts?.head) q.head = true
        return chain
      },
      insert: (values: unknown) => {
        q.op = 'insert'
        q.values = values
        queries.push(q)
        return chain
      },
      upsert: (values: unknown) => {
        q.op = 'upsert'
        q.values = values
        queries.push(q)
        return chain
      },
      update: (values: unknown) => {
        q.op = 'update'
        q.values = values
        queries.push(q)
        return chain
      },
      delete: () => {
        q.op = 'delete'
        queries.push(q)
        return chain
      },
      eq: filter('eq'),
      neq: filter('neq'),
      in: filter('in'),
      is: filter('is'),
      gte: filter('gte'),
      gt: filter('gt'),
      not: filter('not'),
      contains: filter('contains'),
      like: filter('like'),
      or: filter('or'),
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    })
    // A plain select is recorded when it resolves.
    const origThen = chain.then as (...a: unknown[]) => unknown
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (q.op === 'select' && !queries.includes(q)) queries.push(q)
      return origThen(resolve, reject)
    }
    const origMaybe = chain.maybeSingle as () => Promise<unknown>
    chain.maybeSingle = () => {
      if (q.op === 'select' && !queries.includes(q)) queries.push(q)
      return origMaybe()
    }
    return chain
  }
  return { supabase: { from } as never, queries }
}

/** The value of filter `col` (kind eq unless given) on a query. */
export function filterOf(q: FakeQuery, col: string, kind = 'eq'): unknown {
  return q.filters.find(([k, c]) => k === kind && c === col)?.[2]
}
