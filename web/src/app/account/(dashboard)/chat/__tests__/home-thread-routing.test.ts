// @vitest-environment jsdom
/**
 * The home thread's client routing (A3; docs/plans/one-chat.md). Pins:
 *   - routeVoiceAskHome: a spoken ask goes to the home thread (accepted at
 *     once, the main chat put back on it first), except during a call, when
 *     it goes to the call's live agent's chat (one-chat Slice 3: Liam's
 *     decision 3), never the main chat; when the home thread can't be shown
 *     the chat as it is answers, and with no chat it fails;
 *   - the client helper: one request per workspace, cached; another
 *     workspace's answer or a failure isn't cached; openHomeThread fires the
 *     event the main chat handles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendToLiveChat = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true))
vi.mock('@/components/live-chat/use-live-chat', () => ({ sendToLiveChat }))

import { routeVoiceAskHome, type LiveVoiceAskTarget, type VoiceAskPanel } from '../route-voice-ask'
import type { VoiceAskDelivery } from '@/lib/voice/voice-ask-delivery'
import {
  HOME_HANDOFF_REASONS,
  handOffToHome,
  OPEN_HOME_THREAD_EVENT,
  fetchHomeThreadId,
  openHomeThread,
  parseOpenHomeThreadDetail,
  peekHomeThreadId,
  resetHomeThreadCacheForTests,
} from '@/lib/chat/home-thread-client'

function delivery() {
  return {
    text: 'what is next',
    voiceAsk: {} as never,
    accept: vi.fn(),
    speaking: vi.fn(),
    settle: vi.fn(),
    onInterrupt: vi.fn(),
  } satisfies VoiceAskDelivery
}
const panel = () => ({ askByVoice: vi.fn() }) satisfies VoiceAskPanel
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('routeVoiceAskHome', () => {
  it('puts the chat on the home thread and asks there, accepting at once', async () => {
    const d = delivery()
    const home = panel()
    const showHome = vi.fn(async () => home)
    routeVoiceAskHome(d, { panel: () => home, showHome })
    expect(d.accept).toHaveBeenCalledTimes(1)
    expect(showHome).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(home.askByVoice).toHaveBeenCalledWith(d)
  })

  it('has a taker before the panel is there: it waits for the home thread', async () => {
    const d = delivery()
    const home = panel()
    routeVoiceAskHome(d, { panel: () => null, showHome: async () => home })
    expect(d.accept).toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(home.askByVoice).toHaveBeenCalledWith(d)
  })

  it('during a call it goes to the live agent’s chat, never the main chat; settled once the reply is in', async () => {
    sendToLiveChat.mockClear()
    sendToLiveChat.mockResolvedValueOnce(true)
    const d = delivery()
    const main = panel()
    const showHome = vi.fn(async () => main)
    const beforeSend = vi.fn(async () => {})
    const call: LiveVoiceAskTarget = { captureId: 'cap-1', conversationId: 'conv-live', agentId: 'rec-1', workspaceId: 'ws-1', beforeSend }
    routeVoiceAskHome(d, { panel: () => main, showHome, liveCall: () => call })
    expect(d.accept).toHaveBeenCalledTimes(1)
    expect(sendToLiveChat).toHaveBeenCalledWith(
      { captureId: 'cap-1', conversationId: 'conv-live', agentId: 'rec-1', workspaceId: 'ws-1' },
      'what is next',
      beforeSend,
    )
    await flush()
    expect(d.settle).toHaveBeenCalledWith('silent')
    expect(showHome).not.toHaveBeenCalled()
    expect(main.askByVoice).not.toHaveBeenCalled()
  })

  it('a target that sends its own way (desktop: the HUD window) takes it instead of this window’s store', async () => {
    sendToLiveChat.mockClear()
    const d = delivery()
    const send = vi.fn(async (_t: string) => true)
    routeVoiceAskHome(d, {
      panel: () => null,
      showHome: async () => null,
      liveCall: () => ({ captureId: 'cap-1', conversationId: 'conv-live', agentId: null, workspaceId: null, send }),
    })
    await flush()
    expect(send).toHaveBeenCalledWith('what is next')
    expect(sendToLiveChat).not.toHaveBeenCalled()
    expect(d.settle).toHaveBeenCalledWith('silent')
  })

  it('a spoken ask that didn’t reach the live agent fails', async () => {
    sendToLiveChat.mockClear()
    sendToLiveChat.mockResolvedValueOnce(false)
    const d = delivery()
    routeVoiceAskHome(d, {
      panel: () => null,
      showHome: async () => null,
      liveCall: () => ({ captureId: 'cap-1', conversationId: 'conv-live', agentId: null, workspaceId: null }),
    })
    await flush()
    expect(d.settle).toHaveBeenCalledWith('failed')
  })

  it('with no call (or its conversation not open yet) it goes home', async () => {
    sendToLiveChat.mockClear()
    const d = delivery()
    const home = panel()
    routeVoiceAskHome(d, { panel: () => home, showHome: async () => home, liveCall: () => null })
    await flush()
    expect(sendToLiveChat).not.toHaveBeenCalled()
    expect(home.askByVoice).toHaveBeenCalledWith(d)
  })

  it('the chat as it is answers when the home thread can’t be shown, and with no chat it fails', async () => {
    const d = delivery()
    const onScreen = panel()
    routeVoiceAskHome(d, { panel: () => onScreen, showHome: async () => null })
    await Promise.resolve()
    await Promise.resolve()
    expect(onScreen.askByVoice).toHaveBeenCalledWith(d)
    const lost = delivery()
    routeVoiceAskHome(lost, { panel: () => null, showHome: async () => null })
    await Promise.resolve()
    await Promise.resolve()
    expect(lost.settle).toHaveBeenCalledWith('failed')
  })
})

describe('home-thread-client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    resetHomeThreadCacheForTests()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('one request per workspace, sent with its header, then cached', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ conversationId: 'home-1', workspaceId: 'ws-1' }) })
    const [a, b] = await Promise.all([fetchHomeThreadId('ws-1'), fetchHomeThreadId('ws-1')])
    expect([a, b]).toEqual(['home-1', 'home-1'])
    expect(await fetchHomeThreadId('ws-1')).toBe('home-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]).toEqual(['/api/account/chat-history/home', { method: 'POST', headers: { 'x-workspace-id': 'ws-1' } }])
    expect(peekHomeThreadId('ws-1')).toBe('home-1')
    expect(peekHomeThreadId('ws-2')).toBeNull()
  })

  it('another workspace’s answer, a failure or no workspace is null and not cached', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ conversationId: 'home-x', workspaceId: 'ws-other' }) })
    expect(await fetchHomeThreadId('ws-1')).toBeNull()
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    expect(await fetchHomeThreadId('ws-1')).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await fetchHomeThreadId('ws-1')).toBeNull()
    expect(await fetchHomeThreadId(null)).toBeNull()
    expect(peekHomeThreadId('ws-1')).toBeNull()
  })

  it('openHomeThread fires the event the strip handles', () => {
    const seen: unknown[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_HOME_THREAD_EVENT, on)
    openHomeThread()
    openHomeThread({ activate: false })
    openHomeThread({ text: '  Draft the reply  ', cardIds: ['card-1', 'card-1', 7 as never, 'card-2'] })
    openHomeThread({ cardIds: ['card-1'] })
    window.removeEventListener(OPEN_HOME_THREAD_EVENT, on)
    expect(seen.map((d) => {
      const { activate, text, cardIds } = parseOpenHomeThreadDetail(d)
      return { activate, text, cardIds }
    })).toEqual([
      { activate: true, text: null, cardIds: [] },
      { activate: false, text: null, cardIds: [] },
      { activate: true, text: 'Draft the reply', cardIds: ['card-1', 'card-2'] },
      // Cards ride a sent message only.
      { activate: true, text: null, cardIds: [] },
    ])
  })

  it('handOffToHome with no chat strip in the window says nothing was sent', async () => {
    expect(await handOffToHome({ text: 'hi' })).toEqual({ ok: false, reason: HOME_HANDOFF_REASONS.noStrip })
  })
})
