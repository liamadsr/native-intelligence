/**
 * An in-memory stand-in for the Supabase client the deal layer reads and
 * writes through (src/lib/crm/deals.ts over src/lib/tables/store.ts): the
 * selects it makes (eq, neq, in, is, not is, gt, ilike with %, contains on
 * custom_fields, a small or(), custom_fields->>key paths, `a:b::text`
 * aliases, order, limit, range, maybeSingle, single) and the RPCs:
 * ensure_default_pipeline, create_pipeline and apply_data_ops (insert_rows,
 * update_row, archive_rows and create_column, logged as data_change the way
 * 525's _data_apply logs them, the version bumped, an undo marking what it
 * took back). The database's own triggers (closed_at, the stage rules'
 * floor) are migration 540's and checked on DEV, not here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export interface FakePipelineDb {
  client: SupabaseClient
  rows: Record<string, Row[]>
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
}

const path = (r: Row, col: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(col)
  if (!m) return r[col]
  const v = (r[m[1]] as Record<string, unknown> | undefined)?.[m[2]]
  return v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v)
}

const contains = (have: unknown, want: unknown): boolean => {
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => contains(h, w)))
  if (want && typeof want === 'object') {
    if (!have || typeof have !== 'object') return false
    return Object.entries(want as Row).every(([k, v]) => contains((have as Row)[k], v))
  }
  return have === want
}

/** One PostgREST filter, `col.op.value`. */
function filterOf(expr: string): (r: Row) => boolean {
  const m = /^(.+?)\.(is|eq|in)\.(.*)$/.exec(expr)
  if (!m) throw new Error(`fake or(): ${expr}`)
  const [, col, op, raw] = m
  if (op === 'is') return (r) => (path(r, col) ?? null) === null
  if (op === 'eq') return (r) => path(r, col) === raw
  const list = [...raw.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((x) => (x[1] ?? x[2]).replace(/\\(.)/g, '$1'))
  return (r) => list.includes(String(path(r, col)))
}

/** Splits an or() list on its top-level commas. */
function splitOr(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ''
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === '(') depth++
    if (!quoted && ch === ')') depth--
    if (ch === ',' && depth === 0 && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

export function fakePipelineDb(rows: Record<string, Row[]>, opts: { rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } | null } = {}): FakePipelineDb {
  const rpcCalls: FakePipelineDb['rpcCalls'] = []
  let seq = 0
  const now = () => new Date(Date.UTC(2026, 10, 12, 9, 0, seq++)).toISOString()
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
  const table = (name: string) => (rows[name] ??= [])

  const from = (name: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let columns: string[] = []
    const orders: Array<{ col: string; asc: boolean }> = []
    let start = 0
    let end: number | null = null
    const q = {
      select(cols: string) {
        columns = cols.split(',').map((c) => c.trim()).filter(Boolean)
        return q
      },
      eq(col: string, v: unknown) {
        filters.push((r) => path(r, col) === v)
        return q
      },
      neq(col: string, v: unknown) {
        filters.push((r) => path(r, col) !== v)
        return q
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(path(r, col)))
        return q
      },
      is(col: string, v: null) {
        filters.push((r) => (path(r, col) ?? null) === v)
        return q
      },
      not(col: string, op: string, v: null) {
        if (op === 'is') filters.push((r) => (path(r, col) ?? null) !== v)
        return q
      },
      gt(col: string, v: number) {
        filters.push((r) => Number(r[col]) > v)
        return q
      },
      ilike(col: string, pattern: string) {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
        filters.push((r) => re.test(String(path(r, col) ?? '')))
        return q
      },
      contains(col: string, v: unknown) {
        filters.push((r) => contains(r[col], v))
        return q
      },
      or(expr: string) {
        const parts = splitOr(expr).map(filterOf)
        filters.push((r) => parts.some((f) => f(r)))
        return q
      },
      order(col: string, o: { ascending?: boolean } = {}) {
        orders.push({ col, asc: o.ascending !== false })
        return q
      },
      range(a: number, b: number) {
        start = a
        end = b
        return q
      },
      limit(n: number) {
        end = start + n - 1
        return q
      },
      async maybeSingle() {
        return { data: run()[0] ?? null, error: null }
      },
      async single() {
        const list = run()
        return list.length ? { data: list[0], error: null } : { data: null, error: { message: 'no rows' } }
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: run(), error: null }).then(resolve, reject)
      },
    }
    const pick = (r: Row): Row => {
      if (!columns.length || columns[0] === '*') return structuredClone(r)
      const out: Row = {}
      for (const c of columns) {
        const alias = /^(\w+):(\w+)::text$/.exec(c)
        const jsonAlias = /^(\w+):(\w+->>\w+)$/.exec(c)
        if (alias) out[alias[1]] = r[alias[2]] === undefined ? undefined : String(r[alias[2]])
        else if (jsonAlias) out[jsonAlias[1]] = path(r, jsonAlias[2])
        else if (!c.includes('(')) out[c] = structuredClone(r[c])
      }
      return out
    }
    const run = () => {
      let list = table(name).filter((r) => filters.every((f) => f(r)))
      for (const o of [...orders].reverse()) {
        list = [...list].sort((a, b) => {
          const x = a[o.col] as string | number
          const y = b[o.col] as string | number
          const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))
          return o.asc ? c : -c
        })
      }
      list = list.slice(start, end === null ? undefined : end + 1)
      return list.map(pick)
    }
    return q
  }

  /** 525's batch, as far as the deal layer uses it. */
  function applyDataOps(args: Record<string, unknown>) {
    const t = table('data_table').find((x) => x.id === args.p_table_id)
    if (!t) return { data: null, error: { code: 'P0002', message: 'table not found' } }
    if (args.p_base_version !== null && args.p_base_version !== undefined && args.p_base_version !== t.version) {
      return { data: null, error: { code: 'PT409', message: 'the table changed', details: String(t.version) } }
    }
    const changes: Row[] = []
    const inserted: string[] = []
    const created: Record<string, string> = {}
    for (const op of args.p_ops as Row[]) {
      if (op.op === 'insert_rows') {
        const ids: string[] = []
        for (const r of op.rows as Row[]) {
          const rid = (r.id as string) ?? id()
          const max = Math.max(0, ...table('data_row').filter((x) => x.table_id === t.id).map((x) => Number(x.position)))
          const at = now()
          table('data_row').push({
            id: rid,
            workspace_id: t.workspace_id,
            table_id: t.id,
            title: r.title ?? '',
            custom_fields: structuredClone(r.values ?? {}),
            position: max + 1,
            archived_at: null,
            created_at: at,
            updated_at: at,
            stage_changed_at: at,
            closed_at: null,
          })
          ids.push(rid)
        }
        inserted.push(...ids)
        changes.push({ op: 'insert_rows', row_ids: ids })
      } else if (op.op === 'update_row') {
        const row = table('data_row').find((x) => x.id === op.row_id && x.table_id === t.id)
        if (!row) return { data: null, error: { code: '22023', message: 'row not found' } }
        const fields: Row = {}
        if (op.title !== undefined && op.title !== row.title) {
          fields.title = { from: row.title, to: op.title }
          row.title = op.title
        }
        const cf = row.custom_fields as Row
        for (const [k, v] of Object.entries((op.values as Row) ?? {})) {
          const before = cf[k] ?? null
          if (JSON.stringify(before) === JSON.stringify(v ?? null)) continue
          fields[`values.${k}`] = { from: before, to: v ?? null }
          if (v === null) delete cf[k]
          else cf[k] = structuredClone(v)
        }
        if (Object.keys(fields).length) {
          row.updated_at = now()
          changes.push({ op: 'update_row', row_id: row.id, fields })
        }
      } else if (op.op === 'archive_rows') {
        for (const rid of op.row_ids as string[]) {
          const row = table('data_row').find((x) => x.id === rid)
          if (row) row.archived_at = now()
        }
        changes.push({ op: 'archive_rows', row_ids: op.row_ids })
      } else if (op.op === 'create_column') {
        const cid = id()
        const position = Math.max(-1, ...table('custom_field_definition').filter((c) => c.table_id === t.id).map((c) => Number(c.position))) + 1
        table('custom_field_definition').push({
          id: cid,
          workspace_id: t.workspace_id,
          entity_type: 'data_row',
          table_id: t.id,
          key: op.key,
          label: op.label,
          field_type: op.field_type,
          options: op.options ?? [],
          config: op.config ?? {},
          position,
          deleted_at: null,
          system: false,
        })
        created[op.key as string] = cid
        changes.push({ op: 'create_column', key: op.key, column_id: cid, label: op.label, field_type: op.field_type, options: op.options ?? [], config: op.config ?? {} })
      } else {
        return { data: null, error: { code: '22023', message: `fake: no ${String(op.op)}` } }
      }
    }
    if (!changes.length) return { data: { version: t.version, change_id: null, inserted_row_ids: [], created_column_ids: {} }, error: null }
    t.version = Number(t.version) + 1
    const cid = id()
    table('data_change').push({
      id: cid,
      workspace_id: t.workspace_id,
      table_id: t.id,
      version: t.version,
      actor_user_id: args.p_as_user ?? null,
      actor_member_id: null,
      source: args.p_source,
      reason: args.p_reason ?? null,
      changes,
      undo_of: args.p_undo_of ?? null,
      undone_at: null,
      created_at: now(),
    })
    if (args.p_undo_of) {
      const undone = table('data_change').find((c) => c.id === args.p_undo_of)
      if (undone) undone.undone_at = now()
    }
    return { data: { version: t.version, change_id: cid, inserted_row_ids: inserted, created_column_ids: created }, error: null }
  }

  const client = {
    from,
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      const answer = opts.rpc?.(name, args)
      if (answer) return answer
      if (name === 'ensure_default_pipeline') {
        const t = table('data_table').find((x) => x.workspace_id === args.p_workspace_id && x.is_default)
        return { data: t?.id ?? null, error: null }
      }
      if (name === 'apply_data_ops') return applyDataOps(args)
      if (name === 'create_pipeline') return { data: { table_id: 'new-pipeline', version: 1 }, error: null }
      return { data: null, error: { message: `fake: no rpc ${name}` } }
    },
  } as unknown as SupabaseClient
  return { client, rows, rpcCalls }
}

