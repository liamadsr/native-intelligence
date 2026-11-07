'use client'

/**
 * Enrollment recorder hook — owns the microphone for the "Teach Dial8 your
 * voice" flow.
 *
 * Wraps `WebAudioCapture` (getUserMedia → 16 kHz mono Int16 PCM) with the two
 * things the wizard needs on top: a live RMS level for the meter, and a way to
 * capture a passage's audio as a single Float32 buffer for the chunker. The
 * Int16→Float32 conversion is the same math as AudioRingBuffer
 * (int16 / 32768) — the worker assumes Float32 [-1,1].
 *
 * Two capture modes drive the wizard:
 *  - mic-check: sample ~1s of ambient level to derive the noise floor, then
 *    watch for the first sustained speech to confirm the mic works.
 *  - passage: accumulate the whole passage's PCM; `stopPassage()` returns the
 *    Float32 buffer for the chunker (which slices/scores/floors it).
 *
 * All mic failures surface as the classified `WebAudioCaptureErrorKind` so the
 * mic-check step can branch per kind (permission-denied / no-device / in-use /
 * …). The hook never throws into render — errors land in `error`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  WebAudioCapture,
  WebAudioCaptureError,
  type WebAudioCaptureErrorKind,
} from '@/lib/web-audio-capture'
import { rms } from '@/lib/voice-profile/chunker'

/** Int16 LE bytes → Float32 [-1,1]. Same scaling as AudioRingBuffer.write. */
export function int16BytesToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleCount = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

interface RecorderState {
  /** Live mic RMS level (0..1) for the AudioLevelMeter. */
  level: number
  /** True while the mic is open and capturing. */
  recording: boolean
  /** Classified failure kind, or null. Drives per-kind mic-check copy. */
  error: WebAudioCaptureErrorKind | null
  /** Voiced seconds captured in the current passage (drives the progress UI).
   *  A coarse per-block estimate — the precise gate is the real chunker at
   *  passage-end. Resets on beginPassage. */
  passageVoicedSeconds: number
  /** Total samples accumulated in the current passage so far, published on a
   *  coarse cadence (~1s) rather than every PCM block. The flow watches this to
   *  drive INCREMENTAL chunk+embed passes over newly-stable audio during
   *  recording — so Continue only has a tiny tail left to finalize. Resets to 0
   *  on beginPassage. */
  passageSampleCount: number
}

export interface VoiceRecorder extends RecorderState {
  /** Open the mic. Resolves once audio is flowing; sets `error` on failure. */
  start: (deviceId?: string) => Promise<boolean>
  /** Release the mic + audio graph. */
  stop: () => void
  /** The deviceId of the open mic, or undefined when closed (or unreported). */
  openDeviceId: () => string | undefined
  /**
   * Snapshot the ambient noise floor ONCE from the pre-speech level samples
   * collected since the mic opened, then FREEZE it. Call at mic-check
   * completion (before any passage speech). Every later call — including the
   * chunker's floor lookup at passage-end — returns that frozen value, never a
   * fresh re-measure over speech-inflated samples. Reset only when the mic is
   * (re)opened via `start`.
   */
  measureNoiseFloor: () => number
  /** True once sustained speech (level above the floor margin) is detected. */
  speechDetected: boolean
  /** Begin accumulating a passage's raw PCM (clears any prior buffer). */
  beginPassage: () => void
  /**
   * Non-destructive read of the passage audio accumulated SO FAR as one Float32
   * buffer, WITHOUT stopping accumulation. The incremental embed path calls this
   * as `passageSampleCount` grows, chunks the new region past its consumed
   * offset, and embeds those in the background. Distinct from `endPassage`,
   * which stops accumulation and hands off the final buffer for the tail.
   */
  snapshotPassageAudio: () => Float32Array
  /** Stop accumulating and return the passage audio as one Float32 buffer. */
  endPassage: () => Float32Array
  /** Reset the error so the mic-check step can retry cleanly. */
  clearError: () => void
}

/** A running level below this many samples isn't enough to trust a floor. */
const MIN_FLOOR_SAMPLES = 5
/** Speech is "detected" once a level exceeds max(floor·margin, absolute). */
const SPEECH_MARGIN = 2.5
const SPEECH_ABSOLUTE_RMS = 0.02

