/**
 * A to-do mail closed, as its home-thread part (action-done-part.ts): every
 * field checked (a part is data the person's client could write), a sender's
 * domain read off its address only when it is one.
 */
import { describe, expect, it } from 'vitest'
import { actionDoneMessageId, actionDonePartData, senderDomainOf } from '../action-done-part'

describe('senderDomainOf', () => {
  it('reads the domain off a sender, lowercased; null for anything that is not one', () => {
    expect(senderDomainOf('Enterprise Rent-A-Car <enterprise@Email.Enterprise.com>')).toBe('email.enterprise.com')
    expect(senderDomainOf('noreply@coned.example.')).toBe('coned.example')
    expect(senderDomainOf('Enterprise')).toBeNull()
    expect(senderDomainOf('x@localhost')).toBeNull()
    expect(senderDomainOf('x@evil.com <script>')).toBeNull()
    expect(senderDomainOf('"a@b.com" <x@bad domain.com>')).toBeNull()
    expect(senderDomainOf(null)).toBeNull()
  })
})

describe('actionDonePartData', () => {
  const data = { record_id: 'r1', action_id: 'a1', identifier: 'GEN-863', title: '  Look into renting a car  ', sender_domain: 'enterprise.com' }

  it('keeps the checked fields, and the undone and changed marks only when true', () => {
    expect(actionDonePartData(data)).toEqual({ ...data, title: 'Look into renting a car' })
    expect(actionDonePartData({ ...data, undone: true, changed: true })).toMatchObject({ undone: true, changed: true })
    expect(actionDonePartData({ ...data, undone: 'yes' })?.undone).toBeUndefined()
  })

  it('drops what is not one: no ids or title, a bad domain or identifier read as none', () => {
    expect(actionDonePartData(null)).toBeNull()
    expect(actionDonePartData([])).toBeNull()
    expect(actionDonePartData({ ...data, record_id: '' })).toBeNull()
    expect(actionDonePartData({ ...data, action_id: 7 })).toBeNull()
    expect(actionDonePartData({ ...data, title: '  ' })).toBeNull()
    expect(actionDonePartData({ ...data, sender_domain: 'not a domain' })?.sender_domain).toBeNull()
    expect(actionDonePartData({ ...data, identifier: 'x'.repeat(65) })?.identifier).toBeNull()
    expect(actionDonePartData({ ...data, title: 'y'.repeat(500) })?.title).toHaveLength(200)
  })

  it('one message per close', () => {
    expect(actionDoneMessageId('r1')).toBe('action-done-from-mail:r1')
  })
})
