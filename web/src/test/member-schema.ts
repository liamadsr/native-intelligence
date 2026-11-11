/**
 * Make a Supabase double answer `member` queries the way PostgREST does.
 *
 * The member table has no `email` column (migration 013: a member's address
 * lives on auth.users). Hand-rolled fakes returned `{ email }` member rows
 * anyway, so reads that PostgREST rejects outright ("column member.email does
 * not exist") passed their tests while failing on every real call: the
 * calendar → CRM sweep refused every run, and meeting prep, participant
 * seeding and contact sharing never matched a teammate.
 *
 * `withMemberSchema(fake)` wraps any fake so that a member query naming a
 * column the table doesn't have resolves to PostgREST's error instead of the
 * fake's rows, whether the column is selected, filtered on, ordered by or
 * written, at the top level or inside an embed such as `member:member_id(email)`.
 * Embedding `auth.users` from a member row (`user:user_id(email)`) fails too,
 * as it does against the real API, where the auth schema isn't exposed.
 *
 * The columns come from supabase/migrations (the CREATE TABLE, then every
 * ADD / DROP / RENAME COLUMN), so the double follows the schema forward.
 */
import { migrationsInOrder } from './migration-sql'

export interface PostgrestError {
  message: string
  code: string
  details: string | null
  hint: string | null
}

const MEMBER = 'member'

/** Embed targets that resolve to the member table. */
const MEMBER_TARGETS = new Set(['member', 'member_id'])

/** Embed targets that would reach auth.users, which PostgREST can't see. */
const AUTH_TARGETS = new Set(['user_id', 'user', 'users'])

/** Leading words of a CREATE TABLE item, or an ALTER clause, that aren't a column. */
const NOT_COLUMNS = new Set(['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like'])

const FILTER_METHODS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'likeAllOf', 'likeAnyOf', 'ilikeAllOf',
  'ilikeAnyOf', 'is', 'in', 'contains', 'containedBy', 'overlaps', 'rangeGt', 'rangeGte', 'rangeLt',
  'rangeLte', 'rangeAdjacent', 'textSearch', 'not', 'filter',
])

const WRITE_METHODS = new Set(['insert', 'upsert', 'update'])

