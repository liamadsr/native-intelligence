/**
 * Make a Supabase double refuse table and column names the database doesn't
 * have, the way PostgREST does.
 *
 * The in-memory doubles answer whatever a query names: a select of a column
 * the table lacks, an order by it, or a read of a table that was never
 * created all come back with rows. So a query PostgREST rejects on every call
 * passes its tests. That is how `capture_participant` reads ordered by a
 * `created_at` the table never had (it has `joined_at`) and a count of
 * `action_github_prs` (the table is `action_github_pr`) shipped.
 *
 * `withTableSchema(fake, tables)` wraps a double so that:
 *   - `.from(name)` of a table or view no migration leaves in place resolves
 *     to Postgres' "relation does not exist";
 *   - for each table in `tables`, a column that table doesn't have, selected,
 *     filtered on, ordered by or written, at the top level or inside an embed
 *     that names the table (`cp:capture_participant!inner(created_at)`, and
 *     an order or `or` with `{ referencedTable: 'cp' }`), resolves to "column
 *     does not exist". An embed named by its foreign-key column
 *     (`capture:capture_id(...)`) is not checked: the double can't tell
 *     which table that reaches.
 *
 * Both answers come from the schema a database is built from: the baseline
 * dump (supabase/baseline/schema.sql, the database as of the cut) and every
 * migration after the cut, which is what scripts/db-bootstrap.sh applies. So
 * the double follows the schema forward. Column checks are opt-in per table;
 * member has its own, stricter double (member-schema.ts).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { migrationsInOrder } from './migration-sql'
import { namedColumns, orColumns, parseSelect, refused, tableColumns, type PostgrestError } from './member-schema'

const BASELINE_DIR = path.join(process.cwd(), 'supabase/baseline')

const IDENT = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`

let sourcesMemo: { sql: string }[] | null = null

/** The baseline dump, then every migration numbered after its cut, in order. */
export function schemaSources(): { sql: string }[] {
  if (sourcesMemo) return sourcesMemo
  const cutLine = readFileSync(path.join(BASELINE_DIR, 'CUT'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .pop()
  const cut = Number.parseInt(cutLine ?? '', 10)
  if (!Number.isFinite(cut)) throw new Error('supabase/baseline/CUT names no migration number')
  return (sourcesMemo = [
    { sql: readFileSync(path.join(BASELINE_DIR, 'schema.sql'), 'utf8') },
    ...migrationsInOrder().filter((m) => m.num > cut),
  ])
}

let relationsMemo: Set<string> | null = null

/**
 * The tables and views in the public schema: CREATE TABLE / VIEW /
 * MATERIALIZED VIEW, minus DROP, following RENAME TO.
 */
export function relationNames(): Set<string> {
  if (relationsMemo) return relationsMemo
  const names = new Set<string>()
  const statement = new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?${IDENT}` +
      String.raw`|drop\s+(?:materialized\s+)?(?:table|view)\s+(?:if\s+exists\s+)?([^;]*)` +
      String.raw`|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}\s+rename\s+to\s+${IDENT}`,
    'gi',
  )
  for (const { sql } of schemaSources()) {
    const text = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
    for (const m of text.matchAll(statement)) {
      if (m[1]) names.add(m[1].toLowerCase())
      else if (m[2] !== undefined) {
        for (const dropped of m[2].replace(/\b(?:cascade|restrict)\b/gi, '').split(',')) {
          const name = dropped.trim().match(new RegExp(`^${IDENT}`, 'i'))?.[1]
          if (name) names.delete(name.toLowerCase())
        }
      } else if (m[3] && m[4]) {
        names.delete(m[3].toLowerCase())
        names.add(m[4].toLowerCase())
      }
    }
  }
  return (relationsMemo = names)
}

const missingRelation = (table: string): PostgrestError => ({
  code: '42P01',
  message: `relation "public.${table}" does not exist`,
  details: null,
  hint: null,
})

const missingColumn = (table: string, column: string): PostgrestError => ({
  code: '42703',
  message: `column ${table}.${column} does not exist`,
  details: null,
  hint: null,
})

const columnsMemo = new Map<string, Set<string>>()
function columnsOf(table: string): Set<string> {
  let columns = columnsMemo.get(table)
  if (!columns) columnsMemo.set(table, (columns = tableColumns(table, schemaSources())))
  return columns
}

/** The first unknown column in `select` on `table` (or in an embed of a checked table), or null. */
function selectError(table: string | null, select: string, checked: ReadonlySet<string>, embeds: Map<string, string>): PostgrestError | null {
  for (const item of parseSelect(select)) {
    if (item.kind === 'column') {
      if (table && item.name !== '*' && !columnsOf(table).has(item.name.toLowerCase())) return missingColumn(table, item.name)
      continue
    }
    const target = checked.has(item.target) ? item.target : null
    if (target) embeds.set(item.alias ?? item.target, target)
    const nested = selectError(target, item.inner, checked, embeds)
    if (nested) return nested
  }
  return null
}

function queryError(
  table: string,
  method: string,
  args: unknown[],
  checked: ReadonlySet<string>,
  embeds: Map<string, string>,
): PostgrestError | null {
  const own = checked.has(table) ? table : null
  if (method === 'select') return selectError(own, typeof args[0] === 'string' ? args[0] : '*', checked, embeds)
  // An order or `or` on an embed (`{ referencedTable: alias }`) names that embed's columns.
  const options = args[1] as { referencedTable?: string; foreignTable?: string } | undefined
  const referenced = (method === 'order' || method === 'or') && (options?.referencedTable ?? options?.foreignTable)
  if (referenced) {
    const embedded = embeds.get(referenced)
    if (!embedded) return null
    const columns = method === 'order' ? [String(args[0])] : orColumns(String(args[0] ?? ''))
    const unknown = columns.find((c) => !columnsOf(embedded).has(c.split('->')[0].trim().toLowerCase()))
    return unknown ? missingColumn(embedded, unknown) : null
  }
  for (const named of namedColumns(method, args)) {
    const column = named.split('->')[0].trim()
    const dot = column.indexOf('.')
    if (dot === -1) {
      if (own && !columnsOf(own).has(column.toLowerCase())) return missingColumn(own, column)
      continue
    }
    const embedded = embeds.get(column.slice(0, dot))
    const inner = column.slice(dot + 1)
    if (embedded && !inner.includes('.') && !columnsOf(embedded).has(inner.toLowerCase())) return missingColumn(embedded, inner)
  }
  return null
}

function guardQuery(table: string, builder: unknown, checked: ReadonlySet<string>, embeds: Map<string, string>): unknown {
  if (!builder || (typeof builder !== 'object' && typeof builder !== 'function') || builder instanceof Promise) {
    return builder
  }
  return new Proxy(builder as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return value
      }
      return (...args: unknown[]) => {
        const error = queryError(table, prop, args, checked, embeds)
        if (error) return refused(error)
        return guardQuery(table, (value as (...a: unknown[]) => unknown).apply(target, args), checked, embeds)
      }
    },
  })
}

/**
 * Wrap a Supabase double so unknown tables, and unknown columns of `tables`,
 * fail the way PostgREST fails them (see the file comment). `auth`, `rpc` and
 * every valid query pass through to the double untouched.
 */
export function withTableSchema<C extends object>(client: C, tables: readonly string[] = []): C {
  const checked = new Set(tables)
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'from' || typeof value !== 'function') return value
      return (table: string, ...rest: unknown[]) => {
        const name = String(table)
        if (!relationNames().has(name.toLowerCase())) return refused(missingRelation(name))
        return guardQuery(name, (value as (...a: unknown[]) => unknown).call(target, table, ...rest), checked, new Map())
      }
    },
  })
}
