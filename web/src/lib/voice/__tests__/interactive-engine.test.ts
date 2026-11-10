import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoiceEvent } from '@/lib/tauri-bridge'
import { VoiceRefusedError } from '@/lib/tauri-bridge'
import {
  INTERACTIVE_LINES,
  INTERACTIVE_TIMING,
  InteractiveEngine,
  type InteractiveDeps,
  type PausedReading,
} from '../interactive-engine'
import type { InteractivePhase } from '../interactive-store'
import type { VoiceAskContext } from '../voice-ask'
import type { VoiceAskListeners } from '../voice-ask-delivery'
import { isEchoOf } from '../wake-word'

/**
 * Interactive mode's engine (../interactive-engine) with the desktop's voice
 * session, the reading and the chat all stood in for:
 *  - the session: started with the voice settings while active, cancelled
 *    when not (and once a start in flight lands), started again with a
 *    back-off after an end it didn't ask for or a refused start (not
 *    `mic_denied`), unless it goes inactive first; ended for the window
 *    going away (`page`: closed to the tray), only once the window is back;
 *  - the name: heard in a partial, the reading pauses at once; its turn sends
 *    the request with what the user was listening to; the name alone is
 *    answered "Yes?" and the next turn is the request; a turn without the
 *    name is dropped; a name the recogniser takes back resumes the reading;
 *  - the reply: barge `speech` while it is read and in the follow-up window,
 *    a turn there is sent without the name, a barge-in cuts it short, and
 *    after the window: barge `wake`, listening, the reading resumed;
 *  - no chat, or a failure: a short line, then the reading resumes;
 *  - the mute: the mic gated at the desktop, the session kept;
 *  - the echo guard: the reading or the reply heard back on the mic never
 *    wakes it, and is never a follow-up turn.
 */

