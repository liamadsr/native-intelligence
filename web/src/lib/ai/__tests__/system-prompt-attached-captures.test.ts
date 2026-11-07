import { describe, it, expect } from 'vitest'
import { renderAttachedCaptures, type AttachedCaptureRow } from '../system-prompt'

const row: AttachedCaptureRow = {
  id: 'cap-1',
  title: 'Evening sync',
  summary: null,
  ai_summary: null,
  content: null,
  transcript: null,
  recorded_at: null,
  participants: [],
  organizer_email: null,
  meeting_url: null,
  location: null,
  duration_seconds: null,
  // 8:30 PM on 20 Oct in New York.
  started_at: '2026-10-21T00:30:00.000Z',
  ended_at: null,
}

describe('renderAttachedCaptures — date zone', () => {
  it("dates the capture in the person's zone, like the clock line", () => {
    const out = renderAttachedCaptures([row], 'America/New_York')
    expect(out).toContain('Tuesday, October 20, 2026')
    expect(out).toMatch(/08:30 PM EDT/)
  })

  it('falls back to a labelled UTC, never the server zone', () => {
    const out = renderAttachedCaptures([row])
    expect(out).toContain('Wednesday, October 21, 2026')
    expect(out).toMatch(/12:30 AM UTC/)
  })
})
