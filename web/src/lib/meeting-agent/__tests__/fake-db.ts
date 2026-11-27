/**
 * An in-memory database for the meeting agent's tests: `meeting_attendance`,
 * `captures` and `member`, answering the chains the code uses (select, eq,
 * neq, in, is, gte, match, order, limit, maybeSingle, single, insert,
 * update). Timestamps compare as instants, as timestamptz does. Made-up
 * people and numbers only (555-01xx).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export const WS = 'ws-1'
export const ME = 'user-me'
export const OTHER = 'user-other'
export const EVENT = 'evt_abc123'
export const START = '2026-11-30T18:00:00.000Z'
export const END = '2026-11-30T18:30:00.000Z'
export const ATT = '22222222-2222-4222-8222-222222222222'

const TIME_COLS = new Set(['starts_at', 'ends_at', 'scheduled_start'])
const same = (col: string, a: unknown, b: unknown) =>
  TIME_COLS.has(col) && typeof a === 'string' && typeof b === 'string' ? Date.parse(a) === Date.parse(b) : a === b

export function attendanceRow(over: Row = {}): Row {
  return {
    id: ATT,
    workspace_id: WS,
    user_id: ME,
    calendar_event_id: EVENT,
    starts_at: START,
    ends_at: END,
    title: 'Pilot review with Acme',
    status: 'scheduled',
    status_detail: null,
    dial_in_number: '+15555550142',
    dial_in_pin: 'wwwwww123456789#',
    brief: { goals: ['Get a yes on the pilot'], may_share: ['We can start in January'], ask: ['Who signs off?'], must_not_agree: [] },
    brief_approved_at: '2026-11-29T10:00:00.000Z',
    display_name: "Sam's assistant (AI)",
    owner_first_name: 'Sam',
    capture_id: null,
    live_session_id: null,
    twilio_call_sid: null,
    join_token_hash: null,
    asks: [],
    joined_at: null,
    left_at: null,
    ...over,
  }
}

export interface FakeDb {
  client: SupabaseClient
  tables: Record<string, Row[]>
  writes: Array<{ table: string; op: 'insert' | 'update'; values: Row }>
}

export function fakeDb(seed: Record<string, Row[]> = {}, opts: { failOn?: 'select' | 'insert' | 'update' } = {}): FakeDb {
  const tables: Record<string, Row[]> = { meeting_attendance: [], captures: [], member: [] }
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const writes: FakeDb['writes'] = []
  let ids = 0

  function from(table: string) {
    tables[table] ??= []
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: Row | null = null
    let limit = Infinity
    let order: { col: string; asc: boolean } | null = null

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (opts.failOn === op) return { data: null, error: { message: `${op} failed` } }
      if (op === 'insert') {
        const row = { id: `row-${++ids}`, ...payload! }
        tables[table].push(row)
        writes.push({ table, op, values: payload! })
        return { data: [row], error: null }
      }
      let rows = tables[table].filter((r) => filters.every((f) => f(r)))
      if (op === 'delete') {
        tables[table] = tables[table].filter((r) => !rows.includes(r))
        return { data: rows, error: null }
      }
      if (op === 'update') {
        rows.forEach((r) => Object.assign(r, payload))
        writes.push({ table, op, values: payload! })
      }
      if (order) {
        const { col, asc } = order
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
      }
      return { data: rows.slice(0, limit), error: null }
    }

    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (values: Row) => ((op = 'insert'), (payload = values), chain),
      update: (values: Row) => ((op = 'update'), (payload = values), chain),
      delete: () => ((op = 'delete'), chain),
      eq: (col: string, v: unknown) => (filters.push((r) => same(col, r[col], v)), chain),
      neq: (col: string, v: unknown) => (filters.push((r) => !same(col, r[col], v)), chain),
      is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), chain),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.some((v) => same(col, r[col], v))), chain),
      gte: (col: string, v: string) => (filters.push((r) => Date.parse(String(r[col])) >= Date.parse(v)), chain),
      gt: (col: string, v: string) => (filters.push((r) => Date.parse(String(r[col])) > Date.parse(v)), chain),
      match: (m: Row) => {
        for (const [k, v] of Object.entries(m)) filters.push((r) => same(k, r[k], v))
        return chain
      },
      order: (col: string, o: { ascending?: boolean } = {}) => ((order = { col, asc: o.ascending !== false }), chain),
      limit: (n: number) => ((limit = n), chain),
      maybeSingle: async () => {
        const { data, error } = run()
        return { data: data?.[0] ?? null, error }
      },
      single: async () => {
        const { data, error } = run()
        if (error) return { data: null, error }
        return data?.[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } }
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    }
    return chain
  }

  return { client: { from } as unknown as SupabaseClient, tables, writes }
}
