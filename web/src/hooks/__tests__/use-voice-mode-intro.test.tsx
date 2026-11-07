// @vitest-environment jsdom
/**
 * useVoiceMode's sounds and greeting, with the voice bridge, read-aloud and
 * the sound engine mocked (the chime ends when a test says so).
 *
 * Contract pinned here:
 *  - The intro means "the model is up": it waits for voice_start to resolve
 *    AND a desktop state past `starting` (never `muted`), in either order.
 *    Until then: no chime, no greeting, Starting…; a session that never gets
 *    there has none of them (and no end cue).
 *  - Then: nothing mutes the mic (it listens from readiness on),
 *    `voice-chat-start` plays, and the greeting is sent through read-aloud's
 *    speakLine GREETING_LEAD_MS before the chime ends, marked an aside
 *    (voice_set_aside).
 *  - The user comes first: talking before the greeting's time (user_speaking,
 *    processing, a transcript, a turn) skips it; talking during it stops it
 *    at once (only it: never a reply that took over, nor a greeting already
 *    over); a desktop barge-in into it is read-aloud's interrupt.
 *  - A desktop with voice_status `readyFlag` sends `ready` on voice://state:
 *    then that flag alone is readiness (speech or a mute before local-stt is
 *    ready waits for `ready: true`, re-sent under the same state); without
 *    it (0.2.45) readiness is inferred from the state.
 *  - A mute before the model is up stays on the web (the desktop's muted
 *    state would hide readiness); the chime and greeting still play when it
 *    is up, and the mic stays muted.
 *  - The greeting is spoken only: no turn, no send, no followNextTurn.
 *  - Sound effects off: no chime; the greeting still speaks.
 *    No read-aloud: no greeting. A refused start: nothing at all.
 *  - `voice-chat-end` whenever a live session ends (the waveform, Esc, an
 *    error, the desktop ending it); not for a refused start, nor when a
 *    capture takes the mic. Ending during the intro stops the chime and
 *    cancels the greeting.
 *  - A live session keeps alert sounds quiet.
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
  /** Resolve voice_start by hand (null = at once). */
  gate: null as Promise<void> | null,
}))

interface FakeSound {
  name: string
  stopped: boolean
  /** The sound reaches the point nearEnd waits for. */
  near: () => void
  /** The sound plays to its end. */
  end: () => void
}
const sounds = vi.hoisted(() => ({ played: [] as FakeSound[], unplayable: false }))

vi.mock('@/lib/sounds/engine', () => ({
  playSound: (name: string) => {
    let end!: () => void
    let near!: () => void
    const ended = new Promise<void>((resolve) => (end = resolve))
    const nearing = new Promise<void>((resolve) => (near = resolve))
    const sound: FakeSound = { name, stopped: false, near: () => near(), end: () => end() }
    sounds.played.push(sound)
    if (sounds.unplayable) {
      end()
      near()
    }
    return {
      name,
      started: Promise.resolve(!sounds.unplayable),
      ended,
      nearEnd: () => Promise.race([nearing, ended]),
      stop: () => {
        sound.stopped = true
        end()
      },
    }
  },
}))

vi.mock('@/lib/voice/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/messages')>()),
  voiceToast: () => {},
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
      voiceStart: async (args: unknown) => {
        bridge.calls.push(['start', args])
        if (bridge.gate) await bridge.gate
        if (bridge.startError) throw bridge.startError
      },
      voiceStop: async (id: string) => void bridge.calls.push(['stop', id]),
      voiceCancel: async (id: string) => void bridge.calls.push(['cancel', id]),
      voiceSetMuted: async (id: string, muted: boolean) => void bridge.calls.push(['mute', muted]),
      voiceSetAside: async (id: string, aside: boolean, text?: string) =>
        void bridge.calls.push(['aside', aside, ...(text === undefined ? [] : [text])]),
      ttsPrepare: async () => {},
      onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
        bridge.listeners.set(id, cb)
        return () => bridge.listeners.delete(id)
      },
    },
  }
})

