// A small in-memory stand-in for the Supabase query builder, enough for the reads these tests make: select, eq
// (columns and `a->b->>c` JSON paths), in, like / ilike (% wildcards), or (`col.like.x*` terms), order, limit,
// range, maybeSingle, single. Writes are not supported: the code under test writes through mocked modules.
type Row = Record<string, unknown>

const valueAt = (row: Row, path: string): unknown => {
  const parts = path.split(/->>?/)
  let value: unknown = row
  for (const part of parts) value = value && typeof value === 'object' ? (value as Row)[part] : undefined
  return value
}
const likeToRegex = (pattern: string, flags = '') =>
  new RegExp(`^${pattern.replace(/\\([%_\\])/g, '$1').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')}$`, flags)

export function fakeSupabase(tables: Record<string, Row[]>) {
  const reads: { table: string; filters: string[] }[] = []
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const read = { table, filters: [] as string[] }
    reads.push(read)
    const builder = {
      select: () => builder,
      eq: (col: string, value: unknown) => { read.filters.push(`${col}=${value}`); rows = rows.filter((r) => valueAt(r, col) === value); return builder },
      in: (col: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(valueAt(r, col))); return builder },
      like: (col: string, pattern: string) => { rows = rows.filter((r) => likeToRegex(pattern).test(String(valueAt(r, col) ?? ''))); return builder },
      ilike: (col: string, pattern: string) => { rows = rows.filter((r) => likeToRegex(pattern, 'i').test(String(valueAt(r, col) ?? ''))); return builder },
      or: (terms: string) => {
        const tests = terms.split(',').map((term) => {
          const [col, , pattern] = term.split('.')
          return (r: Row) => likeToRegex(term.slice(col!.length + 6) || pattern!).test(String(valueAt(r, col!) ?? ''))
        })
        rows = rows.filter((r) => tests.some((t) => t(r)))
        return builder
      },
      order: (col: string, options: { ascending?: boolean } = {}) => {
        rows.sort((a, b) => String(valueAt(a, col)).localeCompare(String(valueAt(b, col))) * (options.ascending === false ? -1 : 1))
        return builder
      },
      limit: (n: number) => { rows = rows.slice(0, n); return builder },
      range: (from: number, to: number) => { rows = rows.slice(from, to + 1); return builder },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no row' } }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return builder
  }
  return { client: { from } as never, reads }
}
