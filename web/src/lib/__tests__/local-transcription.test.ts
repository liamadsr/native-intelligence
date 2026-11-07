import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TranscriptSegment, VadEvent } from '../deepgram-stream'

/**
 * LocalTranscriptionService — the desktop's on-device engine seen from the web.
 *
 * Hermetic: the Tauri bridge is replaced by an in-memory event bus (no
 * `@tauri-apps/*` import, no shared loadTauriBridge), so each test drives the
 * exact events the desktop emits: stt://message, stt://engine-changed,
 * stt://finished and audio://mic|system.
 *
 * What it pins:
 *  - Deepgram-shaped stt:// messages come out as the SAME TranscriptSegments
 *    the Deepgram WebSocket produces (local_N / remote_N, times, finals → Voice
 *    ID), so everything downstream is engine-agnostic.
 *  - audio:// only feeds onAudioData (Voice ID) + the audio clock.
 *  - Free and unlimited: never /api/deepgram-token, never
 *    /api/ai/log-transcription — only the PostHog completion event.
 *  - Session identity: stt:// events are buffered until start(sessionId),
 *    then only this recording's are replayed/accepted — a previous session's
 *    late finals, finished or engine-changed never leak in.
 *  - Fallback: engine-changed reaches the handler once (replayed if it came
 *    early) with phase 'start' (no result yet — the sidecar failed to load) or
 *    'mid_session', and silences the local stream.
 *  - Tail drain: stop() keeps the stt listener until this session's
 *    stt://finished (≤5s).
 */

type Handler = (payload: unknown) => void

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const failEvents = new Set<string>()
  const subscribe = (event: string, cb: (payload: unknown) => void) => {
    if (failEvents.has(event)) return Promise.reject(new Error(`listen ${event} failed`))
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
    return Promise.resolve(() => { listeners.get(event)?.delete(cb) })
  }
  return {
    listeners,
    failEvents,
    subscribe,
    emit: (event: string, payload?: unknown) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(payload)
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
    modules: [] as unknown[],
    track: vi.fn(),
  }
})

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/recording-telemetry', () => ({ trackRecordingEvent: bus.track }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    modulesList: async () => bus.modules,
    onSttMessage: (cb: Handler) => bus.subscribe('stt://message', cb),
    onSttEngineChanged: (cb: Handler) => bus.subscribe('stt://engine-changed', cb),
    onSttFinished: (cb: Handler) => bus.subscribe('stt://finished', cb),
    onAudioPcm: (stream: 'mic' | 'system', cb: Handler) => bus.subscribe(`audio://${stream}`, cb),
  },
}))

const {
  LocalTranscriptionService,
  LOCAL_STT_FINISH_TIMEOUT_MS,
  prepareLocalTranscription,
  shiftSegmentTime,
} = await import('../local-transcription')
const { createSegmentIdFactory, parseDeepgramMessage } = await import('../deepgram-stream')

const results = (opts: { transcript: string; start: number; duration: number; isFinal: boolean; speaker: number }) => ({
  type: 'Results',
  start: opts.start,
  duration: opts.duration,
  is_final: opts.isFinal,
  speech_final: opts.isFinal,
  channel: {
    alternatives: [{
      transcript: opts.transcript,
      words: opts.transcript.split(' ').map((w, i) => ({
        word: w, punctuated_word: w, start: opts.start + i * 0.3, end: opts.start + i * 0.3 + 0.08, confidence: 1, speaker: opts.speaker,
      })),
    }],
  },
})

function newService(opts: { moduleVersion?: string } = {}) {
  const segments: TranscriptSegment[] = []
  const finals: TranscriptSegment[] = []
  const vad: Array<[VadEvent, string]> = []
  const svc = new LocalTranscriptionService(
    (s) => segments.push(s),
    (s) => finals.push(s),
    (e, st) => vad.push([e, st]),
    opts,
  )
  return { svc, segments, finals, vad }
}

const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }))

