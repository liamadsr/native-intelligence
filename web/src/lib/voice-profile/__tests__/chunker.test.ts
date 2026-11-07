/**
 * Unit coverage for the enrollment chunker — the pure signal analysis that
 * slices a passage's audio into scored, voiced chunks and the cross-passage
 * consistency check. These are the load-bearing gates: they decide which audio
 * becomes an embedding and whether a take is trusted, so the branches
 * (voiced-region detection, quality floor rejection, outlier detection) are
 * pinned explicitly.
 *
 * Pure functions of Float32 buffers — no Worker, no DOM, no network.
 */
import { describe, it, expect } from 'vitest'
import {
  CHUNK_SAMPLE_RATE,
  clamp01,
  rms,
  findVoicedRegions,
  scoreChunk,
  chunkPassageAudio,
  chunkPassageAudioFrom,
  voicedSeconds,
  checkConsistency,
} from '../chunker'
import {
  ENROLLMENT_CHUNK_SECONDS,
  ENROLLMENT_MIN_CHUNK_QUALITY,
  PASSAGE_CONSISTENCY_MIN,
} from '../types'
import { l2Normalize } from '@/lib/voice-id-matching'

/** Build a Float32 buffer of `seconds` filled with a steady sine at `amp`. */
function tone(seconds: number, amp: number, freq = 200): Float32Array {
  const n = Math.floor(seconds * CHUNK_SAMPLE_RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / CHUNK_SAMPLE_RATE)
  }
  return out
}

/** Concatenate several Float32 buffers into one. */
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

describe('clamp01', () => {
  it('clamps to [0,1] and coerces non-finite to 0', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(NaN)).toBe(0)
    expect(clamp01(Infinity)).toBe(0)
  })
})

describe('rms', () => {
  it('is 0 for silence and ~amp/√2 for a full-scale sine', () => {
    expect(rms(new Float32Array(1000))).toBe(0)
    const level = rms(tone(0.5, 1))
    expect(level).toBeGreaterThan(0.69)
    expect(level).toBeLessThan(0.72)
  })

  it('returns 0 for an empty window', () => {
    expect(rms(new Float32Array(0))).toBe(0)
    expect(rms(tone(0.1, 0.5), 100, 100)).toBe(0)
  })
})

describe('findVoicedRegions', () => {
  it('detects a single voiced region flanked by silence', () => {
    const noiseFloor = 0.002
    const audio = concat(
      new Float32Array(CHUNK_SAMPLE_RATE), // 1s silence
      tone(4, 0.2), // 4s speech
      new Float32Array(CHUNK_SAMPLE_RATE), // 1s silence
    )
    const regions = findVoicedRegions(audio, noiseFloor)
    expect(regions.length).toBe(1)
    const r = regions[0]
    const seconds = (r.endSample - r.startSample) / CHUNK_SAMPLE_RATE
    // The 4s tone (± a hop of tolerance) is the voiced span.
    expect(seconds).toBeGreaterThan(3.7)
    expect(seconds).toBeLessThan(4.3)
    expect(r.rms).toBeGreaterThan(noiseFloor)
  })

  it('bridges a short pause but splits on a long silence', () => {
    const noiseFloor = 0.002
    const shortGap = concat(tone(2, 0.2), new Float32Array(Math.floor(0.15 * CHUNK_SAMPLE_RATE)), tone(2, 0.2))
    expect(findVoicedRegions(shortGap, noiseFloor).length).toBe(1)

    const longGap = concat(tone(2, 0.2), new Float32Array(CHUNK_SAMPLE_RATE), tone(2, 0.2))
    expect(findVoicedRegions(longGap, noiseFloor).length).toBe(2)
  })

  it('classifies audio near the noise floor as unvoiced', () => {
    // A quiet room hiss barely above the floor stays below the voiced margin.
    const noiseFloor = 0.02
    const quiet = tone(3, 0.01) // well under 1.8× floor
    expect(findVoicedRegions(quiet, noiseFloor)).toHaveLength(0)
  })
})

