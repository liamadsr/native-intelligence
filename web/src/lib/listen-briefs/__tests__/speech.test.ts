import { describe, it, expect } from 'vitest'
import { Speech, assignedTo, clause, count, firstName, listOf, notesSummary, one, personLine, stringOr, withoutEmails } from '../speech'

describe('Speech', () => {
  it('joins parts into sentences: capitalised, spaced before punctuation fixed, a period added', () => {
    const s = new Speech()
      .say('pricing sync', null, false, 'on Tuesday')
      .say('Jessa has one open action', ':', 'send the deck')
      .say('two follow-ups are still open', ', one of them yours')
      .say('Is it done?')
      .say(undefined, '  ', null)
      .sayAll(['  Read as it is.  ', ''])
    expect(s.toArray()).toEqual([
      'Pricing sync on Tuesday.',
      'Jessa has one open action: send the deck.',
      'Two follow-ups are still open, one of them yours.',
      'Is it done?',
      'Read as it is.',
    ])
    expect(s.length).toBe(5)
  })
})

describe('the words', () => {
  it('counts in words up to ten', () => {
    expect(count(1, 'follow-up')).toBe('one follow-up')
    expect(count(2, 'follow-up')).toBe('two follow-ups')
    expect(count(3, 'person', 'people')).toBe('three people')
    expect(count(12, 'action')).toBe('12 actions')
  })

  it('lists the way people say them', () => {
    expect(listOf([])).toBeNull()
    expect(listOf(['Jessa', null, ' '])).toBe('Jessa')
    expect(listOf(['Jessa', 'Jordan'])).toBe('Jessa and Jordan')
    expect(listOf(['Jessa', 'Jordan', 'Sam'])).toBe('Jessa, Jordan and Sam')
    expect(listOf(['Jessa', 'Jordan', 'Sam', 'Ada'])).toBe('Jessa, Jordan and two others')
    expect(listOf(['Jessa', 'Jordan', 'Sam', 'Ada', 'Lee', 'Bo'])).toBe('Jessa, Jordan and four others')
    expect(listOf(['a', 'b', 'c'], 2)).toBe('a and two others')
  })

  it('names, clauses, people and owners', () => {
    expect(firstName('  Jessa   Lin ')).toBe('Jessa')
    expect(firstName(null)).toBeNull()
    expect(clause('  **Send** the   deck. ')).toBe('Send the deck')
    expect(clause('   ')).toBeNull()
    expect(personLine('Jessa Lin', 'Head of Ops', 'Acme')).toBe('Jessa Lin, Head of Ops at Acme')
    expect(personLine('Jessa Lin', null, 'Acme')).toBe('Jessa Lin from Acme')
    expect(personLine('Jessa Lin', 'Head of Ops')).toBe('Jessa Lin, Head of Ops')
    expect(personLine(' ', 'Head of Ops')).toBeNull()
    expect(assignedTo('the user')).toBe('assigned to you')
    expect(assignedTo('Jordan Lee')).toBe('assigned to Jordan Lee')
    expect(assignedTo(null)).toBeNull()
  })

  it('rows', () => {
    expect(one([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 })
    expect(one(null)).toBeNull()
    expect(stringOr('  x ')).toBe('  x ')
    expect(stringOr(3)).toBeNull()
  })
})

describe('notesSummary', () => {
  it('reads the Summary section at the top, up to the next heading', () => {
    const notes = '# Pricing sync\n\n## Summary\nWe agreed to hold the price. Launch moves to November.\n\n## Action items\n- Send the deck'
    expect(notesSummary(notes)).toEqual(['We agreed to hold the price.', 'Launch moves to November.'])
  })

  it('a bold lead-in counts as the heading, and bullets under it are read', () => {
    const notes = '**Summary:**\n- Price holds at $99\n- Launch in November\n\n**Next steps**\nSend the deck.'
    expect(notesSummary(notes)).toEqual(['Price holds at $99.', 'Launch in November.'])
    // Run straight on, with no blank line after the lead-in.
    expect(notesSummary('**Summary**\nA quick sync.\n**Next steps**\nSend the deck.')).toEqual(['A quick sync.'])
  })

  it('Overview, TL;DR and Recap count too, wherever the section is', () => {
    expect(notesSummary('## Attendees\nJessa, Jordan\n\n## TL;DR\nShip it.')).toEqual(['Ship it.'])
    expect(notesSummary('### Meeting overview\nA quick sync.')).toEqual(['A quick sync.'])
  })

  it('no summary heading: the text before the first heading, else the first section', () => {
    expect(notesSummary('A quick sync about pricing.\n\n## Details\nMore.')).toEqual(['A quick sync about pricing.'])
    expect(notesSummary('## Discussion\nWe talked pricing.\n\n## Next\nLater.')).toEqual(['We talked pricing.'])
  })

  it('skips proposal markers, code and tables; caps the sentences; nothing for nothing', () => {
    const notes = '## Summary\nOne.<!-- proposal:1 --> Two. Three.\n\n```\ncode\n```\n\nFour. Five.'
    expect(notesSummary(notes, 3)).toEqual(['One.', 'Two.', 'Three.'])
    expect(notesSummary(null)).toEqual([])
    expect(notesSummary('## Summary\n\n## Next\nx')).toEqual([])
  })
})

describe('withoutEmails (a brief never reads an address out)', () => {
  it('says an address as the name in it, and drops one in brackets after a name', () => {
    expect(withoutEmails('with jessa@gmail.com and jordan.lee+work@acme.co.uk')).toBe('with Jessa and Jordan Lee')
    expect(withoutEmails('Jessa Lin <jessa@acme.com> and Jordan (mailto:jordan@acme.com)')).toBe('Jessa Lin and Jordan')
    expect(withoutEmails('Email mailto:sam.o@x.io the deck.')).toBe('Email Sam O the deck.')
  })

  it('leaves handles, links and plain text alone', () => {
    expect(withoutEmails('Ping @jessa, see dial8.ai/pricing')).toBe('Ping @jessa, see dial8.ai/pricing')
    expect(withoutEmails('No address here.')).toBe('No address here.')
  })

  it('runs on every sentence a brief says', () => {
    expect(new Speech().say('with', 'jessa@gmail.com').sayAll(['Ask jordan.lee@acme.com.', 'x@y.com']).toArray()).toEqual([
      'With Jessa.',
      'Ask Jordan Lee.',
      'X',
    ])
  })
})
