// @vitest-environment jsdom
/**
 * useDictation — the composer mic's brain, with the voice bridge mocked.
 *
 * Contract pinned here (docs/plans/chat-voice.md §3.4):
 *  - pointerdown starts a `dictation` session (listening before voice_start);
 *    a pointerup within 300 ms latches it (the next click stops), a later one
 *    stops it (hold-to-talk).
 *  - Space / Enter on the focused button toggle; a key repeat doesn't.
 *  - Transcript events: the whole text so far, split into final + interim.
 *  - voice://ended (stopped) commits its text once; Esc cancels (voice_cancel,
 *    nothing committed); a refusal reports its code; the mic being taken
 *    (enabled → false) stops; unmount cancels; no voice://ended within the
 *    timeout (5.5 s, counted from voice_stop) still commits what was heard.
 *  - Read-aloud is held off for the whole session (W-2).
 *  - Esc only when nothing else claimed it: bubble phase, defaultPrevented
 *    and open overlays respected, never stopped from propagating (W-4).
 *  - A refusal carries the desktop's detail (W-8); onFinish reports each end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceEvent } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown?]>,
  listeners: new Map<string, (e: VoiceEvent) => void>(),
  startError: null as unknown,
  ttsCancels: 0,
}))

vi.mock('@/lib/voice/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/messages')>()),
  voiceToast: vi.fn(),
  voiceEndedMessage: () => null,
  voiceRefusalMessage: (c: string) => c,
}))

vi.mock('@/lib/tauri-bridge', () => {
  // As the bridge's: the message is `code` or `code: <the desktop's text>`.
  class VoiceRefusedError extends Error {
    code: string
    constructor(code: string, detail?: string) {
      super(detail && detail !== code ? `${code}: ${detail}` : code)
      this.code = code
    }
  }
  return {
    VoiceRefusedError,
    tauriBridge: {
      voiceStart: async (args: unknown) => {
        bridge.calls.push(['start', args])
        if (bridge.startError) throw bridge.startError
      },
      voiceStop: async (id: string) => {
        bridge.calls.push(['stop', id])
      },
      voiceCancel: async (id: string) => {
        bridge.calls.push(['cancel', id])
      },
      ttsCancel: async () => {
        bridge.ttsCancels++
      },
      onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
        bridge.listeners.set(id, cb)
        return () => bridge.listeners.delete(id)
      },
    },
  }
})

import { useDictation, DICTATION_STOP_TIMEOUT_MS, type DictationHandle } from '../use-dictation'
import { VoiceRefusedError } from '@/lib/tauri-bridge'
import { isMicHeld, isReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import type { VoiceRefusalInfo } from '@/lib/voice/messages'

let root: Root
let host: HTMLDivElement
let handle: DictationHandle
let enabled = true
const commits: string[] = []
const refusals: string[] = []
const refusalInfos: VoiceRefusalInfo[] = []
const finishes: Array<{ cancelled: boolean }> = []

function Harness({ on }: { on: boolean }) {
  handle = useDictation({
    enabled: on,
    onCommit: (t) => commits.push(t),
    onRefused: (r) => {
      refusals.push(r.code)
      refusalInfos.push(r)
    },
    onFinish: (how) => finishes.push(how),
  })
  return h('button', { type: 'button', 'data-mic': '', ...handle.buttonProps }, 'mic')
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function render() {
  await act(async () => {
    root.render(h(Harness, { on: enabled }))
  })
  await flush()
}

const mic = () => host.querySelector('[data-mic]') as HTMLButtonElement

async function pointer(type: 'pointerdown' | 'pointerup') {
  await act(async () => {
    mic().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))
  })
  await flush()
}

async function key(k: string, opts: { repeat?: boolean; target?: EventTarget } = {}) {
  await act(async () => {
    ;(opts.target ?? mic()).dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, repeat: opts.repeat }),
    )
  })
  await flush()
}

/** The only live session's id. */
function sessionId(): string {
  const ids = [...bridge.listeners.keys()]
  expect(ids).toHaveLength(1)
  return ids[0]
}

async function emit(ev: VoiceEvent, id = sessionId()) {
  await act(async () => {
    bridge.listeners.get(id)?.(ev)
  })
  await flush()
}

