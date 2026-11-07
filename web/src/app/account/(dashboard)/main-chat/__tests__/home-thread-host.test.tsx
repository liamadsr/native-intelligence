// @vitest-environment jsdom
/**
 * The main chat's host (MainChatHost, docs/plans/one-chat.md Slice 1; the chat
 * panel stubbed). Pinned:
 *   • boot renders the stored chat at once, and when it is the home thread
 *     nothing loads;
 *   • a stored conversation that isn't the home thread (or none at all) makes
 *     it load the home thread, only while the chat is as it mounted; a chat
 *     something was said in first keeps what it has;
 *   • a card asked for at boot waits for that, so it lands on the home thread;
 *   • a call (Slice 3) never takes the panel: its conversation event loads
 *     nothing and offers nothing (the call's live agent has its own chat, in
 *     the HUD); every turn meanwhile carries the call's capture
 *     (systemContext.onCallCaptureId) for the main agent's one line; a spoken
 *     ask goes to the live agent's chat, typed words stay the main agent's;
 *   • openHomeThread / handOffToHome send into the chat with their result,
 *     a spoken ask goes there outside a call, and a home thread gone from the
 *     server is forgotten and read afresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = 'ws-a'

type Rec = { captureId: string | null; isRecording: boolean; isStarting: boolean; isPaused: boolean; registerNavigate: () => void; unregisterNavigate: () => void }

const env = vi.hoisted(() => ({
  rec: null as Rec | null,
  /** The recording as a store, so the host re-renders on a change (as the real context does). */
  recListeners: new Set<() => void>(),
  homeId: 'home-1' as string | null,
  /** Every home-thread read waits on it (a test holds it to answer later). */
  homeGate: Promise.resolve() as Promise<void>,
}))

/** The stubbed panel: its state, and what was asked of it. */
const panel = vi.hoisted(() => ({
  mounts: [] as Array<{ session: string; initialConversationId?: string; initialMessages: unknown[] }>,
  conversationId: undefined as string | undefined,
  messages: [] as unknown[],
  /** The systemContext prop, on every render. */
  contexts: [] as Array<Record<string, unknown> | undefined>,
  busy: false,
  idleWaiters: [] as Array<() => void>,
  loads: [] as Array<{ conversationId: string; ifUntouched?: boolean }>,
  outcomes: [] as string[],
  asks: [] as string[],
  sends: [] as Array<{ text: string; cardIds?: string[] }>,
  sendResult: true,
  cards: [] as string[],
  /** Voice mode: starts, ends, and what a start answers. */
  voice: [] as string[],
  voiceRefusal: null as null | { code: string; detail: string | null },
  /** What a banner asked of it: catch-ups and reveals, by message id. */
  catchUps: [] as Array<string | null>,
  reveals: [] as Array<string | null>,
}))

const refusals = vi.hoisted(() => [] as unknown[])
vi.mock('@/app/account/(dashboard)/chat/voice-controls', () => ({
  reportVoiceRefusal: (r: unknown) => void refusals.push(r),
}))

const sendToLiveChat = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true))
const desktop = vi.hoisted(() => ({ on: false, asks: [] as unknown[] }))
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isDesktopApp: () => desktop.on,
}))
vi.mock('@/lib/live-agent/hud-ask-client', () => ({
  askHudWindow: vi.fn(async (ask: unknown) => {
    desktop.asks.push(ask)
    return true
  }),
}))

