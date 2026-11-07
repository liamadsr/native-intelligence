// @vitest-environment jsdom
/**
 * useDictation's start click means "the model is up, talk now":
 * `stt-dictate-start` plays once, when voice_start has resolved AND the
 * desktop has reported a state past `starting` (local-stt ready), in either
 * order. voice_start alone is not readiness (a cold start takes seconds more):
 * until then the phase stays `starting` and nothing plays. Never for a refused
 * start, a session that ends before it is ready, or one stopped first; never
 * again for later state events. A desktop with voice_status `readyFlag` sends
 * `ready` on voice://state, and then that flag alone is readiness (speech
 * before local-stt is ready waits for `ready: true`); 0.2.45 infers it.
 *
 * Its end click, `stt-dictate-end`, plays once for a session the user stopped
 * (the mic clicked again or let go, Space / Enter, stop()), when voice://ended
 * `stopped` arrives: the desktop has let go of the mic by then, so never while
 * it finalizes. Never for a session that didn't click in, Esc / cancel, an
 * error or other end, the desktop cancelling, a stop it never answered, or
 * the mic going away (a capture would record it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceEvent } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, (e: VoiceEvent) => void>(),
  startError: null as unknown,
  /** Resolve voice_start by hand (null = at once). */
  gate: null as Promise<void> | null,
  plays: [] as string[],
}))

vi.mock('@/lib/sounds/engine', () => ({
  playSound: (name: string) => {
    bridge.plays.push(name)
    return { name, started: Promise.resolve(true), ended: Promise.resolve(), nearEnd: async () => {}, stop: () => {} }
  },
}))
vi.mock('@/lib/voice/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/messages')>()),
  voiceToast: vi.fn(),
  voiceEndedMessage: () => null,
}))
vi.mock('@/lib/tauri-bridge', () => {
  class VoiceRefusedError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  }
  return {
    VoiceRefusedError,
    tauriBridge: {
      voiceStart: async () => {
        if (bridge.gate) await bridge.gate
        if (bridge.startError) throw bridge.startError
      },
      voiceStop: async () => {},
      voiceCancel: async () => {},
      ttsCancel: async () => {},
      onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
        bridge.listeners.set(id, cb)
        return () => bridge.listeners.delete(id)
      },
    },
  }
})

import { useDictation, DICTATION_STOP_TIMEOUT_MS, type DictationHandle } from '../use-dictation'
import { VoiceRefusedError } from '@/lib/tauri-bridge'

let root: Root
let host: HTMLDivElement
let handle: DictationHandle

function Harness({ on = true }: { on?: boolean }) {
  handle = useDictation({ enabled: on, onCommit: () => {} })
  return h('button', { type: 'button', 'data-mic': '', ...handle.buttonProps }, 'mic')
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function emit(ev: VoiceEvent) {
  const [cb] = [...bridge.listeners.values()]
  await act(async () => cb?.(ev))
  await flush()
}

async function pointer(type: 'pointerdown' | 'pointerup') {
  const mic = host.querySelector('[data-mic]') as HTMLButtonElement
  await act(async () => {
    mic.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))
  })
  await flush()
}

/** A quick press on the mic: starts a session latched, or stops a live one. */
async function click() {
  await pointer('pointerdown')
  await pointer('pointerup')
}

async function key(k: string, target: EventTarget = host.querySelector('[data-mic]') as HTMLButtonElement) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

async function setEnabled(on: boolean) {
  await act(async () => root.render(h(Harness, { on })))
  await flush()
}