beforeEach(() => {
  bus.listeners.clear()
  bus.failEvents.clear()
  bus.modules = []
  bus.track.mockReset()
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** This recording's native session id (RecordingSession.sessionId). */
const S = 'session-2'
/** A previous recording's session — its late events must never land here. */
const OLD = 'session-1'

const msg = (stream: 'mic' | 'system', message: unknown, session: string | undefined = S) =>
  session === undefined ? { stream, message } : { session, stream, message }
const final = (transcript: string, start: number, speaker = 0) =>
  results({ transcript, start, duration: 1, isFinal: true, speaker })

async function started(opts: { moduleVersion?: string } = {}) {
  const s = newService(opts)
  await s.svc.attach()
  s.svc.start(S)
  return s
}

describe('LocalTranscriptionService — transcript', () => {
  it('attach() subscribes to every stt:// and audio:// event', async () => {
    const { svc } = newService()
    await svc.attach()
    for (const e of ['stt://message', 'stt://engine-changed', 'stt://finished', 'audio://mic', 'audio://system']) {
      expect(bus.count(e)).toBe(1)
    }
  })

  it('turns stt://message into the same segments the Deepgram parser produces (local_N / remote_N)', async () => {
    const { segments, finals, vad } = await started()

    const micInterim = results({ transcript: 'we should', start: 2, duration: 0.8, isFinal: false, speaker: 0 })
    const micFinal = results({ transcript: 'we should ship it', start: 2, duration: 1.6, isFinal: true, speaker: 0 })
    const sysFinal = results({ transcript: 'agreed', start: 4, duration: 0.6, isFinal: true, speaker: 1 })

    bus.emit('stt://message', msg('mic', { type: 'SpeechStarted' }))
    bus.emit('stt://message', msg('mic', micInterim))
    bus.emit('stt://message', msg('mic', micFinal))
    bus.emit('stt://message', msg('system', sysFinal))
    bus.emit('stt://message', msg('system', { type: 'UtteranceEnd' }))

    // Same shape as the WebSocket path, id aside.
    const expected = (m: unknown, stream: 'mic' | 'system') => {
      const p = parseDeepgramMessage(m, stream, createSegmentIdFactory(stream))
      return p?.kind === 'segment' ? { ...p.segment, id: expect.stringMatching(new RegExp(`^${stream}-\\d+-`)) } : null
    }
    expect(segments).toEqual([expected(micInterim, 'mic'), expected(micFinal, 'mic'), expected(sysFinal, 'system')])
    expect(segments.map((s) => s.speaker)).toEqual(['local_1', 'local_1', 'remote_2'])
    expect(segments[1]).toMatchObject({ startTime: 2, endTime: 3.6, isFinal: true, text: 'we should ship it' })
    // Finals reach Voice ID; ids count per stream like a Deepgram connection.
    expect(finals).toEqual([segments[1], segments[2]])
    expect(segments.map((s) => s.id.split('-').slice(0, 2).join('-'))).toEqual(['mic-1', 'mic-2', 'system-1'])
    expect(vad).toEqual([['speech_started', 'mic'], ['utterance_end', 'system']])
  })

  it('ignores malformed payloads without breaking the stream', async () => {
    const { segments } = await started()
    bus.emit('stt://message', null)
    bus.emit('stt://message', { session: S, stream: 'other', message: final('x', 0) })
    bus.emit('stt://message', msg('mic', 'garbage'))
    bus.emit('stt://message', msg('mic', final('still here', 0)))
    // A JSON-string message (instead of an object) is tolerated.
    bus.emit('stt://message', msg('mic', JSON.stringify(final('as string', 1))))
    expect(segments.map((s) => s.text)).toEqual(['still here', 'as string'])
  })
})

describe('LocalTranscriptionService — session identity', () => {
  it('buffers stt:// events that arrive before start(sessionId), then replays only this session’s', async () => {
    const { svc, segments } = newService()
    await svc.attach()
    const handler = vi.fn()

    // Between attach() and start_recording's answer: the previous recording's
    // late tail + its finished + its engine-changed, and this session's first final.
    bus.emit('stt://message', msg('mic', final('old tail', 58), OLD))
    bus.emit('stt://finished', { session: OLD })
    bus.emit('stt://engine-changed', { session: OLD, engine: 'deepgram', reason: 'old_crash' })
    bus.emit('stt://message', msg('mic', final('first words', 0.4)))
    expect(segments).toEqual([]) // nothing delivered before the session is known

    svc.start(S)
    svc.setFallbackHandler(handler)

    expect(segments.map((s) => s.text)).toEqual(['first words'])
    expect(handler).not.toHaveBeenCalled()
    expect(svc.getFallbackReason()).toBeNull()
  })

  it('a buffered engine-changed for this session is replayed on start', async () => {
    const { svc } = newService()
    await svc.attach()
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'model_load_failed' })
    svc.start(S)
    const handler = vi.fn()
    svc.setFallbackHandler(handler)
    expect(handler).toHaveBeenCalledWith('model_load_failed', 'start')
  })

  it('after start, drops another session’s message, engine-changed and finished', async () => {
    const { svc, segments } = await started()
    const handler = vi.fn()
    svc.setFallbackHandler(handler)

    bus.emit('stt://message', msg('system', final('stale', 3), OLD))
    bus.emit('stt://engine-changed', { session: OLD, engine: 'deepgram', reason: 'old_crash' })
    bus.emit('stt://finished', { session: OLD })
    bus.emit('stt://message', msg('system', final('mine', 3)))

    expect(segments.map((s) => s.text)).toEqual(['mine'])
    expect(handler).not.toHaveBeenCalled() // a healthy session is not pushed onto (billed) Deepgram
    expect(svc.getFallbackReason()).toBeNull()
  })

  it('a stale stt://finished (before or after start) does not short-circuit this session’s tail drain', async () => {
    const { svc, segments } = newService()
    await svc.attach()
    bus.emit('stt://finished', { session: OLD }) // buffered, then dropped
    svc.start(S)
    bus.emit('stt://finished', { session: OLD }) // dropped on arrival

    let settled = false
    const stopping = svc.stop().then(() => { settled = true })
    bus.emit('stt://finished', { session: OLD })
    await new Promise((r) => setTimeout(r, 0)) // let a (wrongly) settled stop resolve
    expect(settled).toBe(false)
    bus.emit('stt://message', msg('mic', final('the tail', 20)))
    expect(segments.map((s) => s.text)).toEqual(['the tail'])

    bus.emit('stt://finished', { session: S })
    await stopping
    expect(settled).toBe(true)
  })

  it('a payload without a session field is accepted (tolerance)', async () => {
    const { svc, segments } = await started()
    bus.emit('stt://message', msg('mic', final('no session id', 1), undefined))
    expect(segments.map((s) => s.text)).toEqual(['no session id'])
    const stopping = svc.stop()
    bus.emit('stt://finished', {})
    await stopping
  })

  it('events buffered for a service that never starts are discarded', async () => {
    const { svc, segments } = newService()
    await svc.attach()
    bus.emit('stt://message', msg('mic', final('never', 0)))
    await svc.stop({ drainTail: false })
    svc.start(S) // too late: stopped services never start
    expect(segments).toEqual([])
    expect(bus.track).not.toHaveBeenCalled()
  })
})

