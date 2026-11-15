/**
 * What a form takes and one submission read against it (../fields.ts): only
 * the form's own fields are read, each value fits its column or is refused,
 * and nothing a stranger posts picks a column, a member or a record.
 */
import { describe, expect, it } from 'vitest'
import type { DataColumn } from '@/lib/tables/types'
import { FORM_RESERVED_NAMES, parseSubmission, postedNameOf, readFormFields, validateFormFields } from '../fields'
import { FORM_LIMITS, FORM_TITLE_KEY, type FormField } from '../types'

const col = (key: string, label: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `col-${key}`,
  table_id: 't1',
  key,
  label,
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})

const COLUMNS: DataColumn[] = [
  col('email', 'Email', 'email'),
  col('phone', 'Phone', 'phone'),
  col('message', 'Message', 'text'),
  col('rugs', 'Rugs', 'number'),
  col('service', 'Service', 'select', { options: ['Cleaning', 'Repair'] }),
  col('pickup', 'Pickup date', 'date'),
  col('budget', 'Budget', 'currency', { config: { currency: 'USD' } }),
  col('newsletter', 'Newsletter', 'checkbox'),
  col('owner', 'Owner', 'person'),
  col('contact', 'Contact', 'relation', { config: { target: { kind: 'contact' } } }),
  col('total', 'Total', 'formula', { config: { expression: '{#rugs} * 2' } }),
  col('old', 'Old', 'text', { deleted_at: '2026-11-01T00:00:00Z' }),
]

const FIELDS: FormField[] = [
  { key: FORM_TITLE_KEY, label: 'Full name', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'message', label: 'About your rugs', required: false },
  { key: 'rugs', label: 'Rugs', required: false },
  { key: 'service', label: 'Service', required: false },
  { key: 'pickup', label: 'Pickup date', required: false },
  { key: 'budget', label: 'Budget', required: false },
  { key: 'newsletter', label: 'Newsletter', required: false },
]

const ok = (posted: unknown, fields = FIELDS) => {
  const r = parseSubmission(fields, COLUMNS, posted)
  if (!r.ok) throw new Error(`refused: ${r.error}`)
  return r.submission
}

describe('the fields a form is saved with', () => {
  it("takes the row's name and columns a stranger may fill, with the column's label when none is given", () => {
    const r = validateFormFields(COLUMNS, [{ key: FORM_TITLE_KEY, label: 'Full name', required: true }, { key: 'email' }, { key: 'service', label: '  What do you need?  ' }])
    expect(r).toEqual({
      ok: true,
      value: [
        { key: FORM_TITLE_KEY, label: 'Full name', required: true },
        { key: 'email', label: 'Email', required: false },
        { key: 'service', label: 'What do you need?', required: false },
      ],
    })
  })

  it.each(['owner', 'contact', 'total'])('refuses a %s column: a member, a record or a worked-out value is never a stranger\'s to set', (key) => {
    const r = validateFormFields(COLUMNS, [{ key }])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("can't be on a form")
  })

  it('refuses a column that is gone or was never there, a field listed twice, none, and too many', () => {
    expect(validateFormFields(COLUMNS, [{ key: 'old' }]).ok).toBe(false)
    expect(validateFormFields(COLUMNS, [{ key: 'nope' }]).ok).toBe(false)
    expect(validateFormFields(COLUMNS, [{ key: 'email' }, { key: 'email' }]).ok).toBe(false)
    expect(validateFormFields(COLUMNS, []).ok).toBe(false)
    expect(validateFormFields(COLUMNS, Array.from({ length: FORM_LIMITS.fields + 1 }, () => ({ key: 'email' }))).ok).toBe(false)
  })

  it('refuses two fields a post could not tell apart', () => {
    const r = validateFormFields(COLUMNS, [{ key: 'message', label: 'Phone' }, { key: 'phone' }])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('both be called "phone"')
  })

  it('reads stored fields back, dropping anything malformed', () => {
    expect(readFormFields([{ key: 'email', label: 'Email', required: true }, { key: 'x' }, 'junk', null])).toEqual([{ key: 'email', label: 'Email', required: true }])
    expect(readFormFields('nope')).toEqual([])
  })

  it("names a field for a website's input: the column's key, or the name field's label", () => {
    expect(postedNameOf({ key: 'email', label: 'Your email', required: false })).toBe('email')
    expect(postedNameOf({ key: FORM_TITLE_KEY, label: 'Full name', required: false })).toBe('full_name')
  })
})

