/**
 * The shared member setup (add-member.ts) and auto-join by email domain
 * (domain-join.ts), on an in-memory database: the row, joined_via, the
 * contact, the event, and when the workspace cookie is set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const hoisted = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  ensureMemberContact: vi.fn(async () => {}),
  track: vi.fn(),
}))

vi.mock('next/headers', () => ({ cookies: async () => ({ set: hoisted.cookieSet, get: () => undefined }) }))
vi.mock('@/lib/crm/contacts', () => ({ ensureMemberContact: hoisted.ensureMemberContact }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: hoisted.track }))
vi.mock('@/lib/workspace', () => ({ WORKSPACE_COOKIE: 'workspace_id' }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('tests pass their own client') } }))

import { joinWorkspace } from '../add-member'
import { DOMAIN_JOINED_KEY, joinByEmailDomain, joinByEmailDomainAtSignIn } from '../domain-join'

type Row = Record<string, unknown>

const ACME = 'ws-acme'
const OWN = 'ws-own'

function setup(tables: Record<string, Row[]>) {
  const db = memoryDb(tables, {
    member: (a, b) => a.user_id === b.user_id && a.workspace_id === b.workspace_id,
  }) as SupabaseClient & { auth: { admin: { updateUserById: ReturnType<typeof vi.fn> } } }
  const updateUserById = vi.fn(async () => ({ data: {}, error: null as null | { message: string } }))
  Object.assign(db, { auth: { admin: { updateUserById } } })
  return { db, tables, updateUserById }
}

const person = (email = 'riley@acme.example', extra: Record<string, unknown> = {}) => ({
  id: 'user-riley',
  email,
  email_confirmed_at: '2026-11-01T00:00:00.000Z',
  identities: [{ provider: 'google', identity_data: { email, email_verified: true } }],
  user_metadata: { full_name: 'Riley Chen' },
  app_metadata: {},
  ...extra,
})

beforeEach(() => {
  hoisted.cookieSet.mockClear()
  hoisted.ensureMemberContact.mockClear()
  hoisted.track.mockClear()
})

describe('joinWorkspace (the one member setup)', () => {
  it('an accepted invite: the role, onboarding skipped, joined_via invite, contact, invite_accepted, cookie', async () => {
    const { db, tables } = setup({ member: [] })
    const result = await joinWorkspace({
      service: db, user: person(), workspaceId: ACME, role: 'admin', via: 'invite', activate: 'always', inviteId: 'inv-1',
    })
    expect(result).toMatchObject({ ok: true, alreadyMember: false, activated: true })
    expect(tables.member).toHaveLength(1)
    expect(tables.member[0]).toMatchObject({
      user_id: 'user-riley', workspace_id: ACME, role: 'admin', display_name: 'Riley Chen', joined_via: 'invite',
    })
    expect(tables.member[0].onboarding_completed_at).toEqual(expect.any(String))
    expect(hoisted.ensureMemberContact).toHaveBeenCalledWith(ACME, tables.member[0].id, expect.objectContaining({ id: 'user-riley' }))
    expect(hoisted.track).toHaveBeenCalledWith(
      'invite_accepted',
      expect.objectContaining({ userId: 'user-riley', workspaceId: ACME }),
      { invite_id: 'inv-1', role: 'admin' },
    )
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.objectContaining({ httpOnly: true, path: '/' }))
  })

  it('the link: joined_via link and workspace_joined { via: link }', async () => {
    const { db, tables } = setup({ member: [] })
    await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'link', activate: 'always' })
    expect(tables.member[0]).toMatchObject({ role: 'member', joined_via: 'link' })
    expect(hoisted.track).toHaveBeenCalledWith('workspace_joined', expect.anything(), { via: 'link', role: 'member' })
  })

  it('someone already in: nothing added, no event; lands there only when they chose it', async () => {
    const { db, tables } = setup({ member: [{ id: 'm-1', user_id: 'user-riley', workspace_id: ACME, role: 'guest' }] })
    const chose = await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'link', activate: 'always' })
    expect(chose).toEqual({ ok: true, memberId: 'm-1', alreadyMember: true, activated: true })
    expect(tables.member).toHaveLength(1)
    expect(tables.member[0].role).toBe('guest')
    expect(hoisted.track).not.toHaveBeenCalled()
    expect(hoisted.ensureMemberContact).not.toHaveBeenCalled()

    hoisted.cookieSet.mockClear()
    const quiet = await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'domain', activate: 'if-fresh' })
    expect(quiet).toMatchObject({ alreadyMember: true, activated: false })
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('if-fresh: the cookie only while none of their other memberships finished onboarding', async () => {
    const fresh = setup({ member: [{ id: 'own', user_id: 'user-riley', workspace_id: OWN, role: 'owner', onboarding_completed_at: null }] })
    const a = await joinWorkspace({ service: fresh.db, user: person(), workspaceId: ACME, role: 'member', via: 'domain', activate: 'if-fresh' })
    expect(a).toMatchObject({ activated: true })
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.anything())

    hoisted.cookieSet.mockClear()
    const settled = setup({
      member: [{ id: 'own', user_id: 'user-riley', workspace_id: OWN, role: 'owner', onboarding_completed_at: '2026-10-01T00:00:00.000Z' }],
    })
    const b = await joinWorkspace({ service: settled.db, user: person(), workspaceId: ACME, role: 'member', via: 'domain', activate: 'if-fresh' })
    expect(b).toMatchObject({ ok: true, alreadyMember: false, activated: false })
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
    expect(settled.tables.member).toHaveLength(2)
  })

  it('never: just the membership', async () => {
    const { db } = setup({ member: [] })
    const r = await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'domain', activate: 'never' })
    expect(r).toMatchObject({ activated: false })
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('a contact failure does not undo the join', async () => {
    hoisted.ensureMemberContact.mockRejectedValueOnce(new Error('contact down'))
    const { db, tables } = setup({ member: [] })
    const r = await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'link', activate: 'always' })
    expect(r.ok).toBe(true)
    expect(tables.member).toHaveLength(1)
  })
})

describe('joinByEmailDomain', () => {
  const claimed = (domain = 'acme.example') => [{ workspace_id: ACME, auto_join_domain: domain, members_can_invite: false }]
  const ownFresh = () => [{ id: 'own', user_id: 'user-riley', workspace_id: OWN, role: 'owner', onboarding_completed_at: null }]

  it('joins a verified address on a claimed domain once, as member, by domain, and lands a new account there', async () => {
    const { db, tables, updateUserById } = setup({ workspace_join_settings: claimed(), member: ownFresh() })
    const outcome = await joinByEmailDomain(db, person())
    expect(outcome).toEqual({ joined: true, workspaceId: ACME, activated: true })
    const row = tables.member.find((m) => m.workspace_id === ACME)
    expect(row).toMatchObject({ role: 'member', joined_via: 'domain' })
    expect(hoisted.track).toHaveBeenCalledWith('workspace_joined', expect.anything(), { via: 'domain', role: 'member' })
    expect(updateUserById).toHaveBeenCalledWith('user-riley', { app_metadata: { [DOMAIN_JOINED_KEY]: [ACME] } })
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.anything())
  })

  it('an account that already has a workspace of its own in use: added, not moved', async () => {
    const { db } = setup({
      workspace_join_settings: claimed(),
      member: [{ id: 'own', user_id: 'user-riley', workspace_id: OWN, role: 'owner', onboarding_completed_at: '2026-09-01T00:00:00.000Z' }],
    })
    expect(await joinByEmailDomain(db, person())).toEqual({ joined: true, workspaceId: ACME, activated: false })
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('is skipped when no workspace has the domain switched on', async () => {
    const off = setup({ workspace_join_settings: [{ workspace_id: ACME, auto_join_domain: null }], member: ownFresh() })
    expect(await joinByEmailDomain(off.db, person())).toEqual({ joined: false, reason: 'no_claim' })
    expect(off.tables.member).toHaveLength(1)
    const other = setup({ workspace_join_settings: claimed('northwind.example'), member: ownFresh() })
    expect(await joinByEmailDomain(other.db, person())).toEqual({ joined: false, reason: 'no_claim' })
  })

  it('never twice: not again while a member, nor after leaving', async () => {
    const { db, tables, updateUserById } = setup({ workspace_join_settings: claimed(), member: ownFresh() })
    await joinByEmailDomain(db, person())
    expect(await joinByEmailDomain(db, person())).toEqual({ joined: false, reason: 'already_member' })
    expect(tables.member.filter((m) => m.workspace_id === ACME)).toHaveLength(1)

    // They left (or were removed): the account remembers, so the next sign-in leaves them out.
    tables.member = tables.member.filter((m) => m.workspace_id !== ACME)
    const remembered = person('riley@acme.example', { app_metadata: { [DOMAIN_JOINED_KEY]: [ACME] } })
    updateUserById.mockClear()
    expect(await joinByEmailDomain(db, remembered)).toEqual({ joined: false, reason: 'joined_before' })
    expect(tables.member.filter((m) => m.workspace_id === ACME)).toHaveLength(0)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('stays out when the mark cannot be written', async () => {
    const { db, tables, updateUserById } = setup({ workspace_join_settings: claimed(), member: ownFresh() })
    updateUserById.mockResolvedValueOnce({ data: {}, error: { message: 'auth down' } })
    expect(await joinByEmailDomain(db, person())).toEqual({ joined: false, reason: 'failed' })
    expect(tables.member).toHaveLength(1)
  })

  it('refuses an unverified address, an Azure claim, and a confirmed address with an unverified identity', async () => {
    const cases = [
      person('riley@acme.example', { email_confirmed_at: null }),
      person('riley@acme.example', { identities: [{ provider: 'azure', identity_data: { email: 'riley@acme.example', email_verified: true } }] }),
      person('riley@acme.example', { identities: [{ provider: 'email', identity_data: { email: 'riley@acme.example', email_verified: false } }] }),
    ]
    for (const user of cases) {
      const { db, tables } = setup({ workspace_join_settings: claimed(), member: ownFresh() })
      expect(await joinByEmailDomain(db, user)).toEqual({ joined: false, reason: 'unverified' })
      expect(tables.member).toHaveLength(1)
    }
  })

  it('never looks a public provider up', async () => {
    const { db, tables } = setup({ workspace_join_settings: [{ workspace_id: ACME, auto_join_domain: 'gmail.com' }], member: [] })
    expect(await joinByEmailDomain(db, person('riley@gmail.com'))).toEqual({ joined: false, reason: 'public_provider' })
    expect(tables.member).toHaveLength(0)
  })

  it('at sign-in: an unverified user stops before any client is made, and nothing throws', async () => {
    // getServiceClient throws in this file: reaching it would make the hook return null via its catch,
    // and an unverified user must not reach it at all.
    expect(await joinByEmailDomainAtSignIn(person('riley@acme.example', { email_confirmed_at: null }))).toBeNull()
    expect(await joinByEmailDomainAtSignIn(null)).toBeNull()
    expect(await joinByEmailDomainAtSignIn(person())).toBeNull()
  })
})
