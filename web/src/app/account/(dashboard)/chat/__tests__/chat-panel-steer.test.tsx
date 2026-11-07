// @vitest-environment jsdom
/**
 * A held message steers the running reply (UI-2, docs/plans/always-on-agent.md
 * §2b). The transport's steer calls are stubbed (their behaviour is pinned in
 * eve-chat-transport-steer.test.ts); what this pins is the panel:
 *   • plain words typed on the running reply's page ask to steer, and the row
 *     says "Waiting for a good moment…" with Edit and a plain-text Send now;
 *   • once posted, Edit is gone (eve can't take it back);
 *   • the flush sends it with `body.steerId` (adopt, never a second request);
 *   • files, a skill or no composer turn running keep today's wait;
 *   • Edit while held withdraws it; Send now while held withdraws then stops;
 *     Send now while posted only stops (the transport keeps the steer);
 *   • a message sent while one is posted waits in a second row;
 *   • a posted steer never goes back into the composer the tab saves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'
import type { SteerPhase, SteerRequest } from '@/lib/chat/eve/eve-chat-transport'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => 400,
})

const sendMessage = vi.fn()
const setMessages = vi.fn()
const stop = vi.fn(async () => {})
const chat = vi.hoisted(() => ({ status: 'ready' as string, messages: [] as unknown[] }))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chat.messages,
    sendMessage,
    setMessages,
    addToolResult: vi.fn(),
    status: chat.status,
    stop,
    error: undefined,
    regenerate: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
  Toaster: () => null,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}))

vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))

vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [],
  SlashCommandPicker: () => null,
}))

vi.mock('../chat-message-list', () => ({ ChatMessageList: () => null }))

import { toast } from 'sonner'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'
import { ChatPanel, type ChatPanelHandle } from '../chat-panel'

describe('ChatPanel: a held message steers the running reply', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>
  let steers: SteerRequest[]
  let accept: boolean
  let flushPlan: 'adopt' | 'send' | 'gone'
  let withdrawResult: boolean
  const requestSteer = vi.spyOn(EveChatTransport.prototype, 'requestSteer')
  const withdrawSteer = vi.spyOn(EveChatTransport.prototype, 'withdrawSteer')
  const steerFlushPlan = vi.spyOn(EveChatTransport.prototype, 'steerFlushPlan')

  const panel = () =>
    h(ChatPanel, {
      ref,
      chatSessionId: 'sess-steer',
      userAvatarUrl: null,
      userInitials: 'LA',
      alwaysShowMessages: true,
    })
  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
  }
  async function chatIs(status: string) {
    chat.status = status
    await act(async () => root.render(panel()))
    await act(async () => {
      await Promise.resolve()
    })
  }
  async function type(text: string) {
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function send(text: string) {
    await type(text)
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }
  /** A composer turn is running (dispatchTurn names its page and agent). */
  async function replyRunning() {
    await send('draft the email')
    await chatIs('streaming')
  }
  async function phase(p: SteerPhase, i = 0) {
    await act(async () => steers[i].onState?.(p))
  }
  const rows = () => [...container.querySelectorAll('[data-queued-turn]')]
  const rowStatus = (i = 0) => rows()[i]?.querySelector('[role="status"]')?.textContent ?? null
  const buttonsIn = (i = 0) => [...(rows()[i]?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
  function button(label: string, i = 0): HTMLButtonElement {
    const b = [...(rows()[i]?.querySelectorAll('button') ?? [])].find((x) => x.textContent === label)
    if (!b) throw new Error(`no ${label} button`)
    return b as HTMLButtonElement
  }
  const composer = () => container.querySelector('textarea')!.value
  const sends = () => sendMessage.mock.calls.map(([m, o]) => ({ text: (m as { text: string }).text, metadata: (m as { metadata?: unknown }).metadata, body: (o as { body: Record<string, unknown> }).body }))

  beforeEach(() => {
    sendMessage.mockClear()
    setMessages.mockClear()
    stop.mockClear()
    chat.status = 'ready'
    chat.messages = []
    steers = []
    accept = true
    flushPlan = 'adopt'
    withdrawResult = true
    requestSteer.mockReset().mockImplementation((_chatId: string, req: SteerRequest) => {
      if (!accept) return false
      steers.push(req)
      return true
    })
    withdrawSteer.mockReset().mockImplementation(() => withdrawResult)
    steerFlushPlan.mockReset().mockImplementation(() => flushPlan)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('plain words on the running reply’s page ask to steer: "Waiting for a good moment…", Edit and a plain-text Send now', async () => {
    await mount()
    await replyRunning()
    await send('actually, make it shorter')

    expect(requestSteer).toHaveBeenCalledTimes(1)
    expect(requestSteer.mock.calls[0][0]).toBe('sess-steer')
    expect(steers[0].text).toBe('actually, make it shorter')
    expect(rowStatus()).toBe('Waiting for a good moment…')
    expect(buttonsIn()).toEqual(['Send now', 'Edit'])
    // Send now is plain text, not today's pill.
    expect(button('Send now').className).not.toContain('rounded-full')
    expect(sendMessage).toHaveBeenCalledTimes(1) // only the first turn: nothing over the running reply
  })

  it('once posted, Edit is gone; the flush sends it with body.steerId and how it landed', async () => {
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await phase('posting')
    await phase('posted')
    expect(rows()[0].getAttribute('data-queued-turn')).toBe('posted')
    expect(buttonsIn()).toEqual(['Send now'])

    await phase('applied')
    await chatIs('ready') // the prior reply settled at the steer point
    await act(async () => {
      await Promise.resolve()
    })
    expect(steerFlushPlan).toHaveBeenCalledWith('sess-steer', steers[0].id, true)
    const flushed = sends()[1]
    expect(flushed.text).toBe('actually, make it shorter')
    expect(flushed.body.steerId).toBe(steers[0].id)
    expect(flushed.metadata).toEqual({ createdAt: expect.any(String) }) // how it landed is the transport's to persist; only its time rides
    expect(rows()).toHaveLength(0)
  })

  it('a held steer the turn ended before (never posted) goes as an ordinary send, without steerId', async () => {
    flushPlan = 'send'
    await mount()
    await replyRunning()
    await send('one more thing')
    await chatIs('ready')
    await act(async () => {
      await Promise.resolve()
    })
    const flushed = sends()[1]
    expect(flushed.text).toBe('one more thing')
    expect(flushed.body.steerId).toBeUndefined()
    expect(flushed.metadata).toEqual({ createdAt: expect.any(String) })
  })

  it('a refused steer (failed) waits for the end with today’s words', async () => {
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await phase('posting')
    await phase('failed')
    expect(rowStatus()).toBe('Sends when this reply finishes')
    expect(buttonsIn()).toEqual(['Send now', 'Edit'])
  })

  it('files, a skill, or no composer turn running keep today’s wait (never asks to steer)', async () => {
    await mount()
    // No composer turn ran: the reply is someone else's (a click, a voice ask…).
    await chatIs('streaming')
    await send('hello there')
    expect(requestSteer).not.toHaveBeenCalled()
    expect(rowStatus()).toBe('Sends when this reply finishes')
  })

  it('a skill picked while a composer reply runs waits, never steers', async () => {
    await mount()
    await replyRunning()
    await act(async () => {
      ref.current!.triggerSkill({ id: 'skill-brief', slug: 'morning-brief', name: 'Morning Brief', icon: null, color: null, description: null, views_context: null } as never)
      await Promise.resolve()
    })
    expect(requestSteer).not.toHaveBeenCalled()
    expect(rowStatus()).toBe('Sends when this reply finishes')
  })

  it('the transport has nothing to steer: today’s wait', async () => {
    accept = false
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    expect(requestSteer).toHaveBeenCalledTimes(1)
    expect(rowStatus()).toBe('Sends when this reply finishes')
  })

  it('Edit while held takes it back: the words return to the composer and nothing is sent', async () => {
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await act(async () => button('Edit').click())
    expect(withdrawSteer).toHaveBeenCalledWith('sess-steer', steers[0].id, 'edited')
    expect(rows()).toHaveLength(0)
    expect(composer()).toBe('actually, make it shorter')
    await chatIs('ready')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('Edit that comes too late (the POST just started) keeps the row and says it is on its way', async () => {
    withdrawResult = false
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await act(async () => button('Edit').click())
    expect(rows()).toHaveLength(1)
    expect(rowStatus()).toBe('Already on its way — waiting for a good moment…')
    expect(composer()).toBe('')
  })

  it('a second send while held joins it: the held steer is taken back and the joined words asked again', async () => {
    await mount()
    await replyRunning()
    await send('first thought')
    await send('second thought')
    expect(withdrawSteer).toHaveBeenCalledWith('sess-steer', steers[0].id, 'merged')
    expect(steers).toHaveLength(2)
    expect(steers[1].text).toBe('first thought\n\nsecond thought')
    expect(rows()).toHaveLength(1)
  })

  it('Send now while held: withdraws the steer, then stops the reply; it goes as an ordinary send', async () => {
    flushPlan = 'send'
    await mount()
    await replyRunning()
    await send('stop, do this instead')
    await act(async () => button('Send now').click())
    expect(withdrawSteer).toHaveBeenCalledWith('sess-steer', steers[0].id, 'sent_now')
    expect(stop).toHaveBeenCalledTimes(1)
    await chatIs('ready')
    expect(steerFlushPlan).not.toHaveBeenCalled()
    expect(sends()[1]).toMatchObject({ text: 'stop, do this instead' })
    expect(sends()[1].body.steerId).toBeUndefined()
  })

  it('Send now while posted: only stops the reply (the transport keeps the steer), then the flush adopts it', async () => {
    flushPlan = 'adopt'
    await mount()
    await replyRunning()
    await send('stop, do this instead')
    await phase('posting')
    await phase('posted')
    await act(async () => button('Send now').click())
    expect(withdrawSteer).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
    await chatIs('ready')
    await act(async () => {
      await Promise.resolve()
    })
    expect(sends()[1].body.steerId).toBe(steers[0].id)
    expect(sends()[1].metadata).toEqual({ createdAt: expect.any(String) })
  })

  it('Stop marks the reply it ends "Stopped" (metadata.stopped)', async () => {
    chat.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Half a rep' }] },
    ]
    await mount()
    await replyRunning()
    await send('stop, do this instead')
    await act(async () => button('Send now').click())
    const mark = setMessages.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function') as
      | ((prev: unknown[]) => Array<{ id: string; metadata?: unknown }>)
      | undefined
    expect(mark).toBeDefined()
    expect(mark!(chat.messages)[1]).toMatchObject({ id: 'a1', metadata: { stopped: true } })
  })

  it('a message sent while one is posted waits in a second row, and steers the reply that one continues', async () => {
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await phase('posting')
    await phase('posted')
    await send('and friendlier')
    expect(requestSteer).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(2)
    expect(rowStatus(1)).toBe('Sends after that one')
    expect(buttonsIn(1)).toEqual(['Edit'])

    // The flush adopts the first; the second moves up once that reply streams.
    await chatIs('ready')
    await act(async () => {
      await Promise.resolve()
    })
    expect(sends()[1].body.steerId).toBe(steers[0].id)
    await chatIs('streaming')
    expect(requestSteer).toHaveBeenCalledTimes(2)
    expect(steers[1].text).toBe('and friendlier')
    expect(rows()).toHaveLength(1)
    expect(rowStatus()).toBe('Waiting for a good moment…')
  })

  it('a steer the transport lost or dropped (eve has it, or may): the row goes, a toast says so, and nothing is re-sent', async () => {
    for (const lost of ['dropped', 'lost'] as const) {
      sendMessage.mockClear()
      vi.mocked(toast.error).mockClear()
      steers = []
      await mount()
      await replyRunning()
      await send('actually, make it shorter')
      await phase('posting')
      await phase(lost)
      expect(rows()).toHaveLength(0)
      expect(toast.error).toHaveBeenCalledTimes(1)
      await chatIs('ready')
      expect(sends().map((s) => s.text)).toEqual(['draft the email'])
      act(() => root.unmount())
      container.remove()
      chat.status = 'ready'
    }
    await mount() // for afterEach
  })

  it('the flush of a posted steer the transport no longer has (gone) sends nothing', async () => {
    flushPlan = 'gone'
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await phase('posting')
    await phase('posted')
    await chatIs('ready')
    await act(async () => {
      await Promise.resolve()
    })
    expect(sends().map((s) => s.text)).toEqual(['draft the email'])
    expect(rows()).toHaveLength(0)
  })

  it('while a row waits behind a steer, later words join that row (in order), never the head', async () => {
    await mount()
    await replyRunning()
    await send('actually, make it shorter')
    await phase('posting')
    await phase('posted')
    await send('and friendlier')
    await phase('failed') // the head is an ordinary held turn now
    await send('and in French')
    expect(rows()).toHaveLength(2)
    expect(rows()[0].querySelector('[data-queued-turn-text]')?.textContent).toBe('actually, make it shorter')
    expect(rows()[1].querySelector('[data-queued-turn-text]')?.textContent).toBe('and friendlier\n\nand in French')
  })

  it('a posted steer never goes back into the composer the tab saves (eve has it); a held one does', async () => {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const withSnapshot = () =>
      h(ChatPanel, { ref, chatSessionId: 'sess-steer', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true })
    await act(async () => root.render(withSnapshot()))
    await send('draft the email')
    chat.status = 'streaming'
    await act(async () => root.render(withSnapshot()))
    await send('actually, make it shorter')
    expect(ref.current!.flushSnapshot().chatInput).toBe('actually, make it shorter')
    await phase('posting')
    await phase('posted')
    expect(ref.current!.flushSnapshot().chatInput).toBe('')
  })
})
