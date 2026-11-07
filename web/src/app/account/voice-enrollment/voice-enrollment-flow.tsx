'use client'

/**
 * "Teach Dial8 your voice" — the full-page enrollment flow.
 *
 * Modeled on onboarding-wizard.tsx: a min-h-dvh centered max-w-lg column with an
 * AnimatePresence step swap (slide x + fade, 0.25s). Steps:
 *
 *   intro → mic-check → passage-1 → passage-2 → passage-3 → processing → done
 *
 * The user reads three story passages aloud. Each passage is captured as one
 * session_id; its voiced audio is sliced/scored by the chunker and embedded by a
 * PRIVATE worker (EnrollmentEmbedder — never the shared VoiceIdService
 * singleton). At the end we run the cross-passage consistency check, then POST
 * every accepted chunk to /api/account/voice-profile ONCE. Nothing is stored
 * until that final POST, so abandoning at any point is always clean.
 *
 * Embedding happens INCREMENTALLY DURING recording, not all-at-once on Continue.
 * As a passage's audio accrues, an effect chunks the newly-stable region past a
 * per-passage consumed offset and embeds those chunks in the background. Continue
 * (`finalizePassage`) then only has to chunk+embed the small remaining tail
 * (usually 0–2 chunks), so it flashes a pending state for well under a second
 * instead of freezing for seconds while the whole passage embeds on the click.
 * Every incremental embed is paired 1:1 with its chunk; a background failure
 * simply doesn't advance the offset, so finalize re-chunks+embeds the gap (the
 * old whole-passage path) and the worst case equals the pre-incremental behavior.
 * A per-passage generation token discards in-flight incremental results when the
 * passage restarts (mount, retry, consistency re-read) or the flow unmounts.
 *
 * Resilience (all required): a model-load gate on the intro CTA; per-kind
 * mic-failure copy; a retry cap per passage with an "use it anyway" escape (only
 * when the aggregate still clears the floors) or a clean bail to Settings; a
 * quiet header close on every step; aria-live step + recording announcements;
 * always-present Continue buttons (auto-advance is progressive enhancement);
 * focus moves to each step's heading; celebrate() confetti on done.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { celebrate } from '@/components/celebration/celebrate'
import { CelebrationOverlay } from '@/components/celebration/celebration-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { meanVector } from '@/lib/voice-id-matching'
import {
  ENROLLMENT_MIN_CHUNKS,
  MAX_ENROLLMENT_CHUNKS,
  PASSAGE_MIN_CHUNKS,
  PASSAGE_MAX_RETRIES,
  type VoiceProfileChunk,
} from '@/lib/voice-profile/types'
import { ENROLLMENT_STORY } from '@/lib/voice-profile/enrollment-story'
import { EnrollmentEmbedder } from '@/lib/voice-profile/enrollment-embedder'
import {
  chunkPassageAudio,
  chunkPassageAudioFrom,
  checkConsistency,
  voicedSeconds as sumVoicedSeconds,
  type AudioChunk,
} from '@/lib/voice-profile/chunker'
import { useVoiceProfile } from '@/hooks/use-voice-profile'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'
import { desktopActiveMic } from '@/lib/desktop-mic-device'
import { useVoiceRecorder } from '@/components/voice-enrollment/use-voice-recorder'
import { IntroStep, ProcessingStep, DoneStep } from '@/components/voice-enrollment/enrollment-steps'
import { MicCheckStep } from '@/components/voice-enrollment/mic-check-step'
import { PassageCard } from '@/components/voice-enrollment/passage-card'

type Step =
  | 'intro'
  | 'mic-check'
  | 'passage-1'
  | 'passage-2'
  | 'passage-3'
  | 'processing'
  | 'done'

/** Voiced seconds a passage needs before auto-advance is offered. */
const PASSAGE_TARGET_SECONDS = 15

/** One passage's embedded result. */
interface PassageResult {
  sessionId: string
  chunks: AudioChunk[]
  /** Per-chunk embeddings (unit-norm, length 512, asserted by the embedder). */
  embeddings: number[][]
  /** Unit-norm mean prototype for the passage (for the consistency check). */
  prototype: number[]
}

