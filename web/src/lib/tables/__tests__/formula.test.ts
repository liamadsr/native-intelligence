import { describe, expect, it } from 'vitest'
import { checkFormula, parseFormula, runFormula, toDisplayFormula, toStoredFormula, TITLE_REF, type FormulaValue } from '../formula'

const columns = [
  { key: 'price', label: 'Price' },
  { key: 'qty', label: 'Qty' },
  { key: 'due', label: 'Due date' },
  { key: 'done', label: 'Done' },
  { key: 'notes', label: 'Notes' },
]
const types: Record<string, 'number' | 'text' | 'date' | 'checkbox'> = { price: 'number', qty: 'number', due: 'date', done: 'checkbox', notes: 'text', [TITLE_REF]: 'text' }

function run(src: string, values: Record<string, FormulaValue> = {}, today = '2026-11-11') {
  const p = parseFormula(src, columns)
  if (!p.ok) return { parseError: p.error }
  const t = checkFormula(p.ast, (k) => types[k] ?? { error: 'nope' })
  if (!t.ok) return { typeError: t.error }
  const r = runFormula(p.ast, (k) => values[k] ?? null, { today })
  return r.ok ? { type: t.type, value: r.value } : { type: t.type, error: r.error }
}

const n = (v: number): FormulaValue => ({ t: 'number', v })
const s = (v: string): FormulaValue => ({ t: 'text', v })
const d = (v: string): FormulaValue => ({ t: 'date', v })
const b = (v: boolean): FormulaValue => ({ t: 'checkbox', v })

describe('formula: parse', () => {
  it('reads arithmetic with the usual precedence', () => {
    expect(run('1 + 2 * 3')).toEqual({ type: 'number', value: n(7) })
    expect(run('(1 + 2) * 3')).toEqual({ type: 'number', value: n(9) })
    expect(run('-2 * -3')).toEqual({ type: 'number', value: n(6) })
    expect(run('10 / 4')).toEqual({ type: 'number', value: n(2.5) })
  })

  it('names columns by name, any case, and the row by Name', () => {
    expect(run('{price} * {QTY}', { price: n(2.5), qty: n(4) })).toEqual({ type: 'number', value: n(10) })
    expect(run('concat({Name}, "!")', { [TITLE_REF]: s('Oak table') })).toEqual({ type: 'text', value: s('Oak table!') })
  })

  it('says what is wrong, in words', () => {
    expect(run('{Nope} + 1')).toEqual({ parseError: 'No column named {Nope}.' })
    expect(run('Price * 2')).toEqual({ parseError: "Put a column's name in braces: {Price}." })
    expect(run('sqrt(4)')).toEqual({ parseError: 'There is no function called sqrt.' })
    expect(run('(1 + 2')).toEqual({ parseError: 'A bracket is missing its closing ).' })
    expect(run('1 2')).toEqual({ parseError: 'Two values sit side by side: join them with an operator or a comma.' })
    expect(run('"open')).toEqual({ parseError: 'A text is missing its closing quote.' })
    expect(run('')).toEqual({ parseError: 'A formula needs an expression.' })
    expect(run('1 < 2 < 3')).toEqual({ parseError: 'Compare two values at a time: use and() to join comparisons.' })
    expect(run('today')).toEqual({ parseError: 'today needs brackets: today(…).' })
  })

  it('never evaluates code: a string stays a string', () => {
    expect(run('"process.exit(1)"')).toEqual({ type: 'text', value: s('process.exit(1)') })
    expect(run('constructor(1)')).toEqual({ parseError: 'There is no function called constructor.' })
  })

  it('refuses a formula past its limits', () => {
    expect(run('1+'.repeat(1200) + '1')).toEqual({ parseError: 'A formula is at most 2000 characters.' })
    expect(run('('.repeat(60) + '1' + ')'.repeat(60))).toEqual({ parseError: 'That formula nests too deep.' })
  })
})

