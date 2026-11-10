// @vitest-environment jsdom
/**
 * A message sent with a For you card's Reply chip keeps the card on its
 * metadata (card-reply.ts cardReplyMetadata): the thread shows it above the
 * person's words, right-aligned with a hook down to them, on reload too.
 * Never on an assistant reply, and never from a ref that isn't one.
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
import { CARD_QUOTE_CLASS } from '../card-reply-chip'

const CARD = {
  kind: 'card',
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  verb: 'Fix',
  sentence: 'the failing native-intelligence build on Vercel, now five production deploys in a row',
  subkind: 'action_card',
}

function message(role: 'user' | 'assistant', metadata?: Record<string, unknown>): UIMessage {
  return { id: 'm1', role, parts: [{ type: 'text', text: 'what’s this?' }], ...(metadata ? { metadata } : {}) } as UIMessage
}

describe('ChatMessage — the card a message replied to', () => {
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
  const render = (m: UIMessage) => act(() => root.render(h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA' })))
  const quote = () => container.querySelector<HTMLElement>('[data-card-reply-quote]')

  it('shows the card above the person’s words: its verb, its sentence on one line, and the hook', () => {
    render(message('user', { replyCard: CARD }))
    const q = quote()!
    expect(q.getAttribute('data-card-reply-quote')).toBe(CARD.id)
    expect(q.textContent).toContain('Fix')
    expect(q.textContent).toContain(CARD.sentence)
    expect(q.querySelector('.truncate')).not.toBeNull()
    expect(q.querySelector('[data-thread-hook="down-from-right"]')).not.toBeNull()
    // Above the words, and the words keep their own width (not stretched to the card's).
    const bubble = [...container.querySelectorAll<HTMLElement>('div')].find((d) => d.textContent === 'what’s this?' && d.className.includes('chat-user-bubble'))!
    expect(q.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(bubble.className).toMatch(/(^|\s)self-end(\s|$)/)
  })

  it('draws at the composer chip\'s own size (one CardQuote), with the card\'s icon when it had one', () => {
    render(message('user', { replyCard: { ...CARD, icon: 'mail' } }))
    const card = quote()!.querySelector<HTMLElement>('[data-card-quote]')!
    expect(card.className).toContain(CARD_QUOTE_CLASS)
    expect(card.querySelector('[data-sentence-icon="mail"]')).not.toBeNull()
  })

  it('nothing without a card, on a reply, or from a ref that isn’t one', () => {
    render(message('user'))
    expect(quote()).toBeNull()
    render(message('assistant', { replyCard: CARD }))
    expect(quote()).toBeNull()
    render(message('user', { replyCard: { ...CARD, id: 'nope' } }))
    expect(quote()).toBeNull()
  })
})
