/**
 * PATCH /api/account/custom-fields (Tables, phase 2): a kind's field changes
 * type through change_custom_field_type (526), and a type change is undone
 * through undo_custom_field_change. The RPCs are the fake's; what they do is
 * pinned in src/lib/tables/__tests__/migration-523-526.test.ts and was run
 * on DEV.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { fakeRecordsDb, type FakeRecordsDb } from '@/test/records-db-fake'

const WS = 'ws-1'
const USER = 'user-b'
const FIELD = '44444444-4444-4444-8444-444444444444'
const CHANGE = '55555555-5555-4555-8555-555555555555'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/workspace/product-doc', () => ({ readProductDocPointer: () => null }))

const { PATCH } = await import('@/app/api/account/custom-fields/route')

let f: FakeRecordsDb
beforeEach(() => {
  const def = { id: FIELD, workspace_id: WS, entity_type: 'company', key: 'score', label: 'Score', field_type: 'text', options: [], config: {}, position: 0, table_id: null }
  f = fakeRecordsDb(
    { custom_field_definition: [def] },
    {
      rpcs: {
        change_custom_field_type: (args) => {
          def.field_type = String(args.p_field_type)
          return { change_id: CHANGE, converted: 2, definition_id: FIELD }
        },
        undo_custom_field_change: () => {
          def.field_type = 'text'
          return { change_id: '66666666-6666-4666-8666-666666666666', converted: 2, definition_id: FIELD }
        },
      },
    },
  )
  hoisted.requireWorkspace.mockResolvedValue({ supabase: f, user: { id: USER }, workspaceId: WS })
})

const patch = (body: unknown) => buildRequest({ url: 'https://x.test/api/account/custom-fields', method: 'PATCH', body }) as unknown as NextRequest

describe('PATCH /api/account/custom-fields', () => {
  it('changes a field’s type and answers the change to undo', async () => {
    const res = await PATCH(patch({ id: FIELD, field_type: 'currency', config: { currency: 'eur' } }))
    expect(res.status).toBe(200)
    const json = await readJson<{ change_id: string; converted: number; field: { field_type: string } }>(res)
    expect(json).toMatchObject({ change_id: CHANGE, converted: 2, field: { field_type: 'currency' } })
    expect(f.rpcCalls).toEqual([
      { fn: 'change_custom_field_type', args: { p_definition_id: FIELD, p_field_type: 'currency', p_options: [], p_config: { currency: 'EUR' }, p_as_user: null } },
    ])
  })

  it('undoes a type change', async () => {
    const res = await PATCH(patch({ undo: CHANGE }))
    expect(res.status).toBe(200)
    expect((await readJson<{ field: { field_type: string } }>(res)).field.field_type).toBe('text')
    expect(f.rpcCalls.map((c) => c.fn)).toEqual(['undo_custom_field_change'])
  })

  it('refuses a setting the type does not take, a field not there, and a body without either', async () => {
    expect((await PATCH(patch({ id: FIELD, field_type: 'currency', config: { currency: 'EURO' } }))).status).toBe(400)
    expect((await PATCH(patch({ id: '77777777-7777-4777-8777-777777777777', field_type: 'number' }))).status).toBe(404)
    expect((await PATCH(patch({ field_type: 'number' }))).status).toBe(400)
    expect(f.rpcCalls).toEqual([])
  })
})
