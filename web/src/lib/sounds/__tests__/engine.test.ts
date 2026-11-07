// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const platform = vi.hoisted(() => ({ desktop: false }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => platform.desktop }))

import {
  SOUND_TIMING,
  __resetSoundEngineForTests,
  __setAudioContextFactoryForTests,
  canPlaySoundsNow,
  playSound,
  preloadSounds,
  primeSounds,
  stopAllSounds,
  unlockSounds,
} from '../engine'
import { setSoundEffectsEnabled } from '../settings'
import { PRELOADED_SOUND_NAMES, SOUND_NAMES } from '../catalog'

// ── A fake AudioContext: enough of the Web Audio surface the engine touches ──

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  started = false
  stopped = false
  constructor(private ctx: FakeContext) {}
  connect() {}
  disconnect() {}
  start() {
    this.started = true
    this.ctx.sources.push(this)
  }
  stop() {
    this.stopped = true
    this.onended?.()
  }
  /** The sound played to its end. */
  end() {
    this.onended?.()
  }
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed'
  sources: FakeSource[] = []
  destination = {}
  /** 'ok' resumes; 'hang' never settles (a browser before any gesture). */
  resumeMode: 'ok' | 'hang' = 'ok'
  failDecode = false
  resume = vi.fn(() => {
    if (this.resumeMode === 'hang') return new Promise<void>(() => {})
    this.state = 'running'
    return Promise.resolve()
  })
  suspend = vi.fn(() => {
    this.state = 'suspended'
    return Promise.resolve()
  })
  decodeAudioData = vi.fn((_data: ArrayBuffer) =>
    this.failDecode ? Promise.reject(new Error('bad audio')) : Promise.resolve({ duration: 0.25 }),
  )
  constructor(state: 'suspended' | 'running' = 'running') {
    this.state = state
  }
  createBufferSource() {
    return new FakeSource(this)
  }
}

let ctx: FakeContext
let factory: ReturnType<typeof vi.fn>
const fetchMock = vi.fn(async (_url: string) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))

function install(state: 'suspended' | 'running' = 'running') {
  ctx = new FakeContext(state)
  factory = vi.fn(() => ctx as unknown as AudioContext)
  __setAudioContextFactoryForTests(factory as unknown as () => AudioContext)
}

