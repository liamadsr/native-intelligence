/**
 * Custom fields on any kind (the shared entity layer, phase 6): the kinds
 * are the registry's `customFields` flag, values are checked by the same
 * rules on every kind, a write that RLS refuses is a refusal (never a silent
 * success), and the service-role gate asks each kind's own edit rule.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'
import { fakeRecordsDb } from '@/test/records-db-fake'
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_KIND_NOUNS,
  customFieldKindList,
  customFieldTable,
  isCustomFieldEntity,
  setRecordCustomFields,
} from '../custom-fields'
import { customFieldWriteRefusal } from '../custom-field-access'

vi.mock('@/lib/workspace/product-doc', () => ({ readProductDocPointer: () => null }))

const WS = 'ws-1'
const USER = 'user-b'
const db = (f: ReturnType<typeof fakeRecordsDb>) => f as unknown as SupabaseClient

const tierDef = (entity_type: string) => ({
  id: `def-${entity_type}`,
  workspace_id: WS,
  entity_type,
  key: 'tier',
  label: 'Tier',
  field_type: 'select',
  options: ['Gold', 'Silver'],
  position: 0,
})

describe('the kinds come from the registry flag', () => {
  it('is exactly the registry entries marked customFields, in registry order', () => {
    expect([...CUSTOM_FIELD_ENTITIES]).toEqual(ENTITY_REGISTRY.filter((e) => e.customFields).map((e) => e.id))
    expect(new Set(CUSTOM_FIELD_ENTITIES)).toEqual(new Set(['deal', 'contact', 'company', 'action', 'project', 'initiative', 'document']))
  })

  it('names every kind, and reads each from its own table', () => {
    for (const k of CUSTOM_FIELD_ENTITIES) {
      expect(CUSTOM_FIELD_KIND_NOUNS[k].one).toMatch(/^[a-z]+$/)
      expect(customFieldTable(k)).toBe(ENTITY_REGISTRY.find((e) => e.id === k)!.table)
    }
    expect(customFieldTable('action')).toBe('actions')
    expect(customFieldTable('project')).toBe('projects')
    expect(customFieldKindList('one', 'or')).toBe('document, contact, project, task, initiative, company or deal')
  })

  it('refuses a kind without the flag', () => {
    expect(isCustomFieldEntity('action')).toBe(true)
    expect(isCustomFieldEntity('capture')).toBe(false)
    expect(isCustomFieldEntity('calendar_event')).toBe(false)
    expect(isCustomFieldEntity(null)).toBe(false)
  })
})

describe('setRecordCustomFields on the work kinds', () => {
  it('checks a task value against the task definitions and writes the actions table', async () => {
    const f = fakeRecordsDb({
      custom_field_definition: [tierDef('action'), tierDef('contact')],
      actions: [{ id: 't1', workspace_id: WS, custom_fields: { other: 1 } }],
    })
    const result = await setRecordCustomFields(db(f), WS, 'action', 't1', { tier: 'gold' })
    expect(result).toEqual({ ok: true, custom_fields: { other: 1, tier: 'Gold' } })
    expect(f.writes).toEqual([{ table: 'actions', id: 't1', patch: { custom_fields: { other: 1, tier: 'Gold' } } }])
  })

  it('refuses a value that does not fit, and a field the kind does not have', async () => {
    const f = fakeRecordsDb({
      custom_field_definition: [tierDef('project')],
      projects: [{ id: 'p1', workspace_id: WS, custom_fields: {} }],
    })
    expect(await setRecordCustomFields(db(f), WS, 'project', 'p1', { tier: 'bronze' })).toEqual({
      ok: false,
      error: 'Tier is one of: Gold, Silver',
      reason: 'invalid',
    })
    const unknown = await setRecordCustomFields(db(f), WS, 'project', 'p1', { budget: 5 })
    expect(unknown).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.writes).toEqual([])
  })

  it('says not found in the kind’s own word', async () => {
    const f = fakeRecordsDb({ custom_field_definition: [tierDef('initiative')], initiative: [] })
    expect(await setRecordCustomFields(db(f), WS, 'initiative', 'i1', { tier: 'Gold' })).toEqual({
      ok: false,
      error: 'Initiative not found',
      reason: 'not_found',
    })
  })

  it('is forbidden, not a silent success, when RLS lets the row be read but not changed', async () => {
    const f = fakeRecordsDb(
      {
        custom_field_definition: [tierDef('document')],
        document: [{ id: 'd1', workspace_id: WS, custom_fields: {} }],
      },
      { canWrite: () => false },
    )
    expect(await setRecordCustomFields(db(f), WS, 'document', 'd1', { tier: 'Gold' })).toEqual({
      ok: false,
      error: "You can't edit this document",
      reason: 'forbidden',
    })
  })
})

describe('customFieldWriteRefusal: each kind’s own edit rule', () => {
  it('task and project: any member of the record’s workspace', async () => {
    const f = fakeRecordsDb({
      member: [{ id: 'm-b', workspace_id: WS, user_id: USER, role: 'member' }],
      actions: [{ id: 't1', workspace_id: WS }],
      projects: [{ id: 'p1', workspace_id: 'ws-other' }],
    })
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'action', 't1')).toBeNull()
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'project', 'p1')).toEqual({ reason: 'not_found', error: 'Project not found' })
    expect(await customFieldWriteRefusal(db(f), 'stranger', WS, 'action', 't1')).toEqual({ reason: 'not_found', error: 'Task not found' })
  })

  it('initiative: an owner or admin, or its own owner', async () => {
    const tables = {
      member: [
        { id: 'm-b', workspace_id: WS, user_id: USER, role: 'member' },
        { id: 'm-a', workspace_id: WS, user_id: 'user-a', role: 'admin' },
      ],
      initiative: [
        { id: 'i-mine', workspace_id: WS, owner_id: 'm-b' },
        { id: 'i-theirs', workspace_id: WS, owner_id: 'm-a' },
      ],
    }
    const f = fakeRecordsDb(tables)
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'initiative', 'i-mine')).toBeNull()
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'initiative', 'i-theirs')).toEqual({
      reason: 'forbidden',
      error: "You can't edit this initiative",
    })
    expect(await customFieldWriteRefusal(db(f), 'user-a', WS, 'initiative', 'i-theirs')).toBeNull()
  })

  it('contact and company: the twins without the grant arm, failing closed', async () => {
    const f = fakeRecordsDb(
      {},
      {
        rpcs: {
          contact_visible_to_ungranted: (a) => a.p_contact_id === 'c-own',
          company_visible_to_ungranted: (a) => a.p_company_id === 'co-own',
        },
      },
    )
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'contact', 'c-own')).toBeNull()
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'contact', 'c-granted')).toEqual({ reason: 'not_found', error: 'Contact not found' })
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'company', 'co-own')).toBeNull()
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'company', 'co-granted')).toEqual({ reason: 'not_found', error: 'Company not found' })
    expect(f.rpcCalls.map((c) => c.fn)).toEqual([
      'contact_visible_to_ungranted',
      'contact_visible_to_ungranted',
      'company_visible_to_ungranted',
      'company_visible_to_ungranted',
    ])
    // An rpc that errors refuses.
    const broken = fakeRecordsDb({}, { rpcs: {} })
    expect(await customFieldWriteRefusal(db(broken), USER, WS, 'company', 'co-own')).toMatchObject({ reason: 'not_found' })
  })

  it('document: the document edit rule; a private one is its creator’s, a grant never edits', async () => {
    const doc = (id: string, over: Record<string, unknown>) => ({
      id,
      workspace_id: WS,
      created_by: 'm-a',
      type: 'note',
      slug: null,
      published_status: 'draft',
      frontmatter: {},
      project_id: null,
      status: 'active',
      canon_key: null,
      visibility: 'workspace',
      ...over,
    })
    const f = fakeRecordsDb({
      member: [
        { id: 'm-b', workspace_id: WS, user_id: USER, role: 'member', workspace: { settings: {} } },
        { id: 'm-a', workspace_id: WS, user_id: 'user-a', role: 'member', workspace: { settings: {} } },
      ],
      document: [
        doc('d-mine', { created_by: 'm-b' }),
        doc('d-theirs', {}),
        // A's private document, which B could read only through a grant.
        doc('d-private', { visibility: 'private' }),
      ],
    })
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'document', 'd-mine')).toBeNull()
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'document', 'd-theirs')).toMatchObject({ reason: 'forbidden' })
    expect(await customFieldWriteRefusal(db(f), USER, WS, 'document', 'd-private')).toEqual({ reason: 'not_found', error: 'Document not found' })
    expect(await customFieldWriteRefusal(db(f), 'user-a', WS, 'document', 'd-private')).toBeNull()
  })
})