vi.mock('@/app/account/workspace-switcher', () => ({
  useSwitchWorkspace: () => () => false,
  useWorkspaceId: () => WS,
}))
vi.mock('@/hooks/recording-context', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (fn: () => void) => {
    env.recListeners.add(fn)
    return () => env.recListeners.delete(fn)
  }
  return {
    ...(await importOriginal<typeof import('@/hooks/recording-context')>()),
    useOptionalRecordingStable: () => useSyncExternalStore(subscribe, () => env.rec, () => env.rec),
  }
})
vi.mock('@/app/account/(dashboard)/use-home-conversation-adoption', () => ({
  useHomeConversationAdoption: () => null,
}))
vi.mock('@/lib/chat/home-thread-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/home-thread-client')>()),
  fetchHomeThreadId: vi.fn(async () => {
    await env.homeGate
    return env.homeId
  }),
  peekHomeThreadId: vi.fn(() => null),
  forgetHomeThreadId: vi.fn(),
}))
vi.mock('@/components/live-chat/use-live-chat', () => ({ sendToLiveChat }))
vi.mock('@/app/account/(dashboard)/chat/floating-chat', () => ({
  FloatingChat: ({ children }: { children?: ReactNode }) => children,
}))
vi.mock('@/app/account/(dashboard)/chat/chat-panel', async () => {
  const React = await import('react')
  const ChatPanel = React.forwardRef(function ChatPanel(
    props: { chatSessionId: string; initialConversationId?: string; initialMessages?: unknown[]; systemContext?: Record<string, unknown> },
    ref,
  ) {
    const { chatSessionId } = props
    panel.contexts.push(props.systemContext)
    React.useState(() => {
      panel.mounts.push({ session: chatSessionId, initialConversationId: props.initialConversationId, initialMessages: props.initialMessages ?? [] })
      panel.conversationId = props.initialConversationId
      panel.messages = props.initialMessages ?? []
      return null
    })
    React.useImperativeHandle(
      ref,
      () => ({
        flushSnapshot: () => ({ chatSessionId, chatMessages: panel.messages, chatInput: '', conversationId: panel.conversationId }),
        focusInput: () => {},
        whenIdle: () => (panel.busy ? new Promise<void>((resolve) => panel.idleWaiters.push(resolve)) : Promise.resolve()),
        loadConversation: async (conversationId: string, opts?: { ifUntouched?: boolean }) => {
          panel.loads.push({ conversationId, ...(opts?.ifUntouched ? { ifUntouched: true } : {}) })
          await Promise.resolve()
          const outcome = panel.outcomes.shift() ?? 'loaded'
          if (outcome === 'loaded') panel.conversationId = conversationId
          return outcome
        },
        sendFromSurface: async (text: string, opts?: { cardIds?: string[] }) => {
          panel.sends.push({ text, ...(opts?.cardIds?.length ? { cardIds: opts.cardIds } : {}) })
          return panel.sendResult
        },
        askByVoice: (d: { text: string; accept: () => void }) => {
          d.accept()
          panel.asks.push(d.text)
        },
        openCard: (request: { spec: { kind: string } }) => {
          panel.cards.push(request.spec.kind)
        },
        startVoiceMode: async () => {
          panel.voice.push(`start:${panel.conversationId}`)
          return panel.voiceRefusal
        },
        endVoiceMode: () => void panel.voice.push('end'),
        catchUpServerTurns: async (messageId: string | null) => void panel.catchUps.push(messageId),
        revealMessage: async (messageId: string | null) => {
          panel.reveals.push(messageId)
          return true
        },
      }),
      [chatSessionId],
    )
    return null
  })
  return { ChatPanel }
})

import { MainChatProvider } from '../main-chat-context'
import { MainChatHost } from '../main-chat-host'
import { HOME_HANDOFF_REASONS, OPEN_HOME_THREAD_EVENT, handOffToHome } from '@/lib/chat/home-thread-client'
import { VOICE_ASK_EVENT } from '@/lib/voice/voice-ask-delivery'
import { LIVE_CAPTURE_CONVERSATION_EVENT, __resetLiveCaptureConversationsForTests } from '@/lib/live-agent/live-hud'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'
import { OPEN_CARD_EVENT, cardForTarget } from '@/lib/chat-cards/open-card'
import { VOICE_BIRD_EVENT } from '@/components/birds/voice-bird'
import { HOME_MESSAGE_EVENT } from '@/lib/chat/home-message'

let container: HTMLDivElement
let root: Root

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: id }] }) as UIMessage

