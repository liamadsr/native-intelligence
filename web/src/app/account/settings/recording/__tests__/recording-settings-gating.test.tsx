// @vitest-environment jsdom
/**
 * Environment-gating contract for the Recording settings view.
 *
 * On production, real desktop users see Meeting Detection (the feature
 * shipped with the resident passive detector) and the live Permissions panel
 * (Microphone + System Audio Recording status, polled from the passive TCC
 * checks) — plus the page heading and subtitle. The diagnostic surface —
 * the Recording Test + Voice ID harness and System Requirements — stays
 * lower-environment-only. There is no microphone section: the desktop's
 * input-device priority list lives in the chat composer's mic picker.
 *
 * The view is desktop-only and pulls in heavy audio/ML modules, so we mock the
 * platform check, the Tauri bridge, and the Deepgram/Voice-ID services to mount
 * the desktop branch in jsdom without a real backend. We flip isLowerEnvironment
 * per test to assert both the production (hidden) and lower-env (shown) shapes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Toggleable environment gate.
let lowerEnv = false
vi.mock('@/lib/app-env', () => ({
  isLowerEnvironment: () => lowerEnv,
  isProductionEnvironment: () => !lowerEnv,
  getAppEnvironment: () => (lowerEnv ? 'preview' : 'production'),
}))

// Force the desktop branch.
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true, desktopOS: () => 'macos' }))

// The permissions panel's passive checks / requests — per-test controllable.
// vi.hoisted because vi.mock factories run above module-level consts.
const perm = vi.hoisted(() => ({
  checkMic: vi.fn<() => Promise<string>>(),
  requestMic: vi.fn<() => Promise<string>>(),
  checkSystem: vi.fn<() => Promise<string>>(),
  requestSystem: vi.fn<() => Promise<string>>(),
}))

// Local modules + the on-device transcription engine — per-test controllable.
// `modules` is what modules_list answers ([] = a desktop build without Local
// Modules); `prepare` is the mic test's engine selection; `startRecording` is
// start_recording's answer (transcriptionEngine).
const local = vi.hoisted(() => ({
  modules: [] as unknown[],
  prepare: vi.fn(),
  startRecording: vi.fn(),
}))

// Echo cancellation in captures — per-test controllable. `get` undefined
// models an older bridge/desktop without the setting.
const echo = vi.hoisted(() => ({
  get: undefined as undefined | (() => Promise<boolean>),
  set: vi.fn<(enabled: boolean) => Promise<void>>(),
}))
// The one meeting setting (Auto-record), per-test controllable.
const meetings = vi.hoisted(() => ({
  autoRecord: false,
  setAutoRecord: vi.fn<(enabled: boolean) => Promise<void>>(),
  enableDetection: vi.fn<(enabled: boolean) => Promise<void>>(),
}))
vi.mock('@/lib/local-transcription', () => ({
  prepareLocalTranscription: (...args: unknown[]) => local.prepare(...args),
  localFallbackMessage: () => 'fallback',
  trackLocalFallback: () => {},
  shiftSegmentTime: (s: unknown) => s,
}))

// Tauri bridge — every method the view touches at mount resolves to something inert.
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    get getEchoCancellationInCaptures() { return echo.get },
    setEchoCancellationInCaptures: (enabled: boolean) => echo.set(enabled),
    modulesList: async () => local.modules,
    onModuleStatus: async () => () => {},
    moduleEnable: async () => ({}),
    moduleDisable: async () => ({}),
    moduleRemoveAssets: async () => ({}),
    getMeetingDetectionState: async () => ({ state: 'monitoring', detectedApp: null, isAutoRecord: meetings.autoRecord, isEnabled: false }),
    onMeetingDetected: async () => () => {},
    onMeetingAutoStart: async () => () => {},
    onMeetingEnded: async () => () => {},
    onAudioLevel: async () => () => {},
    enableMeetingDetection: (enabled: boolean) => meetings.enableDetection(enabled),
    setAutoRecord: (enabled: boolean) => meetings.setAutoRecord(enabled),
    getStatus: async () => 'idle',
    startRecording: (...args: unknown[]) => local.startRecording(...args),
    stopRecording: async () => ({ sessionId: 's', micFile: null, systemFile: null, durationSeconds: 0 }),
    requestScreenCapturePermission: async () => 'granted',
    checkMicPermission: () => perm.checkMic(),
    requestMicPermission: () => perm.requestMic(),
    checkSystemAudioPermission: () => perm.checkSystem(),
    requestSystemAudioPermission: () => perm.requestSystem(),
  },
}))

// Heavy audio/ML deps — replace with inert stubs so no WASM/model loads in jsdom.
// preloadModel is a spy, not a no-op: visiting this page used to eagerly pull the
// ~100MB Voice ID model into a Web Worker (ungated — web visitors paid it too),
// and the "does not preload on mount" test below is what keeps it from coming
// back. vi.hoisted because vi.mock factories run above module-level consts.
//
// The mock models the REAL service's deferred load: initialize() resolves only
// when the test fires 'loaded', and stop() latches `stopped` so a late-resolving
// initialize() terminates the worker it was about to claim instead of claiming
// it (voice-id-service.ts does exactly this). `voiceIdInstances` exposes every
// service the view built so a test can assert on the one it stopped mid-load.
const { preloadModelSpy, voiceIdStopSpy, voiceIdInstances, fireModelLoaded, autoLoad } =
  vi.hoisted(() => {
    const instances: {
      stopped: boolean
      workerTerminated: boolean
      settleInit: () => void
    }[] = []
    return {
      preloadModelSpy: vi.fn(),
      voiceIdStopSpy: vi.fn(),
      voiceIdInstances: instances,
      // Settle every pending initialize() — i.e. the model finished loading.
      // Resolves for a live service, rejects for a stopped one (see the mock).
      fireModelLoaded: () => { for (const i of instances) i.settleInit() },
      // Most tests don't care about the load window: with autoLoad.on the
      // service resolves initialize() immediately, as it did before.
      autoLoad: { on: true },
    }
  })
vi.mock('@/lib/voice-id-service', () => ({
  VoiceIdService: class {
    static preloadModel = preloadModelSpy
    static clearModelCache() { return Promise.resolve() }
    autoAcceptDelaySec = 10
    onSpeakerIdentified: unknown = null
    onSpeakerSuggested: unknown = null
    onSelfVerified: unknown = null
    onSelfDemoted: unknown = null
    /** Mirrors the real service's stop() latch. */
    stopped = false
    /** True once this service's ~100MB model worker has been terminated. */
    workerTerminated = false
    settleInit: () => void = () => {}
    constructor() {
      voiceIdInstances.push(this as unknown as (typeof voiceIdInstances)[number])
    }
    initialize() {
      return new Promise<void>((resolve, reject) => {
        this.settleInit = () => {
          // The real initialize() checks the latch after awaiting the preload:
          // if stop() ran first it terminates the freshly-loaded worker and
          // THROWS ('Voice ID service stopped before the model finished
          // loading', voice-id-service.ts) rather than attaching the worker to
          // a dead service. Rejecting here — not resolving — is what routes the
          // late settle into the view's .catch(), where the
          // `voiceIdRef.current !== voiceId` guard has to hold.
          if (this.stopped) {
            this.workerTerminated = true
            reject(new Error('Voice ID service stopped before the model finished loading'))
            return
          }
          this.workerTerminated = false
          resolve()
        }
        if (autoLoad.on) this.settleInit()
      })
    }
    loadEnrollments() {
      // The real one rejects once stopped — initialize() throws first.
      return this.stopped
        ? Promise.reject(new Error('Voice ID service stopped before the model finished loading'))
        : Promise.resolve()
    }
    loadSelfProfile() { return Promise.resolve() }
    feedAudio() {}
    onFinalSegment() {}
    getAssignments() { return [] }
    getEmbeddingCount() { return 0 }
    stop(...args: unknown[]) {
      this.stopped = true
      this.workerTerminated = true
      voiceIdStopSpy(...args)
    }
  },
  getTrustTier: () => 'learning',
  getTrustTierLabel: () => 'Learning',
  getNextTierThreshold: () => 3,
}))
vi.mock('@/lib/deepgram-stream', () => ({
  DeepgramStreamingService: class {
    onAudioData: unknown = null
    getUsageAuthHeader: unknown = null
    start() { return Promise.resolve() }
    stop() {}
  },
  TranscriptMerger: class { clear() {} addSegment() { return [] } },
}))
vi.mock('@/components/desktop/speaker-contact-search', () => ({
  SpeakerContactSearch: ({ children }: { children?: unknown }) => children ?? null,
}))
vi.mock('@/components/desktop/audio-level-meter', () => ({
  AudioLevelMeter: () => null,
}))

