/**
 * Enrollment audio chunker — pure signal analysis for the "Teach Dial8 your
 * voice" flow. Given a passage's raw 16 kHz mono Float32 samples and the ambient
 * noise floor measured during mic-check, it:
 *
 *   1. finds VOICED regions (RMS above the noise floor + margin),
 *   2. slices them into fixed ENROLLMENT_CHUNK_SECONDS windows,
 *   3. scores each chunk's quality (duration + level + SNR proxy), and
 *   4. drops chunks below ENROLLMENT_MIN_CHUNK_QUALITY.
 *
 * This is NEW code — the existing Voice-ID pipeline has zero energy analysis
 * (only duration + Deepgram diarization gates), so nothing here reuses those
 * primitives. Everything is a pure function of its inputs (no Worker, no DOM),
 * so it's fully unit-testable and the enrollment recorder hook can call it
 * synchronously as audio accumulates.
 *
 * The consistency check (min pairwise cosine among the three passage prototypes)
 * lives here too so the guard against "a second voice mid-take" is one testable
 * unit alongside the chunking that feeds it.
 */

import {
  ENROLLMENT_CHUNK_SECONDS,
  ENROLLMENT_MIN_CHUNK_QUALITY,
  PASSAGE_CONSISTENCY_MIN,
  QUALITY_WEIGHT_DURATION,
  QUALITY_WEIGHT_LEVEL,
  QUALITY_WEIGHT_SNR,
} from './types'
import { cosineSimilarity } from '@/lib/voice-id-matching'

/** Sample rate of the enrollment audio (matches WebAudioCapture output). */
export const CHUNK_SAMPLE_RATE = 16000

// --- Quality sub-score tuning ---
//
// The sub-score WEIGHTS live in voice-profile/types alongside the other
// enrollment constants (imported above) — §4's constants file. The mapping
// ANCHORS below (level/SNR/voiced-floor thresholds) are private analysis
// internals of this pure module and stay local.

/** RMS at/above this (0..1) scores a perfect level; a healthy speaking voice
 *  through the conferencing DSP sits well under this, so it's a soft ceiling. */
const LEVEL_FULL_SCORE_RMS = 0.15
/** SNR (chunk RMS ÷ noise-floor RMS) at/above this scores a perfect SNR proxy.
 *  ~6× the ambient floor ≈ +15 dB, comfortably "clean speech over quiet room". */
const SNR_FULL_SCORE_RATIO = 6
/** Voiced regions need RMS at least this multiple of the noise floor. Below it,
 *  the sample is treated as silence/room tone, not speech. */
const VOICED_FLOOR_MARGIN = 1.8
/** Absolute floor so a dead-silent mic-check (noiseFloor ≈ 0) can't classify
 *  faint hiss as voiced. Roughly the RMS of a very quiet spoken syllable. */
const MIN_VOICED_RMS = 0.008

/** Clamp a number into [0, 1]. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/** RMS (root-mean-square level) of a sample window, 0..1. */
export function rms(samples: Float32Array | number[], start = 0, end?: number): number {
  const to = end ?? samples.length
  const n = to - start
  if (n <= 0) return 0
  let sumSq = 0
  for (let i = start; i < to; i++) {
    const s = samples[i]
    sumSq += s * s
  }
  const value = Math.sqrt(sumSq / n)
  return Number.isFinite(value) ? value : 0
}

/** A voiced audio slice (indices into the source buffer) with its measured RMS. */
export interface VoicedRegion {
  startSample: number
  endSample: number
  rms: number
}

/**
 * Find contiguous voiced regions: windows whose RMS exceeds the noise floor by
 * VOICED_FLOOR_MARGIN (and the absolute MIN_VOICED_RMS). Analysed on a coarse
 * hop so a single dip between words doesn't fragment a region — adjacent voiced
 * hops are merged, and short unvoiced gaps (< gapMergeSeconds) are bridged.
 */
