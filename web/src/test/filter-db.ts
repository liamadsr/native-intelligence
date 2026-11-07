/**
 * A tiny in-memory Supabase stand-in that APPLIES the filters a query chains
 * (eq, neq, in, is, order, limit), so a test can seed one table with several
 * rows and see only the rows the code's query would see. select is accepted
 * and ignored.
 * `failTables` makes a table's query reject, and `errorTables` makes it
 * resolve { data: null, error } as Supabase does, to test the fail-closed
 * paths. order(key, { ascending }) sorts by a numeric column.
 *
 * For tests whose code reads the same table twice with different filters
 * (the shared createSupabaseMock answers every query on a table the same).
 */
type Row = Record<string, unknown>

export function filterDb(tables: Record<string, Row[]>, failTables: readonly string[] = [], errorTables: readonly string[] = []) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let max = Infinity
    let sort: { key: string; ascending: boolean } | null = null
    const run = async () => {
      if (failTables.includes(table)) throw new Error(`${table} down`)
      if (errorTables.includes(table)) return { data: null, error: { message: `${table} down` } }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (sort) {
        const { key, ascending } = sort
        rows = [...rows].sort((a, b) => ((a[key] as number) - (b[key] as number)) * (ascending ? 1 : -1))
      }
      return { data: rows.slice(0, max), error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: (key: string, opts?: { ascending?: boolean }) => ((sort = { key, ascending: opts?.ascending !== false }), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      limit: (n: number) => ((max = n), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  return { from } as never
}
