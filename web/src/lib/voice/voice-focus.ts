/**
 * Voice focus: Dial8 answers the user, and people it recognises by voice;
 * a voice it doesn't know (a TV, people nearby) is ignored. The desktop hears
 * a turn by speech alone (./settings VOICE_NOISE_PROFILE), so without this any
 * voice in the room is taken as the user's.
 *
 * HOW. A session started with `speechAudio` (voice_status `speechAudio`)
 * sends each run of speech's first 8 s as `voice://speech` chunks, then a
 * closing event; a run that became a turn closes before that turn's
 * `voice://turn`. A run is the whole stretch the desktop timed (from a little
 * before the onset to the end of the turn, the trailing pause included), so
 * on the close its VOICED span is found first (findVoiced: 20 ms frames above
 * an adaptive level, short gaps bridged); its length is what MIN_SECONDS
 * judges, and only that span (± VOICED.PAD_MS) is embedded with the Voice ID model
 * (the in-browser WavLM worker, through the enrollment flow's private
 * embedder: one worker for every session, made when first needed) and scored
 * the way Voice ID already scores a meeting's speakers:
 *   - selfSim: the best cosine against the user's voiceprint prototypes
 *     (VoiceIdService.evaluateSelf's comparison), and
 *   - known: the best workspace contact (rankCandidates over the gallery
 *     /api/account/voice-enrollments gives a recording, the user's own
 *     contacts left out as evaluateSelf leaves them out).
 * The verdict (judgeVoice):
 *   you      the self vote qualifies (selfVoteQualifies: ≥ SELF_VERIFY_THRESHOLD
 *            and beating every contact by SELF_VERIFY_MARGIN)
 *   known    a contact at or above KNOWN_VOICE_THRESHOLD (the floor a Voice ID
 *            vote needs to count for a contact, VOTE_FLOOR_THRESHOLD)
 *   unknown  selfSim below SELF_MISMATCH_THRESHOLD (the floor below which a
 *            meeting's "You" is demoted) and no contact known
 *   unsure   anything else: too short to judge (< MIN_SECONDS), close to the
 *            user without qualifying, no voiceprint, no contacts loaded, the
 *            model not there
 * Only `unknown` is ever dropped, and only with Voice focus on
 * (./settings getVoiceFocus). Everything else is sent, and so is any turn
 * whose verdict isn't in VERDICT_WAIT_MS after its `voice://turn`: it FAILS
 * OPEN. With Voice focus on, a turn waits (in order) for its verdict; one
 * whose session ends during that wait is let go with the session.
 *
 * SHADOW. With the capability and a trained voiceprint every voice mode and
 * Interactive session asks for the speech and scores every turn, Voice focus
 * on or off, so the thresholds can be tuned on real sessions. Off, the turn
 * is handled exactly as without Voice focus (synchronously, at once) and its
 * score is only logged (VoiceFocusGate.observe). One line per turn goes to
 * the desktop's debug log (`voice_log`) and console.debug: ids and numbers,
 * never names, words or audio.
 *
 * Dictation never asks for the speech: the user reads the text before it is
 * sent.
 *
 * PRIVACY: the audio stays in this page's memory, at most MAX_RUNS runs of
 * 8 s, and goes as soon as its turn is scored or the run is abandoned.
 *
 * The decision (SpeechRuns, scoreVoice, judgeVoice, focusAction,
 * formatFocusLine, and VoiceFocusGate with injected deps) is pure; the
 * fetches, the worker and the settings are wired in by openVoiceFocus.
 */

import { tauriBridge, type VoiceSpeechEvent } from '@/lib/tauri-bridge'
import { isDesktopApp } from '@/lib/platform'
import {
  cosineSimilarity,
  l2Normalize,
  rankCandidates,
  VOTE_FLOOR_THRESHOLD,
  type GalleryContact,
  type RankedCandidate,
} from '@/lib/voice-id-matching'
import { EMBEDDING_DIM, SELF_MISMATCH_THRESHOLD } from '@/lib/voice-profile/types'
import { selfVoteQualifies } from '@/lib/voice-profile/self-verify'
import { getVoiceFocus } from './settings'
import { getVoiceStatus } from './status-store'