interface Ask {
  text: string
  voiceAsk: VoiceAskContext
  listeners: VoiceAskListeners
  interrupt: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function harness() {
  const handlers = new Map<string, (ev: VoiceEvent) => void>()
  const started: string[] = []
  const calls: string[] = []
  const startResults: Array<() => Promise<void>> = []
  const bridge = {
    voiceStart: vi.fn(async (args: { sessionId: string; mode: string; endSilenceMs?: number; noiseProfile?: string }) => {
      started.push(args.sessionId)
      calls.push(`start:${args.mode}:${args.endSilenceMs}:${args.noiseProfile}`)
      const next = startResults.shift()
      if (next) await next()
    }),
    voiceCancel: vi.fn(async (id: string) => void calls.push(`cancel:${id}`)),
    voiceSetMuted: vi.fn(async (_id: string, muted: boolean) => void calls.push(`muted:${muted}`)),
    voiceSetBarge: vi.fn(async (_id: string, policy: string) => void calls.push(`barge:${policy}`)),
    onVoiceEvent: vi.fn((id: string | null, cb: (ev: VoiceEvent) => void) => {
      handlers.set(id!, cb)
      return () => handlers.delete(id!)
    }),
  }
  const reading = { playing: null as string | null }
  const asks: Ask[] = []
  const phases: InteractivePhase[] = []
  const said: string[] = []
  /** What the desktop's voice just said (the echo guard reads it). */
  const spoken: string[] = []
  let sayDone: () => void = () => {}
  const opts = { chatTakes: true, sayHolds: false }
  const deps: InteractiveDeps = {
    bridge: bridge as unknown as InteractiveDeps['bridge'],
    getName: () => 'Joseph',
    isEcho: (text: string) => isEchoOf(text, spoken),
    startOptions: () => ({ endSilenceMs: 1200, noiseProfile: 'auto' }),
    snapshot: vi.fn(() =>
      reading.playing ? { kind: 'document' as const, id: 'd1', readingAt: 'The budget is due Friday.' } : { kind: 'document' as const, id: 'd1' },
    ),
    pauseReading: vi.fn((): PausedReading | null => {
      if (!reading.playing) return null
      const key = reading.playing
      reading.playing = null
      return { key }
    }),
    resumeReading: vi.fn((paused: PausedReading) => {
      reading.playing = paused.key
    }),
    say: vi.fn((text: string) => {
      said.push(text)
      return opts.sayHolds ? new Promise<void>((resolve) => (sayDone = resolve)) : Promise.resolve()
    }),
    ask: vi.fn((text: string, voiceAsk: VoiceAskContext, listeners: VoiceAskListeners) => {
      if (!opts.chatTakes) return null
      const ask: Ask = { text, voiceAsk, listeners, interrupt: vi.fn(), cancel: vi.fn() }
      asks.push(ask)
      return { interrupt: ask.interrupt, cancel: ask.cancel }
    }),
    publish: (phase) => {
      if (phases[phases.length - 1] !== phase) phases.push(phase)
    },
  }
  const engine = new InteractiveEngine(deps)
  const current = () => started[started.length - 1]
  const emit = (ev: VoiceEvent) => handlers.get(current())?.(ev)
  const words = (text: string, final = false) => emit({ type: 'transcript', turnId: 't1', text, final })
  const turn = (text: string) => emit({ type: 'turn', turnId: 't1', text })
  const phase = () => phases[phases.length - 1]
  return {
    engine,
    deps,
    bridge,
    calls,
    started,
    startResults,
    handlers,
    reading,
    asks,
    phases,
    said,
    spoken,
    opts,
    emit,
    words,
    turn,
    phase,
    current,
    finishSay: () => sayDone(),
  }
}

/** Lets the bridge's promises land. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

async function live(h: ReturnType<typeof harness>) {
  h.engine.setActive(true)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InteractiveEngine: the session', () => {
  it('starts an interactive session with the voice settings while active, and cancels it when not', async () => {
    const h = harness()
    expect(h.phase()).toBeUndefined()
    h.engine.setActive(true)
    expect(h.phase()).toBe('off')
    await flush()
    expect(h.calls).toEqual(['start:interactive:1200:auto'])
    expect(h.current()).toMatch(/^intr-/)
    expect(h.phase()).toBe('listening')
    // The desktop starts it with the barge policy `wake`: nothing to send.
    expect(h.bridge.voiceSetBarge).not.toHaveBeenCalled()

    h.engine.setActive(false)
    await flush()
    expect(h.calls).toContain(`cancel:${h.current()}`)
    expect(h.phase()).toBe('off')
    expect(h.handlers.size).toBe(0)
  })

  it('a start still in flight when it goes inactive is cancelled once it lands', async () => {
    const h = harness()
    let land: () => void = () => {}
    h.startResults.push(() => new Promise<void>((resolve) => (land = resolve)))
    h.engine.setActive(true)
    await flush()
    h.engine.setActive(false)
    await flush()
    expect(h.bridge.voiceCancel).not.toHaveBeenCalled()
    land()
    await flush()
    expect(h.bridge.voiceCancel).toHaveBeenCalledWith(h.current())
    expect(h.phase()).toBe('off')
  })

  it('starts again after an end it did not ask for, with a back-off', async () => {
    const h = harness()
    await live(h)
    const first = h.current()
    h.emit({ type: 'ended', reason: 'device' })
    expect(h.phase()).toBe('off')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MIN_MS - 1)
    expect(h.started).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.started).toHaveLength(2)
    expect(h.current()).not.toBe(first)
    expect(h.phase()).toBe('listening')

    // Straight away again: the back-off doubles.
    h.emit({ type: 'ended', reason: 'error' })
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MIN_MS)
    expect(h.started).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MIN_MS)
    expect(h.started).toHaveLength(3)

    // One that ran a good while starts the back-off over.
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_RESET_MS)
    h.emit({ type: 'ended', reason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MIN_MS)
    expect(h.started).toHaveLength(4)

    // The window closed to the tray: no timer at all, even if the page never
    // reports itself hidden (no hot mic in the tray).
    h.emit({ type: 'ended', reason: 'page' })
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MAX_MS * 2)
    expect(h.started).toHaveLength(4)
    expect(h.phase()).toBe('off')
  })

  it('ended for the window going away: starts again only when the window comes back', async () => {
    const h = harness()
    await live(h)
    h.engine.windowReturned()
    await flush()
    expect(h.started).toHaveLength(1) // a live session: nothing to do
    h.emit({ type: 'ended', reason: 'page' })
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MAX_MS)
    expect(h.started).toHaveLength(1)
    h.engine.windowReturned()
    await flush()
    expect(h.started).toHaveLength(2)
    expect(h.phase()).toBe('listening')
    // Once only: back again with a live session changes nothing.
    h.engine.windowReturned()
    await flush()
    expect(h.started).toHaveLength(2)

    // Inactive meanwhile (Interactive off): coming back doesn't start it.
    h.emit({ type: 'ended', reason: 'page' })
    h.engine.setActive(false)
    h.engine.windowReturned()
    await flush()
    expect(h.started).toHaveLength(2)
  })

  it('a refused start is tried again with a back-off, except mic_denied; going inactive stops trying', async () => {
    const h = harness()
    h.startResults.push(async () => {
      throw new VoiceRefusedError('busy')
    })
    await live(h)
    expect(h.phase()).toBe('off')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MIN_MS)
    expect(h.started).toHaveLength(2)
    expect(h.phase()).toBe('listening')

    const h2 = harness()
    h2.startResults.push(async () => {
      throw new VoiceRefusedError('mic_denied')
    })
    await live(h2)
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MAX_MS)
    expect(h2.started).toHaveLength(1)
    // Turned off and on again (the user's doing): tried again.
    h2.engine.setActive(false)
    await live(h2)
    expect(h2.started).toHaveLength(2)

    const h3 = harness()
    h3.startResults.push(async () => {
      throw new VoiceRefusedError('recording')
    })
    await live(h3)
    h3.engine.setActive(false)
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MAX_MS)
    expect(h3.started).toHaveLength(1)
  })

  it('the mute gates the mic at the desktop and keeps the session; one set before it opens applies once it does', async () => {
    const h = harness()
    h.engine.setMuted(true)
    await live(h)
    expect(h.calls).toEqual(['start:interactive:1200:auto', 'muted:true'])
    h.engine.setMuted(false)
    await flush()
    expect(h.calls.slice(-1)).toEqual(['muted:false'])
    expect(h.bridge.voiceCancel).not.toHaveBeenCalled()
    expect(h.phase()).toBe('listening')
  })
})

describe('InteractiveEngine: the name', () => {
  it('heard in a partial while listen mode reads: the reading pauses at once, then its turn sends the request', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    expect(h.deps.pauseReading).toHaveBeenCalledTimes(1)
    expect(h.reading.playing).toBeNull()
    expect(h.phase()).toBe('heard')

    h.words('Joseph can you summarize')
    h.turn('Joseph, can you summarize this?')
    expect(h.asks).toHaveLength(1)
    expect(h.asks[0].text).toBe('Can you summarize this?')
    // What the user was listening to, with the sentence being read then.
    expect(h.asks[0].voiceAsk).toEqual({
      snapshot: { kind: 'document', id: 'd1', readingAt: 'The budget is due Friday.' },
    })
    expect(h.phase()).toBe('thinking')
  })

  it('a turn without the name is dropped: nothing sent, nothing paused', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('can you summarize')
    h.turn('Can you summarize this?')
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.deps.pauseReading).not.toHaveBeenCalled()
    expect(h.reading.playing).toBe('doc:d1')
    expect(h.phase()).toBe('listening')
  })

  it('a name the recogniser takes back: dropped, and the reading resumes', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    h.turn('Josephine called earlier')
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.deps.resumeReading).toHaveBeenCalledWith({ key: 'doc:d1' })
    expect(h.reading.playing).toBe('doc:d1')
    expect(h.phase()).toBe('listening')
  })

  it('the name heard and no turn after it: back to listening, the reading resumed', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.HEARD_WAIT_MS)
    expect(h.phase()).toBe('listening')
    expect(h.reading.playing).toBe('doc:d1')
  })

  it('the name alone: "Yes?", and the next turn (no name needed) is the request', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    h.turn('Joseph?')
    expect(h.said).toEqual([INTERACTIVE_LINES.ack])
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.phase()).toBe('heard')

    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.REQUEST_WAIT_MS - 1000)
    h.turn('what did she ask for')
    expect(h.asks.map((a) => a.text)).toEqual(['What did she ask for'])
    expect(h.phase()).toBe('thinking')
  })

  it('the name alone and then nothing for REQUEST_WAIT_MS: back to listening, the reading resumed', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.turn('Hey Joseph')
    expect(h.said).toEqual([INTERACTIVE_LINES.ack])
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.REQUEST_WAIT_MS)
    expect(h.phase()).toBe('listening')
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.reading.playing).toBe('doc:d1')
  })

  it('with nothing reading, the name still asks (no reading to pause, none to resume)', async () => {
    const h = harness()
    await live(h)
    h.turn("What's next on my calendar, Joseph?")
    expect(h.asks[0].text).toBe("What's next on my calendar?")
    expect(h.asks[0].voiceAsk).toEqual({ snapshot: { kind: 'document', id: 'd1' } })
    h.asks[0].listeners.onSettled!('spoken')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.FOLLOW_UP_MS)
    expect(h.deps.resumeReading).not.toHaveBeenCalled()
  })
})

describe('InteractiveEngine: the reply and the follow-up window', () => {
  async function asked(h: ReturnType<typeof harness>) {
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    h.turn('Joseph, who sent this?')
    return h.asks[0]
  }

  it('read aloud: barge `speech`; over: the follow-up window, where a turn goes without the name', async () => {
    const h = harness()
    const ask = await asked(h)
    ask.listeners.onSpeaking!()
    await flush()
    expect(h.phase()).toBe('answering')
    expect(h.calls.filter((c) => c.startsWith('barge:'))).toEqual(['barge:speech'])

    ask.listeners.onSettled!('spoken')
    expect(h.phase()).toBe('follow-up')
    h.turn('and when is it due')
    expect(h.asks.map((a) => a.text)).toEqual(['Who sent this?', 'And when is it due'])
    expect(h.phase()).toBe('thinking')
    await flush()
    // Thinking: back to `wake` (nothing is being said).
    expect(h.calls.filter((c) => c.startsWith('barge:'))).toEqual(['barge:speech', 'barge:wake'])
  })

  it('after the window: barge `wake`, listening, and the paused reading resumes where it stopped', async () => {
    const h = harness()
    const ask = await asked(h)
    ask.listeners.onSpeaking!()
    ask.listeners.onSettled!('spoken')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.FOLLOW_UP_MS - 1)
    expect(h.phase()).toBe('follow-up')
    expect(h.deps.resumeReading).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.phase()).toBe('listening')
    expect(h.deps.resumeReading).toHaveBeenCalledWith({ key: 'doc:d1' })
    expect(h.calls.filter((c) => c.startsWith('barge:'))).toEqual(['barge:speech', 'barge:wake'])
    // Back to the name: a turn without it is dropped again.
    h.turn('thanks')
    expect(h.asks).toHaveLength(1)
  })

  it('words heard in the window keep it open until their turn ends', async () => {
    const h = harness()
    const ask = await asked(h)
    ask.listeners.onSettled!('spoken')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.FOLLOW_UP_MS - 500)
    h.words('and then')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.FOLLOW_UP_MS - 500)
    expect(h.phase()).toBe('follow-up')
    h.turn('and then what')
    expect(h.asks).toHaveLength(2)
  })

  it('talking over the reply (voice://interrupted) cuts it short, and the turn that follows is sent', async () => {
    const h = harness()
    const ask = await asked(h)
    ask.listeners.onSpeaking!()
    h.emit({ type: 'interrupted', turnId: 't2' })
    expect(ask.interrupt).toHaveBeenCalledTimes(1)
    expect(h.phase()).toBe('follow-up')
    h.turn('no, the other one')
    expect(h.asks.map((a) => a.text)).toEqual(['Who sent this?', 'No, the other one'])
  })

  it('a reply cut short or with nothing to read still opens the window', async () => {
    for (const outcome of ['interrupted', 'silent'] as const) {
      const h = harness()
      const ask = await asked(h)
      ask.listeners.onSettled!(outcome)
      expect(h.phase()).toBe('follow-up')
    }
  })

  it('no chat to take it: "I can’t reach the chat right now", then the reading resumes once that is said', async () => {
    const h = harness()
    h.opts.chatTakes = false
    h.opts.sayHolds = true
    await live(h)
    h.reading.playing = 'doc:d1'
    h.turn('Joseph, read the next one')
    expect(h.said).toEqual([INTERACTIVE_LINES.unreachable])
    expect(h.phase()).toBe('listening')
    expect(h.deps.resumeReading).not.toHaveBeenCalled()
    h.finishSay()
    await flush()
    expect(h.deps.resumeReading).toHaveBeenCalledWith({ key: 'doc:d1' })
  })

  it('a failed ask: "Sorry…", back to listening, the reading resumed', async () => {
    const h = harness()
    const ask = await asked(h)
    ask.listeners.onSettled!('failed')
    expect(h.said).toEqual([INTERACTIVE_LINES.failed])
    expect(h.phase()).toBe('listening')
    await flush()
    expect(h.deps.resumeReading).toHaveBeenCalledWith({ key: 'doc:d1' })
  })

  it('a new flow while a line is said keeps the reading waiting until that flow is over', async () => {
    const h = harness()
    h.opts.chatTakes = false
    h.opts.sayHolds = true
    await live(h)
    h.reading.playing = 'doc:d1'
    h.turn('Joseph, read the next one')
    h.opts.chatTakes = true
    h.turn('Joseph, try again')
    h.finishSay()
    await flush()
    expect(h.deps.resumeReading).not.toHaveBeenCalled()
    h.asks[0].listeners.onSettled!('spoken')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.FOLLOW_UP_MS)
    expect(h.deps.resumeReading).toHaveBeenCalledWith({ key: 'doc:d1' })
  })

  it('an ask asked over by a newer one is cancelled, and what it reports is ignored', async () => {
    const h = harness()
    const first = await asked(h)
    h.turn('Joseph, actually, who is on the thread?')
    expect(first.cancel).toHaveBeenCalled()
    first.listeners.onSettled!('interrupted')
    expect(h.phase()).toBe('thinking')
    h.asks[1].listeners.onSpeaking!()
    expect(h.phase()).toBe('answering')
  })

  it('no word from the chat for REPLY_WAIT_MS: back to listening', async () => {
    const h = harness()
    const ask = await asked(h)
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.REPLY_WAIT_MS)
    expect(h.phase()).toBe('listening')
    expect(ask.cancel).toHaveBeenCalled()
    expect(h.reading.playing).toBe('doc:d1')
  })

  it('a session started again mid-reply gets the barge policy the flow wants', async () => {
    const h = harness()
    const ask = await asked(h)
    ask.listeners.onSpeaking!()
    await flush()
    h.emit({ type: 'ended', reason: 'device' })
    // The flow goes on through the restart.
    expect(h.phase()).toBe('answering')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.RESTART_MIN_MS)
    expect(h.calls.filter((c) => c.startsWith('barge:'))).toEqual(['barge:speech', 'barge:speech'])
  })

  it('going inactive mid-flow drops it: nothing resumed, the ask let go', async () => {
    const h = harness()
    const ask = await asked(h)
    h.engine.setActive(false)
    expect(ask.cancel).toHaveBeenCalled()
    expect(h.phase()).toBe('off')
    await vi.advanceTimersByTimeAsync(INTERACTIVE_TIMING.REPLY_WAIT_MS)
    expect(h.deps.resumeReading).not.toHaveBeenCalled()
  })
})

describe('InteractiveEngine: the echo guard', () => {
  it('the reading heard back on the mic, naming the assistant, never wakes it', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.spoken.push('Joseph said the contract is ready for review.')
    h.words('Joseph said the contract')
    expect(h.deps.pauseReading).not.toHaveBeenCalled()
    expect(h.phase()).toBe('listening')
    h.turn('Joseph said the contract is ready')
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.reading.playing).toBe('doc:d1')
    // The user's own words, naming it, still do.
    h.turn('Joseph, who wrote the contract?')
    expect(h.asks.map((a) => a.text)).toEqual(['Who wrote the contract?'])
  })

  it('an echo that straddles two sentences is still an echo', async () => {
    const h = harness()
    await live(h)
    h.spoken.push('We spoke to Joseph.', 'He agreed to the plan on Friday.')
    h.turn('to Joseph he agreed to the plan')
    expect(h.deps.ask).not.toHaveBeenCalled()
  })

  it('a name heard in a partial that turns out to be the reading: dropped, the reading resumed', async () => {
    const h = harness()
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    expect(h.phase()).toBe('heard')
    h.spoken.push('Joseph will send the invoice today.')
    h.turn('Joseph will send the invoice today')
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.phase()).toBe('listening')
    expect(h.reading.playing).toBe('doc:d1')
  })

  it('the reply heard back is never a follow-up turn', async () => {
    const h = harness()
    await live(h)
    h.turn('Joseph, who sent this?')
    const ask = h.asks[0]
    ask.listeners.onSpeaking!()
    h.spoken.push('It was sent by Maya Chen on Tuesday.')
    h.turn('it was sent by Maya Chen on Tuesday')
    expect(h.asks).toHaveLength(1)
    ask.listeners.onSettled!('spoken')
    h.turn('sent by Maya Chen on Tuesday')
    expect(h.asks).toHaveLength(1)
    expect(h.phase()).toBe('follow-up')
    h.turn('what did she want')
    expect(h.asks.map((a) => a.text)).toEqual(['Who sent this?', 'What did she want'])
  })
})

describe('InteractiveEngine: Voice focus', () => {
  /** A gate whose verdicts the test hands out (deps.openFocus). */
  function withFocus(h: ReturnType<typeof harness>, { on = true }: { on?: boolean } = {}) {
    const verdicts = new Map<string, (a: 'send' | 'drop') => void>()
    const promises = new Map<string, Promise<'send' | 'drop'>>()
    const gate = {
      on,
      speech: [] as string[],
      skipped: [] as string[],
      disposed: 0,
      onSpeech: vi.fn((ev: { turnId: string }) => void gate.speech.push(ev.turnId)),
      focusOn: () => gate.on,
      observe: vi.fn(),
      judge: vi.fn((turnId: string) => {
        if (!promises.has(turnId)) promises.set(turnId, new Promise((r) => verdicts.set(turnId, r)))
        return promises.get(turnId)!
      }),
      skip: vi.fn((turnId: string) => void gate.skipped.push(turnId)),
      dispose: vi.fn(() => void gate.disposed++),
    }
    h.deps.openFocus = () => gate
    const decide = async (turnId: string, action: 'send' | 'drop') => {
      verdicts.get(turnId)!(action)
      await flush()
    }
    const turnAs = (turnId: string, text: string) => h.emit({ type: 'turn', turnId, text })
    return { gate, decide, turnAs }
  }

