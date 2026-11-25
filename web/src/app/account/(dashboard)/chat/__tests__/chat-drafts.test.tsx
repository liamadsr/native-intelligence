// @vitest-environment jsdom
/**
 * A half-typed message belongs to the chat it was typed in (chat-drafts.ts,
 * use-chat-drafts.ts; docs/plans/one-home.md, decision 4).
 *
 * The regression this pins (seen in the browser before One Home): a note half
 * typed for the agent stayed in the box when Code was pressed and when a
 * coding chat was opened, one Enter from being sent to a coding agent.
 *
 *   - each chat keeps its own words, and has them back on return;
 *   - the one carry: between the agent and a NEW coding chat, when the other
 *     side's box is empty; never into an existing chat;
 *   - a new chat's first send: its words are nobody's draft afterwards;
 *   - the agent's saved draft is the agent's, whatever chat is on screen;
 *   - per workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ws = vi.hoisted(() => ({ id: 'ws-1' as string | null }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => ws.id }))

import { __resetChatDraftsForTests, agentDraft, draftOf, draftSent, swapDraft } from '../chat-drafts'
import { useChatDrafts } from '../use-chat-drafts'
import { __resetCurrentChatForTests, backToAgent, getCurrentChat, newCodingChat, openCodingChat, pressCode, type CurrentChat } from '../current-chat-store'
import { __resetCodeViewForTests } from '../code-chat-live'
import { DRAFT_CARRIES_TO_NEW_CODING_CHAT, DRAFT_PER_CHAT } from '../one-home-decisions'
import { resetSidePanelStore } from '../../side-panels/side-panel-store'

const AGENT: CurrentChat = { kind: 'agent' }
const NEW: CurrentChat = { kind: 'code-new' }
const chat = (sessionId: string): CurrentChat => ({ kind: 'code', sessionId })

beforeEach(() => {
  ws.id = 'ws-1'
  sessionStorage.clear()
  resetSidePanelStore()
  __resetCodeViewForTests()
  __resetCurrentChatForTests()
  __resetChatDraftsForTests()
})
afterEach(() => {
  __resetCurrentChatForTests()
  __resetCodeViewForTests()
  __resetChatDraftsForTests()
  resetSidePanelStore()
})

describe('the rules (swapDraft)', () => {
  it('both are on, as the owner chose (decision 4)', () => {
    expect(DRAFT_PER_CHAT).toBe(true)
    expect(DRAFT_CARRIES_TO_NEW_CODING_CHAT).toBe(true)
  })

  it('opening an existing coding chat never carries the agent’s words in; they are back with the agent', () => {
    expect(swapDraft(AGENT, chat('a'), 'half typed message to my agent')).toBe('')
    expect(draftOf(AGENT)).toBe('half typed message to my agent')
    expect(swapDraft(chat('a'), AGENT, '')).toBe('half typed message to my agent')
  })

  it('each coding chat keeps its own', () => {
    swapDraft(AGENT, chat('a'), '')
    expect(swapDraft(chat('a'), chat('b'), 'for a')).toBe('')
    expect(swapDraft(chat('b'), chat('a'), 'for b')).toBe('for a')
    expect(swapDraft(chat('a'), chat('b'), 'for a')).toBe('for b')
  })

  it('the one carry: the agent to a NEW coding chat with an empty box, and back', () => {
    expect(swapDraft(AGENT, NEW, 'Fix the flaky checkout test')).toBe('Fix the flaky checkout test')
    // They moved: the agent's box keeps none of them.
    expect(draftOf(AGENT)).toBe('')
    expect(swapDraft(NEW, AGENT, 'Fix the flaky checkout test')).toBe('Fix the flaky checkout test')
    expect(draftOf(NEW)).toBe('')
  })

  it('no carry over words already waiting on the other side: each keeps its own', () => {
    swapDraft(NEW, chat('a'), 'a new job, half typed')
    swapDraft(chat('a'), AGENT, '')
    expect(swapDraft(AGENT, NEW, 'a note for my agent')).toBe('a new job, half typed')
    expect(swapDraft(NEW, AGENT, 'a new job, half typed')).toBe('a note for my agent')
  })

  it('no carry from a new coding chat into an existing one, nor from an existing one into a new one', () => {
    expect(swapDraft(NEW, chat('a'), 'a new job')).toBe('')
    expect(swapDraft(chat('a'), NEW, 'for a')).toBe('a new job')
    expect(draftOf(chat('a'))).toBe('for a')
  })

  it('an empty box carries nothing and keeps nothing', () => {
    expect(swapDraft(AGENT, NEW, '   ')).toBe('')
    expect(swapDraft(NEW, AGENT, '')).toBe('   ')
  })

  it('a new chat’s first send: its words went with it, and are no draft when it is left for the chat it became', () => {
    draftSent(NEW)
    expect(swapDraft(NEW, chat('a'), 'Fix the date picker')).toBe('')
    expect(draftOf(NEW)).toBe('')
    // Code pressed again: a clear box.
    expect(swapDraft(chat('a'), NEW, '')).toBe('')
  })

  it('the same chat: the box is left alone', () => {
    expect(swapDraft(chat('a'), chat('a'), 'typing')).toBe('typing')
  })

  it('the agent’s saved draft is the agent’s, whatever chat is on screen', () => {
    expect(agentDraft(AGENT, 'for my agent')).toBe('for my agent')
    swapDraft(AGENT, chat('a'), 'for my agent')
    expect(agentDraft(chat('a'), 'for the coding agent')).toBe('for my agent')
    // Nothing kept for the agent: nothing, never the coding chat's words.
    __resetChatDraftsForTests()
    expect(agentDraft(chat('a'), 'for the coding agent')).toBe('')
  })

  it('per workspace: another workspace’s chats never read this one’s words', () => {
    swapDraft(AGENT, chat('a'), 'ws-1’s note')
    ws.id = 'ws-2'
    expect(draftOf(AGENT)).toBe('')
    expect(agentDraft(NEW, '')).toBe('')
    ws.id = 'ws-1'
    expect(draftOf(AGENT)).toBe('ws-1’s note')
  })
})

describe('the box (useChatDrafts over the current chat)', () => {
  let container: HTMLDivElement
  let root: Root
  const box = { value: '', set: (_text: string) => {}, saved: (_text: string) => '' as string }

  function Host({ enabled = true }: { enabled?: boolean }) {
    const [value, setValue] = useState('')
    const { agentDraftOf } = useChatDrafts({ enabled, input: value, setInput: setValue })
    box.value = value
    box.set = setValue
    box.saved = agentDraftOf
    return h('textarea', { value, readOnly: true })
  }
  const type = (text: string) => act(() => box.set(text))

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('the bug: a note half typed for the agent is not in the box under a coding chat, and is there again back on the agent', () => {
    act(() => root.render(h(Host)))
    type('half typed message to my agent')
    act(() => openCodingChat('sess-1', { from: 'recents' }))
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 'sess-1' })
    expect(box.value).toBe('')
    // What a reload would save as the agent's draft is still the agent's.
    expect(box.saved(box.value)).toBe('half typed message to my agent')
    type('answer for the coding agent')
    expect(box.saved(box.value)).toBe('half typed message to my agent')
    act(() => backToAgent({ from: 'recents' }))
    expect(box.value).toBe('half typed message to my agent')
    act(() => openCodingChat('sess-1'))
    expect(box.value).toBe('answer for the coding agent')
  })

  it('the toggle to a new coding chat carries the words, and back', () => {
    act(() => root.render(h(Host)))
    type('Fix the flaky checkout test')
    act(() => pressCode({ from: 'composer' }))
    expect(box.value).toBe('Fix the flaky checkout test')
    act(() => backToAgent({ from: 'composer' }))
    expect(box.value).toBe('Fix the flaky checkout test')
  })

  it('a new coding chat’s first send lands in its chat with a clear box, and Code pressed again is clear too', () => {
    act(() => root.render(h(Host)))
    act(() => newCodingChat())
    type('Fix the date picker')
    // As the composer's send does: the words went, then the chat it started is the current one.
    act(() => {
      draftSent(getCurrentChat())
      openCodingChat('sess-new', { from: 'composer' })
    })
    expect(box.value).toBe('')
    act(() => pressCode())
    expect(box.value).toBe('')
  })

  it('any other chat panel (not the home thread) is left alone', () => {
    act(() => root.render(h(Host, { enabled: false })))
    type('a capture’s chat')
    act(() => openCodingChat('sess-1'))
    expect(box.value).toBe('a capture’s chat')
    expect(box.saved(box.value)).toBe('a capture’s chat')
  })
})