/** Voice focus's limits (tune on the shadow logs). */
export const VOICE_FOCUS = {
  /** A turn's verdict this long after its `voice://turn`, or it is sent. */
  VERDICT_WAIT_MS: 1500,
  /** Less voiced speech than this is too short to judge: sent. */
  MIN_SECONDS: 1.5,
  /** The most of a run kept (the desktop sends at most its first 8 s). */
  MAX_SECONDS: 8,
  /** Runs collected at once; a new one pushes the oldest out. */
  MAX_RUNS: 4,
  /** Scored turns waiting for their `voice://turn`; the oldest goes. */
  MAX_SCORED: 8,
  /** Scoring that takes longer than this has failed (the model hung). */
  SCORE_TIMEOUT_MS: 20_000,
  SAMPLE_RATE: 16_000,
}

/** Finding the voiced span of a run (findVoiced). */
export const VOICED = {
  /** Frame length. */
  FRAME_MS: 20,
  /** Nothing quieter than this is speech, however quiet the run (dBFS RMS). */
  FLOOR_DBFS: -55,
  /** A frame is voiced at this fraction of the run's loud frames' level… */
  RELATIVE: 0.1,
  /** …taken at this percentile of its frames' RMS. */
  PERCENTILE: 0.95,
  /** Quieter gaps up to this long inside speech (plosives, a breath) count as speech. */
  HANGOVER_MS: 200,
  /** Embedded around the voiced span. */
  PAD_MS: 100,
}

/** A contact this close is someone Dial8 knows: the floor a Voice ID vote
 *  needs to count for a contact at all (voice-id-matching). */
export const KNOWN_VOICE_THRESHOLD = VOTE_FLOOR_THRESHOLD

/** What the composer says, briefly, for a dropped turn. */
export const VOICE_FOCUS_IGNORED = 'Ignored a voice Dial8 doesn’t recognise'

// ── The speech ─────────────────────────────────────────────────────────────

/** Base64 Int16 LE mono → Float32 [-1, 1]; null when it isn't any. */
export function decodePcm16(base64: string): Float32Array | null {
  let bin: string
  try {
    bin = atob(base64)
  } catch {
    return null
  }
  const n = bin.length >> 1
  if (n === 0) return null
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
    if (v >= 0x8000) v -= 0x10000
    out[i] = v / 32768
  }
  return out
}

interface Run {
  chunks: Float32Array[]
  samples: number
  lastSeq: number
}

/** A run that closed as a turn: its audio (≤ MAX_SECONDS) and length. */
export interface ClosedRun {
  turnId: string
  audio: Float32Array
  seconds: number
}

/**
 * The runs being heard, by turnId. Bounded: at most MAX_RUNS runs of
 * MAX_SECONDS each; an abandoned run is dropped on its close; a chunk out of
 * order (a seq not past the last) is skipped.
 */
export class SpeechRuns {
  private readonly runs = new Map<string, Run>()
  private readonly maxRuns: number
  private readonly maxSamples: number

  constructor(limits: { maxRuns?: number; maxSeconds?: number } = {}) {
    this.maxRuns = limits.maxRuns ?? VOICE_FOCUS.MAX_RUNS
    this.maxSamples = Math.round((limits.maxSeconds ?? VOICE_FOCUS.MAX_SECONDS) * VOICE_FOCUS.SAMPLE_RATE)
  }

