/**
 * The joining routes on an in-memory database:
 *   GET/PATCH /api/account/workspace/join   who sees and changes what; the
 *       domain is always the caller's own verified one, a clash says so;
 *   POST .../join/link/reset                owners and admins only;
 *   POST .../join/accept                    the link: on, off, reset, already
 *       a member; joins as member with joined_via 'link'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'
import { buildRequest, readJson } from '@/test/integration'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  db: null as unknown,
  auth: null as unknown,
  cookieSet: vi.fn(),
  track: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => hoisted.auth,
  requireUser: async () => hoisted.auth,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/email', () => ({ BASE_URL: 'https://app.example' }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: hoisted.cookieSet, get: () => undefined }) }))
vi.mock('@/lib/crm/contacts', () => ({ ensureMemberContact: vi.fn(async () => {}) }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: hoisted.track }))
vi.mock('@/lib/workspace', () => ({ WORKSPACE_COOKIE: 'workspace_id' }))

import { GET, PATCH } from '../route'
import { POST as RESET } from '../link/reset/route'
import { POST as ACCEPT } from '../accept/route'
import type { JoinSettingsView } from '@/lib/workspace-join/view'

const ACME = 'ws-acme'

function user(email: string, id = 'user-avery') {
  return {
    id,
    email,
    email_confirmed_at: '2026-11-01T00:00:00.000Z',
    identities: [{ provider: 'google', identity_data: { email, email_verified: true } }],
    user_metadata: { full_name: 'Avery Reyes' },
  }
}

function as(role: string, email = 'avery@acme.example', id = 'user-avery') {
  hoisted.auth = { supabase: null, user: user(email, id), workspaceId: ACME, member: { id: `m-${id}`, role } }
}

const patch = (body: unknown) => PATCH(buildRequest({ method: 'PATCH', body }) as unknown as NextRequest)
const accept = (token: unknown) => ACCEPT(buildRequest({ body: { token } }) as unknown as NextRequest)

beforeEach(() => {
  hoisted.tables = { workspace_join_settings: [], workspace_join_link: [], member: [] }
  hoisted.db = memoryDb(hoisted.tables, {
    workspace_join_settings: (a, b) =>
      a.workspace_id !== b.workspace_id && a.auto_join_domain != null && a.auto_join_domain === b.auto_join_domain,
    workspace_join_link: (a, b) => a.workspace_id !== b.workspace_id && a.token === b.token,
    member: (a, b) => a.user_id === b.user_id && a.workspace_id === b.workspace_id,
  })
  hoisted.cookieSet.mockClear()
  hoisted.track.mockClear()
})

describe('GET/PATCH /api/account/workspace/join', () => {
  it('all off to start', async () => {
    as('owner')
    const view = await readJson<JoinSettingsView>(await GET())
    expect(view).toMatchObject({
      canManage: true,
      membersCanInvite: false,
      link: { enabled: false, url: null },
      autoJoin: { domain: null, yourDomain: 'acme.example', blockedReason: null },
    })
  })

  it('a member or guest cannot change anything', async () => {
    for (const role of ['member', 'guest']) {
      as(role)
      const res = await patch({ link_enabled: true })
      expect(res.status, role).toBe(403)
    }
    expect(hoisted.tables.workspace_join_link).toHaveLength(0)
  })

  it('auto-join claims the caller’s own verified domain, never one in the body', async () => {
    as('admin', 'avery@acme.example')
    const res = await patch({ auto_join: true, domain: 'northwind.example', auto_join_domain: 'northwind.example' })
    expect(res.status).toBe(200)
    expect(hoisted.tables.workspace_join_settings[0]).toMatchObject({ workspace_id: ACME, auto_join_domain: 'acme.example' })
    expect((await readJson<JoinSettingsView>(res)).autoJoin.domain).toBe('acme.example')

    const off = await readJson<JoinSettingsView>(await patch({ auto_join: false }))
    expect(off.autoJoin.domain).toBeNull()
  })

  it('refuses a public-provider admin, with the reason, and the view shows it disabled', async () => {
    as('owner', 'avery@gmail.com')
    const res = await patch({ auto_join: true })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/public email provider/)
    const view = await readJson<JoinSettingsView>(await GET())
    expect(view.autoJoin.blockedReason).toMatch(/public email provider/)
  })

  it('says so when another workspace already uses the domain', async () => {
    hoisted.tables.workspace_join_settings.push({ workspace_id: 'ws-other', auto_join_domain: 'acme.example' })
    as('owner')
    const res = await patch({ auto_join: true })
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({ error: 'Another workspace already uses @acme.example', code: 'DOMAIN_TAKEN' })
  })

  it('the link: owners copy it; a member only while members can invite; a guest never', async () => {
    as('owner')
    const on = await readJson<JoinSettingsView>(await patch({ link_enabled: true }))
    expect(on.link.url).toMatch(/^https:\/\/app\.example\/join\/[A-Za-z0-9_-]{43}$/)

    as('member', 'riley@acme.example', 'user-riley')
    expect((await readJson<JoinSettingsView>(await GET())).link).toEqual({ enabled: true, url: null })

    as('owner')
    await patch({ members_can_invite: true })
    as('member', 'riley@acme.example', 'user-riley')
    const member = await readJson<JoinSettingsView>(await GET())
    expect(member.link.url).toBe(on.link.url)
    expect(member.canManage).toBe(false)
    expect(member.invitableRoles).toEqual(['member', 'guest'])

    as('guest', 'sam@acme.example', 'user-sam')
    expect((await readJson<JoinSettingsView>(await GET())).link.url).toBeNull()
  })

  it('a member who may copy the link still cannot reset or switch it', async () => {
    as('owner')
    await patch({ link_enabled: true, members_can_invite: true })
    const token = hoisted.tables.workspace_join_link[0].token
    as('member', 'riley@acme.example', 'user-riley')
    expect((await RESET()).status).toBe(403)
    expect((await patch({ link_enabled: false })).status).toBe(403)
    expect(hoisted.tables.workspace_join_link[0]).toMatchObject({ token, enabled: true })
  })

  it('refuses a body with nothing it knows, or a non-boolean', async () => {
    as('owner')
    expect((await patch({ domain: 'acme.example' })).status).toBe(400)
    expect((await patch({ link_enabled: 'yes' })).status).toBe(400)
  })
})

describe('POST /api/account/workspace/join/accept (the link)', () => {
  async function openLink() {
    as('owner')
    const view = await readJson<JoinSettingsView>(await patch({ link_enabled: true }))
    return view.link.url!.split('/join/')[1]
  }

  it('joins as member, by link, and makes it the active workspace', async () => {
    const token = await openLink()
    as('member', 'jordan@northwind.example', 'user-jordan') // their role elsewhere is irrelevant
    hoisted.auth = { supabase: null, user: user('jordan@northwind.example', 'user-jordan') }
    const res = await accept(token)
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ workspace_id: ACME })
    expect(hoisted.tables.member).toEqual([
      expect.objectContaining({ user_id: 'user-jordan', workspace_id: ACME, role: 'member', joined_via: 'link' }),
    ])
    expect(hoisted.track).toHaveBeenCalledWith('workspace_joined', expect.anything(), { via: 'link', role: 'member' })
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.anything())
  })

  it('an already-member just lands in the workspace', async () => {
    const token = await openLink()
    hoisted.tables.member.push({ id: 'm-jordan', user_id: 'user-jordan', workspace_id: ACME, role: 'admin' })
    hoisted.auth = { supabase: null, user: user('jordan@northwind.example', 'user-jordan') }
    const res = await accept(token)
    expect(await readJson(res)).toEqual({ workspace_id: ACME, already_member: true })
    expect(hoisted.tables.member).toHaveLength(1)
    expect(hoisted.tables.member[0].role).toBe('admin')
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.anything())
  })

  it('a link switched off, reset or made up says it no longer works', async () => {
    const token = await openLink()
    await patch({ link_enabled: false })
    hoisted.auth = { supabase: null, user: user('jordan@northwind.example', 'user-jordan') }
    const off = await accept(token)
    expect(off.status).toBe(410)
    expect(await readJson(off)).toMatchObject({ error: 'This link no longer works', code: 'LINK_CLOSED' })

    as('owner')
    await patch({ link_enabled: true })
    await RESET()
    hoisted.auth = { supabase: null, user: user('jordan@northwind.example', 'user-jordan') }
    expect((await accept(token)).status).toBe(410)
    expect((await accept('not-a-token')).status).toBe(410)
    expect((await accept(undefined)).status).toBe(410)
    expect(hoisted.tables.member).toHaveLength(0)
  })
})
