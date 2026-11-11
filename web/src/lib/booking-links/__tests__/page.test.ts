/**
 * What a booking link's page draws (../page.ts): the strip of days from
 * today in the guest's zone, its heading, the times by their day, the hosts
 * as one line, and each failure of the book call as the guest reads it.
 */
import { describe, expect, it } from 'vitest'
import { hostsLine, hostsNote, linkBookFailure, slotsByDay, stripCount, stripDays, stripHeading, todayKey } from '../page'

describe('the strip of days', () => {
  it('today in the guest’s zone: late on the 17th in Chicago is the 18th in Tokyo', () => {
    const at = Date.parse('2030-11-18T03:00:00Z')
    expect(todayKey(at, 'America/Chicago')).toBe('2030-11-17')
    expect(todayKey(at, 'Asia/Tokyo')).toBe('2030-11-18')
    expect(todayKey(at, 'Not/AZone')).toBe('2030-11-18')
  })

  it('seven days a strip from today; days past the window are outside', () => {
    const first = stripDays('2030-11-28', 0, 3)
    expect(first.map((d) => `${d.weekday} ${d.month} ${d.date}${d.outside ? ' x' : ''}`)).toEqual(['Thu Nov 28', 'Fri Nov 29', 'Sat Nov 30', 'Sun Dec 1', 'Mon Dec 2 x', 'Tue Dec 3 x', 'Wed Dec 4 x'])
    expect(stripDays('2030-11-28', 1, 30)[0].key).toBe('2030-12-05')
    expect(stripCount(3)).toBe(1)
    expect(stripCount(6)).toBe(1)
    expect(stripCount(7)).toBe(2)
    expect(stripCount(30)).toBe(5)
  })

  it('its heading: the month, or both across a month’s or a year’s end', () => {
    expect(stripHeading(stripDays('2030-11-03', 0, 30))).toBe('November 2030')
    expect(stripHeading(stripDays('2030-11-28', 0, 30))).toBe('Nov – Dec 2030')
    expect(stripHeading(stripDays('2030-12-29', 0, 30))).toBe('Dec 2030 – Jan 2031')
  })
})

describe('the times by day', () => {
  it('grouped by the guest’s day, soonest first, with their clock', () => {
    const slots = [
      { start: '2030-11-19T19:00:00.000Z', end: '2030-11-19T19:30:00.000Z' },
      { start: '2030-11-19T15:00:00.000Z', end: '2030-11-19T15:30:00.000Z' },
      { start: '2030-11-20T05:30:00.000Z', end: '2030-11-20T06:00:00.000Z' },
    ]
    const chicago = slotsByDay(slots, 'America/Chicago')
    expect(Object.keys(chicago)).toEqual(['2030-11-19'])
    expect(chicago['2030-11-19'].map((s) => s.time)).toEqual(['9:00 AM', '1:00 PM', '11:30 PM'])
    expect(Object.keys(slotsByDay(slots, 'Europe/London'))).toEqual(['2030-11-19', '2030-11-20'])
  })
})

describe('the hosts', () => {
  it('one, everyone, or any one of them', () => {
    expect(hostsLine([], 'one')).toBe('Your host')
    expect(hostsLine(['Ava Lin'], 'one')).toBe('Ava Lin')
    expect(hostsLine(['Ava Lin', 'Ben Ruiz'], 'all')).toBe('Ava Lin and Ben Ruiz')
    expect(hostsLine(['Ava Lin', 'Ben Ruiz', 'Cara Diaz'], 'any')).toBe('Ava Lin, Ben Ruiz or Cara Diaz')
    expect(hostsNote(['Ava Lin'], 'one')).toBeNull()
    expect(hostsNote(['Ava Lin', 'Ben Ruiz'], 'all')).toBe('They’ll all be there.')
    expect(hostsNote(['Ava Lin', 'Ben Ruiz'], 'any')).toBe('One of them will meet you.')
  })
})

describe('a failed booking, for the guest', () => {
  it('each code of the book call', () => {
    expect(linkBookFailure(409, { code: 'SLOT_TAKEN' }, 'Ava Lin')).toEqual({ kind: 'slot_taken' })
    expect(linkBookFailure(410, { code: 'CLOSED' }, 'Ava Lin')).toEqual({ kind: 'closed' })
    expect(linkBookFailure(404, null, 'Ava Lin')).toEqual({ kind: 'missing' })
    expect(linkBookFailure(400, { code: 'NEEDS_EMAIL', error: 'Add your email, so the invitation can reach you.', details: { field: 'email' } }, 'Ava Lin')).toEqual({ kind: 'field', field: 'email', message: 'Add your email, so the invitation can reach you.' })
    expect(linkBookFailure(400, { code: 'NEEDS_CONTACT', error: 'Add your email or a mobile number.' }, 'Ava Lin')).toEqual({ kind: 'field', field: 'contact', message: 'Add your email or a mobile number.' })
    expect(linkBookFailure(400, { code: 'BAD_INPUT', error: 'Answer "Company".', details: { field: 'company' } }, 'Ava Lin')).toEqual({ kind: 'field', field: 'company', message: 'Answer "Company".' })
    expect(linkBookFailure(400, { code: 'BAD_INPUT', error: 'Pick a time.', details: { field: 'start' } }, 'Ava Lin')).toEqual({ kind: 'message', message: 'Pick a time.' })
    expect(linkBookFailure(429, { error: "You've already booked here today." }, 'Ava Lin')).toEqual({ kind: 'message', message: "You've already booked here today." })
    expect(linkBookFailure(503, { code: 'UNAVAILABLE' }, 'Ava Lin')).toEqual({ kind: 'message', message: "We couldn't check Ava Lin's calendar just now. Try again in a minute." })
    expect(linkBookFailure(500, null, 'Ava Lin')).toEqual({ kind: 'message', message: "That didn't go through. Try again in a moment." })
  })
})
