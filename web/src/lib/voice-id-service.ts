/**
 * Voice ID Service — client-side speaker identification orchestrator.
 *
 * Sits alongside DeepgramStreamingService during recording. When Deepgram
 * finalizes an utterance with speaker attribution, this service:
 *   1. Extracts the corresponding audio segment from a ring buffer
 *   2. Sends it to a Web Worker for embedding via wavlm-base-plus-sv
 *   3. Ranks the embedding against enrolled CRM contacts (multi-prototype
 *      cosine scoring with margin-based open-set rejection)
 *   4. Resolves the speaker via a sliding-window vote (see voice-id-matching.ts)
 *
 * Enrollment happens on HUMAN confirmation only: manual assignment or an
 * explicit accept of a suggestion. Auto-matches are surfaced for post-session
 * review and enroll only if the user confirms them there — an auto-match must
 * never confirm itself, otherwise one wrong match silently trains the system
 * on the wrong person's voice and compounds forever.
 */

import type { TranscriptSegment } from './deepgram-stream'
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerMatchResponse,
  WorkerEmbeddingResponse,
} from '@/workers/voice-embedding-worker'
import {
  evaluateVotes,
  sampleEmbeddingsForEnrollment,
  cosineSimilarity,
  l2Normalize,
  VOTING_WINDOW_SIZE,
  VOTING_MIN_SAMPLES,
  type MatchVote,
  type TrustTier,
} from '@/lib/voice-id-matching'
import { EMBEDDING_DIM, MAX_SELF_TOPUP_EMBEDDINGS } from '@/lib/voice-profile/types'
import {
  createSelfVoteState,
  recordSelfVote,
  selfVoteQualifies,
  ungrantSelfVote,
  SELF_DEFAULT_LABEL,
  type SelfVoteState,
} from '@/lib/voice-profile/self-verify'

// Re-exported so existing consumers (settings UI, hooks) keep their imports.
export {
  getTrustTier,
  getTrustTierLabel,
  getNextTierThreshold,
  type TrustTier,
} from '@/lib/voice-id-matching'
import { getTrustTier } from '@/lib/voice-id-matching'

// ── Types ────────────────────────────────────────────────────

/** How a speaker→contact link came to be — determines whether it may train the system. */
export type ConfirmationSource = 'manual' | 'accepted' | 'auto'

export interface SpeakerIdentification {
  contactId: string
  contactName: string
  confidence: number
  isAutoMatched: boolean
  /** Suggestion state awaiting user accept/dismiss */
  isSuggestion?: boolean
  /** Trust tier label for UI display */
  trustTier?: TrustTier
  /** Auto-accept countdown (seconds remaining) for tier 'recognizing' */
  autoAcceptCountdown?: number
  /** When that countdown runs out (epoch ms), on a copy sent to another
   *  window (the desktop HUD, lib/live-agent/voice-id-hud.ts), which counts
   *  down to it itself rather than being sent every second. */
  autoAcceptAt?: number
  /** True for learning tier matches — UI shows "Possible match: Name?" with lower certainty */
  isLearningMatch?: boolean
  /** Provenance of the link — only 'manual'/'accepted' may increment trust. */
  confirmationSource?: ConfirmationSource
}

export interface EnrolledContact {
  contactId: string
  contactName: string
  /** Unit-norm per-session prototype embeddings (server-aggregated). */
  prototypes: number[][]
  enrollmentCount: number
  /** Distinct enrollment sessions — drives the sparse-data threshold boost. */
  sessionCount: number
  confirmationCount: number
  correctionCount: number
}

export interface SpeakerAssignment {
  speakerId: string
  contactId: string
  contactName: string
  confidence: number
  isAutoMatched: boolean
  embeddings: number[][]
  /** True only for human-confirmed links — gates trust increments AND enrollment. */
  shouldConfirm: boolean
  confirmationSource: ConfirmationSource
  trustTier?: TrustTier
  speakingDurationSec: number
}

export type OnSpeakerIdentifiedCallback = (
  speakerId: string,
  contactId: string,
  contactName: string,
  confidence: number,
  isAutoMatched: boolean,
) => void

/**
 * Fired when a speaker label voice-verifies as the enrolled user (self).
 * `embeddings` are the qualifying segment embeddings the client POSTs to
 * /self-binding for server-side re-verification (the client never asserts the
 * grant on its own — the server recomputes the cosine match).
 *
 * The grant is PROVISIONAL until the server responds: the caller MUST call
 * `confirmSelfGrant()` on a 200 {granted:true} (makes the latch permanent) or
 * `resetSelfGrant()` on any failure/rejection (releases the latch + un-grants
 * the vote state so a later qualifying window can re-fire). Without those calls
 * one transient POST failure would permanently lose the binding.
 */
export type OnSelfVerifiedCallback = (
  speakerId: string,
  embeddings: number[][],
) => void

/**
 * Fired (once) when the default "You" label (local_1) should be demoted in the
 * UI — either sustained self-mismatch on local_1, or another label verified as
 * self. Display-only; the caller stops special-casing local_1 as "You".
 */
export type OnSelfDemotedCallback = (speakerId: string) => void

/**
 * Fired (once per label) when a voice is close to the user's but has not
 * verified — the caller asks "Is this you?" (followups issue 11). Never fires
 * after a grant or a confirm, nor for a label the user said is not them.
 */
export type OnSelfSuggestedCallback = (speakerId: string, similarity: number) => void

// ── Audio Ring Buffer ────────────────────────────────────────

const RING_BUFFER_SECONDS = 60
const SAMPLE_RATE = 16000

/**
 * Circular buffer storing raw PCM audio as Float32 samples.
 * Allows extracting time-ranged slices for speaker embedding.
 */
export class AudioRingBuffer {
  private buffer: Float32Array
  private writePos = 0
  private totalSamplesWritten = 0

  constructor() {
    this.buffer = new Float32Array(RING_BUFFER_SECONDS * SAMPLE_RATE)
  }

  /** Append PCM bytes (Int16 LE from Tauri) to the ring buffer. */
  write(pcmBytes: Uint8Array): void {
    // Convert Int16 LE → Float32 (-1.0 to 1.0)
    const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)
    const sampleCount = Math.floor(pcmBytes.byteLength / 2)

    for (let i = 0; i < sampleCount; i++) {
      const int16 = view.getInt16(i * 2, true) // little-endian
      this.buffer[this.writePos] = int16 / 32768.0
      this.writePos = (this.writePos + 1) % this.buffer.length
    }

