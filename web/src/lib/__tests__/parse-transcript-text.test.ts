import { describe, it, expect } from 'vitest'
import { parseTranscriptText } from '../deepgram-stream'

/**
 * Tests for parseTranscriptText() — turns a persisted transcript (the plain
 * `[speaker] text` format written by RecordingProvider.saveTranscript) back
 * into TranscriptSegments so the Live Agent transcript tab can display it
 * after a recording has stopped.
 */
describe('parseTranscriptText', () => {
  it('returns an empty array for null/undefined/empty input', () => {
    expect(parseTranscriptText(null)).toEqual([])
    expect(parseTranscriptText(undefined)).toEqual([])
    expect(parseTranscriptText('')).toEqual([])
  })

  it('parses one `[speaker] text` line per segment', () => {
    const segments = parseTranscriptText('[local_1] Hello there\n[remote_1] Hi, how are you?')
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ speaker: 'local_1', text: 'Hello there', isFinal: true })
    expect(segments[1]).toMatchObject({ speaker: 'remote_1', text: 'Hi, how are you?', isFinal: true })
  })

  it('gives each segment a unique id', () => {
    const segments = parseTranscriptText('[a] one\n[b] two\n[c] three')
    const ids = segments.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('treats lines without a speaker prefix as a continuation of the previous segment', () => {
    const segments = parseTranscriptText('[local_1] first line\nsecond line')
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('first line\nsecond line')
  })

  it('keeps prefix-less leading content under an "unknown" speaker', () => {
    const segments = parseTranscriptText('orphan line\n[local_1] proper line')
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ speaker: 'unknown', text: 'orphan line' })
    expect(segments[1]).toMatchObject({ speaker: 'local_1', text: 'proper line' })
  })

  it('ignores blank lines between segments', () => {
    const segments = parseTranscriptText('[a] one\n\n[b] two')
    expect(segments).toHaveLength(2)
  })
})
