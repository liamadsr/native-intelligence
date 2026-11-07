// @vitest-environment jsdom
/**
 * Tool calls in a reply: a generic tool is ONE collapsed line (shimmering
 * while it runs, static with its scope line once done), the web search's
 * sources sit behind its disclosure, and the tools whose rendering IS the
 * answer or an interaction (remember's chip, an answered question) draw
 * exactly as before.
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

const scope = { window: 'past_4_weeks', since: '2026-09-10T00:00:00.000Z', until: null, transcripts: false, attachments: false }

function message(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts } as unknown as UIMessage
}

describe('ChatMessage tool rows', () => {
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
  const render = (m: UIMessage, streaming = false) =>
    act(() => root.render(h(ChatMessage, { message: m, streaming, userAvatarUrl: null, userInitials: 'LA' })))

  it('a running generic tool shimmers its label; once done it is static, collapsed, with the scope line', () => {
    const running = { type: 'dynamic-tool', toolName: 'find', toolCallId: 'f1', state: 'input-available', input: { query: 'acme' } }
    render(message([running]), true)
    expect(container.querySelector('.shimmer-text')?.textContent).toBe('Search workspace')

    render(message([{ ...running, state: 'output-available', output: { results: [{ title: 'RAW RESULT ROW' }], scope } }]), true)
    expect(container.querySelector('.shimmer-text')).toBeNull()
    expect(container.textContent).toContain('Done')
    expect(container.querySelector('[data-search-scope]')?.textContent).toBe('· Past 4 weeks')
    expect(container.textContent).not.toContain('RAW RESULT ROW')

    act(() => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('RAW RESULT ROW')
  })

  it('web search results stay behind the disclosure', () => {
    render(message([{
      type: 'dynamic-tool', toolName: 'web_search', toolCallId: 'w1', state: 'output-available', input: { query: 'acme' },
      output: { requestId: 'r', results: [{ id: 'a', url: 'https://acme.com', title: 'Acme raises' }] },
    }]))
    expect(container.textContent).toContain('Searched the web')
    expect(container.textContent).not.toContain('Acme raises')
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('special tools are unchanged: the Remembered chip and an answered question draw in full', () => {
    render(message([
      { type: 'dynamic-tool', toolName: 'remember', toolCallId: 'm1', state: 'output-available', input: {},
        output: { success: true, remembered: { id: 'line-1', area: 'mail', area_name: 'Mail', scope: 'personal', status: 'active', text: 'Sign off with Best' } } },
      { type: 'dynamic-tool', toolName: 'ask_user', toolCallId: 'q1', state: 'output-available', input: {},
        output: { answers: { 'Which region?': 'EMEA' } } },
    ]))
    expect(container.querySelector('[data-testid="remembered-chip"]')?.textContent).toContain('Remembered: Sign off with Best')
    expect(container.textContent).toContain('Which region?')
    expect(container.textContent).toContain('EMEA')
    expect(container.querySelector('.shimmer-text')).toBeNull()
  })
})
