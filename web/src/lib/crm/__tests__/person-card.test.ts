/**
 * The HUD's person card (lib/crm/person-card.ts): small and never padded with
 * defaults that say nothing (a plain 'contact', a 'neutral' tie), one line of
 * background from the enricher's summary, else the notes.
 */
import { describe, expect, it } from 'vitest'
import { PERSON_CARD_BACKGROUND_MAX, buildPersonCard, oneLine } from '../person-card'

describe('buildPersonCard', () => {
  it('name, role, company (object or array join), relationship', () => {
    expect(
      buildPersonCard({
        id: 'c-1',
        full_name: ' Ana Lee ',
        job_title: 'CTO',
        relationship_type: 'internal',
        relationship_strength: 'strong',
        company: [{ name: 'Globex' }],
      }),
    ).toEqual({ id: 'c-1', name: 'Ana Lee', role: 'CTO', company: 'Globex', relationship: 'Teammate · Strong', background: null })
  })

  it('says nothing for a plain contact with a neutral tie, and falls back to the email for a name', () => {
    const card = buildPersonCard({ id: 'c-2', full_name: '', email: 'x@y.test', relationship_type: 'contact', relationship_strength: 'neutral' })
    expect(card.name).toBe('x@y.test')
    expect(card.relationship).toBeNull()
    expect(card.role).toBeNull()
    expect(card.company).toBeNull()
  })

  it("background: the enricher's summary first, else the notes, one sentence", () => {
    expect(
      buildPersonCard({ id: 'c', notes: 'From notes.', metadata: { enrichment: { summary: 'From the summary. And more.' } } }).background,
    ).toBe('From the summary.')
    expect(buildPersonCard({ id: 'c', notes: 'Met at the summit.\nLikes golf.', metadata: {} }).background).toBe('Met at the summit.')
  })
})

describe('oneLine', () => {
  it('flattens whitespace and keeps the first sentence', () => {
    expect(oneLine('  Leads   sales at Acme.  Previously Initech. ')).toBe('Leads sales at Acme.')
    expect(oneLine('No full stop here')).toBe('No full stop here')
    expect(oneLine('   ')).toBeNull()
    expect(oneLine(null)).toBeNull()
    // A decimal or a domain isn't a sentence end.
    expect(oneLine('Raised $2.5M at acme.io last year. Then more.')).toBe('Raised $2.5M at acme.io last year.')
  })

  it('cuts a long sentence at a word', () => {
    const long = `${'word '.repeat(60).trim()}.`
    const line = oneLine(long)!
    expect(line.length).toBeLessThanOrEqual(PERSON_CARD_BACKGROUND_MAX)
    expect(line.endsWith('word…')).toBe(true)
  })
})
