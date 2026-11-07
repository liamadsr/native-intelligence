// @vitest-environment jsdom
/**
 * The renderer registry draws a show result as its page card: wide in the
 * main chat (the message column breaks out of the 80% cap), a pill in a
 * narrow host, and the generic chip while the call runs or when it was
 * refused. In the main chat's message list, a page the person opened draws
 * nowhere: it opens full screen, and is mounted outside the list.
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
vi.mock('@/components/chat-cards/card-body', () => ({ default: () => h('div', { 'data-card-body': '' }) }))

import { ChatMessage } from '../chat-message'
import { ChatMessageList } from '../chat-message-list'
import { dataPartRendererFor, rendererFor } from '../tool-renderers'
import { openedCardMessage } from '@/lib/chat-cards/opened-card'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { ChatCardHostProvider } from '@/components/chat-cards/card-host'
import { ChatCardStore } from '@/components/chat-cards/card-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const card = { kind: 'list', title: 'Due this week', entity_type: 'action', filters: [] }

function showPart(state: 'input-available' | 'output-available', output?: unknown) {
  return { type: 'dynamic-tool', toolName: 'show', toolCallId: 'call_1', state, input: { kind: 'list' }, ...(output ? { output } : {}) }
}

function render(parts: unknown[], wide: boolean) {
  const message = h(ChatMessage, { message: { id: 'm1', role: 'assistant', parts } as unknown as UIMessage, userAvatarUrl: null, userInitials: 'LA' })
  act(() => {
    root.render(wide ? h(ChatCardHostProvider, { value: { wide: true, store: new ChatCardStore(), stage: null }, children: message }) : message)
  })
}

describe('the show card in a reply', () => {
  it('breaks out of the 80% message width in the main chat and draws the card', () => {
    render([showPart('output-available', { success: true, card, count: 7, items: [] })], true)
    expect(container.querySelector('[data-chat-card="call_1"]')).not.toBeNull()
    expect(container.querySelector('.w-\\[80\\%\\]')).not.toBeNull()
  })

  it('is a pill in a narrow host, with no breakout', () => {
    render([showPart('output-available', { success: true, card, count: 7, items: [] })], false)
    expect(container.querySelector('[data-chat-card-pill="call_1"]')?.textContent).toBe('Showed 7 actions · Due this week')
    expect(container.querySelector('.w-\\[80\\%\\]')).toBeNull()
  })

  it('falls back to the generic chip while it runs and when it was refused', () => {
    render([showPart('input-available')], true)
    expect(container.querySelector('[data-chat-card]')).toBeNull()
    render([showPart('output-available', { success: false, error: 'bad field' })], true)
    expect(container.querySelector('[data-chat-card]')).toBeNull()
    expect(container.querySelector('.max-w-\\[80\\%\\]')).not.toBeNull()
  })
})

describe('the reply\'s line rides its card (tailwind.css data-chat-panel)', () => {
  const text = (t: string) => ({ type: 'text', text: t, state: 'done' })
  const result = showPart('output-available', { success: true, card, count: 7, items: [] })
  // The element right after the open card, when it is a bubble that may ride it.
  const riding = () => {
    const frame = container.querySelector('[data-chat-panel="card"]')
    const next = frame?.nextElementSibling
    return next?.classList.contains('chat-panel-attachment') ? next : null
  }

  it('an open card is a panel, and the text after it sits right beside it', () => {
    render([result, text('12 actions, 3 overdue.')], true)
    expect(container.querySelector('[data-chat-card="call_1"]')?.getAttribute('data-chat-panel')).toBe('card')
    expect(riding()?.textContent).toContain('12 actions, 3 overdue.')
  })

  it('a lead-in before the card stays a plain bubble; only the line after it rides', () => {
    render([text('Here it is.'), result, text('Mostly on Atlas.')], true)
    const bubbles = Array.from(container.querySelectorAll('.chat-panel-attachment'))
    expect(bubbles).toHaveLength(2)
    // The lead-in follows no panel, so the rule never moves it.
    expect(bubbles[0].previousElementSibling?.hasAttribute('data-chat-panel') ?? false).toBe(false)
    expect(riding()?.textContent).toContain('Mostly on Atlas.')
  })

  it('a pill (a narrow host) is no panel, so nothing rides it', () => {
    render([result, text('12 actions.')], false)
    expect(container.querySelector('[data-chat-panel]')).toBeNull()
  })
})

describe('rendererFor', () => {
  it('finds each moved card by name, and nothing for a tool without one', () => {
    for (const name of ['ask_user', 'suggest_changes', 'web_search', 'create_email_draft', 'get_attachment_content', 'show']) {
      expect(rendererFor(name), name).toBeDefined()
    }
    expect(rendererFor('list_actions')).toBeUndefined()
  })
})

describe('a page the person opened from /', () => {
  const opened = openedCardMessage({ id: 'p1', spec: card as CardSpec, number: 4, page: 'actions' })

  function renderOpened(wide: boolean) {
    const message = h(ChatMessage, { message: opened, userAvatarUrl: null, userInitials: 'LA' })
    act(() => {
      root.render(wide ? h(ChatCardHostProvider, { value: { wide: true, store: new ChatCardStore(), stage: null }, children: message }) : message)
    })
  }

  it('draws the same card, across the reading column, in the person’s own message', () => {
    renderOpened(true)
    const frame = container.querySelector('[data-chat-card="p1"]')
    expect(frame).not.toBeNull()
    expect(frame!.className).toContain('w-full')
    expect(frame!.textContent).toContain('Due this week')
    // No text bubble: the message is only the card.
    expect(container.querySelector('.chat-user-bubble')).toBeNull()
  })

  it('is a pill saying Opened in a narrow host', () => {
    renderOpened(false)
    expect(container.querySelector('[data-chat-card-pill="p1"]')?.textContent).toBe('Opened actions · Due this week')
  })

  it('is in the registry by its part type', () => {
    expect(dataPartRendererFor('data-chat-card')?.wide).toBe(true)
    expect(dataPartRendererFor('data-proposals')).toBeUndefined()
  })
})

describe('the main chat’s message list', () => {
  it('leaves out the pages the person opened (they never draw in the chat), and still draws the agent’s cards', () => {
    const agent = { id: 'm1', role: 'assistant', parts: [showPart('output-available', { success: true, card, count: 7, items: [] })] } as unknown as UIMessage
    const opened = openedCardMessage({ id: 'p1', spec: card as CardSpec, number: 2, page: 'actions' })
    const said = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] } as UIMessage
    act(() => {
      root.render(
        h(ChatCardHostProvider, {
          value: { wide: true, store: new ChatCardStore(), stage: null },
          children: h(ChatMessageList, { messages: [said, opened, agent], latestUserMessageId: 'u1', userAvatarUrl: null, userInitials: 'LA', hideOpenedCards: true }),
        }),
      )
    })
    expect(container.querySelector('[data-chat-card="call_1"]')).not.toBeNull()
    expect(container.querySelector('[data-chat-card="p1"], [data-chat-card-pill="p1"]')).toBeNull()
    // No row, so no gap, where it was.
    expect(Array.from(container.querySelectorAll('.group\\/msg')).length).toBe(2)
  })
})

describe('a server-written data card in a reply', () => {
  it('draws a message holding only a registered data part (the morning tidy)', () => {
    const data = { batch_id: '00000000-0000-4000-8000-0000000000a1', count: 3, domains: ['amazon.com'], more_domains: 0 }
    render([{ type: 'data-email-auto-archive', id: 'email-auto-archive:x', data }], false)
    expect(container.textContent).toContain('Inbox tidied')
    expect(container.textContent).toContain('3 threads')
  })

  it('draws a to-do arriving mail marked done, with Undo, and a reopened one without', () => {
    const data = { record_id: '00000000-0000-4000-8000-0000000000b1', action_id: 'a1', identifier: 'GEN-863', title: 'Look into renting a car', sender_domain: 'enterprise.com' }
    render([{ type: 'data-action-done-from-mail', id: 'action-done-from-mail:x', data }], false)
    expect(container.textContent).toContain('Done from your mail')
    expect(container.textContent).toContain('GEN-863')
    expect(container.textContent).toContain('Look into renting a car')
    expect(container.textContent).toContain('Undo')
    render([{ type: 'data-action-done-from-mail', id: 'action-done-from-mail:x', data: { ...data, undone: true } }], false)
    expect(container.textContent).toContain('Reopened')
    expect(container.textContent).not.toContain('Undo')
  })

  it('a message of only an unknown data part still draws nothing', () => {
    render([{ type: 'data-nobody-draws-this', data: {} }], false)
    expect(container.textContent).toBe('')
  })
})
