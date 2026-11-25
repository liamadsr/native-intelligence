// @vitest-environment jsdom
/**
 * Home's current chat (current-chat-store.ts; docs/plans/one-home.md): the
 * one writer of which chat is on screen.
 *
 *   - its three kinds, from the two parts it stands on;
 *   - every way of moving it, and what each leaves behind;
 *   - the panels' mirror (side-panel-store.ts codeView / codeChat) never
 *     disagrees with it;
 *   - the screen it comes to, pinned for each of the states the Code view had
 *     before this store (phase 1 changed where the state lives, never what
 *     shows): the right panel on or off screen, which of its views, and
 *     whether home's panel lists the coding chats.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))

import {
  __resetCurrentChatForTests,
  backToAgent,
  currentChatKind,
  currentChatOf,
  getCurrentChat,
  isOnCode,
  newCodingChat,
  openCodingChat,
  setCurrentChat,
  showCoding,
  subscribeCurrentChat,
} from '../current-chat-store'
import { __resetCodeViewForTests, getCodeView } from '../code-view-store'
import {
  getSidePanelState,
  resetSidePanelStore,
  rightShown,
  setCodeDetailsOpen,
  setCodeForYouContent,
  setCodeForYouOpen,
  setForYouContent,
  setRightPanelOpen,
  setSidePanelView,
  shownView,
} from '../../side-panels/side-panel-store'

beforeEach(() => {
  localStorage.clear()
  resetSidePanelStore()
  __resetCodeViewForTests()
  __resetCurrentChatForTests()
})
afterEach(() => {
  __resetCurrentChatForTests()
  __resetCodeViewForTests()
  resetSidePanelStore()
})

describe('the three kinds', () => {
  it('the agent, a coding chat, a new coding chat', () => {
    expect(currentChatOf(false, null)).toEqual({ kind: 'agent' })
    // The coding chat the person was on is kept while they are on the agent: still the agent's chat.
    expect(currentChatOf(false, 's1')).toEqual({ kind: 'agent' })
    expect(currentChatOf(true, 's1')).toEqual({ kind: 'code', sessionId: 's1' })
    expect(currentChatOf(true, null)).toEqual({ kind: 'code-new' })
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
    openCodingChat('s2', { from: 'list' })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's2' })
    expect(getCodeView().selected).toBe('s2')
  })

  it('newCodingChat: nothing selected, the next send starts one', () => {
    openCodingChat('s1')
    newCodingChat()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
    expect(getCodeView().selected).toBeNull()
  })

  it('backToAgent, then the Code side again: the chat the person was on comes back', () => {
    openCodingChat('s1')
    backToAgent()
    expect(currentChatKind()).toBe('agent')
    expect(isOnCode()).toBe(false)
    showCoding()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's1' })
  })

  it('the Code side with no chat to come back to: a new one', () => {
    showCoding()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
  })

  it('setCurrentChat takes any of the three', () => {
    setCurrentChat({ kind: 'code', sessionId: 's9' })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 's9' })
    setCurrentChat({ kind: 'code-new' })
    expect(currentChatKind()).toBe('code-new')
    setCurrentChat({ kind: 'agent' })
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

describe('the panels’ mirror never disagrees', () => {
  const mirror = () => ({ codeView: getSidePanelState().codeView, codeChat: getSidePanelState().codeChat })

  it('follows every move', () => {
    expect(mirror()).toEqual({ codeView: false, codeChat: false })
    showCoding()
    expect(mirror()).toEqual({ codeView: true, codeChat: false })
    openCodingChat('s1')
    expect(mirror()).toEqual({ codeView: true, codeChat: true })
    newCodingChat()
    expect(mirror()).toEqual({ codeView: true, codeChat: false })
    openCodingChat('s1')
    backToAgent()
    // The chat is kept for the way back; the view is the agent's.
    expect(mirror()).toEqual({ codeView: false, codeChat: true })
    expect(currentChatKind()).toBe('agent')
  })
})

/**
 * What the screen comes to, for each state the Code view had before the
 * current chat's store: unchanged by phase 1.
 */
describe('the screen for each of the states the Code view had', () => {
  const screen = () => {
    const s = getSidePanelState()
    return {
      chat: currentChatKind(),
      // Home's panel lists the coding chats in place of Recent | Incoming (home-recents.tsx reads codeView).
      leftListsCodingChats: s.codeView,
      // The thread is hidden and the coding stage drawn (code-chat-stage.tsx reads codeView).
      middleIsCoding: s.codeView,
      rightOnScreen: rightShown(s),
      rightView: shownView(s),
    }
  }

  it('the agent’s chat, its panel closed', () => {
    expect(screen()).toEqual({ chat: 'agent', leftListsCodingChats: false, middleIsCoding: false, rightOnScreen: false, rightView: null })
  })

  it('the agent’s chat, its panel open on the sections', () => {
    setRightPanelOpen(true)
    expect(screen()).toEqual({ chat: 'agent', leftListsCodingChats: false, middleIsCoding: false, rightOnScreen: true, rightView: 'panel' })
  })

  it('the agent’s chat, its panel open on For you with cards', () => {
    setRightPanelOpen(true)
    setSidePanelView('forYou')
    setForYouContent(true)
    expect(screen()).toEqual({ chat: 'agent', leftListsCodingChats: false, middleIsCoding: false, rightOnScreen: true, rightView: 'forYou' })
  })

  it('Code with no chat: the list on the left, a clear middle, no right panel (the agent’s own stays as it was)', () => {
    setRightPanelOpen(true)
    showCoding()
    expect(screen()).toEqual({ chat: 'code-new', leftListsCodingChats: true, middleIsCoding: true, rightOnScreen: false, rightView: null })
    expect(getSidePanelState().rightOpen).toBe(true)
  })

  it('Code with a chat: its details on the right, open by default', () => {
    openCodingChat('s1')
    expect(screen()).toEqual({ chat: 'code', leftListsCodingChats: true, middleIsCoding: true, rightOnScreen: true, rightView: 'panel' })
  })

  it('Code with a chat, its details closed', () => {
    openCodingChat('s1')
    setCodeDetailsOpen(false)
    expect(screen()).toEqual({ chat: 'code', leftListsCodingChats: true, middleIsCoding: true, rightOnScreen: false, rightView: null })
  })

  it('Code with the Code view’s own For you open', () => {
    openCodingChat('s1')
    setCodeForYouContent(true)
    setCodeForYouOpen(true)
    expect(screen()).toEqual({ chat: 'code', leftListsCodingChats: true, middleIsCoding: true, rightOnScreen: true, rightView: 'forYou' })
  })

  it('back on the agent from a coding chat: everything as it was', () => {
    setRightPanelOpen(true)
    openCodingChat('s1')
    backToAgent()
    expect(screen()).toEqual({ chat: 'agent', leftListsCodingChats: false, middleIsCoding: false, rightOnScreen: true, rightView: 'panel' })
  })
})
