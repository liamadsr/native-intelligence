// @vitest-environment jsdom
/**
 * Talk anywhere's host (../talk-anywhere-host). Pinned:
 *  - a held press's words go to the home thread (deliverVoiceAsk), and the
 *    panel hears thinking → speaking → done for that press;
 *  - no chat to take them: failed, at once;
 *  - an interrupt cuts that press's reply only, and silences what is
 *    playing; a reply already over is left alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listeners = { onSpeaking?: () => void; onSettled?: (o: string) => void }
const s = vi.hoisted(() => ({
  ask: null as null | ((p: { run: number; text: string }) => void),
  interrupt: null as null | ((p: { run: number }) => void),
  states: [] as Array<[number, string]>,
  delivered: [] as Array<{ text: string; listeners: Listeners; interrupt: ReturnType<typeof vi.fn> }>,
  accept: true,
  cancels: 0,
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    onTalkAsk: (cb: (p: { run: number; text: string }) => void) => {
      s.ask = cb
      return () => {}
    },
    onTalkInterrupt: (cb: (p: { run: number }) => void) => {
      s.interrupt = cb
      return () => {}
    },
    talkState: async (run: number, state: string) => {
      s.states.push([run, state])
    },
  },
}))
vi.mock('@/lib/speech-output', () => ({
  speechOutput: {
    cancel: async () => {
      s.cancels++
    },
  },
}))
vi.mock('@/lib/voice/voice-ask-delivery', () => ({
  deliverVoiceAsk: (text: string, _ctx: unknown, listeners: Listeners) => {
    if (!s.accept) return null
    const interrupt = vi.fn()
    s.delivered.push({ text, listeners, interrupt })
    return { interrupt, cancel: vi.fn() }
  },
}))

import { TalkAnywhereHost } from '../talk-anywhere-host'

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  Object.assign(s, { states: [], delivered: [], accept: true, cancels: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<TalkAnywhereHost />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TalkAnywhereHost', () => {
  it('sends the words home and reports the reply to the panel', () => {
    act(() => s.ask!({ run: 3, text: 'what is next today' }))
    expect(s.delivered.map((d) => d.text)).toEqual(['what is next today'])
    expect(s.states).toEqual([[3, 'thinking']])
    act(() => s.delivered[0].listeners.onSpeaking?.())
    act(() => s.delivered[0].listeners.onSettled?.('spoken'))
    expect(s.states).toEqual([
      [3, 'thinking'],
      [3, 'speaking'],
      [3, 'done'],
    ])
  })

  it('fails at once when no chat takes the words', () => {
    s.accept = false
    act(() => s.ask!({ run: 4, text: 'hello' }))
    expect(s.states).toEqual([[4, 'failed']])
  })

  it('an interrupt cuts only that press', () => {
    act(() => s.ask!({ run: 5, text: 'one' }))
    act(() => s.ask!({ run: 6, text: 'two' }))
    act(() => s.interrupt!({ run: 5 }))
    expect(s.delivered[0].interrupt).toHaveBeenCalledTimes(1)
    expect(s.delivered[1].interrupt).not.toHaveBeenCalled()
    expect(s.cancels).toBe(1)
  })

  it('leaves a reply that is already over alone', () => {
    act(() => s.ask!({ run: 7, text: 'one' }))
    act(() => s.delivered[0].listeners.onSettled?.('spoken'))
    act(() => s.interrupt!({ run: 7 }))
    expect(s.delivered[0].interrupt).not.toHaveBeenCalled()
    expect(s.cancels).toBe(0)
  })
})
