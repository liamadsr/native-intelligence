import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModuleInfo } from '@/lib/tauri-bridge'
import {
  LocalModulesKeeper,
  MAX_AUTO_RETRIES,
  RETRY_DELAYS_MS,
  retryClass,
  STALL_CHECK_MS,
  STALL_MS,
  type KeeperDeps,
} from '@/lib/local-modules-keeper'

const STT = 'local-stt'
const TTS = 'local-tts'

function info(id: string, over: Partial<LocalModuleInfo> = {}): LocalModuleInfo {
  return {
    id,
    version: '2026-09-25',
    enabled: false,
    state: 'off',
    progress: null,
    downloadBytes: id === STT ? 806_885_088 : 144_227_442,
    assetsPresent: false,
    error: null,
    ...over,
  }
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A desktop that does what the real one does with enable/disable, and lets
 *  the test push module://status events. Events land a tick after the
 *  command that caused it, as Tauri delivers them (never inside the call). */
function fakeDesktop(initial: LocalModuleInfo[]) {
  const modules = new Map(initial.map((m) => [m.id, m]))
  const listeners = new Set<(i: LocalModuleInfo) => void>()
  const online = new Set<() => void>()
  const tracked: Array<[string, Record<string, unknown>]> = []
  const emit = (next: LocalModuleInfo) => {
    modules.set(next.id, next)
    void Promise.resolve().then(() => {
      for (const l of [...listeners]) l(next)
    })
  }
  const deps: KeeperDeps = {
    list: vi.fn(async () => [...modules.values()]),
    enable: vi.fn(async (id: string) => {
      const cur = modules.get(id)!
      const next =
        cur.state === 'off' || cur.state === 'error'
          ? { ...cur, enabled: true, state: 'downloading' as const, progress: 0, error: null }
          : { ...cur, enabled: true }
      emit(next)
      return next
    }),
    disable: vi.fn(async (id: string) => {
      const next = { ...modules.get(id)!, enabled: false, state: 'off' as const, progress: null, error: null }
      emit(next)
      return next
    }),
    onStatus: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onOnline: (cb) => {
      online.add(cb)
      return () => online.delete(cb)
    },
    now: () => Date.now(),
    track: (event, props) => void tracked.push([event, props]),
  }
  return {
    deps,
    tracked,
    emit: async (id: string, over: Partial<LocalModuleInfo>) => {
      emit({ ...modules.get(id)!, ...over })
      await settle()
    },
    goOnline: () => {
      for (const cb of [...online]) cb()
    },
    get: (id: string) => modules.get(id)!,
  }
}

const enabledIds = (d: ReturnType<typeof fakeDesktop>) => vi.mocked(d.deps.enable).mock.calls.map((c) => c[0])

let keeper: LocalModulesKeeper | null = null

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  keeper?.stop()
  keeper = null
  vi.useRealTimers()
})

async function start(desktop: ReturnType<typeof fakeDesktop>, opts: { recording?: boolean } = {}) {
  keeper = new LocalModulesKeeper(desktop.deps)
  if (opts.recording) keeper.setRecording(true)
  keeper.start()
  await settle()
  return keeper
}

const ttsReady = () => info(TTS, { enabled: true, state: 'ready', assetsPresent: true })

describe('sets up on-device speech with nothing to choose', () => {
  it('turns read-aloud on first, then transcription once read-aloud is downloaded (events land a tick late)', async () => {
    const d = fakeDesktop([info(TTS), info(STT)])
    await start(d)
    // Both were off in the same list; only read-aloud was turned on.
    expect(enabledIds(d)).toEqual([TTS])

    // Still downloading, then verifying a file: transcription waits.
    await d.emit(TTS, { progress: 0.5 })
    await d.emit(TTS, { state: 'verifying', progress: 0.9 })
    expect(enabledIds(d)).toEqual([TTS])

    // Read-aloud is in (warming up): transcription starts.
    await d.emit(TTS, { state: 'warming', progress: null })
    expect(enabledIds(d)).toEqual([TTS, STT])
    expect(d.tracked.map(([e, p]) => `${e}:${p.module}`)).toEqual([
      `local_module_auto_download_started:${TTS}`,
      `local_module_auto_download_started:${STT}`,
    ])
  })

  it('is not a choice: a model found off is turned on, even one switched off under the old setting', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: false, state: 'off', assetsPresent: true })])
    await start(d)
    expect(enabledIds(d)).toEqual([STT])
    expect(d.get(STT).enabled).toBe(true)

    // Turned off again (any way at all): back on.
    await d.emit(STT, { enabled: false, state: 'off' })
    expect(enabledIds(d)).toEqual([STT, STT])
  })

  it('leaves unavailable modules alone, and a desktop without modules does nothing', async () => {
    const d = fakeDesktop([info(TTS, { state: 'unavailable', error: 'Needs macOS 13.4 or later' }), info(STT)])
    await start(d)
    expect(enabledIds(d)).toEqual([STT])

    keeper!.stop()
    const empty = fakeDesktop([])
    await start(empty)
    expect(empty.deps.enable).not.toHaveBeenCalled()
  })

  it('starts nothing while a capture records, and goes once it stops', async () => {
    const d = fakeDesktop([info(TTS), info(STT)])
    const k = await start(d, { recording: true })
    expect(d.deps.enable).not.toHaveBeenCalled()
    k.setRecording(false)
    await settle()
    expect(enabledIds(d)).toEqual([TTS])
  })

  it('a first enable whose command fails is tried again after a backoff', async () => {
    const d = fakeDesktop([ttsReady(), info(STT)])
    vi.mocked(d.deps.enable).mockRejectedValueOnce(new Error('ipc closed'))
    await start(d)
    expect(d.deps.enable).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1])
    await settle()
    expect(d.deps.enable).toHaveBeenCalledTimes(2)
    expect(d.get(STT).state).toBe('downloading')
  })
})

