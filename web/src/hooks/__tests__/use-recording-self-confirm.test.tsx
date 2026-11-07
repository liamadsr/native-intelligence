// @vitest-environment jsdom
/**
 * useRecording's "This is me" / "Is this you?" actions (followups issue 11):
 * confirming a voice POSTs /self-confirm (decision "mine") and shows it as
 * "You", demoting the default local_1 when the voice is another label;
 * dismissing a suggestion POSTs "not_mine" so a binding the server may hold on
 * that voice is undone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The old preload effect was gated on isDesktopApp() — force the branch that
// USED to fire, so a reintroduced effect fails this test rather than hiding
// behind a web-platform check.
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))

// vi.mock factories are hoisted above module-level consts, so the spy must be
// created inside vi.hoisted to exist when the factory's class body evaluates.
const { preloadModel } = vi.hoisted(() => ({ preloadModel: vi.fn() }))
vi.mock('@/lib/voice-id-service', () => ({
  VoiceIdService: class {
    static preloadModel = preloadModel
    static clearModelCache = async () => {}
    initialize = async () => {}
    stop = () => {}
  },
  getTrustTier: () => 'learning',
  getTrustTierLabel: () => 'Learning',
  getNextTierThreshold: () => 3,
}))

// Heavy native/audio deps — inert stubs so mount effects settle in jsdom.
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    onAudioLevel: async () => () => {},
    onMicFault: async () => () => {},
    getStatus: async () => 'idle',
    stopRecording: async () => ({ sessionId: 's', micFile: null, systemFile: null, durationSeconds: 0 }),
    recoverMic: async () => {},
    checkMicPermission: async () => 'granted',
    requestMicPermission: async () => 'granted',
  },
}))
vi.mock('@/lib/deepgram-stream', () => ({
  DeepgramStreamingService: class {},
  TranscriptMerger: class { clear() {} addSegment() { return [] } },
}))
vi.mock('@/lib/web-audio-capture', () => ({
  WebAudioCapture: class {},
  WebAudioCaptureError: class extends Error {},
}))
vi.mock('@/lib/recording-telemetry', () => ({ trackRecordingEvent: () => {} }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } }),
}))

import { selfLearnAtStop, useRecording } from '../use-recording'

type Api = ReturnType<typeof useRecording>
let api: Api
function Host() {
  api = useRecording({ captureId: 'cap-1' })
  return null
}

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ bound: true, learned: 0 }) }))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const posts = () =>
  fetchMock.mock.calls
    .map((c) => c as unknown as [string, { method?: string; body?: string; headers?: Record<string, string> }])
    .filter(([url]) => String(url).includes('/self-confirm'))

describe('useRecording — the user\'s own voice', () => {
  it('confirmSelf binds the voice as "You" and POSTs it as mine', async () => {
    await act(async () => { root.render(h(Host)) })
    await act(async () => { await api.confirmSelf('local_2') })
    const [[url, init]] = posts()
    expect(url).toBe('/api/account/captures/cap-1/self-confirm')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body!)).toEqual({ speaker_label: 'local_2', decision: 'mine', embeddings: [] })
    expect(init.headers?.Authorization).toBe('Bearer tok')
    expect(api.speakerNames.local_2).toBe('You')
    expect(api.selfDemotedLabels.has('local_1')).toBe(true)
    expect(api.selfDemotedLabels.has('local_2')).toBe(false)
  })

  it('confirming local_1 itself does not demote it', async () => {
    await act(async () => { root.render(h(Host)) })
    await act(async () => { await api.confirmSelf('local_1') })
    expect(api.speakerNames.local_1).toBe('You')
    expect(api.selfDemotedLabels.has('local_1')).toBe(false)
  })

  it('confirming another voice moves "You" to it', async () => {
    await act(async () => { root.render(h(Host)) })
    await act(async () => { await api.confirmSelf('local_2') })
    await act(async () => { await api.confirmSelf('local_3') })
    expect(api.speakerNames.local_3).toBe('You')
    expect(api.speakerNames.local_2).toBeUndefined()
  })

  it('dismissSelf POSTs not_mine for that voice', async () => {
    await act(async () => { root.render(h(Host)) })
    await act(async () => {
      api.dismissSelf('local_3')
      await Promise.resolve()
      await Promise.resolve()
    })
    const [[, init]] = posts()
    expect(JSON.parse(init.body!)).toEqual({ speaker_label: 'local_3', decision: 'not_mine' })
  })
})

describe('selfLearnAtStop — a confirm short of samples teaches at stop (issue 24)', () => {
  const take = (label: string, n: number) => ({
    takeSelfLearnEmbeddings: vi.fn((max: number) => ({ label, embeddings: Array.from({ length: Math.min(n, max) }, () => [0.1]) })),
  })

  it('posts mine again with the samples since, up to what is still owed', () => {
    const voice = take('local_2', 20)
    const learn = selfLearnAtStop(voice, { captureId: 'cap-1', label: 'local_2', posted: 3 })
    expect(voice.takeSelfLearnEmbeddings).toHaveBeenCalledWith(5)
    expect(learn).toEqual({ captureId: 'cap-1', body: { speaker_label: 'local_2', decision: 'mine', embeddings: Array(5).fill([0.1]) } })
  })

  it('posts nothing with no pending confirm, no Voice ID, no new samples, or another voice', () => {
    expect(selfLearnAtStop(take('local_2', 4), null)).toBeNull()
    expect(selfLearnAtStop(null, { captureId: 'cap-1', label: 'local_2', posted: 0 })).toBeNull()
    expect(selfLearnAtStop(take('local_2', 0), { captureId: 'cap-1', label: 'local_2', posted: 0 })).toBeNull()
    expect(selfLearnAtStop(take('local_3', 4), { captureId: 'cap-1', label: 'local_2', posted: 0 })).toBeNull()
    expect(selfLearnAtStop({ takeSelfLearnEmbeddings: () => null }, { captureId: 'cap-1', label: 'local_2', posted: 0 })).toBeNull()
  })
})
