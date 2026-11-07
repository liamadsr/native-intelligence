// @vitest-environment jsdom
/**
 * A spoken ask during a desktop call goes to the HUD window (one-chat review
 * fix 1): the HUD's live chat store alone owns the call's eve session, so the
 * main window never builds a second one. Pinned:
 *   - askHudWindow hands the ask to the HUD (emitTo the agent-hud window) and
 *     resolves true once the HUD says `done`, false on `failed`, and false
 *     when no HUD takes it within HUD_ASK_ACCEPT_MS;
 *   - useSpokenAsks (the HUD's side) sends an ask for its call's conversation
 *     from its own store, telling `accepted` then `done`/`failed`, and fails
 *     one for another conversation without sending it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (e: { payload: unknown }) => void
const tauri = vi.hoisted(() => ({
  global: new Map<string, (e: { payload: unknown }) => void>(),
  window: new Map<string, (e: { payload: unknown }) => void>(),
  emitted: [] as Array<{ event: string; payload: unknown; target?: string }>,
  onEmitTo: null as null | ((target: string, event: string, payload: unknown) => void),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: Handler) => {
    tauri.global.set(event, cb)
    return () => tauri.global.delete(event)
  },
  emit: async (event: string, payload?: unknown) => {
    tauri.emitted.push({ event, payload })
  },
  emitTo: async (target: string, event: string, payload?: unknown) => {
    tauri.emitted.push({ event, payload, target })
    tauri.onEmitTo?.(target, event, payload)
  },
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    listen: async (event: string, cb: Handler) => {
      tauri.window.set(event, cb)
      return () => tauri.window.delete(event)
    },
  }),
}))
const sendToLiveChat = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock('@/components/live-chat/use-live-chat', () => ({ sendToLiveChat, BEFORE_SEND_CAP_MS: 1200 }))

import { askHudWindow, HUD_ASK_ACCEPT_MS } from '../hud-ask-client'
import { LIVE_HUD_ASKED_EVENT, LIVE_HUD_ASK_EVENT, type LiveHudConversation } from '../live-hud'
import { AGENT_HUD_WINDOW } from '../voice-id-hud'
import { useSpokenAsks } from '@/app/hud/agent/agent-hud'

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  tauri.global.clear()
  tauri.window.clear()
  tauri.emitted = []
  tauri.onEmitTo = null
  sendToLiveChat.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('askHudWindow (the main window)', () => {
  const ask = { captureId: 'cap-1', conversationId: 'conv-live', text: 'what did they ask?' }

  it('hands the ask to the HUD window and resolves true once its reply is in', async () => {
    tauri.onEmitTo = (_t, _e, payload) => {
      const id = (payload as { id: string }).id
      queueMicrotask(() => {
        tauri.global.get(LIVE_HUD_ASKED_EVENT)?.({ payload: { id, state: 'accepted' } })
        tauri.global.get(LIVE_HUD_ASKED_EVENT)?.({ payload: { id: 'someone-else', state: 'failed' } })
        tauri.global.get(LIVE_HUD_ASKED_EVENT)?.({ payload: { id, state: 'done' } })
      })
    }
    await expect(askHudWindow(ask)).resolves.toBe(true)
    const sent = tauri.emitted.find((e) => e.event === LIVE_HUD_ASK_EVENT)!
    expect(sent.target).toBe(AGENT_HUD_WINDOW)
    expect(sent.payload).toMatchObject(ask)
    // Stops listening once it's settled.
    expect(tauri.global.has(LIVE_HUD_ASKED_EVENT)).toBe(false)
  })

  it('false when the HUD says it failed', async () => {
    tauri.onEmitTo = (_t, _e, payload) => {
      const id = (payload as { id: string }).id
      queueMicrotask(() => tauri.global.get(LIVE_HUD_ASKED_EVENT)?.({ payload: { id, state: 'failed' } }))
    }
    await expect(askHudWindow(ask)).resolves.toBe(false)
  })

  it('false when no HUD takes it in time', async () => {
    vi.useFakeTimers()
    const result = askHudWindow(ask)
    await vi.advanceTimersByTimeAsync(HUD_ASK_ACCEPT_MS + 10)
    await expect(result).resolves.toBe(false)
  })
})

describe('useSpokenAsks (the HUD window)', () => {
  let container: HTMLDivElement
  let root: Root
  const conversation: LiveHudConversation = { captureId: 'cap-1', conversationId: 'conv-live', agentId: 'rec-1', workspaceId: 'ws-1' }
  const beforeSend = vi.fn(async () => {})

  function Probe({ conv }: { conv: LiveHudConversation | null }) {
    useSpokenAsks(conv, beforeSend)
    return null
  }

  beforeEach(async () => {
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(h(Probe, { conv: conversation })))
    await act(flush)
  })
  afterEach(() => {
    act(() => root.unmount())
  })

  const asked = () => tauri.emitted.filter((e) => e.event === LIVE_HUD_ASKED_EVENT).map((e) => e.payload)

  it('sends an ask for its call from its own store, and says accepted, then done', async () => {
    await act(async () => {
      tauri.window.get(LIVE_HUD_ASK_EVENT)!({ payload: { id: 'a1', captureId: 'cap-1', conversationId: 'conv-live', text: '  what did they ask?  ' } })
      await flush()
    })
    expect(sendToLiveChat).toHaveBeenCalledTimes(1)
    const [target, text, before] = sendToLiveChat.mock.calls[0] as [LiveHudConversation, string, () => Promise<void>]
    expect(target).toEqual(conversation)
    expect(text).toBe('what did they ask?')
    await before()
    expect(beforeSend).toHaveBeenCalled()
    expect(asked()).toEqual([
      { id: 'a1', state: 'accepted' },
      { id: 'a1', state: 'done' },
    ])
  })

  it('fails an ask for another conversation without sending it', async () => {
    await act(async () => {
      tauri.window.get(LIVE_HUD_ASK_EVENT)!({ payload: { id: 'a2', captureId: 'cap-0', conversationId: 'conv-old', text: 'hi' } })
      await flush()
    })
    expect(sendToLiveChat).not.toHaveBeenCalled()
    expect(asked()).toEqual([{ id: 'a2', state: 'failed' }])
  })
})