import { useVoiceMode, type UseVoiceModeOptions, type VoiceModeHandle } from '../use-voice-mode'
import { VoiceRefusedError } from '@/lib/tauri-bridge'
import { setSoundEffectsEnabled } from '@/lib/sounds/settings'
import { __resetSoundQuietForTests, isSoundQuiet } from '@/lib/sounds/quiet'
import { VOICE_GREETINGS, __resetGreetingForTests } from '@/lib/voice/greeting'

let root: Root
let host: HTMLDivElement
let handle: VoiceModeHandle
let props: UseVoiceModeOptions
let log: string[]
let lineSeq = 0

function makeReadAloud(over: Partial<ReadAloudHandle> = {}): ReadAloudHandle {
  return {
    supported: true,
    speakingMessageId: null,
    speakMessage: () => {},
    // Voice mode only ever stops; a pause here would show up in the log.
    pause: () => void log.push('readAloud.pause'),
    stop: () => void log.push('readAloud.stop'),
    followNextTurn: () => void log.push('readAloud.followNextTurn'),
    interrupt: () => void log.push('readAloud.interrupt'),
    speakLine: (text: string | readonly string[]) => {
      log.push(`say:${text}`)
      return `line:${++lineSeq}`
    },
    ...over,
  }
}

function Harness(p: UseVoiceModeOptions) {
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

/** The desktop reports the model up and listening (local-stt ready). */
async function ready() {
  await emit({ type: 'state', state: 'listening', echo: 'converging' })
}

/** A start that resolves, then the model comes up. */
async function startLive() {
  const code = await start()
  await ready()
  return code
}

const chime = () => sounds.played.find((s) => s.name === 'voice-chat-start')
const soundNames = () => sounds.played.map((s) => s.name)
const mutes = () => bridge.calls.filter(([n]) => n === 'mute').map(([, m]) => m)
const greetings = () => log.filter((l) => l.startsWith('say:')).map((l) => l.slice(4))
const asides = () => bridge.calls.filter(([n]) => n === 'aside').map(([, a]) => a)
/** The text each aside call carried (none for a take-back). */
const asideTexts = () => bridge.calls.filter(([n]) => n === 'aside').map(([, , t]) => t)
const stops = () => log.filter((l) => l === 'readAloud.stop').length

/** The chime reaches its tail (the greeting goes out). */
async function chimeNearsEnd() {
  await act(async () => chime()!.near())
  await flush()
}

/** The chime ends. */
async function chimeEnds() {
  await act(async () => chime()!.end())
  await flush()
}

/** Read-aloud now shows `id` speaking (null: nothing). */
async function speakingNow(id: string | null) {
  await render({ readAloud: makeReadAloud({ speakingMessageId: id }) })
}

beforeEach(() => {
  window.localStorage.clear()
  __resetGreetingForTests()
  __resetSoundQuietForTests()
  bridge.calls = []
  bridge.listeners.clear()
  bridge.startError = null
  bridge.gate = null
  sounds.played = []
  sounds.unplayable = false
  log = []
  lineSeq = 0
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

describe('voice mode: the start chime and the greeting', () => {
  it('sends no mute: the mic listens from readiness, the chime plays and the greeting goes out over its tail', async () => {
    await render()
    expect(await startLive()).toBeNull()
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([])
    expect(handle.phase).toBe('listening')

    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
    expect(VOICE_GREETINGS).toContain(greetings()[0])
    await chimeEnds()
    expect(greetings()).toHaveLength(1)
    // Never a mute, from the start to the end of the session.
    await act(async () => handle.end())
    await flush()
    expect(mutes()).toEqual([])
  })

  it('greeting: false plays the chime alone: no greeting, no aside (a bot bubble)', async () => {
    await render({ greeting: false })
    expect(await startLive()).toBeNull()
    expect(soundNames()).toEqual(['voice-chat-start'])
    await chimeNearsEnd()
    await chimeEnds()
    expect(greetings()).toEqual([])
    expect(asides()).toEqual([])
  })

  it('the greeting is an aside: marked before it is spoken', async () => {
    await render({
      readAloud: makeReadAloud({
        speakLine: (text: string | readonly string[]) => {
          log.push(`say:${text}`)
          log.push(`asides:${asides().join(',')}`)
          return 'line:1'
        },
      }),
    })
    await startLive()
    await chimeNearsEnd()
    expect(log).toEqual([`say:${greetings()[0]}`, 'asides:true'])
    expect(asides()).toEqual([true])
  })

  it("the aside carries the greeting's text (the desktop drops its echo from the user's turn)", async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
    expect(asideTexts()).toEqual([greetings()[0]])
    // Taken back when the user starts: no text.
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(asides()).toEqual([true, false])
    expect(asideTexts()).toEqual([greetings()[0], undefined])
  })

  it('no line spoken after all (speakLine says null): the aside is taken back', async () => {
    await render({ readAloud: makeReadAloud({ speakLine: () => null }) })
    await startLive()
    await chimeNearsEnd()
    expect(asides()).toEqual([true, false])
  })

  it('the phase: listening during the chime, speaking during the greeting', async () => {
    await render()
    await startLive()
    expect(handle.phase).toBe('listening')
    await chimeNearsEnd()
    await speakingNow('line:1')
    expect(handle.phase).toBe('speaking')
    expect(handle.agentSpeaking).toBe(true)
    await speakingNow(null)
    await emit({ type: 'state', state: 'listening', echo: 'converging' })
    expect(handle.phase).toBe('listening')
    // The desktop's muted is the user's (nothing else mutes it now).
    await emit({ type: 'state', state: 'muted', echo: 'cancelling' })
    expect(handle.phase).toBe('muted')
  })

  it("the user's mute during the chime reaches the desktop at once and stands", async () => {
    await render()
    await startLive()
    await act(async () => handle.toggleMute())
    await flush()
    expect(handle.muted).toBe(true)
    expect(handle.phase).toBe('muted')
    expect(mutes()).toEqual([true])
    await chimeNearsEnd()
    await chimeEnds()
    expect(mutes()).toEqual([true])
    expect(handle.phase).toBe('muted')
    await act(async () => handle.toggleMute())
    await flush()
    expect(mutes()).toEqual([true, false])
  })

  it('mute then unmute during the chime: both reach the desktop, in order', async () => {
    await render()
    await startLive()
    await act(async () => handle.toggleMute())
    await act(async () => handle.toggleMute())
    await flush()
    expect(mutes()).toEqual([true, false])
    await chimeEnds()
    expect(mutes()).toEqual([true, false])
  })

  it('the greeting is spoken only: never a turn, never sent, never followed as a reply', async () => {
    await render()
    await startLive()
    await chimeEnds()
    expect(log).toEqual([`say:${greetings()[0]}`])
    expect(log.some((l) => l.startsWith('send:') || l === 'readAloud.followNextTurn')).toBe(false)
  })

  it('never the same greeting twice in a row across starts', async () => {
    await render()
    for (let i = 0; i < 8; i++) {
      await startLive()
      await chimeEnds()
      await act(async () => handle.end())
      await flush()
      sounds.played = []
    }
    const said = greetings()
    expect(said).toHaveLength(8)
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1])
  })

  it('Sound effects off: no chime, no mute, the greeting still speaks', async () => {
    setSoundEffectsEnabled(false)
    await render()
    await startLive()
    expect(soundNames()).not.toContain('voice-chat-start')
    expect(mutes()).toEqual([])
    expect(greetings()).toHaveLength(1)
  })

  it('the chime cannot play (no audio): the greeting speaks at once', async () => {
    sounds.unplayable = true
    await render()
    await startLive()
    expect(mutes()).toEqual([])
    expect(greetings()).toHaveLength(1)
  })

  it('no read-aloud (TTS not ready): no greeting and no aside, silently; the chime still plays', async () => {
    await render({ readAloud: makeReadAloud({ supported: false }) })
    await startLive()
    await chimeEnds()
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(greetings()).toEqual([])
    expect(asides()).toEqual([])
    expect(mutes()).toEqual([])
  })

  it('a reply already generating: no greeting over it', async () => {
    await render({ status: 'streaming' })
    await startLive()
    await chimeEnds()
    expect(greetings()).toEqual([])
  })

  it('a refused start: no chime, no greeting, no end cue', async () => {
    bridge.startError = new VoiceRefusedError('busy')
    await render()
    await start()
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    expect(greetings()).toEqual([])
  })
})

