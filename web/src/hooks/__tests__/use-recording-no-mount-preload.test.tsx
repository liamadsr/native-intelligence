// @vitest-environment jsdom
/**
 * useRecording() must NOT load the Voice ID model on mount.
 *
 * useRecording runs inside RecordingProvider, which wraps the whole
 * authenticated tree — so the old mount-time `VoiceIdService.preloadModel()`
 * spun up a Web Worker and pulled the ~100MB WavLM model on EVERY desktop
 * dashboard mount, including the overwhelming majority of sessions that never
 * record. Paired with stop()'s old worker pooling, the model then stayed
 * resident for the life of the WebContent process (a contributor to the
 * 948MB-after-7h heap).
 *
 * The model now loads lazily: VoiceIdService.initialize(), called on the
 * recording-start path, calls preloadModel() itself. This test mounts the REAL
 * hook (the heavy audio/ML deps are stubbed) and asserts preloadModel is never
 * called while merely mounted — on desktop, where the old effect was gated.
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

import { useRecording } from '../use-recording'

function Host() {
  useRecording()
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  preloadModel.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useRecording — no mount-time Voice ID preload', () => {
  it('does not call VoiceIdService.preloadModel when mounted on desktop', async () => {
    await act(async () => { root.render(h(Host)) })
    // Let every mount effect (audio-level/mic-fault listeners) settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(preloadModel).not.toHaveBeenCalled()
  })

  it('stays quiet across re-renders too (no effect re-fires it)', async () => {
    await act(async () => { root.render(h(Host)) })
    await act(async () => { root.render(h(Host)) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(preloadModel).not.toHaveBeenCalled()
  })
})