import { RecordingSettingsView } from '../recording-settings-view'

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount() {
  await act(async () => { root.render(h(RecordingSettingsView)) })
  // Let the mount effects (isDesktop check, device load) settle.
  await flush()
  await flush()
}

function text(): string {
  return container.textContent || ''
}

beforeEach(() => {
  echo.get = undefined
  echo.set.mockReset().mockResolvedValue(undefined)
  meetings.autoRecord = false
  meetings.setAutoRecord.mockReset().mockResolvedValue(undefined)
  meetings.enableDetection.mockReset().mockResolvedValue(undefined)
  local.modules = []
  local.prepare.mockReset().mockResolvedValue({ service: null, fallbackReason: null })
  local.startRecording.mockReset().mockResolvedValue(undefined)
  perm.checkMic.mockReset().mockResolvedValue('granted')
  perm.requestMic.mockReset().mockResolvedValue('granted')
  perm.checkSystem.mockReset().mockResolvedValue('granted')
  perm.requestSystem.mockReset().mockResolvedValue('granted')
  preloadModelSpy.mockClear()
  voiceIdStopSpy.mockClear()
  voiceIdInstances.length = 0
  autoLoad.on = true
  delete (window as unknown as { __voiceId?: unknown }).__voiceId
  // Stub fetch (voice-enrollments, deepgram token) so effects don't hit the network.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ enrollments: [], token: 'dg-test-token' }),
  })) as unknown as typeof fetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RecordingSettingsView — environment gating', () => {
  it('production: shows meeting detection + the permissions panel; hides diagnostics', async () => {
    lowerEnv = false
    await mount()
    const t = text()

    // Kept for production desktop users: the permissions panel (both rows,
    // each showing a status or the control that moves it forward)…
    expect(t).toContain('Permissions')
    expect(t).toContain('System Audio Recording') // the permission
    const micRow = container.querySelector('[data-testid="permission-row-microphone"]')
    const systemRow = container.querySelector('[data-testid="permission-row-system-audio"]')
    expect(micRow?.textContent).toMatch(/allow|open system settings|granted|request/i)
    expect(systemRow?.textContent).toMatch(/allow|open system settings|granted|request/i)
    // …and the one meeting setting (desktop-only): Auto-record. Detecting
    // meetings is not a setting any more.
    expect(t).toContain('Meetings')
    expect(t).toContain('Auto-record meetings')
    expect(t).not.toContain('Detect meetings automatically')
    // Desktop subtitle.
    expect(t).toContain('Choose how meetings are recorded, and grant audio permissions')

    // Diagnostics stay hidden in production.
    expect(t).not.toContain('Audio Input')
    expect(t).not.toContain('Select which microphone')
    expect(t).not.toContain('Recording Test')
    expect(t).not.toContain('Start Test Recording')
    expect(t).not.toContain('Transcription Configuration')
    expect(t).not.toContain('Voice ID Model')
    expect(t).not.toContain('Voice ID auto-accept delay')
    expect(t).not.toContain('System Requirements')
  })

  it('lower environment: shows all sections', async () => {
    lowerEnv = true
    await mount()
    const t = text()

    // The permission stays visible…
    expect(t).toContain('System Audio Recording')
    // …and the desktop subtitle + every section appears.
    expect(t).toContain('Choose how meetings are recorded, and grant audio permissions')
    expect(t).not.toContain('Audio Input')
    expect(t).toContain('Auto-record meetings')
    expect(t).not.toContain('Detect meetings automatically')
    expect(t).toContain('Recording Test')
    expect(t).toContain('Start Test Recording')
    expect(t).toContain('Transcription Configuration')
    expect(t).toContain('Voice ID Model')
    expect(t).toContain('System Requirements')
  })

  it('the System Audio Recording permission row is present in BOTH environments (exactly once)', async () => {
    for (const env of [false, true]) {
      lowerEnv = env
      await act(async () => { root.render(h(RecordingSettingsView)) })
      await flush(); await flush()
      const permissionLabels = [...container.querySelectorAll('p')].filter((p) => /^System Audio Recording$/.test((p.textContent || '').trim()))
      expect(permissionLabels).toHaveLength(1)
    }
  })
})

