/**
 * On-device transcription — the desktop's opt-in "Local transcription" module
 * (`local-stt`, NeMo-Speech.cpp). See docs/plans/local-modules.md §1.6 / §2.4.
 *
 * Rust owns inference: audio goes from the native capture straight into the
 * sidecar and never round-trips through the WebView. What reaches us is
 * Deepgram-shaped JSON over `stt://message`, so this service runs it through
 * the same parser the Deepgram WebSocket uses and produces identical
 * TranscriptSegments — `local_N` / `remote_N` speakers, stream audio-clock
 * times — so the live transcript, TranscriptGate, Voice ID and persistence
 * downstream don't know which engine ran.
 *
 * Cost: local transcription is free and unlimited. This service never mints a
 * Deepgram token (so the STT usage gate never applies) and never POSTs
 * /api/ai/log-transcription (no ai_usage_logs row, no credits). It only emits
 * the PostHog `local_transcription_completed` event on stop.
 *
 * Lifecycle (the order matters — the contract requires subscribing BEFORE
 * start_recording so an early engine-changed is never missed):
 *
 *   const prep = await prepareLocalTranscription(onSegment, onFinalSegment)
 *   const session = await tauriBridge.startRecording({ ..., transcription: prep.service ? 'local' : undefined })
 *   session.transcriptionEngine === 'local'
 *     ? prep.service.start(session.sessionId)
 *     : prep.service.stop({ drainTail: false })
 *   prep.service.setFallbackHandler((reason, phase) => …start Deepgram for the rest…)
 *   …
 *   await tauriBridge.stopRecording(); await prep.service.stop()   // drains the tail
 *
 * Session identity: every stt:// payload names its recording session. Events
 * that arrive before start(sessionId) are buffered, then replayed if they are
 * this session's and dropped otherwise; after that, another session's events
 * are dropped on arrival. A previous recording's late finals, `finished` or
 * `engine-changed` (e.g. a WebView reload that stops a stale session right
 * before this one attaches) can therefore never leak into this one.
 */

import {
  createSegmentIdFactory,
  dispatchDeepgramMessage,
  type OnSegmentCallback,
  type OnVadCallback,
  type TranscriptionService,
  type TranscriptionStatus,
  type TranscriptSegment,
} from './deepgram-stream'
import {
  tauriBridge,
  type SttEngineChangedPayload,
  type SttFinishedPayload,
  type SttMessagePayload,
} from './tauri-bridge'
import { trackRecordingEvent } from './recording-telemetry'
import { getLocalModule, isLocalModuleUsable, LOCAL_STT_MODULE_ID } from './local-modules'

/** Longest stop() keeps listening for the transcript tail. After a stop the
 *  desktop emits `stt://finished` once the sidecar has flushed its last
 *  utterance (immediately if the recording stopped before the engine finished
 *  loading); if the engine fails instead it emits `stt://engine-changed`,
 *  which also ends the wait. This cap only guards a desktop that sends
 *  neither. */
export const LOCAL_STT_FINISH_TIMEOUT_MS = 5_000

/** stt:// events held between attach() and start(sessionId) — normally a
 *  handful of milliseconds; the cap only bounds a start that never comes. */
const MAX_BUFFERED_EVENTS = 1_000

/** 16 kHz mono Int16 PCM — the audio:// payload format. */
const PCM_BYTES_PER_SECOND = 16_000 * 2

type Stream = 'mic' | 'system'

/** Where a fallback to Deepgram happened: 'start' = the local engine never
 *  produced output (declined by the desktop, or failed while loading);
 *  'mid_session' = it failed after transcript results had flowed. */
export type LocalFallbackPhase = 'start' | 'mid_session'

/** One stt:// event, held until the session it belongs to is known. */
type SttEvent =
  | { kind: 'message'; payload: SttMessagePayload | null | undefined }
  | { kind: 'engine-changed'; payload: SttEngineChangedPayload | null | undefined }
  | { kind: 'finished'; payload: SttFinishedPayload | null | undefined }

/** Toast copy for a fallback (the user opted into local, so say so). */
export function localFallbackMessage(phase: LocalFallbackPhase): string {
  return phase === 'mid_session'
    ? 'Local transcription stopped — switched to cloud transcription.'
    : "Local transcription isn't available right now — using cloud transcription."
}

/** Fire the `local_transcription_fallback` analytics event. */
export function trackLocalFallback(
  reason: string,
  phase: LocalFallbackPhase,
  extra: Record<string, string | number | boolean | null> = {},
): void {
  trackRecordingEvent('local_transcription_fallback', { ...extra, reason, phase })
}

