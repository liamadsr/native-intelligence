// @vitest-environment jsdom
/**
 * Home's current chat (current-chat-store.ts; docs/plans/one-home.md): the
 * one writer of which chat is on screen.
 *
 *   - its three kinds, from the two parts it stands on;
 *   - every way of moving it: a coding chat opened from anywhere, the
 *     toggle's Code side (always a new chat), back to the agent;
 *   - a coding chat takes the middle, so a full-screen card is put back;
 *   - this window's memory: a reload comes back on the chat it was on, per
 *     workspace; a new window opens on the agent; a chat that is gone is
 *     forgotten;
 *   - the agent's unseen reply, while the person is on another chat;
 *   - the panels' mirror (side-panel-store.ts codeView / codeChat) never
 *     disagrees with it, and what the right panel comes to for each kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ws = vi.hoisted(() => ({ id: 'ws-1' as string | null }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => ws.id }))

import {
  CURRENT_CHAT_KEY_PREFIX,
  __resetCurrentChatForTests,
  agentHasUnseenReply,
  backToAgent,
  chatKey,
  currentChatKind,
  currentChatOf,
  forgetCodingChat,
  getCurrentChat,
  isOnCode,
  newCodingChat,
  noteAgentReplied,
  openCodingChat,
  pressCode,
  setCurrentChat,
  subscribeCurrentChat,
  syncCurrentChatWorkspace,
} from '../current-chat-store'
import { CODE_PRESS_STARTS_NEW, RELOAD_RESTORES } from '../one-home-decisions'
import { __resetCodeViewForTests, getCodeView } from '../code-view-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import {
  getSidePanelState,
  resetSidePanelStore,
  rightShown,
  setCodeDetailsOpen,
  setForYouContent,
  setRightPanelOpen,
  setSidePanelView,
  shownView,
} from '../../side-panels/side-panel-store'

/** A reload: nothing in memory, the window's sessionStorage as it was. */
function reload() {
  resetSidePanelStore()
  __resetCodeViewForTests()
  __resetCurrentChatForTests()
}

beforeEach(() => {
  ws.id = 'ws-1'
  localStorage.clear()
  sessionStorage.clear()
  reload()
})
afterEach(() => {
  reload()
  sessionStorage.clear()
})

describe('the three kinds', () => {
  it('the agent, a coding chat, a new coding chat', () => {
    expect(currentChatOf(false, null)).toEqual({ kind: 'agent' })
    expect(currentChatOf(false, 's1')).toEqual({ kind: 'agent' })
    expect(currentChatOf(true, 's1')).toEqual({ kind: 'code', sessionId: 's1' })
    expect(currentChatOf(true, null)).toEqual({ kind: 'code-new' })
  })

  it('each has one key', () => {
    expect(chatKey({ kind: 'agent' })).toBe('agent')
    expect(chatKey({ kind: 'code-new' })).toBe('code-new')
    expect(chatKey({ kind: 'code', sessionId: 's1' })).toBe('code:s1')
  })

  it('starts on the agent, and its snapshot is stable between changes', () => {
    expect(getCurrentChat()).toEqual({ kind: 'agent' })
    expect(getCurrentChat()).toBe(getCurrentChat())
    openCodingChat('s1')
    const first = getCurrentChat()
    expect(first).toEqual({ kind: 'code', sessionId: 's1' })
    expect(getCurrentChat()).toBe(first)
  })
})

