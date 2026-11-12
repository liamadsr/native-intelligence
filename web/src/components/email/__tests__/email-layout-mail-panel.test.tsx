// @vitest-environment jsdom
/**
 * A Mail card and the Mail sub-nav beside the rail (Liam, 11-11: "see and
 * select all the accounts … the inbox, faves, sent … and any tags that are
 * available for email"; page-panel/mail-panel.tsx). The card says where it is
 * (chat-cards/mail-card-controls.ts) and takes the sub-nav's moves the way
 * its own controls make them: a folder as its Select (reported, so the card's
 * history steps), the mailboxes as its dropdown, a tag as a filter on its
 * list (every folder but Spam and Trash; a folder clears it). Full screen,
 * its dropdown and Select exist only below `md` (Liam, 11-11: the sub-nav is
 * the one control from there up), in CSS from the first render, never waiting
 * on the panel; inline, they are the card's own. The real EmailLayout is
 * mounted; the list, detail and controls are stubs. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

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
  accountIds?: string[] | null
  extraParams?: Record<string, string>
}
let list: ListProps | null = null
vi.mock('../email-thread-list', () => ({
  EmailThreadList: (props: ListProps) => {
    list = props
    return h('div', { 'data-list': props.folder })
  },
}))
vi.mock('../email-thread-detail', () => ({ EmailThreadDetail: () => null }))
vi.mock('@/components/account-filter-dropdown', () => ({ AccountFilterDropdown: () => h('div', { 'data-account-filter': '' }) }))
vi.mock('@/components/views/view-toolbar', () => ({ ViewToolbar: () => null }))
vi.mock('@/components/views/expandable-search', () => ({ ExpandableSearch: () => null }))
vi.mock('@/components/ui/select', () => ({
  Select: ({ value }: { value: string }) => h('div', { 'data-folder-select': value }),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
}))
vi.mock('@/components/views/hooks/use-view', () => ({
  useView: () => ({ views: [], activeViewId: null, activeView: null, setActiveViewId: () => {}, createView: () => {}, updateView: () => {}, deleteView: () => {}, duplicateView: () => {} }),
  useViewConfig: () => ({ config: { filters: [] }, updateConfig: () => {}, isDirty: false, overrides: null, saveOverrides: () => {}, discardOverrides: () => {} }),
}))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/components/views/unified-view-layout', () => ({ useIsWindowFocused: () => true }))

const { EmailLayout } = await import('../email-layout')
const controlsModule = await import('@/components/chat-cards/mail-card-controls')
const { __resetMailCardsForTests, mailCardFor } = controlsModule
const { __resetSubnavOnScreenForTests, setSubnavOnScreen } = await import('@/app/account/(dashboard)/page-panel/subnav-on-screen')

const CARD = 'card-mail-page'
let container: HTMLDivElement
let root: Root
let onStateChange: ReturnType<typeof vi.fn>
const shows: string[] = []

beforeEach(() => {
  __resetMailCardsForTests()
  __resetSubnavOnScreenForTests()
  list = null
  shows.length = 0
  onStateChange = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('/counts') ? { inbox_unread: 3, drafts: 2 } : {}),
  })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(id: string | null = CARD, fullScreen = true) {
  const card = {
    initial: { folder: 'inbox', search: '', accounts: null, threadId: null },
    fullScreen,
    onStateChange,
    id: id ?? undefined,
    show: () => shows.push('show'),
  }
  await act(async () => {
    root.render(h('div', { 'data-chat-card-fullscreen': 'c1' }, h(EmailLayout, { card })))
  })
  for (let i = 0; i < 3; i++) await act(async () => {})
}

const me = () => mailCardFor(CARD)!
const q = (sel: string) => container.querySelector(sel)

describe('a Mail card and its sub-nav', () => {
  it('says where it is: its folder, all mailboxes, no tag, the counts it read; gone when unmounted', async () => {
    await mount()
    expect(me()).toMatchObject({ cardId: CARD, folder: 'inbox', accounts: null, labelId: null, counts: { inbox_unread: 3, drafts: 2 } })
    act(() => root.unmount())
    expect(mailCardFor(CARD)).toBeNull()
    root = createRoot(container)
  })

  it('a card without an id says nothing', async () => {
    await mount(null)
    expect(mailCardFor(null)).toBeNull()
  })

  it('a folder is its Select’s move: the list goes there, reported once (the card’s history steps)', async () => {
    await mount()
    await act(async () => me().setFolder('sent'))
    expect(list?.folder).toBe('sent')
    expect(me().folder).toBe('sent')
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ folder: 'sent', accounts: null }))
  })

  it('the mailboxes are its dropdown’s: one, or all again', async () => {
    await mount()
    await act(async () => me().setAccounts(['acct-home']))
    expect(list?.accountIds).toEqual(['acct-home'])
    expect(me().accounts).toEqual(['acct-home'])
    await act(async () => me().setAccounts(null))
    expect(list?.accountIds).toBeNull()
  })

  it('a tag filters the list (every folder but Spam and Trash); a folder clears it', async () => {
    await mount()
    await act(async () => me().setLabel('lbl-client'))
    expect(list?.extraParams).toEqual({ readable: '1', label_id: 'lbl-client' })
    expect(list?.folder).toBe('all')
    expect(me().labelId).toBe('lbl-client')
    // Not a step in the card's history (as a search or a mailbox filter isn't).
    expect(onStateChange).not.toHaveBeenCalled()
    await act(async () => me().setFolder('inbox'))
    expect(me().labelId).toBeNull()
    expect(list?.extraParams).toEqual({ readable: '1' })
    expect(list?.folder).toBe('inbox')
  })

  it('full screen: its dropdown and Select only below `md` (the sub-nav’s from there up), from the first render', async () => {
    await mount()
    const own = q('[data-mail-own-nav]')!
    expect(own.className.split(' ')).toEqual(['contents', 'md:hidden'])
    expect(own.querySelector('[data-account-filter]')).not.toBeNull()
    expect(own.querySelector('[data-folder-select]')).not.toBeNull()
    // The unread chip, search and compose stay the card's own, at every width.
    expect(q('[data-unread-toggle]')!.closest('[data-mail-own-nav]')).toBeNull()
  })

  it('full screen without the Mail sub-nav on screen (Liam, 11-11): a capture docked or the panel closed, Recent beside it; its own again', async () => {
    await mount()
    const own = () => q('[data-mail-own-nav]')!
    // The Mail sub-nav on screen: hidden from `md` up, as before.
    act(() => setSubnavOnScreen('mail'))
    expect(own().className.split(' ')).toEqual(['contents', 'md:hidden'])
    // None on screen (the notepad holds the left, or the panel is closed).
    act(() => setSubnavOnScreen(null))
    expect(own().className).toBe('contents')
    expect(own().querySelector('[data-folder-select]')).not.toBeNull()
    // Opened from home (a thread from Recent, For you, a notification): Recent beside it.
    act(() => setSubnavOnScreen('home'))
    expect(own().className).toBe('contents')
    // Another page's sub-nav.
    act(() => setSubnavOnScreen('team-chat'))
    expect(own().className).toBe('contents')
    // Undecided again (settling): today's look, never a flash.
    act(() => setSubnavOnScreen(undefined))
    expect(own().className.split(' ')).toEqual(['contents', 'md:hidden'])
  })

  it('inline in the chat (no sub-nav beside it): its own dropdown and Select at every width', async () => {
    await mount(CARD, false)
    const own = q('[data-mail-own-nav]')!
    expect(own.className).toBe('contents')
    expect(own.querySelector('[data-account-filter]')).not.toBeNull()
    expect(own.querySelector('[data-folder-select]')).not.toBeNull()
  })

  it('show() puts the card full screen through its owner', async () => {
    await mount()
    me().show()
    expect(shows).toEqual(['show'])
  })
})
