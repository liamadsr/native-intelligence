// @vitest-environment jsdom
/**
 * Interactive mode's spoken ask, at the ChatPanel handle (askByVoice); the
 * host's route to it is pinned in home-thread-routing.test.ts:
 *
 *   • it goes out through the composer's own send path (submitTurn), so the
 *     turn carries what a typed one does (the tab's context, the chat's
 *     agent) plus systemContext.voiceAsk; read-aloud
 *     is told to follow it first (followNextTurn), so the reply is spoken;
 *   • the delivery hears back: speaking once the reply is read aloud, then
 *     `spoken` when that is over; `interrupted` when the host cuts it (a
 *     barge-in, which stops the reading) or it is cut while still streaming;
 *     `silent` for a turn that ends with nothing read; `failed` for an error;
 *   • a typed turn in flight is waited for; a spoken ask's own reply still
 *     generating is stopped and replaced.
 *
 * The real ChatPanel; useChat, read-aloud and the voice bridge are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const hoisted = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'streaming' | 'submitted' | 'error',
  messages: [] as UIMessage[],
  speaking: null as string | null,
  log: [] as string[],
  sendMessage: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}))

vi.mock('@ai-sdk/react', async () => {
  const { vi } = await import('vitest')
  hoisted.sendMessage = vi.fn(() => void hoisted.log.push('sendMessage'))
  return {
    useChat: () => ({
      messages: hoisted.messages,
      sendMessage: hoisted.sendMessage,
      setMessages: vi.fn(),
      addToolResult: vi.fn(),
      status: hoisted.status,
      stop: async () => void hoisted.log.push('stop'),
      error: undefined,
      regenerate: vi.fn(),
    }),
  }
})

// Read-aloud as the desktop has it: which message it shows speaking.
vi.mock('@/hooks/use-read-aloud', () => ({
  useReadAloud: () => ({
    supported: true,
    speakingMessageId: hoisted.speaking,
    speakMessage: () => {},
    pause: () => {},
    stop: () => void hoisted.log.push('readAloud.stop'),
    followNextTurn: () => void hoisted.log.push('followNextTurn'),
    interrupt: () => void hoisted.log.push('readAloud.interrupt'),
    speakLine: () => null,
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
    channel: () => {
      const ch: Record<string, unknown> = {}
      ch.on = () => ch
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: () => {},
  }),
}))

vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))
vi.mock('voice-glow', () => ({ VoiceBeam: () => null }))
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({ flushTranscriptForAgent: async () => {}, getSegmentsForAgent: () => [] }),
}))
vi.mock('../slash-command-picker', () => ({ useRecipeCommands: () => [], SlashCommandPicker: () => null }))
// The thread itself isn't under test (its rows need the tabs provider).
vi.mock('../chat-message-list', () => ({ ChatMessageList: () => null }))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { VOICE_ASK_SETTLE_GRACE_MS } from '../use-voice-ask-replies'
import type { VoiceAskDelivery, VoiceAskOutcome } from '@/lib/voice/voice-ask-delivery'
import type { VoiceAskContext } from '@/lib/voice/voice-ask'

const TAB_CONTEXT = { assistantName: 'Dial' }
const VOICE_ASK: VoiceAskContext = { snapshot: { kind: 'document', id: 'doc-1', readingAt: 'The budget is due Friday.' } }

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).split('?')[0] === '/api/account/chat-history/conv-1') {
        return {
          ok: true,
          json: async () => ({ messages: [], title: 'Live: Pricing sync', captureId: 'cap-1', recipeId: 'rec-1' }),
        } as Response
      }
      if (url === '/api/account/agents/rec-1') {
        return {
          ok: true,
          json: async () => ({
            agent: { id: 'rec-1', name: 'Interactive Assistant', icon: null, color: null, description: null, agent_config: null },
          }),
        } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }),
  )
}

/** A delivery as Interactive mode makes it, recording what the panel reports. */
function delivery(text = 'Who wrote this?') {
  const report = { accepted: false, speaking: 0, outcomes: [] as VoiceAskOutcome[], cut: null as null | (() => void) }
  const d: VoiceAskDelivery = {
    text,
    voiceAsk: VOICE_ASK,
    accept: () => void (report.accepted = true),
    speaking: () => void report.speaking++,
    settle: (o) => void report.outcomes.push(o),
    onInterrupt: (fn) => void (report.cut = fn),
  }
  return { d, report }
}