/** Publish the growing passage sample count on this cadence (samples). Coarser
 *  than the PCM block rate (~10/s) so the incremental effect fires ~once/second,
 *  not on every block — one chunk (ENROLLMENT_CHUNK_SECONDS) becomes available
 *  every few ticks. */
const SAMPLE_COUNT_PUBLISH_INTERVAL = 16000 // ~1s at 16 kHz

export function useVoiceRecorder(): VoiceRecorder {
  const [level, setLevel] = useState(0)
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<WebAudioCaptureErrorKind | null>(null)
  const [speechDetected, setSpeechDetected] = useState(false)
  const [passageVoicedSeconds, setPassageVoicedSeconds] = useState(0)
  const [passageSampleCount, setPassageSampleCount] = useState(0)

  const captureRef = useRef<WebAudioCapture | null>(null)
  // Level samples collected during the PRE-SPEECH mic-check window, for the
  // noise-floor estimate. Reset when the mic (re)opens and again at the start
  // of each passage so speech never feeds the floor.
  const levelSamplesRef = useRef<number[]>([])
  const noiseFloorRef = useRef<number>(0)
  // Once the floor is snapshotted at mic-check completion it is frozen: later
  // measureNoiseFloor calls (e.g. the chunker's floor lookup at passage-end)
  // return the frozen value instead of re-measuring over speech samples.
  const noiseFloorFrozenRef = useRef(false)
  // Synchronous mirror of speech detection: the moment a qualifying speech level
  // arrives we STOP feeding the noise-floor sample buffer, so the floor is
  // measured over the pre-speech window only (state flips a render later — too
  // late; a few speech samples would otherwise slip in and inflate the floor).
  const speechSeenRef = useRef(false)
  // Passage PCM accumulation (Int16-derived Float32 blocks, concatenated on end).
  const passageBlocksRef = useRef<Float32Array[]>([])
  const accumulatingRef = useRef(false)
  // Running voiced-seconds tally for the current passage (block-level estimate).
  const voicedSecondsRef = useRef(0)
  // Running TOTAL sample count for the current passage (all blocks, voiced or
  // not) and the count at the last publish — so the growing count is surfaced
  // on a coarse cadence instead of every block.
  const totalSamplesRef = useRef(0)
  const lastPublishedSamplesRef = useRef(0)

  const start = useCallback(async (deviceId?: string): Promise<boolean> => {
    if (captureRef.current?.isRunning) return true
    setError(null)
    setSpeechDetected(false)
    levelSamplesRef.current = []
    noiseFloorFrozenRef.current = false
    speechSeenRef.current = false
    const capture = new WebAudioCapture()
    capture.onLevel = (lvl) => {
      setLevel(lvl)
      // Speech detection: level clears the floor margin (or an absolute floor
      // when the room was near-silent). One qualifying level flips the flag.
      const floor = noiseFloorRef.current
      const threshold = Math.max(floor * SPEECH_MARGIN, SPEECH_ABSOLUTE_RMS)
      const isSpeech = lvl >= threshold
      if (isSpeech) {
        speechSeenRef.current = true
        setSpeechDetected(true)
      }
      // Only PRE-SPEECH (and pre-freeze) samples feed the noise-floor estimate —
      // the very first speech sample and everything after are excluded so the
      // floor can never be inflated by the user's voice.
      if (!noiseFloorFrozenRef.current && !speechSeenRef.current) {
        levelSamplesRef.current.push(lvl)
      }
    }
    capture.onPcm = (bytes) => {
      if (!accumulatingRef.current) return
      const block = int16BytesToFloat32(bytes)
      passageBlocksRef.current.push(block)
      totalSamplesRef.current += block.length
      // Accumulate voiced seconds: a block whose RMS clears the floor margin
      // counts its wall-clock duration toward the passage's voiced total.
      const floor = noiseFloorRef.current
      const threshold = Math.max(floor * SPEECH_MARGIN, SPEECH_ABSOLUTE_RMS)
      if (rms(block) >= threshold) {
        voicedSecondsRef.current += block.length / 16000
        setPassageVoicedSeconds(voicedSecondsRef.current)
      }
      // Publish the growing total on a coarse cadence so the flow's incremental
      // chunk+embed effect fires ~once/second, not on every PCM block.
      if (
        totalSamplesRef.current - lastPublishedSamplesRef.current >=
        SAMPLE_COUNT_PUBLISH_INTERVAL
      ) {
        lastPublishedSamplesRef.current = totalSamplesRef.current
        setPassageSampleCount(totalSamplesRef.current)
      }
    }
    captureRef.current = capture
    try {
      await capture.start(deviceId ? { deviceId } : {})
      setRecording(true)
      return true
    } catch (err) {
      const kind: WebAudioCaptureErrorKind =
        err instanceof WebAudioCaptureError ? err.kind : 'unknown'
      setError(kind)
      setRecording(false)
      captureRef.current = null
      return false
    }
  }, [])

  const stop = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    accumulatingRef.current = false
    setRecording(false)
    setLevel(0)
  }, [])

  const openDeviceId = useCallback(
    (): string | undefined => captureRef.current?.deviceId,
    [],
  )

  const measureNoiseFloor = useCallback((): number => {
    // Frozen: return the snapshot taken at mic-check completion. This is what
    // the chunker's passage-end floor lookup hits — it must NOT re-measure over
    // the (now speech-laden) sample buffer, which would inflate the voiced
    // threshold and fail otherwise-good takes.
    if (noiseFloorFrozenRef.current) return noiseFloorRef.current

    const samples = levelSamplesRef.current
    if (samples.length < MIN_FLOOR_SAMPLES) {
      // Too few samples to trust — fall back to a conservative small floor so
      // the SNR proxy doesn't divide by ~0.
      noiseFloorRef.current = 0.004
    } else {
      noiseFloorRef.current = samples.reduce((a, b) => a + b, 0) / samples.length
    }
    // Snapshot taken — freeze it for the rest of this mic session.
    noiseFloorFrozenRef.current = true
    return noiseFloorRef.current
  }, [])

  const beginPassage = useCallback(() => {
    passageBlocksRef.current = []
    accumulatingRef.current = true
    voicedSecondsRef.current = 0
    totalSamplesRef.current = 0
    lastPublishedSamplesRef.current = 0
    // Drop any residual pre-freeze level samples so they can never be re-read
    // as a floor (the floor is already frozen; this keeps the buffer clean).
    levelSamplesRef.current = []
    setPassageVoicedSeconds(0)
    setPassageSampleCount(0)
    setSpeechDetected(false)
  }, [])

  // Flatten the accumulated blocks into one contiguous Float32 buffer. Shared by
  // the non-destructive snapshot and the destructive endPassage.
  const flattenBlocks = (blocks: Float32Array[]): Float32Array => {
    const total = blocks.reduce((sum, b) => sum + b.length, 0)
    const out = new Float32Array(total)
    let offset = 0
    for (const b of blocks) {
      out.set(b, offset)
      offset += b.length
    }
    return out
  }

  const snapshotPassageAudio = useCallback((): Float32Array => {
    // Non-destructive: copy the blocks accumulated so far, leave accumulation
    // running. `slice()` on each block would double-copy; flattenBlocks already
    // copies into a fresh buffer, so the returned buffer never aliases live
    // block memory.
    return flattenBlocks(passageBlocksRef.current)
  }, [])

  const endPassage = useCallback((): Float32Array => {
    accumulatingRef.current = false
    const blocks = passageBlocksRef.current
    passageBlocksRef.current = []
    return flattenBlocks(blocks)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  // Release the mic if the component unmounts mid-capture.
  useEffect(() => {
    return () => {
      captureRef.current?.stop()
      captureRef.current = null
    }
  }, [])

  return {
    level,
    recording,
    error,
    speechDetected,
    passageVoicedSeconds,
    passageSampleCount,
    start,
    stop,
    openDeviceId,
    measureNoiseFloor,
    beginPassage,
    snapshotPassageAudio,
    endPassage,
    clearError,
  }
}
