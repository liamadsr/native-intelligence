/**
 * A stateful in-memory `tracked_job` double for the ledger tests.
 *
 * Honors the chain shapes the recorder, queries and reaper issue — insert +
 * select('*').maybeSingle(), CAS updates fenced by `.eq('status')` /
 * `.in('status', …)`, `.neq`, `.is` / `.not(col, 'is', null)` (on a jsonb
 * `col->>key` path too), `.filter(col, 'eq', v)`, `.gte` / `.lt` / `.lte`
 * range filters, `.order` / `.limit`, and the head-count select — so the
 * lifecycle transitions and their idempotency are meaningful rather than
 * mocked away. `.ilike(col, '%text%')`, jsonb `.neq(col, '[]')`, and `.or()` with eq,
 * neq, is.null, gt, gte, in, not.in, ilike and not.ilike alternatives are honoured too
 * (the light read's done rows and AI limit; the bell's orphaned bots), as are
 * `.not(col, 'in', '(a,b)')` and a select's `alias:col->>key` (projected as
 * Postgres reads it). A filter on an embedded column (`embed.col`, as on an
 * `embed!inner(...)` select) reads the embed the test seeded on the row. The unique (kind, run_key) index is
 * simulated so the idempotent-start path is exercised for real.
 *
 * Other tables (agent_run for the reaper's guard) are plain row lists. The
 * optional `opts` (step 3: the start helper and the auto-attempt gate) add
 * per-table column defaults and UNIQUE columns (a duplicate is a 23505), a
 * one-shot insert failure, deletes, `rpc` stubs and a log of every read/write.
 *
 * `upsert(row, { onConflict, ignoreDuplicates })` (the chat message writer)
 * honors the conflict columns as a unique index; `chat_messages.ui_message_id`
 * is derived from `ui_message.id` the way the stored generated column is
 * (migration 173).
 *
 * `project: true` returns only the columns a select names, as PostgREST does,
 * so a read that leaves out a column its caller needs fails here too (bots-v4
 * B1: the editor read a persona without `workspace_id`, and every agent read
 * as an anchor). Off by default: older tests select less than they read.
 */
export type Row = Record<string, unknown>

export interface FakeCall {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  filters: Array<[string, unknown]>
  /**
   * The columns a select named (absent for a write, or a select that named
   * none). Not enumerable, so tests that compare whole calls with toEqual
   * don't see it.
   */
  columns?: string
}

export type FakeRpcError = { code?: string; message: string }

export interface FakeSupabaseOptions {
  /** Column defaults applied on insert (the DB's `default`), per table. */
  defaults?: Record<string, Row>
  /** Columns that must be unique (NULLs never collide), per table. */
  unique?: Record<string, string[]>
  /** rpc(fn, args) stubs. An unstubbed rpc returns an error. */
  rpc?: Record<string, (args: Record<string, unknown>) => { data: unknown; error: FakeRpcError | null }>
  /** Return only the columns a select names, as PostgREST does (see the module note). */
  project?: boolean
}

export interface FakeSupabase {
  from: (table: string) => Record<string, unknown>
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: FakeRpcError | null }>
  rows: (table: string) => Row[]
  seed: (table: string, rows: Row[]) => void
  /** Fail the next insert into `table` with `error` (once). */
  failNextInsert: (table: string, error: { code?: string; message: string }) => void
  /** Every from() terminal, in order. */
  calls: FakeCall[]
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  /** What each select() asked for, as written (whole rows come back unless `project` is on). */
  selects: Array<{ table: string; columns: string }>
}

/** A select's top-level items: `a, b, alias:fk(c, d)` → ['a', 'b', 'alias:fk(c, d)']. */
function selectItems(columns: string): string[] {
  const items: string[] = []
  let depth = 0
  let current = ''
  for (const ch of columns) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) items.push(current.trim())
  return items
}

/**
 * `row` as PostgREST returns it for `columns`: only the named columns (an
 * `alias:column` under its alias, a `::cast` dropped), an embed
 * (`alias:fk(...)`, `table(...)`) kept whole under its name when the row
 * carries one. `*` returns the whole row. A named column the row lacks is left
 * out (the double has no schema to refuse it with).
 */
