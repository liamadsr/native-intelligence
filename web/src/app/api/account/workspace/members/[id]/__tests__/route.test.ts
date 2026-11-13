/**
 * PATCH /api/account/workspace/members/[id]: who may change a role from
 * Settings → Members. The route says what migration 306 enforces in the
 * database: an owner or admin changes someone else's role among admin, member
 * and guest; nobody changes their own; the owner's row moves only through
 * transfer-owner. A refusal from the database's guard is a 403, not a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = { id: string; role: string }

const state = {
  caller: null as Row | null,
  target: null as Row | null,
  updateResult: { data: null as unknown, error: null as { message: string; code?: string } | null },
  callerLookups: [] as Record<string, unknown>[],
  targetLookups: [] as Record<string, unknown>[],
  updates: [] as { payload: unknown; filters: Record<string, unknown> }[],
  deleteResult: { data: [{ id: 'm-target' }] as unknown, error: null as { message: string } | null },
  deletes: [] as Record<string, unknown>[],
}

// One member-table chain per from('member'): the caller lookup ends in
// .single(), the target lookup in .maybeSingle(), the write is
// .update().eq().eq().select().single(), a removal is
// .delete().eq().eq().neq().select() awaited.
function memberChain() {
  let payload: unknown = undefined
  let isUpdate = false
  let isDelete = false
  const filters: Record<string, unknown> = {}
  const chain = {
    select: () => chain,
    update: (p: unknown) => {
      isUpdate = true
      payload = p
      return chain
    },
    delete: () => {
      isDelete = true
      return chain
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return chain
    },
    neq: (col: string, val: unknown) => {
      filters[`${col}<>`] = val
      return chain
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (!isDelete) throw new Error('only a removal is awaited without a terminal')
      state.deletes.push({ ...filters })
      return Promise.resolve(state.deleteResult).then(resolve)
    },
    single: async () => {
      if (isUpdate) {
        state.updates.push({ payload, filters: { ...filters } })
        return state.updateResult
      }
      state.callerLookups.push({ ...filters })
      return { data: state.caller, error: null }
    },
    maybeSingle: async () => {
      state.targetLookups.push({ ...filters })
      return { data: state.target, error: null }
    },
  }
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      if (table !== 'member') throw new Error(`unexpected table ${table}`)
      return memberChain()
    },
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
// Removal is remembered on the person's account first (join-by-domain never offers it again).
const marks = vi.hoisted(() => ({ recordLeftWorkspace: vi.fn(async (..._args: unknown[]) => {}) }))
vi.mock('@/lib/workspace-join/marks', () => ({ recordLeftWorkspace: marks.recordLeftWorkspace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))

import { DELETE, PATCH } from '../route'

function patch(id: string, role: unknown) {
  return PATCH({ json: async () => ({ role }) } as unknown as import('next/server').NextRequest, {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  state.caller = { id: 'm-caller', role: 'admin' }
  state.target = { id: 'm-target', role: 'member' }
  state.updateResult = { data: { id: 'm-target', role: 'guest' }, error: null }
  state.callerLookups = []
  state.targetLookups = []
  state.updates = []
  state.deleteResult = { data: [{ id: 'm-target' }], error: null }
  state.deletes = []
})

function remove(id: string) {
  return DELETE({} as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id }) })
}

describe('PATCH /api/account/workspace/members/[id]', () => {
  it('lets an admin move a member to another role, scoped to the workspace', async () => {
    const res = await patch('m-target', 'guest')
    expect(res.status).toBe(200)
    expect(state.callerLookups).toEqual([{ workspace_id: 'ws-1', user_id: 'user-1' }])
    expect(state.targetLookups).toEqual([{ id: 'm-target', workspace_id: 'ws-1' }])
    expect(state.updates).toEqual([{ payload: { role: 'guest' }, filters: { id: 'm-target', workspace_id: 'ws-1' } }])
    expect(await res.json()).toEqual({ member: { id: 'm-target', role: 'guest' } })
  })

  it('lets the owner change a member’s role', async () => {
    state.caller = { id: 'm-caller', role: 'owner' }
    const res = await patch('m-target', 'admin')
    expect(res.status).toBe(200)
    expect(state.updates).toHaveLength(1)
  })

  it('refuses an admin changing the owner’s role, before writing', async () => {
    state.target = { id: 'm-target', role: 'owner' }
    const res = await patch('m-target', 'member')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' })
    expect(state.updates).toHaveLength(0)
  })

  it('refuses the owner’s row to the owner too: ownership moves only by transfer', async () => {
    state.caller = { id: 'm-caller', role: 'owner' }
    state.target = { id: 'm-target', role: 'owner' }
    const res = await patch('m-target', 'admin')
    expect(res.status).toBe(403)
    expect(state.updates).toHaveLength(0)
  })

  it('refuses changing your own role', async () => {
    const res = await patch('m-caller', 'member')
    expect(res.status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  it('refuses members and guests', async () => {
    for (const role of ['member', 'guest']) {
      state.caller = { id: 'm-caller', role }
      const res = await patch('m-target', 'admin')
      expect(res.status).toBe(403)
    }
    expect(state.updates).toHaveLength(0)
  })

  it('never hands out owner here', async () => {
    state.caller = { id: 'm-caller', role: 'owner' }
    const res = await patch('m-target', 'owner')
    expect(res.status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  it('answers 404 for a member outside this workspace', async () => {
    state.target = null
    const res = await patch('m-elsewhere', 'guest')
    expect(res.status).toBe(404)
    expect(state.updates).toHaveLength(0)
  })

  it('turns a refusal from the database guard into a 403, not a 500', async () => {
    state.updateResult = {
      data: null,
      error: { code: '42501', message: "Only the owner can make someone owner or change the owner's role" },
    }
    const res = await patch('m-target', 'guest')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Insufficient permissions', code: 'FORBIDDEN' })
  })

  it('keeps any other database error a 500', async () => {
    state.updateResult = { data: null, error: { code: 'XX000', message: 'boom' } }
    const res = await patch('m-target', 'guest')
    expect(res.status).toBe(500)
  })
})

describe('DELETE /api/account/workspace/members/[id]', () => {
  beforeEach(() => {
    state.caller = { id: 'm-caller', role: 'owner' }
    marks.recordLeftWorkspace.mockReset()
    marks.recordLeftWorkspace.mockResolvedValue(undefined)
  })

  it('removed by the owner: remembered on their account before the row goes, however they joined', async () => {
    for (const joined_via of ['invite', 'link', 'domain', null]) {
      marks.recordLeftWorkspace.mockClear()
      state.deletes = []
      state.target = { id: 'm-target', role: 'member', user_id: 'user-riley', joined_via } as unknown as Row
      expect((await remove('m-target')).status).toBe(200)
      expect(marks.recordLeftWorkspace).toHaveBeenCalledWith({ service: true }, 'user-riley', 'ws-1')
      expect(state.deletes).toHaveLength(1)
    }
  })

  it('stays in when the removal cannot be remembered: a 500, nothing deleted', async () => {
    state.target = { id: 'm-target', role: 'member', user_id: 'user-riley' } as unknown as Row
    marks.recordLeftWorkspace.mockRejectedValueOnce(new Error('auth down'))
    expect((await remove('m-target')).status).toBe(500)
    expect(state.deletes).toHaveLength(0)
  })

  it('the owner removes a member: exactly that non-owner row in this workspace', async () => {
    const res = await remove('m-target')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(state.deletes).toEqual([{ id: 'm-target', workspace_id: 'ws-1', 'role<>': 'owner' }])
  })

  it('refuses anyone but the owner, admins included, before deleting', async () => {
    for (const role of ['admin', 'member', 'guest']) {
      state.caller = { id: 'm-caller', role }
      expect((await remove('m-target')).status).toBe(403)
    }
    expect(state.deletes).toHaveLength(0)
  })

  it('refuses removing yourself', async () => {
    expect((await remove('m-caller')).status).toBe(400)
    expect(state.deletes).toHaveLength(0)
  })

  it('nothing deleted (not in this workspace, or the owner) is a 404, never ok', async () => {
    state.deleteResult = { data: [], error: null }
    const res = await remove('m-elsewhere')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a database error is a 500 the dialog can show', async () => {
    state.deleteResult = { data: null, error: { message: 'boom' } }
    const res = await remove('m-target')
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'boom' })
  })
})