const names = () => bridge.calls.map(([n]) => n)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  bridge.calls = []
  bridge.listeners.clear()
  bridge.startError = null
  bridge.ttsCancels = 0
  commits.length = 0
  refusals.length = 0
  refusalInfos.length = 0
  finishes.length = 0
  enabled = true
  window.localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useDictation', () => {
  it('hold to talk: pointerdown starts, a pointerup after 300 ms stops, ended commits the text', async () => {
    await render()
    await pointer('pointerdown')
    // The quiet room, as voice mode sends it: turns by speech alone.
    expect(bridge.calls[0]).toEqual(['start', { sessionId: expect.stringMatching(/^dict-/), mode: 'dictation', noiseProfile: 'quiet' }])
    const id = sessionId()
    expect(handle.active).toBe(true)
    // The mic is open; the model isn't up until the desktop says so.
    expect(handle.phase).toBe('starting')
    await emit({ type: 'state', state: 'listening', echo: 'converging' })
    expect(handle.phase).toBe('listening')

    await emit({ type: 'transcript', turnId: 't', text: 'hello', final: false })
    expect(handle.transcript).toEqual({ final: '', interim: 'hello' })

    vi.advanceTimersByTime(800)
    await pointer('pointerup')
    expect(bridge.calls.at(-1)).toEqual(['stop', id])
    expect(handle.phase).toBe('stopping')
    expect(commits).toEqual([])

    await emit({ type: 'ended', reason: 'stopped', text: 'hello world' }, id)
    expect(commits).toEqual(['hello world'])
    expect(handle.active).toBe(false)
    expect(handle.transcript).toBeNull()
    expect(bridge.listeners.size).toBe(0)
  })

  it('dictation asks for the quiet room even when an older build stored a noisy one', async () => {
    window.localStorage.setItem('dial8:voice:noise', 'noisy')
    await render()
    await pointer('pointerdown')
    expect(bridge.calls[0]).toEqual(['start', expect.objectContaining({ mode: 'dictation', noiseProfile: 'quiet' })])
  })

  it('click to latch: a quick press keeps listening; the next click stops', async () => {
    await render()
    await pointer('pointerdown')
    vi.advanceTimersByTime(120)
    await pointer('pointerup')
    expect(handle.latched).toBe(true)
    expect(names()).toEqual(['start'])

    vi.advanceTimersByTime(5000)
    await pointer('pointerdown')
    expect(names()).toEqual(['start'])
    await pointer('pointerup')
    expect(names()).toEqual(['start', 'stop'])
    expect(handle.latched).toBe(false)
  })

  it('keyboard: Space starts latched, Enter stops; a key repeat does nothing', async () => {
    await render()
    await key(' ')
    expect(names()).toEqual(['start'])
    expect(handle.latched).toBe(true)
    await key(' ', { repeat: true })
    expect(names()).toEqual(['start'])
    await key('Enter')
    expect(names()).toEqual(['start', 'stop'])
  })

  it('interim vs final: the finalized prefix is solid, the rest interim', async () => {
    await render()
    await key('Enter')
    await emit({ type: 'transcript', turnId: 't', text: 'book the', final: false })
    await emit({ type: 'transcript', turnId: 't', text: 'book the room', final: true })
    expect(handle.transcript).toEqual({ final: 'book the room', interim: '' })
    await emit({ type: 'transcript', turnId: 't', text: 'book the room for fri', final: false })
    expect(handle.transcript).toEqual({ final: 'book the room', interim: ' for fri' })
  })

  it('Esc cancels: voice_cancel, nothing committed', async () => {
    await render()
    await key('Enter')
    const id = sessionId()
    await emit({ type: 'transcript', turnId: 't', text: 'never mind', final: true })
    await key('Escape', { target: document.body })
    expect(bridge.calls.at(-1)).toEqual(['cancel', id])
    expect(handle.active).toBe(false)
    expect(commits).toEqual([])
    // A late event from the cancelled session is never seen.
    expect(bridge.listeners.size).toBe(0)
  })

  it('a refused start reports its code and resets', async () => {
    bridge.startError = new VoiceRefusedError('mic_denied')
    await render()
    await pointer('pointerdown')
    expect(refusals).toEqual(['mic_denied'])
    expect(handle.active).toBe(false)
    expect(bridge.listeners.size).toBe(0)
    await pointer('pointerup')
    expect(names()).toEqual(['start'])
  })

  it('an end the user did not ask for keeps only the final words', async () => {
    await render()
    await key('Enter')
    await emit({ type: 'transcript', turnId: 't', text: 'first part', final: true })
    await emit({ type: 'transcript', turnId: 't', text: 'first part and mor', final: false })
    await emit({ type: 'ended', reason: 'device' })
    expect(commits).toEqual(['first part'])
  })

  it('no voice://ended after a stop: commits what was heard after the timeout', async () => {
    await render()
    await key('Enter')
    await emit({ type: 'transcript', turnId: 't', text: 'still here', final: false })
    await key('Enter')
    expect(commits).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(DICTATION_STOP_TIMEOUT_MS)
    })
    expect(commits).toEqual(['still here'])
    expect(handle.active).toBe(false)
  })

  it('disabled: pointerdown does nothing; the mic taken mid-session stops it', async () => {
    enabled = false
    await render()
    await pointer('pointerdown')
    expect(names()).toEqual([])

    enabled = true
    await render()
    await key('Enter')
    enabled = false
    await render()
    expect(names()).toEqual(['start', 'stop'])
  })

  it('a stop waits 5.5 s after voice_stop for the words (the desktop can take ~4.5 s)', async () => {
    expect(DICTATION_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(3000 + 1500 + 500)
    await render()
    await key('Enter')
    const id = sessionId()
    await emit({ type: 'transcript', turnId: 't', text: 'book the', final: false })
    await key('Enter')
    await act(async () => {
      vi.advanceTimersByTime(4700)
    })
    expect(commits).toEqual([])
    expect(handle.phase).toBe('stopping')
    await emit({ type: 'ended', reason: 'stopped', text: 'book the room for Friday' }, id)
    expect(commits).toEqual(['book the room for Friday.']) // the full stop the engine leaves off (@/lib/voice/punctuation)
  })

  it('the stop timeout counts from voice_stop, not from a stop made while voice_start is in flight', async () => {
    let resolveStart: () => void = () => {}
    const slow = new Promise<void>((r) => {
      resolveStart = r
    })
    const { tauriBridge } = await import('@/lib/tauri-bridge')
    const original = tauriBridge.voiceStart
    tauriBridge.voiceStart = async (args) => {
      bridge.calls.push(['start', args])
      await slow
    }
    try {
      await render()
      await key('Enter')
      await key('Enter') // stop while voice_start is pending: no voice_stop yet
      expect(names()).toEqual(['start'])
      await act(async () => {
        vi.advanceTimersByTime(DICTATION_STOP_TIMEOUT_MS + 1000)
      })
      expect(handle.active).toBe(true) // no timer armed yet
      await act(async () => resolveStart())
      await flush()
      expect(names()).toEqual(['start', 'stop'])
      await act(async () => {
        vi.advanceTimersByTime(DICTATION_STOP_TIMEOUT_MS - 1)
      })
      expect(handle.active).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(handle.active).toBe(false)
    } finally {
      tauriBridge.voiceStart = original
    }
  })

  it('holds read-aloud off for the whole session (a reply starting mid-dictation is not spoken)', async () => {
    await render()
    expect(isReadAloudHeld()).toBe(false)
    await key('Enter')
    expect(isReadAloudHeld()).toBe(true)
    // Not a mic claim: that would disable dictation itself (useVoiceAvailability).
    expect(isMicHeld()).toBe(false)
    expect(bridge.ttsCancels).toBe(1) // whatever was playing stops now
    await key('Enter')
    expect(isReadAloudHeld()).toBe(true) // still finalizing
    await emit({ type: 'ended', reason: 'stopped', text: 'hi' })
    expect(isReadAloudHeld()).toBe(false)

    // Esc, and a refused start, release it too.
    await key('Enter')
    expect(isReadAloudHeld()).toBe(true)
    await key('Escape', { target: document.body })
    expect(isReadAloudHeld()).toBe(false)
    bridge.startError = new VoiceRefusedError('busy')
    await key('Enter')
    expect(isReadAloudHeld()).toBe(false)
  })

  it('unmount releases the read-aloud hold', async () => {
    await render()
    await key('Enter')
    expect(isReadAloudHeld()).toBe(true)
    await act(async () => root.unmount())
    expect(isReadAloudHeld()).toBe(false)
    root = createRoot(host)
  })

  it('Esc: bubble phase, never stopped; an Esc a dialog, menu or picker handled is left alone', async () => {
    await render()
    await key('Enter')

    // A picker's own handler took it (preventDefault): dictation keeps going.
    const picker = document.createElement('input')
    picker.addEventListener('keydown', (e) => e.preventDefault())
    document.body.appendChild(picker)
    await key('Escape', { target: picker })
    expect(handle.active).toBe(true)

    // Focus inside an open dialog / listbox: its Esc.
    for (const role of ['dialog', 'listbox', 'menu']) {
      const overlay = document.createElement('div')
      overlay.setAttribute('role', role)
      const inner = document.createElement('button')
      overlay.appendChild(inner)
      document.body.appendChild(overlay)
      await key('Escape', { target: inner })
      expect(handle.active).toBe(true)
      overlay.remove()
    }

    // A plain Esc cancels, and still reaches listeners after ours.
    let seenByWindow = false
    const late = () => {
      seenByWindow = true
    }
    window.addEventListener('keydown', late)
    await key('Escape', { target: picker.parentElement! })
    window.removeEventListener('keydown', late)
    expect(handle.active).toBe(false)
    expect(seenByWindow).toBe(true)
    picker.remove()
  })

  it('a refusal carries the desktop detail', async () => {
    bridge.startError = new VoiceRefusedError('unavailable', 'unavailable: the audio thread could not start')
    await render()
    await key('Enter')
    expect(refusalInfos).toEqual([{ code: 'unavailable', detail: 'the audio thread could not start' }])
  })

  it('onFinish reports every end: committed, empty, cancelled, refused', async () => {
    await render()
    await key('Enter')
    await key('Enter')
    await emit({ type: 'ended', reason: 'stopped', text: 'words' })
    await key('Enter')
    await key('Enter')
    await emit({ type: 'ended', reason: 'stopped', text: '' })
    await key('Enter')
    await key('Escape', { target: document.body })
    bridge.startError = new VoiceRefusedError('busy')
    await key('Enter')
    expect(finishes).toEqual([{ cancelled: false }, { cancelled: false }, { cancelled: true }, { cancelled: false }])
    expect(commits).toEqual(['words'])
  })

  it('unmount cancels the session', async () => {
    await render()
    await key('Enter')
    const id = sessionId()
    await act(async () => root.unmount())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['cancel', id])
    // afterEach unmounts again; give it a fresh root.
    root = createRoot(host)
  })
})