/** A pipeline table and its system columns, as 540's create_pipeline makes them. */
export function pipelineRows(opts: {
  id: string
  workspaceId: string
  name: string
  isDefault?: boolean
  position?: number
  stages?: Array<[string, 'open' | 'won' | 'lost']>
  extraColumns?: Row[]
  visibility?: 'workspace' | 'private'
  valueRule?: { key: string; option: string }
}): { table: Row; columns: Row[] } {
  const stages = opts.stages ?? [
    ['Lead', 'open'],
    ['Qualified', 'open'],
    ['Proposal', 'open'],
    ['Won', 'won'],
    ['Lost', 'lost'],
  ]
  const col = (key: string, label: string, field_type: string, position: number, extra: Row = {}): Row => ({
    id: `${opts.id}-${key}`,
    workspace_id: opts.workspaceId,
    entity_type: 'data_row',
    table_id: opts.id,
    key,
    label,
    field_type,
    options: [],
    config: {},
    position,
    deleted_at: null,
    system: key !== 'notes',
    created_at: '2026-11-01T00:00:00Z',
    ...extra,
  })
  return {
    table: {
      id: opts.id,
      workspace_id: opts.workspaceId,
      name: opts.name,
      icon: null,
      description: null,
      owner_member_id: null,
      visibility: opts.visibility ?? 'workspace',
      kind: 'pipeline',
      is_default: !!opts.isDefault,
      version: 1,
      position: opts.position ?? 0,
      archived_at: null,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    },
    columns: [
      col('stage', 'Stage', 'select', 0, {
        options: stages.map((s) => s[0]),
        config: { outcomes: Object.fromEntries(stages.filter((s) => s[1] !== 'open')) },
      }),
      col('value', 'Value', 'currency', 1, { config: { currency: 'USD', ...(opts.valueRule ? { required_when: opts.valueRule } : {}) } }),
      col('company', 'Company', 'relation', 2, { config: { target: { kind: 'company' }, multiple: false } }),
      col('contacts', 'Contacts', 'relation', 3, { config: { target: { kind: 'contact' }, multiple: true } }),
      col('expected_close', 'Expected close', 'date', 4),
      col('owner', 'Owner', 'person', 5),
      col('notes', 'Notes', 'text', 6),
      ...(opts.extraColumns ?? []),
    ],
  }
}
