// @vitest-environment jsdom
/**
 * A mail card's header counts every thread its list holds (1602), and the
 * Inbox badge counts the unread ones (1095): both right, different numbers.
 * The badge says which it is, so the two never read as a disagreement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = () => ch
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))

interface ListProps {
  folder: string
  search?: string
  accountIds?: string[] | null
  extraParams?: Record<string, string>
  onThreadSelect: (t: unknown) => void
  onThreadsLoaded?: (t: unknown[]) => void
  onTotal?: (n: number) => void
}
/** The latest props of each mounted list: the card's passes onTotal, the page's does not. */
const lists: { page?: ListProps; card?: ListProps } = {}
vi.mock('../email-thread-list', () => ({
  EmailThreadList: (props: ListProps) => {
    lists[props.onTotal ? 'card' : 'page'] = props
    return h('div', { 'data-list': props.folder })
  },
}))
vi.mock('../email-thread-detail', () => ({ EmailThreadDetail: ({ threadId }: { threadId: string }) => h('div', { 'data-detail': threadId }) }))
vi.mock('@/components/account-filter-dropdown', () => ({ AccountFilterDropdown: () => null }))
vi.mock('@/components/views/view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('@/components/views/expandable-search', () => ({ ExpandableSearch: () => null }))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => h('div', null, children),
  SelectContent: ({ children }: { children: ReactNode }) => h('div', { 'data-folder-menu': '' }, children),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => h('div', { 'data-folder-item': value }, children),
  SelectTrigger: ({ children }: { children: ReactNode }) => h('div', { 'data-folder-trigger': '' }, children),
}))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => h('div', { 'data-two-panes': '' }, children),
  ResizablePanel: ({ children }: { children: ReactNode }) => h('div', null, children),
  ResizableHandle: () => null,
}))
vi.mock('@/components/views/hooks/use-view', () => ({
  useView: () => ({ views: [], activeViewId: null, activeView: null, setActiveViewId: () => {}, createView: () => {}, updateView: () => {}, deleteView: () => {}, duplicateView: () => {} }),
  useViewConfig: () => ({ config: { filters: [] }, updateConfig: () => {}, isDirty: false, overrides: null, saveOverrides: () => {}, discardOverrides: () => {} }),
}))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
// The page is in the focused window.
vi.mock('@/components/views/unified-view-layout', () => ({ useIsWindowFocused: () => true }))

const { EmailLayout } = await import('../email-layout')


let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (String(url).includes('/email/counts') ? { inbox_unread: 1095, inbox_total: 1602, drafts: 3 } : {}) })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the Inbox badge', () => {
  it('says its number is the unread threads', async () => {
    await act(async () => {
      root.render(h('div', { 'data-chat-card': 'c1' }, h(EmailLayout, { card: { initial: { folder: 'inbox', search: '', accounts: null, threadId: null }, fullScreen: true } })))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('[data-folder-count]')?.textContent).toBe('1095 unread')
    expect(container.querySelector('[data-folder-item="inbox"]')?.textContent).toContain('1095 unread')
    // Drafts counts drafts: no unit to add.
    expect(container.querySelector('[data-folder-item="drafts"]')?.textContent).toMatch(/Drafts3$/)
  })
})
