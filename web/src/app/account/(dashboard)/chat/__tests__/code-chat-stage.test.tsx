// @vitest-environment jsdom
/**
 * The Code view's middle (code-chat-stage.tsx): on Code the agent's thread
 * stops painting by the stage's own <style> (never the app's stylesheet),
 * with a chat selected or not, and the selected chat's conversation draws
 * without a box of its own. Its `finish` card is left out while the right
 * panel's Review card shows the job's record, and only then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakePanelProps = { sessionId: string; composer?: boolean; header?: boolean; hideFinish?: boolean }
const panel = vi.fn((props: FakePanelProps) =>
  h('div', { 'data-fake-panel': props.sessionId, 'data-composer': String(props.composer), 'data-header': String(props.header), 'data-hide-finish': String(props.hideFinish) }),
)
vi.mock('@/components/local-agent/local-agent-panel', () => ({ LocalAgentPanel: (props: FakePanelProps) => panel(props) }))
const shell = { shared: {} as object | null }
vi.mock('@/components/work/agent-work-provider', () => ({ useOptionalAgentWorkShared: () => shell.shared }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
const chats = { items: [] as Array<Record<string, unknown>>, readAt: null as Date | null }
vi.mock('../../page-panel/code-chats', () => ({
  useCodeChats: () => chats,
  CodeChatsRows: ({ items }: { items: unknown[] }) => h('div', { 'data-fake-rows': items.length }),
}))
vi.mock('../../side-panels/side-panels', async () => {
  const React = await import('react')
  const store = await import('../../side-panels/side-panel-store')
  return { useSidePanelState: () => React.useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getSidePanelState) }
})

import { CodeChatStage } from '../code-chat-stage'
import { __resetCodeViewForTests, selectCodeChat, setCodeChatLive, type CodeChatLive } from '../code-chat-live'
import { FIRST_TIME_KEY, FIRST_TIME_LINE } from '../one-home-decisions'
import { __resetCurrentChatForTests, backToAgent, currentChatKind, isOnCode, newCodingChat, openCodingChat, subscribeCurrentChat } from '../current-chat-store'
import { RECENTS_FILTER_KEY } from '../../page-panel/use-recents-filter'
import { setCodeDetailsOpen, setPagePanelShown, setRightPanelOpen } from '../../side-panels/side-panel-store'
import { hiddenThreadProps } from '../thread-hidden'
import { useSyncExternalStore } from 'react'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  // The first-time line was dismissed on this device (its own tests say otherwise).
  window.localStorage.setItem(FIRST_TIME_KEY, '1')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => {
    setPagePanelShown(false)
    setRightPanelOpen(false)
    __resetCodeViewForTests()
    __resetCurrentChatForTests()
  })
  window.localStorage.clear()
  // The window's memory of its current chat (current-chat-store.ts): the next test starts on the agent.
  window.sessionStorage.clear()
  chats.items = []
  chats.readAt = null
  shell.shared = {}
})

/** The conversation's reader has read the chat: its turn's record named, or none yet. */
function readChat(trackedJobId: string | null) {
  const live = {
    session: { id: 'sess-1', trackedJobId },
    stopping: false,
    send: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
  } as unknown as CodeChatLive
  act(() => setCodeChatLive('sess-1', live))
}