function projectRow(row: Row, columns: string): Row {
  const items = selectItems(columns)
  if (items.includes('*')) return { ...row }
  const out: Row = {}
  for (const item of items) {
    const paren = item.indexOf('(')
    const head = (paren >= 0 ? item.slice(0, paren) : item).split('::')[0].trim()
    // An unaliased embed comes back under its table's name, its `!hint` dropped (`ai_team_member!inner(...)` → `ai_team_member`).
    const [alias, source] = head.includes(':') ? head.split(':').map((s) => s.trim()) : [head.split('!')[0], head]
    const column = source.split('!')[0]
    // A jsonb path (`alias:col->>key`): its text, as Postgres reads it.
    if (column.includes('->>')) out[alias] = colValue(row, column)
    else if (alias in row) out[alias] = row[alias]
    else if (column in row) out[alias] = row[column]
  }
  return out
}

/**
 * `replace_ai_member_skills(p_member_id, p_skill_ids)` (migration 305) on a
 * fake's rows, for `opts.rpc`: the bot's whole list replaced, each skill once
 * in its first place, at most five (23514), the bot present (P0002), each a
 * skill recipe of the bot's workspace or a system one (23503). `fail` refuses
 * the write for the bots it names.
 */
export function replaceAiMemberSkillsRpc(db: () => FakeSupabase, opts: { fail?: (memberId: string) => boolean } = {}) {
  return (args: Record<string, unknown>): { data: unknown; error: FakeRpcError | null } => {
    const memberId = args.p_member_id as string
    const ids = [...new Set(((args.p_skill_ids as string[] | null) ?? []).filter(Boolean))]
    if (opts.fail?.(memberId)) return { data: null, error: { code: 'XX000', message: `skills write failed for ${memberId}` } }
    if (ids.length > 5) return { data: null, error: { code: '23514', message: `a bot always checks at most five skills (got ${ids.length})` } }
    const bot = db().rows('ai_team_member').find((m) => m.id === memberId)
    if (!bot) return { data: null, error: { code: 'P0002', message: `ai_team_member ${memberId} not found` } }
    const recipes = db().rows('recipe')
    const inScope = (id: string) =>
      recipes.some((r) => r.id === id && r.category === 'skill' && (r.is_system === true || r.workspace_id === bot.workspace_id))
    if (!ids.every(inScope)) {
      return { data: null, error: { code: '23503', message: 'every id must be a skill of the bot’s workspace, or a system skill' } }
    }
    const rows = db().rows('ai_team_member_skill')
    const others = rows.filter((r) => r.ai_team_member_id !== memberId)
    rows.splice(0, rows.length, ...others, ...ids.map((id, i) => ({ ai_team_member_id: memberId, skill_recipe_id: id, sort_order: i })))
    return { data: null, error: null }
  }
}

/** Postgres jsonb containment (`@>`): every element of an array needle matches
 *  some element of the haystack; every key of an object needle matches. */
function jsonContains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(needle)) {
    return Array.isArray(haystack) && needle.every((n) => haystack.some((h) => jsonContains(h, n)))
  }
  if (needle && typeof needle === 'object') {
    if (!haystack || typeof haystack !== 'object' || Array.isArray(haystack)) return false
    return Object.entries(needle as Record<string, unknown>).every(([k, v]) =>
      jsonContains((haystack as Record<string, unknown>)[k], v),
    )
  }
  return haystack === needle
}

/** A filter column's value: a plain column, or a jsonb path ending in `->>key`
 *  (`col->>key`, `col->a->>key`: text, as Postgres returns it: a string as-is,
 *  anything else JSON-encoded, null for a missing key). */
