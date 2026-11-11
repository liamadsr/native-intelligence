/**
 * The chat's booking link cards (../link-card.ts), read from the tools'
 * answers: the link made, changed or turned off; the list; a refusal or an
 * empty list is the chip. Made-up people.
 */
import { describe, expect, it } from 'vitest'
import { bookingLinkCardOf, linkCardLine } from '../link-card'

const LINK = { id: 'l-1', title: 'Intro call', url: 'https://app.example/book/ava-lin/intro-call', duration_minutes: 30, host_names: ['Ava Lin'], host_mode: 'one', active: true, ask_first: false, hosts: ['u-ava'] }
const item = { id: 'l-1', title: 'Intro call', url: LINK.url, durationMinutes: 30, hostNames: ['Ava Lin'], hostMode: 'one', active: true, askFirst: false }

describe('bookingLinkCardOf', () => {
  it('made, changed, turned off', () => {
    expect(bookingLinkCardOf('create_booking_link', { success: true, link: LINK, message: 'Made it.' })).toEqual({ kind: 'link', verb: 'made', link: item })
    expect(bookingLinkCardOf('update_booking_link', { success: true, link: LINK })).toEqual({ kind: 'link', verb: 'changed', link: item })
    expect(bookingLinkCardOf('update_booking_link', { success: true, link: { ...LINK, active: false } })).toMatchObject({ verb: 'off', link: { active: false } })
    expect(bookingLinkCardOf('delete_booking_link', { success: true, link: { ...LINK, active: false } })).toMatchObject({ verb: 'off' })
  })

  it('the list; a refusal, a broken link or an empty list is the chip', () => {
    expect(bookingLinkCardOf('list_booking_links', { success: true, links: [LINK, { title: 'no id' }] })).toEqual({ kind: 'links', links: [item] })
    expect(bookingLinkCardOf('list_booking_links', { success: true, links: [] })).toBeNull()
    expect(bookingLinkCardOf('create_booking_link', { success: false, code: 'NOT_ALLOWED', error: 'No.' })).toBeNull()
    expect(bookingLinkCardOf('create_booking_link', { success: true })).toBeNull()
    expect(bookingLinkCardOf('offer_times', { success: true, link: LINK })).toBeNull()
  })
})

describe('linkCardLine', () => {
  it('its length and hosts', () => {
    expect(linkCardLine({ durationMinutes: 30, hostNames: ['Ava Lin'], hostMode: 'one' })).toBe('30 min · Ava Lin')
    expect(linkCardLine({ durationMinutes: 60, hostNames: ['Ava Lin', 'Ben Ruiz'], hostMode: 'all' })).toBe('1 hr · Ava Lin and Ben Ruiz, all attend')
    expect(linkCardLine({ durationMinutes: 45, hostNames: ['Ava Lin', 'Ben Ruiz', 'Cara Diaz'], hostMode: 'any' })).toBe('45 min · Ava Lin, Ben Ruiz or Cara Diaz')
    expect(linkCardLine({ durationMinutes: 90, hostNames: [], hostMode: 'one' })).toBe('1 hr 30 min')
  })
})
