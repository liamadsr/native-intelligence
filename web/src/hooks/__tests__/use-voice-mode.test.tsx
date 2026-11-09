// @vitest-environment jsdom
/**
 * useVoiceMode — a spoken conversation in one ChatPanel, with the voice bridge
 * and the read-aloud handle mocked.
 *
 * Contract pinned here (docs/plans/chat-voice.md §3.4):
 *  - start(): a `conversation` session with the Voice mode settings
 *    (endSilenceMs / bargeIn), listening before voice_start.
 *  - voice://turn → read-aloud follows the next turn, then sendTurn(text). A
 *    reply still submitted/streaming is stop()ped (and awaited) first.
 *  - voice://interrupted → readAloud.interrupt() (the queue is dropped).
 *  - voice://ended → the session is gone here; later events are ignored.
 *  - Ends: end() (voice_stop), Esc, the panel going inactive, a chat switch,
 *    the mic being taken, unmount (voice_cancel). A user end silences the reply.
 *    Esc only when nothing else claimed it (an open dialog / menu / picker).
 *  - An idle end while the reply is still coming says so (not "5 minutes of
 *    silence"). A refused start returns its code and the desktop's detail.
 *  - The phase: Starting… / Listening / Thinking… / Speaking… / Muted.
 *  - Levels and the words heard go to the live store, not React state. The
 *    words split like dictation's (finalized / interim), start over with each
 *    turn, and clear when the turn ends, so the field is clean for the next.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceEvent } from '@/lib/tauri-bridge'
import type { ReadAloudHandle } from '@/hooks/use-read-aloud'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  listeners: new Map<string, (e: VoiceEvent) => void>(),
  startError: null as unknown,
  toasts: [] as string[],
}))

vi.mock('@/lib/voice/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/messages')>()),
  voiceToast: (m: string) => bridge.toasts.push(m),
  voiceEndedMessage: (reason: string, _mode: string, opts?: { replyPending?: boolean }) =>
    reason === 'idle' ? (opts?.replyPending ? 'ended: idle, reply pending' : 'ended: idle') : null,
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
      voiceStop: async (id: string) => void bridge.calls.push(['stop', id]),
      voiceCancel: async (id: string) => void bridge.calls.push(['cancel', id]),
      voiceSetMuted: async (id: string, muted: boolean) => void bridge.calls.push(['mute', id, muted]),
      voiceSetAside: async (id: string, aside: boolean) => void bridge.calls.push(['aside', id, aside]),
      ttsPrepare: async () => {},
      onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
        bridge.listeners.set(id, cb)
        return () => bridge.listeners.delete(id)
      },
    },
  }
})

/** Voice focus: off unless a test makes a gate (the desktop sends no speech). */
const focusCtl = vi.hoisted(() => ({ make: null as null | ((sessionId: string) => unknown) }))
vi.mock('@/lib/voice/voice-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/voice-focus')>()),
  openVoiceFocus: (id: string) => focusCtl.make?.(id) ?? null,
  prepareVoiceFocus: () => {},
}))

import { useVoiceMode, type UseVoiceModeOptions, type VoiceModeHandle } from '../use-voice-mode'
import { VOICE_FOCUS_IGNORED, VoiceFocusGate, type VoiceFocusAction } from '@/lib/voice/voice-focus'
import { VoiceRefusedError } from '@/lib/tauri-bridge'
import { setVoicePause } from '@/lib/voice/settings'
import { setSoundEffectsEnabled } from '@/lib/sounds/settings'

let root: Root
let host: HTMLDivElement
let handle: VoiceModeHandle
let props: UseVoiceModeOptions
let renders = 0
/** Everything the hook asked of the panel and read-aloud, in order. */
let log: string[]

