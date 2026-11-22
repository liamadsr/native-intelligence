/**
 * The folder routes (Drive folders, migration 690): members only, never a
 * guest; names and ids checked before the database; the database's refusals
 * (its guards, migration 690) answered with their own status. Supabase is a
 * stub that records what each route asks of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  role: 'member' as string,
  result: { data: null as unknown, error: null as null | { code?: string; message?: string } },
  calls: [] as Array<{ table: string; op: string; arg?: unknown }>,
}))

function chain(table: string) {
  const c: Record<string, unknown> = {}
  const self = new Proxy(c, {
    get(_t, prop: string) {
      if (prop === 'then') return (cb: (v: unknown) => unknown) => Promise.resolve(h.result).then(cb)
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(h.result)
      return (arg?: unknown) => {
        if (['insert', 'update', 'upsert', 'delete'].includes(prop)) h.calls.push({ table, op: prop, arg })
        return self
      }
    },
  })
  return self
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: { from: (t: string) => chain(t) },
    user: { id: 'u1' },
    workspaceId: 'ws-1',
    member: { id: 'm-1', role: h.role },
  }),
}))

import { GET as listGET, POST as folderPOST } from '../route'
import { PATCH, DELETE as folderDELETE } from '../[id]/route'
import { POST as itemsPOST, DELETE as itemsDELETE } from '../[id]/items/route'

const F = '11111111-1111-4111-8111-111111111111'
const D = '22222222-2222-4222-8222-222222222222'
const req = (body?: unknown, method = 'POST') =>
  new NextRequest('http://localhost/api/account/folders', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
const params = (id = F) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  h.role = 'member'
  h.result = { data: null, error: null }
  h.calls.length = 0
})

describe('the folder routes', () => {
  it('refuse a guest, writing nothing', async () => {
    h.role = 'guest'
    expect((await listGET()).status).toBe(403)
    expect((await folderPOST(req({ name: 'Clients' }))).status).toBe(403)
    expect((await itemsPOST(req({ type: 'document', id: D }), params())).status).toBe(403)
    expect(h.calls).toEqual([])
  })

  it('make a folder as the caller, trimmed, inside a parent when given', async () => {
    h.result = { data: { id: F, name: 'Clients' }, error: null }
    const res = await folderPOST(req({ name: '  Clients ', parent_id: D }))
    expect(res.status).toBe(201)
    expect(h.calls).toEqual([{ table: 'drive_folder', op: 'insert', arg: { workspace_id: 'ws-1', name: 'Clients', parent_id: D, created_by: 'm-1' } }])
  })

  it('refuse an empty name or a parent that is no id, before the database', async () => {
    expect((await folderPOST(req({ name: '   ' }))).status).toBe(400)
    expect((await folderPOST(req({ name: 'x', parent_id: 'nope' }))).status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it('answer the database’s guard with its own status', async () => {
    h.result = { data: null, error: { code: '42501', message: 'A folder sits in a folder of its own workspace.' } }
    const res = await folderPOST(req({ name: 'x', parent_id: D }))
    expect(res.status).toBe(403)
    h.result = { data: null, error: { code: '23514', message: 'A folder cannot sit inside itself.' } }
    expect((await PATCH(req({ parent_id: D }, 'PATCH'), params())).status).toBe(400)
  })

  it('rename or move only: nothing else about a folder is sent', async () => {
    h.result = { data: { id: F }, error: null }
    await PATCH(req({ name: 'Renamed', parent_id: null, workspace_id: 'ws-2', created_by: 'm-9' }, 'PATCH'), params())
    expect(h.calls).toEqual([{ table: 'drive_folder', op: 'update', arg: { name: 'Renamed', parent_id: null } }])
    expect((await PATCH(req({ parent_id: F }, 'PATCH'), params())).status).toBe(400)
    expect((await PATCH(req({}, 'PATCH'), params())).status).toBe(400)
  })

  it('file only a doc, table, spreadsheet or canvas, by id, moving it if it sat elsewhere', async () => {
    expect((await itemsPOST(req({ type: 'contact', id: D }), params())).status).toBe(400)
    expect((await itemsPOST(req({ type: 'document', id: 'nope' }), params())).status).toBe(400)
    expect(h.calls).toEqual([])
    expect((await itemsPOST(req({ type: 'document', id: D }), params())).status).toBe(200)
    expect(h.calls).toEqual([{ table: 'drive_folder_item', op: 'upsert', arg: { item_type: 'document', item_id: D, folder_id: F, workspace_id: 'ws-1' } }])
  })

  it('a record the caller can’t open is refused by the database, and says so', async () => {
    h.result = { data: null, error: { code: '42501', message: 'Only a record one can open is filed, in its own workspace.' } }
    const res = await itemsPOST(req({ type: 'document', id: D }), params())
    expect(res.status).toBe(403)
  })

  it('take a record out, and delete a folder only where row security lets the delete through', async () => {
    expect((await itemsDELETE(req({ type: 'canvas', id: D }, 'DELETE'), params())).status).toBe(200)
    h.result = { data: [], error: null }
    // Seen but not deleted (someone else's): 403. The stub answers the follow-up read with the same empty list, so: 404 here.
    expect([403, 404]).toContain((await folderDELETE(req(undefined, 'DELETE'), params())).status)
    h.result = { data: [{ id: F }], error: null }
    expect((await folderDELETE(req(undefined, 'DELETE'), params())).status).toBe(200)
  })

  it('a folder id that is no uuid is simply not found', async () => {
    expect((await PATCH(req({ name: 'x' }, 'PATCH'), params('nope'))).status).toBe(404)
    expect((await itemsPOST(req({ type: 'document', id: D }), params('nope'))).status).toBe(404)
  })
})
