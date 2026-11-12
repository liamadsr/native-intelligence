/**
 * Formula columns (Tables, phase 6): a small expression language, read by a
 * hand-written parser and run by a tree walker. Nothing is ever eval'd.
 *
 *   {Price} * {Qty}                     a column by its name, in braces
 *   if({Done}, "Shipped", "Open")       functions, by name
 *   days_between({Start}, today()) > 7  comparisons give a checkbox
 *
 * Literals: numbers (12, 0.5), text in double or single quotes, true, false.
 * Operators: + - * / and = != < <= > >= (also == and <>). + joins two texts,
 * and adds days to a date; a date minus a date is the days between.
 * Functions: if, and, or, not, concat, round, min, max, today, days_between,
 * empty (FORMULA_FUNCTIONS has each one's line of help).
 *
 * A formula is stored with its references as column keys, `{#key}` (the
 * row's own name is `{#_title}`), so renaming a column never breaks one; a
 * person reads and writes names (`toDisplayFormula`, `toStoredFormula`).
 *
 * Every result is one of four types (number, text, date, checkbox), known
 * before it runs (`checkFormula`). An empty value stays empty through
 * arithmetic. A value that can't be worked out (a division by zero) is that
 * cell's error, not the column's.
 *
 * Client-safe and pure: the server computes cells when rows are read
 * (./computed.ts), and the grid recomputes an edited row's the same way.
 */

export type FormulaType = 'number' | 'text' | 'date' | 'checkbox'
export const FORMULA_TYPES: readonly FormulaType[] = ['number', 'text', 'date', 'checkbox']

/** A reference to the row's own name (its title). */
export const TITLE_REF = '_title'
/** What the title is called in a formula a person reads. */
export const TITLE_REF_NAME = 'Name'

export const MAX_FORMULA_LENGTH = 2000
const MAX_DEPTH = 40
const MAX_NODES = 400

export type BinaryOp = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>='

export type FormulaNode =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; key: string; name: string }
  | { k: 'neg'; e: FormulaNode }
  | { k: 'bin'; op: BinaryOp; a: FormulaNode; b: FormulaNode }
  | { k: 'call'; fn: FormulaFunction; args: FormulaNode[] }

export const FORMULA_FUNCTIONS = {
  if: 'if(condition, then, else): one of two values.',
  and: 'and(a, b, …): every one is true.',
  or: 'or(a, b, …): at least one is true.',
  not: 'not(a): true when a is not.',
  concat: 'concat(a, b, …): the values as one text.',
  round: 'round(number, digits): rounded, to 0 digits unless given.',
  min: 'min(a, b, …): the smallest number or earliest date.',
  max: 'max(a, b, …): the largest number or latest date.',
  today: 'today(): the date today.',
  days_between: 'days_between(start, end): the days from start to end.',
  empty: 'empty(a): true when a has no value.',
} as const
export type FormulaFunction = keyof typeof FORMULA_FUNCTIONS
const isFunction = (name: string): name is FormulaFunction => Object.prototype.hasOwnProperty.call(FORMULA_FUNCTIONS, name)

type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

// ── Tokens ──────────────────────────────────────────────────────────────────

type Token =
  | { t: 'num'; v: number; at: number; end: number }
  | { t: 'str'; v: string; at: number; end: number }
  | { t: 'ref'; v: string; at: number; end: number }
  | { t: 'id'; v: string; at: number; end: number }
  | { t: 'op'; v: string; at: number; end: number }

const OPS = ['==', '!=', '<>', '<=', '>=', '+', '-', '*', '/', '=', '<', '>', '(', ')', ',']

