/**
 * Tests for the extraction-time calibration guardrail (GEN-138).
 *
 * Pure functions → exhaustive cases. The invariants (SEED design "only ever
 * damp"): priority only ever lowers, and only from high/urgent; a due date is
 * only ever dropped, never added or shifted.
 */
import { describe, it, expect } from 'vitest'
import { calibratePriority, calibrateDueDate, URGENCY_LEXICON } from '../calibrate-proposal'

describe('calibratePriority', () => {
  it('passes low/medium/none/null through unchanged', () => {
    for (const p of ['none', 'low', 'medium', null, undefined] as const) {
      const r = calibratePriority(p, null, 'anything')
      expect(r.changed).toBe(false)
      expect(r.value).toBe(p ?? null)
      expect(r.note).toBeNull()
    }
  })

  it('keeps high when a hard due date justifies it', () => {
    const r = calibratePriority('high', '2026-07-10', 'we should look at this')
    expect(r.changed).toBe(false)
    expect(r.value).toBe('high')
  })

  it('keeps urgent when a hard due date justifies it', () => {
    const r = calibratePriority('urgent', '2026-07-10', null)
    expect(r.changed).toBe(false)
    expect(r.value).toBe('urgent')
  })

  it('keeps high when blocking language is in the quote', () => {
    const r = calibratePriority('high', null, 'this is blocking the whole integration')
    expect(r.changed).toBe(false)
    expect(r.value).toBe('high')
  })

  it('lowers high→medium with no date and no blocking language', () => {
    const r = calibratePriority('high', null, 'it would be nice to get to this')
    expect(r.changed).toBe(true)
    expect(r.value).toBe('medium')
    expect(r.note).toMatch(/high→medium/)
  })

  it('lowers urgent→medium with no justification', () => {
    const r = calibratePriority('urgent', null, 'we talked about the API')
    expect(r.changed).toBe(true)
    expect(r.value).toBe('medium')
  })

  it('lowers high→medium when quote is empty/null', () => {
    expect(calibratePriority('high', null, null).value).toBe('medium')
    expect(calibratePriority('high', null, '').value).toBe('medium')
    expect(calibratePriority('high', undefined, '   ').value).toBe('medium')
  })

  it('every urgency-lexicon word individually justifies high', () => {
    for (const word of URGENCY_LEXICON) {
      const r = calibratePriority('high', null, `context ${word} more context`)
      expect(r.changed, `word "${word}" should justify high`).toBe(false)
      expect(r.value).toBe('high')
    }
  })

  it('treats blocker/blocking/blocked as justified via the "block" stem', () => {
    for (const q of ['this is a blocker', 'blocking release', 'blocked on vendor']) {
      expect(calibratePriority('high', null, q).value).toBe('high')
    }
  })

  it('does NOT treat soft intensifiers as justification', () => {
    for (const q of ['this is important', 'we should do this soon', 'high value item']) {
      const r = calibratePriority('high', null, q)
      expect(r.value, `"${q}" should NOT justify high`).toBe('medium')
    }
  })

  it('a whitespace-only due date does not count as a hard date', () => {
    // Quote deliberately avoids any lexicon word so only the date signal is under test.
    const r = calibratePriority('high', '   ', 'we chatted about the docs')
    expect(r.value).toBe('medium')
  })
})

describe('calibrateDueDate', () => {
  const CAPTURE = '2026-07-02'

  it('passes through null/empty unchanged', () => {
    expect(calibrateDueDate(null, 'by friday', CAPTURE).changed).toBe(false)
    expect(calibrateDueDate('', 'by friday', CAPTURE).value).toBeNull()
    expect(calibrateDueDate('   ', 'by friday', CAPTURE).changed).toBe(false)
  })

  it('keeps a date when the quote names a weekday', () => {
    const r = calibrateDueDate('2026-07-10', 'let\'s finish by Friday', CAPTURE)
    expect(r.changed).toBe(false)
    expect(r.value).toBe('2026-07-10')
  })

  it('keeps a date when the quote names a month', () => {
    expect(calibrateDueDate('2026-07-15', 'ship it in July', CAPTURE).value).toBe('2026-07-15')
  })

  it('keeps a date when the quote has a relative phrase', () => {
    for (const q of ['by next week', 'end of month', 'due tomorrow', 'eod', 'by the 15th']) {
      const r = calibrateDueDate('2026-07-10', q, CAPTURE)
      expect(r.changed, `"${q}" should keep the date`).toBe(false)
    }
  })

  it('keeps a date when the quote has a numeric date', () => {
    for (const q of ['ship by 7/15', 'target 2026-07-20', 'the 3rd works']) {
      expect(calibrateDueDate('2026-07-10', q, CAPTURE).changed, q).toBe(false)
    }
  })

  it('drops a date when the quote names no date at all', () => {
    const r = calibrateDueDate('2026-07-10', 'we should get this done', CAPTURE)
    expect(r.changed).toBe(true)
    expect(r.value).toBeNull()
    expect(r.note).toMatch(/nothing dated/)
  })

  it('drops a date when the quote is empty/null', () => {
    expect(calibrateDueDate('2026-07-10', null, CAPTURE).value).toBeNull()
    expect(calibrateDueDate('2026-07-10', '', CAPTURE).value).toBeNull()
  })

  it('drops a date that predates the capture (the "before the project existed" case)', () => {
    const r = calibrateDueDate('2025-01-10', 'by next Friday', CAPTURE)
    expect(r.changed).toBe(true)
    expect(r.value).toBeNull()
    expect(r.note).toMatch(/predates/)
  })

  it('predates check fires even with a valid date in the quote', () => {
    // A quote that names a date does NOT rescue a date that's before the meeting.
    const r = calibrateDueDate('2025-06-01', 'by June 1', CAPTURE)
    expect(r.changed).toBe(true)
    expect(r.value).toBeNull()
  })

  it('same-day due date is kept (not "before" the capture)', () => {
    const r = calibrateDueDate('2026-07-02', 'by today', CAPTURE)
    expect(r.changed).toBe(false)
    expect(r.value).toBe('2026-07-02')
  })

  it('keeps a same-day deadline when the capture UTC day is one ahead (tz skew grace)', () => {
    // Evening meeting west of UTC: 8pm PDT July 2 → started_at 2026-07-03T03:00Z.
    // A genuine "by today" (July 2 local) deadline must NOT be dropped just
    // because the capture's UTC calendar day rolled to July 3.
    const r = calibrateDueDate('2026-07-02', 'by today', '2026-07-03T03:00:00Z')
    expect(r.changed).toBe(false)
    expect(r.value).toBe('2026-07-02')
  })

  it('still drops a date grossly before the capture (beyond the 1-day grace)', () => {
    // 2 days before with a dated quote → still dropped (grace is only 1 day).
    const r = calibrateDueDate('2026-06-30', 'by June 30', '2026-07-02')
    expect(r.changed).toBe(true)
    expect(r.value).toBeNull()
    expect(r.note).toMatch(/predates/)
  })

  it('skips the predates check when captureDate is null but still applies the quote check', () => {
    expect(calibrateDueDate('2020-01-01', 'by monday', null).changed).toBe(false) // quote has a date → kept
    expect(calibrateDueDate('2020-01-01', 'no date here', null).value).toBeNull() // quote has none → dropped
  })

  it('handles full-ISO due dates and capture dates (only date part matters)', () => {
    const r = calibrateDueDate('2026-07-10T09:00:00Z', 'by friday', '2026-07-02T14:40:00Z')
    expect(r.changed).toBe(false)
    expect(r.value).toBe('2026-07-10T09:00:00Z')
  })
})