describe('formula: types', () => {
  it('knows each result type before it runs', () => {
    expect(run('{Done}')).toMatchObject({ type: 'checkbox' })
    expect(run('{Due date} + 7')).toMatchObject({ type: 'date' })
    expect(run('{Due date} - today()')).toMatchObject({ type: 'number' })
    expect(run('{Price} > 10')).toMatchObject({ type: 'checkbox' })
    expect(run('if({Done}, "Shipped", "Open")')).toMatchObject({ type: 'text' })
  })

  it('refuses mismatched types', () => {
    expect(run('{Notes} * 2')).toEqual({ typeError: 'Multiplying needs a number, not a text.' })
    expect(run('{Notes} + 2')).toEqual({ typeError: "Can't add a text and a number. To join values as text, use concat()." })
    expect(run('if({Price}, 1, 2)')).toEqual({ typeError: 'if()’s condition needs a checkbox, not a number.' })
    expect(run('if({Done}, 1, "no")')).toEqual({ typeError: 'if() gives a number one way and a text the other: make both the same.' })
    expect(run('{Price} = "x"')).toEqual({ typeError: "Can't compare a number with a text." })
    expect(run('days_between({Price}, today())')).toEqual({ typeError: 'days_between() needs a date, not a number.' })
    expect(run('round()')).toEqual({ typeError: 'round() takes 1 or 2 values.' })
    expect(run('today(1)')).toEqual({ typeError: 'today() takes nothing.' })
  })
})

describe('formula: run', () => {
  it('runs every function', () => {
    expect(run('round(2.345, 2)').value).toEqual(n(2.35))
    expect(run('round(2.5)').value).toEqual(n(3))
    expect(run('min(3, 1, 2)').value).toEqual(n(1))
    expect(run('max({Due date}, today())', { due: d('2026-12-01') }).value).toEqual(d('2026-12-01'))
    expect(run('and(true, {Done})', { done: b(true) }).value).toEqual(b(true))
    expect(run('or(false, {Done})').value).toEqual(b(false))
    expect(run('not({Done})').value).toEqual(b(true))
    expect(run('concat("Qty ", {Qty}, " · ", {Done})', { qty: n(3), done: b(true) }).value).toEqual(s('Qty 3 · Yes'))
    expect(run('today()').value).toEqual(d('2026-11-11'))
    expect(run('days_between({Due date}, today())', { due: d('2026-11-01') }).value).toEqual(n(10))
    expect(run('empty({Notes})').value).toEqual(b(true))
    expect(run('empty({Notes})', { notes: s('hi') }).value).toEqual(b(false))
  })

  it('adds days to a date, and across a month', () => {
    expect(run('{Due date} + 30', { due: d('2026-11-11') }).value).toEqual(d('2026-12-11'))
    expect(run('{Due date} - 11', { due: d('2026-03-10') }).value).toEqual(d('2026-02-27'))
  })

  it('keeps empty values empty through arithmetic', () => {
    expect(run('{Price} * {Qty}', { price: n(3) }).value).toBeNull()
    expect(run('{Price} > 1').value).toBeNull()
    expect(run('{Price} = {Qty}').value).toEqual(b(true))
  })

  it('a division by zero is the cell’s error, and only the branch taken runs', () => {
    expect(run('{Price} / {Qty}', { price: n(1), qty: n(0) })).toEqual({ type: 'number', error: 'Division by zero.' })
    expect(run('if({Qty} = 0, 0, {Price} / {Qty})', { price: n(1), qty: n(0) }).value).toEqual(n(0))
  })

  it('a reference with an error passes it on', () => {
    const p = parseFormula('{Price} + 1', columns)
    if (!p.ok) throw new Error(p.error)
    expect(runFormula(p.ast, () => ({ error: 'x' }), { today: '2026-11-11' })).toEqual({ ok: false, error: '{Price} has an error.' })
  })
})

describe('formula: stored by key, shown by name', () => {
  it('stores references as keys and shows them as names', () => {
    const stored = toStoredFormula('{Price} * {qty} + 1', columns)
    expect(stored).toEqual({ ok: true, text: '{#price} * {#qty} + 1' })
    expect(toDisplayFormula('{#price} * {#qty} + 1', [{ key: 'price', label: 'Unit price' }, { key: 'qty', label: 'Qty' }])).toBe('{Unit price} * {Qty} + 1')
    expect(toStoredFormula('concat({Name}, "{Price}")', columns)).toEqual({ ok: true, text: 'concat({#_title}, "{Price}")' })
    expect(toDisplayFormula('{#_title}', columns)).toBe('{Name}')
  })

  it('a stored formula reads back the same, and a renamed column follows', () => {
    const stored = toStoredFormula('{Price} * 2', columns)
    if (!stored.ok) throw new Error(stored.error)
    const renamed = columns.map((c) => (c.key === 'price' ? { ...c, label: 'Cost' } : c))
    const p = parseFormula(stored.text, renamed)
    expect(p.ok && p.refs).toEqual(['price'])
  })

  it('refuses a reference to nothing', () => {
    expect(toStoredFormula('{Missing}', columns)).toEqual({ ok: false, error: 'No column named {Missing}.' })
  })
})
