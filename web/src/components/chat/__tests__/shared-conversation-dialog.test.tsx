// @vitest-environment jsdom
/**
 * SharedConversationDialog — the read-only viewer for an agent chat
 * (docs/plans/mentions-everywhere.md JOB 2). It opens on a
 * `ni:open-conversation` window event, reads the shared route, and shows the
 * title, "Shared by <name>" / "Your chat", and the messages as bubbles, with a
 * not-found line when the chat isn't the reader's. Radix portals are not under
 * test: the dialog + message primitives are stubbed to plain elements (the
 * company-delete-dialog pattern). Fixtures are made up (Ana, Harbor).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? h('div', {}, children) : null),
  DialogContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => h('div', { 'data-testid': 'title' }, children),
}))
vi.mock('@/components/ui/message', () => ({
  MessageContent: ({ children }: { children?: ReactNode }) => h('div', { 'data-testid': 'bubble' }, children),
}))
vi.mock('@/components/ui/loader', () => ({ Loader: () => h('div', { 'data-testid': 'loader' }) }))

import { SharedConversationDialog } from '../shared-conversation-dialog'
import { OPEN_CONVERSATION_EVENT } from '@/lib/chat/open-conversation'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(SharedConversationDialog)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

async function open(id: string) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: { id, title: 'Harbor chat' } }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SharedConversationDialog', () => {
  it('reads the route and shows the owner line and the bubbles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'c1',
      title: 'Harbor chat',
      role: 'grantee',
      ownerName: 'Ana',
      messages: [
        { id: 'u1', role: 'user', text: 'What did Harbor decide?', createdAt: null },
        { id: 'a1', role: 'assistant', text: 'The north dock.', createdAt: null },
      ],
    })))
    await open('c1')
    expect(container.querySelector('[data-testid="title"]')?.textContent).toBe('Harbor chat')
    expect(container.textContent).toContain('Shared by Ana')
    const bubbles = container.querySelectorAll('[data-testid="bubble"]')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].textContent).toBe('What did Harbor decide?')
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe('/api/account/conversations/c1/shared')
  })

  it('shows the not-found line on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Not found' }, false, 404)))
    await open('c1')
    expect(container.textContent).toContain("isn't shared with you, or no longer exists")
    expect(container.querySelector('[data-testid="bubble"]')).toBeNull()
  })
})
