// @vitest-environment jsdom
/**
 * useRecording — engine selection for on-device transcription (the desktop's
 * opt-in local-stt module) and its two fallback paths to Deepgram.
 *
 * Drives the REAL hook with the REAL LocalTranscriptionService /
 * prepareLocalTranscription / parser / TranscriptMerger. Only the edges are
 * fakes: the Tauri bridge is an in-memory event bus (stt://…, audio://…,
 * modules_list, start/stop_recording — no @tauri-apps import, no shared
 * bridge loader), DeepgramStreamingService is a recording fake, and fetch
 * answers /api/deepgram-token.
 *
 * Pinned:
 *  1. local-stt ready → subscribe BEFORE start_recording, ask for 'local', and
 *     NEVER mint a Deepgram token (free; works over limits). Segments come out
 *     as local_N / remote_N into the live transcript.
 *  2. Stop with the local engine → native stop first, then the transcript
 *     tail drains (until stt://finished) BEFORE the stop resolves — so the
 *     provider's final save sees it — and the interim isn't duplicated.
 *  3. The desktop answers 'deepgram' → today's path (token + Deepgram), plus
 *     local_transcription_fallback{phase:'start'} and a toast.
 *  4. stt://engine-changed → token + Deepgram for the rest, its segments
 *     placed after the local ones; phase 'mid_session' after results flowed,
 *     'start' when the sidecar never produced any (it failed to load). An
 *     over-limit token refusal behaves like today's token failure (recording
 *     continues, error surfaced).
 *  5. Session identity: another session's stt:// events (late finals, a stale
 *     engine-changed or finished) never affect this recording.
 *  6. No module / older desktop → start_recording args exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (payload: unknown) => void

const env = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  return {
    listeners,
    subscribe: (event: string, cb: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
      return Promise.resolve(() => { listeners.get(event)?.delete(cb) })
    },
    emit: (event: string, payload?: unknown) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(payload)
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
    modules: [] as unknown[] | Error,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    track: vi.fn(),
    toastInfo: vi.fn(),
    toastError: vi.fn(),
    deepgram: [] as Array<{
      onSegment: (s: TranscriptSegment) => void
      onFinalSegment?: (s: TranscriptSegment) => void
      start: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
      onAudioData?: unknown
    }>,
    tokenResponse: { ok: true, status: 200, body: { token: 'dg-token' } as Record<string, unknown> },
  }
})

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/recording-telemetry', () => ({ trackRecordingEvent: env.track }))
vi.mock('sonner', () => ({ toast: { info: env.toastInfo, error: env.toastError, success: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    // Local modules + stt:// / audio:// on the in-memory bus.
    modulesList: async () => {
      if (env.modules instanceof Error) throw env.modules
      return env.modules
    },
    onSttMessage: (cb: Handler) => env.subscribe('stt://message', cb),
    onSttEngineChanged: (cb: Handler) => env.subscribe('stt://engine-changed', cb),
    onSttFinished: (cb: Handler) => env.subscribe('stt://finished', cb),
    onAudioPcm: (stream: string, cb: Handler) => env.subscribe(`audio://${stream}`, cb),
    // Recording.
    getStatus: async () => 'idle',
    checkMicPermission: async () => 'granted',
    requestMicPermission: async () => 'granted',
    checkSystemAudioPermission: async () => 'granted',
    requestSystemAudioPermission: async () => 'granted',
    startRecording: (...args: unknown[]) => env.startRecording(...args),
    stopRecording: () => env.stopRecording(),
    recoverMic: async () => {},
    onAudioLevel: async () => () => {},
    onMicFault: async () => () => {},
  },
}))
vi.mock('@/lib/deepgram-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram-stream')>()
  class FakeDeepgram {
    readonly engine = 'deepgram' as const
    onAudioData?: unknown
    onTranscriptionStatus?: (s: string) => void
    getUsageAuthHeader?: unknown
    refreshApiKey?: unknown
    start = vi.fn(async () => { this.onTranscriptionStatus?.('connected') })
    stop = vi.fn()
    constructor(
      public onSegment: (s: TranscriptSegment) => void,
      public onFinalSegment?: (s: TranscriptSegment) => void,
    ) {
      env.deepgram.push(this)
    }
    getLastAudioAt() { return 1 }
    hasReceivedAudio() { return true }
    sendMicAudio() {}
  }
  return { ...actual, DeepgramStreamingService: FakeDeepgram }
})
vi.mock('@/lib/voice-id-service', () => ({
  VoiceIdService: class {
    autoAcceptDelaySec = 10
    initialize = async () => {}
    loadEnrollments = async () => {}
    loadSelfProfile = async () => {}
    hasSelfProfile = () => false
    feedAudio = () => {}
    onFinalSegment = () => {}
    getAssignments = () => []
    stop = () => {}
  },
}))
vi.mock('@/lib/web-audio-capture', () => ({
  WebAudioCapture: class {},
  WebAudioCaptureError: class extends Error {},
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt' } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'jwt' } } }),
    },
  }),
}))

import { useRecording } from '../use-recording'

const holder: { api: ReturnType<typeof useRecording> | null } = { api: null }
function Host() {
  const api = useRecording()
  // Commit-time mirror (no render-time mutation), refreshed every render.
  useEffect(() => { holder.api = api })
  return null
}

const readyStt = {
  id: 'local-stt', version: '97a15af', enabled: true, state: 'ready', progress: null,
  downloadBytes: 807_000_000, assetsPresent: true, error: null,
}

const results = (o: { text: string; start: number; duration: number; isFinal: boolean; speaker: number }) => ({
  type: 'Results',
  start: o.start,
  duration: o.duration,
  is_final: o.isFinal,
  channel: {
    alternatives: [{
      transcript: o.text,
      words: o.text.split(' ').map((w, i) => ({ word: w, start: o.start + i * 0.3, end: o.start + i * 0.3 + 0.08, confidence: 1, speaker: o.speaker })),
    }],
  },
})

const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/deepgram-token') {
    const r = env.tokenResponse
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
})
const fetchedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]))
const tracked = (event: string) => env.track.mock.calls.filter((c) => c[0] === event).map((c) => c[1])

let root: Root
let container: HTMLDivElement

async function flush(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

beforeEach(async () => {
  env.listeners.clear()
  env.modules = []
  env.deepgram.length = 0
  env.track.mockReset()
  env.toastInfo.mockReset()
  env.toastError.mockReset()
  env.tokenResponse = { ok: true, status: 200, body: { token: 'dg-token' } }
  env.startRecording.mockReset().mockImplementation(async (opts: { transcription?: string }) => ({
    sessionId: 's1',
    startedAt: 'now',
    micDevice: null,
    capturingSystemAudio: true,
    systemAudioStatus: 'capturing',
    ...(opts.transcription === 'local' ? { transcriptionEngine: 'local' } : {}),
  }))
  env.stopRecording.mockReset().mockResolvedValue({ sessionId: 's1', micFile: null, systemFile: null, durationSeconds: 60 })
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(h(Host)) })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function start() {
  await act(async () => { await holder.api!.startRecording() })
  await flush()
}

const transcript = () => holder.api!.getTranscriptSegmentsSnapshot()

describe('useRecording — local engine selected', () => {
  it('subscribes before start_recording, asks for local, and never mints a Deepgram token', async () => {
    env.modules = [readyStt]
    const subscribedAtStart: Record<string, number> = {}
    env.startRecording.mockImplementation(async (opts: { transcription?: string }) => {
      for (const e of ['stt://message', 'stt://engine-changed', 'stt://finished']) subscribedAtStart[e] = env.count(e)
      return { sessionId: 's1', systemAudioStatus: 'capturing', transcriptionEngine: opts.transcription === 'local' ? 'local' : undefined }
    })
    await start()

    expect(env.startRecording).toHaveBeenCalledWith(expect.objectContaining({ captureSystemAudio: true, transcription: 'local' }))
    expect(subscribedAtStart).toEqual({ 'stt://message': 1, 'stt://engine-changed': 1, 'stt://finished': 1 })
    expect(fetchedUrls()).not.toContain('/api/deepgram-token')
    expect(env.deepgram).toHaveLength(0)
    expect(tracked('transcription_connected')).toEqual([expect.objectContaining({ platform: 'tauri', engine: 'local' })])

    await act(async () => {
      env.emit('stt://message', { session: 's1', stream: 'mic', message: results({ text: 'kick off', start: 1, duration: 1, isFinal: true, speaker: 0 }) })
      env.emit('stt://message', { session: 's1', stream: 'system', message: results({ text: 'sounds good', start: 2.5, duration: 1, isFinal: true, speaker: 1 }) })
    })
    expect(transcript().map((s) => [s.speaker, s.text])).toEqual([['local_1', 'kick off'], ['remote_2', 'sounds good']])
  })

  it('stop: native stop first, then the tail drains into the transcript before stop resolves (no duplicate interim)', async () => {
    env.modules = [readyStt]
    await start()
    await act(async () => {
      env.emit('stt://message', { session: 's1', stream: 'mic', message: results({ text: 'and the last', start: 10, duration: 1, isFinal: false, speaker: 0 }) })
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) }) // interim coalesce flush

    let stopped = false
    let stopping!: Promise<void>
    await act(async () => { stopping = holder.api!.stopRecording().then(() => { stopped = true }) })
    await flush()

    expect(env.stopRecording).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(false)

    // The sidecar's flush lands after the native stop…
    await act(async () => {
      env.emit('stt://message', { session: 's1', stream: 'mic', message: results({ text: 'and the last word', start: 10, duration: 1.4, isFinal: true, speaker: 0 }) })
      env.emit('stt://finished', { session: 's1' })
    })
    await act(async () => { await stopping })
    expect(stopped).toBe(true)

    // …and is in the final transcript exactly once, not as a promoted interim too.
    expect(transcript().map((s) => [s.text, s.isFinal])).toEqual([['and the last word', true]])
    expect(env.stopRecording).toHaveBeenCalledTimes(1)
    expect(env.count('stt://message')).toBe(0)
    expect(fetchedUrls()).not.toContain('/api/ai/log-transcription')
    expect(tracked('local_transcription_completed')).toEqual([expect.objectContaining({ module_version: '97a15af' })])
  })
})

describe('useRecording — fallback at start', () => {
  it('desktop answers deepgram → token + Deepgram, fallback analytics + toast, local listeners dropped', async () => {
    env.modules = [readyStt]
    env.startRecording.mockResolvedValue({
      sessionId: 's1', systemAudioStatus: 'capturing', transcriptionEngine: 'deepgram', transcriptionFallbackReason: 'module_not_ready',
    })
    await start()

    expect(env.count('stt://message')).toBe(0)
    expect(fetchedUrls()).toContain('/api/deepgram-token')
    expect(env.deepgram).toHaveLength(1)
    expect(env.deepgram[0].start).toHaveBeenCalledWith('dg-token', 'tauri')
    expect(tracked('local_transcription_fallback')).toEqual([{ capture_id: null, reason: 'module_not_ready', phase: 'start' }])
    expect(tracked('local_transcription_completed')).toEqual([])
    expect(env.toastInfo).toHaveBeenCalledTimes(1)
  })
})

describe('useRecording — fallback mid-session (stt://engine-changed)', () => {
  it('mints a token, starts Deepgram for the rest, and places its segments after the local ones', async () => {
    env.modules = [readyStt]
    await start()
    await act(async () => {
      env.emit('audio://mic', new Array(64_000).fill(0)) // 2s
      env.emit('audio://system', new Array(96_000).fill(0)) // 3s
      env.emit('stt://message', { session: 's1', stream: 'mic', message: results({ text: 'local part', start: 0.5, duration: 1, isFinal: true, speaker: 0 }) })
      env.emit('stt://engine-changed', { session: 's1', engine: 'deepgram', reason: 'sidecar_crashed' })
    })
    await flush(20)

    expect(fetchedUrls()).toContain('/api/deepgram-token')
    expect(env.deepgram).toHaveLength(1)
    expect(env.deepgram[0].start).toHaveBeenCalledWith('dg-token', 'tauri')
    expect(env.count('stt://message')).toBe(0)
    expect(tracked('local_transcription_fallback')).toEqual([{ capture_id: null, reason: 'sidecar_crashed', phase: 'mid_session' }])
    expect(tracked('local_transcription_completed')).toEqual([expect.objectContaining({ fallback_reason: 'sidecar_crashed' })])
    expect(env.toastInfo).toHaveBeenCalledTimes(1)
    // Voice ID's audio sink carried over to the new service.
    expect(typeof env.deepgram[0].onAudioData).toBe('function')

    // Deepgram's clock restarts at 0 — its segments land after the local ones.
    const dg = env.deepgram[0]
    await act(async () => {
      dg.onSegment({ id: 'mic-1-x', text: 'cloud part', stream: 'mic', speaker: 'local_1', startTime: 0.2, endTime: 1, isFinal: true, words: [] })
      dg.onSegment({ id: 'system-1-x', text: 'other side', stream: 'system', speaker: 'remote_1', startTime: 0.1, endTime: 0.9, isFinal: true, words: [] })
    })
    expect(transcript().map((s) => [s.text, s.startTime])).toEqual([
      ['local part', 0.5],
      ['cloud part', 2.2],
      ['other side', 3.1],
    ])

    // Stop runs the normal Deepgram teardown (no tail wait).
    await act(async () => { await holder.api!.stopRecording() })
    expect(dg.stop).toHaveBeenCalled()
    expect(env.stopRecording).toHaveBeenCalledTimes(1)
  })

  it('over limits: the fallback token is refused → error surfaced, recording continues without Deepgram', async () => {
    env.modules = [readyStt]
    await start()
    env.tokenResponse = { ok: false, status: 402, body: { error: 'Transcription limit reached for this billing period.' } }
    await act(async () => {
      env.emit('stt://engine-changed', { session: 's1', engine: 'deepgram', reason: 'sidecar_crashed' })
    })
    await flush(20)

    expect(env.deepgram).toHaveLength(0)
    expect(holder.api!.recordingError).toBe('Transcription limit reached for this billing period.')
    expect(holder.api!.isRecording).toBe(true)
  })

  it('a failure reported before the hook finished setting up is still handled (replayed)', async () => {
    env.modules = [readyStt]
    env.startRecording.mockImplementation(async () => {
      // The sidecar fails while start_recording is still answering.
      env.emit('stt://engine-changed', { session: 's1', engine: 'deepgram', reason: 'model_load_failed' })
      return { sessionId: 's1', systemAudioStatus: 'capturing', transcriptionEngine: 'local' }
    })
    await start()
    await flush(20)
    expect(env.deepgram).toHaveLength(1)
    // The engine never produced a result: a start-phase fallback, not a completed local session.
    expect(tracked('local_transcription_fallback')).toEqual([{ capture_id: null, reason: 'model_load_failed', phase: 'start' }])
    expect(tracked('local_transcription_completed')).toEqual([])
    expect(env.toastInfo).toHaveBeenCalledWith("Local transcription isn't available right now — using cloud transcription.")
  })

  it('the sidecar fails to load after start (no results yet) → phase start, start copy, no completed session', async () => {
    env.modules = [readyStt]
    await start()
    await act(async () => {
      env.emit('stt://engine-changed', { session: 's1', engine: 'deepgram', reason: 'sidecar_spawn_failed' })
    })
    await flush(20)
    expect(env.deepgram).toHaveLength(1)
    expect(tracked('local_transcription_fallback')).toEqual([{ capture_id: null, reason: 'sidecar_spawn_failed', phase: 'start' }])
    expect(tracked('local_transcription_completed')).toEqual([])
    expect(env.toastInfo).toHaveBeenCalledWith("Local transcription isn't available right now — using cloud transcription.")
  })

  it('another session’s late events never reach this recording (no billed fallback, no stale finals)', async () => {
    env.modules = [readyStt]
    await start()
    await act(async () => {
      env.emit('stt://message', { session: 's0', stream: 'mic', message: results({ text: 'previous meeting', start: 50, duration: 1, isFinal: true, speaker: 0 }) })
      env.emit('stt://engine-changed', { session: 's0', engine: 'deepgram', reason: 'old_crash' })
      env.emit('stt://message', { session: 's1', stream: 'mic', message: results({ text: 'this meeting', start: 1, duration: 1, isFinal: true, speaker: 0 }) })
    })
    await flush(20)
    expect(env.deepgram).toHaveLength(0)
    expect(fetchedUrls()).not.toContain('/api/deepgram-token')
    expect(tracked('local_transcription_fallback')).toEqual([])
    expect(transcript().map((s) => s.text)).toEqual(['this meeting'])

    // A stale finished doesn't cut this session's tail drain short.
    let stopped = false
    let stopping!: Promise<void>
    await act(async () => { stopping = holder.api!.stopRecording().then(() => { stopped = true }) })
    await flush()
    await act(async () => { env.emit('stt://finished', { session: 's0' }) })
    await flush()
    expect(stopped).toBe(false)
    await act(async () => { env.emit('stt://finished', { session: 's1' }) })
    await act(async () => { await stopping })
    expect(stopped).toBe(true)
  })
})

describe('useRecording — no local module (browser-equivalent desktop paths)', () => {
  for (const [label, modules] of [
    ['older desktop without modules_list', new Error('command modules_list not found')],
    ['module present but off', [{ ...readyStt, enabled: false }]],
  ] as const) {
    it(`${label}: start_recording args and the Deepgram path are unchanged`, async () => {
      env.modules = modules as unknown[] | Error
      await start()
      expect(env.startRecording).toHaveBeenCalledTimes(1)
      const args = env.startRecording.mock.calls[0][0]
      expect(Object.keys(args)).toEqual(['captureSystemAudio'])
      expect(env.count('stt://message')).toBe(0)
      expect(fetchedUrls()).toContain('/api/deepgram-token')
      expect(env.deepgram).toHaveLength(1)
      expect(tracked('local_transcription_fallback')).toEqual([])
      expect(env.toastInfo).not.toHaveBeenCalled()
      expect(tracked('transcription_connected')).toEqual([{ capture_id: null, platform: 'tauri' }])
    })
  }
})
