import { describe, it, expect } from 'vitest'

/**
 * Tests for AudioRingBuffer (src/lib/voice-id-service.ts) — specifically the
 * bounds behavior of extractRange. Reading past the write head used to
 * return stale wrapped samples / zeros, producing embeddings of the wrong
 * audio that then polluted voting.
 */

import { AudioRingBuffer } from '@/lib/voice-id-service'

const SAMPLE_RATE = 16000

/** PCM bytes for `seconds` of a constant Int16 value. */
function pcm(seconds: number, value = 1000): Uint8Array {
  const samples = Math.floor(seconds * SAMPLE_RATE)
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true)
  return bytes
}

describe('AudioRingBuffer.extractRange', () => {
  it('extracts a written range', () => {
    const buf = new AudioRingBuffer()
    buf.write(pcm(5))
    const audio = buf.extractRange(1, 3)
    expect(audio).not.toBeNull()
    expect(audio!.length).toBe(2 * SAMPLE_RATE)
    expect(audio![0]).toBeCloseTo(1000 / 32768)
  })

  it('clamps the end to the write head instead of reading unwritten samples', () => {
    const buf = new AudioRingBuffer()
    buf.write(pcm(5))
    // Deepgram's clock claims the segment runs to 8s but only 5s were written
    const audio = buf.extractRange(3, 8)
    expect(audio).not.toBeNull()
    expect(audio!.length).toBe(2 * SAMPLE_RATE) // 3s..5s only
  })

  it('returns null when the whole range is beyond the write head', () => {
    const buf = new AudioRingBuffer()
    buf.write(pcm(2))
    expect(buf.extractRange(3, 5)).toBeNull()
  })

  it('returns null when the range has been overwritten (older than capacity)', () => {
    const buf = new AudioRingBuffer()
    buf.write(pcm(70)) // capacity is 60s — first 10s are gone
    expect(buf.extractRange(2, 6)).toBeNull()
  })

  it('returns null for empty or inverted ranges', () => {
    const buf = new AudioRingBuffer()
    buf.write(pcm(5))
    expect(buf.extractRange(3, 3)).toBeNull()
    expect(buf.extractRange(4, 2)).toBeNull()
  })
})