describe('moving it', () => {
  it('openCodingChat: that chat, from the agent or from another chat', () => {
    openCodingChat('s1', { from: 'recents' })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's1' })
    openCodingChat('s2', { from: 'recents' })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's2' })
    expect(getCodeView().selected).toBe('s2')
  })

  it('newCodingChat: nothing selected, the next send starts one', () => {
    openCodingChat('s1')
    newCodingChat()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
    expect(getCodeView().selected).toBeNull()
  })

  it('the toggle’s Code side always starts a new chat, whatever chat the person was on (decision 2)', () => {
    expect(CODE_PRESS_STARTS_NEW).toBe(true)
    pressCode()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
    openCodingChat('s1')
    backToAgent()
    expect(currentChatKind()).toBe('agent')
    expect(isOnCode()).toBe(false)
    pressCode()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
    // And from a coding chat itself.
    openCodingChat('s1')
    pressCode()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
  })

  it('setCurrentChat takes any of the three; a coding chat with no id is the agent', () => {
    setCurrentChat({ kind: 'code', sessionId: 's9' })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's9' })
    setCurrentChat({ kind: 'code-new' })
    expect(currentChatKind()).toBe('code-new')
    setCurrentChat({ kind: 'agent' })
    expect(currentChatKind()).toBe('agent')
    setCurrentChat({ kind: 'code', sessionId: '' })
    expect(currentChatKind()).toBe('agent')
  })

  it('an empty id opens nothing', () => {
    openCodingChat('')
    expect(currentChatKind()).toBe('agent')
  })

  it('a listener hears the kind change and the chat change, and nothing after it leaves', () => {
    const heard = vi.fn()
    const off = subscribeCurrentChat(heard)
    openCodingChat('s1')
    expect(heard).toHaveBeenCalled()
    heard.mockClear()
    openCodingChat('s2')
    expect(heard).toHaveBeenCalled()
    heard.mockClear()
    off()
    backToAgent()
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('a coding chat takes the middle', () => {
  const card = () => {
    const close = vi.fn()
    const release = holdFrontCard({ id: 'card-1', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: 'd1' } } as never, close })
    return { close, release }
  }

  it('opening one, or starting a new one, puts a full-screen card back: it would cover the conversation', () => {
    const a = card()
    openCodingChat('s1', { from: 'recents' })
    expect(a.close).toHaveBeenCalledTimes(1)
    a.release()
    const b = card()
    newCodingChat({ from: 'composer' })
    expect(b.close).toHaveBeenCalledTimes(1)
    b.release()
  })

  it('a restore (a reload, a workspace switch) leaves a card where it is: nothing the person pressed', () => {
    openCodingChat('s1')
    reload()
    const a = card()
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's1' })
    expect(a.close).not.toHaveBeenCalled()
    a.release()
  })
})

describe('this window’s memory (decision 5)', () => {
  const stored = (workspace = 'ws-1') => sessionStorage.getItem(`${CURRENT_CHAT_KEY_PREFIX}${workspace}`)

  it('a reload comes back on the chat this window was on', () => {
    expect(RELOAD_RESTORES).toBe('window')
    openCodingChat('s1')
    expect(stored()).toBe('s1')
    reload()
    expect(currentChatKind()).toBe('agent')
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's1' })
    expect(getSidePanelState().codeView).toBe(true)
  })

  it('a new coding chat comes back as one; the agent is remembered as nothing at all', () => {
    newCodingChat()
    expect(stored()).toBe('new')
    reload()
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
    backToAgent()
    expect(stored()).toBeNull()
    reload()
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
  })

  it('a new window opens on the agent: the memory is the window’s, never the device’s', () => {
    openCodingChat('s1')
    expect(localStorage.length).toBe(0)
    // Another window has its own sessionStorage: empty.
    sessionStorage.clear()
    reload()
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
  })

  it('placed once per workspace, never over a chat picked meanwhile', () => {
    openCodingChat('s1')
    reload()
    syncCurrentChatWorkspace()
    openCodingChat('s2')
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's2' })
  })

  it('a chat opened before the first placing (a link) stands: the memory never takes its place', () => {
    openCodingChat('s1')
    reload()
    openCodingChat('s-link', { from: 'link' })
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's-link' })
  })

  it('another workspace has its own: the switch never carries a chat across, nor forgets the one left behind', () => {
    syncCurrentChatWorkspace()
    openCodingChat('a')
    ws.id = 'ws-2'
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
    expect(getCodeView().selected).toBeNull()
    expect(stored('ws-1')).toBe('a')
    openCodingChat('b')
    ws.id = 'ws-1'
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 'a' })
    expect(stored('ws-2')).toBe('b')
  })

  it('ignores a stored value that is not an id', () => {
    sessionStorage.setItem(`${CURRENT_CHAT_KEY_PREFIX}ws-1`, '<script>')
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
  })

  it('a chat that is gone is no longer the one a reload comes back to; another chat’s going changes nothing', () => {
    openCodingChat('gone')
    forgetCodingChat('other')
    expect(stored()).toBe('gone')
    forgetCodingChat('gone')
    expect(stored()).toBeNull()
    reload()
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
  })

  it('the Code view’s old device memory is not read: the first load after the change opens on the agent', () => {
    localStorage.setItem('ni:code-view:selected:ws-1', 'old-chat')
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
    expect(getCodeView().selected).toBeNull()
  })
})

