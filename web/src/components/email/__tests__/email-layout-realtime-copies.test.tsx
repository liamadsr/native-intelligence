// @vitest-environment jsdom
/**
 * Mail's live updates and the per-workspace thread copies. A thread has a copy
 * per workspace its mailbox is linked to, and the list holds the current
 * workspace's. Another workspace's copy changing is not this list's business,
 * and a DELETE carries only the gone row's id (RLS strips the old row to its
 * primary key), so a row goes by its id: matching the old row's
 * provider_thread_id, as before, matched nothing and removed nothing.
 *
 * The REAL layout is mounted; the realtime channel, the list and the pane are
 * stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (payload: { new?: unknown; old?: unknown }) => void
const realtime = vi.hoisted(() => ({ handlers: {} as Record<string, (payload: { new?: unknown; old?: unknown }) => void> }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_kind: string, filter: { event: string }, handler: Handler) => {
      realtime.handlers[filter.event] = handler
      return ch
    }
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))

const listed = vi.hoisted(() => ({
  threads: [
    { id: 'idx-a1', provider_thread_id: 'thr-1', subject: 'Pricing', is_unread: true },
    { id: 'idx-a2', provider_thread_id: 'thr-2', subject: 'Intro', is_unread: true },
  ],
}))
type Row = (typeof listed.threads)[number]
vi.mock('../email-thread-list', async () => {
  const React = await import('react')
  function EmailThreadList({ onSetterReady }: { onSetterReady: (setter: unknown) => void }) {
    const [threads, setThreads] = React.useState<Row[]>(listed.threads)
    React.useEffect(() => onSetterReady(setThreads), [onSetterReady])
    return h(
      'ul',
      null,
      threads.map((t) => h('li', { key: t.id, 'data-row': t.id, 'data-subject': t.subject, 'data-unread': String(!!t.is_unread) })),
    )
  }
  return { EmailThreadList }
})
vi.mock('../email-thread-detail', () => ({ EmailThreadDetail: () => null }))
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
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-a' }))

import { EmailLayout } from '../email-layout'

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  realtime.handlers = {}
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(h(EmailLayout, null)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const rows = () => [...container.querySelectorAll('[data-row]')].map((r) => `${r.getAttribute('data-row')}:${r.getAttribute('data-subject')}`)
const unread = () => [...container.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-unread'))
const fire = (event: string, payload: { new?: unknown; old?: unknown }) =>
  act(async () => realtime.handlers[event](payload))

describe('EmailLayout realtime — per-workspace thread copies', () => {
  it("another workspace's copy changing leaves the list alone; this workspace's copy patches its row", async () => {
    await fire('UPDATE', { new: { id: 'idx-b1', workspace_id: 'ws-b', provider_thread_id: 'thr-1', is_unread: false } })
    expect(rows()).toEqual(['idx-a1:Pricing', 'idx-a2:Intro'])
    expect(unread()).toEqual(['true', 'true'])

    // The index row carries no subject (no stored mail): a realtime patch
    // moves the flags and leaves the row's live header as it was.
    await fire('UPDATE', { new: { id: 'idx-a1', workspace_id: 'ws-a', provider_thread_id: 'thr-1', is_unread: false, subject: 'Leaked' } })
    expect(rows()).toEqual(['idx-a1:Pricing', 'idx-a2:Intro'])
    expect(unread()).toEqual(['false', 'true'])
  })

  it("a DELETE removes the row it names by id; another workspace's copy going removes nothing", async () => {
    await fire('DELETE', { old: { id: 'idx-b1' } })
    expect(rows()).toEqual(['idx-a1:Pricing', 'idx-a2:Intro'])

    await fire('DELETE', { old: { id: 'idx-a2' } })
    expect(rows()).toEqual(['idx-a1:Pricing'])
  })
})
