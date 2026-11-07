// @vitest-environment jsdom
/**
 * The "Stopped" caption (UI-2): a reply Stop or Send now ended where it was
 * says so in one line — live (the panel stamps metadata.stopped) and on reload
 * (the transport persists it). A finished reply and a user message never do.
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

const message = (role: 'user' | 'assistant', metadata?: Record<string, unknown>): UIMessage =>
  ({ id: 'm1', role, parts: [{ type: 'text', text: 'Here is a long dr' }], ...(metadata ? { metadata } : {}) }) as UIMessage

describe('ChatMessage — the Stopped caption', () => {
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
  const caption = () => container.querySelector('[data-chat-reply-stopped]')

  it('a stopped reply says "Stopped"', () => {
    render(message('assistant', { eve_written: true, stopped: true }))
    expect(caption()?.textContent).toBe('Stopped')
  })

  it('a finished reply and a user message say nothing', () => {
    render(message('assistant', { eve_written: true }))
    expect(caption()).toBeNull()
    render(message('user', { stopped: true }))
    expect(caption()).toBeNull()
  })
})
