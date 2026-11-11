/**
 * Call notes' pure parts (src/lib/team-calls/notes.ts): the offset maths that
 * places each microphone's words in the call (overlapping speech, a late
 * joiner, a republished microphone), the speaker labels, the file names the
 * egress webhooks are matched by, LiveKit's egress statuses, Deepgram's
 * answer, the title and the preamble, and who is held back on joining.
 */
import { describe, expect, it } from 'vitest'
import {
  egressFinished,
  egressRowOfPath,
  egressStatusOf,
  holdMicOnJoin,
  mergeNotes,
  notesPreamble,
  notesTitle,
  speakerLabels,
  utterancesOfDeepgram,
  type NotesFile,
} from '../notes'

const ANA = '11111111-1111-4111-8111-111111111111'
const BEN = '22222222-2222-4222-8222-222222222222'
const CY = '33333333-3333-4333-8333-333333333333'
const T0 = '2026-11-11T10:00:00.000Z'
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString()
const labels = speakerLabels([
  { memberId: ANA, name: 'Ana Ruiz' },
  { memberId: BEN, name: 'Ben Okafor' },
  { memberId: CY, name: 'Cy Lane' },
])

describe('mergeNotes', () => {
  it('places each file by when it began: a word said 5 s into a file that began 60 s into the call is at 65 s', () => {
    const files: NotesFile[] = [
      { memberId: ANA, startedAt: at(0), utterances: [{ start: 2, end: 4, text: 'Morning all.' }, { start: 70, end: 72, text: 'Welcome, Ben.' }] },
      { memberId: BEN, startedAt: at(60), utterances: [{ start: 5, end: 7, text: 'Sorry I am late.' }] },
    ]
    const { lines, text } = mergeNotes(T0, files, labels)
    expect(lines.map((l) => [l.label, l.at])).toEqual([
      ['Ana Ruiz', 2],
      ['Ben Okafor', 65],
      ['Ana Ruiz', 70],
    ])
    expect(text).toBe('[Ana Ruiz] Morning all.\n[Ben Okafor] Sorry I am late.\n[Ana Ruiz] Welcome, Ben.')
  })

  it('keeps overlapping speech as said: each line where it began, neither lost', () => {
    const files: NotesFile[] = [
      { memberId: ANA, startedAt: at(0), utterances: [{ start: 10, end: 20, text: 'So the plan for launch is the twelfth.' }] },
      { memberId: BEN, startedAt: at(0), utterances: [{ start: 12, end: 13, text: 'Yes.' }] },
      { memberId: CY, startedAt: at(0), utterances: [{ start: 12, end: 14, text: 'Agreed.' }] },
    ]
    const { lines } = mergeNotes(T0, files, labels)
    expect(lines.map((l) => l.label)).toEqual(['Ana Ruiz', 'Ben Okafor', 'Cy Lane'])
    expect(lines.map((l) => l.text)).toEqual(['So the plan for launch is the twelfth.', 'Yes.', 'Agreed.'])
  })

  it('a republished microphone (a reconnect) is a second file at its own place, and a speaker\'s close stretches are one line', () => {
    const files: NotesFile[] = [
      { memberId: ANA, startedAt: at(0), utterances: [{ start: 1, end: 3, text: 'First part.' }] },
      // Reconnected: a new track, a new file, beginning 120 s into the call.
      { memberId: ANA, startedAt: at(120), utterances: [{ start: 0.5, end: 2, text: 'Back again.' }, { start: 2.6, end: 4, text: 'Where was I?' }] },
      { memberId: BEN, startedAt: at(0), utterances: [{ start: 60, end: 61, text: 'Still there?' }] },
    ]
    const { lines } = mergeNotes(T0, files, labels)
    expect(lines.map((l) => [l.label, Math.round(l.at * 10) / 10, l.text])).toEqual([
      ['Ana Ruiz', 1, 'First part.'],
      ['Ben Okafor', 60, 'Still there?'],
      ['Ana Ruiz', 120.5, 'Back again. Where was I?'],
    ])
  })

  it('a file that began before the call (clock skew) is placed at its start, never before the call', () => {
    const { lines } = mergeNotes(T0, [{ memberId: ANA, startedAt: at(-3), utterances: [{ start: 1, end: 2, text: 'Hi.' }] }], labels)
    expect(lines[0].at).toBe(1)
  })

  it('a person who never spoke adds nothing; empty words and bad times are dropped', () => {
    const files: NotesFile[] = [
      { memberId: ANA, startedAt: at(0), utterances: [] },
      { memberId: BEN, startedAt: at(0), utterances: [{ start: Number.NaN, end: 1, text: 'lost' }, { start: 1, end: 2, text: '   ' }] },
    ]
    expect(mergeNotes(T0, files, labels)).toEqual({ lines: [], text: '' })
  })
})