function colValue(r: Row, k: string): unknown {
  // An embedded resource's column (`embed.col`, a filter on `embed!inner(...)`):
  // the test seeds the embed on the row, as PostgREST returns it.
  if (!k.includes('->>') && k.includes('.') && !(k in r)) {
    const [embed, col] = [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)]
    const nested = r[embed]
    return nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Row)[col] : undefined
  }
  if (!k.includes('->>')) return r[k]
  const [path, key] = k.split('->>')
  const [col, ...hops] = path.split('->')
  let obj: unknown = r[col]
  for (const hop of hops) obj = obj && typeof obj === 'object' ? (obj as Row)[hop] : null
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Row)[key]
  if (v === undefined || v === null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** A PostgREST list, `(a,b,c)`, as its values. */
function inList(v: string): string[] {
  // PostgREST takes a list value bare or double-quoted ("a,b" / "a","b").
  return v.replace(/^\(/, '').replace(/\)$/, '').split(',').map((x) => x.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
}

/** An `or` filter's alternatives: split at its top-level commas (a list's own stay inside it). */
function topLevel(filter: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of filter) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/** An ILIKE pattern as a regex: `%` any run of characters, `_` one, case-insensitive. */
function likeRegex(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`, 'is')
}

/**
 * Whether a cell equals a filter's value. A jsonb cell (an array or object)
 * against a string is compared as JSON, as Postgres casts the literal
 * (`.neq('deliverables', '[]')`); everything else by identity.
 */
function cellEquals(cell: unknown, v: unknown): boolean {
  if (cell !== null && typeof cell === 'object' && typeof v === 'string') {
    try {
      return JSON.stringify(cell) === JSON.stringify(JSON.parse(v))
    } catch {
      return false
    }
  }
  return cell === v
}

/**
 * One `.or()` filter as a row predicate: any alternative matches. An
 * alternative is `col.op.value` (eq, neq, is.null, gt, gte, in, not.in,
 * not.ilike) or a group, `and(a,b)` / `or(a,b)`.
 */
function orPredicate(filter: string): (r: Row) => boolean {
  const alts = topLevel(filter).map(altPredicate)
  return (r) => alts.some((p) => p(r))
}

function altPredicate(alt: string): (r: Row) => boolean {
  const group = /^(and|or)\(([\s\S]*)\)$/.exec(alt.trim())
  if (group) {
    const parts = topLevel(group[2]).map(altPredicate)
    return group[1] === 'and' ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r))
  }
  const [k, opName0, ...rest] = alt.split('.')
  let opName = opName0
  let v = rest.join('.')
  // `col.not.ilike.*text*`: PostgREST's `*` is SQL's `%`.
  if (opName === 'not' && v.startsWith('ilike.')) {
    opName = 'not.ilike'
    v = v.slice('ilike.'.length).replace(/\*/g, '%')
  } else if (opName === 'not' && v.startsWith('in.')) {
    // `col.in.(a,b)` / `col.not.in.(a,b)`.
    opName = 'not.in'
    v = v.slice('in.'.length)
  } else if (opName === 'ilike') {
    // `col.ilike.%text%` (the mail search).
    v = v.replace(/\*/g, '%')
  }
  const known = ['eq', 'neq', 'gt', 'gte', 'in', 'not.in', 'ilike', 'not.ilike'].includes(opName) || (opName === 'is' && v === 'null')
  if (!known) throw new Error(`fake or(): only eq, neq, is.null, gt, gte, in, not.in, ilike, not.ilike and and()/or() groups are supported (${alt})`)
  return (r) => {
    const cell = colValue(r, k)
    if (opName === 'is') return cell === null || cell === undefined
    if (opName === 'gt') return typeof cell === 'string' && cell > v
    if (opName === 'gte') return typeof cell === 'string' && cell >= v
    // A NULL is neither equal nor unequal, nor like anything (Postgres).
    if (opName === 'neq') return cell !== null && cell !== undefined && String(cell) !== v
    if (opName === 'not.ilike') return typeof cell === 'string' && !likeRegex(v).test(cell)
    if (opName === 'ilike') return typeof cell === 'string' && likeRegex(v).test(cell)
    if (opName === 'in') return cell !== null && cell !== undefined && inList(v).includes(String(cell))
    if (opName === 'not.in') return cell !== null && cell !== undefined && !inList(v).includes(String(cell))
    return String(cell) === v
  }
}

/** Stored generated columns, derived on write. */
function withGenerated(table: string, row: Row): Row {
  if (table === 'chat_messages') {
    const id = (row.ui_message as { id?: unknown } | null | undefined)?.id
    return { ...row, ui_message_id: typeof id === 'string' ? id : null }
  }
  return row
}

export function makeFakeSupabase(opts: FakeSupabaseOptions = {}): FakeSupabase {
  const tables = new Map<string, Row[]>()
  let seq = 0
  const calls: FakeCall[] = []
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const selects: Array<{ table: string; columns: string }> = []
  const insertFailures = new Map<string, { code?: string; message: string }>()
  const rowsOf = (table: string) => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)!
  }

  function builder(table: string) {
    const rows = rowsOf(table)
    const eqs: Array<[string, unknown]> = []
    const neqs: Array<[string, unknown]> = []
    const ins: Array<[string, unknown[]]> = []
    const gtes: Array<[string, string]> = []
    const lts: Array<[string, string]> = []
    const ltes: Array<[string, string]> = []
    const gts: Array<[string, string]> = []
    const conts: Array<[string, unknown]> = []
    const overlapsF: Array<[string, unknown[]]> = []
    const iss: Array<[string, unknown]> = []
    const nots: Array<[string, unknown]> = []
    // `.not(col, 'in', '(a,b)')`: a value not in the list (a NULL never passes, as in Postgres).
    const notIns: Array<[string, string[]]> = []
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let insertRow: Row | null = null
    let insertRows: Row[] | null = null
    let patch: Row | null = null
    const orders: Array<{ col: string; asc: boolean }> = []
    let limit: number | null = null
    let offset = 0
    // `.or('a.eq.x,b.is.null,c.gt.v')`: any one alternative matches (eq, is.null, gt, gte).
    const ors: Array<(r: Row) => boolean> = []
    // `.or(filter, { referencedTable })` and `.is('embed.col', …)` on an array
    // embed: they filter the embedded rows; an `alias:table!inner(...)` embed
    // left with none drops its parent, as PostgREST's inner embed does.
    const embedOrs = new Map<string, Array<(r: Row) => boolean>>()
    // `.ilike(col, '%text%')`: a case-insensitive match, `%` any run of characters, `_` one.
    const ilikes: Array<[string, RegExp]> = []
    let head = false
    // `select(cols, { count: 'exact' })`: the matching rows' total, before any page cut.
    let wantCount = false
    // The columns the last select() named, for `project`.
    let selected: string | null = null
    const shape = (r: Row): Row => (opts.project && selected !== null ? projectRow(r, selected) : { ...r })

    const match = (r: Row) =>
      eqs.every(([k, v]) => colValue(r, k) === v) &&
      neqs.every(([k, v]) => !cellEquals(colValue(r, k), v)) &&
      ins.every(([k, vs]) => vs.includes(colValue(r, k))) &&
      gtes.every(([k, v]) => typeof r[k] === 'string' && (r[k] as string) >= v) &&
      lts.every(([k, v]) => typeof r[k] === 'string' && (r[k] as string) < v) &&
      ltes.every(([k, v]) => typeof r[k] === 'string' && (r[k] as string) <= v) &&
      gts.every(([k, v]) => typeof r[k] === 'string' && (r[k] as string) > v) &&
      conts.every(([k, v]) => jsonContains(r[k], v)) &&
      // text[] `&&`: the array column shares a value with the list.
      overlapsF.every(([k, vs]) => Array.isArray(r[k]) && (r[k] as unknown[]).some((x) => vs.includes(x))) &&
      iss.every(([k, v]) => {
        const cell = colValue(r, k)
        return v === null ? cell === null || cell === undefined : cell === v
      }) &&
      nots.every(([k]) => {
        const cell = colValue(r, k)
        return cell !== null && cell !== undefined
      }) &&
      notIns.every(([k, list]) => {
        const cell = colValue(r, k)
        return cell !== null && cell !== undefined && !list.includes(String(cell))
      }) &&
      ilikes.every(([k, re]) => typeof r[k] === 'string' && re.test(r[k] as string)) &&
      ors.every((pred) => pred(r))

    /** A row with its array embeds filtered (embedOrs, `.is('embed.col', …)`); null when an inner embed is left empty. */
    const withEmbedsFiltered = (r: Row): Row | null => {
      const embeds = new Set<string>([...embedOrs.keys(), ...iss.filter(([k]) => k.includes('.') && Array.isArray(r[k.split('.')[0]])).map(([k]) => k.split('.')[0])])
      if (embeds.size === 0) return r
      const out: Row = { ...r }
      for (const embed of embeds) {
        const items = Array.isArray(r[embed]) ? (r[embed] as Row[]) : []
        const kept = items.filter(
          (item) =>
            (embedOrs.get(embed) ?? []).every((pred) => pred(item)) &&
            iss
              .filter(([k]) => k.startsWith(`${embed}.`))
              .every(([k, v]) => {
                const cell = item[k.slice(embed.length + 1)]
                return v === null ? cell === null || cell === undefined : cell === v
              }),
        )
        const inner = selected !== null && new RegExp(`(^|[\\s,])${embed}:[a-z_]+!inner\\(`).test(selected)
        if (inner && kept.length === 0) return null
        out[embed] = kept
      }
      return out
    }

    const api: Record<string, unknown> = {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) head = true
        if (opts?.count) wantCount = true
        if (cols !== undefined) {
          selects.push({ table, columns: cols })
          selected = cols
        }
        return api
      },
      insert: (row: Row | Row[]) => {
        op = 'insert'
        const stamp = (r: Row): Row => {
          seq += 1
          return {
            // uuid-shaped, so writers that validate ids (the touch writer) accept them.
            id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
            created_at: new Date(Date.now() + seq).toISOString(),
            ...(opts.defaults?.[table] ?? {}),
            ...r,
          }
        }
        // A bulk insert (the touch writer) lands every row; a single row keeps
        // the unique / idempotent-start checks below.
        if (Array.isArray(row)) insertRows = row.map(stamp)
        else insertRow = stamp(row)
        return api
      },
      delete: () => {
        op = 'delete'
        return api
      },
      upsert: (row: Row, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) => {
        op = 'upsert'
        upsertOpts = o
        seq += 1
        insertRow = withGenerated(table, {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          created_at: new Date(Date.now() + seq).toISOString(),
          ...(opts.defaults?.[table] ?? {}),
          ...row,
        })
        return api
      },
      is: (k: string, v: unknown) => {
        iss.push([k, v])
        return api
      },
      // `.not(col, 'is', null)`: the column holds a value; `.not(col, 'in', '(a,b)')`: one not listed.
      not: (k: string, opName: string, v: unknown) => {
        if (opName === 'in' && typeof v === 'string') {
          notIns.push([k, inList(v)])
          return api
        }
        if (opName !== 'is' || v !== null) throw new Error(`fake not(): only 'is', null and 'in' are supported (${k} ${opName})`)
        nots.push([k, v])
        return api
      },
      update: (p: Row) => {
        op = 'update'
        patch = p
        return api
      },
      eq: (k: string, v: unknown) => {
        eqs.push([k, v])
        return api
      },
      // `.filter(col, 'eq', v)` (a jsonb path too: the live nudge reads filter
      // on `ui_message->metadata->>kind`). Only 'eq' is supported.
      filter: (k: string, opName: string, v: unknown) => {
        if (opName !== 'eq') throw new Error(`fake filter(): only 'eq' is supported (${k} ${opName})`)
        eqs.push([k, v])
        return api
      },
      // `.neq('is_eval', true)` — the eval fence on capture reads; an unset
      // column passes, as a NULL does in Postgres for `is distinct from`.
      neq: (k: string, v: unknown) => {
        neqs.push([k, v])
        return api
      },
      in: (k: string, vs: unknown[]) => {
        ins.push([k, vs])
        return api
      },
      gte: (k: string, v: string) => {
        gtes.push([k, v])
        return api
      },
      lt: (k: string, v: string) => {
        lts.push([k, v])
        return api
      },
      lte: (k: string, v: string) => {
        ltes.push([k, v])
        return api
      },
      gt: (k: string, v: string) => {
        gts.push([k, v])
        return api
      },
      overlaps: (k: string, vs: unknown[]) => {
        overlapsF.push([k, vs])
        return api
      },
      // jsonb `@>` — the resolve helper's "rows whose deliverables include this ref".
      contains: (k: string, v: unknown) => {
        conts.push([k, typeof v === 'string' ? JSON.parse(v) : v])
        return api
      },
      // Several .order() calls sort by each in turn, the first primary (as Postgres).
      // An order or limit on an embed (`referencedTable`) shapes the embed, not
      // the rows: the double keeps embeds whole, so it leaves the rows alone.
      order: (c: string, opts?: { ascending?: boolean; referencedTable?: string }) => {
        if (!opts?.referencedTable) orders.push({ col: c, asc: opts?.ascending ?? true })
        return api
      },
      limit: (n: number, opts?: { referencedTable?: string }) => {
        if (!opts?.referencedTable) limit = n
        return api
      },
      range: (from: number, to: number) => {
        offset = from
        limit = to - from + 1
        return api
      },
      or: (filter: string, orOpts?: { referencedTable?: string }) => {
        const pred = orPredicate(filter)
        if (orOpts?.referencedTable) {
          const list = embedOrs.get(orOpts.referencedTable) ?? []
          list.push(pred)
          embedOrs.set(orOpts.referencedTable, list)
        } else ors.push(pred)
        return api
      },
      ilike: (k: string, pattern: string) => {
        ilikes.push([k, likeRegex(pattern)])
        return api
      },
      maybeSingle: async () => {
        const r = term()
        if (Array.isArray(r.data)) return { ...r, data: r.data[0] ?? null }
        return r
      },
      single: async () => term(),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(term()).then(resolve, reject),
    }

    function term(): { data: unknown; error: { code?: string; message: string } | null; count?: number } {
      const call: FakeCall = { table, op: op === 'upsert' ? 'insert' : op, filters: [...eqs, ...ins.map(([k, v]) => [k, v] as [string, unknown])] }
      if (op === 'select' && selected !== null) Object.defineProperty(call, 'columns', { value: selected, enumerable: false })
      calls.push(call)
      if (op === 'upsert') {
        const row = insertRow as Row
        const failure = insertFailures.get(table)
        if (failure) {
          insertFailures.delete(table)
          return { data: null, error: failure }
        }
        const cols = (upsertOpts.onConflict ?? 'id').split(',').map((c) => c.trim())
        const existing = rows.find((r) => cols.every((c) => r[c] != null && r[c] === row[c]))
        if (existing) {
          if (upsertOpts.ignoreDuplicates) return { data: [], error: null }
          Object.assign(existing, row, { id: existing.id, created_at: existing.created_at })
          return { data: [shape(existing)], error: null }
        }
        rows.push(row)
        return { data: [shape(row)], error: null }
      }
      if (op === 'insert' && insertRows) {
        const failure = insertFailures.get(table)
        if (failure) {
          insertFailures.delete(table)
          return { data: null, error: failure }
        }
        rows.push(...insertRows)
        return { data: insertRows.map(shape), error: null }
      }
      if (op === 'insert') {
        const row = insertRow as Row
        const failure = insertFailures.get(table)
        if (failure) {
          insertFailures.delete(table)
          return { data: null, error: failure }
        }
        for (const col of opts.unique?.[table] ?? []) {
          if (row[col] != null && rows.some((r) => r[col] === row[col])) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${col})` } }
          }
        }
        if (
          table === 'tracked_job' &&
          row.run_key &&
          rows.some((r) => r.kind === row.kind && r.run_key === row.run_key)
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          }
        }
        rows.push(row)
        return { data: shape(row), error: null }
      }
      if (op === 'update') {
        const targets = rows.filter(match)
        for (const t of targets) Object.assign(t, patch)
        return { data: targets.map((t) => (opts.project && selected !== null ? projectRow(t, selected) : { id: t.id })), error: null }
      }
      if (op === 'delete') {
        const keep = rows.filter((r) => !match(r))
        const removed = rows.filter(match)
        rows.splice(0, rows.length, ...keep)
        // delete().select(): the deleted rows' ids, as PostgREST returns them.
        return { data: selected !== null ? removed.map((r) => ({ id: r.id })) : null, error: null }
      }
      let out = rows.map(withEmbedsFiltered).filter((r): r is Row => r !== null).filter(match)
      if (orders.length > 0) {
        out = [...out].sort((a, b) => {
          for (const { col, asc } of orders) {
            const av = a[col] ?? ''
            const bv = b[col] ?? ''
            const cmp =
              typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0
            if (cmp !== 0) return asc ? cmp : -cmp
          }
          return 0
        })
      }
      const total = out.length
      if (offset > 0) out = out.slice(offset)
      if (limit !== null) out = out.slice(0, limit)
      if (head) return { data: null, error: null, count: out.length }
      return { data: out.map(shape), error: null, ...(wantCount ? { count: total } : {}) }
    }
    return api
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      const stub = opts.rpc?.[fn]
      return stub ? stub(args) : { data: null, error: { message: `no rpc stub for ${fn}` } }
    },
    rows: rowsOf,
    seed: (table: string, seeded: Row[]) => {
      rowsOf(table).push(...seeded)
    },
    failNextInsert: (table, error) => {
      insertFailures.set(table, error)
    },
    calls,
    rpcCalls,
    selects,
  }
}