/** Split on commas outside parentheses and quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** The text inside the parenthesis that opens at `open`. */
function insideParens(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/**
 * A table's columns once every migration has run. `sources` defaults to the
 * migrations; table-schema.ts passes the baseline dump plus the migrations
 * after its cut, which also covers tables no migration creates.
 */
export function tableColumns(table: string, sources: readonly { sql: string }[] = migrationsInOrder()): Set<string> {
  const name = `(?:"?public"?\\.)?"?${table}"?`
  const columns = new Set<string>()
  for (const { sql } of sources) {
    const text = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
    for (const create of text.matchAll(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${name}\\s*\\(`, 'gi'))) {
      for (const item of splitTopLevel(insideParens(text, (create.index ?? 0) + create[0].length - 1))) {
        const word = item.match(/^"?([a-z_][a-z0-9_]*)"?/i)?.[1]?.toLowerCase()
        if (word && !NOT_COLUMNS.has(word)) columns.add(word)
      }
    }
    for (const alter of text.matchAll(new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${name}\\s([^;]*)`, 'gi'))) {
      for (const clause of splitTopLevel(alter[1])) {
        const add = clause.match(/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/i)?.[1]?.toLowerCase()
        const drop = clause.match(/^drop\s+(?:column\s+)?(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/i)?.[1]?.toLowerCase()
        const rename = clause.match(/^rename\s+(?:column\s+)?"?([a-z_][a-z0-9_]*)"?\s+to\s+"?([a-z_][a-z0-9_]*)"?/i)
        if (add && !NOT_COLUMNS.has(add)) columns.add(add)
        else if (drop && !NOT_COLUMNS.has(drop)) columns.delete(drop)
        else if (rename) {
          columns.delete(rename[1].toLowerCase())
          columns.add(rename[2].toLowerCase())
        }
      }
    }
  }
  return columns
}

let memberColumnsMemo: Set<string> | null = null

/** The member table's columns, per the migrations. */
export function memberColumns(): Set<string> {
  return (memberColumnsMemo ??= tableColumns(MEMBER))
}

export type SelectItem =
  | { kind: 'column'; name: string }
  | { kind: 'embed'; alias: string | null; target: string; inner: string }

/** A PostgREST select list, one level deep. */
export function parseSelect(select: string): SelectItem[] {
  return splitTopLevel(select.replace(/\s+/g, ' ')).map((raw): SelectItem => {
    const item = raw.replace(/^\.\.\./, '')
    const open = item.indexOf('(')
    if (open !== -1 && item.endsWith(')')) {
      const head = item.slice(0, open).trim()
      const colon = head.indexOf(':')
      return {
        kind: 'embed',
        alias: colon === -1 ? null : head.slice(0, colon).trim(),
        target: (colon === -1 ? head : head.slice(colon + 1)).split('!')[0].trim(),
        inner: insideParens(item, open),
      }
    }
    let name = item
    const cast = name.indexOf('::')
    if (cast !== -1) name = name.slice(0, cast)
    const colon = name.indexOf(':')
    if (colon !== -1) name = name.slice(colon + 1)
    return { kind: 'column', name: name.split('->')[0].trim().replace(/^"|"$/g, '') }
  })
}

const missingColumn = (column: string): PostgrestError => ({
  code: '42703',
  message: `column member.${column} does not exist`,
  details: null,
  hint: null,
})

const missingRelationship = (target: string): PostgrestError => ({
  code: 'PGRST200',
  message: `Could not find a relationship between 'member' and '${target}' in the schema cache`,
  details: `Searched for a foreign key relationship between 'member' and '${target}' in the schema 'public', but no matches were found.`,
  hint: null,
})

/** PostgREST's answer to selecting `select` from member, or null if it's valid. */
export function memberSelectError(select: string): PostgrestError | null {
  for (const item of parseSelect(select)) {
    if (item.kind === 'column') {
      if (item.name !== '*' && !memberColumns().has(item.name.toLowerCase())) return missingColumn(item.name)
    } else if (AUTH_TARGETS.has(item.target)) {
      return missingRelationship(item.target)
    } else {
      const nested = embedsError(item.inner)
      if (nested) return nested
    }
  }
  return null
}

/** PostgREST's answer to the member embeds inside another table's select. */
export function embedsError(select: string): PostgrestError | null {
  for (const item of parseSelect(select)) {
    if (item.kind !== 'embed') continue
    const error = MEMBER_TARGETS.has(item.target) ? memberSelectError(item.inner) : embedsError(item.inner)
    if (error) return error
  }
  return null
}

/** The columns an `.or()` expression filters on. */
export function orColumns(expression: string): string[] {
  return splitTopLevel(expression).flatMap((part) => {
    const nested = part.match(/^(?:not\.)?(?:and|or)\(([\s\S]*)\)$/)
    return nested ? orColumns(nested[1]) : [part.split('.')[0]]
  })
}

/** The columns a builder call names, other than through `select`. */
export function namedColumns(method: string, args: unknown[]): string[] {
  const [first, second] = args
  if (method === 'or') {
    const options = second as { referencedTable?: string; foreignTable?: string } | undefined
    return options?.referencedTable || options?.foreignTable ? [] : orColumns(String(first ?? ''))
  }
  if (method === 'match') return Object.keys((first ?? {}) as object)
  if (method === 'order') {
    const options = second as { referencedTable?: string; foreignTable?: string } | undefined
    return options?.referencedTable || options?.foreignTable ? [] : [String(first)]
  }
  if (FILTER_METHODS.has(method)) return typeof first === 'string' ? [first] : []
  if (WRITE_METHODS.has(method)) {
    const rows = Array.isArray(first) ? first : [first]
    return rows.flatMap((row) => (row && typeof row === 'object' ? Object.keys(row) : []))
  }
  return []
}

interface QueryState {
  /** Aliases (or table names) of the member embeds this query selected. */
  memberEmbeds: Set<string>
}

function queryError(table: string, method: string, args: unknown[], state: QueryState): PostgrestError | null {
  if (method === 'select') {
    const select = typeof args[0] === 'string' ? args[0] : '*'
    for (const item of parseSelect(select)) {
      if (item.kind === 'embed' && MEMBER_TARGETS.has(item.target)) state.memberEmbeds.add(item.alias ?? item.target)
    }
    return table === MEMBER ? memberSelectError(select) : embedsError(select)
  }
  for (const named of namedColumns(method, args)) {
    const column = named.split('->')[0].trim()
    const dot = column.indexOf('.')
    if (dot === -1) {
      if (table === MEMBER && !memberColumns().has(column.toLowerCase())) return missingColumn(column)
    } else if (state.memberEmbeds.has(column.slice(0, dot))) {
      const inner = column.slice(dot + 1)
      if (!inner.includes('.') && !memberColumns().has(inner.toLowerCase())) return missingColumn(inner)
    }
  }
  return null
}

/** A query PostgREST refused: every further call chains, and awaiting it
 *  gives the error. */
export function refused(error: PostgrestError): unknown {
  const settled = Promise.resolve({ data: null, error, count: null, status: 400, statusText: 'Bad Request' })
  const chain: unknown = new Proxy(settled, {
    get(target, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target)
      }
      return () => chain
    },
  })
  return chain
}

function guardQuery(table: string, builder: unknown, state: QueryState): unknown {
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
        const error = queryError(table, prop, args, state)
        if (error) return refused(error)
        return guardQuery(table, (value as (...a: unknown[]) => unknown).apply(target, args), state)
      }
    },
  })
}

/**
 * Wrap a Supabase double so its `member` queries fail the way PostgREST's do
 * (see the file comment). Everything else (`auth`, `rpc`, other tables' rows)
 * passes through to the double untouched.
 */
export function withMemberSchema<C extends object>(client: C): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'from' || typeof value !== 'function') return value
      return (table: string, ...rest: unknown[]) =>
        guardQuery(String(table), (value as (...a: unknown[]) => unknown).call(target, table, ...rest), {
          memberEmbeds: new Set(),
        })
    },
  })
}
