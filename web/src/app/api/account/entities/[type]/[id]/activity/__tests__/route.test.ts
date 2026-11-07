/**
 * GET /api/account/entities/[type]/[id]/activity (rows 10 and 12): the eight
 * entity kinds only, a uuid id, the caller's session client and workspace, and a
 * failed read is a 500, never an empty tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: h.supabase, user: { id: 'u1' }, workspaceId: 'w1' }) }))

import { GET } from '../route'

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100'
const get = (type: string, id = ID) => GET(new Request('http://x') as never, { params: Promise.resolve({ type, id }) })
let fake: FakeSupabase

beforeEach(() => {
  fake = makeFakeSupabase()
  h.supabase = fake
})

describe('entity activity route', () => {
  it('reads the entity’s rows in the caller’s workspace', async () => {
    fake.seed('work_touch', [{ workspace_id: 'w1', work_item_id: 'j1', agent_run_id: null, entity_type: 'project', entity_id: ID, verb: 'read', tool_name: null, at: '2026-09-27T09:00:00Z' }])
    fake.seed('tracked_job', [{ id: 'j1', workspace_id: 'w1', title: 'Weekly brief', status: 'done', kind: 'work_run' }])
    const res = await get('project')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspace_id).toBe('w1')
    expect(body.hidden).toBe(0)
    expect(body.rows.map((r: { work_item_id: string }) => r.work_item_id)).toEqual(['j1'])
    const touchRead = fake.calls.find((c) => c.table === 'work_touch')!
    expect(touchRead.filters).toEqual(expect.arrayContaining([['workspace_id', 'w1'], ['entity_type', 'project'], ['entity_id', ID]]))
  })

  it('takes the row-12 kinds too (document, company, initiative, email thread)', async () => {
    for (const type of ['document', 'company', 'initiative', 'email_thread']) {
      expect((await get(type)).status).toBe(200)
      expect(fake.calls.filter((c) => c.table === 'work_touch').at(-1)!.filters).toEqual(expect.arrayContaining([['entity_type', type]]))
    }
  })

  it('refuses another kind or a malformed id', async () => {
    expect((await get('email_draft')).status).toBe(400)
    expect((await get('sequence')).status).toBe(400)
    expect((await get('contact', 'not-a-uuid')).status).toBe(400)
  })

  it('a failed read is a 500', async () => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.order = () => chain
    chain.limit = async () => ({ data: null, error: { message: 'boom' } })
    h.supabase = { from: () => chain }
    expect((await get('capture')).status).toBe(500)
  })
})