describe('voice mode: the user comes first', () => {
  it.each([
    ['user_speaking', { type: 'state', state: 'user_speaking', echo: 'converging' }],
    ['processing', { type: 'state', state: 'processing', echo: 'converging' }],
    ['a transcript', { type: 'transcript', turnId: 't1', text: 'so', final: false }],
  ] as const)('talking before the greeting (%s): it is skipped, the chime still plays', async (_label, ev) => {
    await render()
    await startLive()
    await emit(ev as VoiceEvent)
    await chimeNearsEnd()
    await chimeEnds()
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(greetings()).toEqual([])
    expect(asides()).toEqual([])
    expect(mutes()).toEqual([])
  })

  it('a turn before the greeting: it is skipped, and the turn goes out', async () => {
    await render()
    await startLive()
    await emit({ type: 'turn', turnId: 't1', text: 'hello there' })
    await chimeNearsEnd()
    expect(greetings()).toEqual([])
    expect(log).toContain('send:hello there')
  })

  it('an empty caption (a run that came to nothing) is not talking', async () => {
    await render()
    await startLive()
    await emit({ type: 'transcript', turnId: 't1', text: '', final: true })
    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
  })

  it('Sound effects off: speech at readiness itself skips the greeting', async () => {
    setSoundEffectsEnabled(false)
    await render()
    await start()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging', ready: true })
    expect(greetings()).toEqual([])
  })

  it('talking during the greeting stops it at once, and takes the aside back', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await speakingNow('line:1')
    expect(stops()).toBe(0)
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(stops()).toBe(1)
    expect(asides()).toEqual([true, false])
    // Once: the rest of the user's turn stops nothing more.
    await emit({ type: 'transcript', turnId: 't1', text: 'so about', final: false })
    await emit({ type: 'state', state: 'processing', echo: 'converging' })
    expect(stops()).toBe(1)
    // The words go out as the user's turn.
    await emit({ type: 'turn', turnId: 't1', text: 'so about that' })
    expect(log).toContain('send:so about that')
  })

  it('talking right after the greeting was sent (not shown yet): still stopped', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await emit({ type: 'transcript', turnId: 't1', text: 'wait', final: false })
    expect(stops()).toBe(1)
  })

  it('a desktop barge-in into the greeting: interrupted, never stopped twice', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await speakingNow('line:1')
    await emit({ type: 'interrupted', turnId: 't1' })
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(log.filter((l) => l === 'readAloud.interrupt')).toHaveLength(1)
    expect(stops()).toBe(0)
  })

  it('never a reply: once a reply took over, talking stops nothing', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await speakingNow('line:1')
    await speakingNow('a1')
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(stops()).toBe(0)
  })

  it('a greeting that is over is left alone', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await speakingNow('line:1')
    await speakingNow(null)
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(stops()).toBe(0)
    expect(asides()).toEqual([true])
  })

  it("the user's mute is unchanged by talking first", async () => {
    await render()
    await startLive()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    await act(async () => handle.toggleMute())
    await flush()
    expect(mutes()).toEqual([true])
    expect(handle.phase).toBe('muted')
  })
})