function tree() {
  return h(MainChatProvider, null, h('div', null, h(MainChatHost, { userAvatarUrl: null, userInitials: 'LA' })))
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

async function mount() {
  await act(async () => {
    root.render(tree())
  })
  await flush()
}

/** Re-render, as a recording-state change does. */
async function rerender() {
  await act(async () => {
    root.render(tree())
  })
  await flush()
}

function storeChat(chat: { chatSessionId: string; chatMessages?: UIMessage[]; conversationId?: string }) {
  localStorage.setItem(`dial8-chat:${WS}`, JSON.stringify({ chatMessages: [], chatInput: '', ...chat }))
  localStorage.setItem('dial8-chat:last-workspace', WS)
}

const flushTranscriptForAgent = vi.fn(async (_captureId: string) => {})

function recording(captureId: string | null) {
  env.rec = { captureId, isRecording: !!captureId, isStarting: false, isPaused: false, registerNavigate: () => {}, unregisterNavigate: () => {}, flushTranscriptForAgent } as Rec
  act(() => {
    for (const fn of env.recListeners) fn()
  })
}

/** Hold every home-thread read until the returned function is called. */
function holdHome(): () => void {
  let open!: () => void
  env.homeGate = new Promise<void>((resolve) => (open = resolve))
  return open
}

beforeEach(() => {
  localStorage.clear()
  env.rec = null
  env.homeId = 'home-1'
  env.homeGate = Promise.resolve()
  Object.assign(panel, {
    mounts: [],
    conversationId: undefined,
    messages: [],
    contexts: [],
    busy: false,
    idleWaiters: [],
    loads: [],
    outcomes: [],
    asks: [],
    sends: [],
    sendResult: true,
    cards: [],
    voice: [],
    voiceRefusal: null,
    catchUps: [],
    reveals: [],
  })
  refusals.length = 0
  sendToLiveChat.mockClear()
  __resetLiveCaptureConversationsForTests()
  desktop.on = false
  desktop.asks = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('boot', () => {
  it('mounts straight on the stored home thread, and loads nothing', async () => {
    storeChat({ chatSessionId: 'sess-a', chatMessages: [msg('m1'), msg('m2')], conversationId: 'home-1' })
    await mount()
    expect(panel.mounts).toEqual([{ session: 'sess-a', initialConversationId: 'home-1', initialMessages: [msg('m1'), msg('m2')] }])
    expect(panel.loads).toEqual([])
  })

  it('a stored conversation that isn’t the home thread: the home thread loads, only while the chat is untouched', async () => {
    storeChat({ chatSessionId: 'sess-a', chatMessages: [msg('m1')], conversationId: 'conv-old-live' })
    await mount()
    expect(panel.mounts).toHaveLength(1)
    expect(panel.loads).toEqual([{ conversationId: 'home-1', ifUntouched: true }])
    expect(panel.conversationId).toBe('home-1')
  })

  it('a device with no chat stored: a new one, kept with a stable session, and the home thread loads into it', async () => {
    await mount()
    const session = panel.mounts[0].session
    expect(JSON.parse(localStorage.getItem(`dial8-chat:${WS}`)!).chatSessionId).toBe(session)
    expect(panel.loads).toEqual([{ conversationId: 'home-1', ifUntouched: true }])
  })

  it('a blank chat something was said in before the home thread was known keeps what it has', async () => {
    const answer = holdHome()
    await mount()
    panel.messages = [msg('typed first')]
    panel.conversationId = 'conv-new'
    await act(async () => answer())
    await flush()
    expect(panel.loads).toEqual([])
  })

  it('a card asked for at boot lands once the home thread is in', async () => {
    const answer = holdHome()
    await mount()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CARD_EVENT, { detail: { spec: cardForTarget({ type: 'action', id: 'a-1', title: 'GEN-1' })!.spec, from: 'link' } }))
    })
    await flush()
    expect(panel.cards).toEqual([])
    await act(async () => answer())
    await flush()
    expect(panel.loads).toEqual([{ conversationId: 'home-1', ifUntouched: true }])
    expect(panel.cards).toEqual(['record'])
  })
})

