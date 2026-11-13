/**
 * The joining routes on an in-memory database:
 *   GET/PATCH /api/account/workspace/join   who sees and changes what; a
 *       listed domain is always the caller's own verified one; several
 *       admins list theirs; a refused key writes nothing;
 *   POST .../join/domain, .../join/domain/dismiss   Join and Not now;
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
  account: { app_metadata: {} as Record<string, unknown> },
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
import { POST as JOIN_DOMAIN } from '../domain/route'
import { POST as DISMISS } from '../domain/dismiss/route'
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
  hoisted.tables = { workspace_join_settings: [], workspace_join_link: [], workspace_join_domain: [], member: [], workspace: [] }
  hoisted.db = memoryDb(hoisted.tables, {
    workspace_join_link: (a, b) => a.workspace_id === b.workspace_id || a.token === b.token,
    workspace_join_domain: (a, b) => a.workspace_id === b.workspace_id && a.domain === b.domain,
    member: (a, b) => a.user_id === b.user_id && a.workspace_id === b.workspace_id,
  })
  const account = { app_metadata: {} as Record<string, unknown> }
  hoisted.account = account
  Object.assign(hoisted.db as object, {
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { app_metadata: account.app_metadata } }, error: null }),
        updateUserById: async (_id: string, attrs: { app_metadata: Record<string, unknown> }) => {
          Object.assign(account.app_metadata, attrs.app_metadata)
          return { data: {}, error: null }
        },
      },
    },
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
      byDomain: { domains: [], yourDomain: 'acme.example', unavailableReason: null },
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

  it('by_domain lists the caller’s own verified domain, never one in the body', async () => {
    as('admin', 'avery@acme.example')
    const res = await patch({ by_domain: true, domain: 'northwind.example', remove_domains: [] })
    expect(res.status).toBe(200)
    expect(hoisted.tables.workspace_join_domain).toEqual([
      expect.objectContaining({ workspace_id: ACME, domain: 'acme.example', added_by: 'user-avery' }),
    ])
    expect((await readJson<JoinSettingsView>(res)).byDomain.domains).toEqual(['acme.example'])
    expect((await readJson<JoinSettingsView>(await patch({ by_domain: false }))).byDomain.domains).toEqual([])
  })

  it('another admin with another domain adds theirs; nothing is swapped; either can remove a listed one', async () => {
    as('owner', 'avery@acme.example')
    await patch({ by_domain: true })
    as('admin', 'jordan@acme-labs.example', 'user-jordan')
    const both = await readJson<JoinSettingsView>(await patch({ by_domain: true }))
    expect(both.byDomain.domains).toEqual(['acme-labs.example', 'acme.example'])
    // Switching their own off leaves the owner's.
    expect((await readJson<JoinSettingsView>(await patch({ by_domain: false }))).byDomain.domains).toEqual(['acme.example'])
    const removed = await readJson<JoinSettingsView>(await patch({ remove_domains: ['ACME.example'] }))
    expect(removed.byDomain.domains).toEqual([])
  })

  it('the same domain may be listed by two workspaces (no squatting)', async () => {
    hoisted.tables.workspace_join_domain.push({ workspace_id: 'ws-other', domain: 'acme.example' })
    as('owner')
    expect((await patch({ by_domain: true })).status).toBe(200)
    expect(hoisted.tables.workspace_join_domain).toHaveLength(2)
  })

  it('a public-address admin is refused with the reason, and the view says it is unavailable', async () => {
    as('owner', 'avery@gmail.com')
    const res = await patch({ by_domain: true })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/public or shared email provider/)
    const view = await readJson<JoinSettingsView>(await GET())
    expect(view.byDomain).toMatchObject({ yourDomain: null, unavailableReason: expect.stringMatching(/@gmail\.com/) })
  })

  it('a relay address is refused too', async () => {
    as('owner', 'x7f2@privaterelay.appleid.com')
    expect((await patch({ by_domain: true })).status).toBe(403)
    expect(hoisted.tables.workspace_join_domain).toHaveLength(0)
  })

  it('an internationalised domain is listed in its ASCII form; one that is no host name is refused cleanly', async () => {
    as('owner', 'jo@bücher.example')
    expect((await readJson<JoinSettingsView>(await patch({ by_domain: true }))).byDomain.domains).toEqual(['xn--bcher-kva.example'])
    as('owner', 'jo@acme_corp.example')
    const res = await patch({ by_domain: true })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/can’t be used/)
    expect((await patch({ remove_domains: ['not a domain'] })).status).toBe(400)
  })

  it('all or nothing: one refused key and nothing is written', async () => {
    as('owner', 'avery@gmail.com')
    expect((await patch({ link_enabled: true, members_can_invite: true, by_domain: true })).status).toBe(403)
    as('owner')
    expect((await patch({ link_enabled: true, members_can_invite: 'yes' })).status).toBe(400)
    expect((await patch({ link_enabled: true, remove_domains: 'acme.example' })).status).toBe(400)
    expect(hoisted.tables.workspace_join_link).toHaveLength(0)
    expect(hoisted.tables.workspace_join_settings).toHaveLength(0)
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

describe('POST /api/account/workspace/join/domain and /dismiss (the /join/team page)', () => {
  const ACME_ID = '00000000-0000-4000-8000-00000000ac01'
  const SALES_ID = '00000000-0000-4000-8000-00000000ac02'
  const joinDomain = (workspace_id: unknown) => JOIN_DOMAIN(buildRequest({ body: { workspace_id } }) as unknown as NextRequest)
  const dismiss = (workspace_ids: unknown) => DISMISS(buildRequest({ body: { workspace_ids } }) as unknown as NextRequest)
  const riley = (app_metadata: Record<string, unknown> = {}) => {
    hoisted.auth = { supabase: null, user: { ...user('riley@acme.example', 'user-riley'), app_metadata } }
  }

  beforeEach(() => {
    hoisted.tables.workspace_join_domain.push(
      { workspace_id: ACME_ID, domain: 'acme.example' },
      { workspace_id: SALES_ID, domain: 'acme.example' },
    )
  })

  it('Join makes a member by domain, and nothing happens without it', async () => {
    riley()
    expect(hoisted.tables.member).toHaveLength(0)
    const res = await joinDomain(ACME_ID)
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ workspace_id: ACME_ID })
    expect(hoisted.tables.member).toEqual([
      expect.objectContaining({ user_id: 'user-riley', workspace_id: ACME_ID, role: 'member', joined_via: 'domain' }),
    ])
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME_ID, expect.anything())
  })

  it('Join is refused for a workspace they left or were removed from, and for a bad id', async () => {
    riley({ ni_workspaces_left: [ACME_ID] })
    expect((await joinDomain(ACME_ID)).status).toBe(403)
    expect((await joinDomain('ws-acme')).status).toBe(400)
    expect(hoisted.tables.member).toHaveLength(0)
  })

  it('Not now records what was on offer, so it is never asked again', async () => {
    riley()
    const res = await dismiss([ACME_ID, SALES_ID])
    expect(await readJson(res)).toEqual({ dismissed: [ACME_ID, SALES_ID] })
    expect(hoisted.account.app_metadata.ni_join_offer_dismissed).toEqual([ACME_ID, SALES_ID])
    expect(hoisted.tables.member).toHaveLength(0)
    expect((await dismiss('all')).status).toBe(400)
  })
})
