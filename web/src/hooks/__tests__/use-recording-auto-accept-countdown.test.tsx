// @vitest-environment jsdom
/**
 * useRecording — a Voice ID suggestion's auto-accept countdown.
 *
 * A 'recognizing'-tier suggestion counts down on a 1s interval and is
 * auto-accepted when it runs out. The ticks used to be written into
 * `speakerContacts` state — a field of the volatile RecordingContext value — so
 * the capture detail panel (its full-context consumer) re-rendered once a
 * second for a number painted in one chip. The ticks now go to a ref-backed
 * store keyed by the suggestion entry (getAutoAcceptTick /
 * subscribeAutoAcceptTicks, read at the chip via useAutoAcceptCountdown).
 *
 * Pinned, on the REAL hook (desktop path; the Tauri bridge, Deepgram and the
 * Voice ID service are fakes):
 *  1. A tick moves the number in the store and notifies — and leaves
 *     speakerContacts untouched (same identity), so the context never changes.
 *  2. The auto-accept fires on exactly the same beat as before (countdown N →
 *     N seconds after the suggestion), flagged viaTimeout, and flips the entry
 *     to a link as before.
 *  3. A new suggestion counts down from its own start — the previous
 *     suggestion's ticks don't carry over to it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FakeVoiceId {
  onSpeakerSuggested?: (speakerId: string, contactId: string, contactName: string, confidence: number) => void
  acceptSuggestion: ReturnType<typeof vi.fn>
}

const env = vi.hoisted(() => ({
  voiceIds: [] as unknown[],
  /** What getIdentification answers for a suggested speaker. */
  identification: { trustTier: 'recognizing', autoAcceptCountdown: 3 } as Record<string, unknown>,
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/recording-telemetry', () => ({ trackRecordingEvent: () => {} }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    modulesList: async () => [],
    onAudioPcm: async () => () => {},
    getStatus: async () => 'idle',
    checkMicPermission: async () => 'granted',
    requestMicPermission: async () => 'granted',
    checkSystemAudioPermission: async () => 'granted',
    requestSystemAudioPermission: async () => 'granted',
    startRecording: async () => ({ sessionId: 's1', startedAt: 'now', micDevice: null, capturingSystemAudio: true, systemAudioStatus: 'capturing' }),
    stopRecording: async () => ({ sessionId: 's1', micFile: null, systemFile: null, durationSeconds: 60 }),
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
    ) {}
    getLastAudioAt() { return 1 }
    hasReceivedAudio() { return true }
    sendMicAudio() {}
  }
  return { ...actual, DeepgramStreamingService: FakeDeepgram }
})
vi.mock('@/lib/voice-id-service', () => ({
  VoiceIdService: class {
    autoAcceptDelaySec = 3
    acceptSuggestion = vi.fn()
    dismissSuggestion = vi.fn()
    constructor() {
      env.voiceIds.push(this)
    }
    initialize = async () => {}
    loadEnrollments = async () => {}
    loadSelfProfile = async () => {}
    hasSelfProfile = () => false
    feedAudio = () => {}
    onFinalSegment = () => {}
    getIdentification = () => env.identification
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

const fetchMock = vi.fn(async (url: string) => {
  const body = url === '/api/deepgram-token' ? { token: 'dg-token' } : {}
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
})

let root: Root
let container: HTMLDivElement

async function flush(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

beforeEach(async () => {
  env.voiceIds.length = 0
  env.identification = { trustTier: 'recognizing', autoAcceptCountdown: 3 }
  holder.api = null
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(h(Host)) })
  await act(async () => { await holder.api!.startRecording() })
  await flush()
  // Only the countdown's interval (created from here on) runs on fake time.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const voiceId = () => env.voiceIds.at(-1) as FakeVoiceId
const tick = (ms = 1000) => act(() => { vi.advanceTimersByTime(ms) })

describe('useRecording — auto-accept countdown', () => {
  it('ticks the countdown in its store, never in speakerContacts, and auto-accepts on the same beat', async () => {
    await act(async () => { voiceId().onSpeakerSuggested!('remote_1', 'c-ada', 'Ada', 0.91) })
    const contacts = holder.api!.speakerContacts
    const suggestion = contacts.remote_1
    expect(suggestion).toMatchObject({ isSuggestion: true, autoAcceptCountdown: 3, contactName: 'Ada' })
    // Before the first tick the entry's own value is current.
    expect(holder.api!.getAutoAcceptTick(suggestion)).toBeUndefined()

    let notified = 0
    const unsubscribe = holder.api!.subscribeAutoAcceptTicks(() => { notified++ })

    tick()
    expect(holder.api!.getAutoAcceptTick(suggestion)).toBe(2)
    tick()
    expect(holder.api!.getAutoAcceptTick(suggestion)).toBe(1)
    expect(notified).toBe(2)
    // No state moved: the context's speakerContacts is the very same object.
    expect(holder.api!.speakerContacts).toBe(contacts)
    expect(voiceId().acceptSuggestion).not.toHaveBeenCalled()

    // 3s after the suggestion — exactly when it always fired.
    tick(999)
    expect(voiceId().acceptSuggestion).not.toHaveBeenCalled()
    tick(1)
    expect(voiceId().acceptSuggestion).toHaveBeenCalledWith('remote_1', { viaTimeout: true })
    expect(holder.api!.speakerContacts.remote_1).toMatchObject({
      isSuggestion: false,
      isAutoMatched: false,
      contactName: 'Ada',
    })
    expect(holder.api!.speakerNames.remote_1).toBe('Ada')
    // The expiry is a structural change (speakerContacts), not a tick.
    expect(notified).toBe(2)

    // …and the interval is done.
    tick(5000)
    expect(voiceId().acceptSuggestion).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('accepting by hand stops the countdown, as before', async () => {
    await act(async () => { voiceId().onSpeakerSuggested!('remote_1', 'c-ada', 'Ada', 0.91) })
    tick()
    act(() => holder.api!.acceptSuggestion('remote_1'))
    expect(voiceId().acceptSuggestion).toHaveBeenCalledWith('remote_1')
    expect(holder.api!.speakerContacts.remote_1).toMatchObject({ isSuggestion: false, contactName: 'Ada' })
    tick(5000)
    // No timeout accept after the hand accept.
    expect(voiceId().acceptSuggestion).toHaveBeenCalledTimes(1)
  })

  it('a later suggestion counts down from its own start, not the earlier one’s ticks', async () => {
    await act(async () => { voiceId().onSpeakerSuggested!('remote_1', 'c-ada', 'Ada', 0.91) })
    const first = holder.api!.speakerContacts.remote_1
    tick()
    expect(holder.api!.getAutoAcceptTick(first)).toBe(2)

    // Dismissed, then matched again later (matching resumes after a dismiss).
    act(() => holder.api!.dismissSuggestion('remote_1'))
    expect(holder.api!.speakerContacts.remote_1).toBeUndefined()
    env.identification = { trustTier: 'recognizing', autoAcceptCountdown: 5 }
    await act(async () => { voiceId().onSpeakerSuggested!('remote_1', 'c-bo', 'Bo', 0.88) })
    const second = holder.api!.speakerContacts.remote_1
    expect(second).toMatchObject({ isSuggestion: true, autoAcceptCountdown: 5, contactName: 'Bo' })
    expect(holder.api!.getAutoAcceptTick(second)).toBeUndefined()

    tick()
    expect(holder.api!.getAutoAcceptTick(second)).toBe(4)
  })
})
