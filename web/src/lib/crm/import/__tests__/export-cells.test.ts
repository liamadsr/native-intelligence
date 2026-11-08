/**
 * The cells an app's export writes that a plain spreadsheet rarely does
 * (roadmap #10): labelled phone numbers, double-spaced addresses, opt-out
 * columns, a display name beside the person's name, a report's title rows
 * above its header and its totals below. Made-up people only.
 */
import { describe, expect, it } from 'vitest'
import { splitTags, UNSUBSCRIBED_EMAIL_TAG } from '../record'
import { addressFromCell, autoMapColumns, headerRowIndex, isEmailOptOut, parseCsv, rowsToRecords, splitPhones, type Sheet } from '../sources/spreadsheet'

const NOW = Date.UTC(2026, 10, 8)

describe('cells', () => {
  it('reads every number in a phone cell, labelled or not, and never a fax', () => {
    expect(splitPhones('Phone: (626) 555-0101 Mobile: (626) 555-0102 Fax: (626) 555-0199')).toEqual(['(626) 555-0101', '(626) 555-0102'])
    expect(splitPhones('626-555-0101; 626-555-0102')).toEqual(['626-555-0101', '626-555-0102'])
    expect(splitPhones('(626) 555-0101')).toEqual(['(626) 555-0101'])
    expect(splitPhones('626.555.0101 x204')).toEqual(['626.555.0101 x204'])
  })

  it('reads an address on several lines or in double-spaced parts as one line', () => {
    expect(addressFromCell('12 Elm St  Apt 3  Pasadena  CA  91101  US')).toBe('12 Elm St, Apt 3, Pasadena, CA 91101, US')
    expect(addressFromCell('12 Elm St\nPasadena, CA 91101')).toBe('12 Elm St, Pasadena, CA 91101')
    expect(addressFromCell('12 Elm St, Pasadena, CA 91101')).toBe('12 Elm St, Pasadena, CA 91101')
  })

  it('knows an opt-out when it says so, and only then', () => {
    for (const yes of ['true', 'Yes', '1', 'Unsubscribed', 'unsubscribed', 'Opted out', 'No consent', '2025-03-01 12:04:11']) expect(isEmailOptOut(yes), yes).toBe(true)
    for (const no of ['', 'false', 'No', 'Subscribed', 'subscribed', 'Not subscribed', 'Opted in', 'Unknown', null]) expect(isEmailOptOut(no), String(no)).toBe(false)
  })

  it("takes the quotes off a tag (Mailchimp's TAGS cell)", () => {
    expect(splitTags('"VIP","Repeat"')).toEqual(['VIP', 'Repeat'])
  })
})

describe('the header row', () => {
  it("is the first row, unless a report's title rows sit above it", () => {
    expect(headerRowIndex([['Name', 'Email', 'Phone'], ['Ana Ruiz', 'ana@example.com', '626-555-0101']])).toBe(0)
    expect(
      headerRowIndex([
        ['Customer Contact List'],
        ['Fernhill Cleaning Co'],
        ['All Dates'],
        ['', 'Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address'],
        ['', 'Ana Ruiz', 'Phone: (626) 555-0101', 'ana@example.com', 'Ana Ruiz', '12 Elm St'],
      ]),
    ).toBe(3)
    // A short sheet whose header names nothing known stays as it is.
    expect(headerRowIndex([['Nombre', 'Correo'], ['Ana', 'ana@example.com']])).toBe(0)
    // A first row with three cells or more is never a title, even when a later row names more fields.
    expect(headerRowIndex([['Ref', 'Who', 'Where'], ['Name', 'Email', 'Phone']])).toBe(0)
  })

  it('a CSV report reads from its header, title rows dropped', () => {
    const sheet = parseCsv(['Customer Contact List', 'Fernhill Cleaning Co', '', 'Customer,Phone Numbers,Email', 'Ana Ruiz,Phone: (626) 555-0101,ana@example.com'].join('\n'))
    expect(sheet.headers).toEqual(['Customer', 'Phone Numbers', 'Email'])
    expect(sheet.rows).toEqual([['Ana Ruiz', 'Phone: (626) 555-0101', 'ana@example.com']])
  })
})

describe('rows', () => {
  const sheet = (headers: string[], ...rows: string[][]): Sheet => ({ headers, rows })

  it("a display name is the person when nothing else names them, else their business when it names someone else", () => {
    const s = sheet(['Display Name', 'First Name', 'Last Name'], ['Fernhill Cleaning', 'Ana', 'Ruiz'], ['Ruiz, Ben', 'Ben', 'Ruiz'], ['Cy Lane', '', ''])
    const mappings = autoMapColumns(s, { 'display name': 'display_name' })
    const [ana, ben, cy] = rowsToRecords(s, mappings, { nowMs: NOW })
    expect(ana).toMatchObject({ fullName: null, firstName: 'Ana', lastName: 'Ruiz', company: { name: 'Fernhill Cleaning' } })
    expect(ben).toMatchObject({ firstName: 'Ben', company: null })
    expect(cy).toMatchObject({ fullName: 'Cy Lane', company: null })
  })

  it('spend above zero makes a customer and is kept in notes; zero says nothing', () => {
    const s = sheet(['Name', 'Total Spend', 'Payment Count'], ['Ana Ruiz', '$480.00', '2'], ['Ben Ode', '0.00', '0'])
    const mappings = autoMapColumns(s, { 'total spend': 'spend', 'payment count': 'spend' })
    const [ana, ben] = rowsToRecords(s, mappings, { relationship: 'lead', nowMs: NOW })
    expect(ana).toMatchObject({ relationship: 'customer', notes: 'Total Spend: $480.00\nPayment Count: 2' })
    expect(ben).toMatchObject({ relationship: 'lead', notes: null })
  })

  it('an opt-out column tags them unsubscribed (outreach never emails them)', () => {
    const s = sheet(['Email', 'Unsubscribed from all email'], ['ana@example.com', 'true'], ['ben@example.com', 'false'])
    const [ana, ben] = rowsToRecords(s, autoMapColumns(s, { 'unsubscribed from all email': 'email_opt_out' }), { nowMs: NOW })
    expect(ana.tags).toEqual([UNSUBSCRIBED_EMAIL_TAG])
    expect(ben.tags).toEqual([])
  })

  it('the latest of several last-contact columns wins', () => {
    const s = sheet(['Name', 'Last activity date', 'Last email received'], ['Ana Ruiz', '2025-01-10', '2025-04-02'])
    const [ana] = rowsToRecords(s, autoMapColumns(s, { 'last activity date': 'last_contact', 'last email received': 'last_contact' }), { nowMs: NOW })
    expect(ana.lastContactAt).toBe('2025-04-02T00:00:00.000Z')
  })

  it("a plain spreadsheet's id column never links (only a recognised export's does)", () => {
    const s = sheet(['ID', 'Name'], ['7', 'Ana Ruiz'])
    // An answer cannot make a column the app's own id.
    const [ana] = rowsToRecords(s, autoMapColumns(s, { id: 'external_id' }), { nowMs: NOW })
    expect(ana.externalId).toBeNull()
  })
})