describe('voice mode: the intro waits for the model to be up', () => {
  it('voice_start resolving is not readiness: no chime or greeting until the desktop says so', async () => {
    await render()
    expect(await start()).toBeNull()
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    expect(greetings()).toEqual([])
    expect(handle.phase).toBe('starting')
    // Still loading (an echo update re-reports starting): still nothing.
    await emit({ type: 'state', state: 'starting', echo: 'cancelling' })
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    expect(handle.phase).toBe('starting')

    await ready()
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([])
    expect(handle.phase).toBe('listening')
    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
    await chimeEnds()
    expect(mutes()).toEqual([])
  })

  it('a muted state is never readiness', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'muted', echo: 'converging' })
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
  })

  it('user_speaking is past starting too: the intro, without the greeting (the user is talking)', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging' })
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([])
    expect(handle.phase).toBe('listening')
    await chimeNearsEnd()
    expect(greetings()).toEqual([])
  })

  it('the ready state ahead of voice_start resolving: the intro once both are in, once', async () => {
    let open!: () => void
    bridge.gate = new Promise<void>((resolve) => (open = resolve))
    await render()
    let pending!: Promise<unknown>
    await act(async () => {
      pending = handle.start()
    })
    await flush()
    await ready()
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    expect(handle.phase).toBe('starting')

    await act(async () => {
      open()
      await pending
    })
    await flush()
    expect(soundNames()).toEqual(['voice-chat-start'])
    await ready()
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([])
  })

  it('never ready: no chime, no greeting, and no end cue when the error ends it', async () => {
    await render()
    await start()
    await emit({ type: 'ended', reason: 'error', error: 'the transcription session ended' })
    expect(handle.active).toBe(false)
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    expect(greetings()).toEqual([])
  })

  it('ended by the user while still starting: stopped at the desktop, no sounds, and a late ready does nothing', async () => {
    await render()
    await start()
    const id = sessionId()
    await act(async () => handle.end())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['stop', id])
    // The listener is gone; a ready that was already on its way changes nothing.
    await emit({ type: 'state', state: 'listening', echo: 'converging' }, id)
    expect(sounds.played).toEqual([])
    expect(greetings()).toEqual([])
  })

  it('a mute before the model is up stays here; the chime and greeting still play, and the mic stays muted', async () => {
    await render()
    await start()
    await act(async () => handle.toggleMute())
    await flush()
    expect(handle.muted).toBe(true)
    expect(handle.phase).toBe('muted')
    // Not sent: the desktop's muted state would hide readiness.
    expect(mutes()).toEqual([])

    await ready()
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([true])
    expect(handle.phase).toBe('muted')
    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
    await chimeEnds()
    // No unmute after the chime: the user's mute stands.
    expect(mutes()).toEqual([true])
    expect(handle.phase).toBe('muted')
    // Unmuting afterwards reaches the desktop as usual.
    await act(async () => handle.toggleMute())
    await flush()
    expect(mutes()).toEqual([true, false])
  })

  it('mute then unmute before the model is up: the intro runs as usual, with no mute', async () => {
    await render()
    await start()
    await act(async () => handle.toggleMute())
    await act(async () => handle.toggleMute())
    await flush()
    expect(mutes()).toEqual([])
    await ready()
    await chimeEnds()
    expect(mutes()).toEqual([])
    expect(greetings()).toHaveLength(1)
  })

  it('Sound effects off and a mute before the model is up: muted once it is up, and the greeting speaks', async () => {
    setSoundEffectsEnabled(false)
    await render()
    await start()
    await act(async () => handle.toggleMute())
    await flush()
    expect(mutes()).toEqual([])
    expect(greetings()).toEqual([])
    await ready()
    expect(soundNames()).not.toContain('voice-chat-start')
    expect(mutes()).toEqual([true])
    expect(greetings()).toHaveLength(1)
    expect(handle.phase).toBe('muted')
  })

  it('Sound effects off: the greeting waits for the model too', async () => {
    setSoundEffectsEnabled(false)
    await render()
    await start()
    expect(greetings()).toEqual([])
    expect(handle.phase).toBe('starting')
    await ready()
    expect(greetings()).toHaveLength(1)
    expect(mutes()).toEqual([])
  })
})

