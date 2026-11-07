/**
 * A small in-memory Supabase stand-in for the import tests: tables of rows
 * that select / insert / update / delete / upsert really change, with the
 * filters the importer chains (eq, neq, is, in, ilike, order, limit, range),
 * unique keys answering a duplicate with Postgres' 23505, and `on delete set
 * null` for the foreign keys the undo leans on.
 */
type Row = Record<string, unknown>

export interface MemDb {
  tables: Record<string, Row[]>
  client: never
}

let seq = 0
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const UNIQUE: Record<string, string[][]> = {
  contact: [['workspace_id', 'email']],
  company: [['workspace_id', 'domain']],
  crm_source_link: [['workspace_id', 'source', 'kind', 'external_id']],
  contact_import_item: [['batch_id', 'seq']],
  // Postgres keys it on lower(email); the importer writes lowercased addresses.
  outreach_suppression: [['workspace_id', 'email']],
}

/** Columns that point at a deleted row become null (on delete set null) or the row goes (cascade). */
const FKS: Array<{ table: string; column: string; references: string; onDelete: 'set null' | 'cascade' }> = [
  { table: 'contact', column: 'company_id', references: 'company', onDelete: 'set null' },
  { table: 'contact', column: 'merged_into_contact_id', references: 'contact', onDelete: 'set null' },
  { table: 'contact_interaction', column: 'contact_id', references: 'contact', onDelete: 'cascade' },
  { table: 'contact_import_item', column: 'contact_id', references: 'contact', onDelete: 'set null' },
  { table: 'contact_import_item', column: 'candidate_contact_id', references: 'contact', onDelete: 'set null' },
  { table: 'contact_import_item', column: 'company_id', references: 'company', onDelete: 'set null' },
  { table: 'contact_import_item', column: 'created_company_id', references: 'company', onDelete: 'set null' },
]

function likeToRegex(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i++
    } else if (ch === '%') out += '.*'
    else if (ch === '_') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

/** A column, or a `col->>key` JSON path, as PostgREST reads it (text). */
function read(row: Row, key: string): unknown {
  const [col, path] = key.split('->>')
  if (path === undefined) return row[col]
  const obj = row[col] as Record<string, unknown> | null | undefined
  const v = obj?.[path]
  return v === undefined || v === null ? null : String(v)
}

export function memDb(
  seed: Record<string, Row[]> = {},
  opts: {
    visibleTo?: (contactId: string, userId: string) => boolean
    /** Runs after each inserted row, as an AFTER INSERT trigger would (e.g. migration 232's company adopt). */
    afterInsert?: (table: string, row: Row, tables: Record<string, Row[]>) => void
    /** Tables whose inserts fail (to test partial writes). */
    failInserts?: string[]
  } = {},
): MemDb {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]))

  function violates(table: string, row: Row, except?: Row): boolean {
    for (const keys of UNIQUE[table] ?? []) {
      if (keys.some((k) => row[k] === undefined || row[k] === null)) continue
      if ((tables[table] ?? []).some((other) => other !== except && keys.every((k) => other[k] === row[k]))) return true
    }
    return false
  }

  function cascade(table: string, ids: unknown[]) {
    for (const fk of FKS.filter((f) => f.references === table)) {
      const rows = tables[fk.table] ?? []
      if (fk.onDelete === 'set null') for (const r of rows) if (ids.includes(r[fk.column])) r[fk.column] = null
      if (fk.onDelete === 'cascade') {
        const gone = rows.filter((r) => ids.includes(r[fk.column]))
        tables[fk.table] = rows.filter((r) => !ids.includes(r[fk.column]))
        cascade(fk.table, gone.map((r) => r.id))
      }
    }
  }

  function from(table: string) {
    tables[table] ??= []
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let payload: Row | Row[] | null = null
    let returning = false
    let max = Infinity
    let offset = 0
    let sort: { key: string; ascending: boolean } | null = null

    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> => {
      const rows = tables[table]
      if (op === 'insert' || op === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload as Row]).map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }))
        const staged: Row[] = []
        for (const r of list) {
          if (violates(table, r) || staged.some((o) => (UNIQUE[table] ?? []).some((keys) => keys.every((k) => (o as Row)[k] != null && (o as Row)[k] === (r as Row)[k])))) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
          }
          staged.push(r)
        }
        if (opts.failInserts?.includes(table)) return { data: null, error: { message: `${table} insert down` } }
        rows.push(...staged)
        for (const r of staged) opts.afterInsert?.(table, r, tables)
        return { data: returning ? staged.map((r) => ({ ...r })) : null, error: null }
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of matched) {
          const next = { ...r, ...(payload as Row) }
          if (violates(table, next, r)) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        }
        for (const r of matched) Object.assign(r, structuredClone(payload as Row))
        return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null }
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !matched.includes(r))
        cascade(table, matched.map((r) => r.id))
        return { data: returning ? matched : null, error: null }
      }
      if (sort) {
        const { key, ascending } = sort
        matched = [...matched].sort((a, b) => {
          const x = a[key] as number | string
          const y = b[key] as number | string
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1)
        })
      }
      return { data: matched.slice(offset, offset + max).map((r) => structuredClone(r)), error: null }
    }

    const chain: Record<string, unknown> = {
      select: () => {
        if (op !== 'select') returning = true
        return chain
      },
      insert: (r: Row | Row[]) => ((op = 'insert'), (payload = r), chain),
      upsert: (r: Row | Row[]) => ((op = 'upsert'), (payload = r), chain),
      update: (r: Row) => ((op = 'update'), (payload = r), chain),
      delete: () => ((op = 'delete'), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => read(r, k) === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => read(r, k) !== v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (read(r, k) ?? null) === v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(read(r, k))), chain),
      ilike: (k: string, pattern: string) => (filters.push((r) => typeof r[k] === 'string' && likeToRegex(pattern).test(r[k] as string)), chain),
      order: (key: string, o?: { ascending?: boolean }) => ((sort = { key, ascending: o?.ascending !== false }), chain),
      limit: (n: number) => ((max = n), chain),
      range: (a: number, b: number) => ((offset = a), (max = b - a + 1), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'contact_visible_to') return { data: opts.visibleTo ? opts.visibleTo(String(args.p_contact_id), String(args.p_user_id)) : true, error: null }
    return { data: null, error: { message: `no rpc ${fn}` } }
  }
  return { tables, client: { from, rpc } as never }
}

/** A contact row with the columns the importer reads. */
export function contactRow(overrides: Row): Row {
  return {
    id: newId(),
    workspace_id: 'ws-1',
    first_name: null,
    last_name: null,
    full_name: 'Someone',
    email: null,
    secondary_emails: [],
    phone: null,
    address: null,
    job_title: null,
    notes: null,
    tags: [],
    company_id: null,
    member_id: null,
    relationship_type: 'contact',
    visibility: 'workspace',
    created_by_member_id: null,
    last_interaction_at: null,
    interaction_count: 0,
    metadata: {},
    merged_into_contact_id: null,
    source: 'manual',
    source_provider: null,
    provider_contact_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
