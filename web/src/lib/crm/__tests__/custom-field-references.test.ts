/**
 * The custom field checks that need the database (Tables, phase 2): a person
 * is a member, a relation links only what the writer can read (a table's
 * rows through the table's own rule), only what a write adds is checked, and
 * a contact takes values of the new types through setRecordCustomFields.
 * Made-up records.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeRecordsDb } from '@/test/records-db-fake'
import { fieldReferenceCheck, fieldValueLabels, referenceProblem } from '../custom-field-references'
import { setRecordCustomFields } from '../custom-fields'

vi.mock('@/lib/workspace/product-doc', () => ({ readProductDocPointer: () => null }))

const WS = 'ws-1'
const USER = 'user-a'
const MEMBER = 'a0000000-0000-4000-8000-000000000001'
const STRANGER = 'a0000000-0000-4000-8000-000000000099'
const DEAL = 'd0000000-0000-4000-8000-000000000001'
const OTHER_DEAL = 'd0000000-0000-4000-8000-000000000002'
const OPEN_ROW = 'e0000000-0000-4000-8000-000000000001'
const PRIVATE_ROW = 'e0000000-0000-4000-8000-000000000002'
const TABLE = 'f0000000-0000-4000-8000-000000000001'
const PRIVATE_TABLE = 'f0000000-0000-4000-8000-000000000002'
const CONTACT = 'c0000000-0000-4000-8000-000000000001'

const db = (f: ReturnType<typeof fakeRecordsDb>) => f as unknown as SupabaseClient

function world() {
  return fakeRecordsDb(
    {
      member: [{ id: MEMBER, workspace_id: WS, user_id: USER, display_name: 'Robin' }],
      flow: [
        { id: DEAL, workspace_id: WS, name: 'Fernhill renewal' },
        { id: OTHER_DEAL, workspace_id: 'ws-2', name: 'Elsewhere' },
      ],
      data_row: [
        { id: OPEN_ROW, workspace_id: WS, table_id: TABLE, title: 'Open row' },
        { id: PRIVATE_ROW, workspace_id: WS, table_id: PRIVATE_TABLE, title: 'Private row' },
      ],
      data_table: [{ id: TABLE, workspace_id: WS }, { id: PRIVATE_TABLE, workspace_id: WS }],
      custom_field_definition: [],
      contact: [{ id: CONTACT, workspace_id: WS, custom_fields: { existing: [OTHER_DEAL] } }],
    },
    {
      // The writer reads TABLE, not PRIVATE_TABLE (520's visible_data_table_ids).
      rpcs: { visible_data_table_ids: (args) => (args.p_ids as string[]).filter((id) => id === TABLE) },
    },
  )
}

const defs = [
  { key: 'owner', label: 'Owner', field_type: 'person' as const, config: {} },
  { key: 'deals', label: 'Deals', field_type: 'relation' as const, config: { target: { kind: 'flow' as const }, multiple: true } },
  { key: 'rows', label: 'Rows', field_type: 'relation' as const, config: { target: { kind: 'data_row' as const, table_id: TABLE }, multiple: true } },
  { key: 'secret', label: 'Secret', field_type: 'relation' as const, config: { target: { kind: 'data_row' as const, table_id: PRIVATE_TABLE } } },
]
const scope = { workspaceId: WS, userId: USER }
const check = (after: Record<string, unknown>, before: Record<string, unknown> = {}, self?: string) =>
  referenceProblem(db(world()), scope, defs, [{ before, after, self }])

describe('referenceProblem', () => {
  it('takes a member of the workspace as a person, and refuses anyone else', async () => {
    expect(await check({ owner: MEMBER })).toBeNull()
    expect(await check({ owner: STRANGER })).toBe('Owner takes a member of this workspace.')
  })

  it('links a record of the target kind in the workspace, never one elsewhere', async () => {
    expect(await check({ deals: [DEAL] })).toBeNull()
    expect(await check({ deals: [DEAL, OTHER_DEAL] })).toBe("Deals links a record that isn't one you can link to.")
  })

  it('links a table’s rows only from that table, and only when the writer reads the table', async () => {
    expect(await check({ rows: [OPEN_ROW] })).toBeNull()
    expect(await check({ rows: [PRIVATE_ROW] })).toBe("Rows links a record that isn't one you can link to.")
    expect(await check({ secret: [PRIVATE_ROW] })).toBe("Secret links a record that isn't one you can link to.")
  })

  it('checks only what the write adds: an id already there passes, whoever put it', async () => {
    expect(await check({ deals: [OTHER_DEAL, DEAL] }, { deals: [OTHER_DEAL] })).toBeNull()
    expect(await check({ rows: [PRIVATE_ROW] }, { rows: [PRIVATE_ROW] })).toBeNull()
  })

  it('refuses a record linked to itself', async () => {
    expect(await check({ rows: [OPEN_ROW] }, {}, OPEN_ROW)).toBe("Rows can't link a record to itself.")
  })
})

describe('a contact’s fields of the new types', () => {
  const contactDefs = [
    { id: 'd1', workspace_id: WS, entity_type: 'contact', key: 'vip', label: 'VIP', field_type: 'checkbox', options: [], config: {}, position: 0 },
    { id: 'd2', workspace_id: WS, entity_type: 'contact', key: 'budget', label: 'Budget', field_type: 'currency', options: [], config: { currency: 'EUR' }, position: 1 },
    { id: 'd3', workspace_id: WS, entity_type: 'contact', key: 'existing', label: 'Deals', field_type: 'relation', options: [], config: { target: { kind: 'flow' }, multiple: true }, position: 2 },
  ]

  it('stores each in its type’s form, and keeps an id already there', async () => {
    const f = world()
    f.tables.custom_field_definition = contactDefs
    const result = await setRecordCustomFields(db(f), WS, 'contact', CONTACT, { vip: 'yes', budget: '1,200', Deals: [OTHER_DEAL, DEAL] }, {
      checkReferences: fieldReferenceCheck(db(f), scope),
    })
    expect(result).toEqual({ ok: true, custom_fields: { existing: [OTHER_DEAL, DEAL], vip: true, budget: { amount: 1200, currency: 'EUR' } } })
  })

  it('refuses a new link the writer may not make, and writes nothing', async () => {
    const f = world()
    f.tables.custom_field_definition = contactDefs
    f.tables.contact[0].custom_fields = {}
    const result = await setRecordCustomFields(db(f), WS, 'contact', CONTACT, { Deals: [OTHER_DEAL] }, { checkReferences: fieldReferenceCheck(db(f), scope) })
    expect(result).toEqual({ ok: false, reason: 'invalid', error: "Deals links a record that isn't one you can link to." })
    expect(f.writes).toEqual([])
  })
})

describe('fieldValueLabels', () => {
  it('names the people and the linked records the values hold', async () => {
    const labels = await fieldValueLabels(db(world()), WS, defs, [{ owner: MEMBER, deals: [DEAL] }])
    expect(labels).toEqual({ [MEMBER]: 'Robin', [DEAL]: 'Fernhill renewal' })
  })
})
