/**
 * /api/account/profile — and the account-level "Show all workspaces" answer it
 * carries (lib/workspace-span), which is how the switch follows the user to
 * every device and desktop window.
 *
 *  • GET reports `show_all_workspaces` from `user_metadata`: the boolean when
 *    saved, `null` when the account has never saved one (the client then
 *    carries its device's answer up) — never a non-boolean.
 *  • PATCH saves it through the ADMIN API, keyed on the user `getUser()`
 *    verified: `auth.updateUser` needs the cookie session, which goes stale in
 *    the desktop app's extra windows. Only that key is sent, so the rest of
 *    `user_metadata` is untouched (GoTrue merges key by key).
 *  • A non-boolean is a 400, and nothing is written; a failed save is a 500.
 *  • `full_name` saves exactly as before, and is independent of the switch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; created_at: string; user_metadata: Record<string, unknown> },
  updateUser: vi.fn(),
  updateUserById: vi.fn(),
  memberUpdate: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: hoisted.user } }),
      updateUser: hoisted.updateUser,
    },
  }),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    auth: { admin: { updateUserById: hoisted.updateUserById } },
    from: () => ({
      update: (patch: unknown) => ({
        eq: (col: string, val: unknown) => {
          hoisted.memberUpdate(patch, col, val)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: vi.fn() }))

const { GET, PATCH } = await import('@/app/api/account/profile/route')

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/profile',
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

/** A response's JSON body. */
const body = (res: Response) => readJson<Record<string, unknown>>(res)

function signedIn(user_metadata: Record<string, unknown> = {}) {
  hoisted.user = { id: 'user-1', email: 'liam@example.com', created_at: '2026-01-01T00:00:00Z', user_metadata }
}

beforeEach(() => {
  hoisted.updateUser.mockReset().mockResolvedValue({ error: null })
  hoisted.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null })
  hoisted.memberUpdate.mockReset()
  signedIn({ full_name: 'Liam' })
})

describe('GET /api/account/profile — show_all_workspaces', () => {
  it('reports a saved answer', async () => {
    signedIn({ show_all_workspaces: true })
    expect((await body(await GET())).show_all_workspaces).toBe(true)
    signedIn({ show_all_workspaces: false })
    expect((await body(await GET())).show_all_workspaces).toBe(false)
  })

  it('reports null for an account that never saved one, or holds junk', async () => {
    expect((await body(await GET())).show_all_workspaces).toBeNull()
    signedIn({ show_all_workspaces: 'yes' })
    expect((await body(await GET())).show_all_workspaces).toBeNull()
  })

  it('still answers 401 when signed out', async () => {
    hoisted.user = null
    expect((await GET()).status).toBe(401)
  })
})

describe('PATCH /api/account/profile — show_all_workspaces', () => {
  it('saves it through the admin API, that key alone, for the verified user', async () => {
    const res = await PATCH(patchReq({ show_all_workspaces: true }))
    expect(res.status).toBe(200)
    expect(hoisted.updateUserById).toHaveBeenCalledWith('user-1', {
      user_metadata: { show_all_workspaces: true },
    })
    // Not the session-bound update, and no member rows touched.
    expect(hoisted.updateUser).not.toHaveBeenCalled()
    expect(hoisted.memberUpdate).not.toHaveBeenCalled()
  })

  it('saves false as an answer, not as an absence', async () => {
    await PATCH(patchReq({ show_all_workspaces: false }))
    expect(hoisted.updateUserById).toHaveBeenCalledWith('user-1', {
      user_metadata: { show_all_workspaces: false },
    })
  })

  it('refuses a non-boolean with 400 and writes nothing', async () => {
    for (const value of ['true', 1, null, { on: true }]) {
      const res = await PATCH(patchReq({ show_all_workspaces: value }))
      expect(res.status).toBe(400)
      expect((await body(res)).error).toBe('show_all_workspaces must be a boolean')
    }
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })

  it('answers 500 when the save fails', async () => {
    hoisted.updateUserById.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await PATCH(patchReq({ show_all_workspaces: true }))
    expect(res.status).toBe(500)
  })

  it('answers 401 when signed out, and writes nothing', async () => {
    hoisted.user = null
    expect((await PATCH(patchReq({ show_all_workspaces: true }))).status).toBe(401)
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })

  it('leaves the name path as it was, and independent of the switch', async () => {
    await PATCH(patchReq({ full_name: 'Liam A' }))
    expect(hoisted.updateUser).toHaveBeenCalledWith({ data: { full_name: 'Liam A' } })
    expect(hoisted.memberUpdate).toHaveBeenCalledWith({ display_name: 'Liam A' }, 'user_id', 'user-1')
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })
})

