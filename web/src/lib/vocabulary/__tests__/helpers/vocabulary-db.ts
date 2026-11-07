/**
 * An in-memory stand-in for the Supabase queries src/lib/vocabulary/store.ts
 * makes: select / eq / is / ilike / or (comma-separated `col.eq.v` and
 * `col.is.null` terms) / order / limit / maybeSingle / single, insert, update
 * and delete with `.select()`. vocabulary_term's unique key (workspace,
 * owner, lower(trim(term))) answers 23505 like Postgres.
 */
type Row = Record<string, unknown>

export const WS = '11111111-1111-4111-8111-111111111111'
export const OTHER_WS = '22222222-2222-4222-8222-222222222222'
export const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let seq = 0
export function termRow(over: Row = {}): Row {
  seq++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    workspace_id: WS,
    user_id: null,
    term: 'Supabase',
    sounds_like: [],
    status: 'active',
    source: 'manual',
    evidence: {},
    created_by: ME,
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:00:00Z',
    ...over,
  }
}

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(',').map((p) => {
    const [col, op, ...rest] = p.split('.')
    const value = rest.join('.')
    if (op === 'is' && value === 'null') return (r: Row) => (r[col] ?? null) === null
    if (op === 'eq') return (r: Row) => String(r[col]) === value
    if (op === 'neq') return (r: Row) => (r[col] ?? null) !== null && String(r[col]) !== value
    throw new Error(`unsupported or term ${p}`)
  })
  return (r) => parts.some((f) => f(r))
}

const keyOf = (r: Row) => `${r.workspace_id}|${r.user_id ?? ''}|${String(r.term).trim().toLowerCase()}`

export interface VocabularyDb {
  client: never
  tables: Record<string, Row[]>
  calls: Array<{ table: string; op: string; payload?: unknown }>
}

export function vocabularyDb(seed: Record<string, Row[]> = {}, opts: { errorTables?: string[] } = {}): VocabularyDb {
  const tables: Record<string, Row[]> = { vocabulary_term: [], member: [], projects: [], contact: [], document: [], actions: [], chat_messages: [], ...structuredClone(seed) }
  const calls: VocabularyDb['calls'] = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let max = Infinity
    const sorts: Array<{ key: string; ascending: boolean }> = []
    let window: [number, number] | null = null
    let mode: { op: 'select' } | { op: 'insert'; rows: Row[] } | { op: 'update'; patch: Row } | { op: 'delete' } = { op: 'select' }

    const matching = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> => {
      if (opts.errorTables?.includes(table)) return { data: null, error: { message: `${table} down` } }
      if (mode.op === 'insert') {
        const out: Row[] = []
        for (const row of mode.rows) {
          const full = table === 'vocabulary_term' ? termRow({ ...row }) : { ...row }
          if (table === 'vocabulary_term' && (tables[table] ?? []).some((r) => keyOf(r) === keyOf(full))) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "vocabulary_term_key"', code: '23505' } }
          }
          ;(tables[table] ??= []).push(full)
          out.push(full)
        }
        return { data: out, error: null }
      }
      if (mode.op === 'update') {
        const rows = matching()
        for (const r of rows) {
          const next = { ...r, ...mode.patch, updated_at: '2026-10-25T00:00:00Z' }
          if (table === 'vocabulary_term' && (tables[table] ?? []).some((o) => o !== r && keyOf(o) === keyOf(next))) {
            return { data: null, error: { message: 'duplicate key', code: '23505' } }
          }
          Object.assign(r, next)
        }
        return { data: rows, error: null }
      }
      if (mode.op === 'delete') {
        const rows = matching()
        tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r))
        return { data: rows, error: null }
      }
      let rows = matching()
      if (sorts.length) {
        rows = [...rows].sort((a, b) => {
          for (const { key, ascending } of sorts) {
            const x = String(a[key] ?? ''), y = String(b[key] ?? '')
            if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1)
          }
          return 0
        })
      }
      if (window) rows = rows.slice(window[0], window[1] + 1)
      return { data: rows.slice(0, max), error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (rows: Row | Row[]) => {
        mode = { op: 'insert', rows: Array.isArray(rows) ? rows : [rows] }
        calls.push({ table, op: 'insert', payload: rows })
        return chain
      },
      update: (patch: Row) => {
        mode = { op: 'update', patch }
        calls.push({ table, op: 'update', payload: patch })
        return chain
      },
      delete: () => {
        mode = { op: 'delete' }
        calls.push({ table, op: 'delete' })
        return chain
      },
      order: (key: string, o?: { ascending?: boolean }) => (sorts.push({ key, ascending: o?.ascending !== false }), chain),
      range: (from: number, to: number) => ((window = [from, to]), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      ilike: (k: string, pattern: string) => {
        const want = pattern.replace(/\\(.)/g, '$1').toLowerCase()
        filters.push((r) => String(r[k] ?? '').toLowerCase() === want)
        return chain
      },
      or: (expr: string) => (filters.push(parseOr(expr)), chain),
      limit: (n: number) => ((max = n), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      single: async () => {
        const { data, error } = await run()
        if (error) return { data: null, error }
        if (!data?.length) return { data: null, error: { message: 'no rows', code: 'PGRST116' } }
        return { data: data[0], error: null }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  return { client: { from } as never, tables, calls }
}