describe('CodeChatStage', () => {
  it('is nothing on the agent’s tab, even with a chat selected', () => {
    act(() => {
      openCodingChat('sess-1')
      backToAgent()
    })
    act(() => root.render(h(CodeChatStage)))
    expect(container.innerHTML).toBe('')
  })

  /**
   * The thread and the coding chat as chat-panel.tsx draws them: the thread's
   * own element wearing hiddenThreadProps from the same read of Home's
   * current chat that the stage draws by.
   */
  function ThreadAndStage() {
    const codingChatUp = useSyncExternalStore(subscribeCurrentChat, isOnCode, () => false)
    return h('div', { 'data-chat-thread-stage': '' }, h(CodeChatStage), h('div', { 'data-thread': '', ...hiddenThreadProps(codingChatUp) }, 'the agent’s thread'))
  }
  const thread = () => container.querySelector<HTMLElement>('[data-thread]')!
  const threadOut = () => thread().hasAttribute('inert') && thread().style.visibility === 'hidden' && thread().style.opacity === '0' && thread().getAttribute('aria-hidden') === 'true'

  // Liam, 11-16: "the main chat and the agents chats are showing at the same time" must never happen.
  it('the agent’s thread is out of sight and reach whenever a coding chat stands in its place, in the same render, and back with the agent', () => {
    act(() => root.render(h(ThreadAndStage)))
    expect(threadOut()).toBe(false)
    expect(thread().getAttribute('style')).toBeNull()
    // A coding chat: its conversation is in the document, and in that same commit the thread is inert and hidden.
    act(() => openCodingChat('sess-1'))
    expect(container.querySelector('[data-code-chat-stage="sess-1"]')).not.toBeNull()
    expect(threadOut()).toBe(true)
    // Still mounted, where it was, for the way back.
    expect(thread().textContent).toBe('the agent’s thread')
    // A new coding chat (a clear middle): hidden too.
    act(() => newCodingChat())
    expect(threadOut()).toBe(true)
    act(() => backToAgent())
    expect(container.querySelector('[data-code-chat-stage]')).toBeNull()
    expect(threadOut()).toBe(false)
  })

  it('never both at once, through every move between the three kinds of chat', () => {
    act(() => root.render(h(ThreadAndStage)))
    const moves = [() => openCodingChat('sess-1'), () => openCodingChat('sess-2'), () => newCodingChat(), () => backToAgent(), () => newCodingChat(), () => openCodingChat('sess-1'), () => backToAgent()]
    for (const move of moves) {
      act(move)
      const codingChatDrawn = container.querySelector('[data-code-chat-stage]') !== null || currentChatKind() !== 'agent'
      expect(threadOut()).toBe(codingChatDrawn)
    }
  })

  it('by the thread’s own props, never a rule: no <style> is injected, and nothing is exported to hide it by', async () => {
    act(() => root.render(h(ThreadAndStage)))
    act(() => openCodingChat('sess-1'))
    expect(container.querySelector('style')).toBeNull()
    expect(hiddenThreadProps(false)).toEqual({})
    expect(hiddenThreadProps(true)).toMatchObject({ inert: true, 'aria-hidden': true, style: { visibility: 'hidden', opacity: 0, pointerEvents: 'none' } })
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
    expect(read('../code-chat-stage.tsx')).not.toContain('<style')
    expect(read('../code-chat-stage.tsx')).not.toContain('HIDE_THREAD_CSS')
    // chat-panel.tsx puts them on both things the thread can be: its messages, and its empty state.
    expect(read('../chat-panel.tsx').match(/\{\.\.\.threadHidden\}/g)).toHaveLength(2)
  })

  it('draws the selected chat’s conversation, without a box of its own', () => {
    act(() => root.render(h(CodeChatStage)))
    act(() => openCodingChat('sess-1'))
    const stage = container.querySelector('[data-code-chat-stage="sess-1"]')!
    expect(stage.querySelector('[data-fake-panel="sess-1"]')?.getAttribute('data-composer')).toBe('false')
  })

  it('keeps the conversation’s own header only while the right panel isn’t showing the same things', () => {
    act(() => root.render(h(CodeChatStage)))
    act(() => {
      setPagePanelShown(true)
      openCodingChat('sess-1')
    })
    // The details are open by default: they name the agent, folder and status, so the header stays out.
    expect(container.querySelector('[data-fake-panel]')?.getAttribute('data-header')).toBe('false')
    act(() => setCodeDetailsOpen(false))
    expect(container.querySelector('[data-fake-panel]')?.getAttribute('data-header')).toBe('true')
    act(() => setCodeDetailsOpen(true))
  })

  it('where Recent isn’t on screen, a new chat’s middle lists the coding chats, and a chat has its way back to the agent', () => {
    chats.items = [{ key: 'sess-1' }]
    chats.readAt = new Date()
    act(() => root.render(h(CodeChatStage)))
    act(() => newCodingChat())
    // No panel beside the navigation (a narrow window): the list is here.
    expect(container.querySelector('[data-code-chat-stage="list"] [data-fake-rows="1"]')).not.toBeNull()
    act(() => openCodingChat('sess-1'))
    // A chat on screen: its way back to the agent, by the agent's own name ("‹ Joseph").
    const back = container.querySelector<HTMLButtonElement>('[data-code-chat-back]')!
    expect(back.textContent).toBe('Joseph')
    act(() => back.click())
    expect(currentChatKind()).toBe('agent')
    expect(container.innerHTML).toBe('')
    // With Recent on screen: neither the list (its rows are Recent's) nor the crumb (the pinned row is the way back).
    act(() => setPagePanelShown(true))
    act(() => newCodingChat())
    expect(container.querySelector('[data-code-chat-stage]')).toBeNull()
    act(() => openCodingChat('sess-1'))
    expect(container.querySelector('[data-code-chat-back]')).toBeNull()
  })

  it('leaves out the finish card only while the right panel shows the job’s record', () => {
    act(() => root.render(h(CodeChatStage)))
    act(() => {
      setPagePanelShown(true)
      openCodingChat('sess-1')
    })
    const hideFinish = () => container.querySelector('[data-fake-panel]')?.getAttribute('data-hide-finish')
    // Not read yet, then read with no record: nothing beside it says the summary.
    expect(hideFinish()).toBe('false')
    readChat(null)
    expect(hideFinish()).toBe('false')
    // Its record, in the open details: the Review card's What happened says it.
    readChat('job-1')
    expect(hideFinish()).toBe('true')
    // The details closed: the conversation is the only place it reads.
    act(() => setCodeDetailsOpen(false))
    expect(hideFinish()).toBe('false')
    act(() => setCodeDetailsOpen(true))
    expect(hideFinish()).toBe('true')
  })

  it('draws the finish card outside the shell, where the right panel has no Review card', () => {
    shell.shared = null
    act(() => root.render(h(CodeChatStage)))
    act(() => {
      setPagePanelShown(true)
      openCodingChat('sess-1')
    })
    readChat('job-1')
    expect(container.querySelector('[data-fake-panel]')?.getAttribute('data-hide-finish')).toBe('false')
  })

  describe('the first time, for someone used to the Code tab’s own list', () => {
    it('a new coding chat’s clear middle says once where the coding chats are; Dismiss keeps it gone on this device', () => {
      window.localStorage.removeItem(FIRST_TIME_KEY)
      act(() => root.render(h(CodeChatStage)))
      act(() => {
        setPagePanelShown(true)
        newCodingChat()
      })
      expect(container.querySelector('[data-code-first-time]')?.textContent).toContain(FIRST_TIME_LINE)
      // With a chat open: its conversation, no line.
      act(() => selectCodeChat('sess-1'))
      expect(container.querySelector('[data-code-first-time]')).toBeNull()
      act(() => selectCodeChat(null))
      act(() => container.querySelector<HTMLButtonElement>('[data-code-first-time-dismiss]')!.click())
      expect(container.querySelector('[data-code-first-time]')).toBeNull()
      expect(window.localStorage.getItem(FIRST_TIME_KEY)).toBe('1')
      expect(container.querySelector('[data-code-chat-stage]')).toBeNull()
    })

    it('Show only coding puts Recent on its coding chats, and the line is done', () => {
      window.localStorage.removeItem(FIRST_TIME_KEY)
      act(() => root.render(h(CodeChatStage)))
      act(() => {
        setPagePanelShown(true)
        newCodingChat()
      })
      act(() => container.querySelector<HTMLButtonElement>('[data-code-first-time-show]')!.click())
      expect(JSON.parse(window.localStorage.getItem(RECENTS_FILTER_KEY)!)).toEqual({ status: 'all', types: ['agents'] })
      expect(window.localStorage.getItem(FIRST_TIME_KEY)).toBe('1')
      expect(container.querySelector('[data-code-first-time]')).toBeNull()
    })
  })
})