describe('voice mode: a readyFlag desktop says when the model is up', () => {
  it('speech before ready: nothing until `ready: true` is re-sent under the same state, then the intro once', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging', ready: false })
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    expect(handle.phase).toBe('starting')
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging', ready: true })
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([])
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    expect(soundNames()).toEqual(['voice-chat-start'])
    // Still talking when the model came up: no greeting.
    await chimeNearsEnd()
    expect(greetings()).toEqual([])
  })

  it('speech that ended before ready does not skip the greeting', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'user_speaking', echo: 'converging', ready: false })
    await emit({ type: 'state', state: 'starting', echo: 'converging', ready: false })
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
  })

  it('a state past starting is not readiness while `ready` is false', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'listening', echo: 'cancelling', ready: false })
    expect(sounds.played).toEqual([])
    expect(greetings()).toEqual([])
    expect(handle.phase).toBe('starting')
    await emit({ type: 'state', state: 'listening', echo: 'cancelling', ready: true })
    expect(soundNames()).toEqual(['voice-chat-start'])
  })

  it('muted before ready: `ready: true` under muted starts the intro', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'muted', echo: 'converging', ready: false })
    expect(sounds.played).toEqual([])
    await emit({ type: 'state', state: 'muted', echo: 'converging', ready: true })
    expect(soundNames()).toEqual(['voice-chat-start'])
    await chimeNearsEnd()
    expect(greetings()).toHaveLength(1)
  })

  it("the user's mute before ready still stands through the intro", async () => {
    await render()
    await start()
    await act(async () => handle.toggleMute())
    await flush()
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: false })
    expect(sounds.played).toEqual([])
    expect(mutes()).toEqual([])
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(mutes()).toEqual([true])
    await chimeEnds()
    expect(mutes()).toEqual([true])
    expect(handle.phase).toBe('muted')
  })

  it('readiness dropping later changes nothing: no second intro', async () => {
    await render()
    await start()
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    await chimeEnds()
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: false })
    await emit({ type: 'state', state: 'listening', echo: 'converging', ready: true })
    expect(soundNames()).toEqual(['voice-chat-start'])
    expect(greetings()).toHaveLength(1)
  })
})