describe('one submission', () => {
  it('fills each field in its column\'s stored form, matched by key or by label', () => {
    const s = ok({
      'Full Name': 'Sarah Lindqvist',
      email: ' Sarah@Example.com ',
      Phone: '(646) 555-0173',
      'about your rugs': 'Two wool rugs,\r\nred wine on one.',
      rugs: '2',
      service: 'repair',
      'pickup date': '2026-12-03',
      budget: '600',
      newsletter: 'on',
    })
    expect(s.title).toBe('Sarah Lindqvist')
    expect(s.values).toEqual({
      email: 'sarah@example.com',
      phone: '+16465550173',
      message: 'Two wool rugs,\nred wine on one.',
      rugs: 2,
      service: 'Repair',
      pickup: '2026-12-03',
      budget: { amount: 600, currency: 'USD' },
      newsletter: true,
    })
    expect(s.contact).toEqual({ name: 'Sarah Lindqvist', email: 'sarah@example.com', phone: '+16465550173' })
    expect(s.externalId).toBeNull()
  })

  it('drops everything the form does not list: another column, a person, a relation, the row\'s id', () => {
    const s = ok({ full_name: 'Sam', email: 'sam@example.com', owner: 'member-1', contact: ['c-1'], total: 99, old: 'x', id: 'row-1', table_id: 't2', from_form: false })
    expect(Object.keys(s.values)).toEqual(['email'])
  })

  it('refuses a required field left empty, naming it', () => {
    const r = parseSubmission(FIELDS, COLUMNS, { full_name: 'Sam' })
    expect(r).toEqual({ ok: false, reason: 'invalid', error: 'Email is required.' })
    expect(parseSubmission(FIELDS, COLUMNS, { email: 'sam@example.com' })).toEqual({ ok: false, reason: 'invalid', error: 'Full name is required.' })
  })

  it.each([
    [{ email: 'not an email' }, 'Email needs an email address.'],
    [{ email: 'a@b.co', rugs: 'lots' }, 'Rugs needs a number.'],
    [{ email: 'a@b.co', service: 'Dyeing' }, 'Service is one of: Cleaning, Repair.'],
    [{ email: 'a@b.co', pickup: 'next week' }, 'Pickup date needs a date as YYYY-MM-DD.'],
    [{ email: 'a@b.co', rugs: { $gt: 0 } }, 'Rugs takes one value.'],
    [{ email: ['a@b.co', 'c@d.co'] }, 'Email takes one value.'],
  ])('refuses a value that does not fit its column: %j', (extra, error) => {
    expect(parseSubmission(FIELDS, COLUMNS, { full_name: 'Sam', ...extra })).toEqual({ ok: false, reason: 'invalid', error })
  })

  it('cleans what a stranger typed: control and invisible characters out, long text clipped, the name one short line', () => {
    const s = ok({ full_name: `Sam\u0000‮\nSmith ${'x'.repeat(400)}`, email: 'sam@example.com', message: `hi​ ${'y'.repeat(5000)}` })
    expect(s.title.length).toBeLessThanOrEqual(FORM_LIMITS.title)
    expect(s.title).not.toMatch(/[\u0000‮\n]/)
    expect((s.values.message as string).length).toBeLessThanOrEqual(2000)
    expect(s.values.message as string).not.toContain('​')
  })

  it('a filled honeypot is a bot, unless the form has a field of that name', () => {
    expect(parseSubmission(FIELDS, COLUMNS, { full_name: 'Sam', email: 'a@b.co', _gotcha: 'x' })).toMatchObject({ ok: false, reason: 'bot' })
    expect(parseSubmission(FIELDS, COLUMNS, { full_name: 'Sam', email: 'a@b.co', website: 'https://spam.example' })).toMatchObject({ ok: false, reason: 'bot' })
    const columns = [...COLUMNS, col('website', 'Website', 'url')]
    const fields = [...FIELDS, { key: 'website', label: 'Website', required: false }]
    const r = parseSubmission(fields, columns, { full_name: 'Sam', email: 'a@b.co', website: 'brightweave.example' })
    expect(r.ok && r.submission.values.website).toBe('https://brightweave.example')
  })

  it("keeps the form's own submission id, and no contact without an email or a phone", () => {
    const fields: FormField[] = [{ key: 'message', label: 'Message', required: true }]
    const s = ok({ message: 'Hello there', submission_id: 'sub-123' }, fields)
    expect(s.externalId).toBe('sub-123')
    expect(s.contact).toBeNull()
    // No name field: the row is named by the first thing it was given.
    expect(s.title).toBe('Hello there')
  })

  it("a contact's name only from a field that says it is one", () => {
    const fields: FormField[] = [
      { key: FORM_TITLE_KEY, label: 'Project', required: true },
      { key: 'email', label: 'Email', required: true },
    ]
    expect(ok({ project: 'Kitchen remodel', email: 'a@b.co' }, fields).contact).toEqual({ name: null, email: 'a@b.co', phone: null })
  })

  it('a column retyped since the form was saved, to something a stranger must not set, is skipped', () => {
    const retyped = COLUMNS.map((c) => (c.key === 'message' ? { ...c, field_type: 'relation' as const, config: { target: { kind: 'company' as const }, multiple: true } } : c.key === 'rugs' ? { ...c, field_type: 'person' as const } : c))
    const r = parseSubmission(FIELDS, retyped, { full_name: 'Sam', email: 'a@b.co', message: '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222', rugs: '33333333-3333-4333-8333-333333333333' })
    expect(r.ok && r.submission.values).toEqual({ email: 'a@b.co' })
  })

  it('a required checkbox must be ticked; one that is not required may be left or sent as no', () => {
    const fields: FormField[] = [
      { key: 'email', label: 'Email', required: true },
      { key: 'newsletter', label: 'I agree', required: true },
    ]
    expect(parseSubmission(fields, COLUMNS, { email: 'a@b.co', i_agree: 'no' })).toEqual({ ok: false, reason: 'invalid', error: 'I agree is required.' })
    expect(parseSubmission(fields, COLUMNS, { email: 'a@b.co' })).toEqual({ ok: false, reason: 'invalid', error: 'I agree is required.' })
    expect(ok({ email: 'a@b.co', i_agree: 'on' }, fields).values.newsletter).toBe(true)
    expect(ok({ full_name: 'Sam', email: 'a@b.co', newsletter: 'no' }).values.newsletter).toBe(false)
  })

  it('skips a field whose column was deleted since, and refuses when nothing is left or nothing was sent', () => {
    const fields: FormField[] = [
      { key: 'old', label: 'Old', required: true },
      { key: 'email', label: 'Email', required: false },
    ]
    expect(ok({ old: 'x', email: 'a@b.co' }, fields).values).toEqual({ email: 'a@b.co' })
    expect(parseSubmission([{ key: 'old', label: 'Old', required: true }], COLUMNS, { old: 'x' }).ok).toBe(false)
    expect(parseSubmission(fields, COLUMNS, {})).toEqual({ ok: false, reason: 'invalid', error: 'Fill in at least one field.' })
    expect(parseSubmission(fields, COLUMNS, ['a'])).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('names the intake keeps for itself', () => {
  it.each([
    ['a label that slugs to a honeypot', [{ key: FORM_TITLE_KEY, label: 'Gotcha' }]],
    ['a label that is a honeypot', [{ key: 'message', label: 'HP' }]],
    ['a label that slugs to company_website', [{ key: 'message', label: 'Company website' }]],
    ['a label that is the submission id', [{ key: 'message', label: 'Submission ID' }]],
    ['a label that is the external id', [{ key: 'message', label: 'external_id' }]],
    ['a label that slugs to the redirect', [{ key: 'message', label: '_redirect' }]],
    ['a label that slugs to the challenge', [{ key: 'message', label: 'Challenge' }]],
    ['a label that slugs to the answer', [{ key: 'message', label: 'Answer' }]],
    ['a label that slugs to a personal link', [{ key: 'message', label: 'Invite' }]],
    ["a label that slugs to the website check's field", [{ key: 'message', label: 'Dial8 test' }]],
  ])('%s is refused: no field may answer to it', (_, fields) => {
    const r = validateFormFields(COLUMNS, [{ key: 'email', label: 'Email' }, ...fields])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('for the form itself')
  })

  it("a column whose key is one is refused too: it is the name the field is posted by", () => {
    const columns = [...COLUMNS, col('hp', 'Horsepower', 'number')]
    expect(validateFormFields(columns, [{ key: 'hp', label: 'Engine power' }]).ok).toBe(false)
  })

  it('every reserved name is refused, and `website` is not: a business may ask for one, and it is a honeypot only while no field claims it', () => {
    for (const name of FORM_RESERVED_NAMES) expect(validateFormFields(COLUMNS, [{ key: 'message', label: name }]).ok, name).toBe(false)
    const columns = [...COLUMNS, col('website', 'Website', 'url')]
    expect(validateFormFields(columns, [{ key: 'website', label: 'Website' }]).ok).toBe(true)
    expect(FORM_RESERVED_NAMES).not.toContain('website')
  })
})
