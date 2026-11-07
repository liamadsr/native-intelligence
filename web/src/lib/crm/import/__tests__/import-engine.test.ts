/**
 * The one import path (roadmap track G0) against an in-memory database:
 * records staged, matched with the merge engine, written without overwriting
 * the owner's own fields, journaled, summarized, and undone as a whole.
 */
import { describe, expect, it, vi } from 'vitest'
import { applyPendingItems, createImportBatch, loadImportBatch, stageRecords } from '../batch'
import { finishImportBatch } from '../finish'
import type { ImportContactRecord } from '../record'
import { runImport, runUndo } from '../run'
import { finishUndo, startUndo, undoImportItems } from '../undo'
import { contactRow, memDb } from './mem-db'

const WS = 'ws-1'
const USER = 'user-1'

function seeded(contacts: Array<Record<string, unknown>> = []) {
  return memDb({
    contact: contacts.map(contactRow),
    member: [{ id: 'member-1', user_id: USER, workspace_id: WS }],
    contact_interaction: [],
    company: [],
  })
}

const person = (r: Partial<ImportContactRecord>): ImportContactRecord => ({ kind: 'contact', ...r })

async function importAll(db: ReturnType<typeof memDb>, records: ImportContactRecord[], source: 'spreadsheet' | 'hubspot' | 'google_contacts' = 'spreadsheet') {
  const created = await createImportBatch(db.client, { workspaceId: WS, userId: USER, source, label: 'customers.csv', notify: true })
  if (!created.ok) throw new Error(created.error)
  await stageRecords(db.client, created.batch, records)
  for (;;) {
    const { remaining } = await applyPendingItems(db.client, created.batch.id, { limit: 2 })
    if (!remaining) break
  }
  const told: string[] = []
  const finished = await finishImportBatch(db.client, created.batch.id, {
    appendHome: vi.fn(async () => ({ written: true }) as never),
    text: vi.fn(async (_db, args: { body: string }) => (told.push(args.body), { sent: true })),
  })
  return { batchId: created.batch.id, summary: finished.summary, told }
}

const contacts = (db: ReturnType<typeof memDb>) => db.tables.contact