export function findVoicedRegions(
  samples: Float32Array,
  noiseFloor: number,
  opts: { hopSeconds?: number; gapMergeSeconds?: number } = {},
): VoicedRegion[] {
  const hop = Math.max(1, Math.floor((opts.hopSeconds ?? 0.1) * CHUNK_SAMPLE_RATE))
  const gapMerge = Math.floor((opts.gapMergeSeconds ?? 0.3) * CHUNK_SAMPLE_RATE)
  const threshold = Math.max(MIN_VOICED_RMS, noiseFloor * VOICED_FLOOR_MARGIN)

  const regions: VoicedRegion[] = []
  let regionStart = -1
  let unvoicedRun = 0

  for (let pos = 0; pos < samples.length; pos += hop) {
    const end = Math.min(pos + hop, samples.length)
    const level = rms(samples, pos, end)
    const voiced = level >= threshold
    if (voiced) {
      if (regionStart < 0) regionStart = pos
      unvoicedRun = 0
    } else if (regionStart >= 0) {
      unvoicedRun += end - pos
      // Only close the region once the unvoiced run exceeds the merge gap, so a
      // brief pause between words keeps one region.
      if (unvoicedRun >= gapMerge) {
        const regionEnd = pos - (unvoicedRun - (end - pos))
        pushRegion(regions, samples, regionStart, regionEnd)
        regionStart = -1
        unvoicedRun = 0
      }
    }
  }
  if (regionStart >= 0) pushRegion(regions, samples, regionStart, samples.length)
  return regions
}

function pushRegion(
  out: VoicedRegion[],
  samples: Float32Array,
  startSample: number,
  endSample: number,
): void {
  if (endSample <= startSample) return
  out.push({ startSample, endSample, rms: rms(samples, startSample, endSample) })
}

/** One chunk of voiced audio ready to embed, with its per-chunk quality score. */
export interface AudioChunk {
  /** 16 kHz mono Float32 [-1,1], exactly ENROLLMENT_CHUNK_SECONDS long (except a
   *  final partial chunk, which is kept only if it still clears MIN_CHUNK_SECS). */
  audio: Float32Array
  /** Aggregate per-chunk quality 0..1 (duration + level + SNR proxy). */
  quality: number
  /** Component sub-scores, exposed for diagnostics/tests. */
  durationScore: number
  levelScore: number
  snrScore: number
  /** Absolute sample index of this chunk's start in the source buffer. */
  startSample: number
  /** Absolute sample index one past this chunk's end (the incremental path
   *  advances its consumed offset to this once the chunk is embedded). */
  endSample: number
}

/** A trailing region shorter than this (seconds) is dropped, not embedded — a
 *  partial chunk well below the pipeline's MIN_SEGMENT_DURATION is noisy. */
const MIN_CHUNK_SECONDS = 2.0

/**
 * Score one chunk of voiced audio.
 *
 *   durationScore — 1.0 for a full-length chunk, linearly less for a short tail.
 *   levelScore    — RMS mapped onto [0,1] against LEVEL_FULL_SCORE_RMS.
 *   snrScore      — (chunk RMS ÷ noise floor) mapped against SNR_FULL_SCORE_RATIO.
 *
 * quality = clamp01(0.5·duration + 0.3·level + 0.2·snr).
 */
export function scoreChunk(
  audio: Float32Array,
  noiseFloor: number,
): { quality: number; durationScore: number; levelScore: number; snrScore: number } {
  const seconds = audio.length / CHUNK_SAMPLE_RATE
  const durationScore = clamp01(seconds / ENROLLMENT_CHUNK_SECONDS)

  const level = rms(audio)
  const levelScore = clamp01(level / LEVEL_FULL_SCORE_RMS)

  // SNR proxy: how far above the ambient floor this chunk sits. A dead-silent
  // mic-check (floor ~0) can't manufacture infinite SNR — clamp the floor.
  const floor = Math.max(noiseFloor, MIN_VOICED_RMS)
  const snrScore = clamp01(level / floor / SNR_FULL_SCORE_RATIO)

  const quality = clamp01(
    QUALITY_WEIGHT_DURATION * durationScore +
      QUALITY_WEIGHT_LEVEL * levelScore +
      QUALITY_WEIGHT_SNR * snrScore,
  )
  return { quality, durationScore, levelScore, snrScore }
}

