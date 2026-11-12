/**
 * The field types (Tables, phase 2): every type's check and stored form, a
 * definition's config, and a value read as text. Made-up values.
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_FIELD_TYPES,
  cleanFieldConfig,
  coerceCustomValue,
  formatFieldValue,
  parseCurrency,
  referencedIds,
  type CustomFieldType,
  type FieldShape,
} from '../custom-field-types'

const A = 'a0000000-0000-4000-8000-000000000001'
const B = 'b0000000-0000-4000-8000-000000000002'
const def = (field_type: CustomFieldType, extra: Partial<FieldShape> = {}): FieldShape => ({ label: 'Field', field_type, options: ['Gold', 'Silver'], ...extra })
const ok = (d: FieldShape, raw: unknown) => {
  const r = coerceCustomValue(d, raw)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const err = (d: FieldShape, raw: unknown) => {
  const r = coerceCustomValue(d, raw)
  return r.ok ? null : r.error
}

describe('every type clears on empty', () => {
  for (const t of CUSTOM_FIELD_TYPES) {
    it(t, () => {
      expect(ok(def(t, { config: t === 'relation' ? { target: { kind: 'contact' } } : {} }), null)).toBeNull()
      expect(ok(def(t), '')).toBeNull()
      expect(ok(def(t), [])).toBeNull()
    })
  }
})

describe('the four first types are unchanged', () => {
  it('text, number, date, select', () => {
    expect(ok(def('text'), '  hi ')).toBe('hi')
    expect(ok(def('number'), '1,200.5')).toBe(1200.5)
    expect(err(def('number'), '12k')).toBe('Field needs a number')
    expect(err(def('number'), true)).toBe('Field needs a number')
    expect(ok(def('date'), '2026-03-04')).toBe('2026-03-04')
    expect(err(def('date'), '2026-02-30')).toBe('Field needs a date as YYYY-MM-DD')
    expect(ok(def('select'), 'gold')).toBe('Gold')
    expect(err(def('text'), { a: 1 })).toBe('Field takes one value')
  })
})

describe('multi_select', () => {
  it('takes a list or a comma-separated string, in the options’ spelling, once each', () => {
    expect(ok(def('multi_select'), ['silver', 'Gold', 'gold'])).toEqual(['Silver', 'Gold'])
    expect(ok(def('multi_select'), 'gold, silver')).toEqual(['Gold', 'Silver'])
    expect(err(def('multi_select'), ['Bronze'])).toBe('Field takes options from: Gold, Silver')
    expect(err(def('multi_select'), [{}])).toBe('Field takes a list of options')
  })
})

describe('checkbox', () => {
  it('is true or false, from words people use', () => {
    expect(ok(def('checkbox'), true)).toBe(true)
    expect(ok(def('checkbox'), false)).toBe(false)
    expect(ok(def('checkbox'), 'Yes')).toBe(true)
    expect(ok(def('checkbox'), 'no')).toBe(false)
    expect(ok(def('checkbox'), 1)).toBe(true)
    expect(err(def('checkbox'), 'maybe')).toBe('Field is yes or no')
  })
})

describe('url, email, phone', () => {
  it('a web address gains its scheme; anything else is refused', () => {
    expect(ok(def('url'), 'acme.com/pricing')).toBe('https://acme.com/pricing')
    expect(ok(def('url'), 'http://acme.com')).toBe('http://acme.com')
    expect(err(def('url'), 'not a url')).toBe('Field needs a web address')
    expect(err(def('url'), 'ftp://acme.com')).toBe('Field needs a web address')
    expect(err(def('url'), 'localhost')).toBe('Field needs a web address')
  })
  it('an email lowercased; a phone number in E.164 where it can be', () => {
    expect(ok(def('email'), ' Jo@Acme.COM ')).toBe('jo@acme.com')
    expect(err(def('email'), 'jo@')).toBe('Field needs an email address')
    expect(ok(def('phone'), '(626) 555-0101')).toBe('+16265550101')
    expect(ok(def('phone'), '+44 20 7946 0958')).toBe('+442079460958')
    expect(err(def('phone'), '12')).toBe('Field needs a phone number')
  })
})

describe('person', () => {
  it('one member id (membership is the server’s check)', () => {
    expect(ok(def('person'), A.toUpperCase())).toBe(A)
    expect(ok(def('person'), { id: A })).toBe(A)
    expect(ok(def('person'), [A])).toBe(A)
    expect(err(def('person'), [A, B])).toBe('Field takes one workspace member')
    expect(err(def('person'), 'Juniper')).toBe('Field takes one workspace member')
  })
})

describe('currency', () => {
  const usd = def('currency', { config: { currency: 'USD' } })
  const eur = def('currency', { config: { currency: 'EUR' } })
  it('a bare amount takes the field’s currency; a named one keeps its own', () => {
    expect(ok(usd, 1200)).toEqual({ amount: 1200, currency: 'USD' })
    expect(ok(eur, '1,200.50')).toEqual({ amount: 1200.5, currency: 'EUR' })
    expect(ok(usd, '1200 eur')).toEqual({ amount: 1200, currency: 'EUR' })
    expect(ok(usd, '€12')).toEqual({ amount: 12, currency: 'EUR' })
    expect(ok(def('currency', { config: { currency: 'CAD' } }), '$40')).toEqual({ amount: 40, currency: 'CAD' })
    expect(ok(eur, '$40')).toEqual({ amount: 40, currency: 'USD' })
    expect(ok(usd, { amount: '5', currency: 'gbp' })).toEqual({ amount: 5, currency: 'GBP' })
  })
  it('refuses what isn’t an amount or a code', () => {
    expect(err(usd, 'lots')).toBe('Field needs an amount, like 1200 or 1200 EUR')
    expect(err(usd, { amount: 5, currency: 'XYZW' })).toBe("Field's currency is a three-letter code, like USD or EUR")
    expect(err(usd, { amount: 'x' })).toBe('Field needs an amount')
    expect(parseCurrency('12 ABC', 'USD')).toBeNull()
  })
})

describe('relation', () => {
  const one = def('relation', { config: { target: { kind: 'contact' } } })
  const many = def('relation', { config: { target: { kind: 'contact' }, multiple: true } })
  it('a list of ids, one unless the field takes several', () => {
    expect(ok(one, A)).toEqual([A])
    expect(ok(many, [A, B, A])).toEqual([A, B])
    expect(ok(many, `${A}, ${B}`)).toEqual([A, B])
    expect(ok(many, [{ id: A }])).toEqual([A])
    expect(err(one, [A, B])).toBe('Field links one record')
    expect(err(many, ['acme'])).toBe('Field takes record ids')
  })
})

describe('cleanFieldConfig', () => {
  it('a currency takes its code (USD when none); a relation needs its target', () => {
    expect(cleanFieldConfig('currency', {})).toEqual({ ok: true, config: { currency: 'USD' } })
    expect(cleanFieldConfig('currency', { currency: 'eur' })).toEqual({ ok: true, config: { currency: 'EUR' } })
    expect(cleanFieldConfig('currency', { currency: 'EURO' }).ok).toBe(false)
    expect(cleanFieldConfig('relation', {}).ok).toBe(false)
    expect(cleanFieldConfig('relation', { target: { kind: 'claim' } }).ok).toBe(false)
    expect(cleanFieldConfig('relation', { target: { kind: 'data_row' } }).ok).toBe(false)
    expect(cleanFieldConfig('relation', { target: { kind: 'data_row', table_id: A.toUpperCase() }, multiple: true })).toEqual({
      ok: true,
      config: { target: { kind: 'data_row', table_id: A }, multiple: true },
    })
    // What a type doesn't take is left out.
    expect(cleanFieldConfig('text', { currency: 'USD', target: { kind: 'contact' } })).toEqual({ ok: true, config: {} })
  })
  it('required_when is a table column’s only', () => {
    expect(cleanFieldConfig('number', { required_when: { key: 'stage', option: 'Won' } }).ok).toBe(false)
    expect(cleanFieldConfig('number', { required_when: { key: 'stage', option: 'Won' } }, { tableColumn: true })).toEqual({
      ok: true,
      config: { required_when: { key: 'stage', option: 'Won' } },
    })
  })
})

describe('formatFieldValue', () => {
  const now = new Date(2026, 5, 1)
  it('reads each type as text', () => {
    expect(formatFieldValue('number', 1234.567, { now })).toBe('1,234.57')
    expect(formatFieldValue('date', '2026-03-04', { now })).toBe('Mar 4')
    expect(formatFieldValue('date', '2025-03-04', { now })).toBe('Mar 4, 2025')
    expect(formatFieldValue('checkbox', true)).toBe('Yes')
    expect(formatFieldValue('checkbox', false)).toBe('No')
    expect(formatFieldValue('multi_select', ['Gold', 'Silver'])).toBe('Gold, Silver')
    expect(formatFieldValue('currency', { amount: 1200, currency: 'USD' })).toBe('$1,200.00')
    expect(formatFieldValue('url', 'https://acme.com')).toBe('https://acme.com')
  })
  it('names people and linked records only when told their names', () => {
    expect(formatFieldValue('person', A)).toBe('')
    expect(formatFieldValue('person', A, { labels: { [A]: 'Robin' } })).toBe('Robin')
    expect(formatFieldValue('relation', [A, B], { labels: new Map([[A, 'Acme']]) })).toBe('Acme')
    expect(referencedIds('relation', [A, 'x'])).toEqual([A])
    expect(referencedIds('person', A)).toEqual([A])
    expect(referencedIds('text', A)).toEqual([])
  })
  it('an empty value is empty', () => {
    expect(formatFieldValue('multi_select', [])).toBe('')
    expect(formatFieldValue('text', null)).toBe('')
  })
})
