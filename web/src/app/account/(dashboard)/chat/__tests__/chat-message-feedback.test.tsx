// @vitest-environment jsdom
/**
 * Thumbs on a reply (the evals flywheel, message-feedback-buttons.tsx):
 *  - on a settled assistant reply, where the host provides the conversation's
 *    ratings (ChatPanel's MessageFeedbackContext);
 *  - never on the person's messages, a streaming reply, a notice row Dial8
 *    wrote (metadata.kind), or in a host without the context; but on the
 *    agent's own server-started replies (a home turn, a live nudge);
 *  - clicking the active thumb clears it;
 *  - a thumbs-down saves at once and asks "What went wrong?": Send adds the
 *    reason, Skip keeps the rating without one.
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
vi.mock('sonner', () => ({ toast: vi.fn() }))

import { ChatMessage } from '../chat-message'
import { MessageFeedbackContext, canRateMessage } from '../message-feedback-buttons'
import { createMessageFeedbackStore, type MessageFeedbackStore } from '@/hooks/use-message-feedback'

const message = (role: UIMessage['role'], metadata?: Record<string, unknown>, text = 'Here are your three open actions.'): UIMessage =>
  ({ id: 'm1', role, parts: [{ type: 'text', text, state: 'done' }], ...(metadata ? { metadata } : {}) }) as UIMessage

describe('canRateMessage', () => {
  it('takes a settled assistant reply with text', () => {
    expect(canRateMessage(message('assistant', { eve_written: true }), false)).toBe(true)
  })
  it('takes the agent’s own replies nobody typed: a home turn, a live nudge', () => {
    expect(canRateMessage(message('assistant', { kind: 'home_turn', home_turn_id: 'h1', reason: 'helper_report' }), false)).toBe(true)
    expect(canRateMessage(message('assistant', { kind: 'say_to_user', nudge_kind: 'insight' }), false)).toBe(true)
  })
  it('refuses every notice row', () => {
    for (const kind of ['teammate_report', 'approval_result', 'greeting', 'packages-ack', 'work_run', 'flow_run']) {
      expect(canRateMessage(message('assistant', { kind }), false), kind).toBe(false)
    }
  })
  it('refuses the rest', () => {
    expect(canRateMessage(message('assistant'), true)).toBe(false)
    expect(canRateMessage(message('user'), false)).toBe(false)
    expect(canRateMessage(message('system'), false)).toBe(false)
    expect(canRateMessage(message('assistant', { kind: 'teammate_report' }), false)).toBe(false)
    expect(canRateMessage(message('assistant', undefined, '   '), false)).toBe(false)
  })
})

describe('ChatMessage: thumbs', () => {
  let container: HTMLDivElement
  let root: Root
  let posts: Array<Record<string, unknown>>
  let store: MessageFeedbackStore

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    posts = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        posts.push(body)
        return new Response(JSON.stringify({ rating: body.rating ?? null }), { status: 200 })
      }),
    )
    store = createMessageFeedbackStore('c1')
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const render = (m: UIMessage, opts: { streaming?: boolean; provided?: boolean } = {}) => {
    const el = h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA', streaming: opts.streaming ?? false })
    act(() => root.render(opts.provided === false ? el : h(MessageFeedbackContext.Provider, { value: store }, el)))
  }
  const thumb = (which: 'up' | 'down') => container.querySelector<HTMLButtonElement>(`[data-message-feedback="${which}"]`)
  const click = async (el: Element | null) => {
    await act(async () => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('shows beside Copy on a settled reply', () => {
    render(message('assistant', { eve_written: true }))
    expect(thumb('up')).not.toBeNull()
    expect(thumb('down')).not.toBeNull()
    // In the same hover-revealed actions row as Copy.
    expect(thumb('up')!.closest('[data-message-actions]')).not.toBeNull()
  })

  it('shows nothing while streaming, on a user message, on a notice row, or without the context', () => {
    render(message('assistant'), { streaming: true })
    expect(thumb('up')).toBeNull()
    render(message('user'))
    expect(thumb('up')).toBeNull()
    render(message('assistant', { kind: 'teammate_report' }))
    expect(thumb('up')).toBeNull()
    render(message('assistant', { kind: 'home_turn' }))
    expect(thumb('up')).not.toBeNull()
    render(message('assistant'), { provided: false })
    expect(thumb('up')).toBeNull()
  })

  it('rates up, and clicking the active thumb clears it', async () => {
    render(message('assistant'))
    await click(thumb('up'))
    expect(thumb('up')!.getAttribute('aria-pressed')).toBe('true')
    await click(thumb('up'))
    expect(thumb('up')!.getAttribute('aria-pressed')).toBe('false')
    expect(posts.map((p) => p.rating)).toEqual(['up', null])
  })

  it('a thumbs-down saves at once and asks what went wrong; Skip keeps it', async () => {
    render(message('assistant'))
    await click(thumb('down'))
    expect(posts).toEqual([{ conversationId: 'c1', messageId: 'm1', rating: 'down' }])
    expect(document.body.textContent).toContain('What went wrong?')
    expect(thumb('down')!.hasAttribute('data-feedback-open')).toBe(true)
    const skip = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Skip')
    await click(skip!)
    expect(document.body.textContent).not.toContain('What went wrong?')
    expect(thumb('down')!.getAttribute('aria-pressed')).toBe('true')
    expect(posts).toHaveLength(1)
  })

  it('Send adds the reason', async () => {
    render(message('assistant'))
    await click(thumb('down'))
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-message-feedback-reason] textarea')!
    expect(textarea.maxLength).toBe(500)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'It picked the wrong contact')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')
    await click(send!)
    expect(posts[1]).toEqual({ conversationId: 'c1', messageId: 'm1', rating: 'down', reason: 'It picked the wrong contact' })
    expect(document.body.textContent).not.toContain('What went wrong?')
  })

  it('a chat reply’s thumbs-down keeps the words box alone: no nudge reason chips', async () => {
    render(message('assistant'))
    await click(thumb('down'))
    expect(document.querySelector('[data-message-feedback-reason] textarea')).not.toBeNull()
    expect(document.querySelector('[data-nudge-reasons]')).toBeNull()
  })
})
