// @vitest-environment jsdom
/**
 * Enrollment flow — the step gating and the model-load gate.
 *
 * The recorder and the private embedder are fully mocked (no getUserMedia, no
 * WavLM), so the test drives the wizard purely through the controllable mock
 * state:
 *   • intro CTA is disabled ("Getting ready…") until the embedder acks loaded;
 *   • mic-check advances to passage 1 only once speech is detected;
 *   • a passage's Continue is disabled on thin audio (below the target seconds)
 *     and enabled once the voiced-seconds gate is met.
 *
 * We do NOT exercise the real chunker/embedder here — those have their own unit
 * tests. This locks the wizard's advance seams.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// framer-motion — render children directly (no exit-hold), drop animation props,
// so AnimatePresence step swaps are instant in jsdom (the repo's standard stub).
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          const { initial, animate, exit, transition, ...rest } = props as Record<string, unknown>
          void initial
          void animate
          void exit
          void transition
          return React.createElement(tag, rest)
        },
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children),
  }
})

// ── Controllable recorder mock ──────────────────────────────
const rec = vi.hoisted(() => ({
  level: 0,
  recording: false,
  error: null as string | null,
  speechDetected: false,
  passageVoicedSeconds: 0,
  passageSampleCount: 0,
  start: vi.fn(async (_deviceId?: string) => true),
  stop: vi.fn(),
  openDeviceId: vi.fn((): string | undefined => undefined),
  measureNoiseFloor: vi.fn(() => 0.004),
  // Faithful to the real hook: starting a passage resets the voiced tally to 0.
  beginPassage: vi.fn(() => {
    rec.passageVoicedSeconds = 0
    rec.passageSampleCount = 0
  }),
  // Non-destructive snapshot — empty here (this suite drives gating via
  // voicedSeconds, not real audio; the incremental effect no-ops on 0 samples).
  snapshotPassageAudio: vi.fn(() => new Float32Array(0)),
  endPassage: vi.fn(() => new Float32Array(0)),
  clearError: vi.fn(),
}))

vi.mock('@/components/voice-enrollment/use-voice-recorder', () => ({
  useVoiceRecorder: () => rec,
}))

// ── Embedder mock: load resolves on demand ──────────────────
const embed = vi.hoisted(() => ({
  loadResolve: null as null | (() => void),
  loadCalls: 0,
  terminated: false,
}))

vi.mock('@/lib/voice-profile/enrollment-embedder', () => ({
  EnrollmentEmbedder: class {
    load() {
      embed.loadCalls++
      return new Promise<void>((resolve) => {
        embed.loadResolve = resolve
      })
    }
    embed() {
      return Promise.resolve(new Array(512).fill(0.1))
    }
    terminate() {
      embed.terminated = true
    }
  },
}))

// celebrate + overlay are inert in the test.
vi.mock('@/components/celebration/celebrate', () => ({ celebrate: vi.fn() }))
vi.mock('@/components/celebration/celebration-overlay', () => ({
  CelebrationOverlay: () => null,
}))

// Next router.
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

// Shared voice-profile hook.
vi.mock('@/hooks/use-voice-profile', () => ({
  useVoiceProfile: () => ({ status: null, loading: false, refresh: vi.fn() }),
}))

// The desktop's chosen mic mapped to a webview deviceId (undefined = default).
// `lookups` queues per-call answers (e.g. labels hidden, then visible); once
// it's empty every lookup answers `deviceId`.
type MicLookup = { deviceId: string | undefined; labelsHidden: boolean }
const mic = vi.hoisted(() => ({
  deviceId: undefined as string | undefined,
  lookups: [] as MicLookup[],
  calls: 0,
}))
vi.mock('@/lib/desktop-mic-device', () => ({
  desktopActiveMic: async () => {
    mic.calls++
    return mic.lookups.shift() ?? { deviceId: mic.deviceId, labelsHidden: false }
  },
}))

import { VoiceEnrollmentFlow } from '../voice-enrollment-flow'
import { isReadAloudHeld } from '@/lib/read-aloud/mic-guard'

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function text() {
  return container.textContent || ''
}

/** Re-render to reflect updated mock state (the mock returns the same object,
 *  so React needs a state change to re-read it — we trigger one by re-rendering). */
function rerender() {
  act(() => root.render(h(VoiceEnrollmentFlow)))
}