describe('the agent’s look and name on the account', () => {
  const look = { type: 'cat', color: '#9a62ff', shading: 'plastic', face: 'eyes', glasses: 'round', hat: 'crown', headphones: true, bowTie: false }

  it('the GET reports them checked, and null for an account with none, or junk', async () => {
    let res = await body(await GET())
    expect(res.agent_look).toBeNull()
    expect(res.assistant_name).toBeNull()
    signedIn({ agent_look: look, assistant_name: '  Ada ' })
    res = await body(await GET())
    expect(res.agent_look).toEqual({ ...look, color: '#9A62FF' })
    expect(res.assistant_name).toBe('Ada')
    signedIn({ agent_look: { type: 'robot' }, assistant_name: 'R2-D2' })
    res = await body(await GET())
    expect(res.agent_look).toBeNull()
    expect(res.assistant_name).toBeNull()
  })

  it('the PATCH saves them checked through the admin API, in one write with the switch', async () => {
    const res = await PATCH(patchReq({ agent_look: { ...look, glasses: 'laser' }, assistant_name: '  Mary-Jane ', show_all_workspaces: true }))
    expect(res.status).toBe(200)
    expect(hoisted.updateUserById).toHaveBeenCalledTimes(1)
    expect(hoisted.updateUserById).toHaveBeenCalledWith('user-1', {
      user_metadata: { show_all_workspaces: true, agent_look: { ...look, color: '#9A62FF', glasses: 'none' }, assistant_name: 'Mary-Jane' },
    })
    expect(hoisted.updateUser).not.toHaveBeenCalled()
  })

  it('refuses what isn’t a look or a name with 400, and writes nothing', async () => {
    for (const bad of [{ agent_look: { type: 'robot' } }, { agent_look: null }, { assistant_name: 'R2-D2' }, { assistant_name: 7 }, { assistant_name: '   ' }]) {
      expect((await PATCH(patchReq(bad))).status).toBe(400)
    }
    expect((await body(await PATCH(patchReq({ assistant_name: 'R2-D2' })))).error).toBe('Use letters, spaces, hyphens and apostrophes only.')
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })

  it('answers 500 when the save fails', async () => {
    hoisted.updateUserById.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect((await PATCH(patchReq({ assistant_name: 'Ada' }))).status).toBe(500)
  })
})

describe('the app rail’s bar on the account (rail_pages)', () => {
  it('the GET reports it checked, and null for an account with none, or junk', async () => {
    expect((await body(await GET())).rail_pages).toBeNull()
    signedIn({ rail_pages: { order: ['mail', 'docs', 'mail'], hidden: ['deals'] } })
    expect((await body(await GET())).rail_pages).toEqual({ order: ['mail', 'docs'], hidden: ['deals'] })
    signedIn({ rail_pages: { order: 'mail' } })
    expect((await body(await GET())).rail_pages).toBeNull()
  })

  it('the PATCH saves it through the admin API, that key alone', async () => {
    const res = await PATCH(patchReq({ rail_pages: { order: ['calendar', 'mail'], hidden: [] } }))
    expect(res.status).toBe(200)
    expect(hoisted.updateUserById).toHaveBeenCalledWith('user-1', { user_metadata: { rail_pages: { order: ['calendar', 'mail'], hidden: [] } } })
  })

  it('refuses what isn’t two short lists of page ids with 400, and writes nothing', async () => {
    const many = Array.from({ length: 65 }, (_, i) => `page-${i}`)
    for (const bad of [
      null,
      ['mail'],
      { order: 'mail' },
      { order: [7] },
      { order: ['Mail'] },
      { hidden: ['../etc'] },
      { order: ['x'.repeat(41)] },
      { order: many },
      { hidden: many },
    ]) {
      expect((await PATCH(patchReq({ rail_pages: bad }))).status, JSON.stringify(bad).slice(0, 40)).toBe(400)
    }
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })
})