describe('RecordingSettingsView — the permissions panel is live', () => {
  /**
   * After a denial macOS never re-prompts; the only fix is a toggle in System
   * Settings, which the page can't observe directly. The panel re-reads the
   * passive checks every 1.5s, so the row flips to Granted on its own when the
   * user comes back — no click, and no request command on the way.
   */
  it('a denied system audio row flips to Granted on the next poll tick after the Settings toggle', async () => {
    vi.useFakeTimers()
    lowerEnv = false
    perm.checkSystem.mockResolvedValue('denied')
    await mount()

    const row = () => container.querySelector('[data-testid="permission-row-system-audio"]')!
    expect(row().textContent).toContain('Denied')
    const openSettings = [...row().querySelectorAll('button')].find((b) =>
      /open system settings/i.test(b.textContent || ''),
    )
    expect(openSettings).toBeTruthy()

    // The user turns Dial8 on under Screen & System Audio Recording.
    perm.checkSystem.mockResolvedValue('granted')
    await act(async () => { vi.advanceTimersByTime(1500) })
    await flush()

    expect(row().textContent).toContain('Granted')
    expect(row().textContent).not.toContain('Denied')
    expect(row().querySelector('button')).toBeNull()
    expect(perm.requestSystem).not.toHaveBeenCalled()
  })
})

