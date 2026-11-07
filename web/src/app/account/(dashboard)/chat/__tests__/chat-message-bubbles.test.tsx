// @vitest-environment jsdom
/**
 * A reply's text is a white bubble, and text that is only whitespace (a
 * model's stray newline before a tool call) draws none: in a bubble it was an
 * empty pill above the tool's row.
 */
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
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(parts: UIMessage['parts']) {
  act(() =>
    root.render(
      createElement(ChatMessage, {
        message: { id: 'assistant-1', role: 'assistant', parts },
        streaming: false,
        userAvatarUrl: null,
        userInitials: 'LA',
      }),
    ),
  )
}

const bubbles = () => Array.from(container.querySelectorAll('.rounded-\\[22px\\]'))

describe('reply bubbles', () => {
  it('draws no bubble for whitespace-only text', () => {
    render([
      { type: 'text', text: '\n\n', state: 'done' },
      { type: 'dynamic-tool', toolName: 'open_browser', toolCallId: 't1', state: 'output-available', input: {}, output: { success: true } },
      { type: 'text', text: "The browser's open now. What do you want to do in it?", state: 'done' },
    ])
    expect(bubbles()).toHaveLength(1)
    expect(bubbles()[0].textContent).toContain("The browser's open now.")
  })
})
