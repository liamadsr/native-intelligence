// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from '@ai-sdk/react'

vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, detailPanel: unknown) => ({ location: { kind: 'view', view }, view, detailPanel }),
}))
vi.mock('../../../workspace-switcher', () => ({ useWorkspaceEdition: () => 'full' }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => createElement('span', { 'data-thinking-orb': '' }) }))

import { ChatMessage } from '../chat-message'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const reasoning = { type: 'reasoning', text: 'Check the browser result before answering.', state: 'streaming' } as const
function render(parts: UIMessage['parts'], streaming = false) {
  act(() => root.render(createElement(ChatMessage, {
    message: { id: 'assistant-1', role: 'assistant', parts }, streaming,
    userAvatarUrl: null, userInitials: 'LA',
  })))
}

describe('reasoning follows the actual message lifecycle', () => {
  it('renders a historical streaming part as settled without changing its stored state', () => {
    render([reasoning])
    expect(container.textContent).toContain('Thought for a bit')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.querySelector('.shimmer-text')).toBeNull()
    expect(reasoning.state).toBe('streaming')
  })

  it('keeps current reasoning live, then clears the indicator when the message stops', () => {
    render([reasoning], true)
    expect(container.textContent).toContain('Thinking')
    expect(container.querySelector('.shimmer-text')).not.toBeNull()
    // Collapsed: the reasoning itself is not in the thread while it streams.
    expect(container.textContent).not.toContain('Check the browser result')
    render([reasoning], false)
    expect(container.textContent).toContain('Thought for a bit')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.querySelector('.shimmer-text')).toBeNull()
  })

  it('does not animate an old reasoning part ahead of a later completed tool in the same active message', () => {
    render([reasoning, { type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'fetch-1',
      state: 'output-available', input: { url: 'https://example.com' }, output: { success: true } }], true)
    expect(container.textContent).toContain('Thought for a bit')
    expect(container.textContent).toContain('Done')
    expect(container.textContent).not.toContain('Thinking')
    expect(container.querySelector('.shimmer-text')).toBeNull()
  })

  it('keeps explicitly closed reasoning settled even while the message remains active', () => {
    render([{ ...reasoning, state: 'done' }], true)
    expect(container.textContent).toContain('Thought for a bit')
    expect(container.textContent).not.toContain('Thinking')
  })
})
