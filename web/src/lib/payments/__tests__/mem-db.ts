/**
 * A small in-memory Supabase stand-in for the payments tests: tables of rows
 * that select / insert / update / upsert really change, with the filters the
 * payments code chains (eq, neq, is, gt, gte, in, order, limit) applied, and
 * unique keys that answer a duplicate insert with Postgres' 23505.
 */
type Row = Record<string, unknown>

export interface MemDb {
  tables: Record<string, Row[]>
  client: never
  rpcCalls: Array<{ fn: string; args: unknown }>
}

let seq = 0
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

export function memDb(
  seed: Record<string, Row[]> = {},
  unique: Record<string, string[][]> = {},
  opts: { users?: Record<string, { email: string }>; missingTables?: string[] } = {},
): MemDb {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]))
  const rpcCalls: MemDb['rpcCalls'] = []

  function violates(table: string, row: Row, except?: Row): boolean {
    for (const keys of unique[table] ?? []) {
      if (keys.some((k) => row[k] === undefined || row[k] === null)) continue
      if ((tables[table] ?? []).some((other) => other !== except && keys.every((k) => other[k] === row[k]))) return true
    }
    return false
  }

  function from(table: string) {
    tables[table] ??= []
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let payload: Row | Row[] | null = null
    let conflict: string[] = []
    let returning = false
    let max = Infinity
    let sort: { key: string; ascending: boolean } | null = null

    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> => {
      // A table that isn't there (an unmerged migration): PostgREST's PGRST205.
      if (opts.missingTables?.includes(table)) return { data: null, error: { message: `Could not find the table 'public.${table}'`, code: 'PGRST205' } }
      const rows = tables[table]
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload as Row]).map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }))
        for (const r of list) if (violates(table, r)) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        rows.push(...list)
        return { data: returning ? list : null, error: null }
      }
      if (op === 'upsert') {
        const r = payload as Row
        const found = rows.find((o) => conflict.every((k) => o[k] === r[k]))
        if (found) {
          const next = { ...found, ...r }
          if (violates(table, next, found)) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
          Object.assign(found, r)
          return { data: returning ? [found] : null, error: null }
        }
        const fresh = { id: newId(), ...r }
        if (violates(table, fresh)) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        rows.push(fresh)
        return { data: returning ? [fresh] : null, error: null }
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of matched) Object.assign(r, payload)
        return { data: returning ? matched : null, error: null }
      }
      if (sort) {
        const { key, ascending } = sort
        matched = [...matched].sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0) * (ascending ? 1 : -1))
      }
      return { data: matched.slice(0, max), error: null }
    }

    const chain: Record<string, unknown> = {
      select: () => {
        if (op !== 'select') returning = true
        return chain
      },
      insert: (r: Row | Row[]) => ((op = 'insert'), (payload = r), chain),
      update: (r: Row) => ((op = 'update'), (payload = r), chain),
      upsert: (r: Row, o?: { onConflict?: string }) => ((op = 'upsert'), (payload = r), (conflict = (o?.onConflict ?? 'id').split(',')), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      gt: (k: string, v: string) => (filters.push((r) => String(r[k]) > v), chain),
      gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      order: (key: string, o?: { ascending?: boolean }) => ((sort = { key, ascending: o?.ascending !== false }), chain),
      limit: (n: number) => ((max = n), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      single: async () => {
        const { data, error } = await run()
        if (error) return { data: null, error }
        return data?.[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }

  const client = {
    from,
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      return { data: null, error: null }
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: opts.users?.[id] ? { id, email: opts.users[id].email } : null }, error: null }),
      },
    },
  }
  return { tables, client: client as never, rpcCalls }
}
