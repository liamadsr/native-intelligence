// @vitest-environment jsdom
/**
 * A draft sent from the open thread (the pane's onDraftSent). In Drafts, where
 * a work item's "Review draft" lands, the thread is no longer a draft: the list
 * drops it and the pane closes, as Archive and Delete do. In the Inbox it
 * stays, answered, with the pane open. Either way the folder counts (the
 * Drafts badge) are fetched again.
 *
 * A draft discarded from the open thread (onDraftDiscarded) goes the same way,
 * except that a thread that was nothing but the draft leaves every folder.
 * The REAL layout is mounted; the list and the pane are stand-ins that expose
 * what the layout hands them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const listed = vi.hoisted(() => ({
  threads: [
    { provider_thread_id: 'thr-1', subject: 'Exploratory Meeting', needs_reply: true, is_unread: false },
    { provider_thread_id: 'thr-2', subject: 'Complete with Docusign', needs_reply: false, is_unread: false },
  ],
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => {
      const ch: Record<string, unknown> = {}
      ch.on = () => ch
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: () => {},
  }),
}))

type Row = (typeof listed.threads)[number]
interface ListProps {
  folder: string
  onThreadSelect: (t: Row) => void
  onThreadsLoaded: (t: Row[]) => void
  onSetterReady: (setter: unknown) => void
}
vi.mock('../email-thread-list', async () => {
  const React = await import('react')
  function EmailThreadList({ folder, onThreadSelect, onThreadsLoaded, onSetterReady }: ListProps) {
    const [threads, setThreads] = React.useState(listed.threads)
    React.useEffect(() => onSetterReady(setThreads), [onSetterReady])
    React.useEffect(() => onThreadsLoaded(listed.threads), [folder, onThreadsLoaded])
    return h(
      'ul',
      { 'data-folder': folder },
      threads.map((t) =>
        h('li', { key: t.provider_thread_id, 'data-row': t.provider_thread_id, 'data-needs-reply': String(t.needs_reply), onClick: () => onThreadSelect(t) }),
      ),
    )
  }
  return { EmailThreadList }
})
vi.mock('../email-thread-detail', () => ({
  EmailThreadDetail: ({
    threadId,
    onDraftSent,
    onDraftDiscarded,
  }: {
    threadId: string
    onDraftSent?: (id: string) => void
    onDraftDiscarded?: (id: string, threadRemains: boolean) => void
  }) =>
    h(
      'div',
      { 'data-pane': threadId },
      h('button', { onClick: () => onDraftSent?.(threadId) }, 'draft sent'),
      h('button', { onClick: () => onDraftDiscarded?.(threadId, true) }, 'draft discarded'),
      h('button', { onClick: () => onDraftDiscarded?.(threadId, false) }, 'draft discarded, thread gone'),
    ),
}))
vi.mock('@/components/account-filter-dropdown', () => ({ AccountFilterDropdown: () => null }))
vi.mock('@/components/views/view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('@/components/views/hooks/use-view', () => ({
  useView: () => ({
    views: [],
    activeViewId: null,
    activeView: null,
    setActiveViewId: () => {},
    createView: () => {},
    updateView: () => {},
    deleteView: () => {},
    duplicateView: () => {},
  }),
  useViewConfig: () => ({
    config: { filters: [] },
    updateConfig: () => {},
    isDirty: false,
    overrides: null,
    saveOverrides: () => {},
    discardOverrides: () => {},
  }),
}))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/components/views/unified-view-layout', () => ({
  useIsWindowFocused: () => true,
}))

import { EmailLayout } from '../email-layout'

/** A Mail card, full screen (both panes), open on Drafts on `thr-1` (where Review draft lands). */
const draftsCard = () =>
  h(EmailLayout, { card: { initial: { folder: 'drafts', search: '', accounts: null, threadId: 'thr-1' }, fullScreen: true } })

let fetched: string[] = []
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fetched = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url)
      return { ok: true, json: async () => ({}) } as unknown as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const rows = () => [...container.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))
const pane = () => container.querySelector('[data-pane]')?.getAttribute('data-pane') ?? null
const counts = () => fetched.filter((u) => u === '/api/account/email/counts').length
const click = (el: Element | null) => act(async () => (el as HTMLElement).click())
const paneButton = (text: string) => click([...container.querySelectorAll('button')].find((b) => b.textContent === text) ?? null)
const draftSent = () => paneButton('draft sent')

describe('EmailLayout — a draft sent from the open thread', () => {
  it('in Drafts (where Review draft lands) the thread leaves the list and the pane closes', async () => {
    await act(async () => root.render(draftsCard()))
    expect(container.querySelector('[data-folder]')?.getAttribute('data-folder')).toBe('drafts')
    expect(pane()).toBe('thr-1')

    const before = counts()
    await draftSent()
    expect(rows()).toEqual(['thr-2'])
    expect(pane()).toBeNull()
    expect(counts()).toBe(before + 1)
  })

  it('in the Inbox the thread stays, answered, with the pane open', async () => {
    await act(async () => root.render(h(EmailLayout, null)))
    await click(container.querySelector('[data-row="thr-1"]'))
    expect(pane()).toBe('thr-1')

    const before = counts()
    await draftSent()
    expect(rows()).toEqual(['thr-1', 'thr-2'])
    expect(container.querySelector('[data-row="thr-1"]')?.getAttribute('data-needs-reply')).toBe('false')
    expect(pane()).toBe('thr-1')
    expect(counts()).toBe(before + 1)
  })
})

describe('EmailLayout — a draft discarded from the open thread', () => {
  it('in Drafts the thread leaves the list and the pane closes', async () => {
    await act(async () => root.render(draftsCard()))
    expect(pane()).toBe('thr-1')
    const before = counts()
    await paneButton('draft discarded')
    expect(rows()).toEqual(['thr-2'])
    expect(pane()).toBeNull()
    expect(counts()).toBe(before + 1)
  })

  it('in the Inbox the thread stays with the pane open, and the Drafts badge recounts', async () => {
    await act(async () => root.render(h(EmailLayout, null)))
    await click(container.querySelector('[data-row="thr-1"]'))
    const before = counts()
    await paneButton('draft discarded')
    expect(rows()).toEqual(['thr-1', 'thr-2'])
    expect(pane()).toBe('thr-1')
    expect(counts()).toBe(before + 1)
  })

  it('a thread that was nothing but the draft leaves the Inbox too, and the pane closes', async () => {
    await act(async () => root.render(h(EmailLayout, null)))
    await click(container.querySelector('[data-row="thr-1"]'))
    await paneButton('draft discarded, thread gone')
    expect(rows()).toEqual(['thr-2'])
    expect(pane()).toBeNull()
  })
})
