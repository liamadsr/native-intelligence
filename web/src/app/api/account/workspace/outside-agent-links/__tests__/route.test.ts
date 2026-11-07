/**
 * The workspace admin's switch for agent links outside the workspace
 * (decision 5): any member reads it, only an owner or admin changes it, and
 * turning it off goes through setOutsideLinksAllowed (which ends the links).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const role = vi.hoisted(() => ({ value: 'admin' }))
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const setOutsideLinksAllowed = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: settings.value }, error: null }) }) }) }) },
    user: { id: 'u-admin' },
    workspaceId: 'w-acme',
    member: { id: 'm', role: role.value },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/agent-links/outside', () => ({ setOutsideLinksAllowed }))
vi.mock('@/lib/agent-links/store', () => ({
  outsideLinksAllowed: (s: unknown) => (s as { outside_agent_links?: unknown } | null)?.outside_agent_links !== false,
}))

const route = await import('../route')
const patch = (body: unknown) => new Request('https://dial8.ai/x', { method: 'PATCH', body: JSON.stringify(body) })

beforeEach(() => {
  role.value = 'admin'
  settings.value = {}
  setOutsideLinksAllowed.mockReset()
})

describe('outside agent links switch', () => {
  it('reads on when missing, and says who may edit', async () => {
    expect(await (await route.GET()).json()).toEqual({ allowed: true, canEdit: true })
    role.value = 'member'
    settings.value = { outside_agent_links: false }
    expect(await (await route.GET()).json()).toEqual({ allowed: false, canEdit: false })
  })

  it('an admin turns it off, and hears how many links ended', async () => {
    setOutsideLinksAllowed.mockResolvedValue({ ended: 3 })
    const res = await route.PATCH(patch({ allowed: false }))
    expect(await res.json()).toEqual({ allowed: false, ended: 3 })
    expect(setOutsideLinksAllowed).toHaveBeenCalledWith({ service: true }, { workspaceId: 'w-acme', allowed: false, byUserId: 'u-admin' })
  })

  it('a member can’t, and a non-boolean is a 400', async () => {
    role.value = 'member'
    expect((await route.PATCH(patch({ allowed: false }))).status).toBe(403)
    role.value = 'owner'
    expect((await route.PATCH(patch({ allowed: 'no' }))).status).toBe(400)
    expect(setOutsideLinksAllowed).not.toHaveBeenCalled()
  })
})
