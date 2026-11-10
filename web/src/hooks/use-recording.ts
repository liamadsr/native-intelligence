'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { desktopOS, isDesktopApp } from '@/lib/platform'
import {
  tauriBridge,
  type AudioLevelPayload,
  type RecordingResult,
  type SystemAudioStatus,
} from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'
import {
  DeepgramStreamingService,
  TranscriptMerger,
  type TranscriptSegment,
  type TranscriptionService,
  type TranscriptionStatus,
} from '@/lib/deepgram-stream'
import {
  localFallbackMessage,
  prepareLocalTranscription,
  shiftSegmentTime,
  trackLocalFallback,
  type LocalFallbackPhase,
  type LocalTranscriptionService,
} from '@/lib/local-transcription'
import { trackRecordingEvent } from '@/lib/recording-telemetry'
import {
  VoiceIdService,
  type SpeakerIdentification,
  type AutoAcceptDelay,
  type TrustTier,
} from '@/lib/voice-id-service'
import { TranscriptGate } from '@/lib/live-agent/transcript-gate'
import { WebAudioCapture, WebAudioCaptureError } from '@/lib/web-audio-capture'
import { toast } from 'sonner'
import { MAX_SELF_TOPUP_EMBEDDINGS } from '@/lib/voice-profile/types'
import { primeVocabulary } from '@/lib/vocabulary/client'
import { APP_IN_SYSTEM_SETTINGS } from '@/lib/desktop-app-name'

// ── Speaker display helpers (shared across UIs) ─────────────────

/**
 * Get display name — user-assigned name or default label.
 *
 * `demotedSelfLabels` (optional) is the set of speaker labels that live
 * self-verification has demoted from the default "You" special-case: when a
 * label is in it, local_1 no longer renders as "You" (sustained self-mismatch,
 * or another label voice-verified as self). Omitting it — every call site for an
 * un-enrolled user — keeps today's exact behavior.
 */
export function getSpeakerDisplayName(
  speaker: string,
  speakerNames: Record<string, string>,
  demotedSelfLabels?: ReadonlySet<string>,
): string {
  if (speakerNames[speaker]) return speakerNames[speaker]
  if (speaker === 'local_1' && !demotedSelfLabels?.has(speaker)) return 'You'
  if (speaker.startsWith('local_')) {
    const num = speaker.replace('local_', '')
    return `Local ${num}`
  }
  if (speaker.startsWith('remote_')) {
    const num = speaker.replace('remote_', '')
    return `Remote ${num}`
  }
  return speaker
}

export function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Render the meeting transcript (final segments) as a flat, speaker-attributed
 * string for PRIMING a freshly (re)spawned local live-agent session — so the new
 * repo-bound process knows what was already said. Capped to a generous tail so a
 * very long meeting can't blow the priming message up unboundedly (the recent
 * material matters most; the early part is background). Final-only: interims are
 * noisy and may still change.
 */
const PRIMING_TRANSCRIPT_MAX_CHARS = 24_000
function formatTranscriptForPriming(
  segments: TranscriptSegment[],
  speakerNames: Record<string, string>,
  demotedSelfLabels?: ReadonlySet<string>,
): string {
  const lines = segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => `${getSpeakerDisplayName(s.speaker, speakerNames, demotedSelfLabels)}: ${s.text.trim()}`)
  const joined = lines.join('\n')
  // Keep the tail (most recent) if it's over the cap.
  return joined.length > PRIMING_TRANSCRIPT_MAX_CHARS
    ? joined.slice(joined.length - PRIMING_TRANSCRIPT_MAX_CHARS)
    : joined
}

// ── Hook ─────────────────────────────────────────────────────────

export type LiveAgentStatus = 'idle' | 'listening' | 'waiting' | 'processing' | 'finalizing' | 'deferred'

/** An activity event from the live agent (tool calls, proposals, etc.) */
export interface AgentActivityEvent {
  id: string
  /** Tool name (e.g. "search_projects", "propose_change") */
  toolName: string
  /** Tool input arguments */
  args: Record<string, unknown>
  /** State: 'result' = completed successfully; 'error' = the turn ran but its
   *  result couldn't be committed (surfaced so a silent drop is visible). */
  state: 'result' | 'error'
  timestamp: number
}

export interface UseRecordingOptions {
  /** Whether to capture system audio */
  captureSystemAudio?: boolean
  /** Voice ID auto-accept delay in seconds */
  autoAcceptDelay?: AutoAcceptDelay
  /** Enable live agent mode — AI processes transcripts in real-time */
  liveAgentEnabled?: boolean
  /** Selected live agent recipe ID (null = workspace default) */
  agentId?: string | null
  /** Capture ID for live agent to write proposed changes to */
  captureId?: string | null
  /** Callback for live agent status changes */
  onLiveAgentStatusChange?: (status: LiveAgentStatus) => void
  /** Corrections log — user overrides of agent suggestions, passed to agent on each call */
  correctionsLog?: Array<{ field: string; agentProposed: string; userCorrected: string }>
}

/** Max number of recent transcript chunks to keep in the sliding window */
const RECENT_CHUNKS_MAX = 3

// ── Mic recovery coordinator (desktop only) ──────────────────────────────────
// TWO initiators can ask for a recover_mic rebuild of the native mic stream:
//
//   1. The native fault watchdog: Rust emits `audio://mic-fault` when cpal's
//      error callback trips (device disconnect). On a persistently dead device
//      it re-flags every few seconds after each "successful-but-still-dead"
//      rebuild.
//   2. The first-frame watchdog (armed in startRecording): on resume-after-quit,
//      the Rust side opens the mic stream "successfully" but macOS may not have
//      released the physical device from the just-killed process yet. CoreAudio
//      then never fires the IO proc for our new stream, so ZERO mic PCM ever
//      arrives — from t=0 — even though system audio flows fine. Nothing
//      downstream catches this: the Deepgram socket connects (so
//      transcription_connected fires at the socket level) and the zombie-socket
//      watchdog explicitly exempts a never-fed stream (its staleness gate
//      short-circuits when lastAudioSentAt === 0). The watchdog covers BOTH
//      fresh starts and resumes because they share startRecording — resume-
//      after-quit is exactly the case we're defending.
//
// Uncoordinated, the two initiators fight: each rebuild drops + reopens the
// stream, the native path had no budget at all (unbounded recoverMic every ~3s
// on a dead device), and each would fire its own give-up toast/telemetry. So
// both route through ONE coordinator (requestMicRecovery in the hook) with a
// shared per-"dead episode" budget, minimum spacing between rebuilds, and a
// single give-up. An episode ends when mic audio actually arrives after a
// rebuild — a later genuine fault (device unplugged an hour in) then starts a
// fresh episode with a fresh budget.
/** Grace period for the first mic frame before we treat the stream as starved. */
const MIC_FIRST_FRAME_TIMEOUT_MS = 8_000
/** Max recover_mic rebuilds per dead episode, SHARED across both initiators. */
export const MIC_RECOVER_MAX_ATTEMPTS = 3
/** Minimum spacing between rebuilds — a rebuild needs a few seconds to take
 *  effect, and back-to-back rebuilds (e.g. a native fault landing right after a
 *  first-frame rebuild) just drop the stream again before it can settle. */
export const MIC_RECOVER_MIN_SPACING_MS = 6_000

/** Why a mic recovery is being requested (kept distinct in telemetry). */
export type MicRecoveryReason = 'native_fault' | 'no_first_frame'

/** What the coordinator decided to do with a recovery request. */
export type MicRecoveryAction =
  | 'recover' // rebuild now (budget available, spacing satisfied)
  | 'throttled' // inside the spacing window — ignore, let the last rebuild settle
  | 'give-up' // budget exhausted, mic still dead → toast + telemetry, once per episode
  | 'suppressed' // already gave up this episode → telemetry-log only
  | 'inactive' // recording is over / superseded → do nothing

/**
 * Pure decision core of the mic-recovery coordinator. Extracted so the
 * episode/budget/spacing logic is unit-testable without a recording harness
 * (the hook itself has none — established).
 *
 * Episode semantics: `lastAudioAt > lastRecoveryAt` means the last rebuild
 * actually brought mic audio back, so the dead episode it belonged to is OVER —
 * this request is a NEW episode and gets a fresh budget (`resetEpisode: true`;
 * the caller must zero attempts/gaveUp before applying the action). Spacing is
 * judged on the raw lastRecoveryAt even across a reset: rapid flapping must not
 * hammer recover_mic just because audio blipped in between.
 */
export function decideMicRecovery(params: {
  now: number
  /** False once recording stopped / the service was superseded. */
  stillCurrent: boolean
  /** Last time mic PCM was forwarded (0 = never). */
  lastAudioAt: number
  /** Last time this coordinator fired recover_mic (0 = never this session). */
  lastRecoveryAt: number
  /** Recoveries already attempted this episode. */
  attempts: number
  /** Whether this episode already fired its give-up toast/telemetry. */
  gaveUp: boolean
}): { action: MicRecoveryAction; resetEpisode: boolean } {
  const { now, stillCurrent, lastAudioAt, lastRecoveryAt, attempts, gaveUp } = params
  if (!stillCurrent) return { action: 'inactive', resetEpisode: false }

  // Audio arrived after the last rebuild → that episode resolved; fresh budget.
  const resetEpisode = lastRecoveryAt > 0 && lastAudioAt > lastRecoveryAt
  const effectiveAttempts = resetEpisode ? 0 : attempts
  const effectiveGaveUp = resetEpisode ? false : gaveUp

  if (effectiveGaveUp) return { action: 'suppressed', resetEpisode }
  if (effectiveAttempts >= MIC_RECOVER_MAX_ATTEMPTS) return { action: 'give-up', resetEpisode }
  if (lastRecoveryAt > 0 && now - lastRecoveryAt < MIC_RECOVER_MIN_SPACING_MS) {
    return { action: 'throttled', resetEpisode }
  }
  return { action: 'recover', resetEpisode }
}

// ── Transcription setup retry schedule ───────────────────────────────────────
// If service.start() throws (both Deepgram legs failed to connect), the ENTIRE
// setup is retried — the token is re-fetched (they expire after 60s, so the old
// one is never reused) and a fresh service is built — on this backoff. The
// incident that motivated this (386s, zero transcripts) was a transient ~20s
// network slowness at connect time; a short bounded retry rides over it instead
// of abandoning transcription for the whole meeting. Exported for unit testing.
export const SETUP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const
/** Backoff before setup attempt N (0-based prior-failure count), or null once the
 *  bounded retries are exhausted. attempt 0 has already run when this is first
 *  consulted, so index 0 is the delay before the FIRST retry. */
export function nextSetupRetryDelayMs(priorFailures: number): number | null {
  return priorFailures >= 1 && priorFailures <= SETUP_RETRY_DELAYS_MS.length
    ? SETUP_RETRY_DELAYS_MS[priorFailures - 1]
    : null
}

/** Injectable side effects for runTranscriptionSetupWithRetry, so the whole
 *  loop is unit-testable without the Tauri/Deepgram/Supabase stack (mirrors how
 *  decideMicRecovery was extracted from the hook). `T` is the built service. */
export interface SetupRetryDeps<T> {
  /** Mint a FRESH transcription token (never reuse the old one — 60s TTL). */
  fetchToken: () => Promise<string>
  /** Build + start a fresh service with the given token. Throws when the
   *  underlying connect fails (e.g. both Deepgram legs failed). */
  buildAndStart: (token: string) => Promise<T>
  /** Dispose a service we built but must abandon (raced stop / failed start). */
  dispose: (service: T) => void
  /** True while THIS setup's session is still the current one. Consulted after
   *  every await so a stop / new start cancels pending retries. */
  isCurrent: () => boolean
  /** Resolvable delay (defaults to setTimeout). Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
  /** Fired per failed attempt (1-based) with a reason, and once more with
   *  reason 'exhausted' when the retries run out. */
  onAttemptFailed: (attempt: number, reason: string) => void
  /** Fired once when the bounded retries are exhausted — surface to the user. */
  onExhausted: () => void
}

/** Outcome of the bounded setup-retry loop. */
export type SetupRetryResult<T> =
  | { status: 'started'; service: T }
  | { status: 'exhausted' }
  | { status: 'cancelled' } // a stop / new start superseded this setup

/**
 * Run the transcription setup with bounded retries + backoff (Part B).
 *
 * `buildAndStart` throws only when the connect genuinely failed (in the desktop
 * path, both Deepgram legs failed — a single-leg success resolves). On a throw
 * we dispose the half-built service (closing any leaked/in-flight sockets),
 * back off on SETUP_RETRY_DELAYS_MS, mint a FRESH token, and rebuild. Every
 * await is guarded by isCurrent() so a stop / new start cancels cleanly and the
 * caller disposes nothing further. When retries exhaust, onExhausted() fires so
 * the user is told no transcript is being captured.
 */
export async function runTranscriptionSetupWithRetry<T>(
  firstToken: string,
  deps: SetupRetryDeps<T>,
): Promise<SetupRetryResult<T>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let token = firstToken
  let priorFailures = 0

  while (true) {
    let service: T
    try {
      service = await deps.buildAndStart(token)
    } catch (err) {
      // A stop / new start raced this attempt — abandon quietly.
      if (!deps.isCurrent()) return { status: 'cancelled' }
      priorFailures += 1
      deps.onAttemptFailed(priorFailures, err instanceof Error ? err.message : String(err))

      const delay = nextSetupRetryDelayMs(priorFailures)
      if (delay === null) {
        deps.onAttemptFailed(priorFailures, 'exhausted')
        deps.onExhausted()
        return { status: 'exhausted' }
      }
      await sleep(delay)
      if (!deps.isCurrent()) return { status: 'cancelled' }
      // Fresh token per retry (the old one has certainly expired).
      try {
        token = await deps.fetchToken()
      } catch {
        if (!deps.isCurrent()) return { status: 'cancelled' }
        // Token re-fetch failed — treat it as this cycle's failure by looping;
        // the next buildAndStart would fail on a bad/empty token anyway.
        continue
      }
      if (!deps.isCurrent()) return { status: 'cancelled' }
      continue
    }
    // Started (at least one leg). A stop may have raced the successful start —
    // dispose rather than publish a service into a stopped session's refs.
    if (!deps.isCurrent()) {
      deps.dispose(service)
      return { status: 'cancelled' }
    }
    return { status: 'started', service }
  }
}

// ── Derived transcript signals ───────────────────────────────────────────────

/**
 * Derive the two LOW-frequency transcript signals — final-segment count and the
 * sorted unique speaker list — from a freshly published segment array, with
 * change flags computed against the previously published values.
 *
 * Identity rule (the getSnapshot-caching contract): when the speaker set is
 * unchanged, `speakers` returns `prevSpeakers` — the SAME reference — so the
 * ref-backed store's snapshot stays stable across the ~150ms interim flushes
 * and useSyncExternalStore subscribers aren't woken (a fresh array each publish
 * would re-render every leaf per flush and defeat the store).
 *
 * Pure + exported for unit tests (mirrors the decideMicRecovery extraction —
 * the hook itself has no isolated test harness).
 */
export function deriveTranscriptSignals(
  segments: TranscriptSegment[],
  prevFinalCount: number,
  prevSpeakers: string[],
): {
  finalCount: number
  finalCountChanged: boolean
  speakers: string[]
  speakersChanged: boolean
} {
  const finals = segments.filter((s) => s.isFinal)
  // Sorted unique speakers over finals: local_* first, then numeric-aware
  // lexicographic — the exact ordering the speaker pills render in.
  const sorted = Array.from(new Set(finals.map((s) => s.speaker))).sort((a, b) => {
    const aLocal = a.startsWith('local')
    const bLocal = b.startsWith('local')
    if (aLocal !== bLocal) return aLocal ? -1 : 1
    return a.localeCompare(b, undefined, { numeric: true })
  })
  const speakersChanged =
    sorted.length !== prevSpeakers.length || sorted.some((s, i) => s !== prevSpeakers[i])
  return {
    finalCount: finals.length,
    finalCountChanged: finals.length !== prevFinalCount,
    speakers: speakersChanged ? sorted : prevSpeakers,
    speakersChanged,
  }
}

// ── Session-accumulator release ──────────────────────────────────────────────