describe('LocalTranscriptionService — audio', () => {
  it('feeds audio:// to onAudioData and tracks the per-stream audio clock', async () => {
    const { svc } = newService()
    const fed: Array<[string, number[]]> = []
    svc.onAudioData = (stream, bytes) => fed.push([stream, [...bytes]])
    await svc.attach()

    expect(svc.hasReceivedAudio('mic')).toBe(false)
    expect(svc.getLastAudioAt('mic')).toBe(0)

    bus.emit('audio://mic', [1, 0, 2, 0])
    bus.emit('audio://system', new Array(32_000).fill(0)) // 1s of 16 kHz Int16
    bus.emit('audio://mic', null) // empty frames are ignored, like Deepgram's listener

    expect(fed).toEqual([['mic', [1, 0, 2, 0]], ['system', new Array(32_000).fill(0)]])
    expect(svc.hasReceivedAudio('mic')).toBe(true)
    expect(svc.getLastAudioAt('mic')).toBeGreaterThan(0)
    expect(svc.getAudioSeconds('system')).toBe(1)
    expect(svc.getAudioSeconds('mic')).toBeCloseTo(4 / 32_000)
  })
})

describe('LocalTranscriptionService — free and unlimited', () => {
  it('never mints a Deepgram token or logs usage; only the completion analytics event', async () => {
    vi.useFakeTimers()
    const { svc } = await started({ moduleVersion: '97a15af' })
    bus.emit('stt://message', msg('mic', final('hello', 0)))
    await vi.advanceTimersByTimeAsync(42_000)

    const stopping = svc.stop()
    bus.emit('stt://finished', { session: S })
    await stopping

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(bus.track).toHaveBeenCalledTimes(1)
    expect(bus.track).toHaveBeenCalledWith('local_transcription_completed', { seconds: 42, module_version: '97a15af' })
  })

  it('fires no completion event for a session the desktop never confirmed', async () => {
    const { svc } = newService()
    await svc.attach()
    await svc.stop({ drainTail: false })
    expect(bus.track).not.toHaveBeenCalled()
  })
})

