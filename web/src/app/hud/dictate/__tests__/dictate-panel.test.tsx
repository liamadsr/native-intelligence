// @vitest-environment jsdom
/**
 * Dictate anywhere's panel (../dictate-panel). Pinned:
 *  - a tap's start starts the dictation; stop and cancel only for that tap;
 *  - the words go to dictate_paste with the tap's run, and the desktop hears
 *    "listening" and then "idle" for that run;
 *  - a paste that couldn't happen leaves a note before the panel goes;
 *  - a panel built by the waiting tap starts on its own (dictate_state).
 *  - Talk anywhere: a held press's words go to talk_send, never the paste;
 *    the card becomes a circle that thinks, speaks, then waits (until Esc's
 *    close or the next hold); an unreachable agent leaves a note; an empty
 *    hold with no conversation just ends. A hold is a circle (no words) from
 *    the moment it's known; in a conversation every press starts as one, and
 *    a tap turns it back into the card. Esc's hint shows only on hover.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The voice glow asks whether motion should be reduced.
window.matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList)

type Options = { onCommit: (t: string) => void; onFinish?: (h: { cancelled: boolean }) => void; surface?: string }
const s = vi.hoisted(() => ({
  options: null as unknown as Options,
  phase: 'idle' as string,
  toggle: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  emit: null as null | ((p: { run: number; action: string }) => void),
  agent: null as null | ((p: { run: number; state: string }) => void),
  hover: null as null | ((inside: boolean) => void),
  edit: null as null | ((edits: Array<{ heard: string; typed: string }>) => void),
  flashes: [] as boolean[],
  word: null as null | ((p: { id: string; index: number; count: number; word: string }) => void),
  tts: null as null | ((p: { id: string; state: string }) => void),
  learned: [] as Array<{ heard: string; typed: string }>,
  state: { armed: false, agent: false, run: 0 },
  sent: [] as Array<[number, string]>,
  sizes: [] as Array<[number, number, number | undefined]>,
  paste: vi.fn(),
  phaseCalls: [] as Array<[number, string]>,
  pasteResult: { pasted: true, reason: null as string | null },
}))

vi.mock('@/hooks/use-dictation', () => ({
  useDictation: (o: Options) => {
    s.options = o
    return { phase: s.phase, active: s.phase !== 'idle', latched: true, transcript: null, buttonProps: {}, toggle: s.toggle, stop: s.stop, cancel: s.cancel, level: () => 0 }
  },
}))
vi.mock('@/lib/vocabulary/client', () => ({ primeVocabulary: async () => {} }))
vi.mock('@/lib/vocabulary/learn-from-edits', () => ({ learnFromEdits: async () => s.learned }))
vi.mock('@/components/read-aloud/listen-metal', () => ({ MetalRing: () => null }))
const sounds = vi.hoisted(() => ({ played: [] as string[] }))
vi.mock('@/lib/sounds/engine', () => ({
  playSound: (name: string) => {
    sounds.played.push(name)
  },
}))
vi.mock('@/components/bots/agent-bot', () => ({
  AgentBot: ({ state }: { state: string }) => <span data-testid="agent-face" data-state={state} />,
  preloadAgentBot: () => {},
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    onDictateToggle: (cb: (p: { run: number; action: string }) => void) => {
      s.emit = cb
      return () => {}
    },
    onDictateAgent: (cb: (p: { run: number; state: string }) => void) => {
      s.agent = cb
      return () => {}
    },
    onDictateHover: (cb: (inside: boolean) => void) => {
      s.hover = cb
      return () => {}
    },
    onDictateEdit: (cb: (edits: Array<{ heard: string; typed: string }>) => void) => {
      s.edit = cb
      return () => {}
    },
    onTtsWord: (cb: (p: { id: string; index: number; count: number; word: string }) => void) => {
      s.word = cb
      return () => {}
    },
    onTtsState: (cb: (p: { id: string; state: string }) => void) => {
      s.tts = cb
      return () => {}
    },
    dictateFlash: async (on: boolean) => {
      s.flashes.push(on)
    },
    talkSend: async (run: number, text: string) => {
      s.sent.push([run, text])
    },
    dictateState: async () => s.state,
    dictatePanelSize: async (w: number, h: number, r?: number) => {
      s.sizes.push([w, h, r])
    },
    dictatePhase: async (run: number, phase: string) => {
      s.phaseCalls.push([run, phase])
    },
    dictatePaste: async (run: number, text: string) => {
      s.paste(run, text)
      return s.pasteResult
    },
  },
}))

import { AGENT_UNREACHABLE, CARD_MAX_W, CARD_MIN_W, CIRCLE, CARD_ONE_LINE_H, CARD_TWO_LINES_H, DictatePanel, cardSize, pasteNote, tail } from '../dictate-panel'

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  vi.useRealTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.assign(s, { phase: 'idle', state: { armed: false, agent: false, run: 0 }, phaseCalls: [], sent: [], sizes: [], flashes: [], learned: [], pasteResult: { pasted: true, reason: null } })
  s.toggle.mockReset()
  s.stop.mockReset()
  s.cancel.mockReset()
  s.paste.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount() {
  await act(async () => {
    root.render(<DictatePanel />)
  })
  await flush()
}

describe('DictatePanel', () => {
  it('runs one tap: start, stop, paste with its run, then idle', async () => {
    await mount()
    expect(s.options.surface).toBe('anywhere')
    act(() => s.emit!({ run: 7, action: 'start' }))
    expect(s.toggle).toHaveBeenCalledTimes(1)
    act(() => s.emit!({ run: 6, action: 'stop' })) // an old tap's stop: ignored
    expect(s.stop).not.toHaveBeenCalled()
    act(() => s.emit!({ run: 7, action: 'stop' }))
    expect(s.stop).toHaveBeenCalledTimes(1)
    await act(async () => {
      s.options.onCommit('check the APIM team')
      s.options.onFinish?.({ cancelled: false })
    })
    await flush()
    expect(s.paste).toHaveBeenCalledWith(7, 'check the APIM team')
    expect(s.phaseCalls).toContainEqual([7, 'idle'])
  })

  it('cancel only for its own tap', async () => {
    await mount()
    act(() => s.emit!({ run: 3, action: 'start' }))
    act(() => s.emit!({ run: 2, action: 'cancel' }))
    expect(s.cancel).not.toHaveBeenCalled()
    act(() => s.emit!({ run: 3, action: 'cancel' }))
    expect(s.cancel).toHaveBeenCalledTimes(1)
  })

  it('a panel built by the waiting tap starts by itself', async () => {
    s.state = { armed: true, agent: false, run: 4 }
    await mount()
    expect(s.toggle).toHaveBeenCalledTimes(1)
  })

  it('says why the words were copied instead, then goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    s.pasteResult = { pasted: false, reason: 'focus_changed' }
    await mount()
    act(() => s.emit!({ run: 9, action: 'start' }))
    await act(async () => {
      s.options.onCommit('hello')
      s.options.onFinish?.({ cancelled: false })
    })
    await flush()
    expect(container.textContent).toContain('Copied. Press ⌘V to paste')
    expect(s.phaseCalls).not.toContainEqual([9, 'idle'])
    await act(async () => {
      vi.advanceTimersByTime(2300)
    })
    expect(s.phaseCalls).toContainEqual([9, 'idle'])
  })
})

describe('Talk anywhere', () => {
  const circle = () => container.querySelector('[data-testid="dictate-circle"]')

  async function sendHeld(run: number, text: string) {
    act(() => s.emit!({ run, action: 'start' }))
    act(() => s.emit!({ run, action: 'to_agent' }))
    act(() => s.emit!({ run, action: 'send' }))
    expect(s.stop).toHaveBeenCalled()
    await act(async () => {
      s.options.onCommit(text)
      s.options.onFinish?.({ cancelled: false })
    })
    await flush()
  }

  it('sends a held press to the agent and shows the circle through the reply', async () => {
    await mount()
    await sendHeld(5, 'what is on my calendar')
    expect(s.sent).toEqual([[5, 'what is on my calendar']])
    expect(s.paste).not.toHaveBeenCalled()
    expect(circle()?.getAttribute('data-state')).toBe('thinking')
    expect(s.sizes.at(-1)).toEqual([CIRCLE, CIRCLE, CIRCLE / 2])
    act(() => s.agent!({ run: 4, state: 'speaking' })) // an old press: ignored
    expect(circle()?.getAttribute('data-state')).toBe('thinking')
    // The agent's face, hopping while it thinks.
    expect(container.querySelector('[data-testid="agent-face"]')?.getAttribute('data-state')).toBe('working')
    act(() => s.agent!({ run: 5, state: 'speaking' }))
    expect(circle()?.getAttribute('data-state')).toBe('speaking')
    expect(container.querySelector('[data-testid="agent-face"]')?.getAttribute('data-state')).toBe('default')
    act(() => s.agent!({ run: 5, state: 'done' }))
    // It stays, waiting, and never tells the desktop it's over: Esc does that.
    expect(circle()?.getAttribute('data-state')).toBe('waiting')
    expect(s.phaseCalls).not.toContainEqual([5, 'idle'])
    act(() => s.emit!({ run: 5, action: 'close' }))
    expect(circle()).toBeNull()
  })

  it('the next hold takes over the circle', async () => {
    await mount()
    act(() => s.emit!({ run: 1, action: 'start_agent' }))
    expect(s.toggle).toHaveBeenCalledTimes(1)
    act(() => s.emit!({ run: 1, action: 'send' }))
    await act(async () => {
      s.options.onCommit('first')
      s.options.onFinish?.({ cancelled: false })
    })
    await flush()
    expect(circle()).not.toBeNull()
    act(() => s.emit!({ run: 2, action: 'start_agent' }))
    expect(circle()).toBeNull()
    expect(s.toggle).toHaveBeenCalledTimes(2)
  })

  it('a quick tap on the circle dictates and pastes again', async () => {
    await mount()
    await sendHeld(1, 'first')
    act(() => s.agent!({ run: 1, state: 'speaking' }))
    act(() => s.emit!({ run: 2, action: 'start' }))
    expect(circle()).toBeNull()
    act(() => s.agent!({ run: 1, state: 'done' })) // the cut reply: no circle again
    expect(circle()).toBeNull()
    act(() => s.emit!({ run: 2, action: 'stop' }))
    await act(async () => {
      s.options.onCommit('back to typing')
      s.options.onFinish?.({ cancelled: false })
    })
    await flush()
    expect(s.paste).toHaveBeenCalledWith(2, 'back to typing')
    expect(s.sent).toEqual([[1, 'first']])
    expect(s.phaseCalls).toContainEqual([2, 'idle'])
  })

  it('listens unseen till the press is known: a hold opens straight into the circle, a tap into the card', async () => {
    s.phase = 'listening'
    await mount()
    act(() => s.emit!({ run: 1, action: 'start' }))
    // Not yet known: nothing shown, no size asked for.
    expect(container.querySelector('[data-testid="dictate-pill"]')).toBeNull()
    expect(circle()).toBeNull()
    expect(s.sizes).toEqual([])
    act(() => s.emit!({ run: 1, action: 'to_agent' }))
    expect(circle()?.getAttribute('data-state')).toBe('listening')
    // The circle's size is the only one it asks for: no card first.
    expect(s.sizes).toEqual([[CIRCLE, CIRCLE, CIRCLE / 2]])
    act(() => s.emit!({ run: 1, action: 'send' }))
    await act(async () => {
      s.options.onCommit('hello')
      s.options.onFinish?.({ cancelled: false })
    })
    // A conversation: the next press starts round, then a tap makes it the card.
    act(() => s.emit!({ run: 2, action: 'start' }))
    expect(circle()?.getAttribute('data-state')).toBe('listening')
    act(() => s.emit!({ run: 2, action: 'tapped' }))
    expect(circle()).toBeNull()
    expect(container.querySelector('[data-testid="dictate-pill"]')).not.toBeNull()
    // A fresh tap shows the card once it's let go.
    act(() => s.emit!({ run: 3, action: 'close' }))
    act(() => s.emit!({ run: 4, action: 'start' }))
    expect(container.querySelector('[data-testid="dictate-pill"]')).toBeNull()
    act(() => s.emit!({ run: 4, action: 'tapped' }))
    expect(container.querySelector('[data-testid="dictate-pill"]')).not.toBeNull()
  })

  it("plays Live mode's chime once, as a conversation opens", async () => {
    sounds.played.length = 0
    await mount()
    await sendHeld(1, 'hello')
    expect(sounds.played).toEqual(['voice-chat-start'])
    // A later hold in the same conversation: no chime.
    await sendHeld(2, 'and then')
    expect(sounds.played).toEqual(['voice-chat-start'])
  })

  it('sounds what the press turned out to be: a tap clicks, a hold chimes, the agent going sounds its end', async () => {
    sounds.played.length = 0
    s.phase = 'listening'
    await mount()
    // Dictate anywhere cues its own sounds.
    expect((s.options as unknown as { cues?: boolean }).cues).toBe(false)
    // A hold: listening already, then it becomes the agent's. Only Live mode's chime.
    act(() => s.emit!({ run: 1, action: 'start' }))
    act(() => s.emit!({ run: 1, action: 'to_agent' }))
    expect(sounds.played).toEqual(['voice-chat-start'])
    act(() => s.emit!({ run: 1, action: 'cancel' })) // Esc on the hold
    expect(sounds.played).toEqual(['voice-chat-start', 'voice-chat-end'])
    // A tap: dictation's click, and its end click when it pastes.
    sounds.played.length = 0
    act(() => s.emit!({ run: 2, action: 'start' }))
    expect(sounds.played).toEqual([])
    act(() => s.emit!({ run: 2, action: 'tapped' }))
    expect(sounds.played).toEqual(['stt-dictate-start'])
    act(() => s.emit!({ run: 2, action: 'stop' }))
    await act(async () => {
      s.options.onCommit('hi')
      s.options.onFinish?.({ cancelled: false })
    })
    expect(sounds.played).toEqual(['stt-dictate-start', 'stt-dictate-end'])
  })

  it('Esc on the circle sounds Live mode going', async () => {
    sounds.played.length = 0
    await mount()
    await sendHeld(4, 'hello')
    act(() => s.emit!({ run: 4, action: 'close' }))
    expect(sounds.played).toEqual(['voice-chat-start', 'voice-chat-end'])
  })

  it('shows no "…" when stopping with no words', async () => {
    s.phase = 'stopping'
    await mount()
    act(() => s.emit!({ run: 1, action: 'start' }))
    expect(container.textContent).not.toContain('…')
  })

  it('shows Esc only while the mouse is over the circle', async () => {
    await mount()
    await sendHeld(3, 'hi')
    const hint = () => container.querySelector('[data-testid="dictate-esc-hint"]')!
    expect(hint().className).toContain('opacity-0')
    act(() => s.hover!(true))
    expect(hint().className).toContain('opacity-100')
    act(() => s.hover!(false))
    expect(hint().className).toContain('opacity-0')
  })

  it('says when the agent could not be reached, then goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount()
    await sendHeld(8, 'hello')
    act(() => s.agent!({ run: 8, state: 'failed' }))
    expect(container.textContent).toContain(AGENT_UNREACHABLE)
    await act(async () => {
      vi.advanceTimersByTime(2300)
    })
    expect(s.phaseCalls).toContainEqual([8, 'idle'])
  })

  it('a hold with nothing said ends, or goes back to the waiting circle', async () => {
    await mount()
    act(() => s.emit!({ run: 3, action: 'start_agent' }))
    act(() => s.emit!({ run: 3, action: 'send' }))
    await act(async () => s.options.onFinish?.({ cancelled: false }))
    await flush()
    expect(s.sent).toEqual([])
    expect(s.phaseCalls).toContainEqual([3, 'idle'])

    await sendHeld(4, 'hi')
    act(() => s.agent!({ run: 4, state: 'done' }))
    act(() => s.emit!({ run: 5, action: 'start_agent' }))
    act(() => s.emit!({ run: 5, action: 'send' }))
    await act(async () => s.options.onFinish?.({ cancelled: false }))
    await flush()
    expect(circle()?.getAttribute('data-state')).toBe('waiting')
    expect(s.phaseCalls).not.toContainEqual([5, 'idle'])
  })
})

describe('Learning from edits', () => {
  it('shows what it learned a moment, then lets the panel go', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount()
    s.learned = [{ heard: 'Koka Link', typed: 'KokoLink' }]
    await act(async () => s.edit!([{ heard: 'Koka Link', typed: 'KokoLink' }]))
    await flush()
    expect(container.querySelector('[data-testid="dictate-learned"]')?.textContent).toContain('KokoLink')
    expect(container.textContent).toContain('Learned')
    expect(s.flashes).toEqual([true])
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    // Up a good while (Liam 10-25: a few seconds longer).
    expect(container.querySelector('[data-testid="dictate-learned"]')).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(2100)
    })
    expect(container.querySelector('[data-testid="dictate-learned"]')).toBeNull()
    expect(s.flashes).toEqual([true, false])
  })

  it('shows nothing when nothing was learned yet (the first time)', async () => {
    await mount()
    s.learned = []
    await act(async () => s.edit!([{ heard: 'Koka Link', typed: 'KokoLink' }]))
    await flush()
    expect(container.querySelector('[data-testid="dictate-learned"]')).toBeNull()
    expect(s.flashes).toEqual([])
  })
})

describe('Read-along (spike)', () => {
  it('shows each word as it is said on a card that keeps its size, then goes when the reading is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount()
    await act(async () => s.word!({ id: 'read-selection-1-0', index: 0, count: 2, word: 'Hello,' }))
    expect(container.querySelector('[data-testid="read-along"]')?.textContent).toBe('Hello')
    expect(s.flashes).toEqual([true])
    await flush()
    const first = s.sizes.at(-1)
    await act(async () => s.word!({ id: 'read-selection-1-0', index: 1, count: 2, word: 'extraordinarily' }))
    expect(container.querySelector('[data-testid="read-along"]')?.textContent).toBe('extraordinarily')
    // One size the whole time, asked for after it's shown (showing starts it small).
    expect(s.sizes.at(-1)).toEqual([200, CARD_ONE_LINE_H, 18])
    expect(first).toEqual([200, CARD_ONE_LINE_H, 18])
    await act(async () => s.tts!({ id: 'read-selection-1-0', state: 'done' }))
    // A moment for another sentence, then gone.
    expect(container.querySelector('[data-testid="read-along"]')).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(container.querySelector('[data-testid="read-along"]')).toBeNull()
    expect(s.flashes).toEqual([true, false])
  })

  it("shows nothing for the agent's replies, only for Read anywhere", async () => {
    await mount()
    await act(async () => {
      s.tts!({ id: 'talk-3-0', state: 'queued' })
      s.word!({ id: 'talk-3-0', index: 0, count: 2, word: 'Sure,' })
      s.word!({ id: 'chat-msg-9', index: 0, count: 2, word: 'Here' })
    })
    await flush()
    expect(container.querySelector('[data-testid="read-along"]')).toBeNull()
    expect(s.flashes).toEqual([])
  })

  it('stays up from one sentence to the next, through the pause between them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount()
    await act(async () => {
      s.tts!({ id: 'read-selection-2-0', state: 'queued' })
      s.tts!({ id: 'read-selection-2-1', state: 'queued' })
      s.word!({ id: 'read-selection-2-0', index: 0, count: 1, word: 'First.' })
    })
    await flush()
    await act(async () => s.tts!({ id: 'read-selection-2-0', state: 'done' }))
    await act(async () => {
      vi.advanceTimersByTime(3000) // a long pause before the next sentence
    })
    await act(async () => s.word!({ id: 'read-selection-2-1', index: 0, count: 1, word: 'Second' }))
    expect(container.querySelector('[data-testid="read-along"]')?.textContent).toBe('Second')
    expect(s.flashes).toEqual([true]) // never closed
    await act(async () => s.tts!({ id: 'read-selection-2-1', state: 'cancelled' }))
    expect(container.querySelector('[data-testid="read-along"]')).toBeNull()
  })
})

describe('helpers', () => {
  it('notes only when the words were not pasted', () => {
    expect(pasteNote({ pasted: true, reason: null }, 'check the logs')).toBeNull()
    expect(pasteNote({ pasted: false, reason: 'secure_input' }, 'check the logs')).toBe('Password field: copied instead')
    // Refused (a newer press, pasted already): not copied either, so the words show.
    expect(pasteNote({ pasted: false, reason: 'stale' }, 'check the logs')).toBe('Not pasted: check the logs')
    expect(pasteNote({ pasted: false, reason: null }, '  ')).toBeNull()
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'
    const note = pasteNote({ pasted: false, reason: 'stale' }, long)!
    expect(note.startsWith('Not pasted: …')).toBe(true)
    expect(note.endsWith('seventeen')).toBe(true)
  })

  it('shows the newest words', () => {
    expect(tail('short one')).toBe('short one')
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'
    const shown = tail(long, 30)
    expect(shown.startsWith('…')).toBe(true)
    expect(shown.endsWith('fifteen')).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(30)
  })
})

describe('cardSize', () => {
  it('starts small, grows with the words on one line, then two full-width lines', () => {
    expect(cardSize(40, { icon: true, esc: false })).toEqual({ width: CARD_MIN_W, height: CARD_ONE_LINE_H })
    // 300 + 34 + 28 + 34 = 396: past the widest single line, so two lines.
    expect(cardSize(300, { icon: true, esc: true })).toEqual({ width: CARD_MAX_W, height: CARD_TWO_LINES_H })
    // 200 + 96 = 296 → 296 in 8 px steps.
    expect(cardSize(200, { icon: true, esc: true })).toEqual({ width: 296, height: CARD_ONE_LINE_H })
    // No words yet: just the hint, the icon and the glow.
    expect(cardSize(0, { icon: true, esc: true })).toEqual({ width: CARD_MIN_W, height: CARD_ONE_LINE_H })
    expect(cardSize(900, { icon: true, esc: true })).toEqual({ width: CARD_MAX_W, height: CARD_TWO_LINES_H })
  })
})
