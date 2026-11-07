/**
 * PATCH /api/account/workspace/agent-autonomy/teammates/[id] (plan Part 5 row
 * 9): a teammate's role and autonomy. Owner/admin only; validated; a system
 * teammate is 409; 'attempt' adds 'internal-write' when missing and never
 * removes a class; scoped to the request's workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  auth: null as unknown,
  row: null as Record<string, unknown> | null,
  update: null as Record<string, unknown> | null,
  eqs: [] as Array<[string, unknown]>,
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: async () => h.auth }))

function session() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (col: string, v: unknown) => {
        h.eqs.push([col, v])
        return chain
      }
      chain.maybeSingle = async () => ({ data: h.row, error: null })
      chain.update = (vals: Record<string, unknown>) => {
        h.update = vals
        const u: Record<string, unknown> = {}
        u.eq = (col: string, v: unknown) => {
          h.eqs.push([col, v])
          return u
        }
        u.select = async () => ({ data: h.row ? [{ ...h.row, ...vals }] : [], error: null })
        return u
      }
      return chain
    },
  }
}

import { PATCH } from '../route'

const patch = (body: unknown, id = 'tm-1') =>
  PATCH(new Request(`http://x/api/account/workspace/agent-autonomy/teammates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }) as never, {
    params: Promise.resolve({ id }),
  })
const asRole = (role: string) => {
  h.auth = { supabase: session(), user: { id: 'u1' }, workspaceId: 'ws-1', member: { id: 'm1', role } }
}

beforeEach(() => {
  asRole('admin')
  h.row = { id: 'tm-1', is_system: false, allowed_side_effects: ['read'] }
  h.update = null
  h.eqs = []
})

describe('teammate role and autonomy', () => {
  it('sets the role, scoped to this workspace', async () => {
    const res = await patch({ role: 'writer' })
    expect(res.status).toBe(200)
    expect(h.update).toEqual({ role: 'writer' })
    expect(h.eqs).toContainEqual(['workspace_id', 'ws-1'])
    expect((await patch({ role: null })).status).toBe(200)
    expect(h.update).toEqual({ role: null })
  })

  it('attempt adds internal-write when missing, and keeps the other classes', async () => {
    await patch({ autonomy: 'attempt' })
    expect(h.update).toEqual({ autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'] })
    h.row = { id: 'tm-1', is_system: false, allowed_side_effects: ['read', 'internal-write', 'delete'] }
    await patch({ autonomy: 'attempt' })
    expect(h.update).toEqual({ autonomy: 'attempt' })
  })

  it('propose and off never touch the classes', async () => {
    h.row = { id: 'tm-1', is_system: false, allowed_side_effects: ['read', 'internal-write'] }
    await patch({ autonomy: 'propose' })
    expect(h.update).toEqual({ autonomy: 'propose' })
    await patch({ autonomy: 'off' })
    expect(h.update).toEqual({ autonomy: 'off' })
  })

  it('refuses members, bad values, empty bodies, system teammates and strangers', async () => {
    asRole('member')
    expect((await patch({ role: 'writer' })).status).toBe(403)
    asRole('owner')
    expect((await patch({ role: 'astronaut' })).status).toBe(400)
    expect((await patch({ autonomy: 'always' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    h.row = { id: 'tm-1', is_system: true, allowed_side_effects: ['read'] }
    const sys = await patch({ autonomy: 'attempt' })
    expect(sys.status).toBe(409)
    expect((await sys.json()).code).toBe('SYSTEM_TEAMMATE')
    h.row = null
    expect((await patch({ role: 'writer' })).status).toBe(404)
    expect(h.update).toBeNull()
  })
})

// bots-v4 B1, decision 12: owners and admins choose per bot between "Read only"
// and "Read, and change Dial8 records"; never an outside write.
describe('what a bot may change on its own', () => {
  it('an admin sets read and internal writes, or read only', async () => {
    let res = await patch({ allowed_side_effects: ['read', 'internal-write'] })
    expect(res.status).toBe(200)
    expect(h.update).toEqual({ allowed_side_effects: ['read', 'internal-write'] })
    h.row = { id: 'tm-1', is_system: false, allowed_side_effects: ['read', 'internal-write'] }
    res = await patch({ allowed_side_effects: ['read'] })
    expect(res.status).toBe(200)
    expect(h.update).toEqual({ allowed_side_effects: ['read'] })
    expect(h.eqs).toContainEqual(['workspace_id', 'ws-1'])
  })

  it('never past internal writes: an outside write, a delete or a bare write is a 400', async () => {
    asRole('owner')
    for (const bad of [['read', 'external-write'], ['read', 'internal-write', 'external-write'], ['read', 'delete'], ['internal-write'], [], 'read']) {
      expect((await patch({ allowed_side_effects: bad })).status, JSON.stringify(bad)).toBe(400)
    }
    expect(h.update).toBeNull()
  })

  it('only owners and admins: a member, a team lead included, is refused', async () => {
    asRole('member')
    expect((await patch({ allowed_side_effects: ['read', 'internal-write'] })).status).toBe(403)
    expect(h.update).toBeNull()
  })

  it('a system teammate and a work bot keep theirs (409)', async () => {
    h.row = { id: 'tm-1', is_system: true, allowed_side_effects: ['read'] }
    expect((await patch({ allowed_side_effects: ['read', 'internal-write'] })).status).toBe(409)
    h.row = { id: 'tm-1', is_system: false, fronts_only: true, allowed_side_effects: ['read'] }
    const res = await patch({ allowed_side_effects: ['read', 'internal-write'] })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('WORK_BOT')
    expect(h.update).toBeNull()
  })

  it('attempt still needs internal writes, whatever else is asked with it', async () => {
    await patch({ autonomy: 'attempt', allowed_side_effects: ['read'] })
    expect(h.update).toEqual({ autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'] })
  })
})