  it('without a gate nothing changes: no speech audio asked for, turns act at once', async () => {
    const h = harness()
    await live(h)
    expect(h.bridge.voiceStart.mock.calls[0][0]).not.toHaveProperty('speechAudio')
    h.turn('Joseph, what time is it?')
    expect(h.asks).toHaveLength(1)
  })

  it('with a gate: speech audio asked for, every voice://speech handed over, disposed with the session', async () => {
    const h = harness()
    const { gate } = withFocus(h)
    await live(h)
    expect(h.bridge.voiceStart.mock.calls[0][0]).toMatchObject({ mode: 'interactive', speechAudio: true })
    h.emit({ type: 'speech', turnId: 't1', seq: 0, end: false, startMs: 0, sampleRate: 16000, pcm: 'AAA=' })
    expect(gate.speech).toEqual(['t1'])
    h.engine.setActive(false)
    await flush()
    expect(gate.disposed).toBe(1)
  })

  it('a voice Native Intelligence doesn’t know saying the name: nothing asked, and the reading paused by the partial resumes', async () => {
    const h = harness()
    const { decide, turnAs } = withFocus(h)
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    expect(h.phase()).toBe('heard')
    turnAs('t1', 'Joseph, buy now while stocks last')
    expect(h.asks).toHaveLength(0)
    await decide('t1', 'drop')
    expect(h.deps.ask).not.toHaveBeenCalled()
    expect(h.deps.resumeReading).toHaveBeenCalledWith({ key: 'doc:d1' })
    expect(h.phase()).toBe('listening')
  })