describe('import engine', () => {
  it('creates new customers tagged with their source, with no source_provider-less rows (never pushed out)', async () => {
    const db = seeded()
    const { summary, told } = await importAll(db, [
      person({ fullName: 'Ana Ruiz', emails: ['ANA@example.com'], phones: ['(626) 555-0101'], address: '12 Elm St, Pasadena, CA 91101', relationship: 'customer' }),
      person({ fullName: 'Ben Ode', phones: ['626-555-0102'], relationship: 'customer' }),
    ])
    expect(contacts(db)).toHaveLength(2)
    const ana = contacts(db).find((c) => c.full_name === 'Ana Ruiz')!
    expect(ana).toMatchObject({
      email: 'ana@example.com',
      phone: '+16265550101',
      address: '12 Elm St, Pasadena, CA 91101',
      relationship_type: 'customer',
      source: 'import',
      source_provider: 'spreadsheet',
      visibility: 'workspace',
      created_by_member_id: 'member-1',
    })
    expect(ana.tags).toEqual(['from spreadsheet'])
    expect(contacts(db).every((c) => c.source_provider)).toBe(true)
    expect(summary).toBe('2 customers imported from customers.csv. Nothing was sent to anyone. Text "undo import" to take it all back.')
    expect(told).toEqual([summary])
  })

  it('matches people the workspace already has (email, phone) and fills only what is missing', async () => {
    const db = seeded([
      { id: 'c-ana', full_name: 'Ana Ruiz', email: 'ana@example.com', phone: null, notes: 'Prefers mornings', job_title: 'Owner', tags: ['vip'] },
      { id: 'c-ben', full_name: 'Ben Ode', phone: '+16265550102', email: null },
    ])
    const { batchId, summary } = await importAll(db, [
      person({ fullName: 'Ana Ruiz', emails: ['ana@example.com'], phones: ['626 555 0101'], jobTitle: 'Designer', notes: 'Two Persian rugs', relationship: 'customer' }),
      person({ fullName: 'Ben Ode', emails: ['ben@example.com'], phones: ['+1 626 555 0102'], relationship: 'customer' }),
      person({ fullName: 'Cleo Park', emails: ['cleo@example.com'], relationship: 'customer' }),
    ])
    expect(contacts(db)).toHaveLength(3)
    const ana = contacts(db).find((c) => c.id === 'c-ana')!
    // Filled: the phone was empty. Kept: the owner's job title. Added: tags and notes.
    expect(ana.phone).toBe('+16265550101')
    expect(ana.job_title).toBe('Owner')
    expect(ana.tags).toEqual(['vip', 'from spreadsheet'])
    expect(ana.notes).toBe('Prefers mornings\n\nFrom the spreadsheet: Two Persian rugs')
    expect(ana.relationship_type).toBe('customer')
    const ben = contacts(db).find((c) => c.id === 'c-ben')!
    expect(ben.email).toBe('ben@example.com')
    const batch = await loadImportBatch(db.client, batchId)
    expect(batch?.counts).toMatchObject({ created: 1, matched: 2, review: 0, customers: 3 })
    expect(summary).toContain('3 customers imported from customers.csv: 2 matched ones you had.')
  })

  it('never overwrites a field the owner edited, but refreshes one the same source wrote', async () => {
    const db = seeded()
    await importAll(db, [person({ fullName: 'Dee Lane', emails: ['dee@example.com'], address: '1 Old Rd', jobTitle: 'Chef' })])
    const dee = contacts(db)[0]
    // The owner fixes the job title by hand; the address stays as the import wrote it.
    dee.job_title = 'Head chef'
    await importAll(db, [person({ fullName: 'Dee Lane', emails: ['dee@example.com'], address: '9 New Ave', jobTitle: 'Line cook' })])
    expect(contacts(db)).toHaveLength(1)
    expect(dee.address).toBe('9 New Ave')
    expect(dee.job_title).toBe('Head chef')
    // Another source never refreshes what this one wrote.
    await importAll(db, [person({ fullName: 'Dee Lane', emails: ['dee@example.com'], address: '5 Other St' })], 'google_contacts')
    expect(dee.address).toBe('9 New Ave')
  })

  it('folds the same person twice in one file into one contact, with both past jobs', async () => {
    const db = seeded()
    const { batchId, summary } = await importAll(db, [
      person({ fullName: 'Eve Moss', phones: ['626-555-0109'], history: [{ kind: 'job', title: 'Wash 8x10 Persian', occurredAt: '2025-03-01', amountCents: 48000, currency: null }] }),
      person({ fullName: 'Eve Moss', phones: ['(626) 555-0109'], history: [{ kind: 'job', title: 'Fringe repair', occurredAt: '2025-09-12', amountCents: 12000, currency: null }] }),
    ])
    expect(contacts(db)).toHaveLength(1)
    const jobs = db.tables.contact_interaction.filter((r) => r.interaction_type === 'past_job')
    expect(jobs.map((j) => [j.title, j.summary])).toEqual([
      ['Wash 8x10 Persian', 'Job · $480.00'],
      ['Fringe repair', 'Job · $120.00'],
    ])
    expect(contacts(db)[0].last_interaction_at).toBe('2025-09-12T00:00:00.000Z')
    const batch = await loadImportBatch(db.client, batchId)
    expect(batch?.counts).toMatchObject({ created: 1, repeat: 1, history: 2 })
    expect(summary).toMatch(/^1 contact imported from customers\.csv\. 2 past jobs on their timelines\./)
  })

  it('flags a maybe-the-same person to check instead of merging (same name, different everything)', async () => {
    const db = seeded([{ id: 'c-fay', full_name: 'Fay Hill', email: 'fay@work.com' }])
    const { batchId, summary } = await importAll(db, [person({ fullName: 'Fay Hill', emails: ['fay.h@gmail.com'] })])
    expect(contacts(db)).toHaveLength(2)
    const item = db.tables.contact_import_item.find((i) => i.batch_id === batchId)!
    expect(item).toMatchObject({ outcome: 'review', candidate_contact_id: 'c-fay', match_type: 'suggest:name' })
    expect(summary).toContain('1 contact imported from customers.csv: 1 to check.')
  })

  it('keeps two people who share one email apart, the address with the one who had it', async () => {
    const db = seeded([{ id: 'c-jo', full_name: 'Jo Smith', email: 'smiths@example.com' }])
    await importAll(db, [person({ fullName: 'Kim Smith', emails: ['smiths@example.com'], phones: ['626-555-0110'] })])
    const kim = contacts(db).find((c) => c.full_name === 'Kim Smith')!
    expect(kim.email).toBeNull()
    expect(kim.phone).toBe('+16265550110')
    expect(contacts(db).find((c) => c.id === 'c-jo')!.full_name).toBe('Jo Smith')
  })

  it('skips rows that name nobody and says so', async () => {
    const db = seeded()
    const { summary } = await importAll(db, [person({ notes: 'just a note' }), person({ fullName: 'Gus Lee' })])
    expect(contacts(db)).toHaveLength(1)
    expect(summary).toContain('1 row had no name, email or phone and was skipped.')
  })

  it('finds the same contact again by the source id on a second import', async () => {
    const db = seeded()
    await importAll(db, [person({ externalId: 'people/c1', fullName: 'Hal Roe', emails: ['hal@example.com'] })], 'google_contacts')
    await importAll(db, [person({ externalId: 'people/c1', fullName: 'Hal Roe', emails: ['hal.roe@new.com'] })], 'google_contacts')
    expect(contacts(db)).toHaveLength(1)
    expect(contacts(db)[0].secondary_emails).toEqual(['hal.roe@new.com'])
  })

  it("a source's email unsubscribe suppresses outreach to them, and undo keeps it", async () => {
    const db = seeded()
    const { batchId } = await importAll(db, [person({ fullName: 'Opt Out', emails: ['Out@Example.com'], tags: ['unsubscribed email'] }), person({ fullName: 'Opt Out', emails: ['out@example.com'], tags: ['unsubscribed email'] })], 'google_contacts')
    expect(db.tables.outreach_suppression).toEqual([expect.objectContaining({ workspace_id: WS, email: 'out@example.com', reason: 'opted_out', created_by: USER })])
    await runUndo(db.client, { workspaceId: WS, batchId })
    expect(db.tables.outreach_suppression).toHaveLength(1)
  })

  it('tells the owner once, however often finish runs', async () => {
    const db = seeded()
    const created = await createImportBatch(db.client, { workspaceId: WS, userId: USER, source: 'spreadsheet', notify: true })
    if (!created.ok) throw new Error(created.error)
    await stageRecords(db.client, created.batch, [person({ fullName: 'Ivy Ng' })])
    await applyPendingItems(db.client, created.batch.id)
    const text = vi.fn(async () => ({ sent: true }))
    const appendHome = vi.fn(async () => ({ written: true }) as never)
    await finishImportBatch(db.client, created.batch.id, { text, appendHome })
    await finishImportBatch(db.client, created.batch.id, { text, appendHome })
    expect(text).toHaveBeenCalledTimes(1)
    expect(appendHome).toHaveBeenCalledTimes(1)
  })
})

