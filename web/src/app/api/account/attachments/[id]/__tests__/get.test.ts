/**
 * GET /api/account/attachments/[id]: a file's name and the record it hangs
 * off, for a mention of it to open that record. A file the caller may not
 * read (a teammate's, on their private capture) answers 404 as a missing one
 * does. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const BEN_CALL = 'c0000000-0000-4000-8000-000000000001'
const TASK = 'a0000000-0000-4000-8000-000000000001'
const OPEN_FILE = 'f0000000-0000-4000-8000-000000000001'
const PRIVATE_FILE = 'f0000000-0000-4000-8000-000000000002'

const hoisted = vi.hoisted(() => ({ auth: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: vi.fn(async () => hoisted.auth) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

import { GET } from '../route'

beforeEach(() => {
  const db = memoryDb({
    member: [{ id: 'm-ana', user_id: ANA, workspace_id: WS }],
    captures: [{ id: BEN_CALL, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
    attachments: [
      { id: OPEN_FILE, workspace_id: WS, user_id: BEN, note_id: null, action_id: TASK, project_id: null, file_name: 'menu.pdf' },
      { id: PRIVATE_FILE, workspace_id: WS, user_id: BEN, note_id: BEN_CALL, action_id: null, project_id: null, file_name: 'salary.xlsx' },
    ],
  })
  hoisted.auth = { supabase: db, user: { id: ANA }, workspaceId: WS }
})

const get = (id: string) => GET(new Request(`http://localhost/api/account/attachments/${id}`), { params: Promise.resolve({ id }) })

describe('GET /api/account/attachments/[id]', () => {
  it('answers the file and the record it hangs off', async () => {
    const res = await get(OPEN_FILE)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ attachment: { id: OPEN_FILE, file_name: 'menu.pdf', parent: { type: 'action', id: TASK } } })
  })

  it('404 for a file the caller may not read, as for a missing one; 400 for a bad id', async () => {
    expect((await get(PRIVATE_FILE)).status).toBe(404)
    expect((await get('f0000000-0000-4000-8000-0000000000ff')).status).toBe(404)
    expect((await get('nope')).status).toBe(400)
  })
})
