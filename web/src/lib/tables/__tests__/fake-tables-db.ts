/**
 * A small stand-in for the Supabase client the tables store reads and writes
 * through: filtered selects over in-memory rows (eq, in, is, not is, order,
 * range, limit, maybeSingle, a `name:column::text` alias), and RPCs answered
 * by the test. RLS is the test's own choice of rows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>
export type RpcAnswer = { data: unknown; error: { code?: string; message: string; details?: string | null } | null }

export interface FakeTablesDb {
  client: SupabaseClient
  rows: Record<string, Row[]>
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
}

export function fakeTablesDb(rows: Record<string, Row[]>, rpc: (name: string, args: Record<string, unknown>) => RpcAnswer): FakeTablesDb {
  const rpcCalls: FakeTablesDb['rpcCalls'] = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let columns: string[] = []
    let orderBy: string | null = null
    let from_ = 0
    let to: number | null = null
    const q = {
      select(cols: string) {
        columns = cols.split(',').map((c) => c.trim())
        return q
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v)
        return q
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]))
        return q
      },
      is(col: string, v: null) {
        filters.push((r) => (r[col] ?? null) === v)
        return q
      },
      not(col: string, op: string, v: null) {
        if (op === 'is') filters.push((r) => (r[col] ?? null) !== v)
        return q
      },
      order(col: string) {
        orderBy ??= col
        return q
      },
      range(a: number, b: number) {
        from_ = a
        to = b
        return q
      },
      limit(n: number) {
        to = n - 1
        return q
      },
      async maybeSingle() {
        const res = run()
        return { data: res[0] ?? null, error: null }
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve({ data: run(), error: null }).then(resolve)
      },
    }
    const pick = (r: Row): Row => {
      if (columns.length === 0 || columns[0] === '*') return { ...r }
      const out: Row = {}
      for (const c of columns) {
        const alias = /^(\w+):(\w+)::text$/.exec(c)
        if (alias) out[alias[1]] = r[alias[2]] === undefined ? undefined : String(r[alias[2]])
        else out[c] = r[c]
      }
      return out
    }
    const run = () => {
      let list = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (orderBy) list = [...list].sort((a, b) => Number(a[orderBy!] ?? 0) - Number(b[orderBy!] ?? 0))
      list = list.slice(from_, to === null ? undefined : to + 1)
      return list.map(pick)
    }
    return q
  }
  const client = {
    from,
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return rpc(name, args)
    },
  } as unknown as SupabaseClient
  return { client, rows, rpcCalls }
}
