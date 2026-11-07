/**
 * The importer's edges, as the review of track G found them: undo never takes
 * work done since, the no-overwrite rule never claims what the owner typed, an
 * import never reads or writes a contact its user can't see, a contact never
 * takes another's address, source ids are per account, a crash mid-item is
 * recovered and undone, a company's domain adoption is given back, and the
 * small things (repeat rows, undated jobs, encodings).
 */
import { describe, expect, it, vi } from 'vitest'
import { applyPendingItems, createImportBatch, loadImportBatch, stageRecords } from '../batch'
import { decodeText } from '../file'
import { finishImportBatch } from '../finish'
import type { ImportContactRecord, ImportSource } from '../record'
import { runUndo } from '../run'
import { contactRow, memDb } from './mem-db'

const WS = 'ws-1'
const USER = 'user-1'
const person = (r: Partial<ImportContactRecord>): ImportContactRecord => ({ kind: 'contact', ...r })

function seeded(contacts: Array<Record<string, unknown>> = [], extra: Record<string, Array<Record<string, unknown>>> = {}, opts: Parameters<typeof memDb>[1] = {}) {
  return memDb(
    {
      contact: contacts.map(contactRow),
      member: [
        { id: 'member-1', user_id: USER, workspace_id: WS, role: 'member' },
        { id: 'member-2', user_id: 'user-2', workspace_id: WS, role: 'member' },
        { id: 'member-3', user_id: 'admin-1', workspace_id: WS, role: 'admin' },
      ],
      contact_interaction: [],
      company: [],
      ...extra,
    },
    opts,
  )
}

async function importAll(db: ReturnType<typeof memDb>, records: ImportContactRecord[], o: { source?: ImportSource; userId?: string; accountId?: string } = {}) {
  const created = await createImportBatch(db.client, { workspaceId: WS, userId: o.userId ?? USER, source: o.source ?? 'spreadsheet', label: 'customers.csv', accountId: o.accountId ?? null, notify: false })
  if (!created.ok) throw new Error(created.error)
  await stageRecords(db.client, created.batch, records)
  for (;;) if (!(await applyPendingItems(db.client, created.batch.id, { limit: 50 })).remaining) break
  await finishImportBatch(db.client, created.batch.id, { appendHome: vi.fn() as never, text: vi.fn(async () => ({ sent: true })) })
  return created.batch.id
}

const contacts = (db: ReturnType<typeof memDb>) => db.tables.contact
const items = (db: ReturnType<typeof memDb>, batchId: string) => db.tables.contact_import_item.filter((i) => i.batch_id === batchId)

describe('undo never takes work done since', () => {
  it('keeps a contact the owner edited, or gave an action to, after the import; removes an untouched one', async () => {
    const db = seeded([], { actions: [] })
    const batchId = await importAll(db, [person({ fullName: 'Edited Since', phones: ['626-555-0201'] }), person({ fullName: 'Assigned Since', phones: ['626-555-0202'] }), person({ fullName: 'Untouched', phones: ['626-555-0203'] })])
    contacts(db).find((c) => c.full_name === 'Edited Since')!.notes = 'Prefers Tuesday pickups'
    db.tables.actions.push({ id: 'a-1', assignee_contact_id: contacts(db).find((c) => c.full_name === 'Assigned Since')!.id })
    const out = await runUndo(db.client, { workspaceId: WS, batchId, userId: USER })
    expect(out).toEqual({ status: 'done', text: "Undid the import from customers.csv: removed 1 contact it added. Kept 2 contacts you've worked with since (tag removed)." })
    expect(contacts(db).map((c) => c.full_name).sort()).toEqual(['Assigned Since', 'Edited Since'])
    expect(contacts(db).find((c) => c.full_name === 'Edited Since')!.notes).toBe('Prefers Tuesday pickups')
  })

  it('a repeat row later in the file is unwound first, so its contact still comes off', async () => {
    const db = seeded()
    const batchId = await importAll(db, [person({ fullName: 'Rae Kim', phones: ['626-555-0204'] }), person({ fullName: 'Rae Kim', phones: ['626-555-0204'], address: '1 Elm St' })])
    expect(contacts(db)[0].address).toBe('1 Elm St')
    await runUndo(db.client, { workspaceId: WS, batchId, userId: USER })
    expect(contacts(db)).toHaveLength(0)
  })
})

