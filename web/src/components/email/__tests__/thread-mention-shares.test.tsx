// @vitest-environment jsdom
/**
 * ThreadMentionShares — the owner's list of who a mail thread is shared with by
 * an @-mention (migration 673), with Stop sharing. No @testing-library/react:
 * react-dom/client createRoot + act, and Radix's AlertDialog stubbed to plain
 * elements (the shared-conversation-dialog pattern). Made-up people (Ben, Dana).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? h('div', {}, children) : null),
  AlertDialogContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogAction: ({ children, ...props }: { children?: ReactNode }) => h('button', props, children),
  AlertDialogCancel: ({ children, ...props }: { children?: ReactNode }) => h('button', props, children),
}))
const hoisted = vi.hoisted(() => ({
  openMention: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))
const toast = hoisted.toast
vi.mock('@/lib/entity-links/open-mention', () => ({ openMention: (...a: unknown[]) => hoisted.openMention(...a) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))

import { ThreadMentionShares } from '../thread-mention-shares'

const SHARES = [
  { id: 's1', threadIndexId: 'idx1', providerThreadId: 'thr-1', granteeMemberId: 'm-ben', granteeName: 'Ben', createdAt: '2026-11-10T10:00:00.000Z', source: { type: 'comment', id: null, label: 'a comment' } },
  { id: 's2', threadIndexId: 'idx1', providerThreadId: 'thr-1', granteeMemberId: 'm-dana', granteeName: 'Dana', createdAt: '2026-11-11T10:00:00.000Z', source: { type: 'document', id: 'doc1', label: 'Harbor plan' } },
]

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function render(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  await act(async () => {
    root.render(h(ThreadMentionShares, { threadIndexId: 'idx1', fetchImpl }))
  })
  await flush()
}

function click(selector: string) {
  const el = container.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`no element for ${selector}`)
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ThreadMentionShares', () => {
  it('renders nothing when there are no shares', async () => {
    await render(vi.fn(async () => jsonResponse({ shares: [] })))
    expect(container.querySelector('[data-thread-mention-shares]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders a row per share, with grantee and source', async () => {
    await render(vi.fn(async () => jsonResponse({ shares: SHARES })))
    expect(container.querySelectorAll('[data-mention-share]')).toHaveLength(2)
    expect(container.textContent).toContain('Ben')
    expect(container.textContent).toContain('Dana')
    expect(container.textContent).toContain('Harbor plan')
  })

  it('Stop sharing confirms, calls DELETE and removes the row', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? jsonResponse({ ok: true }) : jsonResponse({ shares: SHARES }),
    )
    await render(fetchImpl)
    expect(container.querySelectorAll('[data-mention-share]')).toHaveLength(2)
    click('[data-mention-share-stop="s1"]')
    await flush()
    // The confirm action is now shown; confirming calls DELETE and drops the row.
    click('[data-mention-share-confirm="s1"]')
    await flush()
    const deleteCall = fetchImpl.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')
    expect(deleteCall?.[0]).toBe('/api/account/email/thread-shares/s1')
    expect(container.querySelector('[data-mention-share="s1"]')).toBeNull()
    expect(container.querySelectorAll('[data-mention-share]')).toHaveLength(1)
    expect(toast.success).toHaveBeenCalled()
  })

  it('a failed DELETE restores the row', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? jsonResponse({}, false, 500) : jsonResponse({ shares: SHARES }),
    )
    await render(fetchImpl)
    click('[data-mention-share-stop="s1"]')
    await flush()
    click('[data-mention-share-confirm="s1"]')
    await flush()
    expect(toast.error).toHaveBeenCalled()
    // Reloaded from the server: the row is back.
    expect(container.querySelector('[data-mention-share="s1"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-mention-share]')).toHaveLength(2)
  })
})