function makeReadAloud(speaking: string | null = null): ReadAloudHandle {
  return {
    supported: true,
    speakingMessageId: speaking,
    speakMessage: () => {},
    // Voice mode only ever stops; a pause here would show up in the log.
    pause: () => void log.push('readAloud.pause'),
    stop: () => void log.push('readAloud.stop'),
    followNextTurn: () => void log.push('readAloud.followNextTurn'),
    interrupt: () => void log.push('readAloud.interrupt'),
    // The intro (chime + greeting) has its own suite: use-voice-mode-intro.
    speakLine: () => null,
  }
}

function Harness(p: UseVoiceModeOptions) {
  renders++
  handle = useVoiceMode(p)
  return null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function render(next: Partial<UseVoiceModeOptions> = {}) {
  props = { ...props, ...next }
  await act(async () => {
    root.render(h(Harness, props))
  })
  await flush()
}

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

async function start() {
  let code: unknown
  await act(async () => {
    code = await handle.start()
  })
  await flush()
  return code
}

beforeEach(() => {
  window.localStorage.clear()
  // No start chime here (the intro has its own suite).
  setSoundEffectsEnabled(false)
  bridge.calls = []
  bridge.listeners.clear()
  bridge.startError = null
  bridge.toasts = []
  focusCtl.make = null
  log = []
  renders = 0
  props = {
    canStart: true,
    blocked: false,
    active: true,
    chatKey: 'chat-1',
    status: 'ready',
    stop: async () => void log.push('chat.stop'),
    sendTurn: async (text: string) => void log.push(`send:${text}`),
    readAloud: makeReadAloud(),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useVoiceMode', () => {
  it('starts a conversation session with the Voice mode settings', async () => {
    setVoicePause('normal')
    await render()
    expect(await start()).toBeNull()
    expect(bridge.calls[0]).toEqual([
      'start',
      { sessionId: expect.stringMatching(/^conv-/), mode: 'conversation', endSilenceMs: 700, bargeIn: true, noiseProfile: 'quiet' },
    ])
    expect(handle.active).toBe(true)
    expect(handle.phase).toBe('starting')
    await emit({ type: 'state', state: 'listening', echo: 'cancelling' })
    expect(handle.phase).toBe('listening')
  })

  it('asks for the quiet room even when an older build stored a noisy one', async () => {
    window.localStorage.setItem('dial8:voice:noise', 'noisy')
    await render()
    expect(await start()).toBeNull()
    expect(bridge.calls[0]).toEqual(['start', expect.objectContaining({ noiseProfile: 'quiet' })])
  })

  it('a refused start returns its code and leaves nothing running', async () => {
    bridge.startError = new VoiceRefusedError('busy')
    await render()
    expect(await start()).toEqual({ code: 'busy', detail: null })
    expect(handle.active).toBe(false)
    expect(bridge.listeners.size).toBe(0)
  })

  it('a refused start carries the desktop detail (the mic failing to start is not a version problem)', async () => {
    bridge.startError = new VoiceRefusedError('unavailable', 'unavailable: the microphone could not start: busy')
    await render()
    expect(await start()).toEqual({ code: 'unavailable', detail: 'the microphone could not start: busy' })
  })

  it('cannot start while the modules are not ready', async () => {
    await render({ canStart: false })
    expect(await start()).toEqual({ code: 'not_ready', detail: null })
    expect(bridge.calls).toEqual([])
  })

  it('voice://turn: read-aloud follows the next turn, then the text goes out', async () => {
    await render()
    await start()
    await emit({ type: 'transcript', turnId: 't1', text: 'book the', final: false })
    expect(handle.live.get().transcript).toEqual({ final: '', interim: 'book the' })
    await emit({ type: 'turn', turnId: 't1', text: '  book the room  ' })
    expect(log).toEqual(['readAloud.followNextTurn', 'send:book the room'])
    expect(handle.live.get().transcript).toBeNull()
  })

  it('the words heard split like dictation’s, and start over with the next turn', async () => {
    await render()
    await start()
    await emit({ type: 'transcript', turnId: 't1', text: 'book the', final: true })
    expect(handle.live.get().transcript).toEqual({ final: 'book the', interim: '' })
    await emit({ type: 'transcript', turnId: 't1', text: 'book the room', final: false })
    expect(handle.live.get().transcript).toEqual({ final: 'book the', interim: ' room' })
    await emit({ type: 'turn', turnId: 't1', text: 'book the room' })
    expect(handle.live.get().transcript).toBeNull()
    // A new turn that happens to start with the old words is all interim.
    await emit({ type: 'transcript', turnId: 't2', text: 'book the flight', final: false })
    expect(handle.live.get().transcript).toEqual({ final: '', interim: 'book the flight' })
  })

  it('an empty turn still clears the words heard', async () => {
    await render()
    await start()
    await emit({ type: 'transcript', turnId: 't1', text: 'uh', final: false })
    await emit({ type: 'turn', turnId: 't1', text: '  ' })
    expect(handle.live.get().transcript).toBeNull()
    expect(log).toEqual([])
  })

  it('an empty turn sends nothing', async () => {
    await render()
    await start()
    await emit({ type: 'turn', turnId: 't1', text: '   ' })
    expect(log).toEqual([])
  })

  it('a reply still streaming is stopped (and awaited) before the turn is sent', async () => {
    let finishStop!: () => void
    await render({
      status: 'streaming',
      stop: () =>
        new Promise<void>((resolve) => {
          log.push('chat.stop')
          finishStop = resolve
        }),
    })
    await start()
    await emit({ type: 'turn', turnId: 't2', text: 'actually, wait' })
    expect(log).toEqual(['chat.stop'])
    await act(async () => finishStop())
    await flush()
    expect(log).toEqual(['chat.stop', 'readAloud.followNextTurn', 'send:actually, wait'])
  })

  it('turns go out in order', async () => {
    await render()
    await start()
    await act(async () => {
      bridge.listeners.get(sessionId())?.({ type: 'turn', turnId: 'a', text: 'one' })
      bridge.listeners.get(sessionId())?.({ type: 'turn', turnId: 'b', text: 'two' })
    })
    await flush()
    expect(log.filter((l) => l.startsWith('send:'))).toEqual(['send:one', 'send:two'])
  })

  it('voice://interrupted drops the queued sentences', async () => {
    await render()
    await start()
    await emit({ type: 'interrupted', turnId: 't1' })
    expect(log).toEqual(['readAloud.interrupt'])
  })

  it('voice://ended resets the UI; later events are ignored', async () => {
    await render()
    await start()
    const id = sessionId()
    await emit({ type: 'ended', reason: 'idle' }, id)
    expect(handle.active).toBe(false)
    expect(bridge.toasts).toEqual(['ended: idle'])
    expect(bridge.listeners.size).toBe(0)
    // Not our end: the desktop already closed it, and the reply isn't silenced.
    expect(bridge.calls.map(([n]) => n)).toEqual(['start'])
    expect(log).toEqual([])
  })

  it('an idle end while the reply is still coming says so', async () => {
    await render({ status: 'streaming' })
    await start()
    await emit({ type: 'ended', reason: 'idle' })
    expect(handle.active).toBe(false)
    expect(bridge.toasts).toEqual(['ended: idle, reply pending'])
  })

  it('end() stops the session and silences the reply', async () => {
    await render()
    await start()
    const id = sessionId()
    await act(async () => handle.end())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['stop', id])
    expect(log).toEqual(['readAloud.stop'])
    expect(handle.active).toBe(false)
  })

  it('Esc cancels it', async () => {
    await render()
    await start()
    const id = sessionId()
    let seenLater = false
    const later = () => {
      seenLater = true
    }
    window.addEventListener('keydown', later)
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    window.removeEventListener('keydown', later)
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['cancel', id])
    expect(handle.active).toBe(false)
    // Not swallowed: listeners after ours still get it.
    expect(seenLater).toBe(true)
  })

  it('an Esc a dialog, popover, menu or select handles is theirs: voice mode stays on', async () => {
    await render()
    await start()
    const esc = (target: EventTarget) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })

    // Radix's layers handle Esc on document in the capture phase and
    // preventDefault() it before our bubble-phase listener runs.
    const radix = (e: KeyboardEvent) => e.preventDefault()
    document.addEventListener('keydown', radix, true)
    await esc(document.body)
    document.removeEventListener('keydown', radix, true)
    expect(handle.active).toBe(true)

    // Focus inside an open overlay that didn't claim it (e.g. the Settings overlay).
    for (const attrs of [{ role: 'dialog' }, { role: 'menu' }, { role: 'listbox' }, { 'data-radix-popper-content-wrapper': '' }]) {
      const overlay = document.createElement('div')
      for (const [k, v] of Object.entries(attrs)) overlay.setAttribute(k, v)
      const field = document.createElement('input')
      overlay.appendChild(field)
      document.body.appendChild(overlay)
      await esc(field)
      overlay.remove()
      expect(handle.active).toBe(true)
    }

    // A chat composer inside a dialog: voice mode's controls are in there, so Esc is ours.
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const waveform = document.createElement('button')
    waveform.setAttribute('data-voice-control', 'conversation')
    dialog.appendChild(waveform)
    document.body.appendChild(dialog)
    await esc(waveform)
    dialog.remove()
    await flush()
    expect(handle.active).toBe(false)
  })

  it.each([
    ['the panel going inactive (tab switch)', { active: false }],
    ['a chat switch', { chatKey: 'chat-2' }],
    ['a capture taking the mic', { blocked: true }],
  ] as const)('%s ends it', async (_label, change) => {
    await render()
    await start()
    const id = sessionId()
    await render(change)
    expect(bridge.calls.at(-1)).toEqual(['cancel', id])
    expect(handle.active).toBe(false)
  })

  it('unmount cancels it', async () => {
    await render()
    await start()
    const id = sessionId()
    await act(async () => root.unmount())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['cancel', id])
    root = createRoot(host)
  })

  it('mute gates the mic and reads Muted', async () => {
    await render()
    await start()
    const id = sessionId()
    // The model is up (a mute before that waits for it: use-voice-mode-intro).
    await emit({ type: 'state', state: 'listening', echo: 'cancelling' })
    await act(async () => handle.toggleMute())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['mute', id, true])
    expect(handle.muted).toBe(true)
    expect(handle.phase).toBe('muted')
    await act(async () => handle.toggleMute())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['mute', id, false])
    expect(handle.phase).toBe('listening')
  })

  it('phase: Thinking… while the reply generates, Speaking… while it is read, half duplex offers tap-to-interrupt', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'processing', echo: 'cancelling' })
    expect(handle.phase).toBe('thinking')
    await emit({ type: 'state', state: 'listening', echo: 'cancelling' })
    await render({ status: 'submitted' })
    expect(handle.phase).toBe('thinking')
    await render({ status: 'streaming', readAloud: makeReadAloud('m1') })
    expect(handle.phase).toBe('speaking')
    expect(handle.agentSpeaking).toBe(true)
    await emit({ type: 'state', state: 'agent_speaking', echo: 'half_duplex' })
    expect(handle.echo).toBe('half_duplex')
    await act(async () => handle.interrupt())
    expect(log).toEqual(['readAloud.stop'])
    await emit({ type: 'state', state: 'user_speaking', echo: 'cancelling' })
    await render({ status: 'ready', readAloud: makeReadAloud(null) })
    expect(handle.phase).toBe('listening')
  })

  it('levels and the words heard never re-render the panel', async () => {
    await render()
    await start()
    const before = renders
    const seen: number[] = []
    const off = handle.live.subscribe(() => seen.push(handle.live.get().mic))
    for (const mic of [0.1, 0.5, 0.9]) await emit({ type: 'level', mic, agent: 0.2 })
    expect(seen).toEqual([0.1, 0.5, 0.9])
    expect(handle.live.get()).toMatchObject({ mic: 0.9, agent: 0.2 })
    await emit({ type: 'transcript', turnId: 't1', text: 'hi', final: false })
    expect(renders).toBe(before)
    off()
  })
})

