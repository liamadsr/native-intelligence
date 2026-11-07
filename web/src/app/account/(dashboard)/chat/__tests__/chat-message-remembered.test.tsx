// @vitest-environment jsdom
/**
 * A `remember` call in the chat renders the "Remembered: …" chip with Undo
 * (one-agent plan Part 3, "Memory"); a failed save keeps the generic tool chip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({ work: { rows: [], cardRows: [], roster: [] }, attention: { items: [] }, counts: new Map() }),
}))
vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, detailPanel: unknown) => ({ location: { kind: 'view', view }, view, detailPanel }),
}))
vi.mock('../../../workspace-switcher', () => ({
  useWorkspaceEdition: () => 'full',
  useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1', refresh: () => {} }),
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { ChatMessage } from '../chat-message'

function message(output: unknown): UIMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Got it.' },
      { type: 'dynamic-tool', toolName: 'remember', toolCallId: 'call-1', state: 'output-available', input: { area: 'mail', text: 'x' }, output },
    ],
  } as unknown as UIMessage
}

describe('ChatMessage — remember', () => {
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

  it('shows the Remembered chip with Undo for a saved line', () => {
    render(message({ success: true, remembered: { id: 'line-1', area: 'mail', area_name: 'Mail', scope: 'personal', status: 'active', text: "Sign off with 'Best, Liam'" } }))
    const chip = container.querySelector('[data-testid="remembered-chip"]')
    expect(chip?.textContent).toContain("Remembered: Sign off with 'Best, Liam'")
    expect(chip?.textContent).toContain('Undo')
  })

  it('carries `already` to the chip: no Undo for a line this call didn’t make', () => {
    render(message({ success: true, already: true, remembered: { id: 'line-1', area: 'mail', area_name: 'Mail', scope: 'personal', status: 'active', text: 'Be brief' } }))
    const chip = container.querySelector('[data-testid="remembered-chip"]')
    expect(chip?.textContent).toContain('Already remembered: Be brief')
    expect(chip?.querySelector('button')).toBeNull()
  })

  it('keeps the generic chip for a save that failed', () => {
    render(message({ success: false, code: 'NOTE_FULL', error: 'full' }))
    expect(container.querySelector('[data-testid="remembered-chip"]')).toBeNull()
    expect(container.textContent).toContain('Remember')
  })
})