describe('making sure the downloads finish', () => {
  it('retries a failed download with growing waits, then stops counting once it is ready', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'downloading', progress: 0.2 })])
    await start(d)
    await d.emit(STT, { state: 'error', progress: null, error: 'download of asr.gguf failed: HTTP 503' })
    expect(d.deps.enable).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0])
    expect(d.deps.enable).toHaveBeenCalledTimes(1)

    await d.emit(STT, { state: 'error', progress: null, error: 'download of asr.gguf failed: HTTP 503' })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0])
    expect(d.deps.enable).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] - RETRY_DELAYS_MS[0])
    expect(d.deps.enable).toHaveBeenCalledTimes(2)

    await d.emit(STT, { state: 'ready', progress: null, assetsPresent: true })
    expect(d.tracked.some(([e, p]) => e === 'local_module_ready' && p.module === STT && p.retries === 2)).toBe(true)
  })

  it('retries right away when the network comes back', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'error', error: 'download of asr.gguf failed: error sending request' })])
    await start(d)
    expect(d.deps.enable).not.toHaveBeenCalled()
    d.goOnline()
    await settle()
    expect(enabledIds(d)).toEqual([STT])
  })

  it('never retries what retrying cannot fix, and retries a full disk or a sidecar that would not start only slowly', async () => {
    expect(retryClass('sidecar executable not found')).toBe('never')
    expect(retryClass('sidecar speaks protocol 2, host speaks 1')).toBe('never')
    expect(retryClass('sidecar identifies as "x", expected "local-stt"')).toBe('never')
    expect(retryClass('not enough disk space: 1880 MB needed, 412 MB free')).toBe('slow')
    expect(retryClass('sidecar exited before it was ready')).toBe('slow')
    expect(retryClass('sidecar did not answer ready in time')).toBe('slow')
    expect(retryClass('download of x failed: HTTP 500')).toBe('soon')

    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'error', error: 'not enough disk space: 1880 MB needed, 412 MB free' })])
    await start(d)
    // The slowest wait (10 min), not the first one (5 s).
    const slowest = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
    await vi.advanceTimersByTimeAsync(slowest - 1_000)
    expect(d.deps.enable).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(enabledIds(d)).toEqual([STT])
  })

  it('stops retrying after MAX_AUTO_RETRIES in a session (stall restarts included); the network coming back still tries', async () => {
    const err = 'download of asr.gguf failed: HTTP 503'
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'error', error: err })])
    await start(d)
    for (let i = 0; i < MAX_AUTO_RETRIES + 3; i++) {
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
      await d.emit(STT, { state: 'error', progress: null, error: err })
    }
    expect(d.deps.enable).toHaveBeenCalledTimes(MAX_AUTO_RETRIES)
    d.goOnline()
    await settle()
    expect(d.deps.enable).toHaveBeenCalledTimes(MAX_AUTO_RETRIES + 1)
  })

  it('restarts a download that stops moving (it resumes from the partial file)', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'downloading', progress: 0.3 })])
    await start(d)
    // Moving: no restart.
    await vi.advanceTimersByTimeAsync(STALL_MS / 2)
    await d.emit(STT, { progress: 0.35 })
    await vi.advanceTimersByTimeAsync(STALL_MS / 2 + STALL_CHECK_MS)
    expect(d.deps.disable).not.toHaveBeenCalled()

    // Stuck for a full stall window: disable, then enable again.
    await vi.advanceTimersByTimeAsync(STALL_MS)
    await settle()
    expect(d.deps.disable).toHaveBeenCalledWith(STT)
    expect(enabledIds(d)).toEqual([STT])
    expect(d.get(STT)).toMatchObject({ enabled: true, state: 'downloading' })
    expect(d.tracked.some(([e]) => e === 'local_module_stall_restart')).toBe(true)
  })

  it('a stall restart whose enable fails, or that is cut short, still ends with the model on', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'downloading', progress: 0.3 })])
    await start(d)
    vi.mocked(d.deps.enable).mockRejectedValueOnce(new Error('ipc closed'))
    await vi.advanceTimersByTimeAsync(STALL_MS + STALL_CHECK_MS)
    await settle()
    expect(d.deps.disable).toHaveBeenCalledWith(STT)
    expect(d.get(STT).enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1])
    await settle()
    expect(d.get(STT).enabled).toBe(true)

    // Cut short (the window closed between disable and enable): the next
    // keeper finds it off, and turns it on.
    keeper!.stop()
    const next = fakeDesktop([ttsReady(), info(STT, { enabled: false, state: 'off', progress: null })])
    await start(next)
    expect(enabledIds(next)).toEqual([STT])
  })

  it('a retry due during a capture waits for it to end', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'error', error: 'download of asr.gguf failed: HTTP 502' })])
    const k = await start(d, { recording: true })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0])
    expect(d.deps.enable).not.toHaveBeenCalled()
    k.setRecording(false)
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1])
    expect(enabledIds(d)).toEqual([STT])
  })

  it('stops cleanly: no timers fire after stop()', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'error', error: 'download of asr.gguf failed: HTTP 502' })])
    const k = await start(d)
    k.stop()
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] * 2)
    expect(d.deps.enable).not.toHaveBeenCalled()
  })
})

