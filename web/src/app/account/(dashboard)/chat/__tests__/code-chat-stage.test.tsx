// @vitest-environment jsdom
/**
 * The Code view's middle (code-chat-stage.tsx): on Code the agent's thread
 * stops painting by the stage's own <style> (never the app's stylesheet),
 * with a chat selected or not, and the selected chat's conversation draws
 * without a box of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const panel = vi.fn((props: { sessionId: string; composer?: boolean; header?: boolean }) => h('div', { 'data-fake-panel': props.sessionId, 'data-composer': String(props.composer), 'data-header': String(props.header) }))
vi.mock('@/components/local-agent/local-agent-panel', () => ({ LocalAgentPanel: (props: { sessionId: string; composer?: boolean; header?: boolean }) => panel(props) }))
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

import { CodeChatStage, HIDE_THREAD_CSS } from '../code-chat-stage'
import { __resetCodeViewForTests, selectCodeChat } from '../code-view-store'
import { setCodeDetailsOpen, setCodeView, setPagePanelShown, setRightPanelOpen } from '../../side-panels/side-panel-store'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => {
    setCodeView(false)
    setPagePanelShown(false)
    setRightPanelOpen(false)
    __resetCodeViewForTests()
  })
  window.localStorage.clear()
  chats.items = []
  chats.readAt = null
})

describe('CodeChatStage', () => {
  it('is nothing on the agent’s tab, even with a chat selected', () => {
    act(() => selectCodeChat('sess-1'))
    act(() => root.render(h(CodeChatStage)))
    expect(container.innerHTML).toBe('')
  })

  it('on Code, hides the agent’s thread with its own rule, with no chat selected too', () => {
    act(() => root.render(h(CodeChatStage)))
    act(() => setCodeView(true))
    expect(container.querySelector('style[data-code-view-style]')?.textContent).toBe(HIDE_THREAD_CSS)
    expect(container.querySelector('[data-code-chat-stage]')).toBeNull()
    // The rule spares this conversation and the stage full-screen pages draw on.
    expect(HIDE_THREAD_CSS).toContain(':not([data-code-chat-stage])')
    expect(HIDE_THREAD_CSS).toContain(':not([data-chat-card-stage])')
    // Back on the agent's tab: the rule goes with the view.
    act(() => setCodeView(false))
    expect(container.querySelector('style')).toBeNull()
  })

  it('draws the selected chat’s conversation, without a box of its own', () => {
    act(() => root.render(h(CodeChatStage)))
    act(() => {
      setCodeView(true)
      selectCodeChat('sess-1')
    })
    const stage = container.querySelector('[data-code-chat-stage="sess-1"]')!
    expect(stage.querySelector('[data-fake-panel="sess-1"]')?.getAttribute('data-composer')).toBe('false')
    expect(container.querySelector('style[data-code-view-style]')).not.toBeNull()
  })

  it('keeps the conversation’s own header only while the right panel isn’t showing the same things', () => {
    act(() => root.render(h(CodeChatStage)))
    act(() => {
      setPagePanelShown(true)
      setCodeView(true)
      selectCodeChat('sess-1')
    })
    // The details are open by default: they name the agent, folder and status, so the header stays out.
    expect(container.querySelector('[data-fake-panel]')?.getAttribute('data-header')).toBe('false')
    act(() => setCodeDetailsOpen(false))
    expect(container.querySelector('[data-fake-panel]')?.getAttribute('data-header')).toBe('true')
    act(() => setCodeDetailsOpen(true))
  })

  it('where the list isn’t on screen beside the navigation, offers it in the middle and a way back from a chat', () => {
    chats.items = [{ key: 'sess-1' }]
    chats.readAt = new Date()
    act(() => root.render(h(CodeChatStage)))
    act(() => setCodeView(true))
    // No panel beside the navigation (a narrow window): the list is here.
    expect(container.querySelector('[data-code-chat-stage="list"] [data-fake-rows="1"]')).not.toBeNull()
    act(() => selectCodeChat('sess-1'))
    const back = container.querySelector<HTMLButtonElement>('[data-code-chat-back]')!
    expect(back).not.toBeNull()
    act(() => back.click())
    expect(container.querySelector('[data-code-chat-stage="list"]')).not.toBeNull()
    // With the panel on screen: neither.
    act(() => setPagePanelShown(true))
    expect(container.querySelector('[data-code-chat-stage]')).toBeNull()
    act(() => selectCodeChat('sess-1'))
    expect(container.querySelector('[data-code-chat-back]')).toBeNull()
  })
})
