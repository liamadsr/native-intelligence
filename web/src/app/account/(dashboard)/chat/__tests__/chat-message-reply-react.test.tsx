// @vitest-environment jsdom
/**
 * A message's Reply and reactions in the thread (message-reply.ts,
 * message-reactions.ts). Pinned:
 *   • a message sent with a message's Reply chip points at it in the list
 *     (GEN-353, reply-link.ts): a frosted copy of what it answers stacked on
 *     the reply, which goes back to it, and the compact ┐ beside it, whether
 *     the message is right above or further up, the person's own too; words
 *     selected by hand: the same capsule holding them; outside the list (or
 *     not drawn), the one-line quote with its small hook;
 *   • a reaction's own turn draws nothing;
 *   • where the host provides Reply and React (MessageInteractionsContext),
 *     a settled reply has the corner toolbar (message-toolbar.tsx): React,
 *     Reply, Copy and ⋯, whose menu has the quick reactions, Reply again and
 *     the two copies; the row under it keeps Read aloud and the thumbs (not
 *     Copy); without the host, the row as before (Copy too); while it
 *     streams, no toolbar;
 *   • a turn that says several things: the toolbar goes to the bubble the
 *     pointer is over, and Reply and React act on that bubble;
 *   • each bubble's reaction shows under its foot (its metadata, or the
 *     store's), and pressing it takes it off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, detailPanel: unknown) => ({ location: { kind: 'view', view }, view, detailPanel }),
}))
vi.mock('../../../workspace-switcher', () => ({ useWorkspaceEdition: () => 'full' }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { ChatMessage } from '../chat-message'
import { ChatMessageList } from '../chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '../message-interactions'
import { messageReplyMetadata } from '@/lib/chat/message-reply'
import { reactionTurnMetadata } from '@/lib/chat/message-reactions'
import type { MessageReactionsStore } from '@/hooks/use-message-reactions'

const turn = (metadata?: Record<string, unknown>): UIMessage =>
  ({
    id: 'eve-msg-t1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Looking at your board.' },
      { type: 'dynamic-tool', toolName: 'list_actions', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
      { type: 'text', text: 'Want me to close **ENG-4**?' },
    ],
    ...(metadata ? { metadata } : {}),
  }) as UIMessage
const reply = (metadata?: Record<string, unknown>): UIMessage =>
  ({ id: 'eve-msg-a1', role: 'assistant', parts: [{ type: 'text', text: '**Connected:** just your Google Calendar so far.' }], ...(metadata ? { metadata } : {}) }) as UIMessage
const mine = (metadata?: Record<string, unknown>): UIMessage =>
  ({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'which account?' }], ...(metadata ? { metadata } : {}) }) as UIMessage

/** A store that knows nothing (the messages' metadata stands). */
const emptyStore: MessageReactionsStore = {
  conversationId: 'c',
  get: () => undefined,
  subscribe: () => () => {},
  load: async () => {},
  react: async () => {},
}