/**
 * Shift a segment onto a later clock. A Deepgram fallback connection starts
 * its clock at 0, while the local engine's segments already cover the session
 * so far; offsetting the fallback's segments by the local audio clock keeps
 * the merged transcript chronological (TranscriptMerger sorts by startTime)
 * and keeps Voice ID's ring-buffer lookups on the same clock. Returns the same
 * object when there is nothing to shift.
 */
export function shiftSegmentTime(segment: TranscriptSegment, offsetSec: number): TranscriptSegment {
  if (!offsetSec) return segment
  return {
    ...segment,
    startTime: segment.startTime + offsetSec,
    endTime: segment.endTime + offsetSec,
    words: segment.words.map((w) => ({ ...w, start: w.start + offsetSec, end: w.end + offsetSec })),
  }
}

export class LocalTranscriptionService implements TranscriptionService {
  readonly engine = 'local' as const
  /** Raw PCM per stream (Voice ID ring buffers) — fed from audio://, exactly
   *  like DeepgramStreamingService's desktop listeners. */
  onAudioData?: (stream: Stream, bytes: Uint8Array) => void
  onTranscriptionStatus?: (status: TranscriptionStatus) => void

  private readonly onSegment: OnSegmentCallback
  private readonly onFinalSegment?: OnSegmentCallback
  private readonly onVad?: OnVadCallback
  private readonly moduleVersion: string | null
  private readonly nextSegmentId = {
    mic: createSegmentIdFactory('mic'),
    system: createSegmentIdFactory('system'),
  }

  /** stt:// subscriptions — kept through stop() until the tail drains. */
  private sttUnlisteners: Array<() => void> = []
  /** audio:// subscriptions — dropped the moment stop() is called. */
  private audioUnlisteners: Array<() => void> = []

  private lastAudioAt: Record<Stream, number> = { mic: 0, system: 0 }
  private audioBytes: Record<Stream, number> = { mic: 0, system: 0 }

  /** The recording session this service transcribes — set by start(). */
  private sessionId: string | null = null
  /** stt:// events received before start(); replayed or dropped by session. */
  private buffered: SttEvent[] = []
  /** Set by start(): the desktop confirmed the local engine. */
  private startedAtMs: number | null = null
  /** Set when the engine failed (freezes the telemetry clock). */
  private endedAtMs: number | null = null
  /** A `Results` message arrived for this session — the engine really ran. */
  private receivedResults = false
  private fallbackReason: string | null = null
  private fallbackPhase: LocalFallbackPhase = 'start'
  private fallbackHandler: ((reason: string, phase: LocalFallbackPhase) => void) | null = null
  private finished = false
  private settleTail: (() => void) | null = null
  private stopRequested = false
  private stopCompleted = false
  private stopPromise: Promise<void> | null = null

  constructor(
    onSegment: OnSegmentCallback,
    onFinalSegment?: OnSegmentCallback,
    onVad?: OnVadCallback,
    opts: { moduleVersion?: string | null } = {},
  ) {
    this.onSegment = onSegment
    this.onFinalSegment = onFinalSegment
    this.onVad = onVad
    this.moduleVersion = opts.moduleVersion ?? null
  }

