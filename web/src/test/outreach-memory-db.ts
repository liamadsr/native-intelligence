/**
 * An in-memory Supabase stand-in that APPLIES what a query chains, for tests
 * of code that reads and writes several tables and must see its own writes
 * (outreach launches: enroll, then read back, then arm; review requests).
 * The customer front door's tests use their own, ./memory-db.ts.
 *
 *   reads    select (columns ignored: whole rows come back, embedded objects
 *            and all), eq, neq, is, not(col, 'is', null), in, lt, gt, gte,
 *            ilike (case-insensitive equality, no wildcards), overlaps,
 *            or('a.lt.x,a.is.null'), order(col, { ascending, nullsFirst }),
 *            limit, range, maybeSingle, single.
 *   writes   insert (one row or many; an `id` is generated; `unique` keys
 *            raise 23505 as Postgres would), update (on the filtered rows),
 *            delete. `.select()` after a write returns the written rows;
 *            `defaults` fills a table's column DEFAULTs on insert.
 *   rpc      contact_visible_to answers true unless the id is in `hidden`;
 *            anything else answers null.
 *
 * Every write is recorded in `writes`, in order, for assertions.
 */
type Row = Record<string, unknown>

export interface MemoryDbOptions {
  /** Unique keys per table: an insert repeating one raises 23505. */
  unique?: Record<string, string[][]>
  /** Contact ids contact_visible_to answers false for. */
  hidden?: string[]
  /** Tables whose reads resolve { data: null, error }. */
  errorTables?: string[]
  /** Column defaults an insert fills in, per table (as the schema's DEFAULTs would). */
  defaults?: Record<string, Row>
}

export interface MemoryWrite {
  table: string
  op: 'insert' | 'update' | 'delete'
  values?: Row | Row[]
  rows: Row[]
}

function getPath(row: Row, path: string): unknown {
  if (!path.includes('->')) return row[path]
  // context->outreach->>id style json paths.
  const parts = path.split(/->>?/)
  let v: unknown = row[parts[0]]
  for (const p of parts.slice(1)) v = v && typeof v === 'object' ? (v as Row)[p] : undefined
  return v
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  return String(a) < String(b) ? -1 : 1
}

export function memoryDb(tables: Record<string, Row[]>, options: MemoryDbOptions = {}) {
  const writes: MemoryWrite[] = []
  let nextId = 1

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let values: Row | Row[] | undefined
    let max = Infinity
    let offset = 0
    let sort: { key: string; ascending: boolean; nullsFirst: boolean } | null = null
    let returning = false

    const rows = () => (tables[table] ??= [])
    const matched = () => rows().filter((r) => filters.every((f) => f(r)))

    async function run(): Promise<{ data: unknown; error: { message: string; code?: string } | null }> {
      if (options.errorTables?.includes(table)) return { data: null, error: { message: `${table} down` } }
      if (op === 'insert') {
        const list = Array.isArray(values) ? values : [values as Row]
        const inserted: Row[] = []
        for (const v of list) {
          const row: Row = { id: `${table}-${nextId++}`, ...(options.defaults?.[table] ?? {}), ...v }
          for (const key of options.unique?.[table] ?? []) {
            if (rows().some((r) => key.every((k) => r[k] === row[k]))) {
              return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
            }
          }
          rows().push(row)
          inserted.push(row)
        }
        writes.push({ table, op, values, rows: inserted })
        return { data: returning ? (Array.isArray(values) ? inserted : inserted) : null, error: null }
      }
      if (op === 'update') {
        const hit = matched()
        for (const r of hit) Object.assign(r, values as Row)
        writes.push({ table, op, values, rows: hit })
        return { data: returning ? hit : null, error: null }
      }
      if (op === 'delete') {
        const hit = matched()
        tables[table] = rows().filter((r) => !hit.includes(r))
        writes.push({ table, op, rows: hit })
        return { data: returning ? hit : null, error: null }
      }
      let out = matched()
      if (sort) {
        const { key, ascending, nullsFirst } = sort
        out = [...out].sort((a, b) => {
          const av = a[key]
          const bv = b[key]
          if ((av ?? null) === null || (bv ?? null) === null) {
            if ((av ?? null) === (bv ?? null)) return 0
            return ((av ?? null) === null) === nullsFirst ? -1 : 1
          }
          return compare(av, bv) * (ascending ? 1 : -1)
        })
      }
      return { data: out.slice(offset, offset + (max === Infinity ? out.length : max)), error: null }
    }

    const chain: Record<string, unknown> = {
      select: () => {
        if (op !== 'select') returning = true
        return chain
      },
      insert: (v: Row | Row[]) => ((op = 'insert'), (values = v), chain),
      update: (v: Row) => ((op = 'update'), (values = v), chain),
      delete: () => ((op = 'delete'), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => getPath(r, k) === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => getPath(r, k) !== v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (getPath(r, k) ?? null) === v), chain),
      not: (k: string, operator: string, v: unknown) => {
        if (operator === 'is' && v === null) filters.push((r) => (getPath(r, k) ?? null) !== null)
        return chain
      },
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(getPath(r, k))), chain),
      lt: (k: string, v: unknown) => (filters.push((r) => getPath(r, k) !== null && getPath(r, k) !== undefined && compare(getPath(r, k), v) < 0), chain),
      gt: (k: string, v: unknown) => (filters.push((r) => getPath(r, k) !== null && getPath(r, k) !== undefined && compare(getPath(r, k), v) > 0), chain),
      gte: (k: string, v: unknown) => (filters.push((r) => getPath(r, k) !== null && getPath(r, k) !== undefined && compare(getPath(r, k), v) >= 0), chain),
      ilike: (k: string, v: string) => (filters.push((r) => String(getPath(r, k) ?? '').toLowerCase() === v.replace(/\\(.)/g, '$1').toLowerCase()), chain),
      overlaps: (k: string, vs: unknown[]) => (filters.push((r) => Array.isArray(r[k]) && (r[k] as unknown[]).some((x) => vs.includes(x))), chain),
      or: (expr: string) => {
        const clauses = expr.split(',').map((c) => {
          const [col, oper, ...rest] = c.split('.')
          const val = rest.join('.').replace(/^"(.*)"$/, '$1')
          if (oper === 'is' && val === 'null') return (r: Row) => (r[col] ?? null) === null
          if (oper === 'lt') return (r: Row) => r[col] !== null && r[col] !== undefined && compare(r[col], val) < 0
          if (oper === 'eq') return (r: Row) => String(r[col]) === val
          return () => false
        })
        filters.push((r) => clauses.some((c) => c(r)))
        return chain
      },
      order: (key: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => (
        (sort = { key, ascending: opts?.ascending !== false, nullsFirst: opts?.nullsFirst === true }), chain
      ),
      limit: (n: number) => ((max = n), chain),
      range: (a: number, b: number) => ((offset = a), (max = b - a + 1), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
      },
      single: async () => {
        returning = true
        const { data, error } = await run()
        if (error) return { data: null, error }
        const row = Array.isArray(data) ? data[0] : data
        return row ? { data: row, error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'contact_visible_to') return { data: !(options.hidden ?? []).includes(args.p_contact_id as string), error: null }
    return { data: null, error: null }
  }

  return { client: { from, rpc } as never, tables, writes }
}