describe('ChatMessage — Reply and reactions', () => {
  let container: HTMLDivElement
  let root: Root
  let interactions: MessageInteractions
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    interactions = { reply: vi.fn(), react: vi.fn(), reactions: emptyStore }
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const render = (m: UIMessage, opts: { host?: boolean; streaming?: boolean } = {}) => {
    const el = h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA', streaming: opts.streaming ?? false })
    act(() => root.render(opts.host === false ? el : h(MessageInteractionsContext.Provider, { value: interactions }, el)))
  }

  const renderList = (messages: UIMessage[]) => {
    act(() =>
      root.render(
        h(MessageInteractionsContext.Provider, { value: interactions }, h(ChatMessageList, { messages, latestUserMessageId: null, userAvatarUrl: null, userInitials: 'LA' })),
      ),
    )
  }
  const answer = reply()
  const replyTo = (id: string, quote: string, extra: Record<string, unknown> = {}): UIMessage =>
    ({ id, role: 'user', parts: [{ type: 'text', text: 'which account?' }], metadata: messageReplyMetadata({ messageId: 'eve-msg-a1', role: 'assistant', quote, part: false, ...extra }) }) as UIMessage
  const between: UIMessage[] = [
    { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'and the calendar?' }] } as UIMessage,
    { id: 'eve-msg-a2', role: 'assistant', parts: [{ type: 'text', text: 'Only Google so far.' }] } as UIMessage,
  ]
  const QUOTE = 'Connected: just your Google Calendar so far.'

  it('outside the list (no link), a reply shows the one-line quote above the person’s words, with its small hook', () => {
    render(mine(messageReplyMetadata({ messageId: 'eve-msg-a1', role: 'assistant', quote: QUOTE, part: false })))
    const quote = container.querySelector('[data-message-reply-quote]')!
    expect(quote.getAttribute('data-message-reply-quote')).toBe('eve-msg-a1')
    expect(quote.textContent).toContain(QUOTE)
    expect(quote.querySelector('[data-thread-hook="down-from-right"]')).not.toBeNull()
    const bubble = container.querySelector('.chat-message-bubble')!
    expect(quote.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a reply to the message right above or further up: its frosted copy stacked on the reply, all its words, the ┐ beside it; a press goes back to it', () => {
    if (typeof globalThis.CSS?.escape !== 'function') vi.stubGlobal('CSS', { escape: (s: string) => s })
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      for (const thread of [[answer], [answer, ...between]]) {
        scrollIntoView.mockClear()
        renderList([...thread, replyTo('u1', QUOTE)])
        const row = container.querySelector('[data-message-row="u1"]')!
        const ghost = row.querySelector<HTMLElement>('[data-message-reply-ghost]')!
        expect(ghost.getAttribute('data-message-reply-ghost')).toBe('eve-msg-a1')
        expect(ghost.textContent).toBe(QUOTE)
        // A copy: not a bubble Reply, the selection's Reply or the jump's flash would pick.
        expect(ghost.querySelector('.chat-message-bubble')).toBeNull()
        const control = ghost.querySelector<HTMLElement>('[role="button"]')!
        expect(control.getAttribute('aria-label')).toBe('Copy of the message this replies to; go to it')
        // Its words take no press of their own.
        expect(control.querySelector('[inert]')).not.toBeNull()
        // Above the person's words.
        expect(ghost.compareDocumentPosition(row.querySelector('.chat-message-bubble')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        // No quote line: the copy says what it answers. The ┐ beside it, its title the quote.
        expect(row.querySelector('[data-message-quote]')).toBeNull()
        const hook = row.querySelector('[data-message-reply-quote] [data-reply-link]')!
        expect(hook.getAttribute('title')).toBe(QUOTE)
        act(() => control.click())
        expect(scrollIntoView).toHaveBeenCalledTimes(1)
        expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('[data-message-row="eve-msg-a1"]'))
      }
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
      vi.unstubAllGlobals()
    }
  })

  it('a reply to the person’s own message right above: its copy as plain text, stacked on the reply, with the ┐', () => {
    const own = { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'and the **calendar**?' }] } as UIMessage
    const back = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'never mind' }], metadata: messageReplyMetadata({ messageId: 'u0', role: 'user', quote: 'and the calendar?', part: false }) } as UIMessage
    renderList([answer, own, back])
    const row = container.querySelector('[data-message-row="u1"]')!
    const ghost = row.querySelector('[data-message-reply-ghost]')!
    expect(ghost.getAttribute('data-message-reply-ghost')).toBe('u0')
    // As written: the person's own words aren't markdown.
    expect(ghost.textContent).toBe('and the **calendar**?')
    expect(row.querySelector('[data-message-reply-quote] [data-reply-link]')).not.toBeNull()
  })

  it('a reply to one bubble of a turn copies that bubble only', () => {
    renderList([turn(), ...between, replyTo('u1', 'Want me to close ENG-4?', { messageId: 'eve-msg-t1', part: true })])
    const ghost = container.querySelector('[data-message-reply-ghost]')!
    expect(ghost.textContent).toBe('Want me to close ENG-4?')
  })

  it('a message not drawn in the list (an earlier page): the one-line quote, no copy', () => {
    renderList([...between, replyTo('u1', QUOTE)])
    expect(container.querySelector('[data-message-reply-ghost]')).toBeNull()
    expect(container.querySelector('[data-message-reply-quote]')!.textContent).toContain(QUOTE)
  })

  it('words selected by hand: a capsule holding them above the reply, with the ┐, whether the message is right above or further up (never a copy)', () => {
    const picked = { part: true, selected: true }
    for (const thread of [[answer], [answer, ...between]]) {
      renderList([...thread, replyTo('u1', 'just your Google Calendar so far', picked)])
      const row = container.querySelector('[data-message-row="u1"]')!
      expect(row.querySelector('[data-message-reply-ghost]')).toBeNull()
      const capsule = row.querySelector('[data-message-reply-capsule]')!
      expect(capsule.getAttribute('data-message-reply-capsule')).toBe('eve-msg-a1')
      expect(capsule.textContent).toBe('“just your Google Calendar so far”')
      expect(capsule.querySelector('[role="button"]')!.getAttribute('aria-label')).toBe('The words this replies to; go to them')
      // The compact ┐, not the quote line's small hook.
      expect(row.querySelector('[data-thread-hook="down-from-right"]')).toBeNull()
      expect(row.querySelector('[data-message-reply-quote] [data-reply-link]')).not.toBeNull()
    }
  })

  it('words selected, outside the list too: the capsule and the ┐', () => {
    render(mine(messageReplyMetadata({ messageId: 'eve-msg-a1', role: 'assistant', quote: 'just your Google Calendar so far', part: true, selected: true })))
    expect(container.querySelector('[data-message-reply-capsule]')!.textContent).toBe('“just your Google Calendar so far”')
    expect(container.querySelector('[data-reply-link]')).not.toBeNull()
  })

  it('a reaction’s own turn draws nothing (the agent reads it; the person sees its answer)', () => {
    render(mine({ ...reactionTurnMetadata('👍', 'eve-msg-a1', 0, 'Should I tell you a fun fact about otters?') }))
    expect(container.innerHTML).toBe('')
  })

  const openMenu = async () => {
    const more = container.querySelector<HTMLButtonElement>('[data-message-more]')!
    await act(async () => {
      more.focus()
      more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    return document.querySelector<HTMLElement>('[data-message-menu]')
  }

  it('a settled reply has the corner toolbar where the host has it: React, Reply, Copy and ⋯', () => {
    render(reply())
    const bar = container.querySelector('[data-message-toolbar]')!
    expect(bar).not.toBeNull()
    expect(bar.querySelector('[data-message-react]')).not.toBeNull()
    act(() => bar.querySelector<HTMLButtonElement>('[data-message-reply]')!.click())
    expect(interactions.reply).toHaveBeenCalledWith(
      { messageId: 'eve-msg-a1', role: 'assistant', quote: 'Connected: just your Google Calendar so far.', part: false },
      container.querySelector('.chat-message-bubble'),
      '**Connected:** just your Google Calendar so far.',
    )
    expect(bar.querySelector('[data-message-copy]')).not.toBeNull()
    expect(bar.querySelector('[data-message-more]')).not.toBeNull()
    // The row under the reply stays, for Read aloud and the thumbs; its Copy is the bar's.
    const row = container.querySelector('[data-message-actions]')!
    expect(row).not.toBeNull()
    expect(row.textContent).toBe('')
    expect(bar.contains(row)).toBe(false)
  })

  it('a turn that says several things: the bar goes to the bubble under the pointer, and acts on it', () => {
    render(turn({ reactions: { '1': { emoji: '👍', at: '2026-10-20T10:00:00.000Z' } } }))
    const bubbles = container.querySelectorAll<HTMLElement>('.chat-message-bubble')
    expect(bubbles).toHaveLength(2)
    const bar = container.querySelector<HTMLElement>('[data-message-toolbar]')!
    act(() => {
      bubbles[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(bar.dataset.bubble).toBe('1')
    act(() => bar.querySelector<HTMLButtonElement>('[data-message-reply]')!.click())
    expect(interactions.reply).toHaveBeenCalledWith(
      { messageId: 'eve-msg-t1', role: 'assistant', quote: 'Want me to close ENG-4?', part: true },
      bubbles[1],
      'Want me to close **ENG-4**?',
    )
    // Its reaction is the second bubble's, under it.
    const badges = container.querySelectorAll('[data-message-reaction]')
    expect(badges).toHaveLength(1)
    expect(bubbles[1].nextElementSibling).toBe(badges[0])
    // Over the tool steps between them, it stays where it is.
    act(() => {
      container.querySelector('[data-message-toolbar]')!.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(bar.dataset.bubble).toBe('1')
  })

  it('⋯ holds the reactions, Reply (quoting the whole message’s opening), both copies', async () => {
    render(reply())
    const menu = (await openMenu())!
    expect(menu.querySelectorAll('[data-menu-reaction]')).toHaveLength(6)
    expect(menu.querySelector('[data-menu-copy]')!.textContent).toBe('Copy message')
    expect(menu.querySelector('[data-menu-copy-markdown]')!.textContent).toBe('Copy message as Markdown')
    await act(async () => menu.querySelector<HTMLElement>('[data-menu-reply]')!.click())
    // It runs once the menu has closed (its focus scope lets go on a timer).
    await vi.waitFor(() =>
      expect(interactions.reply).toHaveBeenCalledWith(
        { messageId: 'eve-msg-a1', role: 'assistant', quote: 'Connected: just your Google Calendar so far.', part: false },
        container.querySelector('.chat-message-bubble'),
        '**Connected:** just your Google Calendar so far.',
      ),
    )
  })

  it('a reaction picked in ⋯ goes to the host', async () => {
    render(reply())
    const menu = (await openMenu())!
    const party = [...menu.querySelectorAll<HTMLElement>('[data-menu-reaction]')].find((el) => el.dataset.menuReaction === '🎉')!
    await act(async () => party.click())
    expect(interactions.react).toHaveBeenCalledWith(expect.objectContaining({ id: 'eve-msg-a1' }), 0, '🎉')
  })

  it('without the host, the row under the reply; while it streams, no toolbar', () => {
    render(reply(), { host: false })
    expect(container.querySelector('[data-message-toolbar]')).toBeNull()
    expect(container.querySelector('[data-message-react]')).toBeNull()
    expect(container.querySelector('[data-message-actions]')).not.toBeNull()
    render(reply(), { streaming: true })
    expect(container.querySelector('[data-message-toolbar]')).toBeNull()
  })

  it('the reaction shows under its bubble’s foot, and pressing it takes it off', () => {
    render(reply({ reactions: { '0': { emoji: '❤️', at: '2026-10-20T10:00:00.000Z' } } }))
    const badge = container.querySelector<HTMLButtonElement>('[data-message-reaction]')!
    expect(badge.textContent).toBe('❤️')
    act(() => badge.click())
    expect(interactions.react).toHaveBeenCalledWith(expect.objectContaining({ id: 'eve-msg-a1' }), 0, null)
  })

  it('the store’s word wins over the metadata (taken off, or made, in this tab)', () => {
    interactions = { ...interactions, reactions: { ...emptyStore, get: () => null } }
    render(reply({ reactions: { '0': { emoji: '❤️', at: '2026-10-20T10:00:00.000Z' } } }))
    expect(container.querySelector('[data-message-reaction]')).toBeNull()
    // One object, as the store keeps it (a snapshot must be stable between reads).
    const party = { emoji: '🎉', at: '2026-10-20T10:00:00.000Z' }
    interactions = { ...interactions, reactions: { ...emptyStore, get: () => party } }
    render(reply())
    expect(container.querySelector('[data-message-reaction]')!.textContent).toBe('🎉')
  })
})