/**
 * Slice a passage's raw audio into scored chunks: extract voiced regions, cut
 * them into ENROLLMENT_CHUNK_SECONDS windows, score each, and drop any below
 * ENROLLMENT_MIN_CHUNK_QUALITY. Returns the accepted chunks in capture order.
 *
 * This is the whole-passage (finalize) path — it consumes trailing partial
 * windows too (a ≥ MIN_CHUNK_SECONDS tail of a region still counts). For the
 * incremental-during-recording path use `chunkPassageAudioFrom`, which resumes
 * at an offset and never touches a full-length window's worth of trailing audio
 * (that region may still be growing).
 */
export function chunkPassageAudio(
  samples: Float32Array,
  noiseFloor: number,
): AudioChunk[] {
  const chunkSamples = ENROLLMENT_CHUNK_SECONDS * CHUNK_SAMPLE_RATE
  const minChunkSamples = MIN_CHUNK_SECONDS * CHUNK_SAMPLE_RATE
  const regions = findVoicedRegions(samples, noiseFloor)
  const chunks: AudioChunk[] = []

  for (const region of regions) {
    for (let start = region.startSample; start < region.endSample; start += chunkSamples) {
      const end = Math.min(start + chunkSamples, region.endSample)
      // Skip a trailing sliver that's too short to embed reliably.
      if (end - start < minChunkSamples) continue
      const audio = samples.slice(start, end)
      const scored = scoreChunk(audio, noiseFloor)
      if (scored.quality < ENROLLMENT_MIN_CHUNK_QUALITY) continue
      chunks.push({ audio, ...scored, startSample: start, endSample: end })
    }
  }
  return chunks
}

/** Result of an offset-aware incremental chunk pass. */
export interface IncrementalChunkResult {
  /** Newly accepted chunks whose audio lies entirely at/after `offset` and
   *  entirely within the already-stable prefix of `samples`. */
  chunks: AudioChunk[]
  /** Absolute sample index to resume the NEXT pass from — one past the last
   *  emitted chunk. Regions at/after this index are never re-chunked. When no
   *  full chunk was emitted this pass, equals the input `offset` (no progress). */
  nextOffset: number
}

/**
 * Offset-aware chunker for the incremental-during-recording path. Given the
 * passage buffer accumulated SO FAR and the sample index already consumed by a
 * prior pass, it chunks only the newly-stable region past `offset` and reports
 * how far it consumed so the next pass never re-chunks or re-embeds the same
 * audio.
 *
 * Two rules keep it safe against a buffer that is still growing AND make the
 * incremental output reconstruct the whole-buffer pass exactly:
 *   1. Only FULL-length windows (ENROLLMENT_CHUNK_SECONDS) are emitted here — a
 *      trailing partial window is left for the finalize pass (`chunkPassageAudio`
 *      over `samples.subarray(nextOffset)`), since that tail may still be
 *      growing and, once stable, still yields a ≥ MIN_CHUNK_SECONDS chunk there.
 *   2. `nextOffset` marches forward only while regions tile cleanly into full
 *      windows. The FIRST region that leaves a sub-window tail STOPS the march:
 *      that tail (and every later region) is reconsidered at finalize, so a
 *      short region tail is never stranded between the consumed offset and the
 *      tail pass.
 *
 * Pure: analysis is a function of (samples, noiseFloor, offset) with the SAME
 * frozen floor mic-check locked, so incremental chunks are byte-identical to
 * what a single whole-buffer pass would have produced for that prefix.
 */
