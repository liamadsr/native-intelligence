/**
 * Tripwire (security review 2026-10-31): the provider OAuth token columns
 * (user_oauth_tokens.access_token / refresh_token) are encrypted at rest
 * (token-crypto.ts), so only the modules that decrypt and encrypt them may
 * touch them. A new reader that selects the column itself would hand a
 * ciphertext to GitHub as a bearer token (or, worse, a writer would store a
 * token in plaintext again).
 *
 * WHAT IS ENFORCED, per non-test source file under src/, agents/, scripts/,
 * supabase/functions/ and packages/, parsed with the TypeScript compiler (so
 * comments never count):
 *   1. A `.from('user_oauth_tokens')` chain that selects `*` (or calls
 *      `select()` with no columns, which is `*`), `access_token`,
 *      `refresh_token`, or columns that are not a string literal, or filters or
 *      orders on a token column, is only in TOKEN_READERS.
 *   2. Its insert / update / upsert is only in TOKEN_WRITERS.
 *   3. A chain that ends without saying what it does (`const q =
 *      supabase.from('user_oauth_tokens')`, carried on elsewhere) is only in
 *      the allowlisted files: what it reads can't be seen.
 *   4. Outside the allowlisted files, the table's name appears only as that
 *      `.from(...)` argument: no alias (`const T = 'user_oauth_tokens'`), no
 *      embedded resource (`select('*, user_oauth_tokens(access_token)')`).
 *
 * A new reader of a GitHub token calls github-token.ts; anything else goes
 * through token-manager.ts. Adding a file here is a security decision.
 *
 * And in the database: `anon` and `authenticated` cannot SELECT the token
 * columns (migration 466) or write the table at all (469), so only the
 * service role reads the tokens and only the service role writes rows. The
 * last block below holds 466 and 469 to that and refuses a later migration
 * that hands either role the columns back (a table-level SELECT or ALL
 * included) or any write privilege on the table.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { migrationsInOrder } from '@/test/migration-sql'

const ROOT = process.cwd()
const SCAN_ROOTS = ['src', 'agents', 'scripts', 'supabase/functions', 'packages']
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const TABLE = 'user_oauth_tokens'

/** The modules that may read a token column: they decrypt what they read. */
const TOKEN_READERS = new Set([
  'src/lib/oauth/token-manager.ts',
  'src/lib/oauth/github-token.ts',
  'src/lib/oauth/token-backfill.ts',
])
/** The modules that may write the table: they encrypt what they write. */
const TOKEN_WRITERS = new Set([
  'src/lib/oauth/token-manager.ts',
  'src/lib/oauth/complete-connect.ts',
  'src/lib/oauth/token-backfill.ts',
])
const ALLOWLISTED = new Set([...TOKEN_READERS, ...TOKEN_WRITERS])

const TOKEN_COLUMNS = /\*|\baccess_token\b|\brefresh_token\b/
const WRITE_METHODS = new Set(['insert', 'update', 'upsert'])
const OPERATION_METHODS = new Set(['select', 'insert', 'update', 'upsert', 'delete'])

function stringValue(node: ts.Node | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/** The `.from('user_oauth_tokens')` call a string literal is the argument of, if it is. */
function fromCallOf(literal: ts.Node): ts.CallExpression | null {
  const call = literal.parent
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== literal) return null
  const callee = call.expression
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'from' ? call : null
}

/** The method calls chained onto a call: `.select(...)`, `.eq(...)`, … in order. */
function chainAfter(call: ts.CallExpression): Array<{ name: string; args: readonly ts.Expression[] }> {
  const out: Array<{ name: string; args: readonly ts.Expression[] }> = []
  let node: ts.Node = call
  for (;;) {
    const access = node.parent
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== node) return out
    const next = access.parent
    if (!next || !ts.isCallExpression(next) || next.expression !== access) return out
    out.push({ name: access.name.text, args: next.arguments })
    node = next
  }
}

