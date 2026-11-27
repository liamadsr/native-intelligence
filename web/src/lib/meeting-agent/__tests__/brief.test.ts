import { describe, expect, it } from 'vitest'
import { ALWAYS_MUST_NOT_AGREE, BRIEF_MAX_CHARS, BRIEF_MAX_ITEMS, briefIsEmpty, briefText, parseBrief, sameBrief } from '@/lib/meeting-agent/brief'

describe('the brief', () => {
  it('keeps short lines per field, trimming and dropping blanks and repeats', () => {
    const r = parseBrief({ goals: ['  Get a  yes ', '', 'get a yes'], ask: ['Who signs off?'] })
    expect(r).toEqual({ ok: true, brief: { goals: ['Get a yes'], may_share: [], ask: ['Who signs off?'], must_not_agree: [] } })
  })
  it('refuses rather than cuts: too long, too many, not a list, not text, not an object', () => {
    expect(parseBrief({ goals: ['x'.repeat(BRIEF_MAX_CHARS + 1)] })).toEqual({ ok: false, field: 'goals', reason: 'too_long' })
    expect(parseBrief({ ask: Array.from({ length: BRIEF_MAX_ITEMS + 1 }, (_, i) => `q${i}`) })).toEqual({ ok: false, field: 'ask', reason: 'too_many' })
    expect(parseBrief({ may_share: 'one fact' })).toEqual({ ok: false, field: 'may_share', reason: 'not_list' })
    expect(parseBrief({ must_not_agree: [3] })).toEqual({ ok: false, field: 'must_not_agree', reason: 'not_text' })
    expect(parseBrief(null)).toEqual({ ok: false, field: null, reason: 'not_object' })
    expect(parseBrief(['goals'])).toEqual({ ok: false, field: null, reason: 'not_object' })
  })
  it('is empty without a goal or a question', () => {
    const r = parseBrief({ may_share: ['We start in January'] })
    expect(r.ok && briefIsEmpty(r.brief)).toBe(true)
    const r2 = parseBrief({ ask: ['Who signs off?'] })
    expect(r2.ok && briefIsEmpty(r2.brief)).toBe(false)
  })
  it('as the agent reads it, money, dates and decisions are always off limits', () => {
    const r = parseBrief({ goals: ['A yes'], must_not_agree: ['Exclusivity'] })
    if (!r.ok) throw new Error('parse')
    const text = briefText(r.brief)
    expect(text).toContain('Goals:\n- A yes')
    expect(text).toContain('Facts you may share: (none)')
    expect(text).toContain('- Exclusivity')
    for (const line of ALWAYS_MUST_NOT_AGREE) expect(text).toContain(line)
  })
  it('compares two briefs line by line', () => {
    const a = parseBrief({ goals: ['A'] })
    const b = parseBrief({ goals: ['A'] })
    const c = parseBrief({ goals: ['B'] })
    if (!a.ok || !b.ok || !c.ok) throw new Error('parse')
    expect(sameBrief(a.brief, b.brief)).toBe(true)
    expect(sameBrief(a.brief, c.brief)).toBe(false)
  })
})