/**
 * Decide what the live segment store should hold after a session's accumulators
 * are released (incident hotfix H3). Pure + exported for unit tests — the hook
 * itself has no isolated harness, so its ref bookkeeping is extracted here the
 * same way decideMicRecovery / deriveTranscriptSignals are.
 *
 * `dropSegments` (the DISCARD path) empties the array: the capture row is
 * deleted, so no post-stop reader survives.
 *
 * Otherwise (the STOP path) the text-bearing segments are KEPT and only the
 * per-word payloads are stripped. This is the post-stop transcript-pane
 * contract: `useDisplayTranscriptSegments` falls back to the capture row's
 * persisted transcript the instant `liveSegments` is empty, and that row may not
 * have caught up with the final force-save yet — so emptying the array here
 * would blank the pane. See clearSessionAccumulators' doc for the full rationale
 * and for why the memory win survives (the words arrays + the merger's parallel
 * copy are the multi-MB retainers; the `[speaker] text` the pane paints is not).
 *
 * Segments that already carry no words are returned BY REFERENCE, so a repeat
 * release (or a session that never captured word timings) allocates nothing.
 */
export function releaseSessionSegments(
  segments: TranscriptSegment[],
  dropSegments = false,
): TranscriptSegment[] {
  if (dropSegments) return []
  return segments.map((s) => (s.words.length > 0 ? { ...s, words: [] } : s))
}

/** A recording that asked for on-device transcription is using Deepgram
 *  instead: analytics + a visible notice (the user opted into local). */
function reportLocalTranscriptionFallback(
  reason: string,
  phase: LocalFallbackPhase,
  captureId: string | null,
): void {
  trackLocalFallback(reason, phase, { capture_id: captureId })
  toast.info(localFallbackMessage(phase))
}