  /** One `voice://speech`. A run closing as a turn comes back whole (empty
   *  audio when none of it arrived); anything else returns null. */
  add(ev: VoiceSpeechEvent): ClosedRun | null {
    if (ev.end) {
      const run = this.runs.get(ev.turnId)
      this.runs.delete(ev.turnId)
      if (ev.outcome !== 'turn') return null
      return {
        turnId: ev.turnId,
        audio: run ? join(run) : new Float32Array(0),
        seconds: run ? run.samples / VOICE_FOCUS.SAMPLE_RATE : 0,
      }
    }
    let run = this.runs.get(ev.turnId)
    if (!run) {
      while (this.runs.size >= this.maxRuns) {
        const oldest = this.runs.keys().next().value
        if (oldest === undefined) break
        this.runs.delete(oldest)
      }
      run = { chunks: [], samples: 0, lastSeq: -1 }
      this.runs.set(ev.turnId, run)
    }
    if (ev.seq <= run.lastSeq) return null
    run.lastSeq = ev.seq
    const room = this.maxSamples - run.samples
    if (room <= 0) return null
    const pcm = decodePcm16(ev.pcm)
    if (!pcm) return null
    const part = pcm.length > room ? pcm.slice(0, room) : pcm
    run.chunks.push(part)
    run.samples += part.length
    return null
  }

  /** A run for this turn is being heard (its close hasn't come). */
  has(turnId: string): boolean {
    return this.runs.has(turnId)
  }

  drop(turnId: string): void {
    this.runs.delete(turnId)
  }

  clear(): void {
    this.runs.clear()
  }

  /** Runs held (the memory bound). */
  get size(): number {
    return this.runs.size
  }

  /** Samples held across every run (the memory bound). */
  get samples(): number {
    let n = 0
    for (const run of this.runs.values()) n += run.samples
    return n
  }
}

