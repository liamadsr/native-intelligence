/**
 * Invites:
 *   POST /api/account/workspace/invites   owners and admins as before; a
 *       member only while "members can invite" is on, as member or guest,
 *       written with the service role; never a guest.
 *   POST .../invites/accept               the shared member setup, with
 *       joined_via 'invite' and the invite_accepted event, as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'
import { buildRequest, readJson } from '@/test/integration'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  service: { tables: {} as Record<string, Row[]>, db: null as unknown },
  session: { tables: {} as Record<string, Row[]>, db: null as unknown },
  auth: null as unknown,
  sendEmail: vi.fn(async () => ({ error: null })),
  cookieSet: vi.fn(),
  track: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => hoisted.auth,
  requireWorkspaceMember: async () => hoisted.auth,
  requireUser: async () => hoisted.auth,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service.db }))
vi.mock('@/lib/email', () => ({ BASE_URL: 'https://app.example', sendEmail: hoisted.sendEmail }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: hoisted.cookieSet, get: () => undefined }) }))
vi.mock('@/lib/crm/contacts', () => ({ ensureMemberContact: vi.fn(async () => {}) }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: hoisted.track }))
vi.mock('@/lib/workspace', () => ({ WORKSPACE_COOKIE: 'workspace_id' }))

import { POST as INVITE } from '../route'
import { POST as ACCEPT } from '../accept/route'

const ACME = 'ws-acme'

function as(role: string) {
  hoisted.auth = {
    supabase: hoisted.session.db,
    user: { id: `user-${role}`, email: `${role}@acme.example` },
    workspaceId: ACME,
    member: { id: `m-${role}`, role },
  }
}

const invite = (body: Record<string, unknown>) =>
  INVITE(buildRequest({ body }) as unknown as NextRequest)

beforeEach(() => {
  // The service role and the caller's session are two clients: an owner's
  // invite lands through the session (RLS), a member's through the service.
  hoisted.service.tables = { workspace_join_settings: [], invite: [], member: [], workspace: [{ id: ACME, name: 'Acme' }] }
  hoisted.service.db = memoryDb(hoisted.service.tables, {
    member: (a, b) => a.user_id === b.user_id && a.workspace_id === b.workspace_id,
  })
  hoisted.session.tables = { invite: [], member: [], workspace: [{ id: ACME, name: 'Acme' }] }
  hoisted.session.db = memoryDb(hoisted.session.tables)
  hoisted.sendEmail.mockClear()
  hoisted.cookieSet.mockClear()
  hoisted.track.mockClear()
})

const membersCanInvite = (on: boolean) =>
  hoisted.service.tables.workspace_join_settings.push({ workspace_id: ACME, members_can_invite: on })

describe('POST /api/account/workspace/invites', () => {
  it('owners and admins invite as admin, member or guest, through their own session', async () => {
    for (const role of ['owner', 'admin']) {
      as(role)
      const res = await invite({ email: `${role}-pick@northwind.example`, role: 'admin' })
      expect(res.status, role).toBe(201)
    }
    expect(hoisted.session.tables.invite.map((i) => i.role)).toEqual(['admin', 'admin'])
    expect(hoisted.service.tables.invite).toHaveLength(0)
  })

  it('a member, while the switch is on, invites as member or guest through the service role', async () => {
    membersCanInvite(true)
    as('member')
    expect((await invite({ email: 'jordan@northwind.example', role: 'member' })).status).toBe(201)
    expect((await invite({ email: 'sam@northwind.example', role: 'guest' })).status).toBe(201)
    expect((await invite({ email: 'kai@northwind.example' })).status).toBe(201)
    expect(hoisted.service.tables.invite.map((i) => [i.email, i.role, i.invited_by])).toEqual([
      ['jordan@northwind.example', 'member', 'm-member'],
      ['sam@northwind.example', 'guest', 'm-member'],
      ['kai@northwind.example', 'member', 'm-member'],
    ])
    expect(hoisted.sendEmail).toHaveBeenCalledTimes(3)
  })

  it('refuses a member inviting as admin', async () => {
    membersCanInvite(true)
    as('member')
    const res = await invite({ email: 'jordan@northwind.example', role: 'admin' })
    expect(res.status).toBe(403)
    expect(hoisted.service.tables.invite).toHaveLength(0)
  })

  it('refuses a member while the switch is off (and with no settings row)', async () => {
    as('member')
    expect((await invite({ email: 'jordan@northwind.example', role: 'member' })).status).toBe(403)
    membersCanInvite(false)
    expect((await invite({ email: 'jordan@northwind.example', role: 'member' })).status).toBe(403)
    expect(hoisted.service.tables.invite).toHaveLength(0)
    expect(hoisted.sendEmail).not.toHaveBeenCalled()
  })

  it('never lets a guest invite', async () => {
    membersCanInvite(true)
    as('guest')
    expect((await invite({ email: 'jordan@northwind.example', role: 'guest' })).status).toBe(403)
    expect(hoisted.service.tables.invite).toHaveLength(0)
  })

  it('still refuses a duplicate pending invite and a missing address', async () => {
    as('owner')
    hoisted.session.tables.invite.push({
      workspace_id: ACME, email: 'jordan@northwind.example', accepted_at: null, expires_at: '2999-01-01T00:00:00.000Z',
    })
    expect((await invite({ email: 'Jordan@Northwind.example ' })).status).toBe(409)
    expect((await invite({ role: 'member' })).status).toBe(400)
  })
})

describe('POST /api/account/workspace/invites/accept', () => {
  const pending = (over: Row = {}) => ({
    id: 'inv-1', workspace_id: ACME, email: 'jordan@northwind.example', role: 'guest', token: 'tok-1',
    accepted_at: null, expires_at: '2999-01-01T00:00:00.000Z', ...over,
  })
  const accept = (token: unknown) => ACCEPT(buildRequest({ body: { token } }) as unknown as NextRequest)
  const jordan = () => {
    hoisted.auth = { supabase: null, user: { id: 'user-jordan', email: 'jordan@northwind.example', user_metadata: {} } }
  }

  it('joins with the invite’s role, joined_via invite, invite_accepted, the cookie, and marks it accepted', async () => {
    hoisted.service.tables.invite.push(pending())
    jordan()
    const res = await accept('tok-1')
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ workspace_id: ACME })
    expect(hoisted.service.tables.member).toEqual([
      expect.objectContaining({ user_id: 'user-jordan', workspace_id: ACME, role: 'guest', joined_via: 'invite' }),
    ])
    expect(hoisted.service.tables.member[0].onboarding_completed_at).toEqual(expect.any(String))
    expect(hoisted.track).toHaveBeenCalledWith('invite_accepted', expect.anything(), { invite_id: 'inv-1', role: 'guest' })
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.anything())
    expect(hoisted.service.tables.invite[0].accepted_at).toEqual(expect.any(String))
  })

  it('an already-member: the invite is marked accepted, nothing added', async () => {
    hoisted.service.tables.invite.push(pending())
    hoisted.service.tables.member.push({ id: 'm-j', user_id: 'user-jordan', workspace_id: ACME, role: 'member' })
    jordan()
    expect(await readJson(await accept('tok-1'))).toEqual({ workspace_id: ACME, already_member: true })
    expect(hoisted.service.tables.member).toHaveLength(1)
    expect(hoisted.service.tables.invite[0].accepted_at).toEqual(expect.any(String))
  })

  it('refuses another address, an expired or used invite, and no token', async () => {
    hoisted.service.tables.invite.push(pending({ email: 'riley@acme.example' }))
    jordan()
    expect((await accept('tok-1')).status).toBe(403)

    hoisted.service.tables.invite.splice(0, 1, pending({ expires_at: '2020-01-01T00:00:00.000Z' }))
    expect((await accept('tok-1')).status).toBe(400)
    hoisted.service.tables.invite.splice(0, 1, pending({ accepted_at: '2026-10-01T00:00:00.000Z' }))
    expect((await accept('tok-1')).status).toBe(400)
    expect((await accept(undefined)).status).toBe(400)
    expect(hoisted.service.tables.member).toHaveLength(0)
  })
})
