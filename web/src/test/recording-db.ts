/**
 * A Supabase double that answers every query on a table with the rows seeded
 * for it, and records each builder call per table, so a test can assert what
 * the code asked for (the order, the filters, the embed). Filters are not
 * applied. Wrap it in `withTableSchema` (table-schema.ts) so a name the
 * database doesn't have fails as it does in PostgREST.
 */
type Row = Record<string, unknown>
export type Call = [method: string, ...args: unknown[]]

export function recordingDb(tables: Record<string, Row[]>) {
  const calls: Record<string, Call[]> = {}
  const from = (table: string): unknown => {
    const log = (calls[table] ??= [])
    const rows = tables[table] ?? []
    let chain: unknown
    const terminals: Record<string, unknown> = {
      single: async () => ({ data: rows[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    chain = new Proxy(terminals, {
      get: (target, prop) =>
        typeof prop === 'symbol' || prop in target
          ? Reflect.get(target, prop)
          : (...args: unknown[]) => {
              log.push([prop, ...args])
              return chain
            },
    })
    return chain
  }
  return { client: { from }, calls }
}
