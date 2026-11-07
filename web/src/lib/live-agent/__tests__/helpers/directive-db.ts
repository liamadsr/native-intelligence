/**
 * An in-memory `captures` + `live_directive` for the directive writers' tests
 * (the route, tell_note_taker, direct_notes). It answers the chains those
 * writers use: eq filters, a head count, insert → select → single, order and
 * limit, maybeSingle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export interface DirectiveDb {
  client: SupabaseClient
  tables: { captures: Row[]; live_directive: Row[] }
}

export function directiveDb(
  seed: { captures?: Row[]; live_directive?: Row[] } = {},
  opts: { insertError?: string } = {},
): DirectiveDb {
  const tables = { captures: [...(seed.captures ?? [])], live_directive: [...(seed.live_directive ?? [])] }
  let seq = tables.live_directive.length
  const client = {
    from(table: 'captures' | 'live_directive') {
      const filters: Array<[string, unknown]> = []
      let head = false
      let insertRow: Row | null = null
      let order: { col: string; asc: boolean } | null = null
      let limit: number | null = null
      const matching = () => tables[table].filter((r) => filters.every(([c, v]) => r[c] === v))
      const doInsert = () => {
        if (opts.insertError) return { data: null, error: { message: opts.insertError } }
        seq += 1
        const row: Row = {
          id: `dir-${seq}`,
          status: 'pending',
          consumed_at: null,
          consumed_session: null,
          created_at: new Date(Date.UTC(2026, 8, 29, 20, 0, seq)).toISOString(),
          ...insertRow,
        }
        tables[table].push(row)
        return { data: row, error: null }
      }
      const b: Record<string, unknown> = {
        select(_cols?: string, o?: { head?: boolean }) {
          if (o?.head) head = true
          return b
        },
        insert(row: Row) {
          insertRow = row
          return b
        },
        eq(col: string, val: unknown) {
          filters.push([col, val])
          return b
        },
        order(col: string, o?: { ascending?: boolean }) {
          order = { col, asc: o?.ascending !== false }
          return b
        },
        limit(n: number) {
          limit = n
          return b
        },
        maybeSingle() {
          return Promise.resolve({ data: matching()[0] ?? null, error: null })
        },
        single() {
          if (insertRow) return Promise.resolve(doInsert())
          const rows = matching()
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'not single' } })
        },
        then(ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) {
          let rows = matching()
          if (head) return Promise.resolve({ data: null, count: rows.length, error: null }).then(ok, fail)
          if (order) {
            const { col, asc } = order
            rows = [...rows].sort((x, y) => String(x[col]).localeCompare(String(y[col])) * (asc ? 1 : -1))
          }
          if (limit != null) rows = rows.slice(0, limit)
          return Promise.resolve({ data: rows, error: null }).then(ok, fail)
        },
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, tables }
}

export const OWNER = 'user-owner'
export const OTHER = 'user-other'
export const WS = 'ws-1'
export const CAP = 'cap-1'

/** The capture every writer test targets: owned by OWNER in WS, still live. */
export function liveCapture(over: Row = {}): Row {
  return { id: CAP, user_id: OWNER, workspace_id: WS, batch_processed_at: null, ...over }
}
