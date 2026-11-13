/**
 * The shared member setup (add-member.ts) and join by email domain with one
 * click (domain-offer.ts), on an in-memory database: the row, joined_via,
 * the contact, the event, the cookie; what is offered, what is never
 * offered again (left, removed, dismissed), and that nothing is added
 * without the click.
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
import { dismissDomainOffers, findDomainOffers, hasDomainOfferAtSignIn, joinByDomain, offeredWorkspaceIds } from '../domain-offer'
import { DISMISSED_KEY, LEFT_KEY, addMarks, recordLeftWorkspace } from '../marks'

type Row = Record<string, unknown>

const ACME = '00000000-0000-4000-8000-00000000ac01'
const ACME_SALES = '00000000-0000-4000-8000-00000000ac02'
const NORTHWIND = '00000000-0000-4000-8000-0000000000e1'
const OWN = '00000000-0000-4000-8000-00000000000f'

function setup(tables: Record<string, Row[]>, appMetadata: Record<string, unknown> = {}) {
  const db = memoryDb(tables, {
    member: (a, b) => a.user_id === b.user_id && a.workspace_id === b.workspace_id,
  }) as SupabaseClient
  const account = { app_metadata: { ...appMetadata } as Record<string, unknown> }
  const updateUserById = vi.fn(async (_id: string, attrs: { app_metadata: Record<string, unknown> }) => {
    Object.assign(account.app_metadata, attrs.app_metadata)
    return { data: {}, error: null as null | { message: string } }
  })
  const getUserById = vi.fn(async () => ({ data: { user: { app_metadata: account.app_metadata } }, error: null }))
  Object.assign(db, { auth: { admin: { updateUserById, getUserById } } })
  return { db, tables, account, updateUserById }
}

const person = (email = 'riley@acme.example', extra: Record<string, unknown> = {}) => ({
  id: 'user-riley',
  email,
  email_confirmed_at: '2026-11-01T00:00:00.000Z',
  identities: [{ provider: 'google', identity_data: { email, email_verified: true } }],
  user_metadata: { full_name: 'Riley Chen' },
  app_metadata: {} as Record<string, unknown>,
  ...extra,
})

const world = (): Record<string, Row[]> => ({
  workspace: [
    { id: ACME, name: 'Acme' },
    { id: ACME_SALES, name: 'Acme Sales' },
    { id: NORTHWIND, name: 'Northwind' },
  ],
  workspace_join_domain: [
    { workspace_id: ACME, domain: 'acme.example' },
    { workspace_id: ACME_SALES, domain: 'acme.example' },
    { workspace_id: NORTHWIND, domain: 'northwind.example' },
  ],
  member: [
    { id: 'own', user_id: 'user-riley', workspace_id: OWN, role: 'owner', onboarding_completed_at: null },
    { id: 'o-acme', user_id: 'user-avery', workspace_id: ACME, role: 'owner', display_name: 'Avery Reyes' },
    { id: 'o-sales', user_id: 'user-sam', workspace_id: ACME_SALES, role: 'owner', display_name: 'Sam Ortiz' },
  ],
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
    expect(tables.member[0]).toMatchObject({
      user_id: 'user-riley', workspace_id: ACME, role: 'admin', display_name: 'Riley Chen', joined_via: 'invite',
    })
    expect(tables.member[0].onboarding_completed_at).toEqual(expect.any(String))
    expect(hoisted.ensureMemberContact).toHaveBeenCalledWith(ACME, tables.member[0].id, expect.objectContaining({ id: 'user-riley' }))
    expect(hoisted.track).toHaveBeenCalledWith('invite_accepted', expect.objectContaining({ workspaceId: ACME }), { invite_id: 'inv-1', role: 'admin' })
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
    expect(await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'link', activate: 'always' }))
      .toEqual({ ok: true, memberId: 'm-1', alreadyMember: true, activated: true })
    expect(tables.member).toHaveLength(1)
    expect(tables.member[0].role).toBe('guest')
    expect(hoisted.track).not.toHaveBeenCalled()
    hoisted.cookieSet.mockClear()
    expect(await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'link', activate: 'never' }))
      .toMatchObject({ alreadyMember: true, activated: false })
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('a contact failure does not undo the join', async () => {
    hoisted.ensureMemberContact.mockRejectedValueOnce(new Error('contact down'))
    const { db, tables } = setup({ member: [] })
    expect((await joinWorkspace({ service: db, user: person(), workspaceId: ACME, role: 'member', via: 'link', activate: 'always' })).ok).toBe(true)
    expect(tables.member).toHaveLength(1)
  })
})

describe('join by email domain: the offer', () => {
  it('offers every workspace listing the verified domain, with names and owners, and adds nobody', async () => {
    const { db, tables } = setup(world())
    const offers = await findDomainOffers(db, person())
    expect(offers).toEqual([
      { workspaceId: ACME, name: 'Acme', ownerName: 'Avery Reyes' },
      { workspaceId: ACME_SALES, name: 'Acme Sales', ownerName: 'Sam Ortiz' },
    ])
    expect(tables.member.filter((m) => m.user_id === 'user-riley')).toHaveLength(1)
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('offers nothing to an unverified address, an Azure claim, an unverified identity, or a public provider', async () => {
    const cases = [
      person('riley@acme.example', { email_confirmed_at: null }),
      person('riley@acme.example', { identities: [{ provider: 'azure', identity_data: { email: 'riley@acme.example', email_verified: true } }] }),
      person('riley@acme.example', { identities: [{ provider: 'email', identity_data: { email: 'riley@acme.example', email_verified: false } }] }),
      person('riley@gmail.com'),
    ]
    const tables = world()
    tables.workspace_join_domain.push({ workspace_id: NORTHWIND, domain: 'gmail.com' })
    const { db } = setup(tables)
    for (const user of cases) expect(await offeredWorkspaceIds(db, user), user.email).toEqual([])
  })

  it('leaves out a workspace they are in, left, were removed from, or dismissed', async () => {
    const tables = world()
    tables.member.push({ id: 'm', user_id: 'user-riley', workspace_id: ACME, role: 'member' })
    const { db } = setup(tables)
    expect(await offeredWorkspaceIds(db, person())).toEqual([ACME_SALES])
    expect(await offeredWorkspaceIds(db, person('riley@acme.example', { app_metadata: { [LEFT_KEY]: [ACME_SALES] } }))).toEqual([])
    expect(await offeredWorkspaceIds(db, person('riley@acme.example', { app_metadata: { [DISMISSED_KEY]: [ACME_SALES] } }))).toEqual([])
  })

  it('at sign-in: true only when there is an offer; an unverified user stops before any client is made', async () => {
    // getServiceClient throws in this file: an unverified user must not reach it.
    expect(await hasDomainOfferAtSignIn(person('riley@acme.example', { email_confirmed_at: null }))).toBe(false)
    expect(await hasDomainOfferAtSignIn(null)).toBe(false)
    // A verified one reaches it, and the failure is swallowed (never fails a sign-in).
    expect(await hasDomainOfferAtSignIn(person())).toBe(false)
  })
})

describe('join by email domain: Join and Not now', () => {
  it('Join: member, joined_via domain, workspace_joined, the cookie', async () => {
    const { db, tables } = setup(world())
    expect(await joinByDomain(db, person(), ACME)).toEqual({ ok: true, workspaceId: ACME, alreadyMember: false })
    expect(tables.member.find((m) => m.user_id === 'user-riley' && m.workspace_id === ACME)).toMatchObject({ role: 'member', joined_via: 'domain' })
    expect(hoisted.track).toHaveBeenCalledWith('workspace_joined', expect.anything(), { via: 'domain', role: 'member' })
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', ACME, expect.anything())
  })

  it('Join is refused for a workspace not listing their domain, or one they left', async () => {
    const { db, tables } = setup(world())
    expect(await joinByDomain(db, person(), NORTHWIND)).toMatchObject({ ok: false, status: 403 })
    expect(await joinByDomain(db, person('riley@acme.example', { app_metadata: { [LEFT_KEY]: [ACME] } }), ACME)).toMatchObject({ ok: false, status: 403 })
    expect(await joinByDomain(db, person('riley@acme.example', { email_confirmed_at: null }), ACME)).toMatchObject({ ok: false, status: 403 })
    expect(tables.member.filter((m) => m.user_id === 'user-riley')).toHaveLength(1)
  })

  it('Not now records the workspaces on offer, and only those', async () => {
    const { db, account } = setup(world())
    const dismissed = await dismissDomainOffers(db, person(), [ACME, ACME_SALES, NORTHWIND])
    expect(dismissed).toEqual([ACME, ACME_SALES])
    expect(account.app_metadata[DISMISSED_KEY]).toEqual([ACME, ACME_SALES])
    expect(await offeredWorkspaceIds(db, person('riley@acme.example', { app_metadata: account.app_metadata }))).toEqual([])
  })
})

describe('leaving and removal stick', () => {
  it('a member who left is not offered the workspace again, nor let back in by domain', async () => {
    const tables = world()
    tables.member.push({ id: 'm', user_id: 'user-riley', workspace_id: ACME, role: 'member', joined_via: 'domain' })
    const { db, account } = setup(tables)
    await recordLeftWorkspace(db, 'user-riley', ACME)
    tables.member = tables.member.filter((m) => m.id !== 'm')
    const after = person('riley@acme.example', { app_metadata: account.app_metadata })
    expect(await offeredWorkspaceIds(db, after)).toEqual([ACME_SALES])
    expect(await joinByDomain(db, after, ACME)).toMatchObject({ ok: false, status: 403 })
  })

  it('someone who joined by invite and was then removed is never offered it by domain', async () => {
    const tables = world()
    tables.member.push({ id: 'm', user_id: 'user-riley', workspace_id: ACME_SALES, role: 'member', joined_via: 'invite' })
    const { db, account } = setup(tables)
    await recordLeftWorkspace(db, 'user-riley', ACME_SALES)
    tables.member = tables.member.filter((m) => m.id !== 'm')
    expect(await offeredWorkspaceIds(db, person('riley@acme.example', { app_metadata: account.app_metadata }))).toEqual([ACME])
  })

  it('marks keep what was there, add without repeats, and a failed write throws', async () => {
    const { db, account, updateUserById } = setup({}, { [LEFT_KEY]: [OWN], other: 'kept' })
    await addMarks(db, 'user-riley', LEFT_KEY, [ACME, OWN])
    expect(account.app_metadata[LEFT_KEY]).toEqual([ACME, OWN])
    expect(updateUserById).toHaveBeenCalledWith('user-riley', { app_metadata: { [LEFT_KEY]: [ACME, OWN] } })
    updateUserById.mockResolvedValueOnce({ data: {}, error: { message: 'auth down' } })
    await expect(recordLeftWorkspace(db, 'user-riley', NORTHWIND)).rejects.toThrow('auth down')
  })
})
