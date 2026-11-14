/**
 * Who may invite, as what, and who may see the link.
 */
import { describe, expect, it } from 'vitest'
import { canCopyJoinLink, canManageJoining, decideInvite, invitableRoles } from '../roles'

describe('decideInvite', () => {
  it('leaves owners and admins as they were: admin, member or guest, with or without the switch', () => {
    for (const caller of ['owner', 'admin']) {
      for (const on of [false, true]) {
        for (const role of ['admin', 'member', 'guest']) {
          expect(decideInvite(caller, on, role), `${caller} ${on} ${role}`).toEqual({ ok: true, role })
        }
      }
    }
  })

  it('lets a member invite as member or guest while the switch is on', () => {
    expect(decideInvite('member', true, 'member')).toEqual({ ok: true, role: 'member' })
    expect(decideInvite('member', true, 'guest')).toEqual({ ok: true, role: 'guest' })
    expect(decideInvite('member', true, undefined)).toEqual({ ok: true, role: 'member' })
  })

  it('refuses a member inviting as admin', () => {
    expect(decideInvite('member', true, 'admin')).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses a member while the switch is off', () => {
    for (const role of ['member', 'guest', 'admin']) {
      expect(decideInvite('member', false, role)).toMatchObject({ ok: false, status: 403, message: 'Only owners and admins can invite' })
    }
  })

  it('never lets a guest invite', () => {
    for (const on of [false, true]) expect(decideInvite('guest', on, 'guest')).toMatchObject({ ok: false, status: 403 })
    expect(decideInvite(null, true, 'member')).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses a role that is not one', () => {
    expect(decideInvite('owner', false, 'owner')).toMatchObject({ ok: false, status: 400 })
    expect(decideInvite('admin', false, 42)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('the link and the switches', () => {
  it('only owners and admins change them', () => {
    expect(canManageJoining('owner')).toBe(true)
    expect(canManageJoining('admin')).toBe(true)
    expect(canManageJoining('member')).toBe(false)
    expect(canManageJoining('guest')).toBe(false)
  })

  it('a member copies the link only while members can invite; a guest never', () => {
    expect(canCopyJoinLink('owner', false)).toBe(true)
    expect(canCopyJoinLink('admin', false)).toBe(true)
    expect(canCopyJoinLink('member', false)).toBe(false)
    expect(canCopyJoinLink('member', true)).toBe(true)
    expect(canCopyJoinLink('guest', true)).toBe(false)
  })

  it('offers each role the invite roles it may use', () => {
    expect(invitableRoles('admin', false)).toEqual(['admin', 'member', 'guest'])
    expect(invitableRoles('member', true)).toEqual(['member', 'guest'])
    expect(invitableRoles('member', false)).toEqual([])
    expect(invitableRoles('guest', true)).toEqual([])
  })
})