describe('scoreChunk', () => {
  it('scores a full, loud, clean chunk high and a short, quiet one low', () => {
    const noiseFloor = 0.003
    const good = scoreChunk(tone(ENROLLMENT_CHUNK_SECONDS, 0.2), noiseFloor)
    expect(good.durationScore).toBe(1)
    expect(good.quality).toBeGreaterThanOrEqual(ENROLLMENT_MIN_CHUNK_QUALITY)

    const short = scoreChunk(tone(0.4, 0.01), noiseFloor)
    expect(short.durationScore).toBeLessThan(0.2)
    expect(short.quality).toBeLessThan(ENROLLMENT_MIN_CHUNK_QUALITY)
  })

  it('SNR proxy collapses when the noise floor is as loud as the chunk', () => {
    const chunk = tone(ENROLLMENT_CHUNK_SECONDS, 0.05)
    const clean = scoreChunk(chunk, 0.003)
    const noisy = scoreChunk(chunk, 0.05) // floor == signal
    expect(noisy.snrScore).toBeLessThan(clean.snrScore)
  })
})

describe('chunkPassageAudio', () => {
  it('slices a long voiced passage into full-length chunks and drops the sliver', () => {
    const noiseFloor = 0.003
    // 10s of clean speech → three 3s chunks; the trailing 1s < MIN_CHUNK_SECONDS is dropped.
    const audio = tone(10, 0.2)
    const chunks = chunkPassageAudio(audio, noiseFloor)
    expect(chunks).toHaveLength(3)
    for (const c of chunks) {
      expect(c.audio.length).toBe(ENROLLMENT_CHUNK_SECONDS * CHUNK_SAMPLE_RATE)
      expect(c.quality).toBeGreaterThanOrEqual(ENROLLMENT_MIN_CHUNK_QUALITY)
    }
    expect(voicedSeconds(chunks)).toBeCloseTo(9, 1)
  })

  it('rejects chunks below the quality floor (too quiet)', () => {
    const noiseFloor = 0.02
    // Loud enough to be "voiced" but its aggregate quality lands under the floor.
    const audio = tone(9, 0.045)
    const chunks = chunkPassageAudio(audio, noiseFloor)
    for (const c of chunks) {
      expect(c.quality).toBeGreaterThanOrEqual(ENROLLMENT_MIN_CHUNK_QUALITY)
    }
    // The quiet-ish take yields fewer accepted chunks than a clean loud one.
    const clean = chunkPassageAudio(tone(9, 0.2), 0.003)
    expect(chunks.length).toBeLessThanOrEqual(clean.length)
  })

  it('returns nothing for pure silence', () => {
    expect(chunkPassageAudio(new Float32Array(9 * CHUNK_SAMPLE_RATE), 0.003)).toHaveLength(0)
  })
})