describe('useVoiceMode — a turn handled where it was said (bots-v2.md Phase 4)', () => {
  it('interceptTurn sees each turn first: one it handles is never sent, stops no reply and is followed by nothing', async () => {
    const intercepted: string[] = []
    await render({
      status: 'streaming',
      interceptTurn: (text: string) => {
        intercepted.push(text)
        return text === 'Yes.'
      },
    })
    await start()
    await emit({ type: 'state', state: 'listening', echo: 'cancelling' })
    await emit({ type: 'transcript', turnId: 't1', text: 'Yes.', final: true })
    await emit({ type: 'turn', turnId: 't1', text: '  Yes.  ' })
    expect(intercepted).toEqual(['Yes.'])
    expect(log).toEqual([])
    // The words heard are cleared for the next turn.
    expect(handle.live.get().transcript).toBeNull()

    // One it doesn't handle goes out as ever.
    await emit({ type: 'turn', turnId: 't2', text: 'Do I have any new emails?' })
    expect(intercepted).toEqual(['Yes.', 'Do I have any new emails?'])
    expect(log).toEqual(['chat.stop', 'readAloud.followNextTurn', 'send:Do I have any new emails?'])
  })

  it('an empty turn is never offered', async () => {
    const intercepted: string[] = []
    await render({
      interceptTurn: (text: string) => {
        intercepted.push(text)
        return false
      },
    })
    await start()
    await emit({ type: 'turn', turnId: 't1', text: '   ' })
    expect(intercepted).toEqual([])
  })
})

