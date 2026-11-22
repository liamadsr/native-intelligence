/**
 * A small stand-in for the Supabase client the canvas store reads and writes
 * through: filtered selects, insert/update/delete/upsert over in-memory rows,
 * maybeSingle, order, and canvas_editable_by answered by the test. RLS is the
 * test's own choice of rows and of `editable`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export interface FakeCanvasDb {
  client: SupabaseClient
  rows: Record<string, Row[]>
  calls: Array<{ table: string; op: string; payload?: unknown }>
}

export function fakeCanvasDb(seed: Record<string, Row[]>, opts: { editable?: boolean; error?: Record<string, { code?: string; message: string }> } = {}): FakeCanvasDb {
  const rows: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) rows[k] = v.map((r) => ({ ...r }))
  const calls: FakeCanvasDb['calls'] = []

  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let orderCol: string | null = null
    let orderAsc = true
    let mutation: { kind: 'insert' | 'update' | 'upsert'; payload: Row | Row[]; onConflict?: string } | { kind: 'delete' } | null = null

    const match = (r: Row) => filters.every((f) => f(r))
    const err = () => opts.error?.[table] ?? null

    const applyMutation = (): Row[] => {
      const list = (rows[table] ??= [])
      if (!mutation) return list.filter(match)
      if (mutation.kind === 'delete') {
        const removed = list.filter(match)
        rows[table] = list.filter((r) => !match(r))
        return removed
      }
      const payloads = Array.isArray(mutation.payload) ? mutation.payload : [mutation.payload]
      const out: Row[] = []
      for (const p of payloads) {
        if (mutation.kind === 'insert') {
          const row = { ...p }
          list.push(row)
          out.push(row)
        } else if (mutation.kind === 'upsert') {
          const key = mutation.onConflict?.split(',').map((c) => c.trim()) ?? ['id']
          const existing = list.find((r) => key.every((k) => r[k] === p[k]))
          if (existing) {
            Object.assign(existing, p)
            out.push(existing)
          } else {
            const row = { ...p }
            list.push(row)
            out.push(row)
          }
        } else {
          // update: merge into every matching row
          for (const r of list) if (match(r)) Object.assign(r, p)
          out.push(...list.filter(match))
        }
      }
      return out
    }

    const q = {
      select() {
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
      order(col: string, o?: { ascending?: boolean }) {
        orderCol = col
        orderAsc = o?.ascending !== false
        return q
      },
      insert(payload: Row | Row[]) {
        mutation = { kind: 'insert', payload }
        calls.push({ table, op: 'insert', payload })
        return q
      },
      update(payload: Row) {
        mutation = { kind: 'update', payload }
        calls.push({ table, op: 'update', payload })
        return q
      },
      upsert(payload: Row | Row[], o?: { onConflict?: string }) {
        mutation = { kind: 'upsert', payload, onConflict: o?.onConflict }
        calls.push({ table, op: 'upsert', payload })
        return q
      },
      delete() {
        mutation = { kind: 'delete' }
        calls.push({ table, op: 'delete' })
        return q
      },
      async maybeSingle() {
        const e = err()
        if (e) return { data: null, error: e }
        const res = applyMutation()
        return { data: res[0] ?? null, error: null }
      },
      then(resolve: (v: { data: Row[]; error: unknown }) => unknown) {
        const e = err()
        if (e) return Promise.resolve({ data: null, error: e }).then(resolve)
        let res = applyMutation()
        if (orderCol) {
          const col = orderCol
          res = [...res].sort((a, b) => (String(a[col]) < String(b[col]) ? (orderAsc ? -1 : 1) : String(a[col]) > String(b[col]) ? (orderAsc ? 1 : -1) : 0))
        }
        return Promise.resolve({ data: res, error: null }).then(resolve)
      },
    }
    return q
  }

  const client = {
    from,
    async rpc(name: string, _args: Record<string, unknown>) {
      if (name === 'canvas_editable_by') return { data: opts.editable !== false, error: null }
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient

  return { client, rows, calls }
}