describe('RecordingSettingsView — no mount-time Voice ID preload', () => {
  /**
   * This page used to call VoiceIdService.preloadModel() from its mount effect,
   * so merely opening Settings → Recording downloaded/instantiated the ~100MB
   * WavLM model in a Web Worker — with no isDesktopApp() gate, so web visitors
   * paid it too. The model now loads only when something actually needs it:
   * initialize() on the lower-env test recorder's explicit Start click, or a
   * real recording. Both environments are asserted because the old call sat
   * outside every environment gate.
   */
  for (const [label, env] of [['production', false], ['lower environment', true]] as const) {
    it(`does not preload the Voice ID model on mount (${label})`, async () => {
      lowerEnv = env
      await mount()

      expect(preloadModelSpy).not.toHaveBeenCalled()
    })
  }
})

describe('RecordingSettingsView — the console debug handle is released on stop', () => {
  /**
   * The lower-env test recorder parks the live VoiceIdService on
   * window.__voiceId so `window.__voiceId.getStats()` works in the console.
   * It used to be assigned and never cleared, so the stopped service — and the
   * two 60s/16kHz Float32 ring buffers it owns (~7.7MB) — stayed reachable
   * from a global for the life of the page, surviving every later recording.
   * Stopping must drop the handle along with the ref.
   */
  function findButton(re: RegExp): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => re.test(b.textContent || '')) as
      | HTMLButtonElement
      | undefined
  }

  it('clears window.__voiceId when the test recording stops', async () => {
    lowerEnv = true
    await mount()

    const start = findButton(/Start Test Recording/i)
    expect(start).toBeTruthy()
    await act(async () => { start!.click() })
    await flush(); await flush()

    // The debug handle is live while recording (that is the point of it).
    expect((window as unknown as { __voiceId?: unknown }).__voiceId).toBeDefined()

    const stop = findButton(/^\s*Stop\s*$/i)
    expect(stop).toBeTruthy()
    await act(async () => { stop!.click() })
    await flush(); await flush()

    expect(voiceIdStopSpy).toHaveBeenCalled()
    // …and nothing pins the stopped service afterwards.
    expect((window as unknown as { __voiceId?: unknown }).__voiceId).toBeUndefined()
  })
})