describe('useVoiceMode — Voice focus (a voice Native Intelligence doesn’t know is ignored)', () => {
  /** A gate whose verdicts the test hands out, turn by turn (Voice focus on
   *  unless `on` says otherwise). */
  function fakeGate({ on = true }: { on?: boolean } = {}) {
    const verdicts = new Map<string, { promise: Promise<VoiceFocusAction>; resolve: (a: VoiceFocusAction) => void }>()
    const gate = {
      on,
      speech: [] as string[],
      skipped: [] as string[],
      observed: [] as string[],
      judged: [] as string[],
      disposed: false,
      onSpeech: (ev: { turnId: string }) => void gate.speech.push(ev.turnId),
      focusOn: () => gate.on,
      observe: (turnId: string) => void gate.observed.push(turnId),
      judge: (turnId: string) => {
        gate.judged.push(turnId)
        return verdict(turnId).promise
      },
      skip: (turnId: string) => void gate.skipped.push(turnId),
      dispose: () => void (gate.disposed = true),
    }
    function verdict(turnId: string) {
      let v = verdicts.get(turnId)
      if (!v) {
        let resolve!: (a: VoiceFocusAction) => void
        const promise = new Promise<VoiceFocusAction>((r) => (resolve = r))
        v = { promise, resolve }
        verdicts.set(turnId, v)
      }
      return v
    }
    const decide = async (turnId: string, action: VoiceFocusAction) => {
      await act(async () => verdict(turnId).resolve(action))
      await flush()
    }
    focusCtl.make = () => gate
    return { gate, decide }
  }

  it('asks the desktop for speech audio only with a gate, and hands it every voice://speech', async () => {
    await render()
    await start()
    expect(bridge.calls[0][1]).not.toHaveProperty('speechAudio')
    await act(async () => handle.end())
    await flush()

    const { gate } = fakeGate()
    await start()
    const startCall = bridge.calls.filter(([n]) => n === 'start')[1]
    expect(startCall[1]).toMatchObject({ mode: 'conversation', speechAudio: true })
    await emit({ type: 'speech', turnId: 't1', seq: 0, end: false, startMs: 0, sampleRate: 16000, pcm: 'AAA=' })
    await emit({ type: 'speech', turnId: 't1', seq: 1, end: true, outcome: 'turn' })
    expect(gate.speech).toEqual(['t1', 't1'])
    await act(async () => handle.end())
    await flush()
    expect(gate.disposed).toBe(true)
  })

  it('a dropped turn is never sent, stops no reply, is followed by nothing, and the field says so briefly', async () => {
    const intercepted: string[] = []
    const { decide } = fakeGate()
    await render({
      status: 'streaming',
      interceptTurn: (text: string) => {
        intercepted.push(text)
        return false
      },
    })
    await start()
    await emit({ type: 'state', state: 'listening', echo: 'cancelling' })
    await emit({ type: 'transcript', turnId: 't1', text: 'and now the weather', final: false })
    await emit({ type: 'turn', turnId: 't1', text: 'and now the weather' })
    // The preview clears at once, whatever the verdict.
    expect(handle.live.get().transcript).toBeNull()
    expect(log).toEqual([])
    await decide('t1', 'drop')
    expect(log).toEqual([])
    expect(intercepted).toEqual([])
    expect(handle.live.get().notice).toBe(VOICE_FOCUS_IGNORED)
    // The next words take the field back.
    await emit({ type: 'transcript', turnId: 't2', text: 'what time', final: false })
    expect(handle.live.get().notice).toBeNull()
  })

  it('a sent turn goes exactly as without Voice focus: the reply stopped, read-aloud follows, then the text', async () => {
    const intercepted: string[] = []
    const { decide } = fakeGate()
    await render({
      status: 'streaming',
      interceptTurn: (text: string) => {
        intercepted.push(text)
        return false
      },
    })
    await start()
    await emit({ type: 'turn', turnId: 't1', text: ' book the room ' })
    expect(log).toEqual([])
    await decide('t1', 'send')
    expect(intercepted).toEqual(['book the room'])
    expect(log).toEqual(['chat.stop', 'readAloud.followNextTurn', 'send:book the room'])
    expect(handle.live.get().notice ?? null).toBeNull()
  })

  it('turns stay in order: a later verdict waits for the earlier one', async () => {
    const { decide } = fakeGate()
    await render()
    await start()
    await act(async () => {
      bridge.listeners.get(sessionId())?.({ type: 'turn', turnId: 'a', text: 'one' })
      bridge.listeners.get(sessionId())?.({ type: 'turn', turnId: 'b', text: 'two' })
    })
    await decide('b', 'send')
    expect(log).toEqual([])
    await decide('a', 'drop')
    expect(log).toEqual(['readAloud.followNextTurn', 'send:two'])
  })

  it('Voice focus off: a turn goes exactly as without it (interceptTurn at once, no verdict waited on); the score is only logged', async () => {
    const intercepted: string[] = []
    const { gate } = fakeGate({ on: false })
    await render({
      interceptTurn: (text: string) => {
        intercepted.push(text)
        return text === 'Yes.'
      },
    })
    await start()
    const fire = bridge.listeners.get(sessionId())!
    // Synchronously, inside the event: the bubble's "yes" is handled there and then.
    act(() => fire({ type: 'turn', turnId: 't1', text: ' Yes. ' }))
    expect(intercepted).toEqual(['Yes.'])
    expect(gate.observed).toEqual(['t1'])
    expect(gate.judged).toEqual([])
    // One it doesn't handle goes out with no verdict to wait on (none is ever given).
    act(() => fire({ type: 'turn', turnId: 't2', text: 'book the room' }))
    expect(intercepted).toEqual(['Yes.', 'book the room'])
    await flush()
    expect(log).toEqual(['readAloud.followNextTurn', 'send:book the room'])
    expect(gate.observed).toEqual(['t1', 't2'])
    expect(gate.judged).toEqual([])
  })

  it('Voice focus on: interceptTurn waits for the verdict', async () => {
    const intercepted: string[] = []
    const { gate, decide } = fakeGate()
    await render({
      interceptTurn: (text: string) => {
        intercepted.push(text)
        return true
      },
    })
    await start()
    act(() => bridge.listeners.get(sessionId())!({ type: 'turn', turnId: 't1', text: 'Yes.' }))
    expect(intercepted).toEqual([])
    expect(gate.judged).toEqual(['t1'])
    await decide('t1', 'send')
    expect(intercepted).toEqual(['Yes.'])
    expect(log).toEqual([])
  })

  it('an empty turn is not judged (its audio is let go) and sends nothing', async () => {
    const { gate } = fakeGate()
    await render()
    await start()
    await emit({ type: 'turn', turnId: 't1', text: '   ' })
    expect(gate.skipped).toEqual(['t1'])
    expect(log).toEqual([])
  })

  it('fails open: a verdict that doesn’t come in time sends the turn', async () => {
    focusCtl.make = (id) =>
      new VoiceFocusGate(id, {
        // The model never answers.
        embed: () => new Promise<number[]>(() => {}),
        voiceprint: async () => ({ prototypes: [[1]], selfContactIds: new Set() }),
        gallery: async () => [],
        isOn: () => true,
        log: () => {},
        waitMs: 30,
      })
    await render()
    await start()
    const id = sessionId()
    // 0.5 s of a speech-loud tone, base64 Int16 LE.
    let bin = ''
    for (let i = 0; i < 8000; i++) {
      const v = Math.round(3000 * Math.sin((2 * Math.PI * 200 * i) / 16000)) & 0xffff
      bin += String.fromCharCode(v & 0xff, v >> 8)
    }
    const pcm = btoa(bin)
    for (let seq = 0; seq < 4; seq++) {
      await emit({ type: 'speech', turnId: 't1', seq, end: false, startMs: seq * 500, sampleRate: 16000, pcm }, id)
    }
    await emit({ type: 'speech', turnId: 't1', seq: 4, end: true, outcome: 'turn' }, id)
    await emit({ type: 'turn', turnId: 't1', text: 'hello there' }, id)
    expect(log).toEqual([])
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    await flush()
    expect(log).toEqual(['readAloud.followNextTurn', 'send:hello there'])
  })
})