/** Let the engine's async start (fetch → decode → resume → start) run. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('sound engine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    platform.desktop = false
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install()
  })

  afterEach(() => {
    __resetSoundEngineForTests()
    __setAudioContextFactoryForTests(null)
    Reflect.deleteProperty(navigator, 'userActivation')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A browser with the User Activation API (jsdom has none). */
  function setUserActivation(hasBeenActive: boolean) {
    Object.defineProperty(navigator, 'userActivation', { value: { hasBeenActive }, configurable: true })
  }

  it('plays a sound: started resolves true, ended when it finishes', async () => {
    const handle = playSound('agent-alert')
    await flush()
    await expect(handle.started).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/sounds/agent-alert.m4a')
    expect(ctx.sources).toHaveLength(1)
    let ended = false
    void handle.ended.then(() => (ended = true))
    await flush()
    expect(ended).toBe(false)
    ctx.sources[0].end()
    await flush()
    expect(ended).toBe(true)
  })

  it('ended resolves even when the source never reports its end', async () => {
    const handle = playSound('agent-alert')
    await flush()
    await expect(handle.started).resolves.toBe(true)
    let ended = false
    void handle.ended.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(250 + SOUND_TIMING.END_SLACK_MS + 1)
    expect(ended).toBe(true)
  })

  it('nearEnd(lead) resolves lead ms before the end (to start what follows over the tail)', async () => {
    const handle = playSound('voice-chat-start')
    await flush()
    await expect(handle.started).resolves.toBe(true)
    let near = false
    void handle.nearEnd(100).then(() => (near = true))
    await vi.advanceTimersByTimeAsync(140) // the fake buffer is 250 ms long
    expect(near).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(near).toBe(true)
  })

  it('nearEnd resolves at once when the sound will not play, and when stopped', async () => {
    setSoundEffectsEnabled(false)
    await expect(playSound('voice-chat-start').nearEnd(100)).resolves.toBeUndefined()
    setSoundEffectsEnabled(true)
    const handle = playSound('voice-chat-start')
    await flush()
    let near = false
    void handle.nearEnd(0).then(() => (near = true))
    handle.stop()
    await flush()
    expect(near).toBe(true)
  })

  it('stop() ends it now, and is idempotent', async () => {
    const handle = playSound('agent-complete')
    await flush()
    handle.stop()
    handle.stop()
    await expect(handle.ended).resolves.toBeUndefined()
    expect(ctx.sources[0].stopped).toBe(true)
  })

  it('stop() before it starts means it never plays', async () => {
    const handle = playSound('agent-complete')
    handle.stop()
    await flush()
    await expect(handle.started).resolves.toBe(false)
    await expect(handle.ended).resolves.toBeUndefined()
    expect(ctx.sources).toHaveLength(0)
  })

  it('stopAllSounds stops every sound playing', async () => {
    const a = playSound('agent-alert')
    const b = playSound('notification-alert')
    await flush()
    stopAllSounds()
    await expect(Promise.all([a.ended, b.ended])).resolves.toBeDefined()
    expect(ctx.sources.every((s) => s.stopped)).toBe(true)
  })

  it('does nothing when Sound effects is off (no context, no fetch)', async () => {
    setSoundEffectsEnabled(false)
    const handle = playSound('agent-alert')
    await expect(handle.started).resolves.toBe(false)
    await expect(handle.ended).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is a no-op under jsdom without an injected AudioContext', async () => {
    __setAudioContextFactoryForTests(null)
    const handle = playSound('agent-alert')
    await expect(handle.started).resolves.toBe(false)
    await expect(handle.ended).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed decode resolves at once and the next play tries again', async () => {
    ctx.failDecode = true
    const first = playSound('agent-alert')
    await flush()
    await expect(first.started).resolves.toBe(false)
    await expect(first.ended).resolves.toBeUndefined()
    ctx.failDecode = false
    const second = playSound('agent-alert')
    await flush()
    await expect(second.started).resolves.toBe(true)
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2)
  })

  it('a context that cannot run (no gesture yet) gives up without playing later', async () => {
    install('suspended')
    ctx.resumeMode = 'hang'
    const handle = playSound('agent-alert')
    let ended = false
    void handle.ended.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(SOUND_TIMING.RESUME_TIMEOUT_MS + 1)
    expect(ended).toBe(true)
    await expect(handle.started).resolves.toBe(false)
    expect(ctx.sources).toHaveLength(0)
  })

  it('caches decoded sounds and preloads the rest after the first use', async () => {
    await flush()
    const a = playSound('agent-alert')
    await flush()
    await a.started
    a.stop()
    const b = playSound('agent-alert')
    await flush()
    await expect(b.started).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // jsdom has no requestIdleCallback: the fallback timer preloads the rest.
    await vi.advanceTimersByTimeAsync(SOUND_TIMING.PRELOAD_DELAY_MS + 1)
    await flush()
    const urls = fetchMock.mock.calls.map((c) => c[0])
    for (const name of PRELOADED_SOUND_NAMES) expect(urls).toContain(`/sounds/${name}.m4a`)
    // Sounds nothing plays yet stay unfetched.
    for (const name of SOUND_NAMES.filter((n) => !PRELOADED_SOUND_NAMES.includes(n))) {
      expect(urls).not.toContain(`/sounds/${name}.m4a`)
    }
    expect(urls.filter((u) => u === '/sounds/agent-alert.m4a')).toHaveLength(1)
  })

  it('preloadSounds never rejects', async () => {
    ctx.failDecode = true
    await expect(preloadSounds(['agent-alert', 'voice-chat-end'])).resolves.toBeUndefined()
  })

  it('suspends the context once idle, and resumes it for the next sound', async () => {
    const handle = playSound('agent-alert')
    await flush()
    await handle.started
    ctx.sources[0].end()
    await flush()
    expect(ctx.suspend).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SOUND_TIMING.IDLE_SUSPEND_MS + 1)
    expect(ctx.suspend).toHaveBeenCalledTimes(1)
    expect(ctx.state).toBe('suspended')
    const next = playSound('agent-alert')
    await flush()
    await expect(next.started).resolves.toBe(true)
    expect(ctx.resume).toHaveBeenCalled()
  })

  it('browser: the first pointerdown resumes the context, once', async () => {
    install('suspended')
    primeSounds()
    expect(factory).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('keydown'))
    window.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })

  it('browser: a keydown unlocks too', async () => {
    install('suspended')
    primeSounds()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await flush()
    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })

  it('desktop: no gesture listeners (autoplay is allowed there)', async () => {
    platform.desktop = true
    install('suspended')
    primeSounds()
    window.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(factory).not.toHaveBeenCalled()
    expect(ctx.resume).not.toHaveBeenCalled()
  })

  it('browser: the first gesture unlocks even with Sound effects off (Safari), without preloading', async () => {
    setSoundEffectsEnabled(false)
    install('suspended')
    primeSounds()
    window.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SOUND_TIMING.PRELOAD_DELAY_MS + 1)
    expect(fetchMock).not.toHaveBeenCalled()
    // The device is released once idle.
    await vi.advanceTimersByTimeAsync(SOUND_TIMING.IDLE_SUSPEND_MS + 1)
    expect(ctx.suspend).toHaveBeenCalledTimes(1)
  })

  it('unlockSounds() creates and resumes the context synchronously (inside the click)', () => {
    install('suspended')
    unlockSounds()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })

  describe('canPlaySoundsNow', () => {
    it('browser: false in a tab never clicked or typed in', () => {
      setUserActivation(false)
      install('suspended')
      expect(canPlaySoundsNow()).toBe(false)
    })

    it('browser: true once the page has had a gesture', () => {
      setUserActivation(true)
      expect(canPlaySoundsNow()).toBe(true)
    })

    it("browser: true once this window's unlock ran", () => {
      setUserActivation(false)
      install('suspended')
      ctx.resumeMode = 'hang'
      primeSounds()
      window.dispatchEvent(new Event('pointerdown'))
      expect(canPlaySoundsNow()).toBe(true)
    })

    it('true while the context runs', async () => {
      setUserActivation(false)
      const handle = playSound('agent-alert')
      await flush()
      await expect(handle.started).resolves.toBe(true)
      expect(canPlaySoundsNow()).toBe(true)
    })

    it('desktop: true (autoplay)', () => {
      setUserActivation(false)
      platform.desktop = true
      expect(canPlaySoundsNow()).toBe(true)
    })

    it('true where the User Activation API is missing (as before)', () => {
      expect(canPlaySoundsNow()).toBe(true)
    })
  })
})