describe('the no-overwrite rule never claims what the owner typed', () => {
  it('a file that agrees with the owner does not make the value the source\'s; a later file cannot replace it', async () => {
    const db = seeded([{ id: 'c-1', full_name: 'Pat Doe', email: 'pat@example.com', phone: '+16265550301' }])
    await importAll(db, [person({ fullName: 'Pat Doe', emails: ['pat@example.com'], phones: ['626-555-0301'] })])
    await importAll(db, [person({ fullName: 'Pat Doe', emails: ['pat@example.com'], phones: ['626-555-0399'] })])
    expect(contacts(db)[0].phone).toBe('+16265550301')
  })

  it("an owner's lead is not moved to customer; a contact is", async () => {
    const db = seeded([
      { id: 'c-lead', full_name: 'Lee Lead', email: 'lee@example.com', relationship_type: 'lead' },
      { id: 'c-plain', full_name: 'Cal Plain', email: 'cal@example.com' },
    ])
    await importAll(db, [person({ fullName: 'Lee Lead', emails: ['lee@example.com'], relationship: 'customer' }), person({ fullName: 'Cal Plain', emails: ['cal@example.com'], relationship: 'customer' })])
    expect(contacts(db).find((c) => c.id === 'c-lead')!.relationship_type).toBe('lead')
    expect(contacts(db).find((c) => c.id === 'c-plain')!.relationship_type).toBe('customer')
  })

  it('filling the email of a contact no source owns holds it back from the HubSpot push', async () => {
    const db = seeded([{ id: 'c-sms', full_name: 'Sam Text', phone: '+16265550302', email: null }])
    await importAll(db, [person({ fullName: 'Sam Text', phones: ['626-555-0302'], emails: ['sam@example.com'] })], { source: 'google_contacts' })
    const sam = contacts(db)[0]
    expect(sam.email).toBe('sam@example.com')
    expect((sam.metadata as Record<string, unknown>).hubspot_push_hold).toEqual(expect.objectContaining({ by: 'unattended' }))
  })
})

describe('only contacts the importing member can see', () => {
  const PRIVATE = { id: 'c-secret', full_name: 'Sue Secret', email: 'sue@example.com', notes: 'private notes', visibility: 'private', created_by_member_id: 'member-2' }

  it("never matches, writes or journals another member's private contact; the new contact is flagged without the address", async () => {
    const db = seeded([PRIVATE], {}, { visibleTo: () => false })
    const batchId = await importAll(db, [person({ fullName: 'Sue Secret', emails: ['sue@example.com'], notes: 'from my list' })])
    expect(contacts(db).find((c) => c.id === 'c-secret')).toMatchObject({ notes: 'private notes', tags: [] })
    const [item] = items(db, batchId)
    expect(item).toMatchObject({ outcome: 'review', candidate_contact_id: null, match_type: 'hidden:email' })
    expect(JSON.stringify(item.changes)).not.toContain('private notes')
    expect(contacts(db).find((c) => c.id === item.contact_id)).toMatchObject({ full_name: 'Sue Secret', email: null })
  })

  it('a workspace admin sees and matches it', async () => {
    const db = seeded([PRIVATE])
    const batchId = await importAll(db, [person({ fullName: 'Sue Secret', emails: ['sue@example.com'] })], { userId: 'admin-1' })
    expect(items(db, batchId)[0]).toMatchObject({ outcome: 'matched', contact_id: 'c-secret' })
  })

  it("only the importer (or an admin) undoes a batch", async () => {
    const db = seeded()
    const batchId = await importAll(db, [person({ fullName: 'Ola Own' })])
    expect(await runUndo(db.client, { workspaceId: WS, batchId, userId: 'user-2' })).toEqual({ status: 'refused', error: 'Only the person who ran that import (or a workspace admin) can undo it.' })
    expect(await runUndo(db.client, { workspaceId: WS, batchId, userId: 'admin-1' })).toMatchObject({ status: 'done' })
  })
})

describe('addresses and source ids', () => {
  it("a household row never hands one person another's address", async () => {
    const db = seeded([
      { id: 'c-john', full_name: 'John Roe', email: 'john@example.com' },
      { id: 'c-jane', full_name: 'Jane Roe', email: 'jane@example.com' },
    ])
    await importAll(db, [person({ fullName: 'John Roe', emails: ['john@example.com', 'jane@example.com'] })])
    expect(contacts(db).find((c) => c.id === 'c-john')!.secondary_emails).toEqual([])
  })

  it("a source id is the account's own: two Brevo accounts' contact 5 are two people", async () => {
    const db = seeded()
    await importAll(db, [person({ externalId: '5', fullName: 'First Five', phones: ['626-555-0501'] })], { source: 'brevo', accountId: 'acct-a' })
    await importAll(db, [person({ externalId: '5', fullName: 'Other Five', phones: ['626-555-0502'] })], { source: 'brevo', accountId: 'acct-b' })
    expect(contacts(db).map((c) => c.full_name).sort()).toEqual(['First Five', 'Other Five'])
    expect(db.tables.crm_source_link.map((l) => l.external_id).sort()).toEqual(['acct-a:5', 'acct-b:5'])
  })

  it('a vCard UID reused for someone else is not taken as the same person', async () => {
    const db = seeded()
    await importAll(db, [person({ externalId: 'uid-1', fullName: 'Ann Able', phones: ['626-555-0601'] })], { source: 'vcard' })
    await importAll(db, [person({ externalId: 'uid-1', fullName: 'Bob Baker', phones: ['626-555-0602'] })], { source: 'vcard' })
    expect(contacts(db).map((c) => c.full_name).sort()).toEqual(['Ann Able', 'Bob Baker'])
  })
})