describe('RecordingSettingsView — stopping during the Voice ID model load', () => {
  /**
   * The model load takes 1-2s even warm, and the recorder deliberately does not
   * block recording start on it. The service used to be published into
   * voiceIdRef ONLY in initialize()'s late .then(), so a stop inside that window
   * found voiceIdRef.current still null:
   *
   *   - stop() never ran on the loading service, so its `stopped` latch (the
   *     one thing that tells a late-resolving initialize() to terminate rather
   *     than claim the freshly-loaded worker) was never set → a live ~100MB
   *     WavLM worker attached to a service nothing could reach, for the life of
   *     the page;
   *   - the late .then() then re-published window.__voiceId and flipped the
   *     "Voice ID active" indicator back on, after the user had stopped.
   *
   * The service is now published BEFORE initialize(), and the late .then()
   * publishes nothing unless the ref still points at it.
   */
  function findButton(re: RegExp): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => re.test(b.textContent || '')) as
      | HTMLButtonElement
      | undefined
  }

  it('stop before the model loads terminates the worker and the late load claims nothing', async () => {
    lowerEnv = true
    autoLoad.on = false // hold initialize() pending — the model is still loading
    await mount()

    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()

    // Recording is live, the service exists, but the model has not landed.
    expect(voiceIdInstances).toHaveLength(1)
    const voiceId = voiceIdInstances[0]
    expect(voiceId.stopped).toBe(false)

    // Stop while the model is STILL loading — this is the whole scenario.
    await act(async () => { findButton(/^\s*Stop\s*$/i)!.click() })
    await flush(); await flush()

    // stop() reached the loading service (it was null here before the fix, so
    // nothing was stopped and the latch was never set).
    expect(voiceIdStopSpy).toHaveBeenCalled()
    expect(voiceId.stopped).toBe(true)

    // Now the model finishes loading, late.
    await act(async () => { fireModelLoaded() })
    await flush(); await flush()

    // The late claim terminates the worker instead of attaching it to the dead
    // service, and re-publishes nothing.
    expect(voiceId.workerTerminated).toBe(true)
    expect((window as unknown as { __voiceId?: unknown }).__voiceId).toBeUndefined()
    // "Voice ID active" must not come back on after the user stopped.
    expect(text()).not.toContain('Voice ID active')
    expect(text()).not.toContain('Loaded')
  })

  it('a superseded service\u2019s late rejection does not clear the new recording\u2019s state', async () => {
    // start \u2192 stop \u2192 start again, with BOTH model loads still pending. The
    // first service is stopped, so its initialize() rejects late (the real one
    // throws once the `stopped` latch is set). That rejection lands in the
    // shared .catch(), which without the `voiceIdRef.current !== voiceId` guard
    // would null the ref, delete window.__voiceId and setVoiceIdReady(false) \u2014
    // tearing down the SECOND, healthy recording's state.
    lowerEnv = true
    autoLoad.on = false
    await mount()

    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()
    expect(voiceIdInstances).toHaveLength(1)
    const first = voiceIdInstances[0]

    await act(async () => { findButton(/^\s*Stop\s*$/i)!.click() })
    await flush(); await flush()
    expect(first.stopped).toBe(true)

    // Second recording starts while the first's model load is still in flight.
    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()
    expect(voiceIdInstances).toHaveLength(2)
    const second = voiceIdInstances[1]
    expect(second).not.toBe(first)
    expect((window as unknown as { __voiceId?: unknown }).__voiceId).toBe(second)

    // Both loads land: the first REJECTS (stopped latch), the second resolves.
    await act(async () => { fireModelLoaded() })
    await flush(); await flush()

    // The stale rejection claimed nothing and cleared nothing.
    expect(first.workerTerminated).toBe(true)
    expect(second.stopped).toBe(false)
    expect((window as unknown as { __voiceId?: unknown }).__voiceId).toBe(second)
    // The new recording's model really did land \u2014 the indicator is on.
    expect(text()).toContain('Loaded')
  })

  it('the console handle is live while the model is still loading', async () => {
    // The flip side of publishing early: the ref owns the service from the
    // start, so a mid-load assignContact/stop reaches the real service rather
    // than being dropped on the floor.
    lowerEnv = true
    autoLoad.on = false
    await mount()

    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()

    expect((window as unknown as { __voiceId?: unknown }).__voiceId).toBe(voiceIdInstances[0])
  })
})

