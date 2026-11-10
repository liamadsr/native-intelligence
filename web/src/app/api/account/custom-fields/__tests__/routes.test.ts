/**
 * The custom field routes on every kind the registry gives fields (phase 6):
 * GET/POST /api/account/custom-fields and /api/account/custom-fields/values.
 * The session client's RLS is played by the fake's `canWrite`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { fakeRecordsDb, type FakeRecordsDb } from '@/test/records-db-fake'

const WS = 'ws-1'
const USER = 'user-b'
const TASK = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const INIT = '33333333-3333-4333-8333-333333333333'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), db: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/workspace/product-doc', () => ({ readProductDocPointer: () => null }))

const { GET: listFields, POST: defineField } = await import('@/app/api/account/custom-fields/route')
const { GET: getValues, POST: setValues } = await import('@/app/api/account/custom-fields/values/route')

const def = (entity_type: string, key = 'customer', label = 'Customer') => ({
  id: `def-${entity_type}-${key}`,
  workspace_id: WS,
  entity_type,
  key,
  label,
  field_type: 'text',
  options: [],
  position: 0,
})

let f: FakeRecordsDb
function seed(canWrite?: (table: string, row: Record<string, unknown>) => boolean) {
  f = fakeRecordsDb(
    {
      custom_field_definition: [def('action'), def('deal', 'region', 'Region')],
      member: [{ id: 'm-b', workspace_id: WS, user_id: USER, role: 'member', workspace: { settings: {} } }],
      actions: [{ id: TASK, workspace_id: WS, custom_fields: { customer: 'Fernhill Studio' } }],
      document: [
        {
          id: DOC,
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
          custom_fields: {},
        },
      ],
      initiative: [{ id: INIT, workspace_id: WS, owner_id: 'm-a', custom_fields: {} }],
    },
    { canWrite },
  )
  hoisted.requireWorkspace.mockResolvedValue({ supabase: f, user: { id: USER }, workspaceId: WS })
}

const get = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const post = (url: string, body: unknown) => buildRequest({ url, method: 'POST', body }) as unknown as NextRequest

beforeEach(() => seed())

describe('GET /api/account/custom-fields', () => {
  it('lists a work kind’s fields, and refuses a kind without the flag', async () => {
    const res = await listFields(get('https://x.test/api/account/custom-fields?entity_type=action'))
    expect(res.status).toBe(200)
    expect((await readJson<{ fields: Array<{ key: string }> }>(res)).fields.map((d) => d.key)).toEqual(['customer'])
    const bad = await listFields(get('https://x.test/api/account/custom-fields?entity_type=capture'))
    expect(bad.status).toBe(400)
    expect((await readJson<{ error: string }>(bad)).error).toContain('action')
  })
})

describe('POST /api/account/custom-fields', () => {
  it('defines a field on projects', async () => {
    const res = await defineField(post('https://x.test/api/account/custom-fields', { entity_type: 'project', label: 'Budget', field_type: 'number' }))
    expect(res.status).toBe(201)
    expect(f.tables.custom_field_definition.at(-1)).toMatchObject({ entity_type: 'project', key: 'budget', field_type: 'number' })
  })

  it('refuses a kind without the flag', async () => {
    const res = await defineField(post('https://x.test/api/account/custom-fields', { entity_type: 'calendar_event', label: 'Room', field_type: 'text' }))
    expect(res.status).toBe(400)
  })
})

describe('/api/account/custom-fields/values', () => {
  it('reads a task’s fields with their values, editable', async () => {
    const res = await getValues(get(`https://x.test/api/account/custom-fields/values?entity_type=action&id=${TASK}`))
    expect(res.status).toBe(200)
    const json = await readJson<{ fields: unknown[]; editable: boolean }>(res)
    expect(json.fields).toEqual([{ key: 'customer', label: 'Customer', field_type: 'text', value: 'Fernhill Studio' }])
    expect(json.editable).toBe(true)
  })

  it('says a record the caller may not change is not editable', async () => {
    f.tables.custom_field_definition.push(def('initiative'))
    const res = await getValues(get(`https://x.test/api/account/custom-fields/values?entity_type=initiative&id=${INIT}`))
    expect((await readJson<{ editable: boolean }>(res)).editable).toBe(false)
  })

  it('sets a task’s field through the same validation', async () => {
    const res = await setValues(post('https://x.test/api/account/custom-fields/values', { entity_type: 'action', id: TASK, values: { Customer: 'Pinecrest Bakery' } }))
    expect(res.status).toBe(200)
    expect((await readJson<{ custom_fields: unknown }>(res)).custom_fields).toEqual({ customer: 'Pinecrest Bakery' })
    expect(f.writes).toEqual([{ table: 'actions', id: TASK, patch: { custom_fields: { customer: 'Pinecrest Bakery' } } }])
    const unknown = await setValues(post('https://x.test/api/account/custom-fields/values', { entity_type: 'action', id: TASK, values: { Budget: 4 } }))
    expect(unknown.status).toBe(400)
  })

  it('refuses a record the caller may not edit with a 403 before writing', async () => {
    f.tables.custom_field_definition.push(def('initiative'), def('document'))
    const init = await setValues(post('https://x.test/api/account/custom-fields/values', { entity_type: 'initiative', id: INIT, values: { Customer: 'x' } }))
    expect(init.status).toBe(403)
    const doc = await setValues(post('https://x.test/api/account/custom-fields/values', { entity_type: 'document', id: DOC, values: { Customer: 'x' } }))
    expect(doc.status).toBe(403)
    expect(f.writes).toEqual([])
  })

  it('is a 403, not a silent success, when RLS changes no row', async () => {
    seed(() => false)
    const res = await setValues(post('https://x.test/api/account/custom-fields/values', { entity_type: 'action', id: TASK, values: { Customer: 'x' } }))
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe("You can't edit this task")
  })

  it('refuses a kind without the flag and a record that is not there', async () => {
    const bad = await setValues(post('https://x.test/api/account/custom-fields/values', { entity_type: 'capture', id: TASK, values: { a: 1 } }))
    expect(bad.status).toBe(400)
    const missing = await getValues(get(`https://x.test/api/account/custom-fields/values?entity_type=project&id=${TASK}`))
    expect(missing.status).toBe(404)
  })
})