    this.totalSamplesWritten += sampleCount
  }

  /**
   * Extract audio samples for a time range (seconds since first write).
   * Returns null if the range has been overwritten, or hasn't fully been
   * written yet — reading past the write head would return stale wrapped
   * samples or zeros, and an embedding of the wrong audio is far worse
   * than no embedding.
   */
  extractRange(startTimeSec: number, endTimeSec: number): Float32Array | null {
    const startSample = Math.floor(startTimeSec * SAMPLE_RATE)
    // Clamp the end to what has actually been written — Deepgram's segment
    // clock can run slightly ahead of the audio callback that fills us.
    const endSample = Math.min(Math.floor(endTimeSec * SAMPLE_RATE), this.totalSamplesWritten)
    const length = endSample - startSample

    if (length <= 0) return null

    // Check if the data is still in the buffer
    const oldestSample = Math.max(0, this.totalSamplesWritten - this.buffer.length)
    if (startSample < oldestSample) return null // Data has been overwritten

    const result = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const bufIdx = (startSample + i) % this.buffer.length
      result[i] = this.buffer[bufIdx]
    }

    return result
  }

  /** Total samples written since creation (for debugging). */
  get samplesWritten(): number {
    return this.totalSamplesWritten
  }
}

// ── Voice ID Service ─────────────────────────────────────────

const MIN_SEGMENT_DURATION = 2.0     // seconds — short segments produce noisy embeddings
/**
 * The most audio one embedding hears (seconds): a longer segment gives its
 * middle stretch. WavLM's memory grows with the square of the clip, and
 * onnxruntime's WASM heap never shrinks until the worker ends: measured in
 * WKWebView, a 60 s segment took the page to 2.2 GB for the rest of the
 * capture, while clips of 10 s or less stay ~70 MB over the loaded model. Its
 * CPU grows with the clip too (about 0.4 s of one core per second of audio).
 * A voice's embedding settles within a few seconds of speech, so a longer clip
 * buys nothing.
 */
export const MAX_EMBED_SECONDS = 8
/**
 * After each embedding the worker rests this many times as long as the
 * embedding took before it takes the next segment, so Voice ID holds at most
 * a third of one core through a meeting's continuous speech (it used to take
 * the next segment the moment it finished, i.e. a whole core for the call).
 */
export const EMBED_REST_FACTOR = 2
const SELF_LEARN_MAX_EMBEDDINGS = MAX_SELF_TOPUP_EMBEDDINGS * 3  // a confirmed voice's samples kept after the confirm
const SPEAKER_TIMEOUT_MS = 60_000    // reset window if speaker silent for 60s
const DEFAULT_AUTO_ACCEPT_DELAY = 10 // seconds — configurable via settings
const MAX_ENROLLMENT_EMBEDDINGS_PER_SPEAKER = 8
// Cap the qualifying self embeddings POSTed to /self-binding (server accepts
// 2–5; we keep the most recent, which is what accrued the grant).
const MAX_SELF_GRANT_EMBEDDINGS = 5
// After a PROVISIONAL self grant is reset (a failed/rejected /self-binding
// POST), suppress re-firing for this long so a persistently-failing server
// isn't spammed. A qualifying window must also freshly re-accrue (the vote
// state is un-granted), so this is a floor, not the sole gate.
const SELF_GRANT_RETRY_COOLDOWN_MS = 10_000

/** Auto-accept delay options for the recognizing tier. 0 = disabled (manual only). */
export type AutoAcceptDelay = 5 | 10 | 15 | 0

export class VoiceIdService {
  // Hand-off slot for the worker between preloadModel() and initialize().
  // NOT a long-lived pool any more: nothing preloads on mount, and stop()
  // terminates rather than returning the worker here, so this is only
  // non-null during the in-flight window of the preload that initialize()
  // itself kicks off. Nothing outside this class parks a worker here — stop()
  // and a stopped-during-preload initialize() both terminate whatever they
  // find in the slot.
  private static preloadedWorker: Worker | null = null
  private static preloadComplete = false
  private static preloadPromise: Promise<void> | null = null

  /**
   * Clear all cached model files from IndexedDB and reset preload state.
   * The next preloadModel() call will re-download from scratch.
   */
  static async clearModelCache(): Promise<void> {
    // Terminate any preloaded worker
    VoiceIdService.preloadedWorker?.terminate()
    VoiceIdService.preloadedWorker = null
    VoiceIdService.preloadComplete = false
    VoiceIdService.preloadPromise = null

    // Transformers.js caches models in IndexedDB under "transformers-cache"
    // and also uses Cache API. Clear both.
    const dbNames = await indexedDB.databases?.() || []
    for (const db of dbNames) {
      if (db.name && (db.name.includes('transformers') || db.name.includes('onnx'))) {
        indexedDB.deleteDatabase(db.name)
        console.log(`[VoiceId] Deleted IndexedDB: ${db.name}`)
      }
    }

    // Also clear Cache API entries (Transformers.js v3 uses this)
    const cacheNames = await caches.keys()
    for (const name of cacheNames) {
      if (name.includes('transformers') || name.includes('onnx')) {
        await caches.delete(name)
        console.log(`[VoiceId] Deleted Cache: ${name}`)
      }
    }

    console.log('[VoiceId] Model cache cleared — will re-download on next preload')
  }

