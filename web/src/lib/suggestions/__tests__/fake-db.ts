/**
 * A small programmable Supabase fake for the suggestions tests. Every query is
 * handed to `handler` with its table, operation, filters and payload; the
 * handler returns `{ data, error?, count? }`. Calls are recorded in `calls`.
 */
export interface FakeQuery {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  filters: Array<[string, string, unknown]>
  payload?: unknown
  head?: boolean
}

export type FakeHandler = (q: FakeQuery) => { data?: unknown; error?: { message: string } | null; count?: number }

export function fakeDb(handler: FakeHandler) {
  const calls: FakeQuery[] = []
  const client = {
    from(table: string) {
      const q: FakeQuery = { table, op: 'select', filters: [] }
      const run = () => {
        calls.push(q)
        const r = handler(q) ?? {}
        return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }
      }
      const chain: Record<string, unknown> = {}
      const filter = (kind: string) => (col: string, val?: unknown) => {
        q.filters.push([kind, col, val])
        return chain
      }
      for (const k of ['eq', 'neq', 'in', 'is', 'gte', 'lte', 'lt', 'gt', 'ilike', 'not']) chain[k] = filter(k)
      chain.select = (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) q.head = true
        return chain
      }
      chain.insert = (payload: unknown) => {
        q.op = 'insert'
        q.payload = payload
        return chain
      }
      chain.update = (payload: unknown) => {
        q.op = 'update'
        q.payload = payload
        return chain
      }
      chain.delete = () => {
        q.op = 'delete'
        return chain
      }
      chain.order = () => chain
      chain.limit = () => chain
      chain.single = async () => run()
      chain.maybeSingle = async () => run()
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject)
      return chain
    },
  }
  return { client: client as never, calls }
}

export const has = (q: FakeQuery, col: string, val?: unknown) =>
  q.filters.some(([, c, v]) => c === col && (val === undefined || v === val))
