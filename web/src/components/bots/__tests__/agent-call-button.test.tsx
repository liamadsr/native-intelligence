// @vitest-environment jsdom
/**
 * The agent card's Call (agent-call-button.tsx): no button where voice mode
 * can't exist (the web, models not in); Call starts the main chat's voice
 * mode (Calling… meanwhile), End call ends it; disabled with the composer's
 * reason while the mic is someone else's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const voice = vi.hoisted(() => ({ conversation: true, blocked: null as null | 'recording' | 'enrollment' }))
vi.mock('@/hooks/use-voice-availability', () => ({
  useVoiceAvailability: () => ({ hasVoice: voice.conversation, visible: voice.conversation, dictation: voice.conversation, conversation: voice.conversation, blocked: voice.blocked, status: {} }),
  voiceBlockedLabel: (reason: string) => (reason === 'recording' ? 'Unavailable while a capture is recording' : 'Unavailable while Voice ID is listening'),
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))

const { AgentCallButton } = await import('../agent-call-button')
const bird = await import('@/components/birds/voice-bird')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let events: string[]
let pending: Array<(started: boolean) => void>
// The main chat's host as it really goes: voice mode reports itself on ('starting') the moment start() begins,
// before the mic opens; then listening once it has, or off on a refusal. An end turns it off.
const onEvent = (e: Event) => {
  const d = bird.parseVoiceBirdDetail((e as CustomEvent).detail)!
  events.push(d.action)
  if (d.action === 'start') {
    d.take()
    bird.reportMainVoice(true, 'starting')
    pending.push((started) => {
      bird.reportMainVoice(started && bird.voiceBirdState().voiceActive, started ? 'listening' : null)
      d.onResult(started)
    })
  } else bird.reportMainVoice(false, null)
}
beforeEach(() => {
  voice.conversation = true
  voice.blocked = null
  events = []
  pending = []
  bird.__resetVoiceBirdForTests()
  window.addEventListener(bird.VOICE_BIRD_EVENT, onEvent)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.removeEventListener(bird.VOICE_BIRD_EVENT, onEvent)
})

const button = () => host.querySelector<HTMLButtonElement>('[data-agent-call]')

describe('the agent card’s Call', () => {
  it('is not there where voice mode can’t be (the web, the models not in), and neither is its spacing', () => {
    voice.conversation = false
    act(() => root.render(<AgentCallButton name="Joseph" className="px-3" />))
    expect(host.innerHTML).toBe('')
  })

  it('Call starts voice mode: Calling… while it starts, End call once on, Call again once hung up; no bird', async () => {
    act(() => root.render(<AgentCallButton name="Joseph" className="px-3" />))
    expect(button()!.textContent).toBe('Call')
    expect(button()!.getAttribute('aria-label')).toBe('Call Joseph')
    expect(button()!.hasAttribute('title')).toBe(false)
    expect(button()!.parentElement!.className).toBe('px-3')
    await act(async () => button()!.click())
    expect(events).toEqual(['start'])
    expect(button()!.textContent).toBe('Calling…')
    expect(button()!.getAttribute('data-agent-call')).toBe('starting')
    await act(async () => pending[0](true))
    expect(button()!.textContent).toBe('End call')
    expect(button()!.getAttribute('aria-label')).toBe('End call with Joseph')
    await act(async () => button()!.click())
    expect(events).toEqual(['start', 'end'])
    expect(button()!.textContent).toBe('Call')
    expect(bird.isVoiceBirdHere()).toBe(false)
  })

  it('hung up while it starts (the mic still opening): back to Call at once, and the late start changes nothing', async () => {
    act(() => root.render(<AgentCallButton name="Joseph" />))
    await act(async () => button()!.click())
    expect(button()!.textContent).toBe('Calling…')
    // Calling… is the hang-up while it starts.
    await act(async () => button()!.click())
    expect(events).toEqual(['start', 'end'])
    expect(button()!.textContent).toBe('Call')
    expect(button()!.getAttribute('aria-disabled')).toBeNull()
    await act(async () => pending[0](false))
    expect(button()!.textContent).toBe('Call')
  })

  it('a refused call goes back to Call', async () => {
    act(() => root.render(<AgentCallButton name="Joseph" />))
    await act(async () => button()!.click())
    await act(async () => pending[0](false))
    expect(button()!.textContent).toBe('Call')
  })

  it('while the mic is someone else’s: says why and does nothing, still reachable by keyboard; a call under way can be hung up', async () => {
    voice.blocked = 'recording'
    act(() => root.render(<AgentCallButton name="Joseph" />))
    expect(button()!.getAttribute('aria-disabled')).toBe('true')
    expect(button()!.disabled).toBe(false)
    expect(button()!.title).toBe('Unavailable while a capture is recording')
    await act(async () => button()!.click())
    expect(events).toEqual([])
    act(() => bird.reportMainVoice(true, 'listening'))
    expect(button()!.getAttribute('aria-disabled')).toBeNull()
    expect(button()!.textContent).toBe('End call')
    await act(async () => button()!.click())
    expect(events).toEqual(['end'])
  })
})
