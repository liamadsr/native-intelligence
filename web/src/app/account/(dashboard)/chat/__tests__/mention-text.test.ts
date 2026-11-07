import { describe, it, expect } from 'vitest'
import {
  mentionLabel,
  insertMentionAt,
  countMentions,
  diffMentionRemovals,
  removeMentionOccurrence,
} from '../mention-text'

describe('mentionLabel', () => {
  it('prefers full_name, falls back to email, then "contact"', () => {
    expect(mentionLabel({ full_name: 'Maya Chen', email: 'm@x.io' })).toBe('Maya Chen')
    expect(mentionLabel({ full_name: null, email: 'm@x.io' })).toBe('m@x.io')
    expect(mentionLabel({ full_name: '  ', email: null })).toBe('contact')
  })
})

describe('insertMentionAt', () => {
  it('replaces the @… token at the trigger with @Label and a trailing space', () => {
    const r = insertMentionAt('hey @may', 4, 'Maya Chen')
    expect(r.value).toBe('hey @Maya Chen ')
    expect(r.cursor).toBe('hey @Maya Chen '.length)
  })

  it('keeps the text after the token', () => {
    const r = insertMentionAt('ask @ma about it', 4, 'Maya Chen')
    expect(r.value).toBe('ask @Maya Chen about it')
    expect(r.cursor).toBe('ask @Maya Chen '.length)
  })
})

describe('countMentions', () => {
  it('does not count @Maya inside @Maya Chen (prefix collision)', () => {
    const c = countMentions('ping @Maya Chen and @Maya', ['Maya', 'Maya Chen'])
    expect(c.get('Maya Chen')).toBe(1)
    expect(c.get('Maya')).toBe(1)
  })

  it('does not count @Maya inside "@Maya sync" when that is its own label', () => {
    const c = countMentions('see @Maya sync', ['Maya', 'Maya sync'])
    expect(c.get('Maya sync')).toBe(1)
    expect(c.get('Maya')).toBe(0)
  })

  it('accepts trailing punctuation as a boundary', () => {
    const c = countMentions('thanks @Maya, and @Maya. also @Maya!', ['Maya'])
    expect(c.get('Maya')).toBe(3)
  })

  it('does not match a label that continues into other letters', () => {
    const c = countMentions('@Mayas', ['Maya'])
    expect(c.get('Maya')).toBe(0)
  })
})

describe('diffMentionRemovals', () => {
  const attached = [
    { id: 'short', label: 'Maya' },
    { id: 'long', label: 'Maya Chen' },
  ]

  it('deleting @Maya Chen detaches only the long one', () => {
    const prev = '@Maya and @Maya Chen'
    const next = '@Maya and '
    expect(diffMentionRemovals(prev, next, attached)).toEqual(['long'])
  })

  it('deleting @Maya detaches only the short one', () => {
    const prev = '@Maya and @Maya Chen'
    const next = 'and @Maya Chen'
    expect(diffMentionRemovals(prev, next, attached)).toEqual(['short'])
  })

  it('partially deleting @Maya Chen → @Maya Che detaches the long one, not the short', () => {
    const prev = '@Maya and @Maya Chen'
    const next = '@Maya and @Maya Che'
    expect(diffMentionRemovals(prev, next, attached)).toEqual(['long'])
  })

  it('duplicate labels: removing one occurrence detaches one chip (most recent first)', () => {
    const dup = [
      { id: 'alex-1', label: 'Alex' },
      { id: 'alex-2', label: 'Alex' },
    ]
    const prev = '@Alex meet @Alex'
    const next = '@Alex meet '
    expect(diffMentionRemovals(prev, next, dup)).toEqual(['alex-2'])
  })

  it('duplicate labels: removing both occurrences detaches both', () => {
    const dup = [
      { id: 'alex-1', label: 'Alex' },
      { id: 'alex-2', label: 'Alex' },
    ]
    expect(diffMentionRemovals('@Alex @Alex', '', dup).sort()).toEqual(['alex-1', 'alex-2'])
  })

  it('returns nothing when the mention is still present (typing elsewhere)', () => {
    expect(diffMentionRemovals('@Maya Chen hi', '@Maya Chen hi there', attached)).toEqual([])
  })

  it('company labels participate like any other mention (mixed pool)', () => {
    // Company name "Acme" is a prefix of the contact label "Acme Lee" — the
    // shared pool keeps deleting the company mention from detaching the person.
    const attached = [
      { id: 'contact-1', label: 'Acme Lee' },
      { id: 'company-1', label: 'Acme' },
      { id: 'capture-1', label: 'Acme kickoff' },
    ]
    const prev = 'ask @Acme Lee about @Acme and @Acme kickoff'
    expect(diffMentionRemovals(prev, 'ask @Acme Lee about and @Acme kickoff', attached)).toEqual([
      'company-1',
    ])
    expect(diffMentionRemovals(prev, 'ask about @Acme and @Acme kickoff', attached)).toEqual([
      'contact-1',
    ])
  })

  it('handles mentions with trailing punctuation', () => {
    expect(diffMentionRemovals('hi @Maya, yo', 'hi , yo', [{ id: 'short', label: 'Maya' }])).toEqual(['short'])
  })
})

describe('removeMentionOccurrence', () => {
  it('removes the chip mention and collapses whitespace (chip-X)', () => {
    expect(removeMentionOccurrence('ask @Maya Chen about it', 'Maya Chen', ['Maya Chen'])).toBe(
      'ask about it',
    )
  })

  it('does not splice @Maya out of @Maya Chen', () => {
    const out = removeMentionOccurrence('@Maya Chen and @Maya here', 'Maya', ['Maya', 'Maya Chen'])
    expect(out).toBe('@Maya Chen and here')
  })

  it('removes only the first occurrence when duplicated', () => {
    expect(removeMentionOccurrence('@Alex then @Alex', 'Alex', ['Alex'])).toBe('then @Alex')
  })

  it('keeps trailing punctuation and returns text unchanged when absent', () => {
    expect(removeMentionOccurrence('hi @Maya, yo', 'Maya', ['Maya'])).toBe('hi , yo')
    expect(removeMentionOccurrence('hi there', 'Maya', ['Maya'])).toBe('hi there')
  })
})