  /**
   * Subscribe to `stt://message`, `stt://engine-changed`, `stt://finished` and
   * `audio://mic|system`. Must resolve BEFORE start_recording is invoked.
   * Throws (having undone any partial subscription) if the bridge can't
   * subscribe — the caller then records with Deepgram.
   */
  async attach(): Promise<void> {
    if (this.stopRequested) return
    const [sttResults, audioResults] = await Promise.all([
      Promise.allSettled([
        tauriBridge.onSttMessage((payload) => this.receive({ kind: 'message', payload })),
        tauriBridge.onSttEngineChanged((payload) => this.receive({ kind: 'engine-changed', payload })),
        tauriBridge.onSttFinished((payload) => this.receive({ kind: 'finished', payload })),
      ]),
      Promise.allSettled([
        tauriBridge.onAudioPcm('mic', (bytes) => this.handleAudio('mic', bytes)),
        tauriBridge.onAudioPcm('system', (bytes) => this.handleAudio('system', bytes)),
      ]),
    ])
    const stt = fulfilled(sttResults)
    const audio = fulfilled(audioResults)
    const failure = [...sttResults, ...audioResults].find((r) => r.status === 'rejected')
    if (failure) {
      for (const unlisten of [...stt, ...audio]) unlisten()
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason))
    }
    // stop() may have raced the subscriptions: honour what it already tore down.
    if (this.stopRequested) audio.forEach((unlisten) => unlisten())
    else this.audioUnlisteners.push(...audio)
    if (this.stopCompleted) stt.forEach((unlisten) => unlisten())
    else this.sttUnlisteners.push(...stt)
  }

  /**
   * start_recording answered `transcriptionEngine: 'local'` for `sessionId`
   * (its RecordingSession.sessionId): the local session is live. Binds the
   * service to that session — buffered stt:// events are replayed if they are
   * its own and dropped otherwise — starts the clock the completion event
   * reports, and reports the transcription as connected. Without start(),
   * stop() fires no analytics.
   */
  start(sessionId: string): void {
    if (this.startedAtMs !== null || this.stopRequested) return
    this.sessionId = sessionId
    this.startedAtMs = Date.now()
    this.onTranscriptionStatus?.('connected')
    console.log('[LocalTranscriptionService] Started — on-device transcription')
    const buffered = this.buffered
    this.buffered = []
    for (const event of buffered) {
      if (this.isOwnSession(event.payload)) this.handle(event)
    }
  }

  /**
   * What to do when the local engine fails: the caller starts Deepgram for the
   * rest of the session. `phase` is 'start' when the engine never produced a
   * result (it failed while loading — the desktop answers 'local' before the
   * sidecar is up), 'mid_session' once results had flowed. Fires at most once,
   * never after stop(), and replays a failure that arrived before the handler
   * was registered.
   */
  setFallbackHandler(handler: (reason: string, phase: LocalFallbackPhase) => void): void {
    this.fallbackHandler = handler
    if (this.fallbackReason !== null && !this.stopRequested) handler(this.fallbackReason, this.fallbackPhase)
  }

  /** Why the engine fell back to Deepgram, or null while it is healthy. */
  getFallbackReason(): string | null {
    return this.fallbackReason
  }

  getLastAudioAt(stream: Stream): number {
    return this.lastAudioAt[stream]
  }

  hasReceivedAudio(stream: Stream): boolean {
    return this.lastAudioAt[stream] > 0
  }

  /** Seconds of PCM seen on `stream` — the local engine's audio clock, used to
   *  place a Deepgram fallback's segments after the local ones. */
  getAudioSeconds(stream: Stream): number {
    return this.audioBytes[stream] / PCM_BYTES_PER_SECOND
  }

  /**
   * Stop. Audio listeners go immediately. The stt:// listeners stay until the
   * desktop signals `stt://finished` (the sidecar flushed its last utterance
   * after stop_recording) or LOCAL_STT_FINISH_TIMEOUT_MS passes, so the tail
   * of the transcript isn't lost — call it AFTER stop_recording and await it
   * before reading the final transcript. `drainTail: false` skips the wait
   * (the engine failed, or the native session never started).
   *
   * Never calls /api/ai/log-transcription: local transcription is free. Fires
   * `local_transcription_completed` if the local engine actually ran — not
   * for one that failed before producing any result (that session's record
   * is its `local_transcription_fallback{phase:'start'}`). Idempotent.
   */
  stop(opts: { drainTail?: boolean } = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopRequested = true

    for (const unlisten of this.audioUnlisteners) unlisten()
    this.audioUnlisteners = []

    const startedAt = this.startedAtMs
    const ran = startedAt !== null
    const neverProducedOutput = this.fallbackReason !== null && this.fallbackPhase === 'start'
    if (ran && !neverProducedOutput) {
      const endedAt = this.endedAtMs ?? Date.now()
      trackRecordingEvent('local_transcription_completed', {
        seconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
        ...(this.moduleVersion ? { module_version: this.moduleVersion } : {}),
        ...(this.fallbackReason !== null ? { fallback_reason: this.fallbackReason } : {}),
      })
    }

    const drain = opts.drainTail !== false && ran && this.fallbackReason === null && !this.finished
    const tail = drain ? this.waitForTail(LOCAL_STT_FINISH_TIMEOUT_MS) : Promise.resolve()
    this.stopPromise = tail.then(() => {
      for (const unlisten of this.sttUnlisteners) unlisten()
      this.sttUnlisteners = []
      this.stopCompleted = true
      console.log('[LocalTranscriptionService] Stopped')
    })
    return this.stopPromise
  }

  // ── Event handlers ────────────────────────────────────────────

  /** Every stt:// event enters here: buffered until the session is known,
   *  then dropped unless it is this session's. */
  private receive(event: SttEvent) {
    if (this.stopCompleted) return
    if (this.sessionId === null) {
      // Not started: hold it for start() — unless we never will start.
      if (!this.stopRequested && this.buffered.length < MAX_BUFFERED_EVENTS) this.buffered.push(event)
      return
    }
    if (this.isOwnSession(event.payload)) this.handle(event)
  }

  /** A payload without `session` is accepted (tolerance only). */
  private isOwnSession(payload: { session?: string | null } | null | undefined): boolean {
    const session = payload?.session
    return session === undefined || session === null || session === this.sessionId
  }

  private handle(event: SttEvent) {
    switch (event.kind) {
      case 'message':
        this.handleMessage(event.payload)
        break
      case 'engine-changed':
        this.handleEngineChanged(event.payload?.reason)
        break
      case 'finished':
        this.handleFinished()
        break
    }
  }

  private handleMessage(payload: SttMessagePayload | null | undefined) {
    // After a failure the Deepgram fallback owns the transcript.
    if (this.fallbackReason !== null || this.stopCompleted) return
    const stream = payload?.stream
    if (stream !== 'mic' && stream !== 'system') return
    try {
      // The contract sends the message as a JSON object; tolerate a string.
      const raw = payload?.message
      const message = typeof raw === 'string' ? JSON.parse(raw) : raw
      if ((message as { type?: unknown } | null)?.type === 'Results') this.receivedResults = true
      dispatchDeepgramMessage(message, stream, this.nextSegmentId[stream], {
        onSegment: this.onSegment,
        onFinalSegment: this.onFinalSegment,
        onVad: this.onVad,
      })
    } catch {
      // A malformed message must never break the stream (the WebSocket path
      // swallows the same way).
    }
  }

  private handleEngineChanged(reason: string | undefined) {
    if (this.fallbackReason !== null || this.stopCompleted) return
    this.fallbackReason = reason || 'unknown'
    this.fallbackPhase = this.receivedResults ? 'mid_session' : 'start'
    this.endedAtMs = Date.now()
    // No more finals are coming — a pending tail drain can end now.
    this.settleTail?.()
    console.warn(
      `[LocalTranscriptionService] Local engine stopped (${this.fallbackReason}, ${this.fallbackPhase}) — falling back`,
    )
    if (!this.stopRequested) this.fallbackHandler?.(this.fallbackReason, this.fallbackPhase)
  }

  private handleFinished() {
    this.finished = true
    this.settleTail?.()
  }

  private handleAudio(stream: Stream, payload: number[] | null | undefined) {
    if (!payload) return
    const bytes = new Uint8Array(payload)
    this.lastAudioAt[stream] = Date.now()
    this.audioBytes[stream] += bytes.byteLength
    this.onAudioData?.(stream, bytes)
  }

  private waitForTail(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = () => {
        if (timer) clearTimeout(timer)
        this.settleTail = null
        resolve()
      }
      timer = setTimeout(done, timeoutMs)
      this.settleTail = done
    })
  }
}

