// @vitest-environment jsdom
/**
 * Sign-out wipe vs the main chat's storage (DEPLOY BLOCKER this pins).
 *
 * Clicking Sign out calls beginPersistedTabStateWipe() and then navigates to
 * /sign-out. That navigation fires MainChatProvider's PAGEHIDE flush — which
 * writes the chat's live thread. Without the wipe flag, the flush ran AFTER
 * the key removal and resurrected the previous user's conversation for the
 * next person on a shared device. The pin: the wipe takes the main chat's keys
 * (`ni-chat:*`, the last-workspace pointer included) with the rest of the
 * per-user state, and once it starts every writer (the pagehide flush, the
 * workspace-switch write) is disarmed for the rest of the page load.
 *
 * NOTE the wipe flag is module state and this file deliberately holds ONE test:
 * a second test in the same module registry would inherit the armed flag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE_ID = 'ws-1'

vi.mock('@/app/account/workspace-switcher', () => ({
  useSwitchWorkspace: () => () => false,
  useWorkspaceId: () => WORKSPACE_ID,
}))

import { MainChatProvider, useRegisterChatFlush, useMainChat } from '../main-chat-context'
import { beginPersistedTabStateWipe, isTabStateWipeActive } from '../state-wipe'

let container: HTMLDivElement
let root: Root
let sessionId: string | null = null

/** Stands in for the panel: its live thread, a private one. */
function Panel() {
  const { chat, hydrated } = useMainChat()
  sessionId = hydrated ? chat.chatSessionId : null
  useRegisterChatFlush(chat.chatSessionId, () => ({
    chatSessionId: chat.chatSessionId,
    chatMessages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'private thread' }] }] as never,
    chatInput: 'half-typed secret',
    conversationId: 'home-1',
  }))
  return null
}

/** Every localStorage key the sign-out wipe owns. */
const userKeys = () =>
  Object.keys(localStorage).filter(
    (k) =>
      k.startsWith('ni-chat:') ||
      k.startsWith('ni-tabs') ||
      k === 'ni:bots:cast' ||
      k.startsWith('ni:bots:bubble') ||
      k.startsWith('ni:bots:seen') ||
      k === 'ni:agent-look' ||
      k === 'ni:voice:assistant-name' ||
      k === 'ni:rail-pages',
  )

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('beginPersistedTabStateWipe — sign-out wipe survives the pagehide flush', () => {
  it('removes the main chat’s keys (and every other per-user key), and the pagehide flush cannot write them back', () => {
    act(() => {
      root.render(h(MainChatProvider, null, h(Panel)))
    })
    // The chat's live thread written, as a reload would.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(localStorage.getItem(`ni-chat:${WORKSPACE_ID}`)).toContain('private thread')
    expect(localStorage.getItem('ni-chat:last-workspace')).toBe(WORKSPACE_ID)
    // The in-app browser's saved tabs live under ni-tabs (browser-session.tsx).
    localStorage.setItem('ni-tabs-browser', JSON.stringify([]))
    // What the retired bot crew left: its published cast.
    localStorage.setItem('ni:bots:cast', JSON.stringify({ userId: 'user-1', faces: [{ type: 'research' }] }))
    // The retired desktop overlay's bubble, both ways.
    localStorage.setItem('ni:bots:bubble:user-1', JSON.stringify({ v: 1, userId: 'user-1', at: 1, done: [], open: null, content: null }))
    localStorage.setItem('ni:bots:bubble-action:user-1', JSON.stringify({ actions: [] }))
    // When this device last saw the bots (the retired crew's jumps).
    localStorage.setItem('ni:bots:seen:user-1', '1759309200000')
    // This device's copy of the agent's look and name (the account keeps the real ones).
    localStorage.setItem('ni:agent-look', JSON.stringify({ type: 'cat', glasses: 'none', hat: 'none', headphones: false, bowTie: false }))
    localStorage.setItem('ni:voice:assistant-name', JSON.stringify('Ada'))
    // This device's copy of the app rail's bar (the account keeps the real one).
    localStorage.setItem('ni:rail-pages', JSON.stringify({ order: ['mail', 'docs'], hidden: ['deals'] }))
    expect(userKeys().length).toBeGreaterThanOrEqual(9)
    expect(isTabStateWipeActive()).toBe(false)

    beginPersistedTabStateWipe()

    expect(isTabStateWipeActive()).toBe(true)
    expect(userKeys()).toEqual([])

    // The killer path: the /sign-out navigation's pagehide flush, which would
    // write the chat's thread straight back.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(userKeys()).toEqual([])
  })
})