beforeEach(async () => {
  bridge.listeners.clear()
  bridge.startError = null
  bridge.gate = null
  bridge.plays = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(h(Harness)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const READY: VoiceEvent = { type: 'state', state: 'listening', echo: 'converging' }

describe('dictation start click', () => {
  it('voice_start resolving is not readiness: starting and silent until the desktop reports the model up', async () => {
    await act(async () => handle.toggle())
    await flush()
    expect(handle.phase).toBe('starting')
    expect(bridge.plays).toEqual([])
    // Still loading (an echo update re-reports starting): still silent.
    await emit({ type: 'state', state: 'starting', echo: 'cancelling' })
    expect(handle.phase).toBe('starting')
    expect(bridge.plays).toEqual([])
    await emit(READY)
    expect(handle.phase).toBe('listening')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('clicks once, not again for later states', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit(READY)
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    await emit({ type: 'state', state: 'listening', echo: 'converging' })
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('user_speaking is past starting too: the click', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(handle.phase).toBe('listening')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('the ready state ahead of voice_start resolving: the click once both are in (still once)', async () => {
    let open!: () => void
    bridge.gate = new Promise<void>((resolve) => (open = resolve))
    await act(async () => handle.toggle())
    await flush()
    await emit(READY)
    expect(handle.phase).toBe('starting')
    expect(bridge.plays).toEqual([])
    await act(async () => open())
    await flush()
    expect(handle.phase).toBe('listening')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
    await emit(READY)
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('a session that never becomes ready: no click', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit({ type: 'ended', reason: 'error', error: 'the transcription session ended' })
    expect(handle.phase).toBe('idle')
    // Stopped while still starting, and the desktop ends it without ever being ready.
    await act(async () => handle.toggle())
    await flush()
    await act(async () => handle.stop())
    await flush()
    await emit({ type: 'ended', reason: 'stopped', text: '' })
    expect(handle.phase).toBe('idle')
    expect(bridge.plays).toEqual([])
  })

  it('a refused start never clicks', async () => {
    bridge.startError = new VoiceRefusedError('busy')
    await act(async () => handle.toggle())
    await flush()
    expect(handle.phase).toBe('idle')
    expect(bridge.plays).toEqual([])
  })

  it('stopped before the desktop confirmed: no click, even when it becomes ready while finishing', async () => {
    let open!: () => void
    bridge.gate = new Promise<void>((resolve) => (open = resolve))
    await act(async () => handle.toggle())
    await act(async () => handle.stop())
    await act(async () => open())
    await flush()
    await emit(READY)
    expect(handle.phase).toBe('stopping')
    expect(bridge.plays).toEqual([])
  })

  it('each session clicks once', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit(READY)
    await act(async () => handle.cancel())
    await flush()
    await act(async () => handle.toggle())
    await flush()
    await emit(READY)
    expect(bridge.plays).toEqual(['stt-dictate-start', 'stt-dictate-start'])
  })
})

describe('dictation start click: a readyFlag desktop', () => {
  it('speech before ready: silent until `ready: true` is re-sent under the same state', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging', ready: false })
    expect(handle.phase).toBe('starting')
    expect(bridge.plays).toEqual([])
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging', ready: true })
    expect(handle.phase).toBe('listening')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('listening with `ready: false` is not readiness', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: false })
    expect(handle.phase).toBe('starting')
    expect(bridge.plays).toEqual([])
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: false })
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    expect(handle.phase).toBe('listening')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('muted with `ready: true` is ready', async () => {
    await act(async () => handle.toggle())
    await flush()
    await emit({ type: 'state', state: 'muted', echo: 'converging', ready: true })
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })
})

describe('dictation end click', () => {
  const STOPPED: VoiceEvent = { type: 'ended', reason: 'stopped', text: 'hello' }
  const BOTH = ['stt-dictate-start', 'stt-dictate-end']

  /** A latched session that clicked in (the model is up). */
  async function listening() {
    await click()
    await emit(READY)
    expect(handle.phase).toBe('listening')
  }

  it('the mic clicked again: plays once the desktop has ended the session (its mic released), not while it finalizes', async () => {
    await listening()
    await click()
    expect(handle.phase).toBe('stopping')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
    await emit(STOPPED)
    expect(handle.phase).toBe('idle')
    expect(bridge.plays).toEqual(BOTH)
  })

  it('Space / Enter, and stop() (Send while dictating), end with it too', async () => {
    await key('Enter')
    await emit(READY)
    await key(' ')
    await emit(STOPPED)
    expect(bridge.plays).toEqual(BOTH)
    await act(async () => handle.toggle())
    await flush()
    await emit(READY)
    await act(async () => handle.stop())
    await flush()
    await emit(STOPPED)
    expect(bridge.plays).toEqual([...BOTH, ...BOTH])
  })

  it('hold to talk: letting go of the mic ends with it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await pointer('pointerdown')
      await emit(READY)
      vi.advanceTimersByTime(800)
      await pointer('pointerup')
      expect(handle.phase).toBe('stopping')
      await emit(STOPPED)
      expect(bridge.plays).toEqual(BOTH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('once: stops repeated while finishing, or the end delivered twice, still click once', async () => {
    await listening()
    await click()
    await act(async () => handle.stop())
    await key('Enter')
    const [cb] = [...bridge.listeners.values()]
    await act(async () => {
      cb(STOPPED)
      cb(STOPPED)
    })
    await flush()
    expect(bridge.plays).toEqual(BOTH)
  })

  it('a session stopped while still starting: neither click, even when it turns ready while finishing', async () => {
    await click()
    await click()
    await emit(READY)
    await emit(STOPPED)
    expect(handle.phase).toBe('idle')
    expect(bridge.plays).toEqual([])
  })

  it.each<[string, () => Promise<void>]>([
    ['Esc', () => key('Escape', document.body)],
    [
      'cancel()',
      async () => {
        await act(async () => handle.cancel())
        await flush()
      },
    ],
    ['an error', () => emit({ type: 'ended', reason: 'error', error: 'the transcription session ended' })],
    ['the desktop ending it (idle)', () => emit({ type: 'ended', reason: 'idle', text: 'hello' })],
    [
      'Esc while a stop finishes',
      async () => {
        await click()
        await key('Escape', document.body)
        await emit(STOPPED)
      },
    ],
    [
      'the desktop cancelling a stop',
      async () => {
        await click()
        await emit({ type: 'ended', reason: 'cancelled' })
      },
    ],
    [
      'an error finishing a stop',
      async () => {
        await click()
        await emit({ type: 'ended', reason: 'device' })
      },
    ],
  ])('no end click: %s', async (_, end) => {
    await listening()
    await end()
    expect(handle.phase).toBe('idle')
    expect(bridge.plays).toEqual(['stt-dictate-start'])
  })

  it('no end click for a stop the desktop never answered (the words commit after the timeout)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await listening()
      await click()
      await act(async () => {
        vi.advanceTimersByTime(DICTATION_STOP_TIMEOUT_MS)
      })
      await flush()
      expect(handle.phase).toBe('idle')
      expect(bridge.plays).toEqual(['stt-dictate-start'])
    } finally {
      vi.useRealTimers()
    }
  })

  it("the mic going away: no end click, whether it stops the session or a stop of the user's is finishing", async () => {
    // A capture takes the mic mid-session: the hook stops it.
    await listening()
    await setEnabled(false)
    expect(handle.phase).toBe('stopping')
    await emit(STOPPED)
    expect(handle.phase).toBe('idle')
    // The user stopped; a capture took the mic while it finalized.
    await setEnabled(true)
    await listening()
    await click()
    await setEnabled(false)
    await emit(STOPPED)
    expect(handle.phase).toBe('idle')
    expect(bridge.plays).toEqual(['stt-dictate-start', 'stt-dictate-start'])
  })
})