function fulfilled(results: PromiseSettledResult<() => void>[]): Array<() => void> {
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
}

/** Outcome of engine selection for one recording. */
export type LocalTranscriptionPrep =
  /** Local engine requested: pass `transcription: 'local'` to start_recording. */
  | { service: LocalTranscriptionService; fallbackReason: null }
  /** Use Deepgram. `fallbackReason` is set when the user wanted local but it
   *  couldn't be set up (report it); null when local wasn't asked for. */
  | { service: null; fallbackReason: string | null }

/**
 * Engine selection for a desktop recording. When the `local-stt` module is
 * enabled and ready, build a LocalTranscriptionService and attach it, so the
 * caller can invoke start_recording with `transcription: 'local'`. Any other
 * outcome — browser, a desktop without Local Modules, the module off or not
 * ready, a failed subscription — returns no service and the caller runs
 * Deepgram exactly as before. Never throws.
 */
export async function prepareLocalTranscription(
  onSegment: OnSegmentCallback,
  onFinalSegment?: OnSegmentCallback,
  onVad?: OnVadCallback,
): Promise<LocalTranscriptionPrep> {
  const info = await getLocalModule(LOCAL_STT_MODULE_ID)
  if (!isLocalModuleUsable(info)) return { service: null, fallbackReason: null }
  const service = new LocalTranscriptionService(onSegment, onFinalSegment, onVad, {
    moduleVersion: info.version || null,
  })
  try {
    await service.attach()
    return { service, fallbackReason: null }
  } catch (err) {
    console.warn('[LocalTranscriptionService] Could not subscribe to the local engine — using Deepgram:', err)
    void service.stop({ drainTail: false })
    return { service: null, fallbackReason: 'subscribe_failed' }
  }
}
