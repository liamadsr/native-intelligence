/**
 * An in-memory Supabase stand-in for the custom field writes: tables of rows,
 * the filters the code chains (eq, in, order), maybeSingle / single, insert,
 * and update(...).eq(...).select(), where `canWrite` plays RLS (a row the
 * caller may not change is simply not updated, as Postgres answers a write
 * its UPDATE policy refuses). rpc answers from `rpcs`.
 */
type Row = Record<string, unknown>

export interface FakeRecordsDb {
  from: (table: string) => unknown
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  tables: Record<string, Row[]>
  writes: Array<{ table: string; id: unknown; patch: Row }>
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
}

export function fakeRecordsDb(
  tables: Record<string, Row[]>,
  opts: {
    canWrite?: (table: string, row: Row) => boolean
    rpcs?: Record<string, (args: Record<string, unknown>) => unknown>
  } = {},
): FakeRecordsDb {
  const writes: FakeRecordsDb['writes'] = []
  const rpcCalls: FakeRecordsDb['rpcCalls'] = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    let inserted: Row | null = null
    const matching = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
    const run = async () => {
      if (inserted) {
        const row = { id: `new-${(tables[table]?.length ?? 0) + 1}`, ...inserted }
        ;(tables[table] ??= []).push(row)
        return { data: [row], error: null }
      }
      if (patch) {
        const changed: Row[] = []
        for (const r of matching()) {
          if (opts.canWrite && !opts.canWrite(table, r)) continue
          Object.assign(r, patch)
          writes.push({ table, id: r.id, patch })
          changed.push({ id: r.id })
        }
        return { data: changed, error: null }
      }
      return { data: matching(), error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      update: (p: Row) => ((patch = p), chain),
      insert: (row: Row) => ((inserted = row), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data[0] ?? null, error }
      },
      single: async () => {
        const { data, error } = await run()
        return { data: data[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    const answer = opts.rpcs?.[fn]
    if (!answer) return { data: null, error: { message: `no rpc ${fn}` } }
    return { data: answer(args), error: null }
  }
  return { from, rpc, tables, writes, rpcCalls }
}
