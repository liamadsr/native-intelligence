/**
 * The chat's time-offer cards' data (../offer-card.ts), read from the tools'
 * answers: offer_times, accept_time_offer and list_time_offers; a refusal or
 * an empty list is the generic chip's.
 */
import { describe, expect, it } from 'vitest'
import { timeOfferCardOf } from '../offer-card'

const OFFERED = {
  success: true,
  offer_id: 'o-1',
  recipient_name: 'Dana Whitfield',
  title: 'Intro call',
  duration_minutes: 30,
  link: 'https://app.example/t/AbCdEfGhIjKlMnOpQrStUvWx',
  sent_via: 'link',
  time_zone: 'America/New_York',
  times: [
    { start: '2026-11-17T15:00:00.000Z', label: 'Tue, Nov 17, 10:00 AM EST' },
    { start: '2026-11-18T19:00:00.000Z', label: 'Wed, Nov 18, 2:00 PM EST' },
  ],
  expires: 'Tue, Nov 17, 10:00 AM EST',
  paste_text: 'Could we meet…',
  message: 'The times are held…',
}

describe('timeOfferCardOf', () => {
  it('offer_times by link: who, what, the times, the link and its paste text', () => {
    expect(timeOfferCardOf('offer_times', OFFERED)).toEqual({
      kind: 'offer',
      recipient: 'Dana Whitfield',
      title: 'Intro call',
      durationMinutes: 30,
      times: ['Tue, Nov 17, 10:00 AM EST', 'Wed, Nov 18, 2:00 PM EST'],
      link: OFFERED.link,
      sentVia: 'link',
      to: null,
      expires: 'Tue, Nov 17, 10:00 AM EST',
      pasteText: 'Could we meet…',
    })
  })

  it('offer_times by email: where it went, no paste text', () => {
    const { paste_text: _, ...rest } = OFFERED
    expect(timeOfferCardOf('offer_times', { ...rest, sent_via: 'email', to: 'dana@initech.example' })).toMatchObject({ sentVia: 'email', to: 'dana@initech.example', pasteText: null })
  })

  it('a refusal or a malformed answer is the chip', () => {
    expect(timeOfferCardOf('offer_times', { success: false, code: 'APPROVAL_REQUIRED', error: 'Nothing was sent.' })).toBeNull()
    expect(timeOfferCardOf('offer_times', { success: true, times: [] })).toBeNull()
    expect(timeOfferCardOf('offer_times', null)).toBeNull()
    expect(timeOfferCardOf('withdraw_time_offer', { success: true })).toBeNull()
  })

  it('accept_time_offer: the booked meeting', () => {
    const output = {
      success: true,
      already_booked: false,
      booking: { booking_id: 'b-1', state: 'confirmed', guest: { name: 'Dana Whitfield', email: 'dana@initech.example' }, title: 'Intro call', start: '2026-11-17T15:00:00.000Z', when: 'Tue, Nov 17, 10:00 AM EST', video_link: 'https://meet.example/abc-defg-hij' },
    }
    expect(timeOfferCardOf('accept_time_offer', output)).toEqual({ kind: 'booked', guest: 'Dana Whitfield', title: 'Intro call', when: 'Tue, Nov 17, 10:00 AM EST', state: 'confirmed', videoLink: 'https://meet.example/abc-defg-hij', already: false })
    expect(timeOfferCardOf('accept_time_offer', { success: false, code: 'SLOT_TAKEN', error: 'That time is no longer available.' })).toBeNull()
  })

  it('list_time_offers: offers with their state, bookings with their time; empty is the chip', () => {
    const card = timeOfferCardOf('list_time_offers', {
      success: true,
      offers: [
        { offer_id: 'o-1', state: 'open', recipient: { name: 'Dana Whitfield' }, title: 'Intro call', times: [{ label: 'Tue, Nov 17, 10:00 AM EST', state: 'open' }], expires: 'Tue, Nov 17, 10:00 AM EST' },
        { offer_id: 'o-2', state: 'mystery', recipient: { name: 'Sam Ortiz' }, title: 'Catch up', times: [] },
      ],
      bookings: [
        { booking_id: 'b-1', state: 'cancelled', guest: { name: 'Lee Okafor' }, title: 'Tour', when: 'Wed, Nov 18, 2:00 PM EST' },
        { booking_id: 'b-2', state: 'requested', guest: { name: 'Rae Moss' }, title: 'Intro call', when: 'Thu, Nov 19, 9:00 AM EST', from_booking_link: true, waiting_on_you: true },
      ],
    })
    expect(card).toEqual({
      kind: 'list',
      offers: [{ id: 'o-1', recipient: 'Dana Whitfield', title: 'Intro call', state: 'open', times: [{ label: 'Tue, Nov 17, 10:00 AM EST', booked: false }], expires: 'Tue, Nov 17, 10:00 AM EST' }],
      bookings: [
        { id: 'b-1', guest: 'Lee Okafor', title: 'Tour', when: 'Wed, Nov 18, 2:00 PM EST', state: 'cancelled', fromLink: false },
        { id: 'b-2', guest: 'Rae Moss', title: 'Intro call', when: 'Thu, Nov 19, 9:00 AM EST', state: 'requested', fromLink: true },
      ],
    })
    expect(timeOfferCardOf('list_time_offers', { success: true, offers: [], bookings: [] })).toBeNull()
  })

  it("offer_times for a poll: the grid of guests by times, each guest's link, who answered from their calendar", () => {
    const card = timeOfferCardOf('offer_times', {
      success: true,
      offer_id: 'p-1',
      mode: 'poll',
      state: 'open',
      title: 'Planning session',
      duration_minutes: 45,
      sent_via: 'link',
      times: [
        { start: '2026-11-17T15:00:00.000Z', label: 'Tue, Nov 17, 10:00 AM EST', state: 'open' },
        { start: '2026-11-18T19:00:00.000Z', label: 'Wed, Nov 18, 2:00 PM EST', state: 'open' },
      ],
      expires: 'Wed, Nov 18, 2:00 PM EST',
      guests: [
        { guest_id: 'r-1', name: 'Dana Reyes', link: 'https://app.example/t/A', answered: false, paste_text: 'x' },
        { guest_id: 'r-2', name: 'Sam Ortiz', link: 'https://app.example/t/B', answered: true, works: ['2026-11-18T19:00:00.000Z'], from_calendar: true },
        { name: '' },
      ],
      co_hosts: 1,
    })
    expect(card).toEqual({
      kind: 'poll',
      title: 'Planning session',
      durationMinutes: 45,
      state: 'open',
      times: [
        { start: '2026-11-17T15:00:00.000Z', label: 'Tue, Nov 17, 10:00 AM EST', booked: false },
        { start: '2026-11-18T19:00:00.000Z', label: 'Wed, Nov 18, 2:00 PM EST', booked: false },
      ],
      guests: [
        { id: 'r-1', name: 'Dana Reyes', link: 'https://app.example/t/A', answered: false, works: [], fromCalendar: false, attending: null },
        { id: 'r-2', name: 'Sam Ortiz', link: 'https://app.example/t/B', answered: true, works: ['2026-11-18T19:00:00.000Z'], fromCalendar: true, attending: null },
      ],
      sentVia: 'link',
      expires: 'Wed, Nov 18, 2:00 PM EST',
      best: null,
      booking: null,
      coHosts: 1,
    })
  })

  it('list_time_offers with a booked poll: its grid in the list, the meeting from the bookings, the best time when stuck', () => {
    const times = [{ start: '2026-11-17T15:00:00.000Z', label: 'Tue, Nov 17, 10:00 AM EST', state: 'booked' }]
    const card = timeOfferCardOf('list_time_offers', {
      success: true,
      offers: [
        { offer_id: 'p-1', state: 'booked', mode: 'poll', title: 'Planning session', sent_via: 'email', times, booking_id: 'b-9', guests: [{ guest_id: 'r-1', name: 'Dana Reyes', answered: true, works: [times[0].start], attending: true }] },
        { offer_id: 'p-2', state: 'open', mode: 'poll', title: 'Review', times: [{ ...times[0], state: 'open' }], best_time: 'Tue, Nov 17, 10:00 AM EST (Dana Reyes can)', guests: [{ guest_id: 'r-1', name: 'Dana Reyes', answered: true, works: [] }, { guest_id: 'r-2', name: 'Sam Ortiz', answered: true, works: [] }] },
      ],
      bookings: [{ booking_id: 'b-9', state: 'confirmed', guest: { name: 'Dana Reyes' }, title: 'Planning session', when: 'Tue, Nov 17, 10:00 AM EST', video_link: 'https://meet.example/x', from_poll: true }],
    })
    if (card?.kind !== 'list') throw new Error('not a list')
    expect(card.offers.map((o) => [o.recipient, o.state, o.poll?.kind])).toEqual([
      ['Dana Reyes', 'booked', 'poll'],
      ['2 people', 'open', 'poll'],
    ])
    expect(card.offers[0].poll?.booking).toEqual({ when: 'Tue, Nov 17, 10:00 AM EST', videoLink: 'https://meet.example/x', state: 'confirmed' })
    expect(card.offers[0].times).toEqual([{ label: 'Tue, Nov 17, 10:00 AM EST', booked: true }])
    expect(card.offers[1].poll?.best).toBe('Tue, Nov 17, 10:00 AM EST (Dana Reyes can)')
  })

  it('record_time_offer_answer and book_poll_time draw the booked card when they booked, the chip otherwise', () => {
    const booking = { booking_id: 'b-9', state: 'confirmed', guest: { name: 'Dana Reyes and Sam Ortiz' }, title: 'Planning session', when: 'Tue, Nov 17, 10:00 AM EST' }
    expect(timeOfferCardOf('record_time_offer_answer', { success: true, booking })?.kind).toBe('booked')
    expect(timeOfferCardOf('book_poll_time', { success: true, booking })?.kind).toBe('booked')
    expect(timeOfferCardOf('record_time_offer_answer', { success: true, waiting: 2 })).toBeNull()
  })
})
