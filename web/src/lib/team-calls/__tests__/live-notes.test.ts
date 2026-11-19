/**
 * A call's live notes as the in-call panel shows them (src/lib/team-calls/
 * live-notes.ts): the agent's state read from 655's live notes row ("writing"
 * only while the running turn's lease lasts), the summary drawn as headings,
 * bullets and lines with its anchors and markup taken out, one plain status
 * line, nothing drawn when there is nothing to show, and a guest's lines cut
 * down to the three fields they may carry.
 */
import { describe, expect, it } from 'vitest'
import {
  CALL_NOTES_FINISHING_FOR_MS,
  callNotesFinishing,
  feedHealthLine,
  GUEST_SUMMARY_MAX_BLOCKS,
  guestLinesOf,
  guestSummaryBlocksOf,
  guestSummaryOf,
  hasLiveNotes,
  liveNotesOf,
  liveNotesStateOf,
  liveNotesStatusLine,
  liveNotesWriting,
  summaryBlocks,
} from '../live-notes'

const NOW = Date.parse('2026-11-13T15:00:00Z')

describe('the agent’s state', () => {
  it('reads 655’s live notes row, and nothing else', () => {
    expect(liveNotesStateOf({ state: 'ready', state_at: '2026-11-13T14:58:00Z' })).toEqual({ phase: 'ready', at: '2026-11-13T14:58:00Z', until: null, reason: null })
    expect(liveNotesStateOf({ state: 'stopped', reason: 'bound' })).toEqual({ phase: 'stopped', at: null, until: null, reason: 'bound' })
    expect(liveNotesStateOf({ state: 'idle' })).toBeNull()
    expect(liveNotesStateOf({ state: 'dancing' })).toBeNull()
    expect(liveNotesStateOf(null)).toBeNull()
    expect(liveNotesOf({ summary: null, state: 'idle' })).toEqual({ summary: '', state: null, feed: null })
    expect(liveNotesOf({ summary: '', state: 'idle', feed_state: 'no_words' }).feed).toBe('no_words')
    expect(liveNotesOf({ summary: '', state: 'idle', feed_state: 'bogus' }).feed).toBeNull()
  })

  it('writing only while the running turn’s lease lasts: a dead process never shows writing for ever', () => {
    const working = { phase: 'working' as const, at: '2026-11-13T14:56:00Z', reason: null }
    expect(liveNotesWriting({ ...working, until: '2026-11-13T15:01:00Z' }, NOW)).toBe(true)
    expect(liveNotesWriting({ ...working, until: '2026-11-13T14:59:00Z' }, NOW)).toBe(false)
    expect(liveNotesStatusLine({ ...working, until: '2026-11-13T14:59:00Z' }, NOW)).toBe('Updated 4 minutes ago')
    expect(hasLiveNotes({ summary: '', state: { ...working, until: '2026-11-13T14:59:00Z' } }, NOW)).toBe(false)
    expect(hasLiveNotes({ summary: '', state: { ...working, until: '2026-11-13T15:01:00Z' } }, NOW)).toBe(true)
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
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'bound' }, NOW)).toMatch(/reached its limit/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'usage' }, NOW)).toMatch(/plan has run out/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'failing' }, NOW)).toMatch(/stopped after repeated errors/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'owner_out' }, NOW)).toMatch(/can no longer write/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'something_new' }, NOW)).toMatch(/paused/)
    expect(liveNotesStatusLine({ phase: 'stopped', at: null, reason: 'call_ended' }, NOW)).toBeNull()
  })

  it('the call’s words not being written: one plain line saying why, shown even with nothing else', () => {
    expect(feedHealthLine(null)).toBeNull()
    expect(feedHealthLine('refused')).toBe('Notes aren’t being written right now: the transcription service refused our key.')
    expect(feedHealthLine('no_credit')).toMatch(/out of credit/)
    expect(feedHealthLine('down')).toMatch(/isn’t answering/)
    expect(feedHealthLine('no_words')).toMatch(/no words are coming back/)
    expect(feedHealthLine('lost')).toMatch(/lost its connection/)
    expect(hasLiveNotes({ summary: '', state: null, feed: 'down' })).toBe(true)
  })

  it('a call’s capture says “Finishing the notes…” between its lock and its finished pass, and only then', () => {
    const call = { notes_channel_id: 'ch-1', ended_at: '2026-11-13T14:55:00Z', batch_processed_at: null }
    expect(callNotesFinishing(call, NOW)).toBe(true)
    expect(callNotesFinishing({ ...call, batch_processed_at: '2026-11-13T14:58:00Z' }, NOW)).toBe(false)
    expect(callNotesFinishing({ ...call, ended_at: null }, NOW)).toBe(false)
    expect(callNotesFinishing({ ...call, notes_channel_id: null }, NOW)).toBe(false)
    expect(callNotesFinishing(call, Date.parse(call.ended_at) + CALL_NOTES_FINISHING_FOR_MS)).toBe(false)
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

  it('a guest’s notes are the summary’s plain words, bounded, and nothing else of a block', () => {
    const blocks = guestSummaryOf('## Next steps\n- [ ] Send [the model](https://example.com/x) <!-- proposal:p1 -->\n' + Array.from({ length: 200 }, (_, i) => `- item ${i}`).join('\n'))
    expect(blocks.slice(0, 2)).toEqual([
      { kind: 'heading', text: 'Next steps' },
      { kind: 'bullet', text: 'Send the model' },
    ])
    expect(blocks).toHaveLength(GUEST_SUMMARY_MAX_BLOCKS)
    expect(guestSummaryOf(null)).toEqual([])
    const odd = guestSummaryOf(
      ['See https://example.com/a?x=1 now', 'Auto <https://auto.example> link', '[1]: https://ref.example', 'A <a href="https://h.example">tag</a>', 'Split <!-- proposal:', 'p9 --> anchor', '![shot](https://img.example/x.png) seen', 'Open <!-- never closed'].join('\n'),
    )
    expect(odd.map((b) => b.text)).toEqual(['See now', 'Auto link', 'A tag', 'Split anchor', 'shot seen', 'Open'])
    expect(JSON.stringify(odd)).not.toMatch(/example|proposal|p9|href|closed/)
    expect(guestSummaryBlocksOf([{ kind: 'bullet', text: 'Kept', id: 'p1' }, { kind: 'script', text: 'x' }, { kind: 'text', text: '' }, null, 'x'])).toEqual([{ kind: 'bullet', text: 'Kept' }])
    expect(guestSummaryBlocksOf({})).toEqual([])
  })
})