function tokenize(src: string): { ok: true; tokens: Token[] } | Fail {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const at = i
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d{1,3})?/.exec(src.slice(i))!
      i += m[0].length
      tokens.push({ t: 'num', v: Number(m[0]), at, end: i })
      continue
    }
    if (ch === '"' || ch === "'") {
      let out = ''
      i++
      let closed = false
      while (i < src.length) {
        const c = src[i]
        if (c === '\\' && i + 1 < src.length) {
          out += src[i + 1]
          i += 2
          continue
        }
        if (c === ch) {
          closed = true
          i++
          break
        }
        out += c
        i++
      }
      if (!closed) return fail('A text is missing its closing quote.')
      tokens.push({ t: 'str', v: out, at, end: i })
      continue
    }
    if (ch === '{') {
      const close = src.indexOf('}', i + 1)
      if (close < 0) return fail('A column name is missing its closing }.')
      const name = src.slice(i + 1, close).trim()
      if (!name) return fail('{} names no column.')
      i = close + 1
      tokens.push({ t: 'ref', v: name, at, end: i })
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      i += m[0].length
      tokens.push({ t: 'id', v: m[0], at, end: i })
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) return fail(`"${ch}" can't be used here.`)
    i += op.length
    tokens.push({ t: 'op', v: op, at, end: i })
  }
  return { ok: true, tokens }
}

// ── References ──────────────────────────────────────────────────────────────

/** The columns a formula may name: their keys and names. */
export interface FormulaColumn {
  key: string
  label: string
}

/**
 * A reference's column key: `#key` as stored, else a column by its name (any
 * case), else the row's name. Null when it names nothing.
 */
export function resolveRef(name: string, columns: readonly FormulaColumn[]): string | null {
  if (name.startsWith('#')) {
    const key = name.slice(1)
    if (key === TITLE_REF || columns.some((c) => c.key === key)) return key
  }
  const lower = name.toLowerCase()
  const byLabel = columns.find((c) => c.label.trim().toLowerCase() === lower)
  if (byLabel) return byLabel.key
  if (lower === TITLE_REF_NAME.toLowerCase()) return TITLE_REF
  return null
}

/** The source with each reference rewritten (strings and the rest left exactly as typed). */
function rewriteRefs(src: string, fn: (name: string) => string | null): { ok: true; text: string } | Fail {
  const lexed = tokenize(src)
  if (!lexed.ok) return lexed
  let out = ''
  let last = 0
  for (const tok of lexed.tokens) {
    if (tok.t !== 'ref') continue
    const next = fn(tok.v)
    if (next === null) return fail(`No column named {${tok.v.replace(/^#/, '')}}.`)
    out += src.slice(last, tok.at) + `{${next}}`
    last = tok.end
  }
  return { ok: true, text: out + src.slice(last) }
}

/** A formula as stored: every reference a column key. */
export function toStoredFormula(src: string, columns: readonly FormulaColumn[]): { ok: true; text: string } | Fail {
  return rewriteRefs(src, (name) => {
    const key = resolveRef(name, columns)
    return key === null ? null : `#${key}`
  })
}

/** A stored formula as a person reads it: every reference a column's name (a deleted one keeps its key). */
export function toDisplayFormula(stored: string, columns: readonly FormulaColumn[]): string {
  const shown = rewriteRefs(stored, (name) => {
    if (!name.startsWith('#')) return name
    const key = name.slice(1)
    if (key === TITLE_REF) return TITLE_REF_NAME
    return columns.find((c) => c.key === key)?.label ?? key
  })
  return shown.ok ? shown.text : stored
}

// ── Parse ───────────────────────────────────────────────────────────────────

export type Parsed = { ok: true; ast: FormulaNode; refs: string[] } | Fail

/**
 * A formula read into its tree. References resolve by `resolveRef` against
 * `columns`; one that names nothing is an error.
 */
