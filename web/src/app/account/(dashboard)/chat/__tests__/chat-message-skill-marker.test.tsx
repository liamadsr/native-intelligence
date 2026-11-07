// @vitest-environment jsdom
/**
 * The "via <skill>" marker under a seeded user turn.
 *
 * A button handoff ("Find email", "Learn about my company") auto-sends a
 * sentence the user never typed, and the skill chip clears at send — so without
 * this the turn is indistinguishable in the transcript from something they
 * wrote themselves. The name rides on the message's `metadata`, which is what
 * the two handoffs attach and what `chat_messages.ui_message` stores verbatim.
 *
 * The negatives matter as much as the positive: a turn the user actually typed
 * carries no metadata and must stay unmarked, and an ASSISTANT reply must never
 * be marked — the metadata is about who wrote the prompt, not which skill ran.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, detailPanel: unknown) => ({
    location: { kind: 'view', view },
    view,
    detailPanel,
  }),
}))

vi.mock('../../../workspace-switcher', () => ({
  useWorkspaceEdition: () => 'full',
}))

// Clipboard helper touches navigator APIs jsdom doesn't implement.
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { ChatMessage } from '../chat-message'

function message(
  role: 'user' | 'assistant',
  metadata?: Record<string, unknown>,
): UIMessage {
  return {
    id: 'm1',
    role,
    parts: [{ type: 'text', text: 'The user clicked Find email on the contact Ada Lovelace.' }],
    ...(metadata ? { metadata } : {}),
  } as UIMessage
}

describe('ChatMessage — the seeded-skill marker', () => {
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

  function render(m: UIMessage) {
    act(() => {
      root.render(h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA' }))
    })
  }

  it('marks a seeded user turn "via <skillName>"', () => {
    render(message('user', { skillSlug: 'find-email', skillName: 'Find email' }))
    expect(container.textContent).toContain('via Find email')
  })

  it('uses the skill NAME, not its slug — "via Scout", never "via scout"', () => {
    render(message('user', { skillSlug: 'scout', skillName: 'Scout' }))
    expect(container.textContent).toContain('via Scout')
    expect(container.textContent).not.toContain('via scout')
  })

  it('leaves a turn the user actually typed unmarked', () => {
    render(message('user'))
    expect(container.textContent).not.toContain('via ')
  })

  it('never marks an assistant reply, even carrying the metadata', () => {
    // Metadata on an assistant message would be a different claim entirely
    // ("this reply came from a skill"), and nothing sets it. Guard anyway: the
    // marker reads as authorship, and mislabelling the model's own words is
    // worse than showing nothing.
    render(message('assistant', { skillSlug: 'find-email', skillName: 'Find email' }))
    expect(container.textContent).not.toContain('via Find email')
  })
})
