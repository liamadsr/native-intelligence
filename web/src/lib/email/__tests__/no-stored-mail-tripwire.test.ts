/**
 * Tripwire (no stored mail, Liam 2026-10-15): Native Intelligence keeps no copy of the
 * person's mail. The ONE exception is the holding pattern (email_hold,
 * migration 343): a thread Native Intelligence drafted a reply to, until the person sends
 * or dismisses the draft (src/lib/email/hold.ts).
 *
 * WHAT IS ENFORCED, per non-test source file under src/, agents/, scripts/,
 * supabase/functions/ and packages/, parsed with the TypeScript compiler so a
 * comment can never read as code:
 *   1. No string names a stored-mail table or function that migration 344
 *      drops: email_message, email_attachment, email_compose,
 *      upsert_email_messages, search_email_messages, the search-vector trigger
 *      function, or email_draft.generation_prompt (the wrapped thread).
 *   2. No read or write of email_thread_index names a column 344 drops
 *      (subject, snippet, from_name, to_emails, cc_emails): a select string
 *      after .from('email_thread_index'), an embedded select of the index
 *      (`email_thread:email_thread_id(...)`), or an object written to it.
 *   3. Only src/lib/email/hold.ts writes email_hold (insert, update, upsert):
 *      the one writer of received mail text.
 *
 * PENDING_ELSEWHERE lists files another branch still rewrites; it is empty
 * since claude/mail-claims-leak (341/342) landed on main, and migration 344
 * must not run while it holds anything.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'

const ROOT = process.cwd()
const SCAN_DIRS = ['src', 'agents', 'scripts', 'supabase/functions', 'packages']

/** Tables and functions migration 344 drops, and the dropped draft column. */
const DROPPED_NAMES = [
  'email_message',
  'email_attachment',
  'email_compose',
  'upsert_email_messages',
  'search_email_messages',
  'email_message_search_vector_trigger',
  'generation_prompt',
]
/** email_thread_index columns migration 344 drops. */
const DROPPED_INDEX_COLUMNS = ['subject', 'snippet', 'from_name', 'to_emails', 'cc_emails']
/** The one writer of email_hold. */
const HOLD_WRITER = 'src/lib/email/hold.ts'

/** Files claude/mail-claims-leak rewrites (their email_message reads go there). */
const PENDING_ELSEWHERE = new Set<string>([])

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name === '__tests__' || name.startsWith('.')) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
    }
  }
  for (const d of SCAN_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d))
  return out
}

const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`)

interface Finding {
  file: string
  line: number
  what: string
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
  return null
}

/** The `.from('<table>')` a call chain hangs off, walking down the receiver. */
function tableOf(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr
  for (let i = 0; i < 40; i++) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from' && cur.arguments.length === 1) {
        const t = literalText(cur.arguments[0])
        if (t) return t
      }
      cur = ts.isPropertyAccessExpression(callee) ? callee.expression : callee
      continue
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression
      continue
    }
    return null
  }
  return null
}

function objectKeys(node: ts.Node): string[] {
  const keys: string[] = []
  const collect = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.push(p.name.text)
      }
    } else if (ts.isArrayLiteralExpression(n)) n.elements.forEach(collect)
  }
  collect(node)
  return keys
}

/** The rules over one file's source text. */
function scanSource(rel: string, code: string): Finding[] {
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const findings: Finding[] = []
  const at = (node: ts.Node, what: string) => findings.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what })

  const visit = (node: ts.Node) => {
    // Rule 1, for a column written as a key (`{ generation_prompt: ... }`).
    if (ts.isIdentifier(node) && node.text === 'generation_prompt' && !PENDING_ELSEWHERE.has(rel)) at(node, 'names generation_prompt')
    const lit = literalText(node)
    if (lit !== null) {
      // Rule 1: a dropped table or function, anywhere in a string.
      for (const name of DROPPED_NAMES) {
        if (word(name).test(lit) && !PENDING_ELSEWHERE.has(rel)) at(node, `names ${name}`)
      }
      // Rule 2b: an embedded select of the index naming a dropped column.
      for (const m of lit.matchAll(/(email_thread(?:_index)?)\s*:?\s*[a-z_]*\s*\(([^)]*)\)/g)) {
        for (const col of DROPPED_INDEX_COLUMNS) if (word(col).test(m[2])) at(node, `embeds email_thread_index.${col}`)
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const verb = node.expression.name.text
      if (['select', 'update', 'insert', 'upsert'].includes(verb)) {
        const table = tableOf(node.expression.expression)
        // Rule 2a: the index, read or written with a dropped column.
        if (table === 'email_thread_index' && node.arguments[0]) {
          const arg = node.arguments[0]
          const s = literalText(arg)
          const cols = verb === 'select' ? (s ? s.split(/[\s,()]+/) : []) : objectKeys(arg)
          for (const col of DROPPED_INDEX_COLUMNS) if (cols.includes(col)) at(node, `${verb}s email_thread_index.${col}`)
        }
        // Rule 3: only hold.ts writes received mail.
        if (table === 'email_hold' && verb !== 'select' && rel !== HOLD_WRITER) at(node, `${verb}s email_hold outside ${HOLD_WRITER}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

const scan = (file: string): Finding[] => scanSource(relative(ROOT, file), readFileSync(file, 'utf8'))

describe('no stored mail tripwire', () => {
  const files = sourceFiles()

  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => relative(ROOT, f) === HOLD_WRITER)).toBe(true)
  })

  it('no code names a stored-mail table, the dropped index columns, or writes a hold outside hold.ts', () => {
    const findings = files.flatMap(scan)
    expect(findings.map((f) => `${f.file}:${f.line} ${f.what}`)).toEqual([])
  }, 120_000)

  it('the pending list only names files that still need it (drop an entry once its branch lands)', () => {
    for (const rel of PENDING_ELSEWHERE) {
      const full = join(ROOT, rel)
      if (!existsSync(full)) continue
      const text = readFileSync(full, 'utf8')
      expect(DROPPED_NAMES.some((n) => word(n).test(text)), `${rel} no longer needs to be pending`).toBe(true)
    }
  })

  it('catches what it must (the rules fire on a planted sample)', () => {
    const code = [
      "db.from('email_message').select('*')",
      "db.from('email_thread_index').select('id, subject, from_email')",
      "db.from('email_thread_index').update({ snippet: 'x' })",
      "db.from('email_draft').select('*, email_thread:email_thread_id(subject, folder)')",
      "db.from('email_hold').insert({ subject: 's' })",
      "db.from('email_draft').insert({ generation_prompt: 'p' })",
      '// email_message in a comment is fine',
    ].join('\n')
    const findings = scanSource('src/lib/email/sample.ts', code)
    const whats = findings.map((f) => f.what)
    expect(whats).toEqual(expect.arrayContaining([
      'names email_message',
      'selects email_thread_index.subject',
      'updates email_thread_index.snippet',
      'embeds email_thread_index.subject',
      `inserts email_hold outside ${HOLD_WRITER}`,
      'names generation_prompt',
    ]))
    expect(findings.filter((f) => f.line === 7)).toEqual([])
  })
})