function join(run: Run): Float32Array {
  const out = new Float32Array(run.samples)
  let at = 0
  for (const chunk of run.chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** The voiced part of a run: where to embed (`start`…`end`, in samples, the
 *  voiced span ± VOICED.PAD_MS) and how much speech it holds (`seconds`:
 *  voiced frames, gaps up to VOICED.HANGOVER_MS bridged). */
export interface VoicedSpan {
  start: number
  end: number
  seconds: number
}

/**
 * Find the speech in a run. A 20 ms frame is voiced when its RMS reaches
 * max(the absolute floor, RELATIVE × the run's PERCENTILE frame RMS): the
 * floor keeps a silent run silent, the relative bar keeps room tone out of a
 * run with speech in it. Quieter gaps inside speech up to HANGOVER_MS stay
 * speech, so a plosive or a breath doesn't split a word. Null: no speech.
 */
export function findVoiced(audio: Float32Array, sampleRate = VOICE_FOCUS.SAMPLE_RATE): VoicedSpan | null {
  const frame = Math.max(1, Math.round((VOICED.FRAME_MS / 1000) * sampleRate))
  const frames = Math.floor(audio.length / frame)
  if (frames === 0) return null
  const rms = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += audio[i] * audio[i]
    rms[f] = Math.sqrt(sum / frame)
  }
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const loud = sorted[Math.min(frames - 1, Math.floor(VOICED.PERCENTILE * (frames - 1)))]
  const threshold = Math.max(10 ** (VOICED.FLOOR_DBFS / 20), VOICED.RELATIVE * loud)

  const hangover = Math.round(VOICED.HANGOVER_MS / VOICED.FRAME_MS)
  let first = -1
  let last = -1
  let voicedFrames = 0
  for (let f = 0; f < frames; f++) {
    if (rms[f] < threshold) continue
    if (first < 0) {
      first = f
      voicedFrames = 1
    } else {
      const gap = f - last - 1
      // A short gap inside speech is speech; a long one is a pause.
      voicedFrames += gap <= hangover ? gap + 1 : 1
    }
    last = f
  }
  if (first < 0) return null
  const pad = Math.round((VOICED.PAD_MS / 1000) * sampleRate)
  return {
    start: Math.max(0, first * frame - pad),
    end: Math.min(audio.length, (last + 1) * frame + pad),
    seconds: (voicedFrames * frame) / sampleRate,
  }
}

// ── The decision ───────────────────────────────────────────────────────────

/** The user's voiceprint as Voice ID loads it (unit-norm prototypes), and
 *  the user's own contact ids (left out of the contacts). */
export interface Voiceprint {
  prototypes: number[][]
  selfContactIds: ReadonlySet<string>
}

export interface VoiceScores {
  /** Best cosine against the voiceprint. */
  selfSim: number
  /** Best workspace contact (not the user's own), or null. */
  known: RankedCandidate | null
  /** The contacts loaded (false: whether one is known can't be said). */
  galleryLoaded: boolean
}

export type UnsureReason = 'short' | 'close' | 'no_audio' | 'no_voiceprint' | 'no_gallery' | 'model'

export type VoiceFocusVerdict =
  | { kind: 'you' }
  | { kind: 'known'; contactId: string; contactName: string }
  | { kind: 'unknown' }
  | { kind: 'unsure'; reason: UnsureReason }

export type VoiceFocusAction = 'send' | 'drop'

/** Score one embedding against the voiceprint and the contacts (null: they
 *  couldn't load). */
export function scoreVoice(
  embedding: number[],
  voiceprint: Voiceprint,
  gallery: GalleryContact[] | null,
): VoiceScores {
  let selfSim = -1
  for (const proto of voiceprint.prototypes) {
    const sim = cosineSimilarity(embedding, proto)
    if (sim > selfSim) selfSim = sim
  }
  const known = gallery ? (rankCandidates(embedding, gallery, voiceprint.selfContactIds)[0] ?? null) : null
  return { selfSim, known, galleryLoaded: gallery !== null }
}

/** Whose voice a turn is (see the module doc). */
export function judgeVoice(seconds: number, scores: VoiceScores): VoiceFocusVerdict {
  if (seconds < VOICE_FOCUS.MIN_SECONDS) return { kind: 'unsure', reason: 'short' }
  const bestContactSim = scores.known?.similarity ?? 0
  if (selfVoteQualifies({ selfSim: scores.selfSim, bestContactSim })) return { kind: 'you' }
  if (scores.known && scores.known.similarity >= KNOWN_VOICE_THRESHOLD) {
    return { kind: 'known', contactId: scores.known.contactId, contactName: scores.known.contactName }
  }
  if (scores.selfSim >= SELF_MISMATCH_THRESHOLD) return { kind: 'unsure', reason: 'close' }
  // Not the user; whether it is a contact can't be said without the contacts.
  if (!scores.galleryLoaded) return { kind: 'unsure', reason: 'no_gallery' }
  return { kind: 'unknown' }
}

/** Only an unknown voice, and only with Voice focus on, is dropped. */
export function focusAction(verdict: VoiceFocusVerdict, focusOn: boolean): VoiceFocusAction {
  return focusOn && verdict.kind === 'unknown' ? 'drop' : 'send'
}

/** The shadow log's line: ids and numbers only (never a name or words). */
export function formatFocusLine(p: {
  turnId: string
  /** Voiced seconds (what MIN_SECONDS judges). */
  seconds: number
  /** The whole run's seconds (onset slack and trailing pause included). */
  runSeconds?: number
  scores: VoiceScores | null
  verdict: VoiceFocusVerdict
  focusOn: boolean
  action: VoiceFocusAction
  /** The verdict came after the turn was already sent (VERDICT_WAIT_MS). */
  late?: boolean
  /** Close → verdict, ms. */
  ms?: number
}): string {
  const id = p.turnId.replace(/[^\w.-]/g, '').slice(0, 40) || '-'
  const num = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '-')
  const parts = [
    `turn ${id}`,
    `dur=${p.seconds.toFixed(1)}s`,
    ...(typeof p.runSeconds === 'number' ? [`run=${p.runSeconds.toFixed(1)}s`] : []),
    `self=${p.scores ? num(p.scores.selfSim) : '-'}`,
    `known=${p.scores?.known ? num(p.scores.known.similarity) : '-'}`,
    `verdict=${p.verdict.kind}`,
  ]
  if (p.verdict.kind === 'unsure') parts.push(`why=${p.verdict.reason}`)
  parts.push(`focus=${p.focusOn ? 'on' : 'off'}`, `action=${p.action}`)
  if (p.late) parts.push('late')
  if (typeof p.ms === 'number' && Number.isFinite(p.ms)) parts.push(`ms=${Math.round(p.ms)}`)
  return parts.join(' ')
}

// ── One session's gate ─────────────────────────────────────────────────────

