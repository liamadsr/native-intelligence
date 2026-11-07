/**
 * Every source's mapping into import records (roadmap track G): spreadsheets
 * (CSV, Excel), phone contacts (vCard), Google Contacts, HubSpot and Brevo,
 * and the record cleaning they share.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { contactFileRecords, readContactFile } from '../file'
import { normalizeContactRecord, normalizeDate, normalizePhone, parseMoneyCents } from '../record'
import { brevoContactToRecord, brevoCrmIndex, brevoDealToJob } from '../sources/brevo'
import { googlePersonToRecord } from '../sources/google-contacts'
import { hubspotContactToRecord, hubspotPageToRecords, relationshipFromLifecycle } from '../sources/hubspot'
import { autoMapColumns, parseCsv, readXlsx, rowsToRecords, targetForHeader, unmappedColumns } from '../sources/spreadsheet'
import { parseVcards } from '../sources/vcard'

const enc = (s: string) => new TextEncoder().encode(s)
const NOW = Date.UTC(2026, 9, 31)

describe('record cleaning', () => {
  it('reads US phone numbers as E.164 and drops extensions', () => {
    expect(normalizePhone('(626) 555-0101')).toBe('+16265550101')
    expect(normalizePhone('626.555.0101 x204')).toBe('+16265550101')
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
    expect(normalizePhone('call me')).toBeNull()
  })

  it('reads the dates a spreadsheet holds, and refuses typos', () => {
    expect(normalizeDate('3/15/2024', NOW)).toBe('2024-03-15T00:00:00.000Z')
    expect(normalizeDate('2024-03-15', NOW)).toBe('2024-03-15T00:00:00.000Z')
    expect(normalizeDate('March 15, 2024', NOW)?.slice(0, 10)).toBe('2024-03-15')
    expect(normalizeDate(45366, NOW)).toBe('2024-03-15T00:00:00.000Z') // an Excel day number
    expect(normalizeDate('3/15/2099', NOW)).toBeNull()
    expect(normalizeDate('soon', NOW)).toBeNull()
  })

  it('reads money in either decimal style', () => {
    expect(parseMoneyCents('$1,250.50')).toBe(125050)
    expect(parseMoneyCents('1.250,50 €')).toBe(125050)
    expect(parseMoneyCents('-5')).toBeNull()
  })

  it('drops a record that names nobody, and splits a full name', () => {
    expect(normalizeContactRecord({ kind: 'contact', notes: 'x' })).toBeNull()
    expect(normalizeContactRecord({ kind: 'contact', fullName: 'Ana María Ruiz' })).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz' })
    expect(normalizeContactRecord({ kind: 'contact', fullName: 'ana@example.com', emails: ['ana@example.com'] })?.fullName).toBeNull()
  })
})

describe('spreadsheets', () => {
  it('maps the headers an owner\'s sheet has, and leaves the rest to ask about', () => {
    expect(targetForHeader('E-mail Address')).toBe('email')
    expect(targetForHeader('Cell #')).toBe('phone')
    expect(targetForHeader('Customer Phone Number')).toBe('phone')
    expect(targetForHeader('Zip')).toBe('postal_code')
    expect(targetForHeader('Last Service Date')).toBe('last_contact')
    expect(targetForHeader('Rug Type')).toBeNull()
    expect(targetForHeader('Invoice #')).toBeNull()
  })

  it('parses quoted CSV with any delimiter and builds customers with their past job', () => {
    const csv = [
      'Customer Name;Email;Phone;Street;City;State;Zip;Service;Date;Total;Rug Type',
      '"Ruiz, Ana";ana@example.com;(626) 555-0101;12 Elm St;Pasadena;CA;91101;"Wash, 8x10";3/1/2025;$480.00;Persian',
      'Ben Ode;;626-555-0102;;;;;;;;',
    ].join('\n')
    const sheet = parseCsv(csv)
    expect(sheet.headers).toHaveLength(11)
    const mappings = autoMapColumns(sheet)
    expect(unmappedColumns(mappings).map((m) => m.header)).toEqual(['Rug Type'])
    const [ana, ben] = rowsToRecords(sheet, autoMapColumns(sheet, { 'rug type': 'note' }), { relationship: 'customer', nowMs: NOW })
    expect(ana).toMatchObject({
      fullName: 'Ruiz, Ana',
      emails: ['ana@example.com'],
      address: '12 Elm St, Pasadena, CA 91101',
      notes: 'Rug Type: Persian',
      relationship: 'customer',
      history: [{ kind: 'job', title: 'Wash, 8x10', occurredAt: '2025-03-01T00:00:00.000Z', amountCents: 48000, currency: null }],
    })
    expect(ben).toMatchObject({ fullName: 'Ben Ode', phones: ['626-555-0102'], history: [], relationship: 'customer' })
  })

  it('reads the first sheet of an .xlsx (shared strings, inline strings, numbers)', async () => {
    const zip = new JSZip()
    zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Customers" sheetId="1" r:id="rId1"/></sheets></workbook>')
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
    zip.file('xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Phone</t></si><si><t>Last Visit</t></si><si><t>Cleo &amp; Co</t></si></sst>')
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="inlineStr"><is><t>626 555 0103</t></is></c><c r="C2"><v>45366</v></c></row>' +
        '</sheetData></worksheet>',
    )
    const sheet = await readXlsx(await zip.generateAsync({ type: 'uint8array' }))
    expect(sheet).toEqual({ headers: ['Name', 'Phone', 'Last Visit'], rows: [['Cleo & Co', '626 555 0103', '45366']] })
    const [cleo] = rowsToRecords(sheet, autoMapColumns(sheet), { nowMs: NOW })
    expect(cleo.lastContactAt).toBe('2024-03-15T00:00:00.000Z')
  })

  it('refuses the old .xls and says what to send instead', async () => {
    const file = await readContactFile(new Uint8Array([0xd0, 0xcf]), 'customers.xls')
    expect(file).toMatchObject({ ok: false })
    expect(file.ok ? '' : file.error).toMatch(/\.xlsx or CSV/)
  })
})

describe('phone contacts (vCard)', () => {
  it('reads 3.0 and 2.1 cards: names, preferred values first, address, labels, quoted-printable notes', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:abc-1',
      'FN:Ana Ruiz',
      'N:Ruiz;Ana;;;',
      'item1.EMAIL;TYPE=INTERNET:ana@work.com',
      'EMAIL;TYPE=INTERNET,pref:ana@example.com',
      'TEL;TYPE=CELL:(626) 555-0101',
      'ADR;TYPE=HOME:;;12 Elm St;Pasadena;CA;91101;USA',
      'ORG:Ruiz Design;',
      'CATEGORIES:VIP,Repeat',
      'NOTE:Two rugs\\, both Persian',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N:Ode;Ben',
      'TEL;CELL:626-555-0102',
      'NOTE;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9 owner',
      'END:VCARD',
    ].join('\r\n')
    const [ana, ben] = parseVcards(vcf)
    expect(ana).toMatchObject({
      externalId: 'abc-1',
      fullName: 'Ana Ruiz',
      emails: ['ana@example.com', 'ana@work.com'],
      phones: ['(626) 555-0101'],
      address: '12 Elm St, Pasadena, CA 91101, USA',
      company: { name: 'Ruiz Design' },
      tags: ['VIP', 'Repeat'],
      notes: 'Two rugs, both Persian',
    })
    expect(ben).toMatchObject({ firstName: 'Ben', lastName: 'Ode', phones: ['626-555-0102'], notes: 'Café owner' })
  })

  it('a .vcf file reads as cards, and the owner can say they are customers', async () => {
    const file = await readContactFile(enc('BEGIN:VCARD\nFN:Gus Lee\nTEL:6265550199\nEND:VCARD\n'), 'contacts.vcf')
    if (!file.ok) throw new Error(file.error)
    expect(contactFileRecords(file, 'customer')).toEqual([expect.objectContaining({ fullName: 'Gus Lee', relationship: 'customer' })])
  })
})

describe('Google Contacts', () => {
  it('maps a person: primary name and values first, labels as tags, system groups left out', () => {
    const record = googlePersonToRecord(
      {
        resourceName: 'people/c42',
        names: [{ displayName: 'Ana Ruiz', givenName: 'Ana', familyName: 'Ruiz', metadata: { primary: true } }],
        emailAddresses: [{ value: 'old@example.com' }, { value: 'ana@example.com', metadata: { primary: true } }],
        phoneNumbers: [{ value: '(626) 555-0101', canonicalForm: '+16265550101' }],
        addresses: [{ formattedValue: '12 Elm St\nPasadena, CA 91101' }],
        organizations: [{ name: 'Ruiz Design', title: 'Owner' }],
        biographies: [{ value: 'Met at the fair' }],
        memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/abc' } }, { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } }],
      },
      { 'contactGroups/abc': 'Rug clients' },
    )
    expect(record).toEqual({
      kind: 'contact',
      externalId: 'people/c42',
      fullName: 'Ana Ruiz',
      firstName: 'Ana',
      lastName: 'Ruiz',
      emails: ['ana@example.com', 'old@example.com'],
      phones: ['+16265550101'],
      address: '12 Elm St, Pasadena, CA 91101',
      company: { name: 'Ruiz Design', domain: null },
      jobTitle: 'Owner',
      tags: ['Rug clients'],
      notes: 'Met at the fair',
    })
  })
})

describe('HubSpot', () => {
  it('maps a contact with its company, lifecycle and last contact; archived ones are left out', () => {
    expect(relationshipFromLifecycle('customer')).toBe('customer')
    expect(relationshipFromLifecycle('salesqualifiedlead')).toBe('lead')
    const contact = hubspotContactToRecord({
      id: '501',
      properties: { firstname: 'Ana', lastname: 'Ruiz', email: 'ana@example.com', hs_additional_emails: 'a@two.com;a@three.com', phone: '626 555 0101', city: 'Pasadena', state: 'CA', zip: '91101', lifecyclestage: 'customer', notes_last_contacted: '2025-09-01T10:00:00Z' },
      associations: { companies: { results: [{ id: '77' }] } },
    })
    expect(contact).toMatchObject({
      externalId: '501',
      emails: ['ana@example.com', 'a@two.com', 'a@three.com'],
      address: 'Pasadena, CA 91101',
      company: { externalId: '77' },
      relationship: 'customer',
      lastContactAt: '2025-09-01T10:00:00Z',
    })
    expect(hubspotPageToRecords('companies', [{ id: '1', properties: { name: 'Acme' } }, { id: '2', properties: { name: 'Gone' }, archived: true }])).toEqual([
      expect.objectContaining({ kind: 'company', externalId: '1', name: 'Acme' }),
    ])
  })
})

describe('Brevo', () => {
  it('maps a contact with its lists, unsubscribes, company and won deals; drops the SMS placeholder address', () => {
    const crm = brevoCrmIndex(
      [{ id: 'co-1', attributes: { name: 'Ruiz Design' }, linkedContactsIds: [9] }],
      [
        { id: 'd-1', attributes: { deal_name: 'Wash 2 rugs', amount: 640, deal_stage: 'Won', close_date: '2025-05-02' }, linkedContactsIds: [9] },
        { id: 'd-2', attributes: { deal_name: 'Maybe', deal_stage: 'Lost' }, linkedContactsIds: [9] },
      ],
    )
    const record = brevoContactToRecord(
      { id: 9, email: '33612345678@mailin-sms.com', attributes: { FIRSTNAME: 'Ana', LASTNAME: 'Ruiz', SMS: '+16265550101' }, emailBlacklisted: true, listIds: [3] },
      { 3: 'Newsletter' },
      crm,
    )
    expect(record).toMatchObject({
      externalId: '9',
      emails: [],
      phones: ['+16265550101'],
      tags: ['Newsletter', 'unsubscribed email'],
      company: { externalId: 'co-1', name: 'Ruiz Design' },
      relationship: 'customer',
      history: [{ kind: 'job', title: 'Wash 2 rugs', amountCents: 64000, occurredAt: '2025-05-02' }],
    })
    expect(brevoDealToJob({ id: 'x', attributes: { deal_name: 'Open one', deal_stage: 'Open' } })).toBeNull()
  })
})
