/**
 * The agent's import tools (roadmap track G1): a texted spreadsheet is read,
 * the columns it can't map are the only questions, the import runs through
 * the one importer and its summary comes back to say; undo takes it back.
 * Only the person's own uploads are read, and an unattended turn imports
 * nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { contactRow, memDb } from '@/lib/crm/import/__tests__/mem-db'
import { createContactImportTools } from '../contact-import'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))

const USER = 'user-1'
const WS = 'ws-1'
const PATH = `${USER}/chat-uploads/0b6f.csv`
const CSV = ['Name,Phone,Email,Last Service,Rug Type', 'Ana Ruiz,(626) 555-0101,ana@example.com,3/1/2025,Persian', 'Ben Ode,626-555-0102,,1/10/2024,Kilim'].join('\n')

function setup(files: Record<string, string> = { [PATH]: CSV }) {
  const db = memDb({ contact: [contactRow({ id: 'c-ana', full_name: 'Ana Ruiz', email: 'ana@example.com' })], member: [{ id: 'm-1', user_id: USER, workspace_id: WS }], contact_interaction: [], company: [] })
  const client = {
    from: (db.client as unknown as { from: unknown }).from,
    rpc: (db.client as unknown as { rpc: unknown }).rpc,
    storage: {
      from: () => ({
        download: async (path: string) => (files[path] ? { data: new Blob([files[path]]), error: null } : { data: null, error: { message: 'not found' } }),
      }),
    },
  }
  return { db, client: client as never }
}

const call = async (tools: ReturnType<typeof createContactImportTools>, name: keyof ReturnType<typeof createContactImportTools>, input: Record<string, unknown>) =>
  (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })

describe('contact import tools', () => {
  it('read_contact_file maps what it can and asks only about the rest', async () => {
    const { client } = setup()
    const tools = createContactImportTools(USER, client, WS)
    const out = await call(tools, 'read_contact_file', { storage_path: PATH, file_name: 'customers.csv' })
    expect(out).toMatchObject({ success: true, format: 'spreadsheet', rows: 2, unmapped: [{ column: '#5', header: expect.stringContaining('Rug Type'), samples: [expect.stringContaining('Persian'), expect.stringContaining('Kilim')] }] })
  })

  it('import_contact_file imports with their answers, dedupes against the CRM, and returns the summary to say', async () => {
    const { client, db } = setup()
    const tools = createContactImportTools(USER, client, WS)
    const out = await call(tools, 'import_contact_file', { storage_path: PATH, file_name: 'customers.csv', columns: { '#5': 'note' } })
    expect(out).toMatchObject({ success: true, status: 'done', imported: 2 })
    expect(out.summary).toBe('2 customers imported from customers.csv: 1 matched ones you had. Nothing was sent to anyone. Text "undo import" to take it all back.')
    expect(db.tables.contact).toHaveLength(2)
    const ben = db.tables.contact.find((c) => c.full_name === 'Ben Ode')!
    expect(ben).toMatchObject({ phone: '+16265550102', notes: 'Rug Type: Kilim', relationship_type: 'customer', last_interaction_at: '2024-01-10T00:00:00.000Z' })

    const undone = await call(tools, 'undo_contact_import', {})
    expect(undone).toMatchObject({ success: true, status: 'done', summary: 'Undid the import from customers.csv: removed 1 contact it added and put back what it changed on 1 contact you had.' })
    expect(db.tables.contact.map((c) => c.id)).toEqual(['c-ana'])
    expect(db.tables.contact[0].phone).toBeNull()
  })

  it("never reads a file outside the person's own uploads", async () => {
    const { client } = setup({ 'someone-else/chat-uploads/x.csv': CSV })
    const tools = createContactImportTools(USER, client, WS)
    const out = await call(tools, 'read_contact_file', { storage_path: 'someone-else/chat-uploads/x.csv' })
    expect(out).toMatchObject({ success: false })
    expect(await call(tools, 'read_contact_file', { storage_path: `${USER}/chat-uploads/../../x.csv` })).toMatchObject({ success: false })
  })

  it('an unattended turn imports and undoes nothing', async () => {
    const { client, db } = setup()
    const tools = createContactImportTools(USER, client, WS, { unattended: true })
    expect(await call(tools, 'import_contact_file', { storage_path: PATH })).toMatchObject({ success: false })
    expect(await call(tools, 'undo_contact_import', {})).toMatchObject({ success: false })
    expect(db.tables.contact).toHaveLength(1)
  })
})