export function parseFormula(src: string, columns: readonly FormulaColumn[]): Parsed {
  if (typeof src !== 'string' || !src.trim()) return fail('A formula needs an expression.')
  if (src.length > MAX_FORMULA_LENGTH) return fail(`A formula is at most ${MAX_FORMULA_LENGTH} characters.`)
  const lexed = tokenize(src)
  if (!lexed.ok) return lexed
  const tokens = lexed.tokens
  let pos = 0
  let nodes = 0
  const refs = new Set<string>()
  const peek = () => tokens[pos]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v
  class ParseError extends Error {}
  const stop = (msg: string): never => {
    throw new ParseError(msg)
  }
  const node = <N extends FormulaNode>(n: N): N => {
    if (++nodes > MAX_NODES) stop('That formula is too long.')
    return n
  }

  const expr = (depth: number): FormulaNode => {
    if (depth > MAX_DEPTH) stop('That formula nests too deep.')
    return comparison(depth)
  }
  const comparison = (depth: number): FormulaNode => {
    const a = additive(depth)
    const t = peek()
    if (t?.t === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
      pos++
      const op = (t.v === '==' ? '=' : t.v === '<>' ? '!=' : t.v) as BinaryOp
      const b = additive(depth)
      const next = peek()
      if (next?.t === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(next.v)) stop('Compare two values at a time: use and() to join comparisons.')
      return node({ k: 'bin', op, a, b })
    }
    return a
  }
  const additive = (depth: number): FormulaNode => {
    let a = multiplicative(depth)
    while (isOp('+') || isOp('-')) {
      const op = peek()!.v as BinaryOp
      pos++
      a = node({ k: 'bin', op, a, b: multiplicative(depth) })
    }
    return a
  }
  const multiplicative = (depth: number): FormulaNode => {
    let a = unary(depth)
    while (isOp('*') || isOp('/')) {
      const op = peek()!.v as BinaryOp
      pos++
      a = node({ k: 'bin', op, a, b: unary(depth) })
    }
    return a
  }
  const unary = (depth: number): FormulaNode => {
    if (isOp('-')) {
      pos++
      return node({ k: 'neg', e: unary(depth + 1) })
    }
    if (isOp('+')) {
      pos++
      return unary(depth + 1)
    }
    return primary(depth)
  }
  const primary = (depth: number): FormulaNode => {
    const t = peek()
    if (!t) return stop('The formula ends too soon.')
    pos++
    switch (t.t) {
      case 'num':
        return node({ k: 'num', v: t.v })
      case 'str':
        return node({ k: 'str', v: t.v })
      case 'ref': {
        const key = resolveRef(t.v, columns)
        if (key === null) return stop(`No column named {${t.v.replace(/^#/, '')}}.`)
        refs.add(key)
        const name = key === TITLE_REF ? TITLE_REF_NAME : columns.find((c) => c.key === key)?.label ?? key
        return node({ k: 'ref', key, name })
      }
      case 'id': {
        const lower = t.v.toLowerCase()
        if (lower === 'true' || lower === 'false') return node({ k: 'bool', v: lower === 'true' })
        if (!isOp('(')) {
          return stop(isFunction(lower) ? `${lower} needs brackets: ${lower}(…).` : `Put a column's name in braces: {${t.v}}.`)
        }
        if (!isFunction(lower)) return stop(`There is no function called ${t.v}.`)
        pos++
        const args: FormulaNode[] = []
        if (!isOp(')')) {
          for (;;) {
            args.push(expr(depth + 1))
            if (isOp(',')) {
              pos++
              continue
            }
            break
          }
        }
        if (!isOp(')')) return stop(`${lower}( is missing its closing bracket.`)
        pos++
        return node({ k: 'call', fn: lower, args })
      }
      case 'op':
        if (t.v === '(') {
          const inner = expr(depth + 1)
          if (!isOp(')')) return stop('A bracket is missing its closing ).')
          pos++
          return inner
        }
        return stop(`"${t.v}" can't be used here.`)
    }
  }

  try {
    const ast = expr(0)
    if (pos < tokens.length) {
      const t = tokens[pos]
      return fail(t.t === 'op' && t.v === ')' ? 'There is a ) with no ( before it.' : 'Two values sit side by side: join them with an operator or a comma.')
    }
    return { ok: true, ast, refs: [...refs] }
  } catch (e) {
    if (e instanceof ParseError) return fail(e.message)
    throw e
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

/** A type, or `unknown` (a rollup whose target the check can't see): it fits anywhere. */
export type CheckType = FormulaType | 'unknown'

const TYPE_WORD: Record<FormulaType, string> = { number: 'a number', text: 'a text', date: 'a date', checkbox: 'a checkbox' }
const word = (t: CheckType) => (t === 'unknown' ? 'a value' : TYPE_WORD[t])

/**
 * The type a formula's result has, given each reference's type (or why a
 * reference can't be used). Fails with the first mismatch, in words.
 */
export function checkFormula(ast: FormulaNode, refType: (key: string, name: string) => CheckType | { error: string }): { ok: true; type: CheckType } | Fail {
  class TypeErr extends Error {}
  const stop = (msg: string): never => {
    throw new TypeErr(msg)
  }
  const fits = (t: CheckType, want: FormulaType) => t === 'unknown' || t === want
  const need = (t: CheckType, want: FormulaType, what: string) => {
    if (!fits(t, want)) stop(`${what} needs ${TYPE_WORD[want]}, not ${word(t)}.`)
  }
  const same = (ts: CheckType[]): CheckType => ts.find((t) => t !== 'unknown') ?? 'unknown'

  const walk = (n: FormulaNode): CheckType => {
    switch (n.k) {
      case 'num':
        return 'number'
      case 'str':
        return 'text'
      case 'bool':
        return 'checkbox'
      case 'ref': {
        const t = refType(n.key, n.name)
        if (typeof t === 'object') return stop(t.error)
        return t
      }
      case 'neg': {
        need(walk(n.e), 'number', 'A minus sign')
        return 'number'
      }
      case 'bin': {
        const a = walk(n.a)
        const b = walk(n.b)
        switch (n.op) {
          case '+':
            if (a === 'unknown' || b === 'unknown') return a === 'date' || b === 'date' ? 'date' : same([a, b])
            if (a === 'number' && b === 'number') return 'number'
            if ((a === 'date' && b === 'number') || (a === 'number' && b === 'date')) return 'date'
            if (a === 'text' && b === 'text') return 'text'
            return stop(`Can't add ${word(a)} and ${word(b)}. To join values as text, use concat().`)
          case '-':
            if (a === 'unknown' || b === 'unknown') return a === 'date' && b === 'number' ? 'date' : a === 'date' && b === 'date' ? 'number' : a === 'date' ? 'unknown' : 'number'
            if (a === 'number' && b === 'number') return 'number'
            if (a === 'date' && b === 'number') return 'date'
            if (a === 'date' && b === 'date') return 'number'
            return stop(`Can't take ${word(b)} from ${word(a)}.`)
          case '*':
          case '/':
            need(a, 'number', n.op === '*' ? 'Multiplying' : 'Dividing')
            need(b, 'number', n.op === '*' ? 'Multiplying' : 'Dividing')
            return 'number'
          default: {
            if (a !== 'unknown' && b !== 'unknown' && a !== b) return stop(`Can't compare ${word(a)} with ${word(b)}.`)
            if ((n.op === '<' || n.op === '<=' || n.op === '>' || n.op === '>=') && same([a, b]) === 'checkbox') return stop("Checkboxes can't be ordered: compare them with = or !=.")
            return 'checkbox'
          }
        }
      }
      case 'call': {
        const args = n.args.map(walk)
        const count = (min: number, max: number) => {
          if (args.length < min || args.length > max) {
            stop(min === max ? `${n.fn}() takes ${min === 0 ? 'nothing' : min === 1 ? 'one value' : `${min} values`}.` : max === Infinity ? `${n.fn}() takes at least ${min === 1 ? 'one value' : `${min} values`}.` : `${n.fn}() takes ${min} or ${max} values.`)
          }
        }
        switch (n.fn) {
          case 'if': {
            count(2, 3)
            need(args[0], 'checkbox', 'if()’s condition')
            if (args.length === 3 && args[1] !== 'unknown' && args[2] !== 'unknown' && args[1] !== args[2]) {
              return stop(`if() gives ${word(args[1])} one way and ${word(args[2])} the other: make both the same.`)
            }
            return same(args.slice(1))
          }
          case 'and':
          case 'or':
            count(1, Infinity)
            args.forEach((t) => need(t, 'checkbox', `${n.fn}()`))
            return 'checkbox'
          case 'not':
            count(1, 1)
            need(args[0], 'checkbox', 'not()')
            return 'checkbox'
          case 'concat':
            count(1, Infinity)
            return 'text'
          case 'round':
            count(1, 2)
            need(args[0], 'number', 'round()')
            if (args[1]) need(args[1], 'number', 'round()’s digits')
            return 'number'
          case 'min':
          case 'max': {
            count(1, Infinity)
            const t = same(args)
            if (t !== 'unknown' && t !== 'number' && t !== 'date') stop(`${n.fn}() takes numbers or dates.`)
            if (args.some((x) => x !== 'unknown' && x !== t)) stop(`${n.fn}() takes values of one type.`)
            return t
          }
          case 'today':
            count(0, 0)
            return 'date'
          case 'days_between':
            count(2, 2)
            need(args[0], 'date', 'days_between()')
            need(args[1], 'date', 'days_between()')
            return 'number'
          case 'empty':
            count(1, 1)
            return 'checkbox'
        }
      }
    }
  }
  try {
    return { ok: true, type: walk(ast) }
  } catch (e) {
    if (e instanceof TypeErr) return fail(e.message)
    throw e
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

/** A value while a formula runs: its type, and its value (a date as YYYY-MM-DD). */
export type FormulaValue = { t: FormulaType; v: number | string | boolean } | null

export type FormulaResult = { ok: true; value: FormulaValue } | Fail

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS
const isoOfDay = (day: number) => new Date(Math.round(day) * DAY_MS).toISOString().slice(0, 10)

/** A value as text, the way concat() writes it. */
export function formulaText(value: FormulaValue): string {
  if (!value) return ''
  if (value.t === 'checkbox') return value.v ? 'Yes' : 'No'
  if (value.t === 'number') return numberText(value.v as number)
  return String(value.v)
}

function numberText(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(Number(n.toFixed(10)))
}

/**
 * Runs a parsed formula on one row. `ref` gives a referenced column's value,
 * already typed (an empty value is null; an unset checkbox is false).
 * `today` is the reader's date.
 */
export function runFormula(ast: FormulaNode, ref: (key: string) => FormulaValue | { error: string }, opts: { today: string }): FormulaResult {
  class RunErr extends Error {}
  const stop = (msg: string): never => {
    throw new RunErr(msg)
  }
  const num = (v: number): FormulaValue => {
    if (!Number.isFinite(v)) stop('The result is not a number.')
    return { t: 'number', v }
  }
  const truthy = (v: FormulaValue) => v !== null && v.t === 'checkbox' && v.v === true

  const compare = (a: FormulaValue, b: FormulaValue): number => {
    if (a!.t === 'number') return (a!.v as number) - (b!.v as number)
    if (a!.t === 'checkbox') return Number(a!.v) - Number(b!.v)
    const x = String(a!.v)
    const y = String(b!.v)
    return x < y ? -1 : x > y ? 1 : 0
  }

  const walk = (n: FormulaNode): FormulaValue => {
    switch (n.k) {
      case 'num':
        return { t: 'number', v: n.v }
      case 'str':
        return { t: 'text', v: n.v }
      case 'bool':
        return { t: 'checkbox', v: n.v }
      case 'ref': {
        const v = ref(n.key)
        if (v && 'error' in v) return stop(`{${n.name}} has an error.`)
        return v as FormulaValue
      }
      case 'neg': {
        const v = walk(n.e)
        return v === null ? null : num(-(v.v as number))
      }
      case 'bin': {
        const a = walk(n.a)
        const b = walk(n.b)
        if (n.op === '=' || n.op === '!=') {
          const eq = a === null || b === null ? a === b : a.t === b.t && compare(a, b) === 0
          return { t: 'checkbox', v: n.op === '=' ? eq : !eq }
        }
        if (n.op === '<' || n.op === '<=' || n.op === '>' || n.op === '>=') {
          if (a === null || b === null) return null
          if (a.t !== b.t) stop(`Can't compare ${TYPE_WORD[a.t]} with ${TYPE_WORD[b.t]}.`)
          const c = compare(a, b)
          return { t: 'checkbox', v: n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0 }
        }
        if (a === null || b === null) return null
        switch (n.op) {
          case '+':
            if (a.t === 'number' && b.t === 'number') return num((a.v as number) + (b.v as number))
            if (a.t === 'date' && b.t === 'number') return { t: 'date', v: isoOfDay(dayNumber(a.v as string) + (b.v as number)) }
            if (a.t === 'number' && b.t === 'date') return { t: 'date', v: isoOfDay(dayNumber(b.v as string) + (a.v as number)) }
            if (a.t === 'text' && b.t === 'text') return { t: 'text', v: `${a.v}${b.v}` }
            return stop(`Can't add ${TYPE_WORD[a.t]} and ${TYPE_WORD[b.t]}.`)
          case '-':
            if (a.t === 'number' && b.t === 'number') return num((a.v as number) - (b.v as number))
            if (a.t === 'date' && b.t === 'number') return { t: 'date', v: isoOfDay(dayNumber(a.v as string) - (b.v as number)) }
            if (a.t === 'date' && b.t === 'date') return num(Math.round(dayNumber(a.v as string) - dayNumber(b.v as string)))
            return stop(`Can't take ${TYPE_WORD[b.t]} from ${TYPE_WORD[a.t]}.`)
          case '*':
          case '/':
            if (a.t !== 'number' || b.t !== 'number') return stop(`${n.op === '*' ? 'Multiplying' : 'Dividing'} needs numbers.`)
            if (n.op === '/' && b.v === 0) return stop('Division by zero.')
            return num(n.op === '*' ? (a.v as number) * (b.v as number) : (a.v as number) / (b.v as number))
        }
        return null
      }
      case 'call': {
        switch (n.fn) {
          case 'if': {
            // Only the branch taken runs: the other may divide by zero.
            const c = walk(n.args[0])
            if (truthy(c)) return walk(n.args[1])
            return n.args[2] ? walk(n.args[2]) : null
          }
          case 'and': {
            for (const a of n.args) if (!truthy(walk(a))) return { t: 'checkbox', v: false }
            return { t: 'checkbox', v: true }
          }
          case 'or': {
            for (const a of n.args) if (truthy(walk(a))) return { t: 'checkbox', v: true }
            return { t: 'checkbox', v: false }
          }
          case 'not':
            return { t: 'checkbox', v: !truthy(walk(n.args[0])) }
          case 'concat':
            return { t: 'text', v: n.args.map((a) => formulaText(walk(a))).join('') }
          case 'round': {
            const v = walk(n.args[0])
            if (v === null) return null
            const d = n.args[1] ? walk(n.args[1]) : null
            const digits = Math.max(0, Math.min(10, Math.trunc(d && d.t === 'number' ? (d.v as number) : 0)))
            const f = 10 ** digits
            // Half away from zero, on the decimal the person sees (2.345 is 2.35, not 2.34).
            const x = v.v as number
            return num((Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(15)))) / f)
          }
          case 'min':
          case 'max': {
            const vals = n.args.map(walk).filter((v): v is NonNullable<FormulaValue> => v !== null)
            if (!vals.length) return null
            return vals.reduce((best, v) => {
              if (v.t !== best.t) stop(`${n.fn}() takes values of one type.`)
              const c = compare(v, best)
              return (n.fn === 'min' ? c < 0 : c > 0) ? v : best
            })
          }
          case 'today':
            return { t: 'date', v: opts.today }
          case 'days_between': {
            const a = walk(n.args[0])
            const b = walk(n.args[1])
            if (a === null || b === null) return null
            return num(Math.round(dayNumber(b.v as string) - dayNumber(a.v as string)))
          }
          case 'empty': {
            const v = walk(n.args[0])
            return { t: 'checkbox', v: v === null || (v.t === 'text' && v.v === '') }
          }
        }
      }
    }
    return null
  }
  try {
    const value = walk(ast)
    if (value?.t === 'text' && (value.v as string).length > 2000) return { ok: true, value: { t: 'text', v: (value.v as string).slice(0, 2000) } }
    if (value?.t === 'date' && !ISO_DATE.test(String(value.v))) return fail('That date is out of range.')
    return { ok: true, value }
  } catch (e) {
    if (e instanceof RunErr) return fail(e.message)
    if (e instanceof RangeError) return fail('That date is out of range.')
    throw e
  }
}
