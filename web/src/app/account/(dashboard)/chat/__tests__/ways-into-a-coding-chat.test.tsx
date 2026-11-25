// @vitest-environment jsdom
/**
 * Every way into a coding chat lands in the same place (docs/plans/
 * one-home.md, "Every way in, and every way out"): Home's current chat
 * (current-chat-store.ts openCodingChat). Before, a coding job opened in
 * three different places depending on where it was pressed (the Code view, its
 * work item's card or its bot's page, a tab in its action's card), and
 * nothing at all from a job the agent started or from a link.
 *
 * One test per way, in and out. The ways covered beside their own surface:
 *   - a row in Recent, the pinned agent, the provisional row, a card over the
 *     chat: page-panel/__tests__/page-panel.test.tsx, open-recent-code.test.ts;
 *   - the composer's toggle and a job's line, with and without a Mac:
 *     composer-code.test.tsx;
 *   - "‹ Joseph": code-chat-stage.test.tsx;
 *   - a reload, a workspace switch: current-chat-store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ws = vi.hoisted(() => ({ id: 'ws-1' as string | null }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => ws.id }))
const cards = vi.hoisted(() => ({ opened: [] as unknown[] }))
vi.mock('@/lib/chat-cards/open-card', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-cards/open-card')>()),
  openTarget: (target: unknown, opts: unknown) => {
    cards.opened.push({ target, opts })
    return true
  },
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import {
  SWITCH_FOR_CODING_CHAT_EVENT,
  __resetCurrentChatForTests,
  backToAgent,
  cancelCodingChatSwitch,
  currentChatKind,
  getCurrentChat,
  newCodingChat,
  openCodingChat,
  syncCurrentChatWorkspace,
} from '../current-chat-store'
import { __resetCodeViewForTests } from '../code-chat-live'
import { AGENT_STARTED_CHAT_TAKES_THE_MIDDLE, HOME_PRESS_GOES_TO_AGENT } from '../one-home-decisions'
import { CODING_CHAT_DEEP_LINK, CODING_CHAT_LINK_WORKSPACE, codingChatLink, deepLinkCodingChat } from '../coding-chat-link'
import { DEEP_LINK_WORKSPACE, deepLinkCard } from '../../main-chat/main-chat-context'
import { resetSidePanelStore } from '../../side-panels/side-panel-store'
import { pressHome } from '../../rail/app-rail'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { openItem, type OpenTeammateNav, type OpenTeammateSource } from '@/lib/bots/open-teammate'
import { countByOwner, cardLookupRows } from '@/lib/work/agent-work-lanes'
import { Tool, startedCodingChat } from '@/components/prompt-kit/tool'
import { __resetInboxStoreForTests, inboxOpen } from '@/components/inbox/inbox-store'
import type { InboxItem } from '@/lib/inbox/items'

const SESSION = 'c0de0000-0000-4000-8000-0000000000c1'
const OTHER = 'c0de0000-0000-4000-8000-0000000000c2'
const ITEM = 'aaaaaaaa-0000-4000-8000-0000000000d1'
const WS2 = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  ws.id = 'ws-1'
  cards.opened.length = 0
  localStorage.clear()
  sessionStorage.clear()
  resetSidePanelStore()
  __resetCodeViewForTests()
  __resetCurrentChatForTests()
})
afterEach(() => {
  __resetCurrentChatForTests()
  __resetCodeViewForTests()
  resetSidePanelStore()
  vi.unstubAllGlobals()
})

// ── A work item pressed anywhere: a desktop notification, a For you card's Open, the Agents rows ──

describe('a coding chat’s work item, pressed anywhere (the shared opener)', () => {
  const turn = (over: Record<string, unknown> = {}) => ({
    id: ITEM,
    workspace_id: 'ws-1',
    member_id: 'm1',
    kind: 'local_agent',
    title: 'Fix the export',
    status: 'needs_review',
    ai_team_member_id: 'tm-coder',
    source: { local_agent_session_id: SESSION },
    ...over,
  })
  const source = (rows: unknown[]): OpenTeammateSource => ({ rows: rows as never, cardRows: [], cards: [], counts: countByOwner(rows as never, [], cardLookupRows(rows as never, [])) })
  const nav = (over: Partial<OpenTeammateNav> = {}) => {
    const n = {
      currentWorkspaceId: 'ws-1' as string | null,
      open: vi.fn(),
      openPage: vi.fn(() => true),
      openItemPage: vi.fn(() => true),
      openCodingChat: vi.fn((sessionId: string, workspaceId: string | null) => {
        openCodingChat(sessionId, { from: 'work-item', ...(workspaceId ? { workspaceId } : {}) })
        return true
      }),
      ...over,
    }
    return n as typeof n & OpenTeammateNav
  }

  it('a row the shared source holds: the chat itself, never its bot’s page or its card', () => {
    const n = nav()
    const outcome = openItem(ITEM, ['tm-coder'], source([turn()]), n)
    expect(outcome).toMatchObject({ kind: 'item', on: 'chat', codingSessionId: SESSION })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
    expect(n.openItemPage).not.toHaveBeenCalled()
    expect(n.open).not.toHaveBeenCalled()
  })

  it('a coding chat’s turn in another workspace: that workspace is asked for, the chat with it', () => {
    const n = nav()
    openItem(ITEM, [], source([turn({ workspace_id: WS2 })]), n)
    expect(n.openCodingChat).toHaveBeenCalledWith(SESSION, WS2)
  })

  it('work that is no coding chat opens as before: on its bot’s page, else its own card', () => {
    const n = nav()
    expect(openItem(ITEM, [], source([turn({ kind: 'work_run', source: {} })]), n)).toMatchObject({ on: 'bot-page' })
    expect(n.openCodingChat).not.toHaveBeenCalled()
    const noTeammate = nav()
    expect(openItem(ITEM, [], source([turn({ kind: 'work_run', source: {}, ai_team_member_id: null })]), noTeammate)).toMatchObject({ on: 'card' })
    expect(currentChatKind()).toBe('agent')
  })

  it('a settled item nothing on screen holds (a banner, a plain notice): one light read says it is a coding chat’s, and the chat opens', async () => {
    const n = nav({ lookup: vi.fn(async () => ({ workItemId: ITEM, workspaceId: 'ws-1', teammateId: 'tm-coder', title: 'Fix the export', codingSessionId: SESSION })) })
    // The banner knows its bot and its workspace, not whether this is a coding chat's turn: it is asked.
    const outcome = openItem(ITEM, [], source([]), n, { workspaceId: 'ws-1', title: 'Fix the export', teammateId: 'tm-coder' })
    expect(outcome.kind).toBe('looking')
    expect(await (outcome as { settled: Promise<unknown> }).settled).toMatchObject({ on: 'chat', codingSessionId: SESSION })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
    expect(n.openItemPage).not.toHaveBeenCalled()
  })

  it('a caller that holds the row says so itself: no read at all', () => {
    const n = nav({ lookup: vi.fn(async () => null) })
    expect(openItem(ITEM, [], source([]), n, { workspaceId: 'ws-1', title: 'A report', teammateId: 'tm-writer', codingSessionId: null })).toMatchObject({ on: 'bot-page' })
    expect(openItem(ITEM, [], source([]), n, { workspaceId: 'ws-1', title: 'Fix the export', teammateId: null, codingSessionId: SESSION })).toMatchObject({ on: 'chat' })
    expect(n.lookup).not.toHaveBeenCalled()
  })

  it('where there is no Home to show it (no opener for a chat), it opens as any item does', () => {
    const n = nav({ openCodingChat: undefined })
    expect(openItem(ITEM, [], source([turn()]), n)).toMatchObject({ on: 'bot-page' })
  })
})

// ── Incoming ──

describe('Incoming’s row for a coding chat that needs you, or failed', () => {
  const item = (id = ITEM): InboxItem =>
    ({
      key: `n:${id}`,
      source: 'notification',
      category: 'other',
      at: '2026-11-25T10:00:00.000Z',
      title: 'Fix the export needs you',
      body: null,
      unread: false,
      count: 1,
      notificationIds: [],
      actor: null,
      open: { kind: 'record', type: 'work_item', id },
      type: 'work_needs_you',
      row: { type: 'work_needs_you', title: 'Fix the export needs you', body: null, target_type: 'work_item', target_id: id, context_type: null, context_id: null, workspace_id: 'ws-1', metadata: {} },
    }) as unknown as InboxItem
  const facts = (over: Record<string, unknown>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes(`/api/account/activity/${ITEM}?light=1`)) return new Response(JSON.stringify({ item: { id: ITEM, workspace_id: 'ws-1', ai_team_member_id: null, kind: 'local_agent', title: 'Fix the export', ...over } }), { status: 200 })
        return new Response('{}', { status: 200 })
      }),
    )

  beforeEach(() => __resetInboxStoreForTests())

  it('opens the chat itself, as Home’s current chat: no work item card', async () => {
    facts({ local_agent_session_id: SESSION })
    await inboxOpen(item())
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
    expect(cards.opened).toEqual([])
  })

  it('other work’s row still opens its own card, flipped', async () => {
    facts({ kind: 'work_run', local_agent_session_id: null })
    await inboxOpen(item())
    expect(currentChatKind()).toBe('agent')
    expect(cards.opened).toEqual([{ target: { type: 'work_item', id: ITEM, title: 'Fix the export needs you' }, opts: { from: 'inbox', flip: true } }])
  })

  it('a read that fails opens the card, as before: a press is never a no-op', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await inboxOpen(item())
    expect(cards.opened).toHaveLength(1)
  })
})

// ── A coding chat the agent started itself ──

describe('a coding chat the agent started (its tool chip)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const chip = () => container.querySelector<HTMLButtonElement>('[data-tool-open-coding-chat]')

  it('names the chat a finished start gave; nothing for a running or failed call, another tool, or a result naming none', () => {
    expect(startedCodingChat('start_local_agent', 'result', { status: 'queued', session_id: SESSION })).toBe(SESSION)
    expect(startedCodingChat('start_local_agent', 'result', JSON.stringify({ session_id: SESSION }))).toBe(SESSION)
    // Refused because one already works in that folder: that one is the chat to open.
    expect(startedCodingChat('start_local_agent', 'result', { error: 'busy', busy: { session_id: OTHER } })).toBe(OTHER)
    expect(startedCodingChat('start_local_agent', 'call', { session_id: SESSION })).toBeNull()
    expect(startedCodingChat('start_local_agent', 'error', { session_id: SESSION })).toBeNull()
    expect(startedCodingChat('message_local_agent', 'result', { session_id: SESSION })).toBeNull()
    expect(startedCodingChat('start_local_agent', 'result', { session_id: 'not-an-id' })).toBeNull()
    expect(startedCodingChat('start_local_agent', 'result', 'not json')).toBeNull()
    expect(startedCodingChat('start_local_agent', 'result', null)).toBeNull()
  })

  it('never takes the middle by itself (decision 7): the chip offers Open, and the press opens the chat', async () => {
    expect(AGENT_STARTED_CHAT_TAKES_THE_MIDDLE).toBe(false)
    await act(async () => root.render(h(Tool, { name: 'start_local_agent', state: 'result', result: { status: 'queued', session_id: SESSION } })))
    // Drawn, and the person is still in their agent's chat.
    expect(currentChatKind()).toBe('agent')
    expect(chip()!.textContent).toContain('Open chat')
    act(() => chip()!.click())
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
  })

  it('no Open while it runs', async () => {
    await act(async () => root.render(h(Tool, { name: 'start_local_agent', state: 'call', args: { request: 'Fix it' } })))
    expect(chip()).toBeNull()
  })
})

// ── A link ──

describe('a link to a coding chat (`/account?code=<session id>`)', () => {
  it('names the chat, and its workspace when it has one; ids only', () => {
    expect(deepLinkCodingChat(new URLSearchParams(`code=${SESSION}`))).toEqual({ sessionId: SESSION, workspaceId: null })
    expect(deepLinkCodingChat(new URLSearchParams(`code=${SESSION}&workspace=${WS2}`))).toEqual({ sessionId: SESSION, workspaceId: WS2 })
    expect(deepLinkCodingChat(new URLSearchParams(`code=${SESSION}&workspace=nope`))).toEqual({ sessionId: SESSION, workspaceId: null })
    expect(deepLinkCodingChat(new URLSearchParams('code=../../etc'))).toBeNull()
    expect(deepLinkCodingChat(new URLSearchParams('code='))).toBeNull()
    expect(deepLinkCodingChat(new URLSearchParams('document=abc'))).toBeNull()
  })

  it('the link a chat’s details copy reads back as that chat, and is no card’s link', () => {
    const link = codingChatLink('https://app.example', SESSION, WS2)
    expect(link).toBe(`https://app.example/account?code=${SESSION}&workspace=${WS2}`)
    const params = new URL(link).searchParams
    expect(deepLinkCodingChat(params)).toEqual({ sessionId: SESSION, workspaceId: WS2 })
    expect(deepLinkCard(params)).toBeNull()
    expect(codingChatLink('https://app.example', SESSION, null)).toBe(`https://app.example/account?code=${SESSION}`)
    // The workspace's parameter is the other deep links' own.
    expect(CODING_CHAT_LINK_WORKSPACE).toBe(DEEP_LINK_WORKSPACE)
    expect(CODING_CHAT_DEEP_LINK).toBe('code')
  })
})

// ── Another workspace's chat ──

describe('a coding chat of another workspace', () => {
  it('asks the dashboard to switch there, and is that workspace’s current chat when it arrives; nothing moves here', () => {
    const asked: unknown[] = []
    const onSwitch = (e: Event) => asked.push((e as CustomEvent).detail)
    window.addEventListener(SWITCH_FOR_CODING_CHAT_EVENT, onSwitch)
    syncCurrentChatWorkspace()
    openCodingChat(SESSION, { from: 'notification', workspaceId: WS2 })
    expect(asked).toEqual([{ workspaceId: WS2 }])
    expect(currentChatKind()).toBe('agent')
    // The switch lands.
    ws.id = WS2
    syncCurrentChatWorkspace()
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
    window.removeEventListener(SWITCH_FOR_CODING_CHAT_EVENT, onSwitch)
  })

  it('a refused switch opens nothing, then or later', () => {
    syncCurrentChatWorkspace()
    openCodingChat(SESSION, { from: 'notification', workspaceId: WS2 })
    cancelCodingChatSwitch(WS2)
    ws.id = WS2
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
  })

  it('a switch that went elsewhere drops it: it never opens in a workspace it is not of', () => {
    syncCurrentChatWorkspace()
    openCodingChat(SESSION, { from: 'notification', workspaceId: WS2 })
    ws.id = 'ws-3'
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
    ws.id = WS2
    syncCurrentChatWorkspace()
    expect(currentChatKind()).toBe('agent')
  })

  it('the window’s own workspace named: opened in place, no switch', () => {
    const asked: unknown[] = []
    const onSwitch = (e: Event) => asked.push((e as CustomEvent).detail)
    window.addEventListener(SWITCH_FOR_CODING_CHAT_EVENT, onSwitch)
    openCodingChat(SESSION, { from: 'inbox', workspaceId: 'ws-1' })
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
    expect(asked).toEqual([])
    window.removeEventListener(SWITCH_FOR_CODING_CHAT_EVENT, onSwitch)
  })
})

// ── The rail's Home: a way out ──

describe('the rail’s Home button', () => {
  it('pressed on Home with nothing in front, from a coding chat or a new one: back to the agent (decision 6)', () => {
    expect(HOME_PRESS_GOES_TO_AGENT).toBe(true)
    openCodingChat(SESSION)
    pressHome()
    expect(currentChatKind()).toBe('agent')
    newCodingChat()
    pressHome()
    expect(currentChatKind()).toBe('agent')
  })

  it('with a page in front it puts the page back, as before, and the chat under it stays the current one', () => {
    openCodingChat(SESSION)
    const close = vi.fn()
    const release = holdFrontCard({ id: 'card-1', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: 'd1' } } as never, close })
    pressHome()
    expect(close).toHaveBeenCalledTimes(1)
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: SESSION })
    release()
    backToAgent()
  })
})