beforeEach(() => {
  rec.level = 0
  rec.recording = false
  rec.error = null
  rec.speechDetected = false
  rec.passageVoicedSeconds = 0
  rec.passageSampleCount = 0
  rec.start.mockClear()
  rec.clearError.mockClear()
  rec.stop.mockClear()
  rec.openDeviceId.mockReset()
  rec.openDeviceId.mockReturnValue(undefined)
  mic.deviceId = undefined
  mic.lookups = []
  mic.calls = 0
  rec.beginPassage.mockClear()
  rec.snapshotPassageAudio.mockClear()
  rec.snapshotPassageAudio.mockReturnValue(new Float32Array(0))
  rec.endPassage.mockReset()
  rec.endPassage.mockReturnValue(new Float32Array(0))
  embed.loadResolve = null
  embed.loadCalls = 0
  embed.terminated = false
  router.push.mockReset()
  router.back.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch,
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function findCTA(re: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => re.test(b.textContent || '')) as
    | HTMLButtonElement
    | undefined
}

describe('VoiceEnrollmentFlow — model-load gate', () => {
  it('disables the intro CTA until the embedder loads, then enables it', async () => {
    act(() => root.render(h(VoiceEnrollmentFlow)))
    await flush()
    expect(text()).toContain('Teach Native Intelligence your voice')
    // Before the load ack: the CTA reads "Getting ready…" and is disabled.
    const gettingReady = findCTA(/getting ready/i)
    expect(gettingReady).toBeTruthy()
    expect(gettingReady!.disabled).toBe(true)
    expect(embed.loadCalls).toBe(1)

    // Ack the load.
    await act(async () => {
      embed.loadResolve?.()
      await Promise.resolve()
    })
    await flush()

    const go = findCTA(/let’s do it|let's do it/i)
    expect(go).toBeTruthy()
    expect(go!.disabled).toBe(false)
  })
})

describe('VoiceEnrollmentFlow — mic-check → passage gating', () => {
  async function reachPassage() {
    act(() => root.render(h(VoiceEnrollmentFlow)))
    await flush()
    await act(async () => {
      embed.loadResolve?.()
      await Promise.resolve()
    })
    await flush()
    // Start → mic-check.
    const go = findCTA(/let’s do it|let's do it/i)
    await act(async () => {
      go!.click()
      await Promise.resolve()
    })
    await flush()
    expect(rec.start).toHaveBeenCalled()
    expect(text()).toContain('check your mic')

    // Speech detected → advance to passage 1.
    rec.recording = true
    rec.speechDetected = true
    rerender()
    await flush()
  }

  it('holds read-aloud off while the mic records, and releases it on unmount', async () => {
    act(() => root.render(h(VoiceEnrollmentFlow)))
    await flush()
    expect(isReadAloudHeld()).toBe(false) // intro: the mic is not open yet
    await reachPassage()
    expect(isReadAloudHeld()).toBe(true)
    act(() => root.unmount())
    expect(isReadAloudHeld()).toBe(false)
    root = createRoot(container) // for afterEach
  })

  it('advances to passage 1 once speech is detected and begins accumulating', async () => {
    await reachPassage()
    expect(rec.beginPassage).toHaveBeenCalled()
    // The story's first passage text is on screen.
    expect(text()).toContain('octopus named Pixel')
  })

  it('keeps Continue disabled on thin audio (below the voiced-seconds gate)', async () => {
    await reachPassage()

    // Thin audio: below the 15s target → the CTA reads "Keep reading…" and is
    // disabled. (Auto-advance only fires once the gate is met.)
    rec.passageVoicedSeconds = 3
    rec.recording = true
    rerender()
    await flush()
    const thin = findCTA(/continue|keep reading/i)
    expect(thin).toBeTruthy()
    expect(thin!.disabled).toBe(true)
    // Never auto-advanced on thin audio.
    expect(rec.endPassage).not.toHaveBeenCalled()
  })

  it('offers a clean bail after the retry cap when takes stay thin', async () => {
    await reachPassage()
    // endPassage returns empty audio → the real chunker yields zero chunks →
    // every take fails and re-reads (beginPassage resets voicedSecs to 0, so we
    // re-arm the gate each attempt to simulate a fresh read hitting 15s).
    rec.recording = true
    rec.endPassage.mockReturnValue(new Float32Array(0))

    for (let i = 0; i < 3; i++) {
      // Re-arm: a fresh read reaches the voiced-seconds gate → auto-advance.
      rec.passageVoicedSeconds = 16
      rerender()
      await flush()
      await flush()
      // Still on passage 1 (never advanced past a failed take).
      expect(text()).toContain('octopus named Pixel')
    }

    // Cap hit → the escape appears. Aggregate is 0 chunks (< min), so only the
    // clean bail is offered, not "Use it anyway".
    rerender()
    await flush()
    expect(text()).toContain('Try again later')
    expect(text()).not.toContain('Use it anyway')

    const bail = findCTA(/try again later/i)
    await act(async () => {
      bail!.click()
      await Promise.resolve()
    })
    expect(router.push).toHaveBeenCalledWith('/account/settings/voice')
    // Nothing was ever POSTed — abandonment is clean.
    const posted = (fetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls ?? []
    expect(posted.length).toBe(0)
  })
})

describe('VoiceEnrollmentFlow — which mic (desktop input priority)', () => {
  async function startMicCheck() {
    act(() => root.render(h(VoiceEnrollmentFlow)))
    await flush()
    await act(async () => {
      embed.loadResolve?.()
      await Promise.resolve()
    })
    await flush()
    const go = findCTA(/let’s do it|let's do it/i)
    await act(async () => {
      go!.click()
      await Promise.resolve()
    })
    await flush()
    await flush()
  }

  it('no mapped device → the default mic', async () => {
    await startMicCheck()
    expect(rec.start.mock.calls).toEqual([[]])
  })

  it('opens the desktop-chosen device by its webview deviceId', async () => {
    mic.deviceId = 'webview-airpods'
    await startMicCheck()
    expect(rec.start.mock.calls).toEqual([['webview-airpods']])
  })

  it('falls back to the default when the chosen device will not open', async () => {
    mic.deviceId = 'webview-airpods'
    rec.start.mockResolvedValueOnce(false)
    await startMicCheck()
    expect(rec.start.mock.calls).toEqual([['webview-airpods'], []])
    expect(rec.clearError).toHaveBeenCalledTimes(1)
  })

  // WebKit hides labels until the document has opened a mic, and enrollment
  // is the desktop document's first getUserMedia: the first lookup can't
  // match. Open the default, look again, and switch to the chosen device.
  it('labels hidden on the first lookup → default first, then switches to the chosen device', async () => {
    mic.lookups = [
      { deviceId: undefined, labelsHidden: true },
      { deviceId: 'webview-usb', labelsHidden: false },
    ]
    rec.openDeviceId.mockReturnValue('webview-macbook')
    await startMicCheck()
    expect(mic.calls).toBe(2)
    expect(rec.start.mock.calls).toEqual([[], ['webview-usb']])
    expect(rec.stop).toHaveBeenCalledTimes(1)
  })

  it('labels hidden, but the default already is the chosen device → no reopen', async () => {
    mic.lookups = [
      { deviceId: undefined, labelsHidden: true },
      { deviceId: 'webview-usb', labelsHidden: false },
    ]
    rec.openDeviceId.mockReturnValue('webview-usb')
    await startMicCheck()
    expect(rec.start.mock.calls).toEqual([[]])
    expect(rec.stop).not.toHaveBeenCalled()
  })

  it('labels hidden, then the chosen device will not open → back to the default', async () => {
    mic.lookups = [
      { deviceId: undefined, labelsHidden: true },
      { deviceId: 'webview-usb', labelsHidden: false },
    ]
    rec.openDeviceId.mockReturnValue('webview-macbook')
    rec.start.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await startMicCheck()
    expect(rec.start.mock.calls).toEqual([[], ['webview-usb'], []])
    expect(rec.clearError).toHaveBeenCalledTimes(1)
  })

  it('labels hidden and still no match after the mic opens → stays on the default', async () => {
    mic.lookups = [{ deviceId: undefined, labelsHidden: true }]
    rec.openDeviceId.mockReturnValue('webview-macbook')
    await startMicCheck()
    expect(mic.calls).toBe(2)
    expect(rec.start.mock.calls).toEqual([[]])
    expect(rec.stop).not.toHaveBeenCalled()
  })

  it('labels visible and no match → one lookup, the default, no second look', async () => {
    mic.lookups = [{ deviceId: undefined, labelsHidden: false }]
    await startMicCheck()
    expect(mic.calls).toBe(1)
    expect(rec.start.mock.calls).toEqual([[]])
  })
})