export interface VoiceFocusDeps {
  /** Embed 16 kHz mono Float32 audio (the WavLM worker). May reject. */
  embed: (audio: Float32Array) => Promise<number[]>
  /** The user's voiceprint; null when there is none (or it couldn't load). */
  voiceprint: () => Promise<Voiceprint | null>
  /** The workspace's enrolled contacts; null when they couldn't load. */
  gallery: () => Promise<GalleryContact[] | null>
  /** Voice focus is on (read at each turn). */
  isOn: () => boolean
  /** One shadow-log line. */
  log: (line: string) => void
  now?: () => number
  /** Tests: VOICE_FOCUS.VERDICT_WAIT_MS. */
  waitMs?: number
}

interface Scored {
  verdict: VoiceFocusVerdict
  scores: VoiceScores | null
  /** Voiced seconds. */
  seconds: number
  /** The whole run's seconds (absent when nothing was heard). */
  runSeconds?: number
  ms?: number
}

const unsure = (reason: UnsureReason, seconds = 0, runSeconds?: number): Scored => ({
  verdict: { kind: 'unsure', reason },
  scores: null,
  seconds,
  ...(runSeconds === undefined ? {} : { runSeconds }),
})

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * One voice session's Voice focus: feed it every `voice://speech`
 * (onSpeech), and ask it about each `voice://turn` (judge) before acting on
 * the turn. judge resolves within VERDICT_WAIT_MS: `send` unless the turn is
 * a voice Dial8 doesn't know and Voice focus is on. Never rejects.
 */
export class VoiceFocusGate {
  private readonly runs = new SpeechRuns()
  /** Scores by turnId, from the close until judge takes them. */
  private readonly scored = new Map<string, Promise<Scored>>()
  /** judge called before its run closed: handed the score on the close. */
  private readonly waiting = new Map<string, (scored: Promise<Scored>) => void>()
  private disposed = false