describe('speakerLabels', () => {
  it('names each person once, unique within the call, without brackets', () => {
    const l = speakerLabels([
      { memberId: ANA, name: 'Rosa Lind' },
      { memberId: BEN, name: 'rosa lind' },
      { memberId: CY, name: '[x] ' },
      { memberId: ANA, name: 'Again' },
    ])
    expect([...l.values()]).toEqual(['Rosa Lind', 'rosa lind (2)', 'x'])
  })

  it('a missing name is a teammate, and a long one is cut to fit a transcript label', () => {
    const l = speakerLabels([{ memberId: ANA, name: null }, { memberId: BEN, name: 'A'.repeat(80) }])
    expect(l.get(ANA)).toBe('Teammate')
    expect(l.get(BEN)!.length).toBeLessThanOrEqual(40)
  })
})

describe('egress file names and statuses', () => {
  it('reads the row back from a file the app named', () => {
    const ch = '44444444-4444-4444-8444-444444444444'
    const call = '55555555-5555-4555-8555-555555555555'
    const row = '66666666-6666-4666-8666-666666666666'
    expect(egressRowOfPath(`${ch}/${call}/notes/${row}.ogg`)).toEqual({ channelId: ch, callId: call, kind: 'notes', rowId: row })
    expect(egressRowOfPath(`${ch}/${call}/recording/${row}.mp4`)?.kind).toBe('recording')
    expect(egressRowOfPath(`prefix/${ch}/${call}/notes/${row}.ogg`)).toBeNull()
    expect(egressRowOfPath('someone-else/file.ogg')).toBeNull()
    expect(egressRowOfPath(null)).toBeNull()
  })

  it("maps LiveKit's EgressStatus numbers, and knows which are finished", () => {
    expect([0, 1, 2, 3, 4, 5, 6, undefined].map((n) => egressStatusOf(n))).toEqual(['starting', 'active', 'ending', 'complete', 'failed', 'aborted', 'limit', 'starting'])
    expect(['complete', 'failed', 'aborted', 'limit'].every((s) => egressFinished(s as never))).toBe(true)
    expect(['starting', 'active', 'ending'].some((s) => egressFinished(s as never))).toBe(false)
  })
})

describe("Deepgram's answer", () => {
  it('takes each utterance with its start and end in the file, dropping empty ones', () => {
    expect(
      utterancesOfDeepgram({
        metadata: { duration: 12 },
        results: { utterances: [{ start: 0.4, end: 2.1, transcript: ' Hello there. ' }, { start: 3, end: 3.5, transcript: '' }, { start: 'x', transcript: 'bad' }] },
      }),
    ).toEqual([{ start: 0.4, end: 2.1, text: 'Hello there.' }])
    expect(utterancesOfDeepgram({ results: {} })).toEqual([])
    expect(utterancesOfDeepgram(null)).toEqual([])
  })
})

describe('the title and the preamble', () => {
  it('titles a channel\'s call by the channel, a DM\'s by the other person', () => {
    expect(notesTitle({ kind: 'channel', name: 'launch' })).toBe('Call in #launch')
    expect(notesTitle({ kind: 'dm', name: null, otherName: 'Rosa Lind' })).toBe('Call with Rosa Lind')
    expect(notesTitle({ kind: 'dm', name: null, otherName: null })).toBe('Call')
  })

  it('says whose words are missing and why, and when notes covered only part of the call', () => {
    expect(
      notesPreamble({
        missing: [
          { name: 'Ben Okafor', why: 'not_recorded' },
          { name: 'Cy Lane', why: 'not_recorded' },
          { name: 'Ana Ruiz', why: 'not_transcribed' },
        ],
        notesSeconds: 600,
        callSeconds: 2400,
        stoppedAtBound: false,
      }),
    ).toBe(
      'Not in these notes: Ben Okafor and Cy Lane (their audio could not be recorded).\n' +
        'Not in these notes: Ana Ruiz (their audio could not be transcribed; it is kept).\n' +
        'Notes were on for 10 min of the 40 min call.',
    )
    expect(notesPreamble({ missing: [], notesSeconds: 2400, callSeconds: 2400, stoppedAtBound: false })).toBe('')
    expect(notesPreamble({ missing: [], notesSeconds: 10800, callSeconds: 14000, stoppedAtBound: true })).toBe('Notes stopped after 3 hours.')
  })
})

describe('holdMicOnJoin', () => {
  const base = { notes: false, notes_by: null, recording: 'off' as const }
  it('holds the microphone of someone joining a call with notes on, or being recorded', () => {
    expect(holdMicOnJoin({ memberId: ANA, notes: { ...base, notes: true, notes_by: BEN } })).toBe(true)
    expect(holdMicOnJoin({ memberId: ANA, notes: { ...base, recording: 'on' } })).toBe(true)
    expect(holdMicOnJoin({ memberId: ANA, notes: { ...base, recording: 'starting' } })).toBe(true)
  })
  it('not the starter whose own Auto-record turned the notes on, and not a call with neither', () => {
    expect(holdMicOnJoin({ memberId: ANA, notes: { ...base, notes: true, notes_by: ANA } })).toBe(false)
    expect(holdMicOnJoin({ memberId: ANA, notes: { ...base, recording: 'saved' } })).toBe(false)
    expect(holdMicOnJoin({ memberId: ANA, notes: base })).toBe(false)
  })
})