describe('a call (one-chat Slice 3)', () => {
  const live = { conversationId: 'conv-live', captureId: 'cap-1', cwd: null, recipeId: 'rec-1' }
  const announce = () =>
    act(() => {
      window.dispatchEvent(new CustomEvent(LIVE_CAPTURE_CONVERSATION_EVENT, { detail: live }))
    })

  it('never takes the panel: its conversation loads nothing and offers nothing, start to end', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    recording('cap-1')
    await rerender()
    announce()
    await flush()
    expect(panel.loads).toEqual([])
    expect(panel.mounts).toHaveLength(1)
    expect(panel.conversationId).toBe('home-1')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('Live meeting'))).toBe(false)
    recording(null)
    await rerender()
    expect(panel.loads).toEqual([])
  })

  it('every turn says a call is on while it records, and stops once it ends', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    expect(panel.contexts.at(-1)?.onCallCaptureId).toBeUndefined()
    recording('cap-1')
    await rerender()
    expect(panel.contexts.at(-1)).toMatchObject({ onCallCaptureId: 'cap-1' })
    recording(null)
    await rerender()
    expect(panel.contexts.at(-1)?.onCallCaptureId).toBeUndefined()
  })

  it('a spoken ask goes to the live agent’s chat, with the transcript pushed first; never the panel', async () => {
    setClientWorkspaceId(WS)
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    recording('cap-1')
    await rerender()
    announce()
    const delivery = { text: 'what did they ask?', voiceAsk: {}, accept: vi.fn(), speaking: vi.fn(), settle: vi.fn(), onInterrupt: vi.fn() }
    await act(async () => {
      window.dispatchEvent(new CustomEvent(VOICE_ASK_EVENT, { detail: delivery }))
    })
    await flush()
    expect(delivery.accept).toHaveBeenCalled()
    expect(panel.asks).toEqual([])
    expect(sendToLiveChat).toHaveBeenCalledTimes(1)
    const [target, text, beforeSend] = sendToLiveChat.mock.calls[0] as [Record<string, unknown>, string, () => Promise<void>]
    expect(target).toEqual({ captureId: 'cap-1', conversationId: 'conv-live', agentId: 'rec-1', workspaceId: WS })
    expect(text).toBe('what did they ask?')
    await beforeSend()
    expect(flushTranscriptForAgent).toHaveBeenCalledWith('cap-1')
    expect(delivery.settle).toHaveBeenCalledWith('silent')
  })

  it('on desktop a spoken ask goes to the HUD window’s chat, never a store in this window', async () => {
    desktop.on = true
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    recording('cap-1')
    await rerender()
    announce()
    const delivery = { text: 'what did they ask?', voiceAsk: {}, accept: vi.fn(), speaking: vi.fn(), settle: vi.fn(), onInterrupt: vi.fn() }
    await act(async () => {
      window.dispatchEvent(new CustomEvent(VOICE_ASK_EVENT, { detail: delivery }))
    })
    await flush()
    expect(sendToLiveChat).not.toHaveBeenCalled()
    expect(desktop.asks).toEqual([{ captureId: 'cap-1', conversationId: 'conv-live', text: 'what did they ask?' }])
    expect(delivery.settle).toHaveBeenCalledWith('silent')
  })

  it('a spoken ask before the call’s conversation is open goes home', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    recording('cap-1')
    await rerender()
    const delivery = { text: 'what is next', voiceAsk: {}, accept: vi.fn(), speaking: vi.fn(), settle: vi.fn(), onInterrupt: vi.fn() }
    await act(async () => {
      window.dispatchEvent(new CustomEvent(VOICE_ASK_EVENT, { detail: delivery }))
    })
    await flush()
    expect(sendToLiveChat).not.toHaveBeenCalled()
    expect(panel.asks).toEqual(['what is next'])
  })
})

describe('the home thread on demand', () => {
  it('opening it with text sends that as the person’s message, with the cards it was about', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_HOME_THREAD_EVENT, { detail: { text: 'Draft the reply', cardIds: ['card-1'] } }))
    })
    await flush()
    expect(panel.loads).toEqual([])
    expect(panel.sends).toEqual([{ text: 'Draft the reply', cardIds: ['card-1'] }])
  })

  it('a chat on another conversation is put back on the home thread first', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    panel.conversationId = 'conv-other'
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_HOME_THREAD_EVENT, { detail: { text: 'hi' } }))
    })
    await flush()
    expect(panel.loads).toEqual([{ conversationId: 'home-1', ifUntouched: true }])
    expect(panel.sends).toEqual([{ text: 'hi' }])
  })

  it('a spoken ask goes to the home thread', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    const delivery = { text: 'what is next', voiceAsk: {}, accept: vi.fn(), speaking: vi.fn(), settle: vi.fn(), onInterrupt: vi.fn() }
    await act(async () => {
      window.dispatchEvent(new CustomEvent(VOICE_ASK_EVENT, { detail: delivery }))
    })
    await flush()
    expect(delivery.accept).toHaveBeenCalled()
    expect(panel.asks).toEqual(['what is next'])
  })

  it('a home thread gone from the server is forgotten and read afresh', async () => {
    const client = await import('@/lib/chat/home-thread-client')
    storeChat({ chatSessionId: 'sess-a', conversationId: 'conv-old' })
    panel.outcomes.push('missing')
    await mount()
    expect(vi.mocked(client.forgetHomeThreadId)).toHaveBeenCalledWith(WS)
    // Tried again: the second load took.
    expect(panel.loads).toHaveLength(2)
    expect(panel.conversationId).toBe('home-1')
  })

  it('a hand-off hears whether it went: sent, not sent, or another workspace’s', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    const handOff = async (detail: Parameters<typeof handOffToHome>[0]) => {
      let pending: Promise<unknown> = Promise.resolve()
      act(() => {
        pending = handOffToHome(detail)
      })
      await flush()
      return pending
    }
    expect(await handOff({ text: 'Draft the reply', cardIds: ['card-1'], workspaceId: WS })).toEqual({ ok: true })
    expect(panel.sends).toHaveLength(1)
    panel.sendResult = false
    expect(await handOff({ text: 'again', workspaceId: WS })).toEqual({ ok: false, reason: HOME_HANDOFF_REASONS.notSent })
    const before = panel.sends.length
    expect(await handOff({ text: 'for the other one', workspaceId: 'ws-other' })).toEqual({ ok: false, reason: HOME_HANDOFF_REASONS.otherWorkspace })
    expect(panel.sends).toHaveLength(before)
    // No home thread to be had: not opened.
    env.homeId = null
    panel.conversationId = 'conv-x'
    expect(await handOff({ text: 'x', workspaceId: WS })).toEqual({ ok: false, reason: HOME_HANDOFF_REASONS.notOpened })
  })
})

