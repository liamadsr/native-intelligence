/**
 * define_custom_field and set_custom_fields on every kind the registry gives
 * fields (phase 6). The tools run on a service-role client here (no RLS), so
 * the edit rule they ask first is the only fence: a record the person may
 * only view is never written.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDealTools } from '../deals'
import { getToolDefinition } from '../../tool-registry'
import { CUSTOM_FIELD_ENTITIES } from '@/lib/crm/custom-fields'
import { fakeRecordsDb } from '@/test/records-db-fake'

vi.mock('@/lib/workspace/product-doc', () => ({ readProductDocPointer: () => null }))

const WS = 'ws-1'
const USER = 'user-b'

type Exec = (input: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>>
const exec = (tools: ReturnType<typeof createDealTools>, name: 'define_custom_field' | 'set_custom_fields') =>
  (tools[name] as unknown as { execute: Exec }).execute

function setup(rpcs: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  const f = fakeRecordsDb(
    {
      custom_field_definition: [
        { id: 'd1', workspace_id: WS, entity_type: 'action', key: 'customer', label: 'Customer', field_type: 'text', options: [], position: 0 },
        { id: 'd2', workspace_id: WS, entity_type: 'company', key: 'tier', label: 'Tier', field_type: 'select', options: ['Gold', 'Silver'], position: 0 },
        { id: 'd3', workspace_id: WS, entity_type: 'contact', key: 'tier', label: 'Tier', field_type: 'select', options: ['Gold', 'Silver'], position: 0 },
      ],
      member: [{ id: 'm-b', workspace_id: WS, user_id: USER, role: 'member' }],
      actions: [{ id: 't1', workspace_id: WS, custom_fields: {} }],
      company: [{ id: 'co-granted', workspace_id: WS, custom_fields: {} }],
      contact: [{ id: 'c-granted', workspace_id: WS, custom_fields: {} }],
    },
    { rpcs },
  )
  return { f, tools: createDealTools(USER, f as never, WS) }
}

describe('custom field tools on every kind', () => {
  it('take exactly the registry’s kinds, and say so', () => {
    const { tools } = setup()
    for (const name of ['define_custom_field', 'set_custom_fields'] as const) {
      const schema = (tools[name] as unknown as { inputSchema: z.ZodObject<{ entity_type: z.ZodEnum }> }).inputSchema
      expect(schema.shape.entity_type.options, name).toEqual([...CUSTOM_FIELD_ENTITIES])
      const description = (tools[name] as { description?: string }).description ?? ''
      expect(description, name).toContain('task')
      expect(description, name).toContain('document')
      expect(getToolDefinition(name)!.description, name).toContain('task')
    }
  })

  it('define_custom_field adds a field to tasks', async () => {
    const { f, tools } = setup()
    const out = await exec(tools, 'define_custom_field')({ entity_type: 'action', label: 'Sprint goal', field_type: 'text' }, {})
    expect(out).toMatchObject({ success: true, message: 'Added "Sprint goal" to tasks.' })
    expect(f.tables.custom_field_definition.at(-1)).toMatchObject({ entity_type: 'action', key: 'sprint_goal' })
  })

  it('set_custom_fields writes a task the person may edit', async () => {
    const { f, tools } = setup()
    const out = await exec(tools, 'set_custom_fields')({ entity_type: 'action', id: 't1', values: { Customer: 'Fernhill Studio' } }, {})
    expect(out).toEqual({ success: true, custom_fields: { customer: 'Fernhill Studio' } })
    expect(f.writes).toHaveLength(1)
  })

  it('never writes a contact or company the person sees only through a view grant', async () => {
    // The grant-armed twins would say yes; the write gates ask the ungranted ones.
    const { f, tools } = setup({
      contact_visible_to: () => true,
      company_visible_to: () => true,
      contact_editable_by: () => false,
      company_visible_to_ungranted: () => false,
    })
    const company = await exec(tools, 'set_custom_fields')({ entity_type: 'company', id: 'co-granted', values: { Tier: 'Gold' } }, {})
    expect(company).toEqual({ success: false, error: 'Company not found' })
    const contact = await exec(tools, 'set_custom_fields')({ entity_type: 'contact', id: 'c-granted', values: { Tier: 'Gold' } }, {})
    // Seen (through the grant) but not editable: refused as such.
    expect(contact).toEqual({ success: false, error: "You can't edit this contact" })
    expect(f.writes).toEqual([])
    expect(f.rpcCalls.map((c) => c.fn)).toEqual(['company_visible_to_ungranted', 'contact_editable_by', 'contact_visible_to'])
  })

  it("never writes a contact the person can see but not edit (a view share, a teammate's team contact)", async () => {
    // Before 498 the gate asked the READ rule (contact_visible_to_ungranted), which says yes here.
    const { f, tools } = setup({
      contact_visible_to: () => true,
      contact_visible_to_ungranted: () => true,
      contact_editable_by: () => false,
    })
    const out = await exec(tools, 'set_custom_fields')({ entity_type: 'contact', id: 'c-granted', values: { Tier: 'Gold' } }, {})
    expect(out).toEqual({ success: false, error: "You can't edit this contact" })
    expect(f.writes).toEqual([])
    expect(f.rpcCalls.map((c) => c.fn)).not.toContain('contact_visible_to_ungranted')
  })

  it('says not found for a record in no workspace of theirs', async () => {
    const { tools } = setup()
    const out = await exec(tools, 'set_custom_fields')({ entity_type: 'project', id: 'p-nowhere', values: { a: 1 } }, {})
    expect(out).toEqual({ success: false, error: 'Project not found' })
  })
})
