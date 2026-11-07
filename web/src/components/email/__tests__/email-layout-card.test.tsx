// @vitest-environment jsdom
/**
 * Mail as a card in the chat (docs/plans/one-agent-and-chat-pages.md, P2),
 * mounted beside the Mail page as it is when a Mail window is open over a
 * chat with a mail card:
 *   - the card opens on its own folder, search, mailboxes or thread, and the
 *     page on its own; neither moves the other;
 *   - a key acts once: in the card it came from (or the full-screen card
 *     when nothing has focus), else in the focused page, never both;
 *   - inline a card is one pane (the list, or the open thread), full screen
 *     two.
 * The real EmailLayout is mounted; the list, detail and controls are stubs.
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
  Select: ({ value, onValueChange }: { value: string; onValueChange: (v: string) => void }) =>
    h('button', { 'data-folder': value, onClick: () => onValueChange('archive') }),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
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

const T = (id: string, from = 'Sarah') => ({ provider_thread_id: id, from_name: from, subject: `S ${id}`, is_unread: false })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  lists.page = undefined
  lists.card = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function cardOf(initial: Partial<{ folder: string; search: string; unread: boolean; accounts: string[] | null; threadId: string | null }>, opts: { fullScreen?: boolean; onStateChange?: () => void; onThreads?: () => void } = {}) {
  return {
    initial: { folder: 'inbox', search: '', accounts: null, threadId: null, ...initial },
    fullScreen: !!opts.fullScreen,
    onStateChange: opts.onStateChange,
    onThreads: opts.onThreads,
  }
}

async function mount(card: ReturnType<typeof cardOf> | null, opts: { page?: boolean; fullScreen?: boolean } = {}) {
  const frame = opts.fullScreen ? { 'data-chat-card-fullscreen': 'c1', tabIndex: -1 } : { 'data-chat-card': 'c1' }
  await act(async () => {
    root.render(
      h('div', null,
        opts.page === false ? null : h('div', { 'data-page': '' }, h(EmailLayout)),
        card ? h('div', { ...frame, 'data-card': '' }, h(EmailLayout, { card })) : null,
      ),
    )
  })
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
function key(target: EventTarget, k: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

describe('a mail card beside the Mail page', () => {
  it('opens on its own folder, search and mailboxes, and the page on the inbox', async () => {
    await mount(cardOf({ folder: 'archive', search: 'acme', accounts: ['acct-work'] }))
    expect(lists.card).toMatchObject({ folder: 'archive', search: 'acme', accountIds: ['acct-work'] })
    expect(lists.page).toMatchObject({ folder: 'inbox', search: '', accountIds: null })
  })

  it('a folder change in the card is the card’s, reported once', async () => {
    const onStateChange = vi.fn()
    await mount(cardOf({ folder: 'inbox' }, { onStateChange }))
    await act(async () => (container.querySelector('[data-card] [data-folder]') as HTMLElement).click())
    expect(lists.card?.folder).toBe('archive')
    expect(lists.page?.folder).toBe('inbox')
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith({ folder: 'archive', search: '', unread: false, accounts: null, threadId: null, threadFrom: null })
  })

  it('lists only the mailboxes show counts (readable), with its own unread toggle', async () => {
    const onStateChange = vi.fn()
    await mount(cardOf({ unread: true } as never, { onStateChange }))
    expect(lists.card?.extraParams).toEqual({ readable: '1', unread_only: 'true' })
    // The page lists as before.
    expect(lists.page?.extraParams).toEqual({})
    await act(async () => (container.querySelector('[data-card] [data-unread-toggle]') as HTMLElement).click())
    expect(lists.card?.extraParams).toEqual({ readable: '1' })
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ unread: false }))
    expect(container.querySelector('[data-page] [data-unread-toggle]')).toBeNull()
  })

  it('reports the threads it lists and their total', async () => {
    const onThreads = vi.fn()
    await mount(cardOf({}, { onThreads }), { page: false })
    act(() => {
      lists.card?.onTotal?.(42)
      lists.card?.onThreadsLoaded?.([T('t1'), T('t2')])
    })
    await act(async () => {})
    expect(onThreads).toHaveBeenLastCalledWith([expect.objectContaining({ provider_thread_id: 't1' }), expect.objectContaining({ provider_thread_id: 't2' })], 42)
  })
})

describe('Back and Forward in the card (its history’s place)', () => {
  it('goes to the folder and thread the place moves to, reporting it, and never where it already is', async () => {
    const onStateChange = vi.fn()
    const card = (place: { folder: string; threadId: string | null }) => ({ ...cardOf({ folder: 'inbox' }, { onStateChange }), place })
    await mount(card({ folder: 'inbox', threadId: null }), { page: false })
    // The person opens a thread: the place follows them (nothing to apply).
    act(() => lists.card?.onThreadSelect(T('t1')))
    expect(q('[data-card] [data-detail="t1"]')).not.toBeNull()
    await mount(card({ folder: 'inbox', threadId: 't1' }), { page: false })
    expect(q('[data-card] [data-detail="t1"]')).not.toBeNull()
    onStateChange.mockClear()

    // Back: to the list.
    await mount(card({ folder: 'inbox', threadId: null }), { page: false })
    expect(q('[data-card] [data-detail]')).toBeNull()
    expect(lists.card?.folder).toBe('inbox')
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ folder: 'inbox', threadId: null }))

    // Forward into another folder's thread, by its id alone.
    await mount(card({ folder: 'archive', threadId: 't7' }), { page: false })
    expect(q('[data-card] [data-detail="t7"]')).not.toBeNull()
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ folder: 'archive', threadId: 't7' }))
  })
})

describe('one pane inline, two full screen', () => {
  it('inline: a thread card shows the thread alone; full screen: the list beside it', async () => {
    await mount(cardOf({ threadId: 't9' }), { page: false })
    expect(q('[data-card] [data-detail="t9"]')).not.toBeNull()
    expect(q('[data-card] [data-list]')).toBeNull()
    expect(q('[data-card] [data-two-panes]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mount(cardOf({ threadId: 't9' }, { fullScreen: true }), { page: false, fullScreen: true })
    expect(q('[data-card] [data-two-panes] [data-detail="t9"]')).not.toBeNull()
    expect(q('[data-card] [data-two-panes] [data-list]')).not.toBeNull()
  })
})

describe('session replay never records mail', () => {
  it('the page and the card (inline and full screen) put the list and the thread under ph-no-capture', async () => {
    await mount(cardOf({ threadId: 't9' }))
    expect(q('[data-page] > .ph-no-capture [data-list]')).not.toBeNull()
    expect(q('[data-card] > .ph-no-capture [data-detail="t9"]')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mount(cardOf({ threadId: 't9' }, { fullScreen: true }), { page: false, fullScreen: true })
    expect(q('[data-card] > .ph-no-capture [data-list]')).not.toBeNull()
    expect(q('[data-card] > .ph-no-capture [data-detail="t9"]')).not.toBeNull()
  })
})

describe('keys act once', () => {
  /**
   * The page and a card in its inline frame, each with a thread open in a
   * list of two (the card in its two-pane layout, so its list stays mounted).
   */
  async function bothOpen() {
    const onStateChange = vi.fn()
    await mount(cardOf({}, { fullScreen: true, onStateChange }), { fullScreen: false })
    act(() => {
      lists.page?.onThreadsLoaded?.([T('p1'), T('p2')])
      lists.card?.onThreadsLoaded?.([T('c1'), T('c2')])
    })
    act(() => {
      lists.page?.onThreadSelect(T('p1'))
      lists.card?.onThreadSelect(T('c1'))
    })
    return onStateChange
  }

  it('a key from inside the card moves the card, not the page', async () => {
    await bothOpen()
    key(q('[data-card] [data-detail]')!, 'j')
    expect(q('[data-card] [data-detail]')?.getAttribute('data-detail')).toBe('c2')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p1')

    key(q('[data-card] [data-detail]')!, 'Escape')
    expect(q('[data-card] [data-detail]')).toBeNull()
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p1')
  })

  it('a key from the page moves the page, not the card', async () => {
    await bothOpen()
    key(q('[data-page] [data-detail]')!, 'j')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p2')
    expect(q('[data-card] [data-detail]')?.getAttribute('data-detail')).toBe('c1')
  })

  it('with nothing focused, an inline card stays still and the page acts', async () => {
    await bothOpen()
    key(document.body, 'j')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p2')
    expect(q('[data-card] [data-detail]')?.getAttribute('data-detail')).toBe('c1')
  })

  it('a full-screen card acts on keys from its focused frame; Esc closes its thread and is used up', async () => {
    await mount(cardOf({}, { fullScreen: true }), { fullScreen: true })
    act(() => {
      lists.page?.onThreadsLoaded?.([T('p1'), T('p2')])
      lists.card?.onThreadsLoaded?.([T('c1'), T('c2')])
    })
    act(() => {
      lists.page?.onThreadSelect(T('p1'))
      lists.card?.onThreadSelect(T('c1'))
    })
    // The frame took the focus when it went full screen.
    const frame = q('[data-chat-card-fullscreen]')!
    act(() => frame.focus())
    key(frame, 'k')
    key(frame, 'j')
    expect(q('[data-card] [data-detail]')?.getAttribute('data-detail')).toBe('c2')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p1')

    // Esc after the card: the full-screen frame's own Esc handler sees it handled.
    const seen: boolean[] = []
    const after = (e: KeyboardEvent) => seen.push(e.defaultPrevented)
    window.addEventListener('keydown', after)
    key(frame, 'Escape')
    window.removeEventListener('keydown', after)
    expect(seen).toEqual([true])
    expect(q('[data-card] [data-detail]')).toBeNull()
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p1')
  })

  it('a full-screen card never takes the page’s keys: from the page (or the body) the page acts', async () => {
    await mount(cardOf({}, { fullScreen: true }), { fullScreen: true })
    act(() => {
      lists.page?.onThreadsLoaded?.([T('p1'), T('p2'), T('p3')])
      lists.card?.onThreadsLoaded?.([T('c1'), T('c2')])
    })
    act(() => {
      lists.page?.onThreadSelect(T('p1'))
      lists.card?.onThreadSelect(T('c1'))
    })
    key(q('[data-page] [data-detail]')!, 'j')
    key(document.body, 'j')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p3')
    expect(q('[data-card] [data-detail]')?.getAttribute('data-detail')).toBe('c1')
  })

  it('the Mail page keeps its keys while a card of another kind is full screen', async () => {
    await act(async () => {
      root.render(
        h('div', null,
          h('div', { 'data-page': '' }, h(EmailLayout)),
          // A calendar (or list) card full screen beside the page.
          h('div', { 'data-chat-card-fullscreen': 'cal', tabIndex: -1 }, h('div', { 'data-calendar': '' })),
        ),
      )
    })
    act(() => lists.page?.onThreadsLoaded?.([T('p1'), T('p2')]))
    act(() => lists.page?.onThreadSelect(T('p1')))
    // The person clicked a row on the page (focus on the page or the body) and pressed j.
    key(document.body, 'j')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p2')
    // A key from inside the other card is never the page's.
    key(q('[data-calendar]')!, 'k')
    expect(q('[data-page] [data-detail]')?.getAttribute('data-detail')).toBe('p2')
  })
})
