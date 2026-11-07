/**
 * A small in-memory stand-in for the service client in the agent-link tests:
 * real rows in tables, so a request, an accept and an end can be followed
 * through their state. Check constraints are the test's own (`checks`: a
 * table's insert is refused with 23514 when one returns false). Covers what ./store.ts calls (select with head
 * counts, insert, upsert, update, delete; eq, neq, in, gt, gte, is; PostgREST `or` of plain
 * and `and(...)` groups; order; single and maybeSingle). Unique indexes are
 * the test's own (`unique`).
 */
import { randomUUID } from 'node:crypto'

type Row = Record<string, unknown>
type Pred = (row: Row) => boolean

function parseOr(expr: string): Pred {
  const groups: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      groups.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) groups.push(cur)
  const one = (term: string): Pred => {
    if (term.startsWith('and(')) {
      const inner = term.slice(4, -1).split(',').map(one)
      return (row) => inner.every((p) => p(row))
    }
    const [col, op, ...rest] = term.split('.')
    const val = rest.join('.')
    if (op !== 'eq') throw new Error(`memory-db: or op ${op}`)
    return (row) => String(row[col]) === val
  }
  const preds = groups.map(one)
  return (row) => preds.some((p) => p(row))
}

/** chat_messages' generated ui_message_id, for an upsert keyed on it. */
function withPaths(row: Row): Row {
  const ui = row.ui_message as { id?: unknown } | undefined
  return ui && typeof ui.id === 'string' ? { ...row, ui_message_id: ui.id } : row
}

export function memoryDb(opts: { unique?: Record<string, (a: Row, b: Row) => boolean>; checks?: Record<string, (row: Row) => boolean> } = {}) {
  const tables: Record<string, Row[]> = {}
  const table = (name: string) => (tables[name] ??= [])
  const uniqueClash = (name: string, row: Row, except?: Row) =>
    Object.entries(opts.unique ?? {}).some(([key, same]) => key.startsWith(`${name}:`) && table(name).some((other) => other !== except && other !== row && same(row, other)))

  const from = (name: string) => {
    const preds: Pred[] = []
    let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
    let conflictCols: string[] = []
    let values: Row | Row[] | undefined
    let head = false
    let wantCount = false
    let orderBy: { col: string; asc: boolean } | null = null

    const run = (): { data: unknown; error: { message: string; code?: string } | null; count: number | null } => {
      const rows = table(name)
      const matches = () => rows.filter((r) => preds.every((p) => p(r)))
      if (op === 'insert') {
        const list = (Array.isArray(values) ? values : [values]) as Row[]
        const made: Row[] = []
        for (const v of list) {
          const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...v }
          // The primary key, and the test's own unique indexes.
          if (rows.some((r) => r.id === row.id) || uniqueClash(name, row)) return { data: null, error: { message: 'duplicate key', code: '23505' }, count: null }
          if (opts.checks?.[name] && !opts.checks[name](row)) return { data: null, error: { message: `new row for relation "${name}" violates check constraint`, code: '23514' }, count: null }
          rows.push(row)
          made.push(row)
        }
        return { data: made, error: null, count: null }
      }
      if (op === 'upsert') {
        const list = (Array.isArray(values) ? values : [values]) as Row[]
        for (const v of list) {
          const hit = rows.find((r) => conflictCols.every((c) => JSON.stringify(r[c]) === JSON.stringify(v[c])))
          if (hit) Object.assign(hit, v)
          else rows.push({ id: randomUUID(), created_at: new Date().toISOString(), ...v })
        }
        return { data: list, error: null, count: null }
      }
      if (op === 'update') {
        const hit = matches()
        for (const r of hit) {
          const next = { ...r, ...(values as Row) }
          if (uniqueClash(name, next, r)) return { data: null, error: { message: 'duplicate key', code: '23505' }, count: null }
        }
        for (const r of hit) Object.assign(r, values as Row)
        return { data: hit, error: null, count: null }
      }
      if (op === 'delete') {
        const hit = matches()
        tables[name] = rows.filter((r) => !hit.includes(r))
        return { data: hit, error: null, count: null }
      }
      let hit = matches()
      if (orderBy) {
        const { col, asc } = orderBy
        hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1))
      }
      return { data: head ? null : hit.map((r) => ({ ...r })), error: null, count: wantCount ? hit.length : null }
    }

    const chain: Record<string, unknown> = {
      select: (_cols?: string, o?: { head?: boolean; count?: string }) => {
        if (o?.head) head = true
        if (o?.count) wantCount = true
        return chain
      },
      insert: (v: Row | Row[]) => ((op = 'insert'), (values = v), chain),
      update: (v: Row) => ((op = 'update'), (values = v), chain),
      // onConflict names columns; a path like ui_message_id reads ui_message.id.
      upsert: (v: Row | Row[], o?: { onConflict?: string }) => {
        op = 'upsert'
        values = Array.isArray(v) ? v.map(withPaths) : withPaths(v)
        conflictCols = (o?.onConflict ?? 'id').split(',').map((c) => c.trim())
        return chain
      },
      delete: () => ((op = 'delete'), chain),
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), chain),
      neq: (c: string, v: unknown) => (preds.push((r) => r[c] !== v), chain),
      in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(r[c])), chain),
      gt: (c: string, v: string) => (preds.push((r) => typeof r[c] === 'string' && (r[c] as string) > v), chain),
      gte: (c: string, v: string) => (preds.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v), chain),
      is: (c: string, v: null) => (preds.push((r) => (r[c] ?? null) === v), chain),
      or: (expr: string) => (preds.push(parseOr(expr)), chain),
      order: (col: string, o?: { ascending?: boolean }) => ((orderBy = { col, asc: o?.ascending !== false }), chain),
      limit: () => chain,
      single: async () => {
        const r = run()
        if (r.error) return r
        const list = (r.data as Row[] | null) ?? []
        return list.length === 1 ? { data: { ...list[0] }, error: null } : { data: null, error: { message: `expected one row, got ${list.length}` } }
      },
      maybeSingle: async () => {
        const r = run()
        if (r.error) return r
        const list = (r.data as Row[] | null) ?? []
        return { data: list[0] ? { ...list[0] } : null, error: null }
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    }
    return chain
  }
  return { supabase: { from } as never, tables, table }
}