  constructor(
    readonly sessionId: string,
    private readonly deps: VoiceFocusDeps,
    private readonly onDispose?: () => void,
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** One `voice://speech` of this session. */
  onSpeech(ev: VoiceSpeechEvent): void {
    if (this.disposed) return
    const closed = this.runs.add(ev)
    if (!ev.end) return
    const waiter = this.waiting.get(ev.turnId)
    this.waiting.delete(ev.turnId)
    if (!closed) {
      // Abandoned: its audio is gone already. A judge waiting on it sends.
      waiter?.(Promise.resolve(unsure('no_audio')))
      return
    }
    const scored = this.score(closed)
    if (waiter) {
      waiter(scored)
      return
    }
    this.scored.set(ev.turnId, scored)
    while (this.scored.size > VOICE_FOCUS.MAX_SCORED) {
      const oldest = this.scored.keys().next().value
      if (oldest === undefined) break
      this.scored.delete(oldest)
    }
  }

  /** Voice focus is on now: a turn should wait for judge. Off, the caller
   *  handles the turn as it always has and calls observe. */
  focusOn(): boolean {
    return this.deps.isOn()
  }

  /** Voice focus off: the turn `turnId` is handled without waiting; its
   *  score is only logged once it is in. */
  observe(turnId: string): void {
    void this.take(turnId).then((s) => this.write(formatFocusLine({ turnId, ...s, focusOn: false, action: 'send' })))
  }

  /** The turn `turnId` (its `voice://turn` just came): send it or drop it. */
  judge(turnId: string): Promise<VoiceFocusAction> {
    const scored = this.take(turnId)
    const focusOn = this.deps.isOn()
    const write = (s: Scored, action: VoiceFocusAction, late: boolean) =>
      this.write(formatFocusLine({ turnId, ...s, focusOn, action, late }))

    // Off: the turn goes now; its score is only logged.
    if (!focusOn) {
      void scored.then((s) => write(s, 'send', false))
      return Promise.resolve('send')
    }
    const pending = scored
    return new Promise<VoiceFocusAction>((resolve) => {
      let decided = false
      const timer = setTimeout(() => {
        decided = true
        resolve('send')
      }, this.deps.waitMs ?? VOICE_FOCUS.VERDICT_WAIT_MS)
      void pending.then((s) => {
        if (decided) {
          write(s, 'send', true)
          return
        }
        decided = true
        clearTimeout(timer)
        const action = focusAction(s.verdict, true)
        write(s, action, false)
        resolve(action)
      })
    })
  }

  /** The score of `turnId`, taken off the gate: scored already, or its run
   *  still being heard (the close hasn't come: handed over on the close), or
   *  nothing heard for it at all. */
  private take(turnId: string): Promise<Scored> {
    const scored = this.scored.get(turnId)
    this.scored.delete(turnId)
    if (scored) return scored
    return this.runs.has(turnId) && !this.disposed
      ? new Promise<Scored>((resolve) => this.waiting.set(turnId, (p) => void p.then(resolve)))
      : Promise.resolve(unsure('no_audio'))
  }

  /** A turn with nothing to act on (no words): forget its audio. */
  skip(turnId: string): void {
    this.runs.drop(turnId)
    this.scored.delete(turnId)
    this.waiting.delete(turnId)
  }

  /** The session is over: its audio goes. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.runs.clear()
    this.scored.clear()
    for (const waiter of this.waiting.values()) waiter(Promise.resolve(unsure('no_audio')))
    this.waiting.clear()
    this.onDispose?.()
  }

  /** Tests: what the gate holds. */
  get held(): { runs: number; samples: number; scored: number } {
    return { runs: this.runs.size, samples: this.runs.samples, scored: this.scored.size }
  }

  private write(line: string): void {
    try {
      this.deps.log(line)
    } catch {
      // A log never gets in the way of a turn.
    }
  }

  private async score(run: ClosedRun): Promise<Scored> {
    const started = this.now()
    if (run.audio.length === 0) return unsure('no_audio')
    // The run carries the onset slack and the trailing pause: judge (and
    // embed) only the speech in it.
    const voiced = findVoiced(run.audio)
    if (!voiced) return unsure('no_audio', 0, run.seconds)
    const seconds = voiced.seconds
    if (seconds < VOICE_FOCUS.MIN_SECONDS) return unsure('short', seconds, run.seconds)
    try {
      const voiceprint = await this.deps.voiceprint()
      if (!voiceprint || voiceprint.prototypes.length === 0) return unsure('no_voiceprint', seconds, run.seconds)
      const [embedding, gallery] = await Promise.all([
        withTimeout(this.deps.embed(run.audio.slice(voiced.start, voiced.end)), VOICE_FOCUS.SCORE_TIMEOUT_MS),
        this.deps.gallery().catch(() => null),
      ])
      if (embedding.length !== EMBEDDING_DIM) return unsure('model', seconds, run.seconds)
      const scores = scoreVoice(embedding, voiceprint, gallery)
      return { verdict: judgeVoice(seconds, scores), scores, seconds, runSeconds: run.seconds, ms: this.now() - started }
    } catch {
      return unsure('model', seconds, run.seconds)
    }
  }
}

// ── The voiceprint and the contacts (cached) ───────────────────────────────

/** A loaded answer is good this long (a re-train, a new contact, show up). */
const PROFILE_TTL_MS = 5 * 60_000
/** A failed load is tried again after this. */
const PROFILE_RETRY_MS = 30_000

interface Cached<T> {
  at: number
  ttl: number
  promise: Promise<T>
  /** The answer once it came (undefined until then). */
  value: T | undefined
}

let voiceprintCache: Cached<Voiceprint | null> | null = null
let galleryCache: Cached<GalleryContact[] | null> | null = null

function fresh<T>(c: Cached<T> | null): c is Cached<T> {
  return !!c && Date.now() - c.at < c.ttl
}

/** One stored vector, as Voice ID takes it: EMBEDDING_DIM finite numbers,
 *  re-normalized. */
const toPrototype = (p: unknown): number[] | null =>
  Array.isArray(p) && p.length === EMBEDDING_DIM && p.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? l2Normalize(p as number[])
    : null

function cached<T>(load: (entry: Cached<T>) => Promise<T>): Cached<T> {
  const entry: Cached<T> = { at: Date.now(), ttl: PROFILE_TTL_MS, promise: Promise.resolve(undefined as T), value: undefined }
  entry.promise = load(entry)
  void entry.promise.then((v) => {
    entry.value = v
  })
  return entry
}

/** GET /api/account/voice-profile?include=prototypes, parsed as
 *  VoiceIdService.loadSelfProfile parses it. null: not trained (or, tried
 *  again sooner, it couldn't load). */
export function loadVoiceprint(): Promise<Voiceprint | null> {
  if (fresh(voiceprintCache)) return voiceprintCache.promise
  voiceprintCache = cached(async (entry) => {
    try {
      const res = await fetch('/api/account/voice-profile?include=prototypes')
      if (!res.ok) {
        entry.ttl = PROFILE_RETRY_MS
        return null
      }
      const data = (await res.json()) as { prototypes?: unknown; selfContactIds?: unknown } | null
      const raw: unknown[] = Array.isArray(data?.prototypes) ? data.prototypes : []
      const prototypes = raw.map(toPrototype).filter((p): p is number[] => p !== null)
      if (prototypes.length === 0) return null
      const ids: unknown[] = Array.isArray(data?.selfContactIds) ? data.selfContactIds : []
      return { prototypes, selfContactIds: new Set(ids.filter((id): id is string => typeof id === 'string')) }
    } catch {
      entry.ttl = PROFILE_RETRY_MS
      return null
    }
  })
  return voiceprintCache.promise
}

/** What is known of the voiceprint now, without waiting. */
export function peekVoiceprint(): 'present' | 'absent' | 'unknown' {
  if (!fresh(voiceprintCache) || voiceprintCache.value === undefined) return 'unknown'
  return voiceprintCache.value ? 'present' : 'absent'
}

/** GET /api/account/voice-enrollments, parsed as
 *  VoiceIdService.loadEnrollments parses it. null when it couldn't load. */
export function loadVoiceGallery(): Promise<GalleryContact[] | null> {
  if (fresh(galleryCache)) return galleryCache.promise
  galleryCache = cached(async (entry) => {
    try {
      const res = await fetch('/api/account/voice-enrollments')
      if (!res.ok) {
        entry.ttl = PROFILE_RETRY_MS
        return null
      }
      const data = (await res.json()) as { enrollments?: unknown } | null
      const raw: unknown[] = Array.isArray(data?.enrollments) ? data.enrollments : []
      const gallery: GalleryContact[] = []
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const e = item as Record<string, unknown>
        if (typeof e.contactId !== 'string') continue
        // The multi-prototype shape, else the legacy single centroid.
        const source: unknown[] = Array.isArray(e.prototypes) && e.prototypes.length > 0 ? e.prototypes : [e.embedding]
        const prototypes = source.map(toPrototype).filter((p): p is number[] => p !== null)
        if (prototypes.length === 0) continue
        gallery.push({
          contactId: e.contactId,
          contactName: typeof e.contactName === 'string' ? e.contactName : '',
          prototypes,
        })
      }
      return gallery
    } catch {
      entry.ttl = PROFILE_RETRY_MS
      return null
    }
  })
  return galleryCache.promise
}