/** Every rule this file breaks, as `file:line: why`. */
function violations(file: string, source: string): string[] {
  if (!source.includes(TABLE)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const at = (node: ts.Node, why: string) =>
    out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${why}`)

  const visit = (node: ts.Node) => {
    const text = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : stringValue(node)
    if (text !== null && text.includes(TABLE)) {
      const from = text === TABLE ? fromCallOf(node) : null
      if (!from) {
        if (!ALLOWLISTED.has(file)) at(node, `names ${TABLE} other than as a .from() argument`)
      } else {
        const chain = chainAfter(from)
        if (!chain.some((c) => OPERATION_METHODS.has(c.name)) && !ALLOWLISTED.has(file)) {
          at(node, `a ${TABLE} query whose operation is out of sight`)
        }
        for (const c of chain) {
          if (c.name === 'select') {
            const columns = c.args.length === 0 ? '*' : stringValue(c.args[0])
            if ((columns === null || TOKEN_COLUMNS.test(columns)) && !TOKEN_READERS.has(file)) {
              at(node, `selects a token column (${columns ?? 'non-literal columns'}) outside the token readers`)
            }
          } else if (WRITE_METHODS.has(c.name)) {
            if (!TOKEN_WRITERS.has(file)) at(node, `writes ${TABLE} (.${c.name}) outside the token writers`)
          } else {
            const column = stringValue(c.args[0])
            if (column !== null && TOKEN_COLUMNS.test(column) && !TOKEN_READERS.has(file)) {
              at(node, `.${c.name}('${column}') uses a token column outside the token readers`)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function sources(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(full)
  }
  return out
}

const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/')
const files = SCAN_ROOTS.flatMap((d) => sources(join(ROOT, d))).map((abs) => ({ file: rel(abs), source: readFileSync(abs, 'utf8') }))

describe('token-column tripwire', () => {
  it('no file outside the token readers and writers touches a token column', () => {
    const found = files.flatMap(({ file, source }) => violations(file, source))
    expect(found).toEqual([])
  })

  it('sees the queries it guards (the allowlisted readers do select token columns)', () => {
    const seen = (file: string) => {
      const source = files.find((f) => f.file === file)?.source ?? ''
      // Scanned as if it were any other file, its token reads are caught.
      return violations('src/not-allowlisted.ts', source).length
    }
    expect(seen('src/lib/oauth/token-manager.ts')).toBeGreaterThan(0)
    expect(seen('src/lib/oauth/github-token.ts')).toBeGreaterThan(0)
    expect(seen('src/lib/oauth/token-backfill.ts')).toBeGreaterThan(0)
    expect(seen('src/lib/oauth/complete-connect.ts')).toBeGreaterThan(0)
  })

  it.each([
    [`db.from('user_oauth_tokens').select('access_token').eq('user_id', u)`, /selects a token column/],
    [`db.from('user_oauth_tokens').select('id, refresh_token')`, /selects a token column/],
    [`db.from('user_oauth_tokens').select('*')`, /selects a token column/],
    [`db.from('user_oauth_tokens').select()`, /selects a token column/],
    [`db.from('user_oauth_tokens').select(cols)`, /non-literal columns/],
    [`db.from(\`user_oauth_tokens\`).select('access_token')`, /selects a token column/],
    [`db.from('user_oauth_tokens').select('id').eq('access_token', t)`, /uses a token column/],
    [`db.from('user_oauth_tokens').update({ access_token: t }).eq('id', i)`, /writes user_oauth_tokens/],
    [`db.from('user_oauth_tokens').insert(row)`, /writes user_oauth_tokens/],
    [`const q = db.from('user_oauth_tokens')`, /out of sight/],
    [`const T = 'user_oauth_tokens'`, /other than as a .from\(\) argument/],
    [`db.from('connected_account').select('id, user_oauth_tokens(access_token)')`, /other than as a .from\(\) argument/],
  ])('catches %s', (code, why) => {
    const found = violations('src/lib/somewhere.ts', code)
    expect(found.join('\n')).toMatch(why)
  })

  it.each([
    `db.from('user_oauth_tokens').select('id').eq('user_id', u).limit(1)`,
    `db.from('user_oauth_tokens').select('account_id, scopes, updated_at').eq('user_id', u)`,
    `db.from('user_oauth_tokens').select('user_id').eq('provider', 'google')`,
    `// db.from('user_oauth_tokens').select('access_token')`,
  ])('lets a query of the other columns through: %s', (code) => {
    expect(violations('src/lib/somewhere.ts', code)).toEqual([])
  })
})