describe('voice mode: ending', () => {
  it('ending during the chime stops it, never greets, and plays the end cue', async () => {
    await render()
    await startLive()
    await act(async () => handle.end())
    await flush()
    expect(chime()!.stopped).toBe(true)
    expect(soundNames()).toEqual(['voice-chat-start', 'voice-chat-end'])
    await chimeNearsEnd()
    await chimeEnds()
    expect(greetings()).toEqual([])
    expect(mutes()).toEqual([])
  })

  it('Esc during the greeting cancels it and plays the end cue', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await render({ readAloud: makeReadAloud({ speakingMessageId: 'line:1' }) })
    await chimeEnds()
    log = []
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    expect(handle.active).toBe(false)
    expect(log).toContain('readAloud.stop')
    expect(soundNames().at(-1)).toBe('voice-chat-end')
  })

  it('the desktop ending the session mid-greeting silences the greeting too', async () => {
    await render()
    await startLive()
    await chimeNearsEnd()
    await render({ readAloud: makeReadAloud({ speakingMessageId: 'line:1' }) })
    log = []
    await emit({ type: 'ended', reason: 'device' })
    expect(log).toEqual(['readAloud.stop'])
    expect(soundNames().at(-1)).toBe('voice-chat-end')
  })

  it('a reply read aloud is left alone when the desktop ends the session (only the greeting is ours)', async () => {
    await render()
    await startLive()
    await chimeEnds()
    await render({ readAloud: makeReadAloud({ speakingMessageId: 'a1' }) })
    log = []
    await emit({ type: 'ended', reason: 'idle' })
    expect(log).toEqual([])
  })

  it.each([
    ['the waveform (end)', async () => act(async () => handle.end())],
    ['the desktop ending it (idle)', async () => emit({ type: 'ended', reason: 'idle' })],
    ['an error', async () => emit({ type: 'ended', reason: 'error', error: 'boom' })],
    ['the device going away', async () => emit({ type: 'ended', reason: 'device' })],
    ['a tab switch', async () => render({ active: false })],
  ] as const)('%s plays voice-chat-end', async (_label, endIt) => {
    await render()
    await startLive()
    await chimeEnds()
    await endIt()
    await flush()
    expect(handle.active).toBe(false)
    expect(soundNames().filter((n) => n === 'voice-chat-end')).toHaveLength(1)
  })

  it.each([
    ['a capture taking the mic (blocked)', async () => render({ blocked: true })],
    ['the desktop ending it for a recording', async () => emit({ type: 'ended', reason: 'recording' })],
  ] as const)('%s: no end cue (it would be recorded)', async (_label, endIt) => {
    await render()
    await startLive()
    await chimeEnds()
    await endIt()
    await flush()
    expect(handle.active).toBe(false)
    expect(soundNames()).not.toContain('voice-chat-end')
  })

  it('keeps alert sounds quiet while the session lives', async () => {
    await render()
    expect(await isSoundQuiet()).toBe(false)
    await start()
    expect(await isSoundQuiet()).toBe(true)
    await act(async () => handle.end())
    await flush()
    expect(await isSoundQuiet()).toBe(false)
  })
})
