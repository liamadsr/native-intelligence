/**
 * The live transcript's tail for the HUD: the latest lines with any text, in
 * order, the forming one marked; and only a well-formed tail is read back.
 */
import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '@/lib/deepgram-stream'
import { TRANSCRIPT_HUD_LINES, readTranscriptHudTail, transcriptHudTail } from '../transcript-hud'

const seg = (i: number, text: string, isFinal = true): TranscriptSegment => ({
  id: `s${i}`,
  text,
  stream: 'mic',
  speaker: i % 2 ? 'remote_1' : 'local_1',
  startTime: i,
  endTime: i + 1,
  isFinal,
  words: [],
})

describe('transcriptHudTail', () => {
  it("keeps each speaker's latest lines with text, in transcript order, the forming one marked", () => {
    // A quiet speaker early on, then a long run from someone else.
    const segments = [
      { ...seg(0, 'early words'), speaker: 'remote_2' },
      ...Array.from({ length: 30 }, (_, i) => ({ ...seg(i + 1, `line ${i}`), speaker: 'remote_1' })),
      seg(40, '   '),
      { ...seg(41, ' still going ', false), speaker: 'remote_1' },
    ]
    const tail = transcriptHudTail('cap-1', segments)
    expect(tail.captureId).toBe('cap-1')
    const of = (speaker: string) => tail.lines.filter((l) => l.speaker === speaker)
    // The quiet one's words are still there for their page.
    expect(of('remote_2')).toEqual([{ id: 's0', speaker: 'remote_2', text: 'early words', final: true }])
    expect(of('remote_1')).toHaveLength(TRANSCRIPT_HUD_LINES)
    expect(of('remote_1').at(-1)).toEqual({ id: 's41', speaker: 'remote_1', text: 'still going', final: false })
    expect(tail.lines[0].id).toBe('s0')
  })
})

describe('readTranscriptHudTail', () => {
  it('reads a tail, and nothing else', () => {
    const tail = transcriptHudTail('cap-1', [seg(1, 'hi')])
    expect(readTranscriptHudTail(tail)).toEqual(tail)
    expect(readTranscriptHudTail(null)).toBeNull()
    expect(readTranscriptHudTail({ captureId: 'cap-1' })).toBeNull()
    expect(readTranscriptHudTail({ captureId: 'cap-1', lines: [{ id: 1, speaker: 'x', text: 'y', final: true }] })).toBeNull()
  })
})
