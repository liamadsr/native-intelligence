/**
 * An in-memory Supabase stand-in that applies the filters a query chains and
 * writes what it inserts and updates, for code that reads back what it
 * wrote (the customer front door's store, src/lib/customers/). Supports:
 *
 *   select (columns ignored; `{ count: 'exact', head: true }` answers a count),
 *   insert (one row or many; id and created_at filled), update, delete,
 *   upsert (one row or many, `{ onConflict: 'a,b' }`: a row matching on those
 *   columns is updated, else inserted; `ignoreDuplicates: true` leaves a
 *   matching row as it is),
 *   eq, neq, in, is, gt, gte, lt, lte, not(col, 'is', null), contains,
 *   ilike ('%suffix' / 'prefix%' / '%mid%'), or('a.eq.x,b.cs.{"y"},c.is.null'),
 *   order (strings or numbers), limit, range (fetchAllRows' pages), single,
 *   maybeSingle.
 *
 * `unique[table](a, b)` true makes an insert or update that would collide
 * answer 23505, as a unique index does. Rows are the `tables` object's own,
 * so a test seeds and inspects them directly.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

function orFilter(expr: string): Filter {
  const parts = expr.split(',').map((p) => p.trim()).filter(Boolean)
  const tests = parts.map((part): Filter => {
    const m = /^([a-z_]+)\.(eq|cs|neq|is)\.(.*)$/.exec(part)
    if (!m) throw new Error(`memory-db: or ${part}`)
    const [, col, op, raw] = m
    if (op === 'is') {
      if (raw !== 'null') throw new Error(`memory-db: or ${part}`)
      return (r) => r[col] === null || r[col] === undefined
    }
    if (op === 'cs') {
      const inner = raw.replace(/^\{|\}$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''))
      return (r) => Array.isArray(r[col]) && inner.every((v) => (r[col] as unknown[]).includes(v))
    }
    return op === 'eq' ? (r) => String(r[col] ?? '') === raw : (r) => String(r[col] ?? '') !== raw
  })
  return (r) => tests.some((t) => t(r))
}

function likeFilter(col: string, pattern: string): Filter {
  const p = pattern.toLowerCase()
  return (r) => {
    const v = typeof r[col] === 'string' ? (r[col] as string).toLowerCase() : null
    if (v === null) return false
    if (p.startsWith('%') && p.endsWith('%')) return v.includes(p.slice(1, -1))
    if (p.startsWith('%')) return v.endsWith(p.slice(1))
    if (p.endsWith('%')) return v.startsWith(p.slice(0, -1))
    return v === p
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''))
}

export function memoryDb(tables: Record<string, Row[]>, unique: Record<string, (a: Row, b: Row) => boolean> = {}): SupabaseClient {
  const from = (table: string) => {
    const filters: Filter[] = []
    let op: { kind: 'select' } | { kind: 'insert'; rows: Row[] } | { kind: 'upsert'; rows: Row[]; on: string[]; ignore: boolean } | { kind: 'update'; patch: Row } | { kind: 'delete' } = { kind: 'select' }
    let head = false
    let max = Infinity
    let offset = 0
    let sort: { key: string; ascending: boolean } | null = null
    const rows = () => (tables[table] ??= [])
    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null; count?: number }> => {
      if (op.kind === 'insert') {
        const made: Row[] = []
        for (const input of op.rows) {
          const row = { id: randomUUID(), created_at: new Date().toISOString(), ...input }
          if ([...rows(), ...made].some((r) => unique[table]?.(r, row))) return { data: null, error: { message: 'duplicate key', code: '23505' } }
          made.push(row)
        }
        rows().push(...made)
        return { data: made, error: null }
      }
      if (op.kind === 'upsert') {
        const done: Row[] = []
        for (const input of op.rows) {
          const on = op.on
          const existing = on.length ? rows().find((r) => on.every((k) => r[k] === input[k])) : undefined
          if (existing && op.ignore) {
            continue
          }
          const next = existing ? { ...existing, ...input } : { id: randomUUID(), created_at: new Date().toISOString(), ...input }
          if (rows().some((r) => r !== existing && unique[table]?.(r, next))) return { data: null, error: { message: 'duplicate key', code: '23505' } }
          if (existing) Object.assign(existing, input)
          else rows().push(next)
          done.push(existing ?? next)
        }
        return { data: done, error: null }
      }
      let hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op.kind === 'update') {
        const patch = op.patch
        for (const r of hit) {
          const next = { ...r, ...patch }
          if (rows().some((o) => o !== r && unique[table]?.(o, next))) return { data: null, error: { message: 'duplicate key', code: '23505' } }
        }
        for (const r of hit) Object.assign(r, patch)
        return { data: hit, error: null }
      }
      if (op.kind === 'delete') {
        tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: hit, error: null }
      }
      if (sort) {
        const { key, ascending } = sort
        hit = [...hit].sort((a, b) => compare(a[key], b[key]) * (ascending ? 1 : -1))
      }
      if (head) return { data: null, error: null, count: hit.length }
      return { data: hit.slice(offset, offset + max), error: null }
    }
    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => ((head = opts?.head === true), chain),
      insert: (input: Row | Row[]) => ((op = { kind: 'insert', rows: Array.isArray(input) ? input : [input] }), chain),
      upsert: (input: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => (
        (op = {
          kind: 'upsert',
          rows: Array.isArray(input) ? input : [input],
          on: (opts?.onConflict ?? '').split(',').map((k) => k.trim()).filter(Boolean),
          ignore: opts?.ignoreDuplicates === true,
        }), chain
      ),
      update: (patch: Row) => ((op = { kind: 'update', patch }), chain),
      delete: () => ((op = { kind: 'delete' }), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      gt: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) > 0), chain),
      gte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) >= 0), chain),
      lt: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) < 0), chain),
      lte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) <= 0), chain),
      not: (k: string, o: string, v: unknown) => {
        if (o !== 'is' || v !== null) throw new Error(`memory-db: not ${o}`)
        return filters.push((r) => r[k] != null), chain
      },
      contains: (k: string, vs: unknown[]) => (filters.push((r) => Array.isArray(r[k]) && vs.every((v) => (r[k] as unknown[]).includes(v))), chain),
      ilike: (k: string, pattern: string) => (filters.push(likeFilter(k, pattern)), chain),
      or: (expr: string) => (filters.push(orFilter(expr)), chain),
      order: (key: string, opts?: { ascending?: boolean }) => ((sort = { key, ascending: opts?.ascending !== false }), chain),
      limit: (n: number) => ((max = n), chain),
      range: (from: number, to: number) => ((offset = from), (max = to - from + 1), chain),
      single: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error: error ?? (data?.length ? null : { message: 'no rows', code: 'PGRST116' }) }
      },
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  return { from } as unknown as SupabaseClient
}
