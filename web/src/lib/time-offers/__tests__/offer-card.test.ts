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
})