  /**
   * Load the embedding model in a Web Worker (~100MB on first run, then
   * cached in IndexedDB). Safe to call multiple times — only loads once.
   *
   * Do NOT call this on mount. It is invoked by initialize() at recording
   * start; every other caller was a mount-time eager load that pulled the
   * model for sessions that never recorded.
   */
  static preloadModel(): Promise<void> {
    if (VoiceIdService.preloadComplete) return Promise.resolve()
    if (VoiceIdService.preloadPromise) return VoiceIdService.preloadPromise

    VoiceIdService.preloadPromise = new Promise<void>((resolve) => {
      const worker = new Worker(
        new URL('../workers/voice-embedding-worker.ts', import.meta.url),
        { type: 'module' },
      )

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === 'loaded') {
          VoiceIdService.preloadedWorker = worker
          VoiceIdService.preloadComplete = true
          console.log('[VoiceId] Model preloaded and cached')
          resolve()
        }
        if (event.data.type === 'error') {
          console.warn('[VoiceId] Model preload failed:', (event.data as any).error)
          worker.terminate()
          VoiceIdService.preloadPromise = null // Allow retry
          resolve() // Don't block — preload is best-effort
        }
      }

      worker.postMessage({ type: 'load' })
    })

    return VoiceIdService.preloadPromise
  }

  // Audio ring buffers (one per audio stream)
  private micBuffer = new AudioRingBuffer()
  private systemBuffer = new AudioRingBuffer()

  // Web Worker
  private worker: Worker | null = null
  // Latched by stop(). Load-bearing for the in-flight case: stop() can be
  // called while initialize() is still awaiting the preload promise, when
  // this.worker is still null and there is nothing to terminate. Without this
  // flag the late-resolving initialize() would claim the freshly-loaded worker
  // onto an already-stopped service — a live ~100MB worker with no handle that
  // nothing will ever terminate.
  private stopped = false
  private modelLoaded = false
  private pendingCallbacks = new Map<string, (response: WorkerResponse) => void>()
  private requestCounter = 0
  private workerBusy = false  // Throttle: only one embedding at a time
  private restUntil = 0       // performance.now() before which no new embedding starts (EMBED_REST_FACTOR)

  // Enrolled contacts (loaded from DB at recording start)
  private enrollments: EnrolledContact[] = []

  // Self voice profile — unit-norm per-passage prototypes for the ENROLLED
  // USER (loaded via loadSelfProfile). null = not enrolled → self-verification
  // is inert (the match path still runs for contacts, but no self compare).
  private selfPrototypes: number[][] | null = null

  // The caller's OWN CRM contact ids (loaded with the self profile). Excluded
  // from bestContactSim so a user who enrolled themselves as a contact doesn't
  // fail the self-margin against their own contact.
  private selfContactIds = new Set<string>()

  // Per-speaker self-verification vote state (2-of-3 grant window + mismatch
  // streak). Keyed by speaker label. Only populated when a self profile exists.
  private selfVoteStates = new Map<string, SelfVoteState>()

  // Per-speaker qualifying self embeddings, held so a grant can POST them for
  // server-side re-verification. Capped implicitly by MAX_SELF_GRANT_EMBEDDINGS.
  private selfQualifyingEmbeddings = new Map<string, number[][]>()

  // Latched while a self grant is PROVISIONAL (POST in flight) or CONFIRMED —
  // blocks a second onSelfVerified fire. Set true when a label first qualifies,
  // then either made permanent by confirmSelfGrant() (server 200) or released by
  // resetSelfGrant() (POST failed/rejected) so a later window can re-fire. The
  // server-side CAS is idempotent, but this avoids a wasted round-trip.
  private selfGranted = false

  // The label whose provisional grant is awaiting server confirmation. Held so
  // resetSelfGrant() can un-grant exactly that label's vote state (a later
  // qualifying window must re-accrue before another POST).
  private provisionalSelfLabel: string | null = null

  // Earliest time (Date.now()) a new self grant may fire after a reset — a
  // cooldown so a persistently-failing /self-binding isn't spammed with POSTs.
  private selfGrantCooldownUntil = 0

  // Latched once the default "You" label has been demoted in the UI — display
  // correction is one-way for the session (re-train/remove in Settings to fix).
  private selfDemoted = false

  // Labels the user said are not them ("Is this you?" → ✕): never re-suggested.
  private selfSuggestDismissed = new Set<string>()

  // The label the user confirmed as theirs, and how many of its embeddings
  // existed at the confirm (those were posted with it). Its later segments keep
  // being embedded, for learning only, so a confirm that came before the voice
  // had any samples still teaches the profile at stop (followups issue 24).
  private selfLearnLabel: string | null = null
  private selfLearnFrom = 0

  // Per-speaker accumulated embeddings for current session
  private sessionEmbeddings = new Map<string, number[][]>()

  /**
   * Sliding window of recent match votes per speaker (each vote carries the
   * best match AND the runner-up so ambiguity is visible). Capped at
   * VOTING_WINDOW_SIZE — oldest votes drop off as new ones arrive.
   */
  private votingWindow = new Map<string, MatchVote[]>()

  // Speakers whose voting is complete — no further processing
  private votingComplete = new Set<string>()

  // Per-speaker contacts the user has dismissed — never re-suggested to that
  // speaker, and excluded from its candidate ranking so the true match can
  // still surface afterwards.
  private dismissedContacts = new Map<string, Set<string>>()

  // Resolved speakers (cached for the session — avoids re-matching)
  private resolvedSpeakers = new Map<string, SpeakerIdentification>()

  // Performance stats
  private stats = {
    modelLoadMs: 0,
    enrollmentsLoadMs: 0,
    segmentsProcessed: 0,
    segmentsSkipped: 0,
    embeddingsGenerated: 0,
    matchAttempts: 0,
    matchSuccesses: 0,
    totalEmbedTimeMs: 0,
    lastEmbedTimeMs: 0,
    minEmbedTimeMs: Infinity,
    maxEmbedTimeMs: 0,
  }

  // Configurable auto-accept delay (seconds). 0 = disabled.
  autoAcceptDelaySec: AutoAcceptDelay = DEFAULT_AUTO_ACCEPT_DELAY as AutoAcceptDelay

  // Per-speaker total speaking duration (seconds) for post-session review
  private speakerDurations = new Map<string, number>()

  // Callbacks
  onSpeakerIdentified: OnSpeakerIdentifiedCallback | null = null
  /** Fired for matches that need user confirmation (suggestion chip). */
  onSpeakerSuggested: ((
    speakerId: string,
    contactId: string,
    contactName: string,
    confidence: number,
  ) => void) | null = null
  /** Fired once when a label voice-verifies as the enrolled user (self). */
  onSelfVerified: OnSelfVerifiedCallback | null = null
  /** Fired once when the default "You" label (local_1) should be demoted. */
  onSelfDemoted: OnSelfDemotedCallback | null = null
  /** Fired once per label when a voice is close to the user's but not verified. */
  onSelfSuggested: OnSelfSuggestedCallback | null = null

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Initialize the service: always wait for the preload (whether it's
   * already done, in progress, or not started yet). Never creates a
   * duplicate worker — there's exactly one shared preload.
   */
  async initialize(): Promise<void> {
    const modelLoadStart = performance.now()

    // Ensure preload is started (no-op if already running or done)
    VoiceIdService.preloadModel()

    // Wait for the preload to finish
    await VoiceIdService.preloadPromise

    // stop() may have run while we were awaiting the preload. Claiming the
    // worker now would leave a live ~100MB worker attached to a dead service
    // with nobody left to terminate it — the exact leak this change removes.
    // Terminate it here and clear the statics so the next initialize() starts
    // a genuinely fresh preload.
    if (this.stopped) {
      VoiceIdService.preloadedWorker?.terminate()
      VoiceIdService.preloadedWorker = null
      VoiceIdService.preloadComplete = false
      VoiceIdService.preloadPromise = null
      throw new Error('Voice ID service stopped before the model finished loading')
    }

    // Take ownership of the preloaded worker
    if (VoiceIdService.preloadedWorker) {
      this.worker = VoiceIdService.preloadedWorker
      VoiceIdService.preloadedWorker = null
      // Reset preload state so stop() can re-preload for next session
      VoiceIdService.preloadComplete = false
      VoiceIdService.preloadPromise = null
      this.modelLoaded = true
      this.stats.modelLoadMs = performance.now() - modelLoadStart
      console.log(`[VoiceId] Model ready (${this.stats.modelLoadMs.toFixed(0)}ms wait)`)
    } else {
      throw new Error('Model preload failed — no worker available')
    }

    // Install the message router for embed/match responses
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data

      if ('id' in response && response.id) {
        const cb = this.pendingCallbacks.get(response.id)
        if (cb) {
          this.pendingCallbacks.delete(response.id)
          cb(response)
        }
      }

      if (response.type === 'error') {
        console.error('[VoiceId] Worker error:', response.error)
      }
    }
  }

  /**
   * Feed audio directly from the Deepgram event handler.
   * Called by the DeepgramStreamingService's Tauri listener — avoids
   * creating duplicate Tauri listeners that add main-thread overhead.
   */
  feedAudio(stream: 'mic' | 'system', pcmBytes: Uint8Array): void {
    const buffer = stream === 'mic' ? this.micBuffer : this.systemBuffer
    buffer.write(pcmBytes)
  }

  /**
   * Load enrolled voice profiles from the API and hand the gallery to the
   * worker (sent once — prototypes are too heavy to re-serialize per segment).
   */
  async loadEnrollments(): Promise<void> {
    const start = performance.now()
    try {
      const res = await fetch('/api/account/voice-enrollments')
      if (!res.ok) {
        console.warn('[VoiceId] Failed to load enrollments:', res.status)
        return
      }
      const data = await res.json()
      const raw: any[] = data.enrollments || []
      this.enrollments = raw
        .map((e) => ({
          contactId: e.contactId,
          contactName: e.contactName,
          // Prefer the multi-prototype shape; fall back to the legacy single
          // centroid so an old API response still matches (degraded).
          prototypes: Array.isArray(e.prototypes) && e.prototypes.length > 0
            ? e.prototypes
            : (Array.isArray(e.embedding) ? [e.embedding] : []),
          enrollmentCount: e.enrollmentCount ?? 0,
          sessionCount: e.sessionCount ?? 1,
          confirmationCount: e.confirmationCount ?? 0,
          correctionCount: e.correctionCount ?? 0,
        }))
        .filter((e) => e.prototypes.length > 0)
      this.stats.enrollmentsLoadMs = performance.now() - start

      this.worker?.postMessage({
        type: 'set-gallery',
        gallery: this.enrollments.map((e) => ({
          contactId: e.contactId,
          contactName: e.contactName,
          prototypes: e.prototypes,
        })),
      } satisfies WorkerRequest)

      console.log(`[VoiceId] Loaded ${this.enrollments.length} enrolled contacts in ${this.stats.enrollmentsLoadMs.toFixed(0)}ms`)
    } catch (err) {
      console.warn('[VoiceId] Error loading enrollments:', err)
    }
  }

  /**
   * Load the ENROLLED USER's own voice profile (server-built per-passage
   * prototypes) for live self-verification. Independent of loadEnrollments:
   * desktop calls both (contact matching + self), web calls only this one
   * (empty contact gallery → contact matching inert, self compare runs).
   *
   * Prototypes are re-normalized on receipt. A missing/empty profile leaves
   * selfPrototypes null so self-verification stays inert (never throws into
   * the recording path).
   */
  async loadSelfProfile(): Promise<void> {
    try {
      const res = await fetch('/api/account/voice-profile?include=prototypes')
      if (!res.ok) {
        // 401 (signed out) / 5xx — self-verification simply stays off.
        return
      }
      const data = await res.json()
      const raw: unknown = data?.prototypes
      if (!Array.isArray(raw) || raw.length === 0) return

      const protos = raw
        .filter((p): p is number[] => Array.isArray(p) && p.length === EMBEDDING_DIM)
        .map((p) => l2Normalize(p))
      if (protos.length === 0) return

      this.selfPrototypes = protos

      // The caller's own contact ids — excluded from bestContactSim so a
      // self-enrolled contact can't fail the self-margin against itself.
      const rawIds: unknown = data?.selfContactIds
      this.selfContactIds = new Set(
        Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : [],
      )

      console.log(`[VoiceId] Loaded self voice profile (${protos.length} prototypes)`)
    } catch (err) {
      console.warn('[VoiceId] Error loading self profile:', err)
    }
  }

  /** True once a self voice profile is loaded (drives web init gating). */
  hasSelfProfile(): boolean {
    return this.selfPrototypes !== null
  }

  /** Stop the service and TERMINATE its worker, releasing the model from memory. */
  stop(): void {
    // This used to hand the worker back to the static preload pool. That kept
    // the ~100MB WavLM model (plus its ORT/WASM heap) resident for the entire
    // life of the WebContent process after the first recording ever ran — a
    // contributor to the 948MB-after-7h desktop heap. Terminating releases it;
    // the weights stay in the transformers.js IndexedDB cache, so the next
    // recording pays a worker spin-up + WASM compile, not a re-download.
    // Set BEFORE the worker guard: stop() during an in-flight initialize()
    // finds this.worker still null (the preload hasn't resolved), so the flag
    // is the only thing that tells the late-resolving initialize() to
    // terminate the worker it was about to claim instead of claiming it.
    this.stopped = true

    // Clear the statics unconditionally. A terminated Worker object silently
    // no-ops every postMessage, so a static left pointing at a dead worker
    // would give the next initialize() a service that never embeds anything
    // and never errors. In today's control flow initialize() already nulls
    // preloadedWorker in the same synchronous block that assigns this.worker,
    // so this is a defensive no-op — but it costs nothing and the statics are
    // only ever a hand-off slot for the preload this service itself started.
    VoiceIdService.preloadedWorker?.terminate()
    VoiceIdService.preloadedWorker = null
    VoiceIdService.preloadComplete = false
    VoiceIdService.preloadPromise = null

    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.modelLoaded = false
    this.pendingCallbacks.clear()

    console.log('[VoiceId] Stopped (worker terminated)')
  }

  // ── Duplicate contact prevention ─────────────────────────

  /**
   * Check if a contact is already linked (assigned OR pending suggestion)
   * to a different speaker. Prevents the same person from being matched
   * or suggested twice when Deepgram splits one voice across labels, and
   * prevents two speakers racing for the same contact.
   */
  private isContactAlreadyAssigned(contactId: string, excludeSpeakerId: string): boolean {
    for (const [speakerId, identification] of this.resolvedSpeakers) {
      if (speakerId === excludeSpeakerId) continue
      if (identification.contactId === contactId) return true
    }
    return false
  }

  /** Contacts that must not be considered for a given speaker. */
  private excludedContactIdsFor(speakerId: string): string[] {
    const excluded: string[] = []
    for (const e of this.enrollments) {
      if (this.isContactAlreadyAssigned(e.contactId, speakerId)) excluded.push(e.contactId)
    }
    for (const contactId of this.dismissedContacts.get(speakerId) ?? []) {
      if (!excluded.includes(contactId)) excluded.push(contactId)
    }
    return excluded
  }

  /**
   * Merge two speakers when the user manually assigns the same contact
   * to both. The secondary speaker's embeddings are moved to the primary,
   * and the secondary is marked as resolved (pointing to the same contact).
   */
  mergeSpeakers(primarySpeakerId: string, secondarySpeakerId: string): void {
    // Move session embeddings from secondary → primary
    const secondaryEmbeddings = this.sessionEmbeddings.get(secondarySpeakerId) || []
    const primaryEmbeddings = this.sessionEmbeddings.get(primarySpeakerId) || []
    this.sessionEmbeddings.set(primarySpeakerId, [...primaryEmbeddings, ...secondaryEmbeddings])
    this.sessionEmbeddings.delete(secondarySpeakerId)

    // Merge speaking duration
    const secondaryDuration = this.speakerDurations.get(secondarySpeakerId) || 0
    const primaryDuration = this.speakerDurations.get(primarySpeakerId) || 0
    this.speakerDurations.set(primarySpeakerId, primaryDuration + secondaryDuration)
    this.speakerDurations.delete(secondarySpeakerId)

    // Mark secondary as voting-complete so it stops processing
    this.votingComplete.add(secondarySpeakerId)
    this.votingWindow.delete(secondarySpeakerId)

    console.log(`[VoiceId] Merged speaker ${secondarySpeakerId} into ${primarySpeakerId}`)
  }

  /**
   * Find the speakerId that already has a given contact assigned.
   * Returns null if no speaker has this contact.
   */
  findSpeakerForContact(contactId: string): string | null {
    for (const [speakerId, identification] of this.resolvedSpeakers) {
      if (identification.contactId === contactId && !identification.isSuggestion) {
        return speakerId
      }
    }
    return null
  }

  // ── Core matching logic ──────────────────────────────────

  /**
   * Called by DeepgramStreamingService when a final segment arrives.
   *
   * Accumulates margin-aware match votes per speaker in a sliding window
   * and resolves via evaluateVotes (see voice-id-matching.ts for the
   * decision rules). If the speaker goes unheard for 60s, the window resets.
   */
  onFinalSegment(segment: TranscriptSegment): void {
    const speakerId = segment.speaker
    const segDuration = segment.endTime - segment.startTime

    // DROP, don't queue. Segments that arrive before the model finishes loading
    // are discarded on purpose. With the mount-time preload gone the model now
    // loads at recording start, so this window is longer than it used to be —
    // but use-recording only publishes voiceIdRef.current AFTER initialize()
    // resolves, so in practice nothing reaches here until the worker is ready.
    // Worst case a speaker's first utterance or two go un-embedded; voting is a
    // sliding window over many segments, so identification just resolves a few
    // seconds later. Buffering them instead would mean holding raw audio
    // windows for an unbounded cold-load, which is the memory cost this whole
    // change exists to remove.
    if (!this.worker || !this.modelLoaded) return
    if (!segment.isFinal) return

    // Track total speaking duration per speaker (for post-session review)
    this.speakerDurations.set(speakerId, (this.speakerDurations.get(speakerId) || 0) + segDuration)

    // The user's confirmed voice keeps being embedded (learning only, no
    // votes) until it has enough samples since the confirm.
    const learningSelf =
      speakerId === this.selfLearnLabel &&
      (this.sessionEmbeddings.get(speakerId)?.length ?? 0) - this.selfLearnFrom < SELF_LEARN_MAX_EMBEDDINGS

    // Voting already completed for this speaker — skip
    if (this.votingComplete.has(speakerId) && !learningSelf) {
      this.stats.segmentsSkipped++
      return
    }

    // Already resolved (manual assignment) — skip
    if (this.resolvedSpeakers.has(speakerId)) {
      this.stats.segmentsSkipped++
      return
    }

    // Throttle: skip if the worker is still processing a previous embedding,
    // or resting after one.
    if (this.workerBusy || performance.now() < this.restUntil) {
      this.stats.segmentsSkipped++
      return
    }

    // Check segment duration — 2s minimum for reliable embeddings
    if (segDuration < MIN_SEGMENT_DURATION) {
      this.stats.segmentsSkipped++
      return
    }

    // Cross-talk gate: if Deepgram diarized words in this utterance to more
    // than one speaker, the audio window contains two voices — an embedding
    // of it belongs to no one. The segment label only reflects word[0].
    if (segment.words && segment.words.length > 0) {
      const wordSpeakers = new Set<number>()
      for (const w of segment.words) {
        if (w.speaker !== undefined) wordSpeakers.add(w.speaker)
      }
      if (wordSpeakers.size > 1) {
        this.stats.segmentsSkipped++
        return
      }
    }

    // Select the right ring buffer
    const buffer = segment.stream === 'mic' ? this.micBuffer : this.systemBuffer

    // Extract audio for this segment: its middle MAX_EMBED_SECONDS at most.
    const trim = Math.max(0, segDuration - MAX_EMBED_SECONDS) / 2
    const audio = buffer.extractRange(segment.startTime + trim, segment.endTime - trim)
    if (!audio || audio.length < SAMPLE_RATE * MIN_SEGMENT_DURATION) {
      this.stats.segmentsSkipped++
      return
    }

    // Check for 60s timeout — reset window if speaker has been silent
    const now = Date.now()
    const window = this.votingWindow.get(speakerId)
    if (window && window.length > 0) {
      const lastTimestamp = window[window.length - 1].timestamp
      if ((now - lastTimestamp) > SPEAKER_TIMEOUT_MS) {
        console.log(`[VoiceId] Speaker ${speakerId} silent for >60s — resetting vote window`)
        this.votingWindow.delete(speakerId)
      }
    }

    this.stats.segmentsProcessed++
    this.workerBusy = true

    if (learningSelf) {
      this.embedSegment(speakerId, audio)
      return
    }

    // Route through the match path whenever there's ANYTHING to compare against
    // — a contact gallery OR a self profile. With an empty gallery the worker
    // returns candidates:[] and self-verification still runs off the returned
    // embedding (the match response always carries it). Only fall back to the
    // embed-only path when there's nothing to match at all.
    if (this.enrollments.length > 0 || this.selfPrototypes) {
      this.matchSegment(speakerId, audio)
    } else {
      this.embedSegment(speakerId, audio)
    }
  }

  private matchSegment(speakerId: string, audio: Float32Array): void {
    const requestId = `match-${++this.requestCounter}`
    const sendTime = performance.now()
    this.stats.matchAttempts++

    this.pendingCallbacks.set(requestId, (response) => {
      this.workerDone(sendTime)
      if (response.type !== 'match-result') return
      const matchResponse = response as WorkerMatchResponse

      const embedMs = performance.now() - sendTime
      this.trackEmbedTime(embedMs)
      this.stats.embeddingsGenerated++

      // Always accumulate the embedding for this speaker
      this.accumulateEmbedding(speakerId, matchResponse.embedding)

      // Self-verification runs off the SAME embedding the match returned — no
      // extra worker round-trip. The candidates array is passed so evaluateSelf
      // can compute bestContactSim over NON-self candidates only (0 on an empty
      // gallery, e.g. web).
      this.evaluateSelf(
        speakerId,
        matchResponse.embedding,
        matchResponse.candidates,
      )

      const [best, runnerUp] = matchResponse.candidates
      const vote: MatchVote = {
        best: best ?? null,
        runnerUp: runnerUp ?? null,
        margin: best ? best.similarity - (runnerUp?.similarity ?? 0) : 0,
        timestamp: Date.now(),
      }

      // Push into the sliding window, capping at VOTING_WINDOW_SIZE
      const window = this.votingWindow.get(speakerId) || []
      window.push(vote)
      if (window.length > VOTING_WINDOW_SIZE) {
        window.shift() // drop oldest
      }
      this.votingWindow.set(speakerId, window)

      console.log(
        `[VoiceId] Vote ${window.length}/${VOTING_WINDOW_SIZE} for ${speakerId}: `
        + (vote.best
          ? `${vote.best.contactName} (${(vote.best.similarity * 100).toFixed(1)}%, margin ${(vote.margin * 100).toFixed(1)}%)`
          : 'no match')
        + ` in ${embedMs.toFixed(0)}ms`,
      )

      if (window.length >= VOTING_MIN_SAMPLES) {
        this.evaluateWindow(speakerId, window)
      }
    })

    // Transfer the audio buffer for zero-copy performance. The gallery
    // already lives in the worker; only pass the exclusion list.
    this.worker!.postMessage(
      {
        type: 'match',
        id: requestId,
        audio,
        excludeContactIds: this.excludedContactIdsFor(speakerId),
      } satisfies WorkerRequest,
      [audio.buffer],
    )
  }

  /**
   * Live self-verification for one segment. Compares the segment embedding
   * against the enrolled user's own prototypes and feeds the pure vote machine
   * (self-verify.ts). On a grant: hand the qualifying embeddings to the client
   * (onSelfVerified) which POSTs them for server-side re-verification, and demote
   * the default "You" label if some OTHER label was the one that verified. On a
   * sustained self-mismatch of local_1 itself: demote it.
   *
   * Inert when no self profile is loaded (un-enrolled → today's behavior).
   * Guards embedding.length === EMBEDDING_DIM before comparing (cosineSimilarity
   * silently truncates mismatched dims).
   */
  private evaluateSelf(
    speakerId: string,
    embedding: number[],
    candidates: WorkerMatchResponse['candidates'],
  ): void {
    if (!this.selfPrototypes) return
    if (embedding.length !== EMBEDDING_DIM) return

    // max cosine over the self prototypes.
    let selfSim = -1
    for (const proto of this.selfPrototypes) {
      const sim = cosineSimilarity(embedding, proto)
      if (sim > selfSim) selfSim = sim
    }

    // bestContactSim = best candidate that is NOT one of the caller's own
    // contacts. Candidates are sorted best-first, so the first non-self entry
    // is the max. Excluding self-contacts stops a user who enrolled themselves
    // as a contact from failing the self-margin against their own contact.
    let bestContactSim = 0
    for (const c of candidates) {
      if (this.selfContactIds.has(c.contactId)) continue
      bestContactSim = c.similarity
      break
    }

    const isDefaultLabel = speakerId === SELF_DEFAULT_LABEL
    const vote = { selfSim, bestContactSim }

    let state = this.selfVoteStates.get(speakerId)
    if (!state) {
      state = createSelfVoteState()
      this.selfVoteStates.set(speakerId, state)
    }

    // Hold this segment's embedding if the vote qualifies — a grant POSTs these
    // for server-side re-verification. Cap at the most recent
    // MAX_SELF_GRANT_EMBEDDINGS (server accepts 2–5). selfVoteQualifies is the
    // exact predicate the vote machine uses, so held stays in lock-step.
    if (selfVoteQualifies(vote)) {
      const held = this.selfQualifyingEmbeddings.get(speakerId) ?? []
      held.push(embedding)
      if (held.length > MAX_SELF_GRANT_EMBEDDINGS) held.shift()
      this.selfQualifyingEmbeddings.set(speakerId, held)
    }

    const result = recordSelfVote(state, vote, isDefaultLabel)

    // Close to the user's voice but not verified → "Is this you?" (once per
    // label; never once the user's voice is bound this session, never for a
    // label they said is not them).
    if (result.suggested && !this.selfGranted && !this.selfSuggestDismissed.has(speakerId)) {
      this.onSelfSuggested?.(speakerId, selfSim)
    }

    // Sustained self-mismatch on local_1 → demote its display (once).
    if (result.demoted && !this.selfDemoted) {
      this.selfDemoted = true
      console.log(`[VoiceId] Self-mismatch on ${speakerId} — demoting "You" display`)
      this.onSelfDemoted?.(speakerId)
    }

    // A label voice-verified as self → provisionally grant (once at a time).
    // The grant only becomes permanent when the caller calls confirmSelfGrant()
    // after the server confirms; a failed POST calls resetSelfGrant() and this
    // can re-fire once the cooldown elapses and a fresh window re-accrues.
    if (result.granted && !this.selfGranted) {
      // A grant transition during the post-reset cooldown must not be consumed:
      // un-latch the vote state so a fresh window re-accrues and re-fires once
      // the cooldown elapses (otherwise state.granted would stay latched and
      // the transition never recurs).
      if (Date.now() < this.selfGrantCooldownUntil) {
        ungrantSelfVote(state)
        return
      }
      this.selfGranted = true
      this.provisionalSelfLabel = speakerId
      const embeddings = (this.selfQualifyingEmbeddings.get(speakerId) ?? []).slice(
        -MAX_SELF_GRANT_EMBEDDINGS,
      )
      console.log(
        `[VoiceId] Self-verified ${speakerId} (selfSim ${(selfSim * 100).toFixed(1)}%, `
        + `${embeddings.length} embeddings) — requesting server binding`,
      )
      // If a NON-default label is the self, the default "You" is now wrong —
      // demote it too (display-only; the server binds the verified label).
      if (!isDefaultLabel && !this.selfDemoted) {
        this.selfDemoted = true
        this.onSelfDemoted?.(SELF_DEFAULT_LABEL)
      }
      this.onSelfVerified?.(speakerId, embeddings)
    }
  }

  /**
   * Confirm the provisional self grant (server responded 200 {granted:true}).
   * The latch is now permanent for the session — no further self grants fire.
   */
  confirmSelfGrant(): void {
    this.provisionalSelfLabel = null
    // selfGranted stays true (permanent latch).
  }

  /**
   * The user confirmed a label is them ("This is me", or ✓ on "Is this you?")
   * and the server bound it. Latches the session's self binding (no voice
   * grant or suggestion fires after it) and stops matching the label to a
   * contact: it is the user.
   */
  confirmSelfLabel(speakerId: string): void {
    this.selfGranted = true
    this.provisionalSelfLabel = null
    this.votingComplete.add(speakerId)
    this.resolvedSpeakers.delete(speakerId)
    this.selfLearnLabel = speakerId
    this.selfLearnFrom = this.sessionEmbeddings.get(speakerId)?.length ?? 0
  }

  /** The user said a suggested label is not them: never suggest it again. */
  dismissSelfSuggestion(speakerId: string): void {
    this.selfSuggestDismissed.add(speakerId)
    if (this.selfLearnLabel === speakerId) this.selfLearnLabel = null
  }

  /**
   * The confirmed label's embeddings from AFTER the confirm, sampled to at most
   * `max` — what the stop posts so the profile learns from a voice confirmed
   * before it had samples. Null when no label is confirmed or none came since.
   */
  takeSelfLearnEmbeddings(max: number): { label: string; embeddings: number[][] } | null {
    const label = this.selfLearnLabel
    if (!label || max <= 0) return null
    const since = (this.sessionEmbeddings.get(label) ?? []).slice(this.selfLearnFrom)
    if (since.length === 0) return null
    return { label, embeddings: sampleEmbeddingsForEnrollment(since, max) }
  }

  /**
   * A label's embeddings from this session, sampled across its segments — what
   * a confirm teaches the user's profile. Empty when none were embedded.
   */
  getSelfEmbeddings(speakerId: string): number[][] {
    return sampleEmbeddingsForEnrollment(this.sessionEmbeddings.get(speakerId) || [], MAX_SELF_TOPUP_EMBEDDINGS)
  }

  /** Whether a contact is the user's own (their member-linked contact). */
  isSelfContact(contactId: string): boolean {
    return this.selfContactIds.has(contactId)
  }

  /**
   * Release a provisional self grant after a failed/rejected /self-binding POST
   * (network/5xx/422). Un-grants the label's vote state so a LATER qualifying
   * window can re-fire, and starts a cooldown so a persistently-failing server
   * isn't spammed. Without this, one transient failure permanently loses the
   * binding (the vote machine latches `granted` and never re-fires).
   */
  resetSelfGrant(): void {
    this.selfGranted = false
    this.selfGrantCooldownUntil = Date.now() + SELF_GRANT_RETRY_COOLDOWN_MS
    const label = this.provisionalSelfLabel
    this.provisionalSelfLabel = null
    if (label) {
      const state = this.selfVoteStates.get(label)
      if (state) ungrantSelfVote(state)
      // Drop the held embeddings for that label — a re-fire re-accumulates the
      // fresh qualifying window's embeddings.
      this.selfQualifyingEmbeddings.delete(label)
    }
  }

  /**
   * Evaluate the sliding window for a speaker and apply the decision.
   * All scoring/threshold rules live in evaluateVotes (voice-id-matching.ts);
   * this method only maps the decision onto session state + callbacks.
   */
  private evaluateWindow(speakerId: string, window: MatchVote[]): void {
    const dismissed = this.dismissedContacts.get(speakerId)

    const decision = evaluateVotes(window, (contactId) => {
      // Re-check exclusions at decision time — another speaker may have
      // claimed this contact after some votes were cast.
      if (dismissed?.has(contactId)) return null
      if (this.isContactAlreadyAssigned(contactId, speakerId)) return null
      const enrollment = this.enrollments.find((e) => e.contactId === contactId)
      if (!enrollment) return null
      return {
        tier: getTrustTier(enrollment.confirmationCount),
        sessionCount: enrollment.sessionCount,
      }
    })

    if (decision.type !== 'resolve') return

    const { contactId, contactName, confidence, tier, mode } = decision
    this.votingComplete.add(speakerId)

    if (mode === 'auto') {
      this.stats.matchSuccesses++
      this.resolvedSpeakers.set(speakerId, {
        contactId, contactName, confidence,
        isAutoMatched: true, trustTier: tier,
        confirmationSource: 'auto',
      })
      this.onSpeakerIdentified?.(speakerId, contactId, contactName, confidence, true)
      console.log(`[VoiceId] Auto-assign ${speakerId} → ${contactName} (${tier}, avg ${(confidence * 100).toFixed(1)}%)`)
      return
    }

    // Suggestion — how it's presented depends on tier.
    const countdown = tier === 'recognizing' && this.autoAcceptDelaySec > 0
      ? this.autoAcceptDelaySec
      : undefined
    this.resolvedSpeakers.set(speakerId, {
      contactId, contactName, confidence,
      isAutoMatched: false, isSuggestion: true, trustTier: tier,
      autoAcceptCountdown: countdown,
      isLearningMatch: tier === 'learning' ? true : undefined,
    })
    this.onSpeakerSuggested?.(speakerId, contactId, contactName, confidence)
    console.log(
      `[VoiceId] Suggested ${speakerId} → ${contactName} (${tier}`
      + (countdown ? `, auto-accept in ${countdown}s` : '')
      + (decision.ambiguous ? ', ambiguous' : '')
      + `, avg ${(confidence * 100).toFixed(1)}%)`,
    )
  }

  private embedSegment(speakerId: string, audio: Float32Array): void {
    const requestId = `embed-${++this.requestCounter}`
    const sendTime = performance.now()

    this.pendingCallbacks.set(requestId, (response) => {
      this.workerDone(sendTime)
      if (response.type !== 'embedding') return

      const embedMs = performance.now() - sendTime
      this.trackEmbedTime(embedMs)
      this.stats.embeddingsGenerated++

      this.accumulateEmbedding(speakerId, (response as WorkerEmbeddingResponse).embedding)
      console.log(`[VoiceId] Embedded ${speakerId} in ${embedMs.toFixed(0)}ms (${(audio.length / SAMPLE_RATE).toFixed(1)}s audio)`)
    })

    this.worker!.postMessage(
      {
        type: 'embed',
        id: requestId,
        audio,
      } satisfies WorkerRequest,
      [audio.buffer],
    )
  }

  /** The worker answered (or failed) a request sent at `sendTime`: free it, then rest (EMBED_REST_FACTOR). */
  private workerDone(sendTime: number): void {
    this.workerBusy = false
    const now = performance.now()
    this.restUntil = now + (now - sendTime) * EMBED_REST_FACTOR
  }

  private accumulateEmbedding(speakerId: string, embedding: number[]): void {
    const existing = this.sessionEmbeddings.get(speakerId) || []
    existing.push(embedding)
    this.sessionEmbeddings.set(speakerId, existing)
  }

  private trackEmbedTime(ms: number): void {
    this.stats.lastEmbedTimeMs = ms
    this.stats.totalEmbedTimeMs += ms
    if (ms < this.stats.minEmbedTimeMs) this.stats.minEmbedTimeMs = ms
    if (ms > this.stats.maxEmbedTimeMs) this.stats.maxEmbedTimeMs = ms
  }

  // ── Manual CRM assignment ────────────────────────────────

  /**
   * Manually assign a speaker to a CRM contact.
   * Called when the user selects a contact from the CRM search.
   *
   * If the contact is already assigned to a different speaker, returns
   * the existing speakerId so the caller can merge them in the UI.
   */
  assignContact(speakerId: string, contactId: string, contactName: string): { merged: false } | { merged: true; primarySpeakerId: string } {
    // Check if this contact is already assigned to another speaker
    const existingSpeakerId = this.findSpeakerForContact(contactId)
    if (existingSpeakerId && existingSpeakerId !== speakerId) {
      // Merge: move secondary speaker's data into the primary
      this.mergeSpeakers(existingSpeakerId, speakerId)
      // Mark the secondary as resolved too (pointing to same contact)
      this.resolvedSpeakers.set(speakerId, {
        contactId,
        contactName,
        confidence: 1.0,
        isAutoMatched: false,
        confirmationSource: 'manual',
      })
      console.log(`[VoiceId] Manual assignment: ${speakerId} → ${contactName} (merged into ${existingSpeakerId})`)
      return { merged: true, primarySpeakerId: existingSpeakerId }
    }

    this.resolvedSpeakers.set(speakerId, {
      contactId,
      contactName,
      confidence: 1.0,
      isAutoMatched: false,
      confirmationSource: 'manual',
    })
    this.votingComplete.add(speakerId)
    this.onSpeakerIdentified?.(speakerId, contactId, contactName, 1.0, false)
    console.log(`[VoiceId] Manual assignment: ${speakerId} → ${contactName}`)
    return { merged: false }
  }

  /**
   * Accept a suggestion — promotes it to a full assignment.
   *
   * `viaTimeout: true` marks an auto-accept countdown expiring with no user
   * interaction. That is NOT a human confirmation: the link is kept for the
   * session (transcript labeling) but flagged 'auto' so it goes through
   * post-session review instead of self-confirming trust.
   */
  acceptSuggestion(speakerId: string, opts?: { viaTimeout?: boolean }): void {
    const existing = this.resolvedSpeakers.get(speakerId)
    if (!existing?.isSuggestion) return

    const viaTimeout = opts?.viaTimeout === true
    const updated: SpeakerIdentification = {
      ...existing,
      isSuggestion: false,
      isAutoMatched: viaTimeout,
      confirmationSource: viaTimeout ? 'auto' : 'accepted',
    }
    this.resolvedSpeakers.set(speakerId, updated)
    this.onSpeakerIdentified?.(speakerId, updated.contactId, updated.contactName, updated.confidence, viaTimeout)
    console.log(`[VoiceId] Suggestion ${viaTimeout ? 'auto-accepted (timeout)' : 'accepted'}: ${speakerId} → ${updated.contactName}`)
  }

  /**
   * Dismiss a suggestion — returns the chip to unresolved and RESUMES
   * matching for this speaker with the dismissed contact excluded. The
   * old behavior froze the speaker for the whole session, which meant one
   * wrong suggestion permanently blocked the true match from surfacing.
   */
  dismissSuggestion(speakerId: string): void {
    const existing = this.resolvedSpeakers.get(speakerId)
    if (!existing?.isSuggestion) return

    this.resolvedSpeakers.delete(speakerId)

    const dismissed = this.dismissedContacts.get(speakerId) ?? new Set<string>()
    dismissed.add(existing.contactId)
    this.dismissedContacts.set(speakerId, dismissed)

    // Re-open voting with a fresh window — the old votes were dominated by
    // the contact the user just rejected.
    this.votingComplete.delete(speakerId)
    this.votingWindow.delete(speakerId)

    console.log(`[VoiceId] Suggestion dismissed: ${speakerId} (excluding ${existing.contactName}, matching resumes)`)
  }

  // ── Session data for persistence ─────────────────────────

  /**
   * Get all resolved speaker→contact links for persistence.
   *
   * - 'manual' / 'accepted' (human-confirmed): shouldConfirm true — the
   *   caller saves their embeddings as enrollments and increments trust.
   * - 'auto' (auto-assign or countdown expiry): shouldConfirm false — the
   *   caller must hold these for post-session review; nothing is enrolled
   *   or confirmed unless the human approves.
   *
   * Pending (unaccepted) suggestions are excluded entirely. Embeddings are
   * downsampled to at most MAX_ENROLLMENT_EMBEDDINGS_PER_SPEAKER per
   * speaker — a long meeting must not flood a contact's voice profile
   * with one day's channel conditions.
   */
  getAssignments(): SpeakerAssignment[] {
    const results: SpeakerAssignment[] = []

    for (const [speakerId, identification] of this.resolvedSpeakers) {
      // Skip pending suggestions — user hasn't confirmed them
      if (identification.isSuggestion) continue

      const source: ConfirmationSource = identification.confirmationSource
        ?? (identification.isAutoMatched ? 'auto' : 'manual')

      results.push({
        speakerId,
        contactId: identification.contactId,
        contactName: identification.contactName,
        confidence: identification.confidence,
        isAutoMatched: identification.isAutoMatched,
        embeddings: sampleEmbeddingsForEnrollment(
          this.sessionEmbeddings.get(speakerId) || [],
          MAX_ENROLLMENT_EMBEDDINGS_PER_SPEAKER,
        ),
        shouldConfirm: source !== 'auto',
        confirmationSource: source,
        trustTier: identification.trustTier,
        speakingDurationSec: this.speakerDurations.get(speakerId) || 0,
      })
    }

    return results
  }

  /** Get total speaking duration for a speaker (seconds). */
  getSpeakerDuration(speakerId: string): number {
    return this.speakerDurations.get(speakerId) || 0
  }

  /**
   * Check if a speaker has been resolved (auto or manual).
   */
  isResolved(speakerId: string): boolean {
    return this.resolvedSpeakers.has(speakerId)
  }

  /**
   * Get the identification for a resolved speaker.
   */
  getIdentification(speakerId: string): SpeakerIdentification | null {
    return this.resolvedSpeakers.get(speakerId) || null
  }

  /**
   * Get the number of accumulated embeddings for a speaker.
   */
  getEmbeddingCount(speakerId: string): number {
    return this.sessionEmbeddings.get(speakerId)?.length || 0
  }

  /**
   * Get performance stats for the current session.
   * Call from the browser console: voiceIdRef.current.getStats()
   */
  getStats() {
    const avgEmbedMs = this.stats.embeddingsGenerated > 0
      ? this.stats.totalEmbedTimeMs / this.stats.embeddingsGenerated
      : 0

    return {
      modelLoadMs: Math.round(this.stats.modelLoadMs),
      enrollmentsLoadMs: Math.round(this.stats.enrollmentsLoadMs),
      enrolledContacts: this.enrollments.length,
      segmentsProcessed: this.stats.segmentsProcessed,
      segmentsSkipped: this.stats.segmentsSkipped,
      embeddingsGenerated: this.stats.embeddingsGenerated,
      matchAttempts: this.stats.matchAttempts,
      matchSuccesses: this.stats.matchSuccesses,
      matchRate: this.stats.matchAttempts > 0
        ? `${((this.stats.matchSuccesses / this.stats.matchAttempts) * 100).toFixed(1)}%`
        : 'N/A',
      embedding: {
        avgMs: Math.round(avgEmbedMs),
        minMs: this.stats.minEmbedTimeMs === Infinity ? 0 : Math.round(this.stats.minEmbedTimeMs),
        maxMs: Math.round(this.stats.maxEmbedTimeMs),
        lastMs: Math.round(this.stats.lastEmbedTimeMs),
      },
      ringBuffers: {
        micSamples: this.micBuffer.samplesWritten,
        systemSamples: this.systemBuffer.samplesWritten,
        micDurationSec: (this.micBuffer.samplesWritten / SAMPLE_RATE).toFixed(1),
        systemDurationSec: (this.systemBuffer.samplesWritten / SAMPLE_RATE).toFixed(1),
      },
      resolvedSpeakers: Object.fromEntries(this.resolvedSpeakers),
      votingWindows: Object.fromEntries(
        Array.from(this.votingWindow.entries()).map(([k, window]) => [k, {
          windowSize: window.length,
          votes: window.map((v) => v.best
            ? `${v.best.contactName} (${(v.best.similarity * 100).toFixed(1)}%, margin ${(v.margin * 100).toFixed(1)}%)`
            : 'no match'),
          complete: this.votingComplete.has(k),
        }]),
      ),
      perSpeakerEmbeddings: Object.fromEntries(
        Array.from(this.sessionEmbeddings.entries()).map(([k, v]) => [k, v.length]),
      ),
    }
  }
}