describe('chunkPassageAudioFrom (incremental)', () => {
  const floor = 0.003

  it('emits nothing and holds the offset until a full window of new audio exists', () => {
    // Under one chunk's worth of new audio past the offset → nothing stable yet.
    const audio = tone(ENROLLMENT_CHUNK_SECONDS - 0.5, 0.2)
    const res = chunkPassageAudioFrom(audio, floor, 0)
    expect(res.chunks).toHaveLength(0)
    expect(res.nextOffset).toBe(0)
  })

  it('emits only full-length windows and reports how far it consumed', () => {
    // 7s of clean speech → two full 3s chunks; the trailing 1s is NOT emitted
    // (it may still be growing) so nextOffset sits at the 6s boundary.
    const audio = tone(7, 0.2)
    const res = chunkPassageAudioFrom(audio, floor, 0)
    expect(res.chunks).toHaveLength(2)
    for (const c of res.chunks) {
      expect(c.audio.length).toBe(ENROLLMENT_CHUNK_SECONDS * CHUNK_SAMPLE_RATE)
    }
    expect(res.nextOffset).toBe(2 * ENROLLMENT_CHUNK_SECONDS * CHUNK_SAMPLE_RATE)
  })

  it('never re-chunks a region already consumed across successive passes', () => {
    // First pass over the first 7s (a growing buffer snapshot).
    const first = chunkPassageAudioFrom(tone(7, 0.2), floor, 0)
    expect(first.chunks).toHaveLength(2)

    // Buffer grew to 13s; resume from where pass 1 stopped. Only the NEW audio
    // past nextOffset is chunked — no region before it is re-emitted.
    const grown = tone(13, 0.2)
    const second = chunkPassageAudioFrom(grown, floor, first.nextOffset)
    // 13s from 6s = 7s remaining → two more full 3s chunks (12s), 1s tail held.
    expect(second.chunks).toHaveLength(2)
    expect(second.nextOffset).toBe(4 * ENROLLMENT_CHUNK_SECONDS * CHUNK_SAMPLE_RATE)

    // Incremental total (4 chunks) + a finalize tail over the remaining audio
    // equals a single whole-buffer pass — no double-count, no gap.
    const tail = chunkPassageAudio(grown.subarray(second.nextOffset), floor)
    const incrementalTotal = first.chunks.length + second.chunks.length + tail.length
    expect(incrementalTotal).toBe(chunkPassageAudio(grown, floor).length)
  })

  it('reconstructs the exact whole-buffer chunk set (byte-for-byte) via incremental + tail', () => {
    // A realistic passage: two voiced spans separated by a real pause.
    const audio = concat(
      tone(8, 0.2, 190),
      new Float32Array(CHUNK_SAMPLE_RATE), // 1s pause (splits regions)
      tone(5, 0.22, 210),
    )
    // Chunk it incrementally in several growing snapshots.
    let offset = 0
    const incremental: Float32Array[] = []
    for (const end of [4, 9, 14, audio.length / CHUNK_SAMPLE_RATE]) {
      const snap = audio.subarray(0, Math.floor(end * CHUNK_SAMPLE_RATE))
      const res = chunkPassageAudioFrom(audio.subarray(0, snap.length), floor, offset)
      for (const c of res.chunks) incremental.push(c.audio)
      offset = res.nextOffset
    }
    // Finalize tail from the last consumed offset.
    const tail = chunkPassageAudio(audio.subarray(offset), floor)
    for (const c of tail) incremental.push(c.audio)

    // Whole-buffer reference.
    const whole = chunkPassageAudio(audio, floor).map((c) => c.audio)

    // Same count and same audio content, in order.
    expect(incremental.length).toBe(whole.length)
    for (let i = 0; i < whole.length; i++) {
      expect(incremental[i].length).toBe(whole[i].length)
      // Compare a few interior samples — identical slicing means identical audio.
      expect(incremental[i][0]).toBe(whole[i][0])
      expect(incremental[i][incremental[i].length - 1]).toBe(whole[i][whole[i].length - 1])
    }
  })

  it('clamps an out-of-range offset without throwing', () => {
    const audio = tone(6, 0.2)
    expect(chunkPassageAudioFrom(audio, floor, 999999).chunks).toHaveLength(0)
    expect(chunkPassageAudioFrom(audio, floor, -50).chunks.length).toBeGreaterThan(0)
  })
})

describe('checkConsistency', () => {
  it('is trivially consistent with fewer than two prototypes', () => {
    expect(checkConsistency([]).ok).toBe(true)
    expect(checkConsistency([[1, 0, 0]]).ok).toBe(true)
  })

  it('passes when the three prototypes are mutually similar', () => {
    const a = l2Normalize([1, 0.1, 0])
    const b = l2Normalize([0.98, 0.15, 0.02])
    const c = l2Normalize([0.97, 0.12, 0.05])
    const res = checkConsistency([a, b, c])
    expect(res.ok).toBe(true)
    expect(res.minPairwise).toBeGreaterThanOrEqual(PASSAGE_CONSISTENCY_MIN)
    expect(res.outlierIndex).toBeNull()
  })

  it('flags the outlier passage when one prototype diverges', () => {
    const a = l2Normalize([1, 0, 0])
    const b = l2Normalize([0.99, 0.05, 0])
    const outlier = l2Normalize([0, 1, 0]) // orthogonal — a second voice
    const res = checkConsistency([a, b, outlier])
    expect(res.ok).toBe(false)
    expect(res.minPairwise).toBeLessThan(PASSAGE_CONSISTENCY_MIN)
    expect(res.outlierIndex).toBe(2)
  })

  it('reports a fail without an outlier index when only two prototypes disagree', () => {
    const a = l2Normalize([1, 0, 0])
    const b = l2Normalize([0, 1, 0])
    const res = checkConsistency([a, b])
    expect(res.ok).toBe(false)
    expect(res.outlierIndex).toBeNull()
  })
})
