/**
 * What a source's own words offer (values.ts): its sentences (the quoted
 * reply left out), the dates it names (a month alone is that month's last
 * day; a weekday the next one after the message), and its amounts and plain
 * numbers (never a year, a time or a date's own digits).
 */
import { describe, expect, it } from 'vitest'
import { amountsIn, datesIn, numbersIn, ownText, sentencesOf } from '../values'

const REF = '2026-11-11T15:00:00.000Z' // a Wednesday

describe('ownText and sentencesOf', () => {
  it('leaves out the quoted reply and ">" lines', () => {
    const body = 'We signed today.\n\nOn Tue, Nov 10, 2026 at 9:00 AM Sam Lee <sam@fernhill.example> wrote:\n> Any news on the renewal?\n> Thanks'
    expect(ownText(body)).toBe('We signed today.\n')
    expect(ownText('Sounds good.\n> quoted\nCheers')).toBe('Sounds good.\nCheers')
    expect(ownText('Done.\n\nFrom: Sam Lee\nSent: Tuesday')).toBe('Done.\n')
  })

  it('splits lines at sentence ends, clipped, empty ones gone', () => {
    expect(sentencesOf('Good news. We signed the renewal!\n\nCan we push it to March?  ')).toEqual(['Good news.', 'We signed the renewal!', 'Can we push it to March?'])
    expect(sentencesOf('One. Two. Three. Four.', 2)).toEqual(['One.', 'Two.'])
    expect(sentencesOf('x'.repeat(400))[0]).toHaveLength(300)
  })
})

describe('datesIn', () => {
  it('a month alone is its last day; a weekday is the next one after the message; an explicit day as written', () => {
    const found = datesIn(['Can we push it to March?', 'We are signing Friday.', 'Kickoff on December 3rd works.'], REF)
    expect(found.map((d) => d.value)).toEqual(['2027-03-31', '2026-11-13', '2026-12-03'])
    expect(found[0]).toMatchObject({ phrase: 'March', sentence: 0 })
  })

  it('a time alone is no date; each date once; at most max', () => {
    expect(datesIn(['Call at 3pm?'], REF)).toEqual([])
    expect(datesIn(['March.', 'In March then.'], REF)).toHaveLength(1)
    expect(datesIn(['Jan 5.', 'Feb 6.', 'Mar 7.'], REF, 2)).toHaveLength(2)
  })
})

describe('amountsIn and numbersIn', () => {
  it('a currency sign or code beside a number, scaled', () => {
    const found = amountsIn(['We can do $48,000 for the year.', 'Or 45k USD if monthly.', 'The EU team pays €1.2m.'])
    expect(found.map((a) => [a.amount, a.currency])).toEqual([[48000, 'USD'], [45000, 'USD'], [1200000, 'EUR']])
  })

  it('plain numbers for a number column, never a year, a time or a date or amount’s digits', () => {
    const sentences = ['Make it 25 seats starting in 2027.', 'We can do $48,000.', 'Kickoff December 3 at 10:30.']
    const dates = datesIn(sentences, REF)
    const amounts = amountsIn(sentences)
    expect(numbersIn(sentences, dates, amounts).map((n) => n.amount)).toEqual([25])
  })
})