describe('the voice bird', () => {
  async function summon(wanted = () => true) {
    const results: boolean[] = []
    const take = vi.fn()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(VOICE_BIRD_EVENT, { detail: { action: 'start', take, wanted, onResult: (ok: boolean) => results.push(ok) } }),
      )
    })
    await flush()
    expect(take).toHaveBeenCalled()
    return results
  }

  it('starts voice mode in the chat as it is (no thread switch, no wait for a reply), and says it started', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    panel.conversationId = 'conv-other'
    panel.busy = true
    expect(await summon()).toEqual([true])
    expect(panel.loads).toEqual([])
    expect(panel.voice).toEqual(['start:conv-other'])
    expect(refusals).toEqual([])
  })

  it('a summon no longer wanted (sent away first) starts nothing', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    expect(await summon(() => false)).toEqual([false])
    expect(panel.voice).toEqual([])
  })

  it('a refusal toasts as the waveform’s does, and says it didn’t start', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    panel.voiceRefusal = { code: 'busy', detail: null }
    expect(await summon()).toEqual([false])
    expect(refusals).toEqual([{ code: 'busy', detail: null }])
  })

  it('end ends the chat’s voice mode', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(VOICE_BIRD_EVENT, { detail: { action: 'end' } }))
    })
    expect(panel.voice).toEqual(['end'])
  })
})

describe('a banner about a home-thread message (lib/chat/home-message.ts)', () => {
  // PROD 2026-10-31: the chat was on the home thread already, so a click only
  // "showed" it: nothing happened, and the message it had missed stayed missing.
  it('a click opens the home thread on its message, even when the chat is on it already', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_HOME_THREAD_EVENT, { detail: { reveal: { messageId: 'home-turn:1' } } }))
    })
    await flush()
    expect(panel.loads).toEqual([])
    expect(panel.reveals).toEqual(['home-turn:1'])
    expect(panel.sends).toEqual([])
  })

  it('a click with the chat on another conversation puts it back on the home thread first', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    panel.conversationId = 'conv-other'
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_HOME_THREAD_EVENT, { detail: { reveal: { messageId: null } } }))
    })
    await flush()
    expect(panel.loads).toEqual([{ conversationId: 'home-1', ifUntouched: true }])
    expect(panel.reveals).toEqual([null])
  })

  it('its arrival: the chat on that thread reads it in', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HOME_MESSAGE_EVENT, { detail: { workspaceId: WS, conversationId: 'home-1', messageId: 'home-turn:1' } }))
    })
    await flush()
    expect(panel.catchUps).toEqual(['home-turn:1'])
    expect(panel.reveals).toEqual([])
  })

  it('its arrival asks nothing of a chat on another conversation, or in another workspace', async () => {
    storeChat({ chatSessionId: 'sess-a', conversationId: 'home-1' })
    await mount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HOME_MESSAGE_EVENT, { detail: { workspaceId: 'ws-other', conversationId: 'home-1', messageId: 'home-turn:1' } }))
      window.dispatchEvent(new CustomEvent(HOME_MESSAGE_EVENT, { detail: { workspaceId: WS, conversationId: 'conv-other', messageId: 'home-turn:1' } }))
    })
    await flush()
    expect(panel.catchUps).toEqual([])
  })
})