describe('token-column tripwire: the database (migrations 466, 469)', () => {
  /** SQL with its line comments dropped and its whitespace collapsed, lower-cased. */
  const flat = (sql: string) =>
    sql
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  const migrations = migrationsInOrder()
  const m466 = migrations.find((m) => m.file === '466_revoke_oauth_token_select.sql')
  const body466 = flat(m466?.sql ?? '')

  it('466 takes SELECT from anon and authenticated and grants back every column but the tokens, in one transaction', () => {
    expect(m466).toBeDefined()
    expect(body466.startsWith('begin;')).toBe(true)
    expect(body466.endsWith('commit;')).toBe(true)
    expect(body466).toContain("set local lock_timeout = '5s';")
    expect(body466).toContain('revoke all on table public.user_oauth_tokens from anon;')
    expect(body466).toContain('revoke select on table public.user_oauth_tokens from authenticated;')
    expect(body466).toContain('revoke select (access_token, refresh_token) on table public.user_oauth_tokens from anon, authenticated;')
    expect(body466).toContain("a.attname not in ('access_token', 'refresh_token')")
    expect(body466).toContain("execute format('grant select (%s) on table public.user_oauth_tokens to authenticated', cols);")
    expect(body466).toContain('grant all on table public.user_oauth_tokens to service_role;')
    // Re-runnable: guarded on the table, and nothing in it fails on a second run.
    expect(body466).toContain("if to_regclass('public.user_oauth_tokens') is null then")
  })

  /** A GRANT on user_oauth_tokens to anon/authenticated that reaches a token column. */
  function tokenGrants(sql: string): string[] {
    const out: string[] = []
    for (const stmt of flat(sql).split(';')) {
      const m = stmt.match(/grant (.+?) on (?:table )?(?:public\.)?"?user_oauth_tokens"? to (.+)$/)
      if (!m || !/\b(anon|authenticated|public)\b/.test(m[2])) continue
      const privs = m[1]
      const tableWide = /^(all( privileges)?|select)\b(?! ?\()/.test(privs) || /(^|, ?)(all( privileges)?|select)(,|$)/.test(privs)
      if (tableWide || /\b(access_token|refresh_token)\b/.test(privs)) out.push(stmt.trim())
    }
    return out
  }

  it('no migration from 466 on gives anon or authenticated a token column back', () => {
    const later = migrations.filter((m) => m.num >= 466)
    expect(later.length).toBeGreaterThan(0)
    const found = later.flatMap((m) => tokenGrants(m.sql).map((g) => `${m.file}: ${g}`))
    expect(found).toEqual([])
  })

  const m469 = migrations.find((m) => m.file === '469_revoke_oauth_token_writes.sql')
  const body469 = flat(m469?.sql ?? '')

  it('469 takes every write privilege on the table from anon and authenticated, in one transaction', () => {
    expect(m469).toBeDefined()
    expect(body469.startsWith('begin;')).toBe(true)
    expect(body469.endsWith('commit;')).toBe(true)
    expect(body469).toContain("set local lock_timeout = '5s';")
    expect(body469).toContain("if to_regclass('public.user_oauth_tokens') is null then")
    expect(body469).toContain('revoke all on table public.user_oauth_tokens from anon;')
    expect(body469).toContain('revoke insert, update, delete, truncate, references, trigger on table public.user_oauth_tokens from authenticated;')
    expect(body469).toContain("execute 'revoke maintain on table public.user_oauth_tokens from anon, authenticated';")
    expect(body469).toContain(
      "'revoke insert (%1$s), update (%1$s), references (%1$s) on table public.user_oauth_tokens from anon, authenticated',",
    )
    expect(body469).toContain('grant all on table public.user_oauth_tokens to service_role;')
    // It grants the client roles nothing.
    expect(writeGrants(m469?.sql ?? '')).toEqual([])
    expect(tokenGrants(m469?.sql ?? '')).toEqual([])
  })

  const WRITE_PRIVS = /\b(all|insert|update|delete|truncate|references|trigger|maintain)\b/

  /** A GRANT on user_oauth_tokens to anon/authenticated/public of any write privilege. */
  function writeGrants(sql: string): string[] {
    const out: string[] = []
    for (const stmt of flat(sql).split(';')) {
      const m = stmt.match(/grant (.+?) on (?:table )?(?:public\.)?"?user_oauth_tokens"? to (.+)$/)
      if (m && /\b(anon|authenticated|public)\b/.test(m[2]) && WRITE_PRIVS.test(m[1])) out.push(stmt.trim())
    }
    return out
  }

  it('no migration from 469 on gives anon or authenticated a write on the table back', () => {
    const later = migrations.filter((m) => m.num >= 469)
    expect(later.length).toBeGreaterThan(0)
    const found = later.flatMap((m) => writeGrants(m.sql).map((g) => `${m.file}: ${g}`))
    expect(found).toEqual([])
  })

  it.each([
    'grant insert on table public.user_oauth_tokens to authenticated;',
    'GRANT UPDATE (access_token, account_id) ON public.user_oauth_tokens TO authenticated;',
    'grant select, delete on user_oauth_tokens to anon;',
    'grant all privileges on table public.user_oauth_tokens to authenticated;',
  ])('the write-grant check catches %s', (sql) => {
    expect(writeGrants(sql)).toHaveLength(1)
  })

  it.each([
    'grant all on table public.user_oauth_tokens to service_role;',
    'grant select (id, user_id, account_id) on table public.user_oauth_tokens to authenticated;',
  ])('the write-grant check lets %s through', (sql) => {
    expect(writeGrants(sql)).toEqual([])
  })

  it.each([
    'grant select on table public.user_oauth_tokens to authenticated;',
    'GRANT ALL ON public.user_oauth_tokens TO anon, authenticated;',
    'grant select (id, access_token) on table public.user_oauth_tokens to authenticated;',
    'grant insert, select on user_oauth_tokens to authenticated;',
  ])('the grant check catches %s', (sql) => {
    expect(tokenGrants(sql)).toHaveLength(1)
  })

  it.each([
    'grant select (id, user_id, account_id) on table public.user_oauth_tokens to authenticated;',
    'grant all on table public.user_oauth_tokens to service_role;',
    "execute format('grant select (%s) on table public.user_oauth_tokens to authenticated', cols);",
  ])('the grant check lets %s through', (sql) => {
    expect(tokenGrants(sql)).toEqual([])
  })
})
