/**
 * An in-memory stand-in for the two tables the snippet store reads (member,
 * snippet), answering the query chains it uses: select / eq / or / order /
 * limit / maybeSingle / single, insert, update, delete. It keeps the
 * database's two unique shortcuts (migration 699) and raises 23505 for them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const WS = '11111111-1111-4111-8111-111111111111'
export const ME = 'user-me'
export const OTHER = 'user-other'
export const ADMIN = 'user-admin'
export const M_ME = 'member-me'
export const M_OTHER = 'member-other'
export const M_ADMIN = 'member-admin'

type Row = Record<string, unknown>

export function snippetDb(seed: { snippet?: Row[]; member?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    member: seed.member ?? [
      { id: M_ME, user_id: ME, workspace_id: WS, role: 'member' },
      { id: M_OTHER, user_id: OTHER, workspace_id: WS, role: 'member' },
      { id: M_ADMIN, user_id: ADMIN, workspace_id: WS, role: 'admin' },
    ],
    snippet: seed.snippet ?? [],
  }
  let n = 0

  function violates(row: Row, others: Row[]): boolean {
    return others.some(
      (o) =>
        o !== row &&
        o.workspace_id === row.workspace_id &&
        o.shortcut === row.shortcut &&
        o.visibility === row.visibility &&
        (row.visibility === 'workspace' || o.created_by === row.created_by),
    )
  }

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: Row | null = null
    let limit = Infinity
    let order: string | null = null

    const run = (): { data: Row[]; error: { code: string; message: string } | null } => {
      const rows = tables[table]
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'insert') {
        const row: Row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, updated_at: `2026-11-23T00:00:0${n}Z`, ...payload }
        if (violates(row, rows)) return { data: [], error: { code: '23505', message: 'duplicate key' } }
        rows.push(row)
        return { data: [row], error: null }
      }
      if (op === 'update') {
        for (const r of hit) {
          const next = { ...r, ...payload, updated_at: `2026-11-23T01:00:0${++n}Z` }
          if (violates(next, rows.filter((o) => o !== r))) return { data: [], error: { code: '23505', message: 'duplicate key' } }
          Object.assign(r, next)
        }
        return { data: hit, error: null }
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !hit.includes(r))
        return { data: hit, error: null }
      }
      const sorted = order ? [...hit].sort((a, b) => String(a[order!]).localeCompare(String(b[order!]))) : hit
      return { data: sorted.slice(0, limit), error: null }
    }

    const chain = {
      select: () => chain,
      insert: (row: Row) => {
        op = 'insert'
        payload = row
        return chain
      },
      update: (row: Row) => {
        op = 'update'
        payload = row
        return chain
      },
      delete: () => {
        op = 'delete'
        return chain
      },
      eq: (col: string, value: unknown) => {
        filters.push((r) => r[col] === value)
        return chain
      },
      or: (expr: string) => {
        const arms = expr.split(',').map((a) => a.split('.eq.'))
        filters.push((r) => arms.some(([col, value]) => String(r[col]) === value))
        return chain
      },
      order: (col: string) => {
        order = col
        return chain
      },
      limit: (k: number) => {
        limit = k
        return chain
      },
      maybeSingle: async () => {
        const r = run()
        return { data: r.data[0] ?? null, error: r.error }
      },
      single: async () => {
        const r = run()
        return { data: r.data[0] ?? null, error: r.error ?? (r.data.length ? null : { code: 'PGRST116', message: 'no row' }) }
      },
      then: (resolve: (v: { data: Row[]; error: unknown }) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return chain
  }

  return { client: { from } as unknown as SupabaseClient, tables }
}

export function snippetRow(over: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    workspace_id: WS,
    created_by: M_ME,
    name: 'Signature',
    shortcut: 'sig',
    body: 'Best,\nMaya',
    visibility: 'personal',
    updated_at: '2026-11-20T00:00:00Z',
    ...over,
  }
}