export function chunkPassageAudioFrom(
  samples: Float32Array,
  noiseFloor: number,
  offset: number,
): IncrementalChunkResult {
  const chunkSamples = ENROLLMENT_CHUNK_SECONDS * CHUNK_SAMPLE_RATE
  const from = Math.max(0, Math.min(offset, samples.length))
  if (samples.length - from < chunkSamples) {
    // Not even one full window of new audio yet — nothing stable to emit.
    return { chunks: [], nextOffset: from }
  }

  const regions = findVoicedRegions(samples.subarray(from), noiseFloor)
  const chunks: AudioChunk[] = []
  let nextOffset = from

  for (const region of regions) {
    // Region indices are relative to the subarray; shift back to absolute.
    const regionStart = from + region.startSample
    const regionEnd = from + region.endSample
    let start = regionStart
    for (; start + chunkSamples <= regionEnd; start += chunkSamples) {
      const end = start + chunkSamples
      const audio = samples.slice(start, end)
      const scored = scoreChunk(audio, noiseFloor)
      nextOffset = end
      if (scored.quality < ENROLLMENT_MIN_CHUNK_QUALITY) continue
      chunks.push({ audio, ...scored, startSample: start, endSample: end })
    }
    // If this region left a sub-window tail (< chunkSamples), stop advancing —
    // the finalize pass owns that tail and everything after it. Marching past it
    // would strand a chunk the whole-buffer pass keeps.
    if (regionEnd - start > 0) break
  }
  return { chunks, nextOffset }
}

/** Total voiced seconds across a set of chunks (for the ≥15s passage gate). */
export function voicedSeconds(chunks: AudioChunk[]): number {
  let total = 0
  for (const c of chunks) total += c.audio.length / CHUNK_SAMPLE_RATE
  return total
}

/** Result of the cross-passage consistency check. */
export interface ConsistencyResult {
  /** True when every pairwise cosine among the prototypes clears the floor. */
  ok: boolean
  /** The minimum pairwise cosine observed (1 when < 2 prototypes). */
  minPairwise: number
  /** Index of the prototype that is the outlier (lowest mean similarity to the
   *  rest), or null when consistent / fewer than 3 prototypes. */
  outlierIndex: number | null
}

/**
 * Consistency check across the passage prototypes (one unit-norm mean per
 * passage). Guards against a TV / a second person reading a passage: if the min
 * pairwise cosine among prototypes drops below PASSAGE_CONSISTENCY_MIN, the
 * take is inconsistent and the outlier passage is flagged for a re-read.
 *
 * With < 2 prototypes there's nothing to compare → trivially consistent. With
 * exactly 2 there's no "outlier" to single out, so outlierIndex stays null even
 * on a fail (the caller re-reads whichever it chooses).
 */
export function checkConsistency(prototypes: number[][]): ConsistencyResult {
  const n = prototypes.length
  if (n < 2) return { ok: true, minPairwise: 1, outlierIndex: null }

  let minPairwise = Infinity
  // Per-prototype accumulated similarity to the others (to pick the outlier).
  const meanSim = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(prototypes[i], prototypes[j])
      if (sim < minPairwise) minPairwise = sim
      meanSim[i] += sim
      meanSim[j] += sim
    }
  }
  for (let i = 0; i < n; i++) meanSim[i] /= n - 1

  const ok = minPairwise >= PASSAGE_CONSISTENCY_MIN
  let outlierIndex: number | null = null
  if (!ok && n >= 3) {
    // The outlier is the prototype least similar to the rest on average.
    let worst = Infinity
    for (let i = 0; i < n; i++) {
      if (meanSim[i] < worst) {
        worst = meanSim[i]
        outlierIndex = i
      }
    }
  }
  return { ok, minPairwise, outlierIndex }
}
