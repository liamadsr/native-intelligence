/**
 * An in-memory `meeting_goal` + `captures` for the meeting-goal tests (the lib,
 * the route, set_meeting_goal, get_meeting_prep's goal); any other table reads
 * empty. It answers the chains
 * those use: eq / in / gte filters, a PostgREST `or` of `col.eq.value` terms,
 * order, limit, maybeSingle / single, an upsert on the meeting key
 * (onConflict), and delete → select.
 *
 * Timestamps behave like timestamptz: a row's starts_at is kept the way
 * Postgres returns it ("…+00:00"), and a filter on it compares instants, so
 * "…Z", "…000Z" and "-04:00" spellings of one start all match.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export const WS = 'ws-1'
export const ME = 'user-me'
export const OTHER = 'user-other'
export const CAP = '11111111-1111-4111-8111-111111111111'
export const EVENT = 'evt_abc123'
export const START = '2026-10-17T18:30:00.000Z'

const TIME_COLS = new Set(['starts_at', 'occurrence_start', 'scheduled_start', 'updated_at', 'created_at'])
const pgTime = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString().replace('Z', '+00:00') : v)
const same = (col: string, a: unknown, b: unknown) =>
  TIME_COLS.has(col) && typeof a === 'string' && typeof b === 'string' ? Date.parse(a) === Date.parse(b) : a === b

export interface MeetingGoalDb {
  client: SupabaseClient
  tables: { meeting_goal: Row[]; captures: Row[] } & Record<string, Row[]>
  /** Every from(table) call, in order. */
  reads: string[]
}

export function goalRow(over: Row = {}): Row {
  return {
    id: 'goal-1',
    workspace_id: WS,
    user_id: ME,
    calendar_event_id: EVENT,
    starts_at: pgTime(START),
    capture_id: null,
    goal: 'Close the pilot',
    source: 'prep_card',
    created_at: '2026-10-17T12:00:00+00:00',
    updated_at: '2026-10-17T12:00:00+00:00',
    ...over,
  }
}

export function meetingGoalDb(
  seed: { meeting_goal?: Row[]; captures?: Row[] } = {},
  opts: { failOn?: 'select' | 'upsert' | 'delete' } = {},
): MeetingGoalDb {
  const tables: MeetingGoalDb['tables'] = {
    meeting_goal: (seed.meeting_goal ?? []).map((r) => ({ ...r, starts_at: pgTime(r.starts_at) })),
    captures: [...(seed.captures ?? [])],
  }
  const reads: string[] = []
  let seq = tables.meeting_goal.length
  const client = {
    from(table: string) {
      reads.push(table)
      // Any other table reads empty (get_meeting_prep's participants, say).
      tables[table] ??= []
      const filters: Array<(r: Row) => boolean> = []
      let op: 'select' | 'upsert' | 'delete' = 'select'
      let upsertRow: Row | null = null
      let conflict: string[] = []
      let order: { col: string; asc: boolean } | null = null
      let limit: number | null = null
      const matching = () => tables[table].filter((r) => filters.every((f) => f(r)))
      const run = (): { data: Row[] | null; error: { message: string } | null } => {
        if (opts.failOn === op) return { data: null, error: { message: `${op} failed` } }
        if (op === 'upsert' && upsertRow) {
          const row: Row = { ...upsertRow, starts_at: pgTime(upsertRow.starts_at) }
          const hit = tables[table].find((r) => conflict.every((c) => same(c, r[c], row[c])))
          const now = new Date(Date.UTC(2026, 9, 17, 13, 0, ++seq)).toISOString().replace('Z', '+00:00')
          if (hit) {
            Object.assign(hit, row, { updated_at: now })
            return { data: [hit], error: null }
          }
          const created = { id: `goal-${seq}`, capture_id: null, created_at: now, updated_at: now, ...row }
          tables[table].push(created)
          return { data: [created], error: null }
        }
        let rows = matching()
        if (op === 'delete') {
          tables[table] = tables[table].filter((r) => !rows.includes(r))
          return { data: rows, error: null }
        }
        if (order) {
          const { col, asc } = order
          rows = [...rows].sort((a, b) => {
            const x = String(a[col] ?? '')
            const y = String(b[col] ?? '')
            return asc ? x.localeCompare(y) : y.localeCompare(x)
          })
        }
        if (limit != null) rows = rows.slice(0, limit)
        return { data: rows, error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        upsert(row: Row, o?: { onConflict?: string }) {
          op = 'upsert'
          upsertRow = row
          conflict = (o?.onConflict ?? 'id').split(',')
          return b
        },
        delete() {
          op = 'delete'
          return b
        },
        eq(col: string, val: unknown) {
          filters.push((r) => same(col, r[col], val))
          return b
        },
        in(col: string, vals: unknown[]) {
          filters.push((r) => vals.some((v) => same(col, r[col], v)))
          return b
        },
        or(expr: string) {
          const terms = expr.split(',').map((t) => {
            const [col, opName, ...rest] = t.split('.')
            if (opName !== 'eq') throw new Error(`or: only eq terms (${t})`)
            return { col, val: rest.join('.') }
          })
          filters.push((r) => terms.some(({ col, val }) => String(r[col]) === val))
          return b
        },
        gte(col: string, val: string) {
          filters.push((r) => typeof r[col] === 'string' && Date.parse(r[col] as string) >= Date.parse(val))
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
        maybeSingle: async () => {
          const { data, error } = run()
          return { data: data?.[0] ?? null, error }
        },
        single: async () => {
          const { data, error } = run()
          return data?.[0] ? { data: data[0], error } : { data: null, error: error ?? { message: 'no rows' } }
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject)
        },
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, tables, reads }
}
