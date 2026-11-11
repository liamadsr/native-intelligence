/**
 * The words of a time offer (src/lib/time-offers/words.ts) and its tokens
 * (../tokens.ts): times in the host's zone with the abbreviation, the card
 * fitted to what the app shows (the person's line cut first), its hash
 * stable for the same words; the links' tokens unguessable and stored only
 * hashed; the event's description carries the manage link and where it came
 * from.
 */
import { describe, expect, it } from 'vitest'
import { isOfferToken, manageTokenFor, manageTokenHash, mintOfferToken, offerTokenHash, offerUrl, offerUrlShown } from '../tokens'
import { bookingEventWords, emailWords, hostCancelledWords, fitOfferWords, offerCard, offerCardHash, pasteText, slotLabel, smsText, timesInline, type OfferWords } from '../words'

const WORDS: OfferWords = {
  hostName: 'Ava Lin',
  recipientFirstName: 'Dana',
  title: 'Intro call',
  durationMinutes: 30,
  video: true,
  location: null,
  message: null,
  timeZone: 'America/New_York',
  starts: ['2026-11-17T15:00:00.000Z', '2026-11-18T19:00:00.000Z'],
}

describe('the words', () => {
  it("says each time in the host's zone, with its abbreviation once", () => {
    expect(slotLabel('2026-11-17T15:00:00.000Z', 'America/New_York')).toBe('Tue, Nov 17, 10:00 AM')
    expect(timesInline(WORDS.starts, 'America/New_York')).toBe('Tue, Nov 17, 10:00 AM; or Wed, Nov 18, 2:00 PM')
    const paste = pasteText(WORDS, 'https://app.example/t/abc')
    expect(paste).toBe(['Could we meet for Intro call (30 min, on a video call)? These times work for me (EST):', '- Tue, Nov 17, 10:00 AM', '- Wed, Nov 18, 2:00 PM', '', 'Pick the one that suits you here: https://app.example/t/abc'].join('\n'))
    expect(smsText({ ...WORDS, video: false, location: 'Fernhill Studio, 12 Elm St' }, 'L')).toBe(
      'Hi Dana, Ava Lin here. Could we meet for Intro call (30 min, at Fernhill Studio, 12 Elm St)? Tue, Nov 17, 10:00 AM; or Wed, Nov 18, 2:00 PM EST. Pick one at L or reply here with the one that works.',
    )
  })

  it("the email: the person's line, the times, the link as a link, signed by the host", () => {
    const e = emailWords({ ...WORDS, message: 'Good to meet you <b>yesterday</b>.' }, 'https://app.example/t/abc')
    expect(e.subject).toBe('Intro call: a few times to meet')
    expect(e.text.split('\n')[0]).toBe('Hi Dana,')
    expect(e.text).toContain('Good to meet you <b>yesterday</b>.')
    expect(e.text.trim().split('\n').at(-1)).toBe('Ava Lin')
    expect(e.html).toContain('<a href="https://app.example/t/abc">https://app.example/t/abc</a>')
    expect(e.html).toContain('&lt;b&gt;yesterday&lt;/b&gt;')
  })

  it('the card names who gets it and every word, fits the app (the person\'s line cut first), and its hash pins the words', () => {
    const shown = offerUrlShown('https://app.example')
    const long = { ...WORDS, message: 'x'.repeat(160), starts: [...WORDS.starts, '2026-11-19T14:30:00.000Z'] }
    const render = (w: OfferWords) => offerCard(w, { via: 'email', to: 'dana@initech.example' }, 'Dana Reyes', '2026-11-17T15:00:00.000Z', shown).why
    expect(render(long).length).toBeGreaterThan(480)
    const fitted = fitOfferWords(long, render)
    expect(render(fitted).length).toBeLessThanOrEqual(480)
    expect(fitted.title).toBe('Intro call')
    const card = offerCard(fitted, { via: 'email', to: 'dana@initech.example' }, 'Dana Reyes', '2026-11-17T15:00:00.000Z', shown)
    expect(card.title).toBe('Email Dana Reyes (dana@initech.example) times to meet?')
    expect(card.why).toContain('https://app.example/t/…')
    expect(card.why).toContain('The times stay held until they pick one or Tue, Nov 17, 10:00 AM. It runs once, exactly as shown, when you accept.')
    expect(offerCardHash(card)).toBe(offerCardHash({ ...card }))
    expect(offerCardHash(card)).not.toBe(offerCardHash({ ...card, why: card.why.replace('Dana', 'Dan') }))
    const text = offerCard(WORDS, { via: 'text', to: '+13125550142', from: '+13125550100' }, 'Dana Reyes', '2026-11-17T15:00:00.000Z', shown)
    expect(text.title).toBe('Text Dana Reyes (+1 312-555-0142) times to meet?')
    expect(text.why.startsWith('From the business number +1 312-555-0100: “Hi Dana, Ava Lin here.')).toBe(true)
  })

  it("the event's description: the guest's note, the manage link, and that it was booked here", () => {
    const words = bookingEventWords({ title: 'Intro call', guestName: 'Dana Reyes', guestNote: 'Bring the deck', location: null }, 'https://app.example/b/xyz')
    expect(words.title).toBe('Intro call (Dana Reyes)')
    expect(words.description).toBe('Note from Dana Reyes: Bring the deck\n\nNeed to change it? Reschedule or cancel: https://app.example/b/xyz\n\nBooked through Native Intelligence')
  })
})