describe('RecordingSettingsView — Local transcription (desktop local-stt module)', () => {
  /**
   * The row exists only when THIS desktop build ships the on-device engine:
   * modules_list must include local-stt. An older desktop (no modules_list →
   * []) and the browser (the view's early return) never show it — so the web
   * can deploy before the desktop does.
   */
  const stt = {
    id: 'local-stt', version: '97a15af', enabled: false, state: 'off', progress: null,
    downloadBytes: 807_000_000, assetsPresent: false, error: null,
  }

  for (const [label, env] of [['production', false], ['lower environment', true]] as const) {
    it(`is hidden on a desktop build without Local Modules (${label})`, async () => {
      lowerEnv = env
      local.modules = []
      await mount()
      expect(text()).not.toContain('Local transcription')
      expect(container.querySelector('[data-testid="local-module-row-local-stt"]')).toBeNull()
    })

    it(`shows the Local transcription row when the desktop has local-stt (${label})`, async () => {
      lowerEnv = env
      local.modules = [stt]
      await mount()
      const row = container.querySelector('[data-testid="local-module-row-local-stt"]')
      expect(row).not.toBeNull()
      const t = row!.textContent || ''
      expect(t).toContain('Local transcription')
      expect(t).toContain('Beta')
      expect(t).toContain('Meeting audio never leaves your device. Free and unlimited.')
      expect(t).toContain('Downloads automatically (~800 MB).')
      expect(t).not.toContain('Recommended for Macs with 16 GB+ memory')
      // NVIDIA credit: the models and their licenses, linked to the license
      // pages the desktop's bundled notices use.
      expect(t).toContain(
        'Speech models by NVIDIA — Nemotron Speech Streaming (NVIDIA Open Model License) and Nemotron 3 Diarization (OpenMDW-1.1)',
      )
      const licenseLinks = [...row!.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
      expect(licenseLinks).toEqual([
        ['NVIDIA Open Model License', 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'],
        ['OpenMDW-1.1', 'https://openmdw.ai/license/1-1/'],
      ])
      // Not a choice: it downloads and is used on its own.
      expect(row!.querySelector('[role="switch"]')).toBeNull()
    })
  }

  function findButton(re: RegExp): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => re.test(b.textContent || '')) as
      | HTMLButtonElement
      | undefined
  }

  const fetchedUrls = () =>
    (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))

  it('the test recorder transcribes on-device when local-stt is ready: no Deepgram token', async () => {
    lowerEnv = true
    const fake = { engine: 'local', start: vi.fn(), stop: vi.fn(async () => {}), setFallbackHandler: vi.fn(), onAudioData: undefined }
    local.prepare.mockResolvedValue({ service: fake, fallbackReason: null })
    local.startRecording.mockResolvedValue({ sessionId: 's', transcriptionEngine: 'local' })
    await mount()

    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()

    expect(local.startRecording).toHaveBeenCalledWith(expect.objectContaining({ transcription: 'local' }))
    // Bound to the native session start_recording answered with.
    expect(fake.start).toHaveBeenCalledWith('s')
    expect(fake.setFallbackHandler).toHaveBeenCalled()
    expect(fetchedUrls()).not.toContain('/api/deepgram-token')

    await act(async () => { findButton(/^\s*Stop\s*$/i)!.click() })
    await flush(); await flush()
    expect(fake.stop).toHaveBeenCalled()
  })

  it('falls back to Deepgram when the desktop answers without the local engine', async () => {
    lowerEnv = true
    const fake = { engine: 'local', start: vi.fn(), stop: vi.fn(async () => {}), setFallbackHandler: vi.fn() }
    local.prepare.mockResolvedValue({ service: fake, fallbackReason: null })
    local.startRecording.mockResolvedValue({ sessionId: 's' }) // older answer: no transcriptionEngine
    await mount()

    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()

    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.stop).toHaveBeenCalledWith({ drainTail: false })
    expect(fetchedUrls()).toContain('/api/deepgram-token')
  })

  it('without the module, the recorder starts exactly as before (no transcription arg)', async () => {
    lowerEnv = true
    await mount()
    await act(async () => { findButton(/Start Test Recording/i)!.click() })
    await flush(); await flush()
    expect(local.startRecording).toHaveBeenCalledWith({ captureSystemAudio: true })
    expect(fetchedUrls()).toContain('/api/deepgram-token')
  })
})

describe('RecordingSettingsView — no choices that needn\'t be (Liam, 2026-10-08)', () => {
  it('has no echo cancellation switch: captures always run it while system audio is captured', async () => {
    lowerEnv = false
    echo.get = vi.fn(async () => false)
    local.modules = [{
      id: 'local-stt', version: '97a15af', enabled: true, state: 'ready', progress: null,
      downloadBytes: 807_000_000, assetsPresent: true, error: null,
    }]
    await mount()
    expect(container.querySelector('[data-testid="echo-cancellation-row"]')).toBeNull()
    expect(text()).not.toContain('Echo cancellation')
    // The page doesn't touch the setting (the desktop set-up keeps it on).
    expect(echo.set).not.toHaveBeenCalled()
  })

  it('one meeting switch, Auto-record: it shows the setting and writes it, whatever detection says', async () => {
    lowerEnv = false
    meetings.autoRecord = true
    await mount()
    const row = container.querySelector('[data-testid="auto-record-row"]')!
    expect(row.textContent).toContain('Auto-record meetings')
    expect(row.textContent).toContain('When off, Dial8 asks before it records.')
    const toggle = row.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    // Never disabled (detection is always on, not a setting).
    expect(toggle.disabled).toBe(false)
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1)

    await act(async () => { toggle.click() })
    await flush()
    expect(meetings.setAutoRecord).toHaveBeenCalledWith(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(meetings.enableDetection).not.toHaveBeenCalled()
  })
})