describe('ChatPanel.askByVoice', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  const panel = () =>
    h(ChatPanel, { ref, chatSessionId: 'sess-1', userAvatarUrl: null, userInitials: 'LA', alwaysShowMessages: true, systemContext: TAB_CONTEXT })

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
  }
  async function rerender() {
    await act(async () => root.render(panel()))
    await settle()
  }
  async function mount() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
    await settle()
  }
  async function ask(d: VoiceAskDelivery) {
    await act(async () => ref.current!.askByVoice(d))
    await settle()
  }
  /** useChat appends the user's message as the send goes out. */
  async function turnStarts(userId = 'u1') {
    hoisted.messages = [...hoisted.messages, { id: userId, role: 'user', parts: [{ type: 'text', text: 'q' }] } as UIMessage]
    hoisted.status = 'submitted'
    await rerender()
  }
  async function replyStreams(replyId = 'a1') {
    hoisted.messages = [...hoisted.messages, { id: replyId, role: 'assistant', parts: [{ type: 'text', text: 'It was Maya.' }] } as UIMessage]
    hoisted.status = 'streaming'
    await rerender()
  }

  beforeEach(() => {
    hoisted.status = 'ready'
    hoisted.messages = []
    hoisted.speaking = null
    hoisted.log = []
    hoisted.sendMessage?.mockClear()
    installFetch()
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('accepts it and sends it through the send path: the tab’s context and voiceAsk, never a live meeting’s; followed first', async () => {
    await mount()
    const { d, report } = delivery()
    await ask(d)
    expect(report.accepted).toBe(true)
    expect(hoisted.sendMessage).toHaveBeenCalledTimes(1)
    const [message, { body }] = hoisted.sendMessage.mock.calls[0] as [{ text: string }, { body: Record<string, any> }]
    expect(message).toEqual({ text: 'Who wrote this?', metadata: { createdAt: expect.any(String) } })
    expect(body.systemContext).toMatchObject({ ...TAB_CONTEXT, voiceAsk: VOICE_ASK })
    // A spoken ask during a call goes to the live agent's chat
    // (route-voice-ask.ts), never through this panel as the meeting's.
    expect(body.systemContext.liveCaptureId).toBeUndefined()
    expect(body.agentId).toBeUndefined()
    // Read-aloud follows the turn before it goes.
    expect(hoisted.log).toEqual(['followNextTurn', 'sendMessage'])
  })

  it('reports speaking once the reply is read aloud, and `spoken` when the reading is over', async () => {
    await mount()
    const { d, report } = delivery()
    await ask(d)
    await turnStarts()
    await replyStreams()
    expect(report.speaking).toBe(0)
    hoisted.speaking = 'a1'
    await rerender()
    expect(report.speaking).toBe(1)
    hoisted.status = 'ready'
    await rerender()
    expect(report.outcomes).toEqual([])
    hoisted.speaking = null
    await rerender()
    expect(report.outcomes).toEqual(['spoken'])
  })

  it('cut by the host (a barge-in): the reading stops, `interrupted`', async () => {
    await mount()
    const { d, report } = delivery()
    await ask(d)
    await turnStarts()
    await replyStreams()
    hoisted.speaking = 'a1'
    await rerender()
    await act(async () => report.cut!())
    expect(hoisted.log).toContain('readAloud.interrupt')
    expect(report.outcomes).toEqual(['interrupted'])
  })

  it('the reading stopping while the reply still streams (another reader, a new turn): `interrupted`', async () => {
    await mount()
    const { d, report } = delivery()
    await ask(d)
    await turnStarts()
    await replyStreams()
    hoisted.speaking = 'a1'
    await rerender()
    hoisted.speaking = null
    await rerender()
    expect(report.outcomes).toEqual(['interrupted'])
  })

  it('a turn that ends with nothing read: `silent` (after a grace for its last sentences); an error: `failed`', async () => {
    await mount()
    const first = delivery()
    await ask(first.d)
    await turnStarts()
    await replyStreams()
    hoisted.status = 'ready'
    await rerender()
    expect(first.report.outcomes).toEqual([])
    await act(async () => {
      await new Promise((r) => setTimeout(r, VOICE_ASK_SETTLE_GRACE_MS + 50))
    })
    expect(first.report.outcomes).toEqual(['silent'])

    const second = delivery('And when?')
    await ask(second.d)
    await turnStarts('u2')
    hoisted.status = 'error'
    await rerender()
    await act(async () => {
      await new Promise((r) => setTimeout(r, VOICE_ASK_SETTLE_GRACE_MS + 50))
    })
    expect(second.report.outcomes).toEqual(['failed'])
  })

  it('a typed turn in flight is waited for: the ask goes out once the chat settles', async () => {
    await mount()
    hoisted.messages = [{ id: 'typed', role: 'user', parts: [{ type: 'text', text: 'typed' }] } as UIMessage]
    hoisted.status = 'streaming'
    await rerender()
    const { d, report } = delivery()
    await ask(d)
    expect(report.accepted).toBe(true)
    expect(hoisted.sendMessage).not.toHaveBeenCalled()
    hoisted.status = 'ready'
    await rerender()
    expect(hoisted.sendMessage).toHaveBeenCalledTimes(1)
    expect(hoisted.log).not.toContain('stop')
  })

  it('a spoken ask’s own reply still generating is stopped and replaced', async () => {
    await mount()
    const first = delivery()
    await ask(first.d)
    await turnStarts()
    await replyStreams()
    const second = delivery('No, the other one')
    await ask(second.d)
    // The new ask waits for the stopped reply to settle (never sent over its
    // stream, which would duplicate it), then goes.
    expect(hoisted.log).toEqual(['followNextTurn', 'sendMessage', 'stop', 'followNextTurn'])
    hoisted.status = 'ready'
    await rerender()
    expect(hoisted.log).toEqual(['followNextTurn', 'sendMessage', 'stop', 'followNextTurn', 'sendMessage'])
    expect((hoisted.sendMessage.mock.calls[1] as [{ text: string }])[0].text).toBe('No, the other one')
    // The first one gave way.
    expect(first.report.outcomes).toEqual(['interrupted'])
  })
})