describe('times across a daylight-saving change', () => {
  const across = { ...WORDS, starts: ['2026-10-30T14:00:00.000Z', '2026-11-03T15:00:00.000Z'] }
  it('names each time’s own zone, never one for both', () => {
    expect(pasteText(across, 'L').split('\n').slice(0, 3)).toEqual([
      'Could we meet for Intro call (30 min, on a video call)? These times work for me (New York time):',
      '- Fri, Oct 30, 10:00 AM EDT',
      '- Tue, Nov 3, 10:00 AM EST',
    ])
    expect(smsText(across, 'L')).toContain('Fri, Oct 30, 10:00 AM EDT; or Tue, Nov 3, 10:00 AM EST. Pick one')
  })
})

describe("the host's cancel line", () => {
  const event = { title: 'Intro call', calendarEventId: 'evt-1' }
  it('names who the calendar told and who it could not', () => {
    expect(hostCancelledWords(event, [{ name: 'Dana Reyes', email: 'dana@initech.example' }])).toBe('Cancelled Intro call with Dana Reyes. The calendar sent Dana Reyes the cancellation.')
    expect(hostCancelledWords(event, [{ name: 'Dana Reyes', email: 'dana@initech.example' }, { name: 'Sam Ortiz', email: null }])).toBe(
      "Cancelled Intro call with Dana Reyes and Sam Ortiz. The calendar sent Dana Reyes the cancellation. Sam Ortiz has no email on file, so the calendar couldn't tell them: tell them yourself.",
    )
  })

  it('with no event written yet, says nobody was told', () => {
    expect(hostCancelledWords({ ...event, calendarEventId: null }, [{ name: 'Dana Reyes', email: 'dana@initech.example' }])).toBe(
      "Cancelled Intro call with Dana Reyes. It wasn't on the calendar yet, so nobody was told: reach Dana Reyes yourself if they should know.",
    )
  })
})

describe('the tokens', () => {
  it('an offer token is 144 random bits, its hash all that is stored', () => {
    const a = mintOfferToken()
    const b = mintOfferToken()
    expect(a).not.toBe(b)
    expect(isOfferToken(a)).toBe(true)
    expect(Buffer.from(a, 'base64url')).toHaveLength(18)
    expect(offerTokenHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(offerTokenHash(a)).not.toContain(a)
    expect(offerUrl('https://app.example/', a)).toBe(`https://app.example/t/${a}`)
    expect(isOfferToken('../etc/passwd')).toBe(false)
  })

  it("a manage token is the same for the same booking, never another booking's, never without the secret; its hash differs from an offer token's", () => {
    const id = '6f0a8c1e-1b2c-4d5e-8f90-123456789abc'
    expect(manageTokenFor(id, 's1')).toBe(manageTokenFor(id, 's1'))
    expect(manageTokenFor(id, 's1')).not.toBe(manageTokenFor('6f0a8c1e-1b2c-4d5e-8f90-123456789abd', 's1'))
    expect(manageTokenFor(id, 's1')).not.toBe(manageTokenFor(id, 's2'))
    expect(isOfferToken(manageTokenFor(id, 's1'))).toBe(true)
    expect(manageTokenHash('same')).not.toBe(offerTokenHash('same'))
  })
})