/** POST /self-confirm for the user's own voice (followups issue 11). */
async function postSelfConfirm(
  captureId: string,
  body: { speaker_label: string; decision: 'mine' | 'not_mine'; embeddings?: number[][] },
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const { createClient } = await import('@/lib/supabase/client')
    const { data } = await createClient().auth.getSession()
    const token = data.session?.access_token
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch { /* cookies fallback for web */ }
  return fetch(`/api/account/captures/${captureId}/self-confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** Voice ID came up after a "This is me": that voice is the confirmed one now. */
function confirmPendingSelfLabel(
  voiceId: VoiceIdService,
  pending: { captureId: string; label: string } | null,
  captureId: string | null,
): void {
  if (pending && pending.captureId === captureId) voiceId.confirmSelfLabel(pending.label)
}

/**
 * At stop, the POST that teaches the profile from a voice confirmed while it
 * was short of samples: 'mine' again (binding is idempotent) with the samples
 * since the confirm, up to MAX_SELF_TOPUP_EMBEDDINGS in all (issue 24).
 */
export function selfLearnAtStop(
  voiceId: Pick<VoiceIdService, 'takeSelfLearnEmbeddings'> | null,
  pending: { captureId: string; label: string; posted: number } | null,
): { captureId: string; body: { speaker_label: string; decision: 'mine'; embeddings: number[][] } } | null {
  if (!voiceId || !pending) return null
  const learn = voiceId.takeSelfLearnEmbeddings(MAX_SELF_TOPUP_EMBEDDINGS - pending.posted)
  if (!learn || learn.label !== pending.label || learn.embeddings.length === 0) return null
  return { captureId: pending.captureId, body: { speaker_label: learn.label, decision: 'mine', embeddings: learn.embeddings } }
}

function getStoredAutoAcceptDelay(): AutoAcceptDelay {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('voiceId.autoAcceptDelay')
    if (stored === '5' || stored === '10' || stored === '15' || stored === '0') return Number(stored) as AutoAcceptDelay
  }
  return 10
}

export function useRecording(options: UseRecordingOptions = {}) {
  const {
    captureSystemAudio = true,
    autoAcceptDelay = getStoredAutoAcceptDelay(),
    liveAgentEnabled = false,
    agentId = null,
    captureId = null,
    onLiveAgentStatusChange,
    correctionsLog = [],
  } = options

  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const isPausedRef = useRef(false)

  // ── Audio levels + elapsed as REF-BACKED EXTERNAL STORES ────────────────
  // These two update at audio-frame rate (levels ~10×/s from the native tap /
  // web worklet; elapsed 1×/s from the timer). Holding them in React state made
  // the hook — and every RecordingContext consumer — re-render that often for
  // the whole meeting, which is the core cause of the long-session sluggishness.
  // Instead we keep them in refs with a listener set + stable accessors, so only
  // the leaf that actually paints (the waveform / the timer readout), subscribed
  // via useSyncExternalStore, re-renders on each frame. `publishLevels` /
  // `publishElapsed` write the ref and notify; every old `setLevels`/`setElapsed`
  // call site now routes through them (reset-to-zero semantics preserved).
  const levelsRef = useRef<AudioLevelPayload>({ micLevel: 0, systemLevel: 0, timestamp: 0 })
  const levelsListenersRef = useRef<Set<() => void>>(new Set())
  const getLevels = useCallback(() => levelsRef.current, [])
  const subscribeLevels = useCallback((cb: () => void) => {
    levelsListenersRef.current.add(cb)
    return () => { levelsListenersRef.current.delete(cb) }
  }, [])
  const publishLevels = useCallback((payload: AudioLevelPayload) => {
    levelsRef.current = payload
    levelsListenersRef.current.forEach((cb) => cb())
  }, [])

  const elapsedRef = useRef(0)
  const elapsedListenersRef = useRef<Set<() => void>>(new Set())
  const getElapsed = useCallback(() => elapsedRef.current, [])
  const subscribeElapsed = useCallback((cb: () => void) => {
    elapsedListenersRef.current.add(cb)
    return () => { elapsedListenersRef.current.delete(cb) }
  }, [])
  const publishElapsed = useCallback((value: number) => {
    elapsedRef.current = value
    elapsedListenersRef.current.forEach((cb) => cb())
  }, [])

  // ── Transcript segments as a REF-BACKED EXTERNAL STORE ──────────────────
  // The live transcript array grows all meeting and is re-published ~6-7×/s
  // (every ~150ms interim-coalesce flush + each final). Holding it in React
  // state re-rendered the hook — and every RecordingContext consumer, notably
  // the ~3.3k-line capture detail panel — that often, the dominant remaining
  // typing-lag source on a long call. So the ARRAY lives in a ref + listener set
  // (mirrors levels/elapsed above): only the leaf that paints the live transcript
  // re-renders per tick, via useTranscriptSegments() + useSyncExternalStore.
  //
  // The two DERIVED values — finalSegmentCount and detectedSpeakers — are ALSO
  // ref-backed external stores now (audit finding 7): as bare context state they
  // re-rendered every volatile-context consumer (the ~3.4k-line capture detail
  // panel, ×2 mounted copies during a recording) once per finalized utterance
  // for the whole meeting. The stores notify only when the value ACTUALLY
  // changes — interim flushes (the ~150ms hot path) add no finals or speakers,
  // so they wake nobody. Leaf consumers read them via useFinalSegmentCount() /
  // useDetectedSpeakers() (recording-context.tsx).
  //
  // There are deliberately NO useState mirrors of these signals: a mirror would
  // re-render this hook (and so the provider) once per finalized utterance for
  // the whole meeting — the exact per-utterance render load the stores exist to
  // remove. Every consumer reads them through a leaf hook.
  const transcriptSegmentsRef = useRef<TranscriptSegment[]>([])
  const transcriptSegmentsListenersRef = useRef<Set<() => void>>(new Set())
  const getTranscriptSegmentsSnapshot = useCallback(() => transcriptSegmentsRef.current, [])
  const subscribeTranscriptSegments = useCallback((cb: () => void) => {
    transcriptSegmentsListenersRef.current.add(cb)
    return () => { transcriptSegmentsListenersRef.current.delete(cb) }
  }, [])
  const finalSegmentCountRef = useRef(0)
  const finalSegmentCountListenersRef = useRef<Set<() => void>>(new Set())
  const getFinalSegmentCount = useCallback(() => finalSegmentCountRef.current, [])
  const subscribeFinalSegmentCount = useCallback((cb: () => void) => {
    finalSegmentCountListenersRef.current.add(cb)
    return () => { finalSegmentCountListenersRef.current.delete(cb) }
  }, [])
  const detectedSpeakersRef = useRef<string[]>([])
  const detectedSpeakersListenersRef = useRef<Set<() => void>>(new Set())
  const getDetectedSpeakers = useCallback(() => detectedSpeakersRef.current, [])
  const subscribeDetectedSpeakers = useCallback((cb: () => void) => {
    detectedSpeakersListenersRef.current.add(cb)
    return () => { detectedSpeakersListenersRef.current.delete(cb) }
  }, [])
  // Write the ref, notify leaf subscribers, then reconcile the two low-frequency
  // derived signals: their stores notify only when the derived value actually
  // changed. Accepts a value or updater fn, matching the old
  // setTranscriptSegments call sites (one uses the fn form).
  const publishTranscriptSegments = useCallback(
    (next: TranscriptSegment[] | ((prev: TranscriptSegment[]) => TranscriptSegment[])) => {
      const value =
        typeof next === 'function'
          ? (next as (prev: TranscriptSegment[]) => TranscriptSegment[])(transcriptSegmentsRef.current)
          : next
      transcriptSegmentsRef.current = value
      transcriptSegmentsListenersRef.current.forEach((cb) => cb())

      const signals = deriveTranscriptSignals(
        value,
        finalSegmentCountRef.current,
        detectedSpeakersRef.current,
      )
      if (signals.finalCountChanged) {
        finalSegmentCountRef.current = signals.finalCount
        finalSegmentCountListenersRef.current.forEach((cb) => cb())
      }
      if (signals.speakersChanged) {
        detectedSpeakersRef.current = signals.speakers
        detectedSpeakersListenersRef.current.forEach((cb) => cb())
      }
    },
    [],
  )
  const [recordingError, setRecordingError] = useState<string | null>(null)
  // Outcome of the system-audio stream for the current session. `null` until a
  // recording starts. Anything other than 'capturing' or 'disabled' means the
  // user asked to capture other participants' audio but we couldn't — the UI
  // surfaces a warning so they can grant permission / fix it mid-meeting.
  const [systemAudioStatus, setSystemAudioStatus] = useState<SystemAudioStatus | null>(null)
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>('connected')
  const [recordingResult, setRecordingResult] = useState<{
    sessionId: string
    micFile: string | null
    systemFile: string | null
    durationSeconds: number
  } | null>(null)

  // Post-session review for auto-assigned speakers. Their embeddings are
  // HELD here (not yet saved) — enrollment + trust confirmation only happen
  // when the user confirms an entry. Dismissing the review saves nothing.
  const [postSessionReview, setPostSessionReview] = useState<{
    sessionId: string
    autoAssigned: { speakerId: string; contactId: string; contactName: string; confidence: number; trustTier: TrustTier; speakingDurationSec: number; embeddings: number[][] }[]
  } | null>(null)

  // Speaker state
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [speakerContacts, setSpeakerContacts] = useState<Record<string, SpeakerIdentification>>({})
  const [voiceIdReady, setVoiceIdReady] = useState(false)
  // Speaker labels demoted from the default "You" special-case by live
  // self-verification (sustained self-mismatch on local_1, or another label
  // voice-verified as self). Empty for every un-enrolled user → today's behavior.
  const [selfDemotedLabels, setSelfDemotedLabels] = useState<ReadonlySet<string>>(() => new Set())
  // "Is this you?" — a voice close to the user's own but not verified
  // (followups issue 11). One at a time; cleared by a confirm or a dismiss.
  const [selfSuggestion, setSelfSuggestion] = useState<{ speakerId: string; similarity: number } | null>(null)
  // Ref mirror so the live-agent callback can format a speaker-attributed
  // transcript for priming without a stale closure over speakerNames.
  const speakerNamesRef = useRef(speakerNames)
  speakerNamesRef.current = speakerNames
  // Ref mirror of the demoted set for the same priming path.
  const selfDemotedLabelsRef = useRef(selfDemotedLabels)
  selfDemotedLabelsRef.current = selfDemotedLabels

  // Live agent activity feed — ref-backed external store (audit finding 7). The
  // feed appends on every live-agent tool call; as a bare context field each
  // append re-rendered every volatile-context consumer. publishAgentActivity is
  // the SINGLE write path (emitActivity, the start-of-meeting reset, and the
  // stop-time accumulator clear all route through it): it writes the ref and
  // notifies useAgentActivity() leaf subscribers.
  //
  // As with the three signals above, there is deliberately NO useState mirror:
  // a mirror would re-render this hook (and so the provider) once per live-agent
  // tool call for the whole meeting — the exact render load the store exists to
  // remove. Every consumer reads it through the useAgentActivity() leaf hook.
  const agentActivityRef = useRef<AgentActivityEvent[]>([])
  const agentActivityListenersRef = useRef<Set<() => void>>(new Set())
  const getAgentActivity = useCallback(() => agentActivityRef.current, [])
  const subscribeAgentActivity = useCallback((cb: () => void) => {
    agentActivityListenersRef.current.add(cb)
    return () => { agentActivityListenersRef.current.delete(cb) }
  }, [])
  const publishAgentActivity = useCallback(
    (next: AgentActivityEvent[] | ((prev: AgentActivityEvent[]) => AgentActivityEvent[])) => {
      const value =
        typeof next === 'function'
          ? (next as (prev: AgentActivityEvent[]) => AgentActivityEvent[])(agentActivityRef.current)
          : next
      agentActivityRef.current = value
      agentActivityListenersRef.current.forEach((cb) => cb())
    },
    [],
  )
  const activityIdCounter = useRef(0)

  // Track live agent in-flight work so we can wait for it on stop
  const [isAgentFinalizing, setIsAgentFinalizing] = useState(false)
  const liveAgentFinalizingPromiseRef = useRef<Promise<void> | null>(null)
  const liveAgentResolveRef = useRef<(() => void) | null>(null)

  // Internal refs
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The live transcription service: Deepgram (cloud) or, on desktop with the
  // opt-in local-stt module ready, the on-device engine — which a mid-session
  // failure swaps for a Deepgram fallback.
  const transcriptionServiceRef = useRef<DeepgramStreamingService | LocalTranscriptionService | null>(null)
  // Pending mic first-frame watchdog timeout (desktop only). Held so stop() can
  // clear it — a stale timer must never fire recover_mic after the meeting ended.
  const micWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mergerRef = useRef<TranscriptMerger>(new TranscriptMerger())
  const voiceIdRef = useRef<VoiceIdService | null>(null)
  // Once-per-capture latch for the live self-binding POST — holds the capture id
  // whose self-binding has already been requested, so a second grant (or a React
  // re-invoke) never fires a duplicate POST. The server CAS is idempotent anyway,
  // but this avoids the wasted round-trip.
  const selfBindingRequestedForRef = useRef<string | null>(null)
  // A "This is me" that posted fewer than MAX_SELF_TOPUP_EMBEDDINGS samples:
  // the stop posts the voice's later samples so the profile still learns
  // (followups issue 24).
  const pendingSelfLearnRef = useRef<{ captureId: string; label: string; posted: number } | null>(null)
  const autoAcceptTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  // ── Auto-accept countdown ticks as a REF-BACKED EXTERNAL STORE ──────────
  // A 'recognizing'-tier suggestion counts down to auto-accept on a 1s
  // interval. Writing each tick into `speakerContacts` state re-rendered this
  // hook — and every volatile RecordingContext consumer (the capture detail
  // panel) — once a second, for a number painted in one chip. The ticks land
  // here instead, keyed by the suggestion ENTRY they count down: the object
  // onSpeakerSuggested puts in speakerContacts (the only producer of suggestion
  // entries), remembered per speaker in latestSuggestionRef. The chip reads it
  // via useAutoAcceptCountdown() (recording-context.tsx): the latest tick for
  // the entry it shows, else that entry's own autoAcceptCountdown (the value it
  // started at). speakerContacts still changes for the structural moves — a
  // new suggestion, accept, dismiss, the expiry's auto-accept.
  const latestSuggestionRef = useRef<Map<string, SpeakerIdentification>>(new Map())
  const autoAcceptTicksRef = useRef<WeakMap<SpeakerIdentification, number>>(new WeakMap())
  const autoAcceptTicksListenersRef = useRef<Set<() => void>>(new Set())
  const getAutoAcceptTick = useCallback(
    (suggestion: SpeakerIdentification) => autoAcceptTicksRef.current.get(suggestion),
    [],
  )
  const subscribeAutoAcceptTicks = useCallback((cb: () => void) => {
    autoAcceptTicksListenersRef.current.add(cb)
    return () => { autoAcceptTicksListenersRef.current.delete(cb) }
  }, [])
  const transcriptGateRef = useRef<TranscriptGate | null>(null)
  // The running meeting's out-of-cycle record turn (live-agent messaging L3),
  // installed by startRecording's live-agent closure and nulled at stop. See
  // requestRecordTurn.
  const requestRecordTurnRef = useRef<((captureId: string) => void) | null>(null)
  /** A directive for the note-taker just landed on `captureId`: run a record
   *  turn now, or once the turn in flight settles (coalesced). A no-op unless
   *  this hook is recording that capture with live mode on. */
  const requestRecordTurn = useCallback((captureId: string) => {
    requestRecordTurnRef.current?.(captureId)
  }, [])
  // Browser mic capture (web only). On desktop this stays null — audio comes
  // from Tauri events instead. Holds the active WebAudioCapture so stop() can
  // tear down the mic + audio graph.
  const webCaptureRef = useRef<WebAudioCapture | null>(null)
  // Synthetic session start (web only). The desktop returns a RecordingResult
  // with a sessionId + duration from Rust; on web we mint our own so the rest
  // of the pipeline (voice enrollments, post-session review) has a stable id.
  const webSessionRef = useRef<{ sessionId: string; startedAtMs: number } | null>(null)

  // Stable refs for options used in callbacks
  const captureSystemAudioRef = useRef(captureSystemAudio)
  captureSystemAudioRef.current = captureSystemAudio
  const autoAcceptDelayRef = useRef(autoAcceptDelay)
  autoAcceptDelayRef.current = autoAcceptDelay
  const liveAgentEnabledRef = useRef(liveAgentEnabled)
  liveAgentEnabledRef.current = liveAgentEnabled
  const agentIdRef = useRef(agentId)
  agentIdRef.current = agentId
  const captureIdRef = useRef(captureId)
  captureIdRef.current = captureId
  // Guards the one-shot `transcription_connected` telemetry so reconnects during
  // a single session don't re-fire it. Reset when a new Deepgram service starts.
  const transcriptionConnectedFiredRef = useRef(false)
  const onLiveAgentStatusChangeRef = useRef(onLiveAgentStatusChange)
  onLiveAgentStatusChangeRef.current = onLiveAgentStatusChange
  const correctionsLogRef = useRef(correctionsLog)
  correctionsLogRef.current = correctionsLog

  // Sliding window of recent transcript chunks (capped at RECENT_CHUNKS_MAX)
  const recentChunksRef = useRef<string[]>([])
  // Set true when live mode is toggled ON *mid-meeting* (OFF→ON while recording),
  // so the NEXT cloud turn primes the model with the meeting-so-far. Without this
  // the cloud path only sends the ≤3 chunks captured AFTER the toggle (the gate
  // accumulated nothing while OFF), so the agent had zero context for everything
  // said before and extracted almost nothing until new chunks piled up.
  // One-shot: cleared once sent.
  const cloudPrimeNeededRef = useRef(false)
  /** PAIRED LIVE NOTES. Does this meeting's live agent need a note-taker beside
   *  it? `null` = not known yet (no cloud turn has answered), `true` = the route
   *  said the live agent is ASSIST-ONLY (it talks and writes nothing), so every
   *  window also fires a `live_role: 'notes'` turn that writes the record,
   *  `false` = the live agent takes its own notes. The ROUTE owns the rule (it
   *  has the resolved persona); this just remembers its answer per meeting. */
  const pairNotesRef = useRef<boolean | null>(null)
  /** The note-taker's own one-shot meeting-so-far prime — set alongside
   *  cloudPrimeNeededRef (live toggled ON mid-meeting), consumed by its first
   *  turn. Separate because the two turns consume their primes independently. */
  const notesPrimeNeededRef = useRef(false)

  // Interim-segment coalescing. Deepgram emits interim results ~10×/s per stream;
  // pushing each one straight to React state re-renders the live-capture UI that
  // often during speech. Finals flush immediately (they're the durable content);
  // interim-only updates are coalesced onto a short timer so the in-progress
  // bubble still updates smoothly but the render storm is cut. The live-agent
  // gate is fed EVERY segment regardless (it owns its own debouncing).
  const pendingInterimFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // NO mount-time Voice ID preload. useRecording() runs inside RecordingProvider,
  // which wraps the whole authenticated tree — so a preload here spun up a Web
  // Worker and pulled the ~100MB WavLM model on EVERY desktop dashboard mount,
  // for every session, including the overwhelming majority that never record.
  // Combined with stop()'s old worker pooling that model stayed resident for the
  // life of the WebContent process (a contributor to the 948MB / 7h heap).
  // VoiceIdService.initialize() — called on the recording-start paths below —
  // already calls preloadModel() itself, so the model now loads lazily at the
  // one moment it is actually needed. Transformers.js caches the weights in
  // IndexedDB, so the repeat-recording cost is a worker spin-up + WASM compile,
  // not a re-download.

  // Tracks the previous liveAgentEnabled so we can detect an OFF→ON transition
  // (below) vs. the initial mount. Starts false to match liveAgentEnabled's own
  // default, so enabling live at recording START is not treated as a mid-meeting
  // toggle (the model gets the whole meeting anyway once chunks flow).
  const prevLiveAgentEnabledRef = useRef(false)

  // Sync the transcript gate's enabled flag with live mode so the user can
  // toggle live processing on/off mid-meeting. Disabling stops accumulation
  // (and thus the per-pause API calls); enabling resumes from that point.
  useEffect(() => {
    // ON→OFF mid-meeting: flush the gate BEFORE disabling. setEnabled(false)
    // resets the buffer without flushing, and with the size floor the buffer can
    // now hold up to ~60s of sub-floor transcript (pre-floor it was ≤3s of
    // silence away from flushing) — content the user spoke while live was ON
    // that would silently vanish from live extraction. Mirrors the flush-then-
    // disable convention the stopRecording path already follows.
    if (!liveAgentEnabled && prevLiveAgentEnabledRef.current && isRecording) {
      transcriptGateRef.current?.flush()
    }
    transcriptGateRef.current?.setEnabled(liveAgentEnabled)
    // If live was just toggled ON while a meeting is already in progress, mark the
    // next cloud turn to prime with the meeting-so-far (see cloudPrimeNeededRef).
    // Only on a genuine OFF→ON transition mid-recording — not on the initial
    // enable at start, and not on an ON→OFF.
    if (liveAgentEnabled && !prevLiveAgentEnabledRef.current && isRecording) {
      cloudPrimeNeededRef.current = true
      notesPrimeNeededRef.current = true
    }
    prevLiveAgentEnabledRef.current = liveAgentEnabled
  }, [liveAgentEnabled, isRecording])

  // Listen for audio levels while recording
  useEffect(() => {
    if (!isDesktopApp() || !isRecording) return

    return listenScoped((gate) => tauriBridge.onAudioLevel(gate((level) => {
      if (isPausedRef.current) return
      publishLevels(level)
    })))
    // publishLevels is an identity-stable useCallback (deps []); listed to satisfy
    // exhaustive-deps without changing the effect's real trigger (isRecording).
  }, [isRecording, publishLevels])

  // ── Shared mic-recovery coordinator ──────────────────────────────────────
  // Single funnel for BOTH recovery initiators (the native `audio://mic-fault`
  // watchdog and the first-frame watchdog armed in startRecording). See the
  // module-level comment above decideMicRecovery for why they must share one
  // budget: uncoordinated, a persistently dead device makes the native path
  // fire recover_mic unboundedly (~3s cadence) while the first-frame path runs
  // its own budget, each rebuild dropping the other's, with duplicate toasts.
  //
  // Per-episode state lives in a ref (reset at startRecording). The pure
  // decision (decideMicRecovery) handles budget / spacing / episode-reset; this
  // callback applies it: fires recover_mic, telemetry with the initiator's
  // distinct reason, and the once-per-episode give-up toast.
  const micRecoveryStateRef = useRef({ attempts: 0, lastRecoveryAt: 0, gaveUp: false })
  // Imperative isRecording mirror so the coordinator can no-op the instant a
  // stop begins — recover_mic must never fire after the meeting ended, and the
  // React state flip only propagates on the next render (too late for a fault
  // event racing a stop). Set true in startRecording, false at the top of
  // stopRecording and in the start-failure cleanup.
  const isRecordingRef = useRef(false)

  // Monotonic session token. Bumped when a start begins its background setup and
  // again at the top of stopRecording, so the detached Deepgram/VoiceID setup IIFE
  // can tell whether the session it belongs to is still the current one before it
  // publishes a live service/voiceId into the shared refs. A fast stop-after-start
  // (or a new start) that races the IIFE bumps this, and the IIFE's captured token
  // no longer matches — it then disposes what it built instead of orphaning it in
  // the refs of a stopped/newer session.
  const sessionGenerationRef = useRef(0)

  const requestMicRecovery = useCallback((reason: MicRecoveryReason): MicRecoveryAction => {
    const state = micRecoveryStateRef.current
    const { action, resetEpisode } = decideMicRecovery({
      now: Date.now(),
      stillCurrent: isRecordingRef.current,
      // 0 when the transcription service is absent (e.g. setup failed
      // mid-recording): recovery still runs for the WAV capture, just without
      // the audio-based episode reset — bounded by the budget either way.
      lastAudioAt: transcriptionServiceRef.current?.getLastAudioAt('mic') ?? 0,
      lastRecoveryAt: state.lastRecoveryAt,
      attempts: state.attempts,
      gaveUp: state.gaveUp,
    })
    if (resetEpisode) {
      state.attempts = 0
      state.gaveUp = false
    }
    switch (action) {
      case 'recover': {
        state.attempts += 1
        state.lastRecoveryAt = Date.now()
        trackRecordingEvent('transcription_source_stalled', {
          capture_id: captureIdRef.current ?? null,
          stream: 'mic',
          reason,
          attempt: state.attempts,
        })
        console.warn(
          reason === 'no_first_frame'
            ? '[useRecording] Mic produced no audio ' + MIC_FIRST_FRAME_TIMEOUT_MS +
              'ms after start — rebuilding mic stream (attempt ' +
              state.attempts + '/' + MIC_RECOVER_MAX_ATTEMPTS + ')'
            : '[useRecording] Native mic fault — rebuilding mic stream (attempt ' +
              state.attempts + '/' + MIC_RECOVER_MAX_ATTEMPTS + ')',
        )
        tauriBridge.recoverMic().catch((err) => {
          console.warn('[useRecording] mic recovery failed:', err)
        })
        break
      }
      case 'throttled':
        // Inside the spacing window: the last rebuild hasn't had time to take
        // effect. Ignore (the requester re-fires soon enough) — log only.
        console.info(
          '[useRecording] Mic recovery (' + reason + ') requested within ' +
            MIC_RECOVER_MIN_SPACING_MS + 'ms of the last rebuild — letting it settle',
        )
        break
      case 'give-up':
        // Budget exhausted and mic audio still absent: tell the user ONCE per
        // episode, regardless of which initiator got here first.
        state.gaveUp = true
        trackRecordingEvent('transcription_source_stalled', {
          capture_id: captureIdRef.current ?? null,
          stream: 'mic',
          reason: 'unrecovered',
          via: reason,
          attempt: state.attempts,
        })
        toast.error(
          "Microphone isn't being picked up — try switching the input device in Settings, or restart the app.",
        )
        break
      case 'suppressed':
        // Exhausted episode, give-up already fired: keep the fault queryable in
        // telemetry but no recover_mic and no repeat toast.
        trackRecordingEvent('transcription_source_stalled', {
          capture_id: captureIdRef.current ?? null,
          stream: 'mic',
          reason,
          suppressed: true,
        })
        break
      case 'inactive':
        break
    }
    return action
  }, [])

  // Recover transcription after a mic-stream fault (e.g. a disconnected /
  // switched audio device). The Rust watchdog emits `audio://mic-fault`; the
  // shared coordinator decides whether a rebuild actually fires (budget +
  // spacing + episode logic above) so a persistently dead device can't loop
  // recover_mic unboundedly or fight the first-frame watchdog's rebuilds.
  useEffect(() => {
    if (!isDesktopApp() || !isRecording) return

    return listenScoped((gate) => tauriBridge.onMicFault(gate(() => {
      requestMicRecovery('native_fault')
    })))
    // requestMicRecovery is an identity-stable useCallback (deps []); listed to
    // satisfy exhaustive-deps without changing the effect's trigger.
  }, [isRecording, requestMicRecovery])

  // Wire live self-verification callbacks onto a VoiceIdService instance.
  // Shared by web and desktop: on a grant, POST the qualifying embeddings to
  // /self-binding (server re-verifies before granting) with a once-per-capture
  // latch; on a demotion, drop the label from the "You" special-case (display).
  const wireSelfVerification = useCallback((voiceId: VoiceIdService) => {
    voiceId.onSelfSuggested = (speakerId, similarity) => {
      setSelfSuggestion((prev) => prev ?? { speakerId, similarity })
    }
    voiceId.onSelfDemoted = (speakerId) => {
      setSelfDemotedLabels((prev) => {
        if (prev.has(speakerId)) return prev
        const next = new Set(prev)
        next.add(speakerId)
        return next
      })
    }
    voiceId.onSelfVerified = (speakerId, embeddings) => {
      const captureId = captureIdRef.current
      // The client grant is PROVISIONAL — release it so a later qualifying
      // window can re-fire (the service also un-grants the vote state).
      const releaseProvisionalGrant = () => {
        if (selfBindingRequestedForRef.current === captureId) {
          selfBindingRequestedForRef.current = null
        }
        voiceId.resetSelfGrant()
      }
      // No capture row (e.g. a bare recording with no capture) → nothing to bind.
      // Release so nothing stays latched on the service.
      if (!captureId) {
        voiceId.resetSelfGrant()
        return
      }
      // The server needs 2–5 embeddings each length EMBEDDING_DIM; if the vote
      // window somehow produced fewer, skip — the server would 422 anyway.
      if (embeddings.length < 2) {
        voiceId.resetSelfGrant()
        return
      }
      // Once-per-capture latch: never POST twice for the same capture.
      if (selfBindingRequestedForRef.current === captureId) return
      selfBindingRequestedForRef.current = captureId

      void (async () => {
        try {
          const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
          try {
            const { createClient } = await import('@/lib/supabase/client')
            const supabase = createClient()
            const { data } = await supabase.auth.getSession()
            const token = data.session?.access_token
            if (token) authHeaders['Authorization'] = `Bearer ${token}`
          } catch { /* cookies fallback for web */ }

          const res = await fetch(`/api/account/captures/${captureId}/self-binding`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ speaker_label: speakerId, embeddings }),
          })
          if (!res.ok) {
            // Server rejected (422 = didn't clear the threshold, 403/404 = not
            // the caller's capture, 5xx = transient). Release the provisional
            // grant so a later, stronger window can retry within this capture —
            // one transient failure must NOT permanently lose the binding.
            releaseProvisionalGrant()
            return
          }
          const result = await res.json().catch(() => null)
          if (result?.granted === true) {
            // Server confirmed — make the latch permanent.
            voiceId.confirmSelfGrant()
            // Reflect the grant immediately: the verified label is "You".
            setSpeakerNames((prev) => ({ ...prev, [speakerId]: 'You' }))
            // Un-demote the verified label so "You" shows immediately — a prior
            // sustained mismatch (or a non-default grant) may have demoted the
            // DEFAULT label; a confirmed grant on it restores the "You" display.
            setSelfDemotedLabels((prev) => {
              if (!prev.has(speakerId)) return prev
              const next = new Set(prev)
              next.delete(speakerId)
              return next
            })
          } else {
            // granted:false (CAS matched 0 rows / already confirmed server-side)
            // — the label is settled; make the latch permanent, no re-fire.
            voiceId.confirmSelfGrant()
          }
        } catch {
          // Network failure — release the provisional grant so a retry can happen.
          releaseProvisionalGrant()
        }
      })()
    }
  }, [])

  const startRecording = useCallback(async () => {
    // Custom vocabulary: make sure this session's finished segments are
    // corrected (src/lib/vocabulary/client.ts). Never awaited: a start never waits on it.
    void primeVocabulary()
    setRecordingError(null)
    setRecordingResult(null)
    setSystemAudioStatus(null)
    publishTranscriptSegments([])
    setTranscriptionStatus('connected')
    setSpeakerNames({})
    setSpeakerContacts({})
    // Reset live self-verification state for the new session: demoted-label set
    // and the once-per-capture self-binding latch. Speaker labels repeat across
    // sessions, so stale demotion would mislabel the wrong person.
    setSelfDemotedLabels(new Set())
    setSelfSuggestion(null)
    selfBindingRequestedForRef.current = null
    pendingSelfLearnRef.current = null
    // Clear any unactioned review from the previous session — speaker labels
    // (remote_1, ...) repeat across sessions and a stale review would badge
    // the wrong people in the new one.
    setPostSessionReview(null)
    publishAgentActivity([])
    activityIdCounter.current = 0
    recentChunksRef.current = []
    requestRecordTurnRef.current = null
    cloudPrimeNeededRef.current = false
    // Pairing is re-learned per meeting: the agent (and the edition) may differ.
    pairNotesRef.current = null
    notesPrimeNeededRef.current = false
    // Fresh mic-recovery episode per meeting: the previous session's attempt
    // count / give-up flag must not gate this session's rebuilds.
    micRecoveryStateRef.current = { attempts: 0, lastRecoveryAt: 0, gaveUp: false }
    prevLiveAgentEnabledRef.current = liveAgentEnabledRef.current
    mergerRef.current.clear()
    publishElapsed(0)
    transcriptionConnectedFiredRef.current = false

    // Flushes the merger's current segments to React state and cancels any
    // pending coalesced interim flush.
    const flushTranscript = () => {
      if (pendingInterimFlushRef.current) {
        clearTimeout(pendingInterimFlushRef.current)
        pendingInterimFlushRef.current = null
      }
      publishTranscriptSegments(mergerRef.current.getTranscript())
    }

    // Segment sinks shared by every transcription service this session builds
    // (Deepgram, or the on-device engine — which must exist BEFORE the native
    // start, hence defined up here rather than inside the setup IIFE).
    const handleSegment = (segment: TranscriptSegment) => {
      if (isPausedRef.current) return
      mergerRef.current.addSegment(segment)
      // Feed all segments to the live agent gate immediately (interims for
      // activity tracking, finals for content) — never throttled.
      transcriptGateRef.current?.addSegment(segment)

      if (segment.isFinal) {
        // Finals are durable content — render them right away (and this
        // also flushes any interim coalesced just before).
        flushTranscript()
      } else if (!pendingInterimFlushRef.current) {
        // Coalesce a burst of interims into one state update so the
        // in-progress bubble updates smoothly (~150ms) without a re-render
        // per Deepgram frame.
        pendingInterimFlushRef.current = setTimeout(() => {
          pendingInterimFlushRef.current = null
          publishTranscriptSegments(mergerRef.current.getTranscript())
        }, 150)
      }
    }
    const handleFinalSegment = (finalSegment: TranscriptSegment) => {
      if (isPausedRef.current) return
      voiceIdRef.current?.onFinalSegment(finalSegment)
    }

    const isWeb = !isDesktopApp()
    // On-device transcription (desktop, opt-in local-stt module). Subscribed
    // before the native start; `localEngine` is set only once start_recording
    // confirms the desktop is actually transcribing locally.
    let pendingLocal: LocalTranscriptionService | null = null
    let localEngine: LocalTranscriptionService | null = null
    // The native session the local engine was confirmed for — its stt://
    // events carry this id; any other session's are dropped.
    let localEngineSession = ''

    try {
      if (isWeb) {
        // ── Web mic-only capture ──────────────────────────────────────────
        // No native recorder and no system-audio tap in the browser. We grab the
        // mic via WebAudioCapture (getUserMedia + AudioWorklet → 16 kHz PCM) and
        // feed it to the SAME Deepgram service the desktop uses. systemAudioStatus
        // is 'disabled' because we never even attempt other participants' audio —
        // the UI makes this clear and points to the desktop app.
        const webCapture = new WebAudioCapture()
        // Throws on permission-denied / unsupported — caught by the outer catch,
        // which surfaces the message and re-throws so the provider can clean up
        // the capture row it created in parallel.
        // The browser's default mic (the desktop's priority list is desktop-only).
        await webCapture.start()
        webCaptureRef.current = webCapture
        webSessionRef.current = { sessionId: crypto.randomUUID(), startedAtMs: Date.now() }

        // Mic level → visualizer (system stays 0; there's no system stream).
        webCapture.onLevel = (level) => {
          if (isPausedRef.current) return
          publishLevels({ micLevel: level, systemLevel: 0, timestamp: Date.now() })
        }

        setSystemAudioStatus('disabled')
        setIsRecording(true)
        timerRef.current = setInterval(() => publishElapsed(elapsedRef.current + 1), 1000)
      } else {
      // Clean up stale state from a previous crashed session in this window.
      // stopRecording is now guarded by window ownership on the Rust side,
      // so this will harmlessly fail if another window owns the recording.
      const status = await tauriBridge.getStatus()
      if (status === 'recording') {
        try { await tauriBridge.stopRecording() } catch { /* owned by another window or no session */ }
      }

      // Mic TCC gate. A denied mic is invisible to the capture pipeline —
      // CoreAudio feeds zero-filled buffers and start_recording still
      // succeeds — so check the real permission state up front instead of
      // recording silence. Desktop builds before 0.2.41 don't register these
      // commands; the catches fall back to the old start-anyway behavior.
      const micPerm = await tauriBridge.checkMicPermission().catch(() => 'unknown')
      if (micPerm === 'not-determined') {
        // First-ever use: shows the real system prompt and waits for the answer.
        // 'opened-settings' means the status flipped to denied between check and
        // request (the command re-derives it) — treat it like denied.
        const result = await tauriBridge.requestMicPermission().catch(() => 'unknown')
        if (result === 'denied' || result === 'opened-settings') {
          throw new Error(`Microphone access was denied. Enable ${APP_IN_SYSTEM_SETTINGS} under System Settings → Privacy & Security → Microphone, then start again.`)
        }
      } else if (micPerm === 'denied' || micPerm === 'restricted') {
        // macOS never re-prompts a denied mic (and Windows never prompts at
        // all) — requestMicPermission opens the Settings mic pane so the user
        // lands in the right place.
        void tauriBridge.requestMicPermission().catch(() => {})
        throw new Error(desktopOS() === 'windows'
          ? 'Microphone access is turned off for Native Intelligence. Turn on Microphone access and “Let desktop apps access your microphone” under Settings → Privacy & security → Microphone, then start again.'
          : `Microphone access is turned off. Enable ${APP_IN_SYSTEM_SETTINGS} under System Settings → Privacy & Security → Microphone, then start again.`)
      }

      // System-audio TCC gate. Unlike the mic, a missing System Audio Recording
      // permission never blocks the start — the meeting still records your
      // side. The passive check is cheap and never prompts; builds without it
      // reject → 'unknown' → the old start-anyway behavior.
      if (captureSystemAudioRef.current) {
        const sysPerm = await tauriBridge.checkSystemAudioPermission().catch(() => 'unknown')
        trackRecordingEvent('system_audio_permission_status', { status: sysPerm, source: 'capture_start' })
        if (sysPerm === 'not-determined') {
          // First-ever use: show the real OS prompt NOW, deliberately, instead of letting the tap start un-permitted and record zeros.
          await tauriBridge.requestSystemAudioPermission().catch(() => {})
        }
        // denied → keep going mic-only: Rust reports permissionDenied and SystemAudioWarning offers the fix.
      }

      // Engine selection. With the opt-in local-stt module enabled and ready,
      // ask the desktop to transcribe on-device (free: no Deepgram token, no
      // usage gate, no usage row). Its service subscribes to the stt:// events
      // BEFORE start_recording so an early failure can't be missed. Anything
      // else — older desktop, module off/not ready — yields no service and the
      // Deepgram path runs exactly as before.
      const localPrep = await prepareLocalTranscription(handleSegment, handleFinalSegment)
      pendingLocal = localPrep.service
      if (localPrep.fallbackReason) {
        reportLocalTranscriptionFallback(localPrep.fallbackReason, 'start', captureIdRef.current ?? null)
      }

      const session = await tauriBridge.startRecording({
        captureSystemAudio: captureSystemAudioRef.current,
        ...(localPrep.service ? { transcription: 'local' as const } : {}),
      })

      if (localPrep.service) {
        if (session.transcriptionEngine === 'local') {
          localEngine = localPrep.service
          localEngineSession = session.sessionId
        } else {
          // The desktop answered Deepgram (module no longer ready, sidecar
          // missing, …) — or, missing field, a desktop that can't do local.
          void localPrep.service.stop({ drainTail: false })
          reportLocalTranscriptionFallback(
            session.transcriptionFallbackReason || 'desktop_declined',
            'start',
            captureIdRef.current ?? null,
          )
        }
        pendingLocal = null
      }

      // Surface the actual system-audio outcome so the UI can warn the user
      // when a requested system stream didn't engage (e.g. no permission).
      setSystemAudioStatus(session.systemAudioStatus ?? null)

      // Mark recording as active immediately — audio is already capturing
      setIsRecording(true)
      timerRef.current = setInterval(() => publishElapsed(elapsedRef.current + 1), 1000)
      }

      // Synchronous isRecording mirror for the mic-recovery coordinator (both
      // branches above flipped the React state; the coordinator can't wait a
      // render for it). Cleared at the top of stopRecording / start-failure.
      isRecordingRef.current = true

      // Claim a new session token for the detached setup IIFE below. A stop (or a
      // new start) that races the IIFE bumps this, so the IIFE can detect that its
      // session is no longer current before publishing a live service/voiceId.
      const sessionGeneration = ++sessionGenerationRef.current

      // Fetch Deepgram token and start transcription in the background.
      // Recording continues even if transcription setup fails.
      // Wrapped in a fire-and-forget IIFE so startRecording() resolves
      // immediately after Tauri confirms — callers don't wait for Deepgram.
      ;(async () => { try {
      // Fetch a FRESH Deepgram token. Called for the first setup attempt AND on
      // each setup retry — the tokens expire after 60s, so a retry must never
      // reuse the old one. Throws with a readable detail on a non-OK response.
      const fetchDeepgramToken = async (): Promise<string> => {
        // Get Supabase access token for auth — in the desktop app, cookies
        // aren't available because OAuth happened in the system browser.
        const headers: Record<string, string> = {}
        try {
          const { createClient } = await import('@/lib/supabase/client')
          const supabase = createClient()
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.access_token) {
            headers['Authorization'] = `Bearer ${session.access_token}`
          }
        } catch { /* cookies will be used as fallback */ }
        const tokenRes = await fetch('/api/deepgram-token', { method: 'POST', headers })
        if (!tokenRes.ok) {
          const body = await tokenRes.text().catch(() => 'unknown')
          let detail = ''
          try { detail = JSON.parse(body).error || body } catch { detail = body }
          throw new Error(detail || 'Failed to fetch Deepgram token')
        }
        const { token } = await tokenRes.json()
        return token
      }

      try {
        // Reassigned across setup retries — each retry mints a fresh 60s token.
        // Never fetched for the local engine: on-device transcription is free
        // and must not touch the STT usage gate (it works over limits, too).
        let currentToken = ''
        if (!localEngine) {
          try {
            currentToken = await fetchDeepgramToken()
          } catch (tokenErr) {
            // Couldn't even mint the first token — surface it and skip transcription
            // (recording continues WAV-only, as before). This is a distinct failure
            // from a connect timeout; the setup-retry loop below covers the latter.
            setRecordingError(tokenErr instanceof Error ? tokenErr.message : String(tokenErr))
            throw tokenErr
          }
        }
        {

          // Initialize the live agent transcript gate. We ALWAYS create it so
          // the user can toggle live mode on/off mid-meeting — the gate's
          // enabled flag (synced from liveAgentEnabled via an effect below)
          // decides whether silence windows are accumulated and flushed. When
          // disabled, nothing is accumulated, so no /api/ai/live-agent calls
          // fire (no token cost). The deferred batch run at meeting end handles
          // extraction for the time spent with live mode off.
          {
            let liveAgentInFlight = false
            // Queued chunks carry the capture id bound at ENQUEUE time. With
            // background finalizing (stop no longer blocks on the last turn), a
            // chunk queued during THIS meeting can drain AFTER the user started a
            // NEW meeting — the drain loop below runs inside the old gate
            // handler's invocation, after the in-flight finalizing turn completes,
            // potentially minutes into the next call. Reading captureIdRef at
            // drain time would misattribute the old chunk to the new capture;
            // binding the id at enqueue keeps attribution honest (processChunk's
            // `stale` check handles the rest).
            //
            // Each also carries when the gate flushed it (`flushedAt`, this
            // device's clock). The turn sends AGES, taken just before its
            // fetch, never timestamps, so a skewed device clock never meets the
            // server's: `window_age_ms` for the NEWEST coalesced window (the
            // tool route's time guard reads it, so a fresh window can still be
            // researched and spoken about) and, when they differ,
            // `window_queued_age_ms` for the OLDEST (queue-wait telemetry).
            const pendingChunks: Array<{ text: string; cId: string | null; flushedAt: number }> = []
            const setStatus = (s: LiveAgentStatus) => onLiveAgentStatusChangeRef.current?.(s)
            // Track in-flight count so stopRecording can wait for completion.
            //
            // Part D — the finalizing promise/resolve are owned PER MEETING here
            // (these closures are re-created every startRecording), and only
            // MIRRORED into the shared hook refs so stopRecording can observe
            // this meeting's in-flight work. Since stop now lets finalizing run in
            // the BACKGROUND, a prior meeting's decrementInFlight can fire AFTER a
            // new meeting has started and claimed the shared hook refs for its own
            // finalizing cycle. If decrement wrote the shared refs blindly it would
            // resolve/null the NEW meeting's promise — cross-meeting corruption. So
            // we resolve our OWN local resolve unconditionally, and only clear the
            // shared hook refs when they STILL point at THIS meeting's promise
            // (identity guard). stopRecording likewise snapshots + nulls the hook
            // refs at Phase 2, so the next meeting always starts from a clean slate.
            let inFlightCount = 0
            let localFinalizingPromise: Promise<void> | null = null
            let localFinalizingResolve: (() => void) | null = null
            const incrementInFlight = () => {
              inFlightCount++
              if (inFlightCount === 1 && !localFinalizingPromise) {
                localFinalizingPromise = new Promise<void>((resolve) => {
                  localFinalizingResolve = resolve
                })
                // Mirror into the shared hook refs so stopRecording (Phase 2) can
                // await THIS meeting's finalizing work. A new meeting nulls these
                // on its own start/stop, so we only publish when they're free.
                if (!liveAgentFinalizingPromiseRef.current) {
                  liveAgentFinalizingPromiseRef.current = localFinalizingPromise
                  liveAgentResolveRef.current = localFinalizingResolve
                }
              }
            }
            const decrementInFlight = () => {
              inFlightCount = Math.max(0, inFlightCount - 1)
              if (inFlightCount === 0 && localFinalizingResolve) {
                const resolve = localFinalizingResolve
                const settledPromise = localFinalizingPromise
                localFinalizingResolve = null
                localFinalizingPromise = null
                resolve()
                // Only clear the shared hook refs if they still reference OUR
                // promise — never a newer meeting's (identity guard).
                if (liveAgentFinalizingPromiseRef.current === settledPromise) {
                  liveAgentResolveRef.current = null
                  liveAgentFinalizingPromiseRef.current = null
                }
              }
            }

            // Only announce 'listening' if live mode is actually on. The gate is
            // always created now (so it can be toggled on mid-meeting), but when
            // live is off the provider owns the status ('deferred'), and emitting
            // 'listening' here would cause an idle→listening→deferred flicker.
            if (liveAgentEnabledRef.current) setStatus('listening')

            // `cId` is the capture this chunk belongs to, bound at ENQUEUE /
            // invocation time — NOT read from captureIdRef here. See the
            // pendingChunks comment: with background finalizing, a chunk queued
            // during the OLD meeting can drain after a NEW meeting started, and
            // reading the ref at call time would misattribute it. A null cId
            // (no capture at enqueue) drops the chunk, as before.
            //
            // A RECORD-ONLY pass (live-agent messaging L3) has no new text:
            // `text` is null and it re-sends the windows already in the sliding
            // window, so the turn that writes the record reads the directive
            // the user just sent. It never runs for a stale meeting (the batch
            // pass consumes or expires what is left), nor before the first
            // window.
            const processChunk = async (
              text: string | null,
              cId: string | null,
              opts: { recordOnly?: boolean; flushedAt?: number; queuedSince?: number } = {},
            ) => {
              if (!cId) return
              const recordOnly = opts.recordOnly === true
              // When the gate flushed this window (a record-only pass has none).
              const windowFlushedAt = recordOnly ? undefined : opts.flushedAt
              // The oldest coalesced window's flush, sent only when it differs.
              const windowQueuedSince =
                recordOnly || opts.queuedSince === undefined || opts.queuedSince === windowFlushedAt
                  ? undefined
                  : opts.queuedSince
              if (
                recordOnly &&
                (cId !== captureIdRef.current || recentChunksRef.current.length === 0)
              ) {
                return
              }

              // STALE = this chunk's meeting is no longer the active capture (a
              // new meeting started, or the capture was cleared). A stale chunk is
              // still real transcript content correctly attributed to ITS capture,
              // so it's still extracted — but it must not touch ANY state belonging
              // to the CURRENT meeting: not the sliding window (that's the new
              // meeting's extraction input), not the activity feed or status. It
              // goes to the live turn with its own text only.
              const stale = cId !== captureIdRef.current

              // Late-result guard (Part B). With background finalizing, a turn from
              // THIS capture can complete AFTER the user started a NEW meeting
              // (startRecording clears agentActivity + sets a new captureId). Push
              // this turn's proposals/nudges into the feed ONLY while the active
              // capture is still the one that started them — otherwise the old
              // capture's items would bleed into the new meeting's panel. (They're
              // already persisted server-side; this only gates the in-panel feed.)
              const emitActivity = (
                update: (prev: AgentActivityEvent[]) => AgentActivityEvent[],
              ) => {
                if (captureIdRef.current !== cId) return
                publishAgentActivity(update)
              }

              // Status is the CURRENT meeting's — a stale chunk must not flip it.
              if (!stale) setStatus('processing')

              // Push to sliding window (capped at RECENT_CHUNKS_MAX). Current
              // meeting only: a stale chunk's text must not contaminate the new
              // meeting's window.
              if (!stale && text !== null) {
                recentChunksRef.current = [
                  ...recentChunksRef.current,
                  text,
                ].slice(-RECENT_CHUNKS_MAX)
              }

              // Get auth token for the API call
              let authHeaders: Record<string, string> = {}
              try {
                const { createClient } = await import('@/lib/supabase/client')
                const supabase = createClient()
                const { data: { session } } = await supabase.auth.getSession()
                if (session?.access_token) {
                  authHeaders['Authorization'] = `Bearer ${session.access_token}`
                }
              } catch { /* cookies fallback */ }

              // ── Live turns (eve live-agent, via /api/ai/live-agent) ──────
              const primeMeetingSoFar = (): string | undefined => {
                const primed = formatTranscriptForPriming(
                  mergerRef.current.getTranscript(),
                  speakerNamesRef.current,
                  selfDemotedLabelsRef.current,
                )
                return primed.trim() ? primed : undefined
              }
              // ONE cloud live turn for `role` over this window. 'copilot' is
              // the capture's live agent — today's turn, unchanged. 'notes' is
              // the PAIRED NOTE-TAKER: it sends no recipe_id (the route resolves
              // the batch persona for it) and its output is the record, never a
              // word to the user. Both feed the activity feed the same way.
              const postLiveTurn = async (
                role: 'copilot' | 'notes',
                prime: string | undefined,
              ): Promise<{ pair_notes?: boolean; skipped?: string } | null> => {
                const res = await fetch('/api/ai/live-agent', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({
                    capture_id: cId,
                    // Stale: this chunk's OWN text only — recentChunksRef now holds
                    // the NEW meeting's window and must not leak into the old
                    // capture's extraction (nor vice versa).
                    recent_chunks: stale && text !== null ? [text] : recentChunksRef.current,
                    corrections_log: correctionsLogRef.current.length > 0
                      ? correctionsLogRef.current
                      : undefined,
                    ...(role === 'notes'
                      ? { live_role: 'notes' }
                      : { recipe_id: agentIdRef.current || undefined }),
                    ...(prime ? { prior_transcript: prime } : {}),
                    ...(recordOnly ? { record_only: true } : {}),
                    // Ages at send time (see the pendingChunks comment).
                    ...(windowFlushedAt !== undefined ? { window_age_ms: Math.max(0, Date.now() - windowFlushedAt) } : {}),
                    ...(windowQueuedSince !== undefined
                      ? { window_queued_age_ms: Math.max(0, Date.now() - windowQueuedSince) }
                      : {}),
                  }),
                })
                if (!res.ok) return null
                // Parse tool call details for activity feed
                try {
                  const data = (await res.json()) as {
                    pair_notes?: boolean
                    tool_call_details?: Array<{ tool: string; args: Record<string, unknown> }>
                  }
                  if (data.tool_call_details?.length) {
                    const events: AgentActivityEvent[] = data.tool_call_details.map((tc) => ({
                      id: `activity-${++activityIdCounter.current}`,
                      toolName: tc.tool,
                      args: tc.args,
                      state: 'result' as const,
                      timestamp: Date.now(),
                    }))
                    emitActivity((prev) => [...prev, ...events])
                  }
                  return data
                } catch {
                  return null
                }
              }
              // The note-taker's one-shot meeting-so-far prime (live toggled ON
              // mid-meeting), consumed by its first turn. A stale chunk never
              // takes it — it belongs to the current meeting.
              const takeNotesPrime = (): string | undefined => {
                if (stale || !notesPrimeNeededRef.current) return undefined
                notesPrimeNeededRef.current = false
                return primeMeetingSoFar()
              }

              try {
                // If live was toggled ON mid-meeting, this first cloud turn carries
                // the meeting-so-far as background context so the agent isn't blind
                // to everything said before the toggle. Sent ONCE, then cleared —
                // subsequent turns feed forward via the capture's ai_summary as
                // usual. Bounded by formatTranscriptForPriming's char cap.
                // A stale chunk must not CONSUME the one-shot prime flag (it belongs
                // to the current meeting's first cloud turn), nor send the current
                // merger's transcript as another capture's context.
                let priorTranscript: string | undefined
                if (!stale && cloudPrimeNeededRef.current) {
                  cloudPrimeNeededRef.current = false
                  priorTranscript = primeMeetingSoFar()
                }

                // PAIRED LIVE NOTES. An assist-only live agent (a sales copilot)
                // talks to the user and writes nothing, so the record needs a
                // second agent on the same window. The copilot turn's response
                // says whether that is the case (`pair_notes`); once known, the
                // notes turn runs IN PARALLEL with every later copilot turn. On
                // the window that first tells us, it runs right after, so no
                // window goes un-noted. Stale chunks (a previous meeting's last
                // window) take no notes turn: the pairing answer belongs to the
                // current meeting, and the old capture's post-call pass runs
                // anyway. The notes turn's own failure never fails the copilot's.
                // RECORD-ONLY, paired: only the note-taker writes the record, and
                // the copilot has nothing new to hear, so the notes turn runs
                // alone (plan 3.6).
                if (recordOnly && pairNotesRef.current === true) {
                  await postLiveTurn('notes', takeNotesPrime())
                  return
                }
                const notesInFlight =
                  !stale && pairNotesRef.current === true
                    ? postLiveTurn('notes', takeNotesPrime()).catch((err) => {
                        console.warn('[useRecording] Paired notes turn failed:', err)
                        return null
                      })
                    : null
                const copilot = await postLiveTurn('copilot', priorTranscript)
                if (!stale && copilot && typeof copilot.pair_notes === 'boolean') {
                  const wasPaired = pairNotesRef.current === true
                  pairNotesRef.current = copilot.pair_notes
                  if (copilot.pair_notes && !wasPaired) {
                    await postLiveTurn('notes', takeNotesPrime()).catch((err) => {
                      console.warn('[useRecording] Paired notes turn failed:', err)
                    })
                  }
                }
                if (notesInFlight) await notesInFlight
              } catch (err) {
                console.warn('[useRecording] Live agent call failed:', err)
              }
            }

            // A record turn requested while a pass is in flight (live-agent
            // messaging L3). A boolean, not a counter: however many directives
            // land during one pass, one record turn after it reads them all.
            let recordTurnRequested = false

            // One pass of live turns: the window (or record-only turn) that
            // started it, then everything that queued behind it.
            const runPass = async (
              text: string | null,
              cId: string | null,
              recordOnly: boolean,
              flushedAt?: number,
            ) => {
              // The capture this gate pass belongs to. Passed to processChunk as
              // its identity, and used to guard the terminal status flip: with
              // background finalizing, this pass can complete AFTER the user
              // started a NEW meeting, and a stale setStatus('listening') would
              // clobber the new meeting's status (which the provider drives). Only
              // flip status back to 'listening' if we're still the active capture
              // (Part B, status half).
              const gateCaptureId = captureIdRef.current

              liveAgentInFlight = true
              incrementInFlight()
              try {
                await processChunk(text, cId, { recordOnly, flushedAt })
                // Drain the whole queue as ONE window per pass rather than one
                // chunk at a time: chunks queued while a turn was in flight are a
                // second crumb source (each fires its own thin extraction turn).
                // Coalescing them into a single window gives extraction the same
                // substantive input the size floor is designed to produce. Loop in
                // case more chunks arrive during the await. All entries in one
                // drain belong to one meeting (the queue is per-gate, and the gate
                // is nulled at stop before a new meeting creates its own), so join
                // the texts and take the identity from the first entry.
                //
                // A record turn requested meanwhile rides the next window when
                // there is one (that window's record-writing turn starts after
                // the directive landed, so it reads it); otherwise it runs on its
                // own, only while this meeting is still the one recording.
                while (pendingChunks.length > 0 || recordTurnRequested) {
                  recordTurnRequested = false
                  if (pendingChunks.length > 0) {
                    const batch = pendingChunks.splice(0)
                    const next = batch.map((c) => c.text).join('\n')
                    // The guard's clock is the NEWEST window; the oldest is
                    // how long this turn's input waited (telemetry).
                    const flushTimes = batch.map((c) => c.flushedAt)
                    await processChunk(next, batch[0].cId, {
                      flushedAt: Math.max(...flushTimes),
                      queuedSince: Math.min(...flushTimes),
                    })
                  } else if (transcriptGateRef.current === gate && captureIdRef.current === gateCaptureId) {
                    await processChunk(null, gateCaptureId, { recordOnly: true })
                  }
                }
              } finally {
                liveAgentInFlight = false
                decrementInFlight()
                // Don't reassert 'listening' for a capture that's no longer active
                // — a background finalizing completion must not flip a new meeting's
                // status (or a stopped meeting's) back to listening.
                if (captureIdRef.current === gateCaptureId) setStatus('listening')
              }
            }

            const gate = new TranscriptGate(async (text) => {
              // Queue chunks to prevent concurrent API calls (rate limiting).
              // Bind the capture id NOW — see the pendingChunks comment for why
              // enqueue-time identity matters under background finalizing.
              const flushedAt = Date.now()
              if (liveAgentInFlight) {
                pendingChunks.push({ text, cId: captureIdRef.current, flushedAt })
                return
              }
              await runPass(text, captureIdRef.current, false, flushedAt)
            })

            // The out-of-cycle record turn (live-agent messaging L3, plan 3.6):
            // a directive landed, so get it recorded within one turn instead of
            // waiting for the next window. Idle with transcript buffered: flush
            // it now, under the size floor, as an ordinary window (the copilot
            // still hears it, and the record turn reads the directive). Idle
            // with nothing buffered: a record-only pass. In flight: one record
            // turn after the pass, coalesced.
            requestRecordTurnRef.current = (requestedCaptureId: string) => {
              if (!liveAgentEnabledRef.current) return
              if (transcriptGateRef.current !== gate || captureIdRef.current !== requestedCaptureId) return
              if (liveAgentInFlight) {
                recordTurnRequested = true
                return
              }
              if (gate.hasPending()) {
                gate.flush()
                return
              }
              void runPass(null, requestedCaptureId, true)
            }

            // Start enabled only if live mode is currently on; otherwise the
            // gate sits dormant until the user toggles live mode on (see the
            // sync effect below).
            gate.setEnabled(liveAgentEnabledRef.current)
            transcriptGateRef.current = gate
          }

          // Transcription health → UI state + the once-per-session connected
          // breadcrumb. `engine` tags a local-engine connect; a Deepgram connect
          // keeps the event's historical shape.
          const handleTranscriptionStatus = (status: TranscriptionStatus, engine?: 'local') => {
            setTranscriptionStatus(status)
            // Durable breadcrumb: the live transcription socket actually opened.
            // Its ABSENCE after a recording_resumed is the signal that a resume
            // failed to bring transcription back. Fire once per session. With the
            // socket-leak fix (deepgram-stream), a timed-out socket can no longer
            // open late and fire this — so it now only fires for a genuinely
            // started service.
            if (status === 'connected' && !transcriptionConnectedFiredRef.current) {
              transcriptionConnectedFiredRef.current = true
              trackRecordingEvent('transcription_connected', {
                capture_id: captureIdRef.current ?? null,
                platform: isWeb ? 'web' : 'tauri',
                ...(engine ? { engine } : {}),
              })
            }
          }

          // Build a FRESH Deepgram service. Called once per setup attempt — a
          // retry after a failed start() must not reuse a half-initialized
          // service (its failed legs armed their own reconnects; a clean rebuild
          // is simpler and correct). `timeOffsets` is set only for a fallback
          // from the local engine (see fallBackToDeepgram below).
          const buildService = (timeOffsets?: Record<'mic' | 'system', number>): DeepgramStreamingService => {
            const svc = new DeepgramStreamingService(
              timeOffsets
                ? (segment) => handleSegment(shiftSegmentTime(segment, timeOffsets[segment.stream]))
                : handleSegment,
              timeOffsets
                ? (segment) => handleFinalSegment(shiftSegmentTime(segment, timeOffsets[segment.stream]))
                : handleFinalSegment,
              // VAD callback (unused by gate, but available for status display)
              undefined,
            )
            svc.onTranscriptionStatus = (status) => handleTranscriptionStatus(status)
            // Provide an auth header getter for usage logging — fired once on stop().
            svc.getUsageAuthHeader = async () => {
              try {
                const { createClient } = await import('@/lib/supabase/client')
                const supabase = createClient()
                const { data } = await supabase.auth.getSession()
                const token = data.session?.access_token
                return token ? `Bearer ${token}` : null
              } catch {
                return null
              }
            }
            // Provide a token refresher so reconnects after token expiry can get a new key.
            // Must refresh the Supabase session first — the JWT expires during network outages.
            svc.refreshApiKey = async () => {
              // Don't attempt token refresh while offline — it will fail and waste a retry
              if (typeof navigator !== 'undefined' && !navigator.onLine) {
                throw new Error('Offline — skipping token refresh')
              }
              const refreshHeaders: Record<string, string> = {}
              try {
                const { createClient } = await import('@/lib/supabase/client')
                const supabase = createClient()
                // Force-refresh the session to get a new access token (the old one
                // likely expired during the network outage)
                const { data: refreshData } = await supabase.auth.refreshSession()
                const accessToken = refreshData.session?.access_token
                if (!accessToken) {
                  // Fall back to the possibly-stale session
                  const { data: { session } } = await supabase.auth.getSession()
                  if (session?.access_token) {
                    refreshHeaders['Authorization'] = `Bearer ${session.access_token}`
                  }
                } else {
                  refreshHeaders['Authorization'] = `Bearer ${accessToken}`
                }
              } catch { /* cookies fallback */ }
              const res = await fetch('/api/deepgram-token', { method: 'POST', headers: refreshHeaders })
              if (!res.ok) throw new Error('Failed to refresh Deepgram token')
              const { token } = await res.json()
              return token
            }
            return svc
          }

          // ── Bounded setup-retry (Part B) ─────────────────────────────────────
          // service.start() throws only when BOTH Deepgram legs fail to connect
          // (degraded-dual start in deepgram-stream keeps a single-leg success).
          // On that throw, the extracted loop retries the WHOLE setup — re-fetch
          // the token (60s TTL, so never reuse the old one) and build a fresh
          // service — on SETUP_RETRY_DELAYS_MS backoff. Every await is guarded by
          // the session generation so a stop / new start cancels pending retries
          // and disposes anything half-built. On exhaustion the user is told no
          // transcript is being captured (no more silent console.warn). A mid-
          // recording success just starts transcription from that point.
          const isCurrent = () => sessionGenerationRef.current === sessionGeneration
          const startDeepgram = (firstToken: string, timeOffsets?: Record<'mic' | 'system', number>) => runTranscriptionSetupWithRetry<DeepgramStreamingService>(
            firstToken,
            {
              fetchToken: fetchDeepgramToken,
              buildAndStart: async (token) => {
                const svc = buildService(timeOffsets)
                await svc.start(token, isWeb ? 'web' : 'tauri')
                return svc
              },
              dispose: (svc) => svc.stop(),
              isCurrent,
              onAttemptFailed: (attempt, reason) => {
                trackRecordingEvent('transcription_failed', {
                  capture_id: captureIdRef.current ?? null,
                  platform: isWeb ? 'web' : 'tauri',
                  reason,
                  attempt,
                })
                if (reason !== 'exhausted') {
                  console.warn(
                    `[useRecording] Deepgram setup attempt ${attempt} failed (${reason}) — will retry`,
                  )
                }
              },
              onExhausted: () => {
                // Surface it. Match the mic-recovery toast pattern (toast.error)
                // so the user knows transcription is down for this recording.
                setRecordingError('Live transcription could not connect — no transcript is being captured for this recording.')
                toast.error(
                  "Live transcription couldn't connect — this recording won't have a transcript. Try stopping and starting again, or check your connection.",
                )
              },
            },
          )

          // ── Mic first-frame watchdog (desktop only) ─────────────────────────
          // Arm ONLY on desktop: recover_mic is a Tauri command, and only the
          // native capture path can hit the CoreAudio device-release race on
          // resume-after-quit (a mic stream that opens but never fires its IO
          // proc, so zero PCM arrives from t=0 while system audio flows). See
          // the coordinator comment above decideMicRecovery. This same code
          // covers fresh starts AND resumes because they share startRecording —
          // the resume path is NOT gated separately; that's the point.
          //
          // The watchdog only DETECTS starvation; whether a rebuild actually
          // fires is the shared coordinator's call (requestMicRecovery), so this
          // initiator and the native fault path draw on one budget and can't
          // stack rebuilds or double-toast.
          const watchMicFirstFrame = (watchedService: TranscriptionService) => {
            // Capture the service instance for a generation check: if a stop or a
            // restart swaps transcriptionServiceRef.current out from under us, every
            // scheduled check compares against THIS instance and no-ops, so a
            // stale timer can never rebuild the mic for a meeting that's over.
            const armMicWatchdog = () => {
              micWatchdogTimerRef.current = setTimeout(() => {
                micWatchdogTimerRef.current = null
                if (transcriptionServiceRef.current !== watchedService) return
                // First frame arrived — the stream is live. Later mid-meeting
                // deaths are the native fault watchdog's job; this one is done.
                if (watchedService.hasReceivedAudio('mic')) return
                // A PAUSED recording legitimately produces no PCM (the native mic
                // callback gates on pause before emitting), so a pause inside the
                // first-frame window must not read as starvation: don't burn a
                // recovery attempt or escalate to the toast — keep watching until
                // unpaused. The native watchdog gates on pause the same way.
                if (isPausedRef.current) {
                  armMicWatchdog()
                  return
                }
                const action = requestMicRecovery('no_first_frame')
                // Keep checking while recovery is in progress ('recover') or
                // momentarily deferred behind another initiator's fresh rebuild
                // ('throttled'). Stop once the coordinator gave up (toast already
                // shown), suppressed us (give-up fired earlier this episode), or
                // the recording went inactive.
                if (action === 'recover' || action === 'throttled') armMicWatchdog()
              }, MIC_FIRST_FRAME_TIMEOUT_MS)
            }
            armMicWatchdog()
          }

          // ── Local engine → Deepgram fallback ────────────────────────────────
          // stt://engine-changed: the on-device engine never came up ('start':
          // the desktop answers 'local' before the sidecar has loaded, so a load
          // failure lands here) or died mid-meeting ('mid_session', after
          // results had flowed). Transcribe the rest of the session with Deepgram: mint a
          // token — the normal STT usage gate applies, and if it refuses, the
          // recording continues WAV-only exactly like the token failure above —
          // then the same bounded setup-retry. A fresh connection's clock starts
          // at 0, so its segments are shifted by the local engine's audio clock
          // to land after the local ones (TranscriptMerger sorts by startTime).
          const fallBackToDeepgram = async (
            local: LocalTranscriptionService,
            reason: string,
            phase: LocalFallbackPhase,
          ) => {
            if (!isCurrent()) return
            const timeOffsets = { mic: local.getAudioSeconds('mic'), system: local.getAudioSeconds('system') }
            void local.stop({ drainTail: false })
            // The stopped local service sees no more audio: its first-frame
            // watchdog must not read that as a dead mic. Re-armed on success.
            if (micWatchdogTimerRef.current) {
              clearTimeout(micWatchdogTimerRef.current)
              micWatchdogTimerRef.current = null
            }
            reportLocalTranscriptionFallback(reason, phase, captureIdRef.current ?? null)
            let token: string
            try {
              token = await fetchDeepgramToken()
            } catch (tokenErr) {
              if (isCurrent()) setRecordingError(tokenErr instanceof Error ? tokenErr.message : String(tokenErr))
              return
            }
            if (!isCurrent()) return
            const result = await startDeepgram(token, timeOffsets)
            if (result.status !== 'started') return
            const fallback = result.service
            // Keep Voice ID fed: carry over the audio sink the Voice ID setup
            // below wired onto the local service.
            fallback.onAudioData = local.onAudioData
            transcriptionServiceRef.current = fallback
            watchMicFirstFrame(fallback)
          }

          if (localEngine) {
            // ── On-device engine ──────────────────────────────────────────────
            // start_recording confirmed it. Publish it as the session's service:
            // Voice ID's audio feed and the mic watchdogs read it exactly like a
            // Deepgram one. No token and no usage logging — local is free.
            const local = localEngine
            if (!isCurrent()) {
              void local.stop({ drainTail: false })
              return
            }
            local.onTranscriptionStatus = (status) => handleTranscriptionStatus(status, 'local')
            transcriptionServiceRef.current = local
            // Binds the service to this native session: stt:// events buffered
            // since attach() are replayed if they are this session's, dropped
            // otherwise (a previous recording's late events never leak in).
            local.start(localEngineSession)
            watchMicFirstFrame(local)
            // Registered last: replays a failure that arrived during start-up
            // (the fallback disarms the watchdog just armed for `local`).
            local.setFallbackHandler((reason, phase) => { void fallBackToDeepgram(local, reason, phase) })
          } else {
            const setupResult = await startDeepgram(currentToken)
            // 'exhausted' / 'cancelled' → nothing to publish; the loop already
            // disposed any half-built service and (for exhausted) surfaced the
            // error + toast. Only a 'started' result yields a service to wire up.
            if (setupResult.status !== 'started') {
              // Disarm the mic first-frame watchdog if it was somehow armed — it
              // must not fire recover_mic against a session with no live service.
              if (micWatchdogTimerRef.current) {
                clearTimeout(micWatchdogTimerRef.current)
                micWatchdogTimerRef.current = null
              }
              return
            }
            const service = setupResult.service
            transcriptionServiceRef.current = service

            // Web: pump mic PCM from the browser capture into the mic connection,
            // in place of the desktop's Tauri audio events. (Desktop wires this
            // internally via the audio:// listeners in service.start('tauri').)
            if (isWeb && webCaptureRef.current) {
              webCaptureRef.current.onPcm = (bytes) => {
                if (isPausedRef.current) return
                service.sendMicAudio(bytes)
              }
            }

            if (!isWeb) watchMicFirstFrame(service)
          }
        }
      } catch {
        // Transcription setup failed — recording continues without live transcript.
        // Disarm the mic first-frame watchdog if it was armed before the throw:
        // left running, its generation check would still pass (the service is
        // still "current") while the rest of the setup never completed, and the
        // timer chain would burn shared recoveries / toast against a
        // half-initialized session. Mirrors the stop/start-failure clear sites.
        if (micWatchdogTimerRef.current) {
          clearTimeout(micWatchdogTimerRef.current)
          micWatchdogTimerRef.current = null
        }
      }

      // Initialize Voice ID in background (works independently of Deepgram).
      // Desktop runs the full path: CRM contact matching + suggestions + live
      // self-verification. Web (v1) still skips CRM contact matching (it's mic-
      // only, and the suggestion UI is tuned for the desktop's per-stream audio),
      // but an ENROLLED user gets live self-verification (self_binding='voice') —
      // see the web branch below. Non-enrolled web users are unchanged: Deepgram
      // diarization still runs (local_* speakers), just no voice matching.
      if (!isWeb) {
      const voiceId = new VoiceIdService()
      voiceId.autoAcceptDelaySec = autoAcceptDelayRef.current
      voiceId.onSpeakerIdentified = (speakerId, contactId, contactName, confidence, isAutoMatched) => {
        setSpeakerContacts((prev) => ({
          ...prev,
          [speakerId]: { contactId, contactName, confidence, isAutoMatched },
        }))
        setSpeakerNames((prev) => ({ ...prev, [speakerId]: contactName }))
      }
      voiceId.onSpeakerSuggested = (speakerId, contactId, contactName, confidence) => {
        const identification = voiceId.getIdentification(speakerId)
        const hasCountdown = identification?.autoAcceptCountdown != null
        const suggestion: SpeakerIdentification = {
          contactId, contactName, confidence, isAutoMatched: false,
          isSuggestion: true, trustTier: identification?.trustTier,
          autoAcceptCountdown: identification?.autoAcceptCountdown,
          isLearningMatch: identification?.isLearningMatch,
        }
        // From here on this speaker's countdown ticks count THIS entry down.
        latestSuggestionRef.current.set(speakerId, suggestion)
        setSpeakerContacts((prev) => ({
          ...prev,
          [speakerId]: suggestion,
        }))

        // Start auto-accept countdown for 'recognizing' tier
        if (hasCountdown) {
          let remaining = identification!.autoAcceptCountdown!
          const timer = setInterval(() => {
            remaining--
            if (remaining <= 0) {
              clearInterval(timer)
              autoAcceptTimers.current.delete(speakerId)
              // Countdown expiry is NOT a human confirmation — the service
              // flags it 'auto' so it goes through post-session review
              // instead of enrolling/confirming on its own.
              voiceIdRef.current?.acceptSuggestion(speakerId, { viaTimeout: true })
              setSpeakerContacts((prev) => {
                const existing = prev[speakerId]
                if (!existing?.isSuggestion) return prev
                return {
                  ...prev,
                  [speakerId]: { ...existing, isSuggestion: false, isAutoMatched: false },
                }
              })
              setSpeakerNames((prev) => ({ ...prev, [speakerId]: contactName }))
            } else {
              // A tick changes only the chip's number: publish it to the tick
              // store for the speaker's current suggestion, which re-renders
              // that chip alone (see autoAcceptTicksRef). While the speaker's
              // entry isn't that suggestion, no chip shows it.
              const current = latestSuggestionRef.current.get(speakerId)
              if (current) {
                autoAcceptTicksRef.current.set(current, remaining)
                autoAcceptTicksListenersRef.current.forEach((cb) => cb())
              }
            }
          }, 1000)
          autoAcceptTimers.current.set(speakerId, timer)
        }
      }

      // Live self-verification (self_binding='voice'): runs alongside contact
      // matching on desktop. loadSelfProfile is added to the init chain below.
      wireSelfVerification(voiceId)

      // Wire audio data for Voice ID ring buffers (a local engine's Deepgram
      // fallback carries this sink over — see fallBackToDeepgram)
      if (transcriptionServiceRef.current) {
        transcriptionServiceRef.current.onAudioData = (stream, bytes) => {
          if (isPausedRef.current) return
          voiceIdRef.current?.feedAudio(stream, bytes)
        }
      }

      voiceId.initialize()
        // Load both galleries: CRM contacts (matching) AND the user's own voice
        // profile (self-verification). Independent — either may be empty.
        .then(() => Promise.all([voiceId.loadEnrollments(), voiceId.loadSelfProfile()]))
        .then(() => {
          // Same guard as the Deepgram publish: if a stop/new-start raced this
          // async init, don't publish a live VoiceID into the ref of a stopped
          // (or newer) session — stop already nulled voiceIdRef. Dispose instead.
          if (sessionGenerationRef.current !== sessionGeneration) {
            voiceId.stop()
            return
          }
          voiceIdRef.current = voiceId
          confirmPendingSelfLabel(voiceId, pendingSelfLearnRef.current, captureIdRef.current)
          setVoiceIdReady(true)
        })
        .catch((err) => {
          console.warn('[useRecording] Voice ID failed to initialize:', err)
          voiceIdRef.current = null
          setVoiceIdReady(false)
        })
      } else {
        // ── Web self-verification (mic-only) ──────────────────────────────
        // Web deliberately does NOT run CRM contact matching (empty gallery →
        // the suggestion UI stays inert). But an ENROLLED user still gets live
        // self-verification: build a VoiceIdService, load ONLY the self profile,
        // and skip the whole thing (no worker download) when not enrolled.
        //
        // loadSelfProfile runs FIRST (a plain fetch, no worker) so we only pay
        // the ~100MB model download when there's actually a profile to match.
        const voiceId = new VoiceIdService()
        wireSelfVerification(voiceId)

        // Feed mic PCM into the Voice ID ring buffer. On web, sendMicAudio (fed
        // by WebAudioCapture) invokes onAudioData('mic', ...) — same seam the
        // desktop uses. Only local_* (mic) speakers exist here.
        if (transcriptionServiceRef.current) {
          transcriptionServiceRef.current.onAudioData = (stream, bytes) => {
            if (isPausedRef.current) return
            voiceIdRef.current?.feedAudio(stream, bytes)
          }
        }

        void (async () => {
          try {
            await voiceId.loadSelfProfile()
            // Not enrolled → don't download the model or take a worker. Web stays
            // exactly as it is today (mic-only diarization, no matching).
            if (!voiceId.hasSelfProfile()) return
            await voiceId.initialize()
            // Race guard: a stop/new-start moved the session on — dispose.
            if (sessionGenerationRef.current !== sessionGeneration) {
              voiceId.stop()
              return
            }
            voiceIdRef.current = voiceId
            confirmPendingSelfLabel(voiceId, pendingSelfLearnRef.current, captureIdRef.current)
            setVoiceIdReady(true)
          } catch (err) {
            console.warn('[useRecording] Web self-verification failed to initialize:', err)
            voiceIdRef.current = null
            setVoiceIdReady(false)
          }
        })()
      } // end if (!isWeb) / web self-verification
      } catch (bgErr) {
        // Background setup (Deepgram/VoiceID) failed — recording continues without them.
        // Same watchdog disarm as the inner catch: a throw AFTER the watchdog was
        // armed (e.g. in the Voice ID section) must not leave the timer chain
        // running against a half-initialized setup.
        if (micWatchdogTimerRef.current) {
          clearTimeout(micWatchdogTimerRef.current)
          micWatchdogTimerRef.current = null
        }
        console.warn('[useRecording] Background transcription setup failed:', bgErr)
      } })()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // "already active" is an expected guard, not an error — log quietly
      if (msg.includes('already active')) {
        console.debug('[useRecording] blocked: another window is recording')
      } else {
        console.error('[useRecording] start failed:', msg)
      }
      // Web mic-capture failures (permission/device) are surfaced by the
      // RecordingProvider's MicPermissionDialog instead of a stray red string —
      // don't also set recordingError for them. Other failures still do.
      if (!(e instanceof WebAudioCaptureError)) {
        setRecordingError(msg)
      }
      // Tear down the browser mic capture (web). No-op/null on desktop.
      webCaptureRef.current?.stop()
      webCaptureRef.current = null
      webSessionRef.current = null
      // Only attempt native cleanup on desktop, and not for "already active"
      // (that means another window owns the session — don't stop it).
      if (!isWeb && !msg.includes('already active')) {
        try { await tauriBridge.stopRecording() } catch { /* ignore */ }
      }
      // Disarm the mic first-frame watchdog if the background IIFE armed it
      // before this start failed — it must not fire recover_mic post-teardown —
      // and close the coordinator's synchronous gate for the same reason.
      isRecordingRef.current = false
      // Move the session token past this failed start so the detached setup IIFE
      // (if still resolving) disposes its service/voiceId instead of publishing.
      sessionGenerationRef.current++
      if (micWatchdogTimerRef.current) {
        clearTimeout(micWatchdogTimerRef.current)
        micWatchdogTimerRef.current = null
      }
      void transcriptionServiceRef.current?.stop()
      transcriptionServiceRef.current = null
      // A local engine subscribed for this start but never published (e.g. the
      // native start itself failed): drop its listeners.
      void (pendingLocal ?? localEngine)?.stop({ drainTail: false })
      voiceIdRef.current?.stop()
      voiceIdRef.current = null
      setVoiceIdReady(false)
      // Clear the recording flag so the UI doesn't get stuck "recording" after a
      // failed web start (desktop relies on the native session, but on web the
      // setIsRecording(true) above already fired before the failure).
      setIsRecording(false)
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      // Re-throw so callers (RecordingProvider) know the start failed
      throw e
    }
    // publishLevels/publishElapsed/publishTranscriptSegments/publishAgentActivity/
    // requestMicRecovery/wireSelfVerification are identity-stable useCallbacks
    // (deps []) — listed only to satisfy exhaustive-deps; they never change so
    // startRecording stays identity-stable (which the stable context value
    // relies on).
  }, [publishLevels, publishElapsed, publishTranscriptSegments, publishAgentActivity, requestMicRecovery, wireSelfVerification])

  const stopRecording = useCallback(async () => {
    // Stop means audio + transcription + the recording UI stop IMMEDIATELY (~1s).
    // The live agent's finalizing turn continues in the BACKGROUND (Phase 2) — it
    // no longer blocks teardown. So the user can start the next call right away and
    // the waveform stops repainting instantly, instead of the old behavior where
    // the mic/system tap stayed hot for up to ~45s waiting on finalization.
    //
    // ── Phase 1: immediate teardown (all fast, all awaited) ──────────────────

    // Zero out audio levels immediately so the visualizer stops showing audio.
    // This is also re-asserted after setIsRecording(false) below — that flag flip
    // unsubscribes the onAudioLevel listener effect, which is what makes the zero
    // STICK (otherwise a late in-flight level event would repaint the waveform).
    publishLevels({ micLevel: 0, systemLevel: 0, timestamp: 0 })

    // Recording is over as far as mic recovery is concerned: flip the
    // coordinator's synchronous gate FIRST so a native fault event racing this
    // stop can't fire recover_mic while we tear down (the React isRecording
    // flip below only lands on the next render — too late for that race).
    isRecordingRef.current = false
    // Move the session token past this session so a still-in-flight setup IIFE
    // (fast stop-after-start) disposes its Deepgram service/voiceId rather than
    // publishing them into refs we're about to null — otherwise the orphaned
    // socket leaks and the NEXT meeting receives this session's transcript events.
    sessionGenerationRef.current++

    // Local engine: the sidecar finalizes its last utterance only AFTER the
    // native stop (it flushes, then the desktop emits stt://finished). So for a
    // local session, stop the native capture first and drain that tail (≤5s)
    // into the merger and the live gate — BEFORE the interim promotion and gate
    // flush below, which would otherwise promote the interim and then also take
    // the real final. Deepgram sessions keep the original order (native stop
    // further down, after the promotion).
    let earlyNativeStop: { result: RecordingResult | null; error: unknown } | null = null
    const activeService = transcriptionServiceRef.current
    if (activeService?.engine === 'local') {
      earlyNativeStop = { result: null, error: null }
      try {
        earlyNativeStop.result = await tauriBridge.stopRecording()
      } catch (err) {
        earlyNativeStop.error = err
      }
      // No tail is coming when the native stop failed — don't sit out the cap.
      await activeService.stop({ drainTail: earlyNativeStop.error === null })
    }

    // Cancel any pending coalesced interim flush — stop() flushes the merger
    // directly below, so a late timer firing would be redundant (and must not
    // run after teardown).
    if (pendingInterimFlushRef.current) {
      clearTimeout(pendingInterimFlushRef.current)
      pendingInterimFlushRef.current = null
    }

    try {
      // Promote any pending interim segments to final before flushing.
      // When the user stops mid-sentence, Deepgram hasn't finalized the last
      // utterance yet. We grab the latest interims from the merger, mark them
      // as final, and feed them to the gate so the live agent processes them.
      // MUST happen BEFORE Deepgram stops so nothing said pre-click is lost.
      const interimSegments = mergerRef.current.getTranscript().filter((s) => !s.isFinal)
      for (const seg of interimSegments) {
        const promoted: TranscriptSegment = { ...seg, isFinal: true, id: `${seg.id}-promoted` }
        mergerRef.current.addSegment(promoted)
        publishTranscriptSegments(mergerRef.current.getTranscript())
        transcriptGateRef.current?.addSegment(promoted)
      }

      // Flush any remaining transcript in the live agent gate before stopping.
      // This kicks processChunk for the final accumulated segment into the
      // background machinery (the finalizing turn we detach into Phase 2).
      transcriptGateRef.current?.flush()
      transcriptGateRef.current?.setEnabled(false)
      transcriptGateRef.current = null
      requestRecordTurnRef.current = null

      // ── Phase 2 handoff: snapshot the finalizing lifecycle, then DETACH ─────
      // The finalizing wait (up to 45s) used to sit HERE, blocking every teardown
      // below. Now we capture the shared finalizing refs LOCALLY and null the hook
      // refs immediately, so:
      //   (1) teardown proceeds without waiting, and
      //   (2) a new meeting started while this finalizes begins with a clean slate
      //       — its first chunk's `incrementInFlight` create-guard sees a null
      //       `liveAgentFinalizingPromiseRef` and mints its OWN promise, so the two
      //       meetings' finalizing lifecycles can't corrupt each other (Part D).
      // The detached IIFE below owns the captured promise/resolve to completion.
      const finalizingPromise = liveAgentFinalizingPromiseRef.current
      const finalizingResolve = liveAgentResolveRef.current
      liveAgentFinalizingPromiseRef.current = null
      liveAgentResolveRef.current = null

      // ── Phase 2: background finalizing (fire-and-forget, NOT awaited) ────────
      // Launched HERE — immediately after the snapshot, BEFORE the remaining
      // teardown — so no throw later in Phase 1 (web capture / Deepgram / VoiceID
      // / native stop) can orphan the finalizing lifecycle: the snapshot already
      // nulled the hook refs, so if this IIFE never launched, nothing would ever
      // resolve the promise. The live agent's last turn(s)
      // keep running in here; isAgentFinalizing still indicates the work. Every
      // step is guarded so a throw can't surface as an unhandled rejection.
      void (async () => {
        try {
          if (finalizingPromise) {
            setIsAgentFinalizing(true)
            onLiveAgentStatusChangeRef.current?.('finalizing')
            const FINALIZE_TIMEOUT = 45_000 // 45 seconds max wait
            await Promise.race([
              finalizingPromise,
              new Promise<void>((resolve) => setTimeout(resolve, FINALIZE_TIMEOUT)),
            ])
            setIsAgentFinalizing(false)
            // Resolve the captured promise in case of timeout — never the hook ref
            // (already nulled, and possibly owned by a NEW meeting now).
            finalizingResolve?.()
          }
        } catch (err) {
          console.warn('[useRecording] Live agent finalizing wait failed:', err)
        }
      })()

      // Stop the browser mic capture FIRST (web) so no further PCM is pushed
      // into the Deepgram connection after we close it. No-op/null on desktop.
      webCaptureRef.current?.stop()
      webCaptureRef.current = null

      // Disarm the mic first-frame watchdog before nulling the service ref: it
      // must never fire recover_mic after the meeting ended. Nulling the ref
      // below also trips the watchdog's generation check as a backstop.
      if (micWatchdogTimerRef.current) {
        clearTimeout(micWatchdogTimerRef.current)
        micWatchdogTimerRef.current = null
      }

      // Get the recording result BEFORE closing Deepgram. On desktop the native
      // `tauriBridge.stopRecording()` kills the mic/system tap — it's fast — and
      // PCM emits are batched in the Rust emitter threads (desktop
      // session.rs), so up to ~120ms of end-of-recording audio sits in their
      // accumulators at click time. The native stop joins those threads, which
      // flushes that tail through the still-armed audio listeners into the
      // still-open Deepgram socket and voice-ID feed; stopping Deepgram first
      // would unlisten + CloseStream while the tail is still in flight and clip
      // the last word. Wrap the native call so a throw still lets the UI-state
      // teardown (setIsRecording(false) etc.) run unconditionally: a failed
      // native stop must NOT leave the UI stuck "recording". `result` stays null
      // on a native throw, in which case we skip setRecordingResult but still
      // clear the recording UI.
      const webSession = webSessionRef.current
      webSessionRef.current = null
      let result: {
        sessionId: string
        micFile: string | null
        systemFile: string | null
        durationSeconds: number
      } | null = null
      let nativeStopError: unknown = null
      if (webSession) {
        result = {
          sessionId: webSession.sessionId,
          micFile: null,
          systemFile: null,
          durationSeconds: Math.max(0, Math.round((Date.now() - webSession.startedAtMs) / 1000)),
        }
      } else if (earlyNativeStop) {
        // A local session already stopped natively (and drained) above.
        result = earlyNativeStop.result
        nativeStopError = earlyNativeStop.error
      } else {
        try {
          result = await tauriBridge.stopRecording()
        } catch (err) {
          nativeStopError = err
        }
      }

      void transcriptionServiceRef.current?.stop()
      transcriptionServiceRef.current = null

      // Clean up auto-accept timers
      for (const timer of autoAcceptTimers.current.values()) {
        clearInterval(timer)
      }
      autoAcceptTimers.current.clear()

      // Collect Voice ID assignments before stopping
      const voiceId = voiceIdRef.current
      const assignments = voiceId?.getAssignments() || []
      // A confirm that was short of samples: post the voice's samples since (issue 24).
      const learn = selfLearnAtStop(voiceId, pendingSelfLearnRef.current)
      pendingSelfLearnRef.current = null
      if (learn) {
        void postSelfConfirm(learn.captureId, learn.body)
          .catch((err) => console.warn('[useRecording] self-confirm learn failed:', err instanceof Error ? err.message : err))
      }
      voiceId?.stop()
      voiceIdRef.current = null
      setVoiceIdReady(false)

      // Unconditionally clear the recording UI (finally-style guarantee): even if
      // the native stop threw, the mic tap is dead / dying and the UI must not stay
      // "recording". setIsRecording(false) also unsubscribes the audio-level
      // listener effect, which is what makes the waveform zeroing below stick.
      setIsRecording(false)
      setIsPaused(false)
      isPausedRef.current = false
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      publishLevels({ micLevel: 0, systemLevel: 0, timestamp: 0 })

      // A native stop that threw: surface it (as the catch below would have) but
      // the UI is already cleaned up. No recordingResult to set.
      if (nativeStopError) {
        const msg = nativeStopError instanceof Error ? nativeStopError.message : String(nativeStopError)
        console.error('[useRecording] stop failed:', msg)
        setRecordingError(msg)
        return
      }
      // Non-null past this point (web-synthesized or native result).
      if (!result) return
      setRecordingResult({
        sessionId: result.sessionId,
        micFile: result.micFile,
        systemFile: result.systemFile,
        durationSeconds: result.durationSeconds,
      })

      // Persist voice enrollments in background — HUMAN-CONFIRMED speakers
      // only (manual assignment or an explicitly accepted suggestion).
      // Auto-matches must never enroll or confirm themselves: one wrong
      // auto-match would train the system on the wrong person's voice and
      // every future session would compound the error.
      if (assignments.length > 0) {
        const humanConfirmed = assignments.filter((a) => a.shouldConfirm)
        const enrollmentsToSave = humanConfirmed.flatMap((a) =>
          a.embeddings.map((embedding) => ({
            contact_id: a.contactId,
            embedding,
            session_id: result.sessionId,
          })),
        )
        // One confirmation per contact — merged speaker labels must not
        // double-increment trust for the same person.
        const confirmationsToSave = Array.from(
          new Set(humanConfirmed.map((a) => a.contactId)),
        ).map((contactId) => ({ contact_id: contactId }))

        // Send even with zero embeddings — a manual assignment is a trust
        // confirmation regardless of whether clean audio was captured.
        if (enrollmentsToSave.length > 0 || confirmationsToSave.length > 0) {
          fetch('/api/account/voice-enrollments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enrollments: enrollmentsToSave,
              confirmations: confirmationsToSave,
            }),
          }).catch((err) => console.warn('[useRecording] Failed to save voice enrollments:', err))
        }

        // NOTE: speaker assignments are persisted by the RecordingProvider
        // (stopRecordingWithCapture) under the real DB capture id. We intentionally
        // do NOT POST them here — result.sessionId is Tauri's random session UUID,
        // not the capture id, so that endpoint would always no-op ({skipped:true}).

        // Auto-assigned speakers (silent auto-assign or countdown expiry) go
        // to post-session review with their embeddings HELD — saved only if
        // the user confirms or reassigns them below.
        const autoAssigned = assignments
          .filter((a) => !a.shouldConfirm)
          .map((a) => ({
            speakerId: a.speakerId,
            contactId: a.contactId,
            contactName: a.contactName,
            confidence: a.confidence,
            trustTier: a.trustTier ?? ('unrecognized' as TrustTier),
            speakingDurationSec: a.speakingDurationSec,
            embeddings: a.embeddings,
          }))
        if (autoAssigned.length > 0) {
          setPostSessionReview({ sessionId: result.sessionId, autoAssigned })
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[useRecording] stop failed:', msg)
      setRecordingError(msg)
    }
    // publishLevels/publishTranscriptSegments are identity-stable useCallbacks
    // (deps []) — listed to satisfy exhaustive-deps; stopRecording stays
    // identity-stable.
  }, [publishLevels, publishTranscriptSegments])

  /**
   * Clear the session accumulators once a stopped capture's data has been fully
   * consumed (incident hotfix H3). They used to survive until the NEXT
   * startRecording, retaining the full per-word segment arrays + the
   * TranscriptMerger's parallel copy + the activity feed (~4–8MB after a 1.5h
   * call) for as long as the app sat idle post-meeting.
   *
   * Called by the provider from stopRecordingWithCapture's tail (and discard),
   * strictly AFTER the final transcript force-save and voice-ID collection have
   * read the segments. Deliberately NOT part of stopRecording() itself: stop's
   * Phase-1 teardown runs BEFORE the provider's final force-save, which still
   * reads the snapshot.
   *
   * ── The post-stop transcript-pane CONTRACT (read this before changing it) ──
   * On STOP the live segment ARRAY is deliberately KEPT (as `main` did) —
   * emptied only of its heavy per-word payloads. This is load-bearing for the
   * UI: `useDisplayTranscriptSegments` (live-capture-header.tsx) falls back to
   * the capture row's PERSISTED transcript the instant `liveSegments` is empty,
   * and that row is only refreshed by the panel's one-shot `loadTranscript()`,
   * which can resolve against a pre-final-save row. Emptying the array here
   * therefore opened a window — permanent for the panel's lifetime — where the
   * transcript pane rendered blank or truncated even though the DB row was
   * correct. Keeping the text-bearing segments makes the clear SAFE regardless
   * of when (or whether) the panel's transcript fetch lands: the pane always has
   * the meeting's real text from memory, and the persisted copy simply takes
   * over on the next mount.
   *
   * The memory win is still realized. The retained bytes were dominated by the
   * per-word arrays ({word,start,end,confidence,speaker} per word — ~1.5–2.5MB
   * for a 1.5h call) plus the merger's PARALLEL copy of the same segments; both
   * are released here. What survives is the ~0.5–1MB of `[speaker] text` the
   * pane is actually painting — the same order of magnitude as the persisted
   * transcript string it would otherwise have to hold instead. `words: []` is a
   * first-class segment shape already (parseTranscriptText mints exactly that
   * for persisted text) and nothing reads `words` after stop — voice-ID's only
   * reader (`onFinalSegment`) runs during the recording, and stop collects its
   * assignments before this is ever called.
   *
   * `dropSegments` (discard only) additionally empties the array: the capture
   * row is DELETED on that path, the panel navigates away, and no post-stop
   * reader exists — so there is nothing to keep the text for.
   *
   * The derived finalSegmentCount/detectedSpeakers stores are left untouched on
   * both paths: the post-stop header still renders the speaker pills (including
   * the post-session review affordance, which keys off detectedSpeakers) until
   * the next start resets everything via publishTranscriptSegments([]).
   */
  const clearSessionAccumulators = useCallback((options?: { dropSegments?: boolean }) => {
    // A stray coalesced interim flush must never republish the just-cleared
    // merger (stop already cancels this timer; belt-and-suspenders for the
    // discard path, which doesn't).
    if (pendingInterimFlushRef.current) {
      clearTimeout(pendingInterimFlushRef.current)
      pendingInterimFlushRef.current = null
    }
    // Rewrite the segments store directly (NOT via publishTranscriptSegments,
    // which would also zero the derived speaker signals — see the scope note).
    // releaseSessionSegments owns the keep-text/strip-words decision.
    transcriptSegmentsRef.current = releaseSessionSegments(
      transcriptSegmentsRef.current,
      options?.dropSegments,
    )
    transcriptSegmentsListenersRef.current.forEach((cb) => cb())
    mergerRef.current.clear()
    publishAgentActivity([])
  }, [publishAgentActivity])

  const pauseRecording = useCallback(() => {
    setIsPaused(true)
    isPausedRef.current = true
    // Pause the elapsed timer
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    publishLevels({ micLevel: 0, systemLevel: 0, timestamp: 0 })
  }, [publishLevels])

  const resumeRecording = useCallback(() => {
    setIsPaused(false)
    isPausedRef.current = false
    // Restart the elapsed timer
    timerRef.current = setInterval(() => publishElapsed(elapsedRef.current + 1), 1000)
  }, [publishElapsed])

  // The user says which voice is theirs ("This is me", or ✓/✕ on "Is this
  // you?"). POSTs /self-confirm with the voice's embeddings so the server
  // binds the self row and the user's profile learns from meeting audio, as an
  // attendee's does (followups issue 11).
  const confirmSelf = useCallback(async (speakerId: string) => {
    const captureId = captureIdRef.current
    if (!captureId) return
    const voiceId = voiceIdRef.current
    const embeddings = voiceId?.getSelfEmbeddings(speakerId) ?? []
    // The session's self binding is settled: no voice grant or suggestion fires after it.
    voiceId?.confirmSelfLabel(speakerId)
    // Short of samples (an early confirm, or Voice ID still loading): the
    // voice keeps being sampled and the stop posts the rest (issue 24).
    pendingSelfLearnRef.current =
      embeddings.length < MAX_SELF_TOPUP_EMBEDDINGS ? { captureId, label: speakerId, posted: embeddings.length } : null
    selfBindingRequestedForRef.current = captureId
    setSelfSuggestion(null)
    // One voice is the user's: "You" moves to this label from any other.
    setSpeakerNames((prev) => {
      const next: Record<string, string> = {}
      for (const [label, name] of Object.entries(prev)) if (name !== 'You') next[label] = name
      next[speakerId] = 'You'
      return next
    })
    setSpeakerContacts((prev) => {
      if (!prev[speakerId]) return prev
      const next = { ...prev }
      delete next[speakerId]
      return next
    })
    // The confirmed label shows "You"; the default local_1 stops doing so when it is another voice.
    setSelfDemotedLabels((prev) => {
      const next = new Set(prev)
      next.delete(speakerId)
      if (speakerId !== 'local_1') next.add('local_1')
      return next
    })
    try {
      const res = await postSelfConfirm(captureId, { speaker_label: speakerId, decision: 'mine', embeddings })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[useRecording] self-confirm failed:', err instanceof Error ? err.message : err)
      toast.error('Could not save that this is you', { description: 'Your voice was not linked to this recording.' })
    }
  }, [])

  const dismissSelf = useCallback((speakerId: string) => {
    voiceIdRef.current?.dismissSelfSuggestion(speakerId)
    if (pendingSelfLearnRef.current?.label === speakerId) pendingSelfLearnRef.current = null
    setSelfSuggestion((prev) => (prev?.speakerId === speakerId ? null : prev))
    const captureId = captureIdRef.current
    // Undo a binding the server may hold on this voice (e.g. the one-voice position rule).
    if (captureId) {
      void postSelfConfirm(captureId, { speaker_label: speakerId, decision: 'not_mine' }).catch(() => {})
    }
  }, [])

  // Voice ID actions exposed to UI
  const acceptSuggestion = useCallback((speakerId: string) => {
    const timer = autoAcceptTimers.current.get(speakerId)
    if (timer) { clearInterval(timer); autoAcceptTimers.current.delete(speakerId) }
    voiceIdRef.current?.acceptSuggestion(speakerId)
    setSpeakerContacts((prev) => {
      const contact = prev[speakerId]
      if (!contact?.isSuggestion) return prev
      return { ...prev, [speakerId]: { ...contact, isSuggestion: false, isAutoMatched: false } }
    })
    setSpeakerContacts((prev) => {
      const contact = prev[speakerId]
      if (!contact) return prev
      setSpeakerNames((names) => ({ ...names, [speakerId]: contact.contactName }))
      return prev
    })
  }, [])

  const dismissSuggestion = useCallback((speakerId: string) => {
    const timer = autoAcceptTimers.current.get(speakerId)
    if (timer) { clearInterval(timer); autoAcceptTimers.current.delete(speakerId) }
    voiceIdRef.current?.dismissSuggestion(speakerId)
    setSpeakerContacts((prev) => {
      const next = { ...prev }
      delete next[speakerId]
      return next
    })
  }, [])

  const assignContact = useCallback((speakerId: string, contactId: string, contactName: string) => {
    // Picking your own contact is "This is me": your voice binds your self row
    // and your own profile, never an attendee link or a contact voiceprint.
    if (voiceIdRef.current?.isSelfContact(contactId)) {
      void confirmSelf(speakerId)
      return
    }
    // The confirmed voice is someone else's after all: the stop learns nothing from it.
    if (pendingSelfLearnRef.current?.label === speakerId) pendingSelfLearnRef.current = null
    const result = voiceIdRef.current?.assignContact(speakerId, contactId, contactName)

    if (result?.merged) {
      // Same contact was already on another speaker — merge them.
      // Relabel the secondary speaker's transcript segments to the primary.
      const primaryId = result.primarySpeakerId
      publishTranscriptSegments((prev) =>
        prev.map((seg) =>
          seg.speaker === speakerId ? { ...seg, speaker: primaryId } : seg,
        ),
      )
      // Clean up the secondary speaker from state
      setSpeakerContacts((prev) => {
        const next = { ...prev }
        delete next[speakerId]
        return next
      })
      setSpeakerNames((prev) => {
        const next = { ...prev }
        delete next[speakerId]
        return next
      })
      console.log(`[useRecording] Merged speaker ${speakerId} into ${primaryId} (same contact: ${contactName})`)
      return
    }

    if (!voiceIdRef.current) {
      setSpeakerContacts((prev) => ({
        ...prev,
        [speakerId]: { contactId, contactName, confidence: 1.0, isAutoMatched: false },
      }))
      setSpeakerNames((prev) => ({ ...prev, [speakerId]: contactName }))
    }
    // publishTranscriptSegments (used by the merge relabel above) is an
    // identity-stable useCallback (deps []) — listed to satisfy exhaustive-deps.
  }, [publishTranscriptSegments, confirmSelf])

  const unlinkSpeaker = useCallback((speakerId: string) => {
    setSpeakerContacts((prev) => {
      const next = { ...prev }
      delete next[speakerId]
      return next
    })
    setSpeakerNames((prev) => {
      const next = { ...prev }
      delete next[speakerId]
      return next
    })
  }, [])

  const renameSpeaker = useCallback((speakerId: string, name: string) => {
    if (name) {
      setSpeakerNames((prev) => ({ ...prev, [speakerId]: name }))
    } else {
      setSpeakerNames((prev) => {
        const next = { ...prev }
        delete next[speakerId]
        return next
      })
    }
  }, [])

  const getEmbeddingCount = useCallback((speakerId: string) => {
    return voiceIdRef.current?.getEmbeddingCount(speakerId) || 0
  }, [])

  const removeFromPostSessionReview = useCallback((speakerId: string) => {
    setPostSessionReview((prev) => {
      if (!prev) return null
      const remaining = prev.autoAssigned.filter((a) => a.speakerId !== speakerId)
      return remaining.length > 0 ? { ...prev, autoAssigned: remaining } : null
    })
  }, [])

  /** Put an entry back after its save failed: it holds the only copy of the
   *  session's embeddings for that speaker, so dropping it loses them. */
  const restoreToPostSessionReview = useCallback((review: NonNullable<typeof postSessionReview>, entry: NonNullable<typeof postSessionReview>['autoAssigned'][number]) => {
    setPostSessionReview((prev) => {
      if (prev && prev.sessionId !== review.sessionId) return prev
      const base = prev ?? { ...review, autoAssigned: [] }
      if (base.autoAssigned.some((a) => a.speakerId === entry.speakerId)) return base
      return { ...base, autoAssigned: [...base.autoAssigned, entry] }
    })
    toast.error('Couldn’t save the voice review. Try again.')
  }, [])

  /**
   * User confirmed an auto-assignment in post-session review — NOW the held
   * embeddings become enrollments and the contact earns a confirmation.
   */
  const confirmPostSessionSpeaker = useCallback(async (speakerId: string) => {
    const entry = postSessionReview?.autoAssigned.find((a) => a.speakerId === speakerId)
    if (!postSessionReview || !entry) return
    removeFromPostSessionReview(speakerId)
    if (entry.embeddings.length > 0) {
      try {
        const res = await fetch('/api/account/voice-enrollments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enrollments: entry.embeddings.map((embedding) => ({
              contact_id: entry.contactId,
              embedding,
              session_id: postSessionReview.sessionId,
            })),
            confirmations: [{ contact_id: entry.contactId }],
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch {
        console.warn('[useRecording] Failed to save confirmed voice enrollment')
        restoreToPostSessionReview(postSessionReview, entry)
      }
    }
  }, [postSessionReview, removeFromPostSessionReview, restoreToPostSessionReview])

  /**
   * User said an auto-assignment was the wrong person and picked the right
   * contact: penalize the wrong contact's trust AND teach the right one —
   * the held embeddings enroll under the correct contact with a confirmation.
   */
  const reassignPostSessionSpeaker = useCallback(async (speakerId: string, rightContactId: string, rightContactName: string) => {
    const entry = postSessionReview?.autoAssigned.find((a) => a.speakerId === speakerId)
    if (!postSessionReview || !entry) return
    removeFromPostSessionReview(speakerId)

    // Update the visible speaker link to the corrected contact
    setSpeakerContacts((prev) => ({
      ...prev,
      [speakerId]: { contactId: rightContactId, contactName: rightContactName, confidence: 1.0, isAutoMatched: false },
    }))
    setSpeakerNames((prev) => ({ ...prev, [speakerId]: rightContactName }))

    let saved = true
    try {
      const res = await fetch(`/api/account/voice-enrollments/${entry.contactId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: postSessionReview.sessionId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      console.warn('[useRecording] Failed to apply trust penalty')
      saved = false
    }
    if (entry.embeddings.length > 0) {
      try {
        const res = await fetch('/api/account/voice-enrollments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enrollments: entry.embeddings.map((embedding) => ({
              contact_id: rightContactId,
              embedding,
              session_id: postSessionReview.sessionId,
            })),
            confirmations: [{ contact_id: rightContactId }],
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch {
        console.warn('[useRecording] Failed to save corrected voice enrollment')
        saved = false
      }
    }
    if (!saved) restoreToPostSessionReview(postSessionReview, entry)
  }, [postSessionReview, removeFromPostSessionReview, restoreToPostSessionReview])

  /** Apply trust penalty and remove a speaker from the post-session review */
  const correctPostSessionSpeaker = useCallback(async (speakerId: string, wrongContactId: string) => {
    if (!postSessionReview) return
    // Apply trust penalty to the wrong contact
    try {
      const res = await fetch(`/api/account/voice-enrollments/${wrongContactId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: postSessionReview.sessionId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      console.warn('[useRecording] Failed to apply trust penalty')
      // Keep the entry so the correction can be retried.
      toast.error('Couldn’t save the voice review. Try again.')
      return
    }
    removeFromPostSessionReview(speakerId)
  }, [postSessionReview, removeFromPostSessionReview])

  const dismissPostSessionReview = useCallback(() => {
    setPostSessionReview(null)
  }, [])

  // NOTE: finalSegmentCount + detectedSpeakers are derived inside
  // publishTranscriptSegments (deriveTranscriptSignals) on each publish. They
  // live in ref-backed external stores that notify only when the derived value
  // actually changes — so interim flushes (the ~150ms hot path, which add no
  // finals/speakers) never wake anyone. There are no useState mirrors of them
  // (nor of agentActivity): consumers read all four through the leaf hooks.

  return {
    // State
    isRecording,
    isPaused,
    // Audio levels + elapsed are NOT returned as state — they update at audio-
    // frame rate and would re-render every consumer of the hook (and the whole
    // RecordingContext) ~10×/s. Consumers read them via the external-store
    // accessors below (getLevels/subscribeLevels, getElapsed/subscribeElapsed),
    // wired to leaf components through useSyncExternalStore so only the waveform
    // / timer readout re-paints per frame.
    getLevels,
    subscribeLevels,
    getElapsed,
    subscribeElapsed,
    // Transcript segments are ALSO an external store now (see the store note near
    // the declaration) — NOT returned as a state array, so a re-publish doesn't
    // re-render the hook / full context. Consumers read the live array via the
    // useTranscriptSegments() leaf hook (useSyncExternalStore over these), and the
    // provider's own save/beacon logic pulls the current value via the snapshot.
    getTranscriptSegmentsSnapshot,
    subscribeTranscriptSegments,
    // Derived transcript signals + agent activity as external stores (audit
    // finding 7) — read at the leaf via useFinalSegmentCount() /
    // useDetectedSpeakers() / useAgentActivity() in recording-context.tsx.
    getFinalSegmentCount,
    subscribeFinalSegmentCount,
    getDetectedSpeakers,
    subscribeDetectedSpeakers,
    getAgentActivity,
    subscribeAgentActivity,
    // Voice ID auto-accept countdown ticks — read at the chip via
    // useAutoAcceptCountdown() in recording-context.tsx.
    getAutoAcceptTick,
    subscribeAutoAcceptTicks,
    recordingError,
    recordingResult,
    systemAudioStatus,
    transcriptionStatus,
    postSessionReview,
    speakerNames,
    speakerContacts,
    selfDemotedLabels,
    selfSuggestion,
    voiceIdReady,
    isAgentFinalizing,

    // Actions
    startRecording,
    stopRecording,
    requestRecordTurn,
    clearSessionAccumulators,
    pauseRecording,
    resumeRecording,
    acceptSuggestion,
    dismissSuggestion,
    assignContact,
    confirmSelf,
    dismissSelf,
    unlinkSpeaker,
    renameSpeaker,
    getEmbeddingCount,
    confirmPostSessionSpeaker,
    reassignPostSessionSpeaker,
    correctPostSessionSpeaker,
    dismissPostSessionReview,
  }
}