describe('the agent, while the person is on another chat', () => {
  it('a reply that finished is unseen until they are back; on the agent’s own chat it is never unseen', () => {
    noteAgentReplied()
    expect(agentHasUnseenReply()).toBe(false)
    openCodingChat('s1')
    const heard = vi.fn()
    const off = subscribeCurrentChat(heard)
    noteAgentReplied()
    expect(agentHasUnseenReply()).toBe(true)
    expect(heard).toHaveBeenCalled()
    // Another chat is still not the agent's.
    openCodingChat('s2')
    expect(agentHasUnseenReply()).toBe(true)
    backToAgent()
    expect(agentHasUnseenReply()).toBe(false)
    off()
  })
})

describe('the panels’ mirror never disagrees', () => {
  const mirror = () => ({ codeView: getSidePanelState().codeView, codeChat: getSidePanelState().codeChat })

  it('follows every move', () => {
    expect(mirror()).toEqual({ codeView: false, codeChat: false })
    pressCode()
    expect(mirror()).toEqual({ codeView: true, codeChat: false })
    openCodingChat('s1')
    expect(mirror()).toEqual({ codeView: true, codeChat: true })
    newCodingChat()
    expect(mirror()).toEqual({ codeView: true, codeChat: false })
    openCodingChat('s1')
    backToAgent()
    expect(mirror().codeView).toBe(false)
    expect(currentChatKind()).toBe('agent')
  })
})

describe('the right panel, for each current chat', () => {
  const right = () => {
    const s = getSidePanelState()
    return { chat: currentChatKind(), onScreen: rightShown(s), view: shownView(s) }
  }

  it('the agent’s chat: its own panel, closed, on its sections, or on For you with cards', () => {
    expect(right()).toEqual({ chat: 'agent', onScreen: false, view: null })
    setRightPanelOpen(true)
    expect(right()).toEqual({ chat: 'agent', onScreen: true, view: 'panel' })
    setSidePanelView('forYou')
    setForYouContent(true)
    expect(right()).toEqual({ chat: 'agent', onScreen: true, view: 'forYou' })
  })

  it('a new coding chat: nothing to show yet, and the agent’s own panel stays as it was for the way back', () => {
    setRightPanelOpen(true)
    pressCode()
    expect(right()).toEqual({ chat: 'code-new', onScreen: false, view: null })
    expect(getSidePanelState().rightOpen).toBe(true)
    backToAgent()
    expect(right()).toEqual({ chat: 'agent', onScreen: true, view: 'panel' })
  })

  it('a coding chat: its details, open by default, closed by their own switch', () => {
    openCodingChat('s1')
    expect(right()).toEqual({ chat: 'code', onScreen: true, view: 'panel' })
    setCodeDetailsOpen(false)
    expect(right()).toEqual({ chat: 'code', onScreen: false, view: null })
  })
})