describe('LocalTranscriptionService — fallback (stt://engine-changed)', () => {
  it('after results flowed: handler once with phase mid_session, later local messages silenced, completion carries the reason', async () => {
    const { svc, segments } = await started()
    const handler = vi.fn()
    svc.setFallbackHandler(handler)

    bus.emit('stt://message', msg('mic', final('local part', 0)))
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'sidecar_crashed' })
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'again' })
    bus.emit('stt://message', msg('mic', final('late', 9)))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('sidecar_crashed', 'mid_session')
    expect(svc.getFallbackReason()).toBe('sidecar_crashed')
    expect(segments.map((s) => s.text)).toEqual(['local part'])

    await svc.stop({ drainTail: false })
    expect(bus.track).toHaveBeenCalledWith(
      'local_transcription_completed',
      expect.objectContaining({ fallback_reason: 'sidecar_crashed' }),
    )
  })

  it('before any result (the sidecar failed to load): phase start, and no completed local session is reported', async () => {
    const { svc } = await started()
    const handler = vi.fn()
    svc.setFallbackHandler(handler)
    // VAD alone doesn't count as output — only a Results message does.
    bus.emit('stt://message', msg('mic', { type: 'SpeechStarted' }))
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'model_load_failed' })

    expect(handler).toHaveBeenCalledWith('model_load_failed', 'start')
    await svc.stop({ drainTail: false })
    expect(bus.track).not.toHaveBeenCalledWith('local_transcription_completed', expect.anything())
  })

  it('an empty Results (silence) still counts as the engine running', async () => {
    const { svc } = await started()
    const handler = vi.fn()
    svc.setFallbackHandler(handler)
    bus.emit('stt://message', msg('mic', results({ transcript: '', start: 0, duration: 1, isFinal: false, speaker: 0 })))
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'sidecar_crashed' })
    expect(handler).toHaveBeenCalledWith('sidecar_crashed', 'mid_session')
  })

  it('replays a failure that arrived before the handler was registered', async () => {
    const { svc } = await started()
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'model_load_failed' })
    const handler = vi.fn()
    svc.setFallbackHandler(handler)
    expect(handler).toHaveBeenCalledWith('model_load_failed', 'start')
  })

  it('never fires the handler after stop()', async () => {
    const { svc } = await started()
    const handler = vi.fn()
    svc.setFallbackHandler(handler)
    const stopping = svc.stop()
    // The sidecar dies while flushing: the drain ends, no fallback is started.
    bus.emit('stt://engine-changed', { session: S, engine: 'deepgram', reason: 'crash_on_flush' })
    await stopping
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('LocalTranscriptionService — stop drains the transcript tail', () => {
  it('keeps stt://message until stt://finished, drops audio immediately, then unsubscribes', async () => {
    const { svc, segments } = newService()
    const fed: string[] = []
    svc.onAudioData = (stream) => fed.push(stream)
    await svc.attach()
    svc.start(S)

    let settled = false
    const stopping = svc.stop().then(() => { settled = true })

    // Audio is off the moment stop() is called…
    expect(bus.count('audio://mic')).toBe(0)
    bus.emit('audio://mic', [1, 2])
    expect(fed).toEqual([])

    // …but the sidecar's last final still lands.
    bus.emit('stt://message', msg('mic', final('last words', 30)))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(segments.map((s) => s.text)).toEqual(['last words'])

    bus.emit('stt://finished', { session: S })
    await stopping
    expect(settled).toBe(true)
    for (const e of ['stt://message', 'stt://engine-changed', 'stt://finished']) expect(bus.count(e)).toBe(0)

    // Idempotent: a second stop returns at once and fires nothing new.
    await svc.stop()
    expect(bus.track).toHaveBeenCalledTimes(1)
  })

  it('gives up waiting after the cap when stt://finished never arrives', async () => {
    vi.useFakeTimers()
    const { svc } = await started()
    let settled = false
    const stopping = svc.stop().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(LOCAL_STT_FINISH_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(bus.count('stt://message')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(settled).toBe(true)
    expect(bus.count('stt://message')).toBe(0)
  })

  it('resolves at once when this session’s stt://finished already arrived, or with drainTail: false', async () => {
    const a = await started()
    bus.emit('stt://finished', { session: S })
    await a.svc.stop() // would hang 5s without the early finished
    expect(bus.count('stt://message')).toBe(0)

    const b = await started()
    await b.svc.stop({ drainTail: false })
    expect(bus.count('stt://message')).toBe(0)
  })

  it('a stop() that races attach() leaves no listener behind', async () => {
    const { svc } = newService()
    const attaching = svc.attach()
    await svc.stop({ drainTail: false })
    await attaching
    for (const e of ['stt://message', 'audio://mic', 'audio://system']) expect(bus.count(e)).toBe(0)
  })
})

describe('prepareLocalTranscription — engine selection', () => {
  const info = (over: Record<string, unknown> = {}) => ({
    id: 'local-stt', version: '97a15af', enabled: true, state: 'ready', progress: null,
    downloadBytes: 807_000_000, assetsPresent: true, error: null, ...over,
  })

  it('no module on this desktop (or an older build) → Deepgram, nothing to report', async () => {
    bus.modules = []
    expect(await prepareLocalTranscription(() => {})).toEqual({ service: null, fallbackReason: null })
    expect(bus.count('stt://message')).toBe(0)
  })

  it('module off, or on but not ready yet → Deepgram, nothing to report', async () => {
    for (const over of [{ enabled: false }, { state: 'downloading', progress: 0.4 }, { state: 'warming' }, { state: 'error', error: 'x' }]) {
      bus.modules = [info(over)]
      expect(await prepareLocalTranscription(() => {})).toEqual({ service: null, fallbackReason: null })
    }
    expect(bus.count('stt://message')).toBe(0)
  })

  it('enabled + ready → an attached service (subscribed before start_recording)', async () => {
    bus.modules = [info()]
    const prep = await prepareLocalTranscription(() => {})
    expect(prep.service).toBeInstanceOf(LocalTranscriptionService)
    expect(prep.fallbackReason).toBeNull()
    expect(bus.count('stt://message')).toBe(1)
    expect(bus.count('stt://engine-changed')).toBe(1)
  })

  it('a failed subscription → Deepgram with a reportable reason, and no stray listeners', async () => {
    bus.modules = [info()]
    bus.failEvents.add('stt://finished')
    const prep = await prepareLocalTranscription(() => {})
    expect(prep).toEqual({ service: null, fallbackReason: 'subscribe_failed' })
    for (const e of ['stt://message', 'stt://engine-changed', 'audio://mic', 'audio://system']) expect(bus.count(e)).toBe(0)
  })
})

describe('shiftSegmentTime', () => {
  const seg: TranscriptSegment = {
    id: 'mic-1-0-x', text: 'hi there', stream: 'mic', speaker: 'local_1', startTime: 1, endTime: 2, isFinal: true,
    words: [{ word: 'hi', start: 1, end: 1.2, confidence: 1, speaker: 0 }, { word: 'there', start: 1.4, end: 2, confidence: 1, speaker: 0 }],
  }

  it('moves the segment and its words onto the later clock', () => {
    expect(shiftSegmentTime(seg, 600)).toEqual({
      ...seg,
      startTime: 601,
      endTime: 602,
      words: [
        { word: 'hi', start: 601, end: 601.2, confidence: 1, speaker: 0 },
        { word: 'there', start: 601.4, end: 602, confidence: 1, speaker: 0 },
      ],
    })
    expect(seg.startTime).toBe(1) // not mutated
  })

  it('returns the same object for a zero offset', () => {
    expect(shiftSegmentTime(seg, 0)).toBe(seg)
  })
})