describe('useVoiceMode — one conversation per page', () => {
  let a: VoiceModeHandle
  let b: VoiceModeHandle
  function Two(p: UseVoiceModeOptions) {
    a = useVoiceMode({ ...p, chatKey: 'composer' })
    b = useVoiceMode({ ...p, chatKey: 'bubble' })
    return null
  }
  const starts = () => bridge.calls.filter(([name]) => name === 'start').map(([, args]) => (args as { sessionId: string }).sessionId)

  it('starting one ends the other at once (cancelled at the desktop), and back again', async () => {
    await act(async () => root.render(h(Two, props)))
    await flush()
    await act(async () => void (await a.start()))
    await flush()
    expect(a.active).toBe(true)
    const [first] = starts()

    await act(async () => void (await b.start()))
    await flush()
    expect(a.active).toBe(false)
    expect(b.active).toBe(true)
    expect(bridge.calls).toContainEqual(['cancel', first])
    // Its events are no longer heard.
    expect(bridge.listeners.has(first)).toBe(false)

    const second = starts()[1]
    await act(async () => void (await a.start()))
    await flush()
    expect(b.active).toBe(false)
    expect(a.active).toBe(true)
    expect(bridge.calls).toContainEqual(['cancel', second])
  })

  it('a session that ended lets go: the next start ends nobody', async () => {
    await act(async () => root.render(h(Two, props)))
    await flush()
    await act(async () => void (await a.start()))
    await flush()
    await act(async () => a.end())
    await flush()
    const before = bridge.calls.length
    await act(async () => void (await b.start()))
    await flush()
    expect(bridge.calls.slice(before).filter(([name]) => name === 'cancel' || name === 'stop')).toEqual([])
    expect(b.active).toBe(true)
  })
})
