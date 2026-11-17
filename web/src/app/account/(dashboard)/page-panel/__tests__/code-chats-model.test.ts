// @vitest-environment jsdom
/**
 * The Code view's list (code-chats-model.ts) and its flag (side-panel-store.ts
 * codeView): the person's Code jobs newest first, and the agent's right panel
 * off screen while the composer is on Code.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { PanelSession } from '@/components/local-agent/session-api'
import { codeChatTitle, codeChatsOf } from '../code-chats-model'
import { groupCodeChats } from '../code-chats'
import { getSidePanelState, rightShown, setCodeDetailsOpen, setCodeView, toggleRightPanel } from '../../side-panels/side-panel-store'
import { vi } from 'vitest'
import { SELECTED_KEY_PREFIX, __resetCodeViewForTests, getCodeView, selectCodeChat, setCodeChatError, setCodeChatLive, syncCodeViewWorkspace } from '../../chat/code-view-store'

let workspace = 'ws-1'
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => workspace }))

const session = (over: Partial<PanelSession> & { id: string }): PanelSession =>
  ({
    folderId: 'f1',
    folderLabel: 'web-app',
    deviceId: 'd1',
    deviceName: 'Studio Mac',
    conversationId: 'c1',
    mode: 'code',
    request: 'Fix the login redirect',
    status: 'waiting',
    lastSignal: null,
    lastSignalText: null,
    branch: null,
    commitSha: null,
    error: null,
    trackedJobId: 'w1',
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:05:00.000Z',
    endedAt: null,
    lastDeviceSeq: null,
    codeRequestId: `req-${over.id}`,
    ...over,
  }) as PanelSession

describe('codeChatsOf', () => {
  it('keeps the Code jobs only (a send’s request id), newest first by when they last moved', () => {
    const items = codeChatsOf([
      session({ id: 'a', updatedAt: '2026-11-16T10:05:00.000Z' }),
      session({ id: 'b', updatedAt: '2026-11-16T12:00:00.000Z', request: 'Add a dark theme\n\nwith details' }),
      // Started by the agent, not from the Code tab: not a coding chat.
      session({ id: 'c', codeRequestId: undefined, updatedAt: '2026-11-16T13:00:00.000Z' }),
    ])
    expect(items.map((i) => i.key)).toEqual(['b', 'a'])
    expect(items[0]).toMatchObject({ title: 'Add a dark theme', folder: 'web-app', workItemId: 'w1' })
  })

  it('says which work now and which wait on the person’s answer', () => {
    const [asking, working, done] = codeChatsOf([
      session({ id: 'a', status: 'waiting', lastSignal: 'ask', updatedAt: '2026-11-16T12:00:00.000Z' }),
      session({ id: 'b', status: 'running', updatedAt: '2026-11-16T11:00:00.000Z' }),
      session({ id: 'c', status: 'cancelled', lastSignal: 'ask', updatedAt: '2026-11-16T10:00:00.000Z' }),
    ])
    expect(asking).toMatchObject({ needsYou: true, working: false })
    expect(working).toMatchObject({ needsYou: false, working: true })
    // Ended: nothing waits on anyone.
    expect(done).toMatchObject({ needsYou: false, working: false })
  })

  it('titles a chat by the request’s first line, cut to one short line', () => {
    expect(codeChatTitle('\n  Fix   the\tbug  \nmore')).toBe('Fix the bug')
    expect(codeChatTitle('')).toBe('Untitled')
    expect(codeChatTitle('x'.repeat(300)).length).toBe(120)
  })

  it('groups under the recents’ sections, newest section first', () => {
    const now = new Date('2026-11-16T15:00:00')
    const items = codeChatsOf([
      session({ id: 'a', updatedAt: new Date('2026-11-16T14:00:00').toISOString() }),
      session({ id: 'b', updatedAt: new Date('2026-11-15T14:00:00').toISOString() }),
    ])
    expect(groupCodeChats(items, now).map((g) => [g.key, g.items.map((i) => i.key)])).toEqual([
      ['afternoon', ['a']],
      ['yesterday', ['b']],
    ])
  })
})

describe('the Code view’s flag', () => {
  afterEach(() => {
    setCodeView(false)
    __resetCodeViewForTests()
    selectCodeChat(null)
    window.localStorage.clear()
  })

  it('shows the selected coding chat’s details by their own switch, never the agent’s panel’s', () => {
    const agentOpen = { rightOpen: true, view: 'panel' as const, forYouContent: false }
    expect(rightShown(agentOpen)).toBe(true)
    // On Code with no chat selected: nothing to show, whatever the agent's panel was.
    expect(rightShown({ ...agentOpen, codeView: true })).toBe(false)
    // A chat selected: its details, with the agent's panel open or closed, on any view of it.
    expect(rightShown({ ...agentOpen, codeView: true, codeChat: true })).toBe(true)
    expect(rightShown({ rightOpen: false, view: 'forYou', forYouContent: false, codeView: true, codeChat: true })).toBe(true)
    // Closed by their own switch.
    expect(rightShown({ ...agentOpen, codeView: true, codeChat: true, codeDetailsOpen: false })).toBe(false)
  })

  it('closing the details on Code leaves the agent’s panel as it was; ⌘\\ with no chat selected does nothing', () => {
    const before = getSidePanelState().rightOpen
    setCodeView(true)
    expect(getSidePanelState().codeView).toBe(true)
    // No chat selected: nothing flips.
    toggleRightPanel()
    expect(getSidePanelState().codeDetailsOpen).toBe(true)
    expect(getSidePanelState().rightOpen).toBe(before)
    selectCodeChat('a')
    toggleRightPanel()
    expect(getSidePanelState().codeDetailsOpen).toBe(false)
    expect(getSidePanelState().rightOpen).toBe(before)
    expect(rightShown(getSidePanelState())).toBe(false)
    setCodeDetailsOpen(true)
    expect(rightShown(getSidePanelState())).toBe(true)
    setCodeView(false)
    expect(getSidePanelState().rightOpen).toBe(before)
  })
})

describe('the Code view’s selected chat (code-view-store.ts)', () => {
  afterEach(() => __resetCodeViewForTests())

  it('selects a chat, holds what its conversation reads for it only, and clears with New chat', () => {
    const live = { session: session({ id: 'a' }), stopping: false, send: async () => ({ ok: true as const }), stop: async () => ({ ok: true as const }) }
    selectCodeChat('a')
    expect(getCodeView()).toEqual({ selected: 'a', live: null, error: null, attempt: 0 })
    expect(getSidePanelState().codeChat).toBe(true)
    // Another chat's reader reporting late changes nothing.
    setCodeChatLive('b', live)
    expect(getCodeView().live).toBeNull()
    setCodeChatLive('a', live)
    expect(getCodeView().live).toBe(live)
    // Another chat: its own read, from nothing.
    selectCodeChat('b')
    expect(getCodeView()).toEqual({ selected: 'b', live: null, error: null, attempt: 0 })
    selectCodeChat(null)
    expect(getCodeView().selected).toBeNull()
    expect(getSidePanelState().codeChat).toBe(false)
  })
})

describe('the selected chat is remembered per workspace', () => {
  afterEach(() => {
    __resetCodeViewForTests()
    window.localStorage.clear()
    workspace = 'ws-1'
  })

  it('comes back after a reload, once, and never over a chat picked meanwhile', () => {
    selectCodeChat('a')
    expect(window.localStorage.getItem(`${SELECTED_KEY_PREFIX}ws-1`)).toBe('a')
    // A reload: nothing in memory.
    __resetCodeViewForTests()
    expect(getCodeView().selected).toBeNull()
    syncCodeViewWorkspace()
    expect(getCodeView().selected).toBe('a')
    expect(getSidePanelState().codeChat).toBe(true)
    // New chat clears it for good.
    selectCodeChat(null)
    expect(window.localStorage.getItem(`${SELECTED_KEY_PREFIX}ws-1`)).toBeNull()
    syncCodeViewWorkspace()
    expect(getCodeView().selected).toBeNull()
  })

  it('another workspace has its own: the switch never carries a chat across, nor forgets the one left behind', () => {
    syncCodeViewWorkspace()
    selectCodeChat('a')
    workspace = 'ws-2'
    syncCodeViewWorkspace()
    expect(getCodeView().selected).toBeNull()
    expect(window.localStorage.getItem(`${SELECTED_KEY_PREFIX}ws-1`)).toBe('a')
    selectCodeChat('b')
    workspace = 'ws-1'
    syncCodeViewWorkspace()
    expect(getCodeView().selected).toBe('a')
  })

  it('ignores a stored value that is not an id', () => {
    window.localStorage.setItem(`${SELECTED_KEY_PREFIX}ws-1`, '<script>')
    syncCodeViewWorkspace()
    expect(getCodeView().selected).toBeNull()
  })
})

describe('a chat that cannot be read', () => {
  afterEach(() => {
    __resetCodeViewForTests()
    window.localStorage.clear()
  })

  it('a read that only failed keeps it remembered, and picking it again reads it again', () => {
    selectCodeChat('a')
    setCodeChatError('a', 'Could not load this local agent.', false)
    expect(getCodeView()).toEqual({ selected: 'a', live: null, error: 'Could not load this local agent.', attempt: 0 })
    expect(window.localStorage.getItem(`${SELECTED_KEY_PREFIX}ws-1`)).toBe('a')
    selectCodeChat('a')
    expect(getCodeView()).toEqual({ selected: 'a', live: null, error: null, attempt: 1 })
    // Picked again with nothing wrong: nothing to do.
    const same = getCodeView()
    selectCodeChat('a')
    expect(getCodeView()).toBe(same)
  })

  it('gone: says so, and is no longer the chat a reload comes back to', () => {
    selectCodeChat('gone')
    setCodeChatError('other', 'nope', true)
    expect(getCodeView().error).toBeNull()
    setCodeChatError('gone', 'This local agent is no longer available.', true)
    expect(getCodeView()).toEqual({ selected: 'gone', live: null, error: 'This local agent is no longer available.', attempt: 0 })
    expect(window.localStorage.getItem(`${SELECTED_KEY_PREFIX}ws-1`)).toBeNull()
    // Another chat picked: the error goes with the old one.
    selectCodeChat('a')
    expect(getCodeView().error).toBeNull()
  })
})