/**
 * Live accumulator for the CURRENTLY-recording passage. The incremental effect
 * chunks the newly-stable audio past `offset` and embeds it in the background,
 * appending 1:1-paired chunks+embeddings here. `finalizePassage` then chunks
 * only the tail past `offset` and merges. Reset (fresh sessionId, offset 0,
 * empty arrays) on every beginPassage. `generation` guards against applying a
 * stale in-flight embed after the passage restarted.
 */
interface PassageAccumulator {
  sessionId: string
  /** Sample offset already chunked+embedded (or attempted) — the chunker resumes
   *  here so no region is embedded twice. */
  offset: number
  chunks: AudioChunk[]
  embeddings: number[][]
  /** The generation this accumulator belongs to; a mismatch means it's stale. */
  generation: number
}

function isPassageStep(step: Step): step is 'passage-1' | 'passage-2' | 'passage-3' {
  return step === 'passage-1' || step === 'passage-2' || step === 'passage-3'
}

/** 0-based passage index for a passage step. */
function passageIndex(step: 'passage-1' | 'passage-2' | 'passage-3'): number {
  return Number(step.slice('passage-'.length)) - 1
}

export function VoiceEnrollmentFlow() {
  const router = useRouter()
  const { refresh } = useVoiceProfile()
  const recorder = useVoiceRecorder()

  const [step, setStep] = useState<Step>('intro')
  const [modelReady, setModelReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  // Live voiced-seconds for the current passage comes straight off the recorder.
  const voicedSecs = recorder.passageVoicedSeconds
  // Growing sample count drives the incremental chunk+embed effect.
  const sampleCount = recorder.passageSampleCount
  // Per-passage retry counter + the "one more time?" reason.
  const [retryCount, setRetryCount] = useState(0)
  const [retryReason, setRetryReason] = useState<string | null>(null)
  const [escapeOffered, setEscapeOffered] = useState(false)
  const [postError, setPostError] = useState(false)
  // True while Continue is finalizing the tail (chunk+embed the small remaining
  // region + advance). Real state so the passage card can disable Continue and
  // show a spinner; typically flashes for well under a second now that the bulk
  // was already embedded incrementally. The ref-based re-entry guard below stays
  // for correctness — this drives only the UI.
  const [advancing, setAdvancing] = useState(false)
  // Set when the consistency check fails with no recoverable path (no
  // identifiable outlier, or the outlier passage has exhausted its retries).
  // We NEVER POST a known-inconsistent (two-voice) profile — the user picks
  // "Start over" or "Try again later".
  const [consistencyFailed, setConsistencyFailed] = useState(false)

  const embedderRef = useRef<EnrollmentEmbedder | null>(null)
  // Accumulated results by passage index (0..2).
  const resultsRef = useRef<Map<number, PassageResult>>(new Map())
  // The live accumulator for the passage currently recording (incremental
  // chunks+embeddings + consumed offset). Reset on every beginPassage.
  const accumRef = useRef<PassageAccumulator | null>(null)
  // Bumped on every beginPassage (mount / retry / consistency re-read). An
  // incremental embed pass captures the generation before it starts and discards
  // its result if the passage restarted meanwhile — so a slow embed can't leak
  // into a fresh accumulator or a later passage.
  const generationRef = useRef(0)
  // Only one incremental chunk+embed pass runs at a time (FIFO) so passes can't
  // overlap-embed the same region or race the offset.
  const incrementalBusyRef = useRef(false)
  // False after unmount — guards state updates from in-flight async work.
  const mountedRef = useRef(true)
  // Per-passage consistency-bounce counts (keyed by passage index). A bounce
  // for the same passage counts toward PASSAGE_MAX_RETRIES so a passage that
  // never matches the others can't loop forever.
  const consistencyRetriesRef = useRef<Map<number, number>>(new Map())
  // A retry reason set during a step transition (e.g. a consistency bounce),
  // consumed by the passage-mount effect so it survives the effect that would
  // otherwise wipe it before paint (finding: reason must show after a bounce).
  const pendingReasonRef = useRef<string | null>(null)
  // Passage index we bounced back for a CONSISTENCY re-read. Re-reading it must
  // return straight to processing to re-check consistency — NOT advance linearly
  // (which would overwrite the already-good later passages).
  const consistencyReReadRef = useRef<number | null>(null)
  const headingRef = useRef<HTMLDivElement | null>(null)
  const advancingRef = useRef(false)
  // Latches auto-advance to ONE fire per capture attempt. Reset on every fresh
  // beginPassage (mount + re-read) so a re-read can auto-advance again, but a
  // failed take that keeps voicedSecs high can't loop-fire.
  const autoAdvancedRef = useRef(false)
  // Which passage step the recorder has actively accrued voiced seconds for.
  // Auto-advance only fires when this matches the current step, so the mount
  // render's STALE voicedSecs (the prior passage's total, before beginPassage's
  // reset flushes) can't instantly consume a retry with an empty buffer.
  const armedStepRef = useRef<Step | null>(null)

  // ── Model load (private worker) ─────────────────────────────
  // Preload on intro mount so the worker is warm before recording. The load ack
  // drives the intro CTA gate; a load error offers a retry.
  const loadModel = useCallback(() => {
    setLoadError(false)
    if (!embedderRef.current) embedderRef.current = new EnrollmentEmbedder()
    embedderRef.current
      .load()
      .then(() => setModelReady(true))
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadModel()
    return () => {
      // Unmount: flip the mounted guard so any in-flight incremental/finalize
      // embed drops its result instead of touching state (every async callback
      // checks mountedRef), then tear the worker down (which rejects pending
      // embeds — caught, never crashes). The per-passage generation handles
      // staleness while mounted; the mounted guard covers unmount.
      mountedRef.current = false
      embedderRef.current?.terminate()
      embedderRef.current = null
    }
  }, [loadModel])

  // No read-aloud while the mic is (or is about to be) open: a reply read
  // aloud now would be learned into the voiceprint as the user's voice.
  const micLive = recorder.recording || step === 'mic-check' || isPassageStep(step)
  useEffect(() => {
    if (!micLive) return
    return holdReadAloud()
  }, [micLive])

  // Move focus to the step heading on each transition (a11y).
  useEffect(() => {
    const el = headingRef.current?.querySelector<HTMLElement>('h1')
    el?.focus()
  }, [step])

  // ── Step transitions ────────────────────────────────────────

  // Mirror of `step` for async continuations (startMic's second lookup).
  const stepRef = useRef<Step>(step)
  useEffect(() => {
    stepRef.current = step
  }, [step])

  // Open `deviceId`; if it won't open, the default.
  const openMic = useCallback(
    async (deviceId: string) => {
      if (await recorder.start(deviceId)) return true
      recorder.clearError()
      return recorder.start()
    },
    [recorder],
  )

  // Open the mic. In the desktop app, the desktop's chosen mic (its input
  // priority list, matched to a webview device by label); if that device
  // won't open — or anywhere else — the default.
  //
  // WebKit hides device labels until the document has opened a mic, and in
  // the desktop app this is normally the first getUserMedia since the page
  // loaded. So when the match missed on hidden labels, open the default (that
  // grants permission), look again, and move to the chosen device if it is a
  // different one — still in mic-check, before the noise floor is measured.
  const startMic = useCallback(async () => {
    const first = await desktopActiveMic()
    if (first.deviceId) return openMic(first.deviceId)
    if (!(await recorder.start())) return false
    if (!first.labelsHidden) return true
    const { deviceId } = await desktopActiveMic()
    const open = recorder.openDeviceId()
    // Closed meanwhile (bail/unmount), moved past mic-check, no match, or
    // already on it: keep what's open.
    if (!mountedRef.current || stepRef.current !== 'mic-check') return true
    if (!deviceId || !open || open === deviceId) return true
    recorder.stop()
    return openMic(deviceId)
  }, [recorder, openMic])

  const goMicCheck = useCallback(async () => {
    setStep('mic-check')
    await startMic()
  }, [startMic])

  // Advance from mic-check once speech is detected: lock the noise floor, then
  // begin passage 1 on the SAME open mic. Depend on the primitive fields we read
  // (the recorder's methods are stable useCallbacks) so this re-fires the moment
  // speech is detected.
  const { speechDetected, measureNoiseFloor, beginPassage } = recorder
  useEffect(() => {
    if (step !== 'mic-check' || !speechDetected) return
    measureNoiseFloor()
    setStep('passage-1')
  }, [step, speechDetected, measureNoiseFloor])

  // Discard the current passage's incremental accumulation and start a fresh
  // one on the same open mic: bump the generation (so any in-flight incremental
  // embed is dropped), reset the recorder buffer, and seed a new accumulator
  // with a fresh sessionId + zero offset. Called on every fresh read of a
  // passage: mount, thin-take retry, and consistency re-read.
  const resetPassageAccumulation = useCallback(() => {
    generationRef.current++
    accumRef.current = {
      sessionId: crypto.randomUUID(),
      offset: 0,
      chunks: [],
      embeddings: [],
      generation: generationRef.current,
    }
    incrementalBusyRef.current = false
    beginPassage()
  }, [beginPassage])

  // Begin accumulating the current passage's audio whenever a passage step
  // mounts (fresh buffer, reset counters). A reason carried across a step
  // transition (a consistency bounce) is consumed here instead of wiped, so it
  // renders on the target passage.
  useEffect(() => {
    if (!isPassageStep(step)) return
    setRetryReason(pendingReasonRef.current)
    pendingReasonRef.current = null
    setEscapeOffered(false)
    advancingRef.current = false
    setAdvancing(false)
    autoAdvancedRef.current = false
    // Not yet armed for THIS step: beginPassage resets the recorder's voiced
    // tally to 0 asynchronously, so until we observe a fresh sub-target reading
    // for this step the auto-advance effect must not fire on the prior passage's
    // stale count.
    armedStepRef.current = null
    resetPassageAccumulation()
  }, [step, resetPassageAccumulation])

  // ── Incremental embedding during recording ──────────────────
  // As the passage's audio grows, chunk the newly-stable region past the
  // accumulator's consumed offset and embed those chunks in the background. Runs
  // one pass at a time (FIFO). Every embed is paired 1:1 with its chunk. A
  // generation check discards results if the passage restarted mid-embed; a
  // background embed FAILURE leaves the offset where it was so finalize re-chunks
  // and embeds the gap (the old whole-passage path) — worst case == today.
  useEffect(() => {
    if (!isPassageStep(step)) return
    if (incrementalBusyRef.current) return
    const accum = accumRef.current
    const embedder = embedderRef.current
    if (!accum || !embedder) return

    // Snapshot the audio so far; bail if there isn't a full new chunk yet.
    const audio = recorder.snapshotPassageAudio()
    const floor = recorder.measureNoiseFloor()
    const { chunks, nextOffset } = chunkPassageAudioFrom(audio, floor, accum.offset)
    if (chunks.length === 0) return

    incrementalBusyRef.current = true
    const gen = accum.generation
    void (async () => {
      // Advance the consumed offset to nextOffset only if the WHOLE pass embeds;
      // on a mid-pass failure we advance just past the last embedded chunk so the
      // failed region (and everything after) is re-chunked+embedded at finalize.
      let embeddedThrough = accum.offset
      try {
        for (const chunk of chunks) {
          // Copy so the embedder can transfer the buffer without stealing the
          // chunk's (we keep chunks for the "use it anyway" path + prototypes).
          const embedding = await embedder.embed(chunk.audio.slice())
          // The passage may have restarted (retry / re-read / unmount) while this
          // embed was in flight — drop a stale result rather than corrupt a fresh
          // accumulator. accumRef identity also changes on reset, so re-read it.
          if (!mountedRef.current) return
          const live = accumRef.current
          if (!live || live.generation !== gen) return
          live.chunks.push(chunk)
          live.embeddings.push(embedding)
          embeddedThrough = chunk.endSample
          live.offset = embeddedThrough
        }
        // Whole pass embedded: advance past any rejected trailing window too, so
        // a below-quality window isn't re-scanned every pass.
        const live = accumRef.current
        if (mountedRef.current && live && live.generation === gen) {
          live.offset = Math.max(live.offset, nextOffset)
        }
      } catch {
        // Background embed failed after `embeddedThrough`. The offset already
        // sits there (set per successful chunk above), so finalize re-chunks and
        // embeds the remainder — the old whole-passage path. Never crashes.
      } finally {
        incrementalBusyRef.current = false
      }
    })()
  }, [step, sampleCount, recorder])

  // Finalize a passage: merge the incrementally-embedded chunks with the small
  // remaining TAIL (chunk+embed only the region past the accumulator's consumed
  // offset), then build the prototype from all embeddings. The bulk of the audio
  // was already embedded during recording, so this typically embeds 0–2 chunks —
  // Continue flashes rather than freezes. Returns the accepted chunks, or a
  // failure with a stated reason. The thin-take check counts ALL accepted chunks
  // (incremental + tail).
  const finalizePassage = useCallback(
    async (): Promise<{ ok: true; result: PassageResult } | { ok: false; reason: string }> => {
      // Snapshot the accumulator identity BEFORE the await — a restart would swap
      // accumRef, and we must not merge a fresh accumulator into this finalize.
      const accum = accumRef.current
      const audio = recorder.endPassage()
      const floor = recorder.measureNoiseFloor()

      const embedder = embedderRef.current
      if (!embedder) return { ok: false, reason: 'The voice model isn’t ready — try again.' }

      // Already-embedded incremental chunks for this passage.
      const priorChunks = accum ? accum.chunks.slice() : []
      const priorEmbeddings = accum ? accum.embeddings.slice() : []
      // Tail = everything past what the incremental path consumed. On the rare
      // path where there was no accumulator (or a background failure left a gap),
      // offset 0 means the tail IS the whole passage — worst case equals today.
      const tailStart = accum ? accum.offset : 0
      const tail = audio.length > tailStart ? audio.subarray(tailStart) : new Float32Array(0)
      const tailChunks = chunkPassageAudio(tail, floor)

      const totalChunkCount = priorChunks.length + tailChunks.length
      if (totalChunkCount < PASSAGE_MIN_CHUNKS) {
        const seconds =
          sumVoicedSeconds(priorChunks) + sumVoicedSeconds(tailChunks)
        const reason =
          seconds < 5
            ? 'That one didn’t come through — try reading it a bit louder and slower.'
            : 'That was a little short or quiet — one more time?'
        return { ok: false, reason }
      }

      const tailEmbeddings: number[][] = []
      try {
        for (const chunk of tailChunks) {
          // Copy the audio so the embedder can transfer its buffer without
          // stealing the chunk's (we keep chunks for the "use it anyway" path).
          const embedding = await embedder.embed(chunk.audio.slice())
          tailEmbeddings.push(embedding)
        }
      } catch {
        return { ok: false, reason: 'We couldn’t process that recording — one more time?' }
      }

      const chunks = [...priorChunks, ...tailChunks]
      const embeddings = [...priorEmbeddings, ...tailEmbeddings]
      const prototype = meanVector(embeddings)
      // Reuse the accumulator's sessionId so a passage keeps ONE session_id even
      // across the incremental→tail merge (per-passage prototypes depend on it).
      const sessionId = accum ? accum.sessionId : crypto.randomUUID()
      return { ok: true, result: { sessionId, chunks, embeddings, prototype } }
    },
    [recorder],
  )

  // Advance a passage on Continue (or auto). Runs the real chunk+embed; on a
  // thin take, increments the retry counter and re-reads (up to the cap, then
  // offers the escape).
  const advancePassage = useCallback(
    async (step: 'passage-1' | 'passage-2' | 'passage-3') => {
      if (advancingRef.current) return
      advancingRef.current = true
      // Surface the pending state so Continue disables + shows the spinner. Bulk
      // audio is already embedded, so this normally clears in well under a second.
      setAdvancing(true)
      const idx = passageIndex(step)

      const outcome = await finalizePassage()
      if (!mountedRef.current) return
      if (!outcome.ok) {
        const nextRetry = retryCount + 1
        setRetryCount(nextRetry)
        setRetryReason(outcome.reason)
        if (nextRetry >= PASSAGE_MAX_RETRIES) {
          // Cap hit: offer the escape (use-it-anyway only if the aggregate so far
          // could still clear the floors), else a clean bail.
          setEscapeOffered(true)
        }
        // Re-read the same passage: restart accumulation on the same mic (fresh
        // sessionId, offset 0, dropped incremental accumulation, bumped
        // generation). Clear the auto-advance latch AND disarm so the fresh read
        // must accrue its own sub-target reading before it can auto-advance — a
        // still-high count from the failed take can't immediately re-fire.
        resetPassageAccumulation()
        advancingRef.current = false
        setAdvancing(false)
        autoAdvancedRef.current = false
        armedStepRef.current = null
        return
      }

      resultsRef.current.set(idx, outcome.result)
      setRetryCount(0)
      setRetryReason(null)
      setEscapeOffered(false)

      // A consistency re-read of THIS passage returns straight to processing to
      // re-check — it must not advance linearly and overwrite the good passages.
      if (consistencyReReadRef.current === idx) {
        consistencyReReadRef.current = null
        setStep('processing')
      } else if (step === 'passage-3') {
        setStep('processing')
      } else {
        setStep(step === 'passage-1' ? 'passage-2' : 'passage-3')
      }
      advancingRef.current = false
      setAdvancing(false)
    },
    [finalizePassage, retryCount, resetPassageAccumulation],
  )

  // Auto-advance a passage once its voiced-seconds gate is met — progressive
  // enhancement over the always-present Continue button. `advancingRef` guards
  // against a double-fire with a manual click; a re-read resets it on remount.
  useEffect(() => {
    if (!isPassageStep(step)) return
    // Arm only after this step has actively accrued a fresh sub-target reading:
    // the frame the passage mounts still carries the PRIOR passage's voicedSecs
    // (beginPassage's reset to 0 hasn't flushed yet). Arming on a real
    // below-target sample for THIS step means the subsequent threshold crossing
    // is genuine speech, not stale state — so a mount can't consume a retry.
    if (armedStepRef.current !== step) {
      if (voicedSecs < PASSAGE_TARGET_SECONDS) armedStepRef.current = step
      return
    }
    if (voicedSecs < PASSAGE_TARGET_SECONDS) return
    if (advancingRef.current || autoAdvancedRef.current) return
    autoAdvancedRef.current = true
    void advancePassage(step)
  }, [step, voicedSecs, advancePassage])

  // ── Processing: consistency check + POST ────────────────────
  const submit = useCallback(async () => {
    // Key everything by passage index (the Map key) end-to-end. `entries` order
    // is the values order the consistency check sees, so its positional
    // outlierIndex maps back to a real passage KEY via entries[outlierIndex][0].
    // (After a re-read, Map insertion order no longer equals passage index, so
    // indexing by the positional value would delete the WRONG passage.)
    const entries = [...resultsRef.current.entries()]
    const prototypes = entries.map(([, r]) => r.prototype)
    const consistency = checkConsistency(prototypes)

    // Store EVERY quality-accepted chunk (incremental + tail) with its 1:1
    // embedding — no per-passage downsample. One-shot self-enrollment is a
    // single voice reading a fixed script, so more chunks is strictly more
    // signal; the CRM contact cap (sampleEmbeddingsForEnrollment) exists to stop
    // one meeting dominating a MULTI-meeting profile, which has no analogue here.
    // Accuracy over payload thrift.
    const allChunks: VoiceProfileChunk[] = []
    for (const [, r] of entries) {
      // Embeddings and chunks are index-aligned 1:1 (the embedder pairs each
      // chunk with its embedding), so quality flows straight through.
      for (let i = 0; i < r.embeddings.length; i++) {
        allChunks.push({
          embedding: r.embeddings[i],
          quality: r.chunks[i]?.quality ?? 0.5,
          sessionId: r.sessionId,
        })
      }
    }
    // Defensive clamp ONLY for a pathological over-long take: if the total
    // somehow exceeds the shared route max, evenly subsample down to it (never
    // 400). A normal read is well under the cap and passes through untouched.
    const postChunks = evenlySubsample(allChunks, MAX_ENROLLMENT_CHUNKS)

    if (!consistency.ok) {
      const outlierIdx = consistency.outlierIndex // positional into `entries`
      const passageKey = outlierIdx !== null ? entries[outlierIdx]?.[0] : undefined
      const bounces = passageKey !== undefined ? (consistencyRetriesRef.current.get(passageKey) ?? 0) : 0

      // Bounce the identifiable outlier back for a re-read only while it has
      // retry budget AND the aggregate could still clear the floor. Each bounce
      // counts toward PASSAGE_MAX_RETRIES so a passage that never matches can't
      // loop forever.
      if (
        passageKey !== undefined &&
        bounces < PASSAGE_MAX_RETRIES &&
        postChunks.length >= ENROLLMENT_MIN_CHUNKS
      ) {
        consistencyRetriesRef.current.set(passageKey, bounces + 1)
        resultsRef.current.delete(passageKey)
        // Mark this a consistency re-read so completing it returns to processing
        // (re-check), not the linear next passage.
        consistencyReReadRef.current = passageKey
        const passageStep = `passage-${passageKey + 1}` as 'passage-1' | 'passage-2' | 'passage-3'
        // Carry the reason across the transition so the passage-mount effect
        // doesn't wipe it before paint.
        pendingReasonRef.current = 'One passage didn’t match the others — let’s read that one again.'
        setStep(passageStep)
        return
      }

      // No recoverable path: no identifiable outlier (e.g. exactly 2 passages),
      // or the outlier exhausted its retries, or too little audio to bounce.
      // NEVER POST a known-inconsistent (possibly two-voice) profile — this is
      // the exact failure the guard exists to prevent.
      setConsistencyFailed(true)
      return
    }

    if (postChunks.length < ENROLLMENT_MIN_CHUNKS) {
      // Not enough usable audio overall — send the user back to passage 1.
      pendingReasonRef.current = 'We need a little more of your voice — let’s try the story again.'
      resultsRef.current.clear()
      consistencyRetriesRef.current.clear()
      consistencyReReadRef.current = null
      setStep('passage-1')
      return
    }

    setPostError(false)
    try {
      const res = await fetch('/api/account/voice-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunks: postChunks, source: 'settings_training' }),
      })
      if (!res.ok) {
        setPostError(true)
        return
      }
    } catch {
      setPostError(true)
      return
    }

    refresh()
    setStep('done')
  }, [refresh])

  // Run submit once when we reach the processing step.
  useEffect(() => {
    if (step !== 'processing') return
    void submit()
  }, [step, submit])

  // Fire confetti when we land on done (static success is the guaranteed
  // payoff; celebrate() no-ops under reduced motion).
  useEffect(() => {
    if (step === 'done') celebrate({ intensity: 'big' })
  }, [step])

  // ── Escape / close ──────────────────────────────────────────

  const bail = useCallback(() => {
    recorder.stop()
    embedderRef.current?.terminate()
    router.push('/account/settings/voice')
  }, [recorder, router])

  // "Start over" from a consistency failure: drop every accumulated result and
  // restart the story at passage 1. Nothing was ever stored, so this is clean.
  const startOver = useCallback(() => {
    resultsRef.current.clear()
    consistencyRetriesRef.current.clear()
    consistencyReReadRef.current = null
    setConsistencyFailed(false)
    setRetryCount(0)
    pendingReasonRef.current = null
    setStep('passage-1')
  }, [])

  const finish = useCallback(() => {
    recorder.stop()
    if (window.history.length > 1) router.back()
    else router.push('/account')
  }, [recorder, router])

  // "Use it anyway": accept whatever aggregate we have if it clears the floor.
  const useAnyway = useCallback(() => {
    const total = [...resultsRef.current.values()].reduce(
      (sum, r) => sum + r.chunks.length,
      0,
    )
    if (total >= ENROLLMENT_MIN_CHUNKS) {
      setStep('processing')
    } else {
      // Not enough to trust — the only honest option is to bail cleanly.
      bail()
    }
  }, [bail])

  const aggregateChunks = [...resultsRef.current.values()].reduce(
    (sum, r) => sum + r.chunks.length,
    0,
  )

  // ── Render ──────────────────────────────────────────────────

  const stepAnnouncement = useMemo(() => announce(step, voicedSecs), [step, voicedSecs])

  return (
    <div className="relative flex min-h-dvh flex-col bg-background text-foreground">
      <CelebrationOverlay />

      {/* Draggable title bar region for desktop + a quiet header close. */}
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end px-3">
        {step !== 'done' && (
          <button
            onClick={() => setConfirmClose(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close voice training"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Screen-reader step + recording announcements. */}
      <div className="sr-only" role="status" aria-live="polite">
        {stepAnnouncement}
      </div>

      <div className="flex flex-1 items-center justify-center px-6 pb-12">
        <div className="w-full max-w-lg" ref={headingRef}>
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25 }}
            >
              {step === 'intro' && (
                <IntroStep
                  modelReady={modelReady}
                  loadError={loadError}
                  onStart={goMicCheck}
                  onRetryLoad={loadModel}
                />
              )}

              {step === 'mic-check' && (
                <MicCheckStep
                  level={recorder.level}
                  recording={recorder.recording}
                  speechDetected={recorder.speechDetected}
                  error={recorder.error}
                  onRetry={async () => {
                    recorder.clearError()
                    await startMic()
                  }}
                />
              )}

              {isPassageStep(step) && (
                <>
                  <PassageCard
                    passage={ENROLLMENT_STORY[passageIndex(step)]}
                    index={passageIndex(step)}
                    total={ENROLLMENT_STORY.length}
                    recording={recorder.recording}
                    level={recorder.level}
                    elapsedSeconds={voicedSecs}
                    targetSeconds={PASSAGE_TARGET_SECONDS}
                    canContinue={voicedSecs >= PASSAGE_TARGET_SECONDS}
                    advancing={advancing}
                    retryReason={retryReason}
                    onContinue={() => void advancePassage(step)}
                  />
                  {escapeOffered && (
                    <div className="mx-auto mt-6 flex max-w-sm flex-col items-center gap-2 text-center">
                      <p className="text-xs text-muted-foreground">
                        Having trouble? You can use what we have, or come back later.
                      </p>
                      <div className="flex gap-2">
                        {aggregateChunks >= ENROLLMENT_MIN_CHUNKS && (
                          <Button variant="outline" size="sm" onClick={useAnyway}>
                            Use it anyway
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={bail}>
                          Try again later
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {step === 'processing' && (
                <>
                  {/* Consistency failure with no recoverable path: never POST a
                      known-inconsistent (possibly two-voice) profile. Offer a
                      clean restart or a bail — nothing was stored. */}
                  {consistencyFailed ? (
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 text-center">
                      <p className="font-heading text-xl text-foreground">
                        The passages didn’t match up
                      </p>
                      <p className="text-sm text-muted-foreground" role="alert">
                        It sounded like more than one voice — maybe background noise
                        or someone nearby. Nothing was saved. Let’s try the story
                        again from the top.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={startOver}>
                          Start over
                        </Button>
                        <Button variant="ghost" size="sm" onClick={bail}>
                          Try again later
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <ProcessingStep />
                      {postError && (
                        <div className="mx-auto mt-6 flex max-w-sm flex-col items-center gap-3 text-center">
                          <p className="text-sm text-muted-foreground" role="alert">
                            We couldn’t save your voiceprint just now. Give it another try.
                          </p>
                          <Button size="sm" onClick={() => void submit()}>
                            Try again
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {step === 'done' && <DoneStep onFinish={finish} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Leave voice training?"
        description="Nothing’s been saved yet. You can start over anytime from Settings."
        confirmLabel="Leave"
        onConfirm={bail}
      />
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────

/**
 * Evenly-spaced defensive subsample: returns `items` untouched when it already
 * fits within `max`, else picks `max` items spread across the array (first and
 * last always included). Purely a safety valve so a pathological over-long take
 * can never 400 on volume — a normal enrollment is well under the cap and passes
 * through unchanged. Same spacing math as sampleEmbeddingsForEnrollment, but
 * generic over the chunk shape (which carries per-chunk quality + sessionId).
 */
function evenlySubsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const result: T[] = []
  const step = (items.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) result.push(items[Math.round(i * step)])
  return result
}

/** aria-live copy for the current step + recording state. */
function announce(step: Step, voicedSecs: number): string {
  switch (step) {
    case 'intro':
      return 'Voice training. Read a short story out loud to teach Dial8 your voice.'
    case 'mic-check':
      return 'Checking your microphone. Say a few words.'
    case 'passage-1':
      return `Recording passage 1 of 3. ${Math.floor(voicedSecs)} seconds captured.`
    case 'passage-2':
      return `Recording passage 2 of 3. ${Math.floor(voicedSecs)} seconds captured.`
    case 'passage-3':
      return `Recording passage 3 of 3. ${Math.floor(voicedSecs)} seconds captured.`
    case 'processing':
      return 'Passage complete. Learning your voice.'
    case 'done':
      return 'Done. Dial8 knows your voice now.'
  }
}
