// @vitest-environment jsdom
/**
 * The agent's plan in the chat (update_plan, A4 slice 1): a compact checklist
 * under the reply, drawn from the tool's result. Only the reply's newest plan
 * draws in full; an earlier one folds to "Plan · N of M". A call in flight
 * draws nothing; a refused call keeps the generic chip ("Update plan"). The
 * in-progress step never spins (a stored reply would spin forever).
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
import { ChatMessageList } from '../chat-message-list'

const FIRST = [
  { text: 'Find the stale actions', status: 'in_progress' },
  { text: 'Close the done ones', status: 'pending' },
  { text: 'Summarize', status: 'pending' },
]
const SECOND = [
  { text: 'Find the stale actions', status: 'done' },
  { text: 'Close the done ones', status: 'in_progress' },
  { text: 'Summarize', status: 'pending' },
]

type Part = Record<string, unknown>
const planPart = (id: string, steps: unknown, over: Part = {}): Part => ({
  type: 'dynamic-tool',
  toolName: 'update_plan',
  toolCallId: id,
  state: 'output-available',
  input: { steps },
  output: { ok: true, plan: steps },
  ...over,
})
const message = (parts: Part[]): UIMessage => ({ id: 'a1', role: 'assistant', parts }) as unknown as UIMessage

describe('ChatMessage — the plan', () => {
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

  it('draws the plan as a checklist under the reply, never spinning', () => {
    render(message([{ type: 'text', text: 'On it.' }, planPart('call-1', FIRST)]))
    const card = container.querySelector('[data-chat-plan]')!
    expect(card.textContent).toContain('Plan · 0 of 3')
    expect([...card.querySelectorAll('[data-plan-step]')].map((li) => li.getAttribute('data-plan-step'))).toEqual(['in_progress', 'pending', 'pending'])
    expect(card.querySelector('.animate-spin')).toBeNull()
  })

  it('only the newest plan draws in full; an earlier one folds to one line', () => {
    render(message([planPart('call-1', FIRST), { type: 'text', text: 'Found 4.' }, planPart('call-2', SECOND)]))
    const cards = container.querySelectorAll('[data-chat-plan]')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('Plan · 1 of 3')
    const summaries = [...container.querySelectorAll('[data-plan-summary]')].map((el) => el.textContent)
    expect(summaries).toEqual(['Plan · 0 of 3'])
  })

  it('a refused call keeps the generic chip and is never the newest plan', () => {
    render(
      message([
        planPart('call-1', FIRST),
        planPart('call-2', [], { output: { ok: false, error: 'A plan needs at least one step.' } }),
      ]),
    )
    expect(container.querySelector('[data-chat-plan]')?.textContent).toContain('Plan · 0 of 3')
    expect(container.textContent).toContain('Update plan')
  })

  it('across replies, an earlier reply’s plan folds once a later reply has one (no stale checklist)', () => {
    const earlier = { id: 'a1', role: 'assistant', parts: [planPart('call-1', FIRST)] } as unknown as UIMessage
    const ask = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'keep going' }] } as unknown as UIMessage
    const later = { id: 'a2', role: 'assistant', parts: [planPart('call-2', SECOND)] } as unknown as UIMessage
    const list = (messages: UIMessage[]) =>
      act(() => root.render(h(ChatMessageList, { messages, latestUserMessageId: null, userAvatarUrl: null, userInitials: 'LA' })))
    list([earlier])
    expect(container.querySelectorAll('[data-chat-plan]')).toHaveLength(1)
    list([earlier, ask, later])
    const cards = container.querySelectorAll('[data-chat-plan]')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('Plan · 1 of 3')
    expect([...container.querySelectorAll('[data-plan-summary]')].map((el) => el.textContent)).toEqual(['Plan · 0 of 3'])
    // A later reply with no plan leaves the newest one standing.
    const plain = { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] } as unknown as UIMessage
    list([earlier, ask, later, plain])
    expect(container.querySelector('[data-chat-plan]')?.textContent).toContain('Plan · 1 of 3')
  })

  it('draws nothing while the call is in flight', () => {
    render(message([{ type: 'text', text: 'On it.' }, planPart('call-1', FIRST, { state: 'input-available', output: undefined })]))
    expect(container.querySelector('[data-chat-plan]')).toBeNull()
    expect(container.textContent).not.toContain('Update plan')
  })
})