describe('telemetry (what PostHog gets)', () => {
  const events = (d: ReturnType<typeof fakeDesktop>, name: string) =>
    d.tracked.filter(([e]) => e === name).map(([, p]) => p)

  it('a failure says what went wrong, how, and where it got to', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'downloading', progress: 0.42 })])
    await start(d)
    await d.emit(STT, { state: 'error', progress: null, error: 'download of asr.gguf failed: HTTP 503' })
    expect(events(d, 'local_module_failed')).toEqual([
      {
        module: STT,
        state: 'error',
        error: 'download of asr.gguf failed: HTTP 503',
        error_kind: 'network',
        retry: 'soon',
        phase: 'downloading',
        progress: 0.42,
        attempt: 0,
        bytes: 806_885_088,
        version: '2026-09-25',
      },
    ])
  })

  it('a warm-up failure reports the warming phase', async () => {
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'warming', assetsPresent: true })])
    await start(d)
    await d.emit(STT, { state: 'error', error: 'sidecar exited before it was ready' })
    expect(events(d, 'local_module_failed')[0]).toMatchObject({ phase: 'warming', error_kind: 'sidecar_start', retry: 'slow' })
  })

  it('a module this Mac cannot run is reported once a session, with why', async () => {
    const d = fakeDesktop([info(TTS, { state: 'unavailable', error: 'Needs macOS 13.4 or later' }), info(STT, { enabled: true, state: 'ready' })])
    await start(d)
    await d.emit(TTS, { state: 'unavailable', error: 'Needs macOS 13.4 or later' })
    expect(events(d, 'local_module_unavailable')).toEqual([
      { module: TTS, state: 'unavailable', reason: 'Needs macOS 13.4 or later', error_kind: 'macos_too_old', version: '2026-09-25' },
    ])
  })

  it('says when it gives up for the session', async () => {
    const err = 'download of asr.gguf failed: HTTP 503'
    const d = fakeDesktop([ttsReady(), info(STT, { enabled: true, state: 'error', error: err })])
    await start(d)
    for (let i = 0; i < MAX_AUTO_RETRIES + 2; i++) {
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
      await d.emit(STT, { state: 'error', progress: null, error: err })
    }
    expect(events(d, 'local_module_retries_exhausted')).toEqual([
      { module: STT, state: 'error', error: err, error_kind: 'network', retries: MAX_AUTO_RETRIES },
    ])
  })

  it('ready says how long it took, and whether it had to download', async () => {
    const d = fakeDesktop([info(TTS), info(STT, { state: 'unavailable' })])
    await start(d)
    await vi.advanceTimersByTimeAsync(9_000)
    await d.emit(TTS, { state: 'warming', progress: null })
    await vi.advanceTimersByTimeAsync(1_000)
    await d.emit(TTS, { state: 'ready', assetsPresent: true })
    expect(events(d, 'local_module_ready')).toEqual([
      { module: TTS, state: 'ready', retries: 0, duration_ms: 10_000, downloaded: true, bytes: 144_227_442, version: '2026-09-25' },
    ])
  })
})
