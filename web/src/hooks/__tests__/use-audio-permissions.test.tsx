// @vitest-environment jsdom
/**
 * useAudioPermissions — the live Microphone / System Audio Recording status
 * behind the desktop Settings → Recording permissions panel.
 *
 * The load-bearing contracts:
 *   • Status comes ONLY from the passive checks, seeded on mount and re-read
 *     every 1500ms while the page is visible, plus immediately on focus /
 *     visibilitychange → visible: after a denial the only fix is a toggle in
 *     System Settings, so the row must follow it without a click. The request
 *     commands never run on their own.
 *   • A check that rejects (a desktop build older than the command) turns that
 *     permission 'unknown' and it stops being polled.
 *   • requestSystem falls back to the legacy probe when the new command
 *     rejects — and the probe's "granted" still never shows as granted (on
 *     those builds it can't see a denial; that lie is what this replaced).
 *   • Latest read wins, and requests can't overlap.
 *
 * Driven through a real render (createRoot + act), the house pattern for hooks
 * here; the poll runs on setInterval, so fake timers drive it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  checkMic: vi.fn<() => Promise<string>>(),
  requestMic: vi.fn<() => Promise<string>>(),
  checkSystem: vi.fn<() => Promise<string>>(),
  requestSystem: vi.fn<() => Promise<string>>(),
  requestScreenCapture: vi.fn<() => Promise<string>>(),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    checkMicPermission: () => bridge.checkMic(),
    requestMicPermission: () => bridge.requestMic(),
    checkSystemAudioPermission: () => bridge.checkSystem(),
    requestSystemAudioPermission: () => bridge.requestSystem(),
    requestScreenCapturePermission: () => bridge.requestScreenCapture(),
  },
}))

import {
  toMicState,
  toSystemState,
  useAudioPermissions,
  type AudioPermissions,
} from '../use-audio-permissions'

// What Tauri rejects with for a command the running binary doesn't register.
const notFound = (cmd: string) => new Error(`Command ${cmd} not found`)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let root: Root
let host: HTMLDivElement
let api: AudioPermissions
let visibility: DocumentVisibilityState = 'visible'

function Harness(props: { pollMs?: number; enabled?: boolean }) {
  api = useAudioPermissions(props)
  return null
}

async function mount(props: { pollMs?: number; enabled?: boolean } = {}) {
  await act(async () => {
    root.render(h(Harness, props))
  })
  await flush()
}

/** Let pending check/request promises settle into state. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  for (const fn of Object.values(bridge)) fn.mockReset()
  bridge.checkMic.mockResolvedValue('granted')
  bridge.checkSystem.mockResolvedValue('granted')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete (document as unknown as { visibilityState?: unknown }).visibilityState
  vi.useRealTimers()
})

describe('status mapping', () => {
  it('maps check_mic_permission (restricted is a denial; anything else unrecognised is unknown)', () => {
    expect(toMicState('granted')).toBe('granted')
    expect(toMicState('denied')).toBe('denied')
    expect(toMicState('restricted')).toBe('denied')
    expect(toMicState('not-determined')).toBe('not-determined')
    expect(toMicState('not_applicable')).toBe('unknown')
    expect(toMicState('something-new')).toBe('unknown')
  })

  it('maps check_system_audio_permission (unavailable still offers Allow)', () => {
    expect(toSystemState('granted')).toBe('granted')
    expect(toSystemState('denied')).toBe('denied')
    expect(toSystemState('not-determined')).toBe('not-determined')
    expect(toSystemState('unavailable')).toBe('not-determined')
    expect(toSystemState('unsupported')).toBe('unsupported')
    expect(toSystemState('not_applicable')).toBe('unknown')
    expect(toSystemState('something-new')).toBe('unknown')
  })
})

describe('useAudioPermissions — passive polling', () => {
  it('seeds both rows from the passive checks on mount and never requests on its own', async () => {
    bridge.checkMic.mockResolvedValue('not-determined')
    bridge.checkSystem.mockResolvedValue('denied')
    await mount()

    expect(api.mic).toBe('not-determined')
    expect(api.system).toBe('denied')

    await advance(1500)
    await advance(1500)
    expect(bridge.requestMic).not.toHaveBeenCalled()
    expect(bridge.requestSystem).not.toHaveBeenCalled()
    expect(bridge.requestScreenCapture).not.toHaveBeenCalled()
  })

  it('re-reads every 1500ms while visible, so a Settings toggle lands without a click', async () => {
    bridge.checkSystem.mockResolvedValue('denied')
    await mount()
    expect(bridge.checkSystem).toHaveBeenCalledTimes(1)
    expect(api.system).toBe('denied')

    await advance(1499)
    expect(bridge.checkSystem).toHaveBeenCalledTimes(1)

    // The user flips the toggle in System Settings.
    bridge.checkSystem.mockResolvedValue('granted')
    await advance(1)
    expect(bridge.checkSystem).toHaveBeenCalledTimes(2)
    expect(bridge.checkMic).toHaveBeenCalledTimes(2)
    expect(api.system).toBe('granted')

    await advance(1500)
    expect(bridge.checkSystem).toHaveBeenCalledTimes(3)
  })

  it('does not poll while hidden, and re-reads the moment the page is visible again', async () => {
    await mount()
    expect(bridge.checkMic).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    await advance(6000)
    expect(bridge.checkMic).toHaveBeenCalledTimes(1)
    expect(bridge.checkSystem).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(bridge.checkMic).toHaveBeenCalledTimes(2)
    expect(bridge.checkSystem).toHaveBeenCalledTimes(2)
  })

  it('re-reads immediately on window focus (back from System Settings)', async () => {
    bridge.checkMic.mockResolvedValue('denied')
    await mount()
    expect(api.mic).toBe('denied')

    bridge.checkMic.mockResolvedValue('granted')
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(bridge.checkMic).toHaveBeenCalledTimes(2)
    expect(api.mic).toBe('granted')
  })

  it('a rejected check is unknown and that permission stops being polled; the other keeps going', async () => {
    bridge.checkSystem.mockRejectedValue(notFound('check_system_audio_permission'))
    await mount()
    expect(api.system).toBe('unknown')
    expect(api.mic).toBe('granted')

    await advance(1500)
    await advance(1500)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(bridge.checkSystem).toHaveBeenCalledTimes(1)
    expect(bridge.checkMic).toHaveBeenCalledTimes(4)

    // An explicit refresh() still retries it — and a read that now succeeds
    // puts the permission back on the poll.
    bridge.checkSystem.mockResolvedValue('granted')
    await act(async () => {
      await api.refresh()
    })
    expect(api.system).toBe('granted')
    await advance(1500)
    expect(bridge.checkSystem).toHaveBeenCalledTimes(3)
  })

  it('latest read wins: a read that started earlier and lands late cannot flip the row back', async () => {
    const stale = deferred<string>()
    bridge.checkSystem.mockReturnValueOnce(stale.promise).mockResolvedValue('granted')
    bridge.requestSystem.mockResolvedValue('granted')
    await mount()
    expect(api.system).toBe('checking')

    // The user answers the OS prompt while the seed read is still in flight.
    await act(async () => {
      await api.requestSystem()
    })
    expect(api.system).toBe('granted')

    // The seed read (taken before the grant) resolves last.
    await act(async () => {
      stale.resolve('not-determined')
    })
    await flush()
    expect(api.system).toBe('granted')
  })

  it('enabled: false never touches the bridge', async () => {
    await mount({ enabled: false })
    await advance(4500)
    expect(bridge.checkMic).not.toHaveBeenCalled()
    expect(bridge.checkSystem).not.toHaveBeenCalled()
    expect(api.mic).toBe('checking')
  })
})

describe('useAudioPermissions — requests', () => {
  it('requestMic returns the command answer, then the row follows a fresh passive check', async () => {
    bridge.checkMic.mockResolvedValue('not-determined')
    await mount()

    bridge.requestMic.mockResolvedValue('granted')
    bridge.checkMic.mockResolvedValue('granted')
    let result = ''
    await act(async () => {
      result = await api.requestMic()
    })
    expect(result).toBe('granted')
    expect(bridge.requestMic).toHaveBeenCalledTimes(1)
    expect(api.mic).toBe('granted')
    expect(api.micBusy).toBe(false)
  })

  it('requestSystem uses request_system_audio_permission on a current build', async () => {
    bridge.checkSystem.mockResolvedValue('denied')
    await mount()

    // Already denied → the command opens the Settings pane; the row stays
    // denied until the passive check says otherwise.
    bridge.requestSystem.mockResolvedValue('opened-settings')
    let result = ''
    await act(async () => {
      result = await api.requestSystem()
    })
    expect(result).toBe('opened-settings')
    expect(bridge.requestScreenCapture).not.toHaveBeenCalled()
    expect(api.system).toBe('denied')
  })

  it('requestSystem falls back to the legacy probe on rejection — and its "granted" never shows as granted', async () => {
    bridge.checkSystem.mockRejectedValue(notFound('check_system_audio_permission'))
    bridge.requestSystem.mockRejectedValue(notFound('request_system_audio_permission'))
    bridge.requestScreenCapture.mockResolvedValue('granted')
    await mount()
    expect(api.system).toBe('unknown')

    let result = ''
    await act(async () => {
      result = await api.requestSystem()
    })
    expect(bridge.requestSystem).toHaveBeenCalledTimes(1)
    expect(bridge.requestScreenCapture).toHaveBeenCalledTimes(1)
    expect(result).toBe('granted')
    // Old build: the probe can't observe a denial, so its answer is not proof.
    expect(api.system).toBe('unknown')
    expect(api.systemBusy).toBe(false)
  })

  it('resolves "error" when every command rejects', async () => {
    bridge.requestSystem.mockRejectedValue(notFound('request_system_audio_permission'))
    bridge.requestScreenCapture.mockRejectedValue(new Error('ipc down'))
    await mount()

    let result = ''
    await act(async () => {
      result = await api.requestSystem()
    })
    expect(result).toBe('error')
    expect(api.systemBusy).toBe(false)
  })

  it('guards against overlapping requests and reports busy while one is in flight', async () => {
    bridge.checkMic.mockResolvedValue('not-determined')
    await mount()

    const prompt = deferred<string>()
    bridge.requestMic.mockReturnValue(prompt.promise)
    let first: Promise<string> = Promise.resolve('')
    let second = ''
    await act(async () => {
      first = api.requestMic()
      second = await api.requestMic()
    })
    expect(second).toBe('busy')
    expect(bridge.requestMic).toHaveBeenCalledTimes(1)
    expect(api.micBusy).toBe(true)

    bridge.checkMic.mockResolvedValue('granted')
    await act(async () => {
      prompt.resolve('granted')
      await first
    })
    expect(api.micBusy).toBe(false)
    expect(api.mic).toBe('granted')
  })
})