// ── The model: one worker for every session ────────────────────────────────

interface Embedder {
  load(): Promise<void>
  embed(audio: Float32Array): Promise<number[]>
  terminate(): void
}

/** The worker goes after this long unused, unless Voice focus is on and a
 *  session is open (then the next turn must not wait for it to load). */
const MODEL_IDLE_MS = 2 * 60_000
/** A model that failed to load isn't tried again for this long. */
const MODEL_RETRY_MS = 5 * 60_000

let embedder: Embedder | null = null
let embedderReady: Promise<Embedder> | null = null
let modelLastUsed = 0
let modelFailedUntil = 0
let modelIdleTimer: ReturnType<typeof setTimeout> | null = null
let openGates = 0

function dropModel(): void {
  embedder?.terminate()
  embedder = null
  embedderReady = null
}

function checkModelIdle(): void {
  modelIdleTimer = null
  if (!embedderReady) return
  const keep = openGates > 0 && getVoiceFocus()
  if (!keep && Date.now() - modelLastUsed >= MODEL_IDLE_MS) {
    dropModel()
    return
  }
  modelIdleTimer = setTimeout(checkModelIdle, MODEL_IDLE_MS)
}

function touchModel(): void {
  modelLastUsed = Date.now()
  if (!modelIdleTimer) modelIdleTimer = setTimeout(checkModelIdle, MODEL_IDLE_MS)
}