describe('undo', () => {
  it('takes the whole import back: new contacts gone, matched ones restored, edits since kept', async () => {
    const db = seeded([{ id: 'c-ana', full_name: 'Ana Ruiz', email: 'ana@example.com', phone: null, tags: ['vip'] }])
    const { batchId } = await importAll(db, [
      person({ fullName: 'Ana Ruiz', emails: ['ana@example.com'], phones: ['626 555 0101'], address: '12 Elm St', history: [{ kind: 'job', title: 'Wash', occurredAt: '2025-01-01', amountCents: null, currency: null }] }),
      person({ fullName: 'New Person', emails: ['new@example.com'] }),
      person({ fullName: 'Worked With', emails: ['worked@example.com'] }),
    ])
    expect(contacts(db)).toHaveLength(3)
    const ana = contacts(db).find((c) => c.id === 'c-ana')!
    // After the import, the owner edits Ana's address by hand, and emails the third person.
    ana.address = '14 Elm St'
    const worked = contacts(db).find((c) => c.email === 'worked@example.com')!
    db.tables.email_thread_index = [{ id: 't-1', linked_contact_id: worked.id }]

    const started = await startUndo(db.client, batchId, WS)
    expect(started.ok).toBe(true)
    await undoImportItems(db.client, batchId)
    const { tallies } = await finishUndo(db.client, batchId)

    expect(tallies).toEqual({ removed: 1, restored: 1, kept: 1 })
    expect(contacts(db).map((c) => c.email).sort()).toEqual(['ana@example.com', 'worked@example.com'])
    expect(ana.phone).toBeNull()
    expect(ana.address).toBe('14 Elm St') // edited since: stays
    expect(ana.tags).toEqual(['vip'])
    expect(db.tables.contact_interaction).toHaveLength(0)
    expect(worked.tags).toEqual([])
    expect((await loadImportBatch(db.client, batchId))?.status).toBe('undone')
    expect((await startUndo(db.client, batchId, WS)).ok).toBe(false)
  })

  it('removes the companies it created once nothing points at them', async () => {
    const db = seeded()
    const { batchId } = await importAll(db, [person({ fullName: 'Lu Chan', emails: ['lu@acme.com'], company: { name: 'Acme Rugs', domain: 'acme.com' } })])
    expect(db.tables.company).toHaveLength(1)
    expect(contacts(db)[0].company_id).toBe(db.tables.company[0].id)
    const undone = await runUndo(db.client, { workspaceId: WS, batchId })
    expect(undone).toEqual({ status: 'done', text: 'Undid the import from customers.csv: removed 1 contact it added.' })
    expect(db.tables.company).toHaveLength(0)
    expect(db.tables.crm_source_link ?? []).toHaveLength(0)
  })

  it('refuses another workspace’s batch', async () => {
    const db = seeded()
    const { batchId } = await importAll(db, [person({ fullName: 'Max Orr' })])
    expect(await startUndo(db.client, batchId, 'ws-other')).toEqual({ ok: false, error: 'No import with that id in this workspace.' })
  })
})

