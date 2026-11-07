// @vitest-environment jsdom
/**
 * Words typed into the composer while the agent's question is open ANSWER it
 * (the #681 rule, docs/plans/always-on-agent.md §2b). Pinned here:
 *   • the panel hands them to the transport flagged `typed`, so eve approves
 *     the ask_user with the words as the answer instead of cancelling it (the
 *     model read "tool execution was denied" and asked again);
 *   • the popover's Skip and X stay dismissals: no `typed` flag.
 * (A live meeting's ambient question is the live agent's chat's to answer:
 * components/live-chat.)
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'

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
const chat = vi.hoisted(() => ({ status: 'ready' as string, messages: [] as unknown[] }))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chat.messages,
    sendMessage,
    setMessages,
    addToolResult: vi.fn(),
    status: chat.status,
    stop: vi.fn(async () => {}),
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

// The thread isn't what these pin; the popover and the composer are.
vi.mock('../chat-message-list', () => ({ ChatMessageList: () => null }))

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'

const QUESTION_THREAD = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'set up the review' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-ask_user',
        toolCallId: 'ask-1',
        state: 'input-available',
        input: {
          questions: [
            {
              question: 'Which day?',
              header: 'Day',
              options: [{ label: 'Monday' }, { label: 'Tuesday' }],
              multiSelect: false,
            },
          ],
        },
      },
    ],
  },
]

describe('ChatPanel: typed words answer an open question', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>
  let answerPermission: MockInstance

  const panel = () =>
    h(ChatPanel, {
      ref,
      chatSessionId: 'sess-typed',
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
  async function send(text: string) {
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }
  /** A button in the question popover (it portals out of the panel). */
  function popoverButton(match: (b: HTMLButtonElement) => boolean): HTMLButtonElement {
    const b = [...document.body.querySelectorAll('button')].find(match)
    if (!b) throw new Error('no such popover button')
    return b
  }
  /** The flip handleAnswerQuestion applied to the question's part. */
  function flippedPart() {
    const flip = setMessages.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function') as
      | ((prev: unknown[]) => Array<{ parts: Array<Record<string, unknown>> }>)
      | undefined
    return flip?.(chat.messages)[1].parts[0]
  }

  beforeEach(() => {
    sendMessage.mockClear()
    setMessages.mockClear()
    chat.status = 'ready'
    chat.messages = QUESTION_THREAD
    answerPermission = vi.spyOn(EveChatTransport.prototype, 'answerPermission').mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    answerPermission.mockRestore()
    vi.unstubAllGlobals()
  })

  it('a typed reply goes to the transport flagged typed, so it answers rather than dismisses', async () => {
    await mount()
    await send('Thursday')

    expect(answerPermission).toHaveBeenCalledTimes(1)
    expect(answerPermission).toHaveBeenCalledWith('sess-typed', 'ask-1', {}, 'Thursday', { typed: true })
    // It answers the question; it is not also sent as a turn of its own.
    expect(sendMessage).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(flippedPart()).toMatchObject({ toolCallId: 'ask-1', state: 'output-available', output: { response: 'Thursday' } })
  })

  it('words a surface sends (A3 sendFromSurface) answer the open question too, flagged typed', async () => {
    await mount()
    let sent = false
    await act(async () => {
      sent = await ref.current!.sendFromSurface('Thursday', { cardIds: ['card-1'] })
    })

    expect(sent).toBe(true)
    expect(answerPermission).toHaveBeenCalledTimes(1)
    expect(answerPermission).toHaveBeenCalledWith('sess-typed', 'ask-1', {}, 'Thursday', { typed: true })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(flippedPart()).toMatchObject({ toolCallId: 'ask-1', state: 'output-available', output: { response: 'Thursday' } })
  })

  it('Skip stays a dismissal: no typed flag', async () => {
    await mount()
    await act(async () => popoverButton((b) => b.textContent === 'Skip').click())

    expect(answerPermission).toHaveBeenCalledTimes(1)
    const [, toolCallId, answers, response, options] = answerPermission.mock.calls[0]
    expect([toolCallId, answers, response]).toEqual(['ask-1', {}, '(skipped)'])
    expect(options?.typed).toBeUndefined()
  })

  it('X stays a dismissal: no typed flag', async () => {
    await mount()
    await act(async () => popoverButton((b) => b.getAttribute('aria-label') === 'Dismiss question').click())

    expect(answerPermission).toHaveBeenCalledTimes(1)
    const [, toolCallId, answers, response, options] = answerPermission.mock.calls[0]
    expect([toolCallId, answers, response]).toEqual(['ask-1', {}, '(dismissed)'])
    expect(options?.typed).toBeUndefined()
  })
})
