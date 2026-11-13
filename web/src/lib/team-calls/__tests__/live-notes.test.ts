/**
 * A call's live notes as the in-call panel shows them (src/lib/team-calls/
 * live-notes.ts): the agent's state read from the capture's metadata (655's
 * live_notes), the summary drawn as headings, bullets and lines with its
 * anchors and markup taken out, one plain status line, nothing drawn when
 * there is nothing to show, and a guest's lines cut down to the three fields
 * they may carry.
 */
import { describe, expect, it } from 'vitest'
import { guestLinesOf, hasLiveNotes, liveNotesOf, liveNotesStateOf, liveNotesStatusLine, summaryBlocks } from '../live-notes'

const NOW = Date.parse('2026-11-13T15:00:00Z')

describe('the agent’s state', () => {
  it('reads 655’s live_notes, and nothing else', () => {
    expect(liveNotesStateOf({ live_notes: { state: 'ready', at: '2026-11-13T14:58:00Z', turns: 4 } })).toEqual({ phase: 'ready', at: '2026-11-13T14:58:00Z', reason: null })
    expect(liveNotesStateOf({ live_notes: { state: 'stopped', reason: 'bound' } })).toEqual({ phase: 'stopped', at: null, reason: 'bound' })
    expect(liveNotesStateOf({ live_notes: { state: 'dancing' } })).toBeNull()
    expect(liveNotesStateOf({ source: 'team_call' })).toBeNull()
    expect(liveNotesStateOf(null)).toBeNull()
    expect(liveNotesOf({ ai_summary: null, metadata: null })).toEqual({ summary: '', state: null })
  })
})

describe('the summary', () => {
  it('as headings, bullets and lines, its anchors and markup taken out', () => {
    const md = [
      '## Summary',
      'The team agreed the **pilot** starts Monday.',
      '',
      '## Next Steps',
      '- Rosa sends the contract <!-- proposal:abc -->',
      '- <!-- proposal:only-an-anchor -->',
      '1. Book the [venue](https://example.com)',
    ].join('\n')
    expect(summaryBlocks(md)).toEqual([
      { kind: 'heading', text: 'Summary' },
      { kind: 'text', text: 'The team agreed the pilot starts Monday.' },
      { kind: 'heading', text: 'Next Steps' },
      { kind: 'bullet', text: 'Rosa sends the contract' },
      { kind: 'bullet', text: 'Book the venue' },
    ])
  })
})

describe('the status line', () => {
  it('says what the agent is doing, plainly', () => {
    expect(liveNotesStatusLine(null, NOW)).toBeNull()
    expect(liveNotesStatusLine({ phase: 'working', at: null, reason: null }, NOW)).toBe('Writing as people speak…')
    expect(liveNotesStatusLine({ phase: 'ready', at: '2026-11-13T14:59:40Z', reason: null }, NOW)).toBe('Updated just now')
    expect(liveNotesStatusLine({ phase: 'ready', at: '2026-11-13T14:58:00Z', reason: null }, NOW)).toBe('Updated 2 minutes ago')
    expect(liveNotesStatusLine({ phase: 'failed', at: null, reason: null }, NOW)).toMatch(/next update catches up/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'bound' }, NOW)).toMatch(/paused/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'call_ended' }, NOW)).toBeNull()
  })

  it('nothing to show: nothing drawn', () => {
    expect(hasLiveNotes(null)).toBe(false)
    expect(hasLiveNotes({ summary: '', state: null })).toBe(false)
    expect(hasLiveNotes({ summary: '- <!-- proposal:x -->', state: { phase: 'ready', at: null, reason: null } })).toBe(false)
    expect(hasLiveNotes({ summary: '', state: { phase: 'stopped', at: null, reason: 'call_ended' } })).toBe(false)
    expect(hasLiveNotes({ summary: '', state: { phase: 'working', at: null, reason: null } })).toBe(true)
    expect(hasLiveNotes({ summary: '## Summary', state: null })).toBe(true)
  })
})

describe('a guest’s lines', () => {
  it('carry their time, speaker and words, nothing else', () => {
    const raw = [
      { at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome, Sam.', summary: 'workspace context', contact_id: 'c-1' },
      { at: '2026-11-13T14:59:10Z', speaker: 'Sam Ruiz', text: 'Thanks.' },
      { speaker: 'nobody', text: 'no time' },
    ]
    const lines = guestLinesOf(raw)
    expect(lines).toEqual([
      { at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome, Sam.' },
      { at: '2026-11-13T14:59:10Z', speaker: 'Sam Ruiz', text: 'Thanks.' },
    ])
    for (const l of lines) expect(Object.keys(l).sort()).toEqual(['at', 'speaker', 'text'])
    expect(guestLinesOf(null)).toEqual([])
  })
})