describe('runImport', () => {
  it('applies a small import inline and returns the summary for the agent to say (no second text)', async () => {
    const db = seeded()
    const send = vi.fn(async () => undefined)
    const out = await runImport(db.client, { workspaceId: WS, userId: USER, source: 'vcard', label: 'contacts.vcf', records: [person({ fullName: 'Nia Fox', phones: ['626-555-0111'] })] }, { send })
    expect(out).toMatchObject({ status: 'done', imported: 1 })
    expect(send).not.toHaveBeenCalled()
    const batch = db.tables.contact_import_batch[0]
    expect(batch).toMatchObject({ status: 'done', notify: false })
  })

  it('sends a large import to the background', async () => {
    const db = seeded()
    const send = vi.fn(async () => undefined)
    const records = Array.from({ length: 151 }, (_, i) => person({ fullName: `Person ${i}`, emails: [`p${i}@example.com`] }))
    const out = await runImport(db.client, { workspaceId: WS, userId: USER, source: 'spreadsheet', records }, { send })
    expect(out).toMatchObject({ status: 'running', total: 151 })
    expect(send).toHaveBeenCalledWith({ name: 'crm/import.apply', data: { batchId: expect.any(String), workspaceId: WS } })
    expect(db.tables.contact_import_item).toHaveLength(151)
    expect(contacts(db)).toHaveLength(0)
  })
})