function getEmbedder(): Promise<Embedder> {
  if (Date.now() < modelFailedUntil) return Promise.reject(new Error('voice model unavailable'))
  touchModel()
  if (!embedderReady) {
    const ready = loadEmbedder()
    embedderReady = ready
    // A failed load is never cached: the next turn after MODEL_RETRY_MS tries again.
    ready.catch(() => {
      if (embedderReady === ready) embedderReady = null
    })
  }
  return embedderReady
}

async function loadEmbedder(): Promise<Embedder> {
  // The enrollment flow's private worker wrapper: the same WavLM worker,
  // never VoiceIdService's, which a recording owns. Loaded on demand, so the
  // chat's first load doesn't carry it.
  let mod: typeof import('@/lib/voice-profile/enrollment-embedder')
  try {
    mod = await import('@/lib/voice-profile/enrollment-embedder')
  } catch (err) {
    // A chunk that failed to load (a deploy since, a network blip) backs off
    // like a model that failed to load.
    modelFailedUntil = Date.now() + MODEL_RETRY_MS
    throw err
  }
  const e = new mod.EnrollmentEmbedder()
  embedder = e
  try {
    await e.load()
  } catch (err) {
    modelFailedUntil = Date.now() + MODEL_RETRY_MS
    // Unless it was dropped (and maybe replaced) meanwhile.
    if (embedder === e) dropModel()
    else e.terminate()
    throw err
  }
  return e
}

async function embedWithModel(audio: Float32Array): Promise<number[]> {
  const e = await getEmbedder()
  touchModel()
  return e.embed(audio)
}

// ── Wiring ─────────────────────────────────────────────────────────────────

/** Warm the voiceprint (and, with Voice focus on, the contacts) while voice
 *  is available, so a session's start knows whether to ask for the speech. */
export function prepareVoiceFocus(): void {
  if (!isDesktopApp() || getVoiceStatus().speechAudio !== true) return
  void loadVoiceprint()
  if (getVoiceFocus()) void loadVoiceGallery()
}

const liveDeps = (sessionId: string): VoiceFocusDeps => ({
  embed: embedWithModel,
  voiceprint: loadVoiceprint,
  gallery: loadVoiceGallery,
  isOn: getVoiceFocus,
  log: (line) => {
    console.debug(`[voice-focus] ${sessionId} ${line}`)
    void tauriBridge.voiceLog(sessionId, line)
  },
})

/**
 * Voice focus for a voice mode or Interactive session about to start: a gate
 * when this desktop sends speech (voice_status `speechAudio`) and the user has
 * a voiceprint (or it is still loading), else null. With a gate, voice_start
 * asks for `speechAudio`. Dispose it with the session.
 */
export function openVoiceFocus(sessionId: string): VoiceFocusGate | null {
  if (!isDesktopApp() || getVoiceStatus().speechAudio !== true) return null
  const voiceprint = peekVoiceprint()
  if (voiceprint === 'absent') return null
  if (voiceprint === 'unknown') void loadVoiceprint()
  openGates++
  const gate = new VoiceFocusGate(sessionId, liveDeps(sessionId), () => {
    openGates = Math.max(0, openGates - 1)
  })
  if (getVoiceFocus()) {
    // The first turn shouldn't wait on the contacts or the model.
    void loadVoiceGallery()
    void getEmbedder().catch(() => {})
  }
  return gate
}

/** Tests only: forget the caches and the model. */
export function __resetVoiceFocusForTests(): void {
  voiceprintCache = null
  galleryCache = null
  if (modelIdleTimer) clearTimeout(modelIdleTimer)
  modelIdleTimer = null
  dropModel()
  modelFailedUntil = 0
  modelLastUsed = 0
  openGates = 0
}