  it('the user’s turn is acted on once its verdict says send', async () => {
    const h = harness()
    const { decide, turnAs } = withFocus(h)
    await live(h)
    turnAs('t1', 'Joseph, can you summarize this?')
    expect(h.asks).toHaveLength(0)
    await decide('t1', 'send')
    expect(h.asks.map((a) => a.text)).toEqual(['Can you summarize this?'])
  })

  it('a dropped turn in the follow-up window is not sent; turns stay in order', async () => {
    const h = harness()
    const { decide, turnAs } = withFocus(h)
    await live(h)
    turnAs('t1', 'Joseph, who sent this?')
    await decide('t1', 'send')
    const ask = h.asks[0]
    ask.listeners.onSpeaking!()
    ask.listeners.onSettled!('spoken')
    expect(h.phase()).toBe('follow-up')
    turnAs('t2', 'and in other news')
    turnAs('t3', 'what did she want')
    await decide('t3', 'send')
    expect(h.asks).toHaveLength(1)
    await decide('t2', 'drop')
    expect(h.asks.map((a) => a.text)).toEqual(['Who sent this?', 'What did she want'])
  })

  it('Voice focus off: turns act at once, as without it; the score is only logged', async () => {
    const h = harness()
    const { gate, turnAs } = withFocus(h, { on: false })
    await live(h)
    h.reading.playing = 'doc:d1'
    h.words('Joseph')
    // Synchronously, with no verdict to wait on.
    turnAs('t1', 'Joseph, can you summarize this?')
    expect(h.asks.map((a) => a.text)).toEqual(['Can you summarize this?'])
    expect(gate.observe).toHaveBeenCalledWith('t1')
    expect(gate.judge).not.toHaveBeenCalled()
  })

  it('Voice focus turned off while a verdict is still awaited: later turns keep their place behind it', async () => {
    const h = harness()
    const { gate, decide, turnAs } = withFocus(h)
    await live(h)
    turnAs('t1', 'Joseph, who sent this?')
    gate.on = false
    turnAs('t2', 'Joseph, what time is it?')
    expect(h.asks).toHaveLength(0)
    await decide('t1', 'send')
    await flush()
    expect(h.asks.map((a) => a.text)).toEqual(['Who sent this?', 'What time is it?'])
    // Once nothing waits, off is synchronous again.
    turnAs('t3', 'Joseph, and tomorrow?')
    expect(h.asks.map((a) => a.text)).toContain('And tomorrow?')
  })

  it('an empty turn is not judged (its audio let go)', async () => {
    const h = harness()
    const { gate, turnAs } = withFocus(h)
    await live(h)
    turnAs('t1', '  ')
    await flush()
    expect(gate.skipped).toEqual(['t1'])
    expect(gate.judge).not.toHaveBeenCalled()
  })
})
