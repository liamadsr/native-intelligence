// @vitest-environment jsdom
/**
 * Inbox's panel beside the rail (../inbox-panel.tsx; Liam, 11-23, Inbox
 * "Like Home"; docs/plans/hub-panels.md): registered for `inbox`, a hub's
 * panel (it wears HUB_PLACE_ATTR), its filter and the inbox's one list (the
 * store the card reads too), its keys, and what it opens just that item:
 * the Inbox card brought in front for a conversation or a mail thread, the
 * row lit, J / K flipping it. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('@/app/account/(dashboard)/views/team-chat-view', () => ({ TeamChatView: () => null }))
vi.mock('@/components/email/email-layout', () => ({ EmailLayout: () => null }))
vi.mock('../../chat/for-you-column', () => ({ useForYouEntries: () => [] }))
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    PANEL_TOP: '6px',
    SLIDE_CLASS: 'transition-[translate,visibility]',
    SLIDE_STYLE: {},
    useComposerReserve: () => 0,
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PAGE_PANELS } from '../page-panel'
import { InboxPanel } from '../inbox-panel'
import { HOME_SIDE_KEY, __resetHomeSideForTests, homeSide, setHomeSide } from '../home-side'
import { HUB_PLACE_ATTR } from '../../rail/selected-place'
import { __resetInboxStoreForTests, inboxState, setInboxFilter } from '@/components/inbox/inbox-store'
import { OPEN_CARD_EVENT } from '@/lib/chat-cards/open-card'

const at = new Date().toISOString()
const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  source: 'notification',
  category: 'messages',
  at,
  title: `Item ${key}`,
  body: null,
  unread: true,
  count: 1,
  notificationIds: [`n-${key}`],
  actor: null,
  open: { kind: 'team_chat', channelId: 'ch1', messageId: `m-${key}`, threadRootId: null },
  type: 'team_chat_message',
  ...over,
})
const MAIL = item('mail:t1', { source: 'mail', category: 'mail', title: 'Fern Example', open: { kind: 'mail', threadIndexId: 't1', providerThreadId: 'pt1', accountId: null }, notificationIds: [], type: 'mail' })
const DATA = { items: [item('a'), item('b'), MAIL], held: [], mail: [] }

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
const opened: unknown[] = []
const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)

beforeEach(() => {
  __resetInboxStoreForTests()
  __resetHomeSideForTests()
  window.localStorage.clear()
  opened.length = 0
  window.addEventListener(OPEN_CARD_EVENT, onOpen)
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/api/account/inbox') && !String(url).includes('/notifications') && !String(url).includes('/hold') ? DATA : { ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(OPEN_CARD_EVENT, onOpen)
  vi.unstubAllGlobals()
})

async function render(front: unknown = null) {
  const onContent = vi.fn()
  await act(async () => root.render(<InboxPanel active mode="room" front={front as never} onContent={onContent} />))
  await act(async () => {})
  return onContent
}
const panel = () => container.querySelector<HTMLElement>('[data-page-panel="home"]')!
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-inbox-row]'))
const key = async (target: HTMLElement, k: string) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  await act(async () => void target.dispatchEvent(ev))
  return ev
}

describe('Inbox’s panel', () => {
  it('is Home’s Inbox side (Liam, 11-24), a hub’s panel: its filter and the one list, something to show from its first commit', async () => {
    expect((PAGE_PANELS as Record<string, unknown>).inbox).toBeUndefined()
    const onContent = await render()
    expect(onContent).toHaveBeenCalledWith('home', true)
    expect(panel().getAttribute(HUB_PLACE_ATTR)).toBe('home')
    expect(panel().getAttribute('aria-label')).toBe('Incoming')
    // One filter, Recent's kind (Liam, 11-24): a button, no row of pills.
    expect(container.querySelector('[data-inbox-filter]')).not.toBeNull()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(rows().map((r) => r.getAttribute('data-inbox-row'))).toEqual(['a', 'b', 'mail:t1'])
    // The filter narrows the one list.
    act(() => setInboxFilter({ status: 'all', kinds: ['mail'] }))
    expect(rows().map((r) => r.getAttribute('data-inbox-row'))).toEqual(['mail:t1'])
  })

  it('S goes to Home’s Recent side (home-side.ts), kept on this device; off its side it draws nothing', async () => {
    setHomeSide('inbox')
    await render()
    const list = container.querySelector<HTMLElement>('[data-inbox-list="panel"]')!
    expect((await key(list, 's')).defaultPrevented).toBe(true)
    expect(homeSide()).toBe('recent')
    expect(window.localStorage.getItem(HOME_SIDE_KEY)).toBe('recent')
    await act(async () => root.render(<InboxPanel active mode="room" front={null} onContent={() => {}} shown={false} />))
    expect(container.querySelector('[data-page-panel]')).toBeNull()
  })

  it('opens a mail thread just beside it: the Inbox card brought in front, never the Mail page; the row lit', async () => {
    await render()
    await act(async () => rows()[2].click())
    expect(inboxState().openKey).toBe('mail:t1')
    expect(rows()[2].getAttribute('aria-current')).toBe('true')
    // The Inbox page's card, not a mail card.
    expect(opened).toHaveLength(1)
    expect((opened[0] as { spec: { kind: string }; flip?: boolean }).spec.kind).toBe('inbox')
    expect((opened[0] as { flip?: boolean }).flip).toBe(true)
  })

  it('with the Inbox card in front already, opens in its pane and asks for no card', async () => {
    const { CARD_PAGES } = await import('@/lib/chat-cards/page-menu')
    await render({ id: 'in1', spec: CARD_PAGES.find((p) => p.slug === 'inbox')!.spec(new Date()), close: () => {} })
    await act(async () => rows()[0].click())
    expect(inboxState().openKey).toBe('a')
    expect(opened).toHaveLength(0)
  })

  it('flips with J / K while an item is open, and E / H act on the row', async () => {
    await render({ id: 'in1', spec: { kind: 'inbox', title: 'Inbox' }, close: () => {} })
    const list = container.querySelector<HTMLElement>('[data-inbox-list="panel"]')!
    // Nothing open: J only moves.
    expect((await key(list, 'j')).defaultPrevented).toBe(true)
    expect(inboxState().cursor).toBe(1)
    expect(inboxState().openKey).toBeNull()
    await key(list, 'Enter')
    expect(inboxState().openKey).toBe('b')
    // Open: J flips to the next, K back.
    await key(list, 'j')
    expect(inboxState().openKey).toBe('mail:t1')
    await key(list, 'k')
    expect(inboxState().openKey).toBe('b')
    // E: done (the item's notifications), off the list.
    await key(list, 'e')
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))])
    expect(posts).toContainEqual(['/api/account/inbox/notifications', { action: 'done', ids: ['n-b'] }])
    expect(rows().map((r) => r.getAttribute('data-inbox-row'))).not.toContain('b')
    // H: hold until tomorrow.
    await key(list, 'h')
    const holds = fetchMock.mock.calls.filter(([url]) => url === '/api/account/inbox/hold')
    expect(holds).toHaveLength(1)
  })
})