describe('a crash mid-item', () => {
  it('a retry finds the contact the item already inserted instead of making a second', async () => {
    const db = seeded()
    const created = await createImportBatch(db.client, { workspaceId: WS, userId: USER, source: 'spreadsheet', notify: false })
    if (!created.ok) throw new Error(created.error)
    await stageRecords(db.client, created.batch, [person({ fullName: 'Name Only' })])
    const item = db.tables.contact_import_item[0]
    // The insert landed, then the worker died before the item was marked.
    db.tables.contact.push(contactRow({ id: 'c-orphan', full_name: 'Name Only', source_provider: 'spreadsheet', metadata: { import_batch: created.batch.id, import_item: item.id } }))
    await applyPendingItems(db.client, created.batch.id)
    expect(contacts(db)).toHaveLength(1)
    expect(item).toMatchObject({ outcome: 'created', contact_id: 'c-orphan' })
  })

  it('an item that fails after its insert is journaled, and undo removes what it wrote', async () => {
    const db = seeded([], {}, { failInserts: ['contact_interaction'] })
    const batchId = await importAll(db, [person({ fullName: 'Half Done', history: [{ kind: 'job', title: 'Wash', occurredAt: '2025-01-01', amountCents: null, currency: null }] })])
    expect(items(db, batchId)[0]).toMatchObject({ outcome: 'failed', match_type: 'partial:created', contact_id: expect.any(String) })
    expect(contacts(db)).toHaveLength(1)
    await runUndo(db.client, { workspaceId: WS, batchId, userId: USER })
    expect(contacts(db)).toHaveLength(0)
  })
})

describe("a company's domain adoption", () => {
  it('undo gives the contacts the new company adopted back, then removes the company', async () => {
    // Migration 232's trigger: a new company takes the unassigned contacts at its domain.
    const adopt = (table: string, row: Record<string, unknown>, tables: Record<string, Array<Record<string, unknown>>>) => {
      if (table !== 'company' || !row.domain) return
      for (const c of tables.contact) if (!c.company_id && String(c.email ?? '').endsWith(`@${row.domain}`)) c.company_id = row.id
    }
    const db = seeded([{ id: 'c-own', full_name: 'Own Person', email: 'own@acme.com' }], {}, { afterInsert: adopt })
    const batchId = await importAll(db, [person({ fullName: 'Lu Chan', emails: ['lu@gmail.com'], company: { name: 'Acme', domain: 'acme.com' } })], { source: 'hubspot' })
    expect(contacts(db).find((c) => c.id === 'c-own')!.company_id).toBe(db.tables.company[0].id)
    await runUndo(db.client, { workspaceId: WS, batchId, userId: USER })
    expect(contacts(db).find((c) => c.id === 'c-own')!.company_id).toBeNull()
    expect(db.tables.company).toHaveLength(0)
  })
})

describe('repeat rows and jobs', () => {
  it('the same name with nothing else, row after row (an invoice per row), is one customer', async () => {
    const db = seeded()
    const batchId = await importAll(db, [
      person({ fullName: 'Jane Doe', history: [{ kind: 'invoice', title: 'Invoice', occurredAt: null, amountCents: 10000, currency: null }] }),
      person({ fullName: 'Jane Doe', history: [{ kind: 'invoice', title: 'Invoice', occurredAt: null, amountCents: 25000, currency: null }] }),
    ])
    expect(contacts(db)).toHaveLength(1)
    // Two undated invoices of different amounts are two rows.
    expect(db.tables.contact_interaction.map((r) => r.summary)).toEqual(['Invoice · $100.00', 'Invoice · $250.00'])
    expect((await loadImportBatch(db.client, batchId))?.counts).toMatchObject({ created: 1, repeat: 1, review: 0 })
  })

  it('importing the same file again adds no undated job twice', async () => {
    const db = seeded()
    const rows = [person({ fullName: 'Kay Lo', phones: ['626-555-0701'], history: [{ kind: 'job', title: 'Wash', occurredAt: null, amountCents: 5000, currency: null }] })]
    await importAll(db, rows)
    await importAll(db, rows)
    expect(db.tables.contact_interaction).toHaveLength(1)
  })
})

describe('text files in any encoding', () => {
  it('reads UTF-8, Windows-1252 and UTF-16', () => {
    expect(decodeText(new TextEncoder().encode('José'))).toBe('José')
    expect(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]))).toBe('José')
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x4a, 0x00, 0xe9, 0x00]))).toBe('Jé')
  })
})
