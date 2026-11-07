/**
 * An in-memory Supabase stand-in for the coding tests: it APPLIES the filters
 * a query chains (eq, neq, in, is, not in, gte, contains on arrays) to reads,
 * updates and deletes, and records every write, so a test can seed rows, run
 * the code and read the tables back. select() is accepted and ignored. Joined
 * selects are not resolved: seed the joined object on the row itself.
 * `rpc` answers through the handlers a test passes.
 */
type Row = Record<string, unknown>

export interface FakeDb {
  tables: Record<string, Row[]>
  writes: Array<{ table: string; op: 'insert' | 'update' | 'delete'; value: unknown }>
  client: never
}

/** Postgres jsonb @> : every element / key of `want` is in `have`, recursively. */
function jsonContains(have: unknown, want: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => jsonContains(h, w)))
  if (want && typeof want === 'object') {
    if (!have || typeof have !== 'object' || Array.isArray(have)) return false
    return Object.entries(want as Record<string, unknown>).every(([key, w]) => jsonContains((have as Record<string, unknown>)[key], w))
  }
  return have === want
}

function parseInList(list: string): string[] {
  return list.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim())
}

export function fakeDb(
  tables: Record<string, Row[]>,
  rpc: Record<string, (args: Record<string, unknown>) => unknown> = {},
): FakeDb {
  const writes: FakeDb['writes'] = []
  let seq = 0
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let max = Infinity
    let op: { kind: 'select' } | { kind: 'update'; patch: Row } | { kind: 'insert'; rows: Row[] } | { kind: 'delete' } = { kind: 'select' }
    let countHead = false
    const rows = () => (tables[table] ??= [])
    const run = async (): Promise<{ data: unknown; error: null; count?: number }> => {
      if (op.kind === 'insert') {
        const inserted = op.rows.map((r) => ({ id: r.id ?? `${table}-${++seq}`, created_at: new Date().toISOString(), ...r }))
        rows().push(...inserted)
        writes.push({ table, op: 'insert', value: inserted })
        return { data: inserted, error: null }
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op.kind === 'update') {
        for (const r of hit) Object.assign(r, op.patch)
        writes.push({ table, op: 'update', value: { patch: op.patch, ids: hit.map((r) => r.id) } })
        return { data: hit, error: null }
      }
      if (op.kind === 'delete') {
        tables[table] = rows().filter((r) => !hit.includes(r))
        writes.push({ table, op: 'delete', value: hit.map((r) => r.id) })
        return { data: hit, error: null }
      }
      if (countHead) return { data: null, error: null, count: hit.length }
      return { data: hit.slice(0, max), error: null }
    }
    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) countHead = true
        return chain
      },
      insert: (value: Row | Row[]) => ((op = { kind: 'insert', rows: Array.isArray(value) ? value : [value] }), chain),
      upsert: (value: Row | Row[]) => ((op = { kind: 'insert', rows: Array.isArray(value) ? value : [value] }), chain),
      update: (patch: Row) => ((op = { kind: 'update', patch }), chain),
      delete: () => ((op = { kind: 'delete' }), chain),
      order: () => chain,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      gte: (k: string, v: string) => (filters.push((r) => String(r[k] ?? '') >= v), chain),
      not: (k: string, operator: string, v: string) => {
        if (operator === 'in') filters.push((r) => !parseInList(v).includes(String(r[k])))
        else if (operator === 'is') filters.push((r) => (r[k] ?? null) !== null)
        return chain
      },
      contains: (k: string, v: unknown) => {
        const want = typeof v === 'string' ? JSON.parse(v) : v
        filters.push((r) => jsonContains(r[k], want))
        return chain
      },
      limit: (n: number) => ((max = n), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
      },
      single: async () => {
        const { data, error } = await run()
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  const client = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      const handler = rpc[name]
      if (!handler) return { data: null, error: { message: `no rpc ${name}` } }
      return { data: handler(args), error: null }
    },
  }
  return { tables, writes, client: client as never }
}
