// @vitest-environment jsdom
/**
 * The person's coding chats as a list (code-chats-model.ts): newest first,
 * an action's job named by its action; and the current coding chat as its
 * conversation's reader holds it (code-chat-live.ts).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { PanelSession } from '@/components/local-agent/session-api'
import { codeChatTitle, codeChatsOf } from '../code-chats-model'
import { groupCodeChats } from '../code-chats'
import { vi } from 'vitest'
import { __resetCodeViewForTests, getCodeView, selectCodeChat, setCodeChatError, setCodeChatLive } from '../../chat/code-chat-live'

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))

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
  it('lists every coding job, newest first by when it last moved: the Code tab’s and any other (Liam, 11-20)', () => {
    const items = codeChatsOf([
      session({ id: 'a', updatedAt: '2026-11-16T10:05:00.000Z' }),
      session({ id: 'b', updatedAt: '2026-11-16T12:00:00.000Z', request: 'Add a dark theme\n\nwith details' }),
      // Started by the chat agent, not from the Code tab: listed too.
      session({ id: 'c', codeRequestId: undefined, updatedAt: '2026-11-16T13:00:00.000Z', request: 'Look into the flaky test' }),
    ])
    expect(items.map((i) => i.key)).toEqual(['c', 'b', 'a'])
    expect(items[1]).toMatchObject({ title: 'Add a dark theme', folder: 'web-app', workItemId: 'w1', action: null })
  })

  it('an action’s job goes by its action (identifier and title), never by the agent’s long brief', () => {
    const [job] = codeChatsOf([
      session({
        id: 'a',
        codeRequestId: undefined,
        request: '[From one of your actions] Work on the card below.\n\nTitle: Fix the board pagination…',
        actionId: 'act-1',
        action: { id: 'act-1', identifier: 'ENG-42', title: 'Fix the board pagination' },
      }),
    ])
    expect(job).toMatchObject({ title: 'Fix the board pagination', action: { id: 'act-1', identifier: 'ENG-42' } })
    // An action with no title goes by its identifier; one the list couldn't name, by the request.
    expect(codeChatsOf([session({ id: 'b', action: { id: 'x', identifier: 'ENG-7', title: '' } })])[0].title).toBe('ENG-7')
    expect(codeChatsOf([session({ id: 'c', actionId: 'gone', request: 'Do the thing' })])[0]).toMatchObject({ title: 'Do the thing', action: null })
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

describe('the current coding chat, live (code-chat-live.ts)', () => {
  afterEach(() => __resetCodeViewForTests())

  it('selects a chat, holds what its conversation reads for it only, and clears with New chat', () => {
    const live = { session: session({ id: 'a' }), stopping: false, send: async () => ({ ok: true as const }), stop: async () => ({ ok: true as const }) }
    selectCodeChat('a')
    expect(getCodeView()).toEqual({ selected: 'a', live: null, error: null, attempt: 0 })
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
  })
})

describe('a chat that cannot be read', () => {
  afterEach(() => {
    __resetCodeViewForTests()
    window.localStorage.clear()
  })

  it('a read that failed says so, and picking the chat again reads it again', () => {
    selectCodeChat('a')
    setCodeChatError('a', 'Could not load this local agent.')
    expect(getCodeView()).toEqual({ selected: 'a', live: null, error: 'Could not load this local agent.', attempt: 0 })
    selectCodeChat('a')
    expect(getCodeView()).toEqual({ selected: 'a', live: null, error: null, attempt: 1 })
    // Picked again with nothing wrong: nothing to do.
    const same = getCodeView()
    selectCodeChat('a')
    expect(getCodeView()).toBe(same)
  })

  it('gone: says so, for that chat only (what a reload comes back to is the current chat’s store’s: current-chat-store.test.ts)', () => {
    selectCodeChat('gone')
    setCodeChatError('other', 'nope')
    expect(getCodeView().error).toBeNull()
    setCodeChatError('gone', 'This local agent is no longer available.')
    expect(getCodeView()).toEqual({ selected: 'gone', live: null, error: 'This local agent is no longer available.', attempt: 0 })
    // Another chat picked: the error goes with the old one.
    selectCodeChat('a')
    expect(getCodeView().error).toBeNull()
  })
})
