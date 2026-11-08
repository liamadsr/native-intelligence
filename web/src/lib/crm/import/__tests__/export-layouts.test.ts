/**
 * The customer exports of common tools import with no questions (roadmap
 * #10): each made-up export under ./fixtures/exports is recognised as its
 * app, every column is mapped, the junk is dropped, and the people come out
 * right: names, emails, phones, addresses, tags, spend, opt-outs, the app's
 * own id. Anyone's own spreadsheet is never taken for an app's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contactFilePreview, contactFileRecords, readContactFile } from '../file'
import { UNSUBSCRIBED_EMAIL_TAG, UNSUBSCRIBED_SMS_TAG, normalizeContactRecord } from '../record'
import { detectExportLayout } from '../sources/export-layouts'

const NOW = Date.UTC(2026, 10, 8)
const FIXTURES = join(__dirname, 'fixtures/exports')

async function read(name: string) {
  const file = await readContactFile(new Uint8Array(readFileSync(join(FIXTURES, name))), name)
  if (!file.ok || file.format !== 'spreadsheet') throw new Error(`${name} was not read as a spreadsheet`)
  const preview = contactFilePreview(file)
  const people = contactFileRecords(file).map((r) => normalizeContactRecord(r, NOW))
  return { file, preview, people }
}

describe('each export is recognised and fully mapped', () => {
  it.each([
    ['stripe-unified_customers.csv', 'stripe', 'Stripe'],
    ['square-customers.csv', 'square', 'Square'],
    ['hubspot-contacts.csv', 'hubspot', 'HubSpot'],
    ['pipedrive-people.csv', 'pipedrive', 'Pipedrive'],
    ['mailchimp-subscribed_members_export_8f2c1.csv', 'mailchimp', 'Mailchimp'],
    ['unsubscribed_email_audience_export_8f2c1.csv', 'mailchimp', 'Mailchimp'],
    ['cleaned_email_audience_export_8f2c1.csv', 'mailchimp', 'Mailchimp'],
    ['stripe-default-preset.csv', 'stripe', 'Stripe'],
    ['quickbooks-desktop-customers.csv', 'quickbooks', 'QuickBooks'],
    ['quickbooks-online-customers-new.csv', 'quickbooks', 'QuickBooks'],
    ['jobber-clients.csv', 'jobber', 'Jobber'],
    ['housecall-pro-customers.csv', 'housecall_pro', 'Housecall Pro'],
    ['quickbooks-customer-contact-list.csv', 'quickbooks', 'QuickBooks'],
    ['quickbooks-customers.csv', 'quickbooks', 'QuickBooks'],
  ])('%s → %s, nothing to ask', async (name, source, label) => {
    const { file, preview } = await read(name)
    expect(file.source).toBe(source)
    expect(preview).toMatchObject({ app: label, unmapped: [] })
  })
})

describe('the people in each export', () => {
  it('Stripe: the customer id links them, card details and Stripe bookkeeping stay out, spend and metadata go in notes', async () => {
    const { people, file } = await read('stripe-unified_customers.csv')
    expect(people[0]).toMatchObject({
      externalId: 'cus_Q1fernA001',
      fullName: 'Ana Ruiz',
      emails: ['ana.ruiz@example.com'],
      phones: ['+16265550101'],
      // The billing address, never the card's (Card Address City: Glendale).
      address: '12 Elm St, Apt 3, Pasadena, CA 91101, US',
      relationship: 'customer',
      notes: 'Prefers mornings\ngate_code: 0142\nTotal Spend: 480.00\nPayment Count: 2',
    })
    // Never paid: a lead, not a customer (a win-back must not reach them).
    expect(people[1]).toMatchObject({ externalId: 'cus_Q1fernB002', fullName: 'Ben Ode', relationship: 'lead', notes: null })
    const [wes] = (await read('stripe-default-preset.csv')).people
    expect(wes).toMatchObject({ externalId: 'cus_Q1fernW003', fullName: 'Wes Ford', relationship: 'customer', notes: 'tag: rugs\nTotal Spend: 1,200.00\nPayment Count: 3' })
    const skipped = file.mappings.filter((m) => m.target === 'skip').map((m) => m.header)
    for (const h of ['Card ID', 'Card Last4', 'Card Name', 'Card Address City', 'Created (UTC)', 'Delinquent', 'Account Balance', 'Currency']) expect(skipped).toContain(h)
  })

  it("Square: last visit, groups as tags, lifetime spend, an unsubscribed email, the numbers Excel mangled", async () => {
    const [cy, dee] = (await read('square-customers.csv')).people
    expect(cy).toMatchObject({
      externalId: 'SQCUST0001FERN',
      fullName: 'Cy Lane',
      phones: ['+16265550103'],
      address: '40 Oak Ave, Pasadena, CA 91103',
      notes: 'Likes the blue rug\nTransaction Count: 5\nLifetime Spend: $1,230.00',
      tags: ['Regulars', 'Pickup'],
      lastContactAt: '2025-03-01T00:00:00.000Z',
      relationship: 'customer',
    })
    expect(dee).toMatchObject({ phones: ['+16265550104'], company: { name: 'Moss Bakery' }, tags: [UNSUBSCRIBED_EMAIL_TAG, UNSUBSCRIBED_SMS_TAG], relationship: 'lead' })
  })

  it("HubSpot: the record id (HubSpot's own, like its connected import), the lifecycle stage, an opt-out", async () => {
    const [eve, finn] = (await read('hubspot-contacts.csv')).people
    expect(eve).toMatchObject({ externalId: '501', fullName: 'Eve Park', company: { name: 'Park Dental' }, jobTitle: 'Office manager', relationship: 'customer', tags: [], notes: null })
    expect(eve!.lastContactAt).toMatch(/^2025-04-02/)
    expect(finn).toMatchObject({ externalId: '502', relationship: 'lead', tags: [UNSUBSCRIBED_EMAIL_TAG] })
  })

  it('Pipedrive: every email and phone, the organization, won deals make a customer, the label a tag', async () => {
    const [gia, hal] = (await read('pipedrive-people.csv')).people
    expect(gia).toMatchObject({ externalId: '71', fullName: 'Gia Stone', company: { name: 'Stone Realty' }, tags: ['Hot lead'], relationship: 'lead', notes: null })
    expect(hal).toMatchObject({
      emails: ['hal.weir@example.com', 'hal@example.net'],
      phones: ['+16265550107'],
      relationship: 'customer',
      notes: 'Won deals: 2',
      tags: [UNSUBSCRIBED_EMAIL_TAG],
    })
  })

  it("Mailchimp: the double-spaced address, the quoted tags, and the unsubscribed file's people opted out", async () => {
    const [ivy] = (await read('mailchimp-subscribed_members_export_8f2c1.csv')).people
    expect(ivy).toMatchObject({ fullName: 'Ivy Reed', company: { name: 'Reed Tile' }, address: '9 Pine Rd, Apt 2, Pasadena, CA 91104, US', tags: ['Customer', 'VIP'], relationship: null, notes: null })
    const [jo] = (await read('unsubscribed_email_audience_export_8f2c1.csv')).people
    expect(jo).toMatchObject({ emails: ['jo.kent@example.com'], tags: [UNSUBSCRIBED_EMAIL_TAG] })
    // A cleaned address bounced: never mailed again either.
    const [ola] = (await read('cleaned_email_audience_export_8f2c1.csv')).people
    expect(ola).toMatchObject({ emails: ['old.box@example.com'], tags: [UNSUBSCRIBED_EMAIL_TAG] })
  })

  it('Jobber: a row per property is one client, the billing address, never the service one or the fax, a custom field in notes', async () => {
    const { people, file } = await read('jobber-clients.csv')
    const [kai, kaiRental, lea] = people
    expect(kai).toMatchObject({
      externalId: '1001',
      fullName: 'Kai Moore',
      phones: ['+16265550109'],
      address: '15 Cedar Ln, Pasadena, California, 91105, United States',
      tags: ['weekly', 'gate code'],
      notes: 'Gate code: 0142',
      relationship: 'customer',
    })
    // The second property's row is the same client (the importer folds it into the first).
    expect(kaiRental).toMatchObject({ externalId: '1001', address: kai!.address })
    expect(lea).toMatchObject({ externalId: '1002', fullName: 'Lea Diaz', company: { name: 'Fernhill Property Group' }, phones: ['+16265550110', '+16265550118'], address: '200 Lake Ave, Suite 5, Pasadena, California, 91101, United States' })
    expect(file.mappings.find((m) => m.header === 'Fax Phone #s')?.target).toBe('skip')
  })

  it("Housecall Pro: the first address set, every number, lifetime value, a business display name as the company, a lead saved by its number", async () => {
    const [max, nia, numberOnly] = (await read('housecall-pro-customers.csv')).people
    expect(max).toMatchObject({
      externalId: 'cus_hcp_0001',
      fullName: 'Max Ng',
      address: '77 Birch St, Pasadena, CA 91106',
      tags: ['repeat', 'dog in yard'],
      notes: 'Side gate\nAddress Notes: Gate code 0142\nLifetime value: $2,400.00',
      lastContactAt: '2025-04-18T00:00:00.000Z',
      relationship: 'customer',
    })
    expect(nia).toMatchObject({ fullName: 'Nia Cole', company: { name: 'Cole Plumbing' }, jobTitle: 'Owner', phones: ['+16265550112'], relationship: 'lead' })
    // Its name fields hold its number: nobody's name, but still the number to reach.
    expect(numberOnly).toMatchObject({ fullName: null, firstName: null, phones: ['+16265550120'] })
  })

  it('QuickBooks: a report read from under its title rows, its printed-at line dropped, labelled phones read, the fax left out', async () => {
    const { people, preview } = await read('quickbooks-customer-contact-list.csv')
    expect(preview.rows).toBe(3)
    expect(people).toHaveLength(3)
    expect(people[0]).toMatchObject({ fullName: 'Pia Grant', company: { name: 'Oak & Ash Cafe' }, phones: ['+16265550113', '+16265550114'], address: '300 Colorado Blvd, Pasadena, CA 91101', relationship: 'customer' })
    expect(people[1]).toMatchObject({ fullName: 'Rory Quinn', company: null, phones: ['+16265550115'] })
    // A sub-customer ("Parent:Job") is the parent's.
    expect(people[2]).toMatchObject({ fullName: 'Pia Grant', company: { name: 'Oak & Ash Cafe' } })
  })

  it('a QuickBooks customer whose name starts with "Total" is a customer, not the totals line', async () => {
    const csv = ['Fernhill Cleaning Co', 'Customer Contact List', '', ',Customer,Phone Numbers,Email,Full Name,Billing Address', ',Total Fitness LLC,Phone: (626) 555-0124,desk@totalfit.example.com,Wyn Ash,', ',TOTAL,,,,'].join('\n')
    const file = await readContactFile(new TextEncoder().encode(csv), 'contacts.csv')
    if (!file.ok || file.format !== 'spreadsheet') throw new Error('not read')
    expect(file.source).toBe('quickbooks')
    expect(contactFileRecords(file).map((r) => r.company?.name)).toEqual(['Total Fitness LLC'])
  })

  it("only an app's own id links: a Stripe export's id column that isn't a customer id names nobody", async () => {
    const csv = ['id,Email,Name,Created (UTC),Delinquent,Card Last4,Total Spend', '7,ana@example.com,Ana Ruiz,2024-05-02 18:20:11,false,4242,10.00'].join('\n')
    const file = await readContactFile(new TextEncoder().encode(csv), 'customers.csv')
    if (!file.ok || file.format !== 'spreadsheet') throw new Error('not read')
    expect(file.source).toBe('stripe')
    expect(contactFileRecords(file)[0].externalId).toBeNull()
  })

  it("QuickBooks Desktop: the bill-to lines as the address (without the name line), the job's row the customer's own", async () => {
    const [una, patio] = (await read('quickbooks-desktop-customers.csv')).people
    expect(una).toMatchObject({ fullName: 'Una Bell', firstName: 'Una', lastName: 'Bell', phones: ['+16265550121', '+16265550122'], address: '4 Vine St, Pasadena, CA 91104', notes: 'Balance: 85.00' })
    expect(patio).toMatchObject({ fullName: 'Una Bell', emails: ['una.bell@example.com'], company: null })
  })

  it("QuickBooks Online's new customer screen", async () => {
    const [vic] = (await read('quickbooks-online-customers-new.csv')).people
    expect(vic).toMatchObject({ fullName: 'Vic Shaw', company: { name: 'Shaw Studio' }, phones: ['+16265550123'], address: '21 Pine St, Pasadena, CA 91103', notes: 'Monthly\nBalance: 40.00', relationship: 'customer' })
  })

  it('QuickBooks customer list: the open balance kept in notes (zero says nothing)', async () => {
    const [sky, tom] = (await read('quickbooks-customers.csv')).people
    expect(sky).toMatchObject({ fullName: 'Sky Tan', address: '18 Maple Dr, Pasadena, CA 91107, USA', notes: 'Every other Friday\nOpen Balance: 125.00', relationship: 'customer' })
    expect(tom).toMatchObject({ fullName: 'Tom Vu', company: { name: 'Vu Dental' }, notes: null })
  })
})

describe('Pipedrive without its prefix', () => {
  it('is still Pipedrive by the counts it keeps per person', () => {
    expect(detectExportLayout(['ID', 'Name', 'Organization', 'Email - Work', 'Phone - Mobile', 'Label', 'Owner', 'Open deals', 'Won deals'])?.app).toBe('pipedrive')
  })
})

describe("anyone's own spreadsheet", () => {
  it.each([
    [['Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip', 'Notes']],
    [['Customer Name', 'Email', 'Phone', 'Street', 'City', 'State', 'Zip', 'Service', 'Date', 'Total', 'Rug Type']],
    [['First Name', 'Last Name', 'Email Address', 'Phone Number', 'Company', 'Tags']],
    [['ID', 'Name', 'Email', 'Created', 'Status', 'Balance']],
    [['Display Name', 'Email', 'Mobile Number', 'Notes']],
    [['Name', 'Email', 'Phone', 'Billing Address', 'Shipping Address']],
    [['Name', 'Email', 'Lifecycle Stage', 'Lead Status', 'Create Date']],
    // The review's: each once taken for an app's export.
    [['Name', 'Email', 'Phone', 'Address', 'Latitude', 'Longitude', 'Timezone', 'Gate code']],
    [['Name', 'Email', 'Phone', 'First Visit', 'Last Visit', 'Lifetime Spend']],
    [['ID', 'Name', 'Email', 'Mobile Number', 'Home Number', 'Lifetime value']],
    [['Name', 'Phone Numbers', 'Email', 'Balance']],
    [['ID', 'Name', 'Email', 'Phone', 'Total Spend', 'Payment Count']],
  ])('%j is nobody\'s export: its unknown columns are still asked about', (headers) => {
    expect(detectExportLayout(headers, 'customers.csv')).toBeNull()
  })
})
