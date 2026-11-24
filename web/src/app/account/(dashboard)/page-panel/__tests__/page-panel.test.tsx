// @vitest-environment jsdom
/**
 * The page panel beside the navigation (page-panel.tsx, home-recents.tsx;
 * Liam, 11-11): home's recents, not while the capture's notepad holds the
 * left, and nothing at all with nothing to show. A row opens its record
 * exactly as the palette's feed rows do (openTarget), and its dot goes. The
 * panel persists under a card full screen (Liam, 11-11: "it should just
 * make room for both things to be open"): it keeps painting (tailwind.css),
 * the card's layer starts after it (--page-panel-w on <html>), and the open
 * record's row is lit. Reads: when it comes on screen, on focus while it
 * shows, and when a card in front closes; a failed read keeps the last
 * list. Its button (Liam, 11-11, right of Search) closes and opens it: the
 * host says whether it is on screen, closed it takes the layer's variable
 * with it, floating it ends above the composer. Its card has the opened
 * card's 24px corners (Liam, 11-11). Only where the app rail is (from
 * `md` up): below it, no panel, no float, no variable, the saved state kept
 * for crossing back. It follows the selected place (Liam, 11-11): Recent on
 * home and beside what is opened from home; on a selected page with no panel
 * of its own (My Actions has one: tasks-panel.test.tsx) nothing, the variable cleared and the button gone, the saved
 * open state untouched. Fixtures are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'
import type { FeedEntry } from '@/lib/entities/feed-model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => [] as Array<{ target: unknown; from: string }>)
/** Each open's `flip` (open-card.ts): a hub's open takes the place of the card it opened before. */
const flips = vi.hoisted(() => [] as Array<boolean | undefined>)
const composer = vi.hoisted(() => ({ height: 0 }))
// The window's workspace, as its requests name it: a test may have it learned only while the first reads are out.
const windowWs = vi.hoisted(() => ({ id: 'ws-home' as string | null }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => windowWs.id }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
const filesOpened: string[] = []
vi.mock('@/components/files/global-file-viewer', () => ({
  openAttachmentById: async (id: string) => {
    filesOpened.push(id)
    return true
  },
}))
vi.mock('@/lib/chat-cards/open-card', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-cards/open-card')>()),
  openTarget: (target: unknown, opts: { from: string; flip?: boolean }) => {
    opened.push({ target, from: opts.from })
    flips.push(opts.flip)
    return true
  },
}))
// The side panel's module is the whole right panel: the frame takes only its place and motion, the host the store.
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    PANEL_TOP: '6px',
    SLIDE_CLASS: 'transition-[translate,visibility]',
    SLIDE_STYLE: {},
    useComposerReserve: (active: boolean) => (active ? composer.height : 0),
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PagePanelHost, pageKeyOf } from '../page-panel'
import { RAIL_MEDIA } from '../../rail/rail-media'
import { PAGE_PANEL_ID } from '../page-panel-types'
import { pagePanelBottom, pagePanelBottomCss } from '../page-panel-frame'
import { MINIMIZED_TILE_BAND_PX, PAGE_PANEL_HEIGHT_SHARE } from '../../side-panels/space-plan'
import { SEEN_KEY } from '../use-recents'
import { recentGroupLabel, recentGroupOf } from '../recents-model'
import * as store from '../../side-panels/side-panel-store'
import { PAGE_PANEL_W_VAR, holdFrontCard } from '@/components/chat-cards/front-card'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { __resetSelectedPlaceForTests } from '../../rail/selected-place'
import { __resetSubnavOnScreenForTests, subnavCovers, subnavOnScreen, subscribeSubnavOnScreen } from '../subnav-on-screen'

const DOC = 'd0000000-0000-4000-8000-000000000001'
const ACTION = 'a0000000-0000-4000-8000-000000000001'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const entry = (type: FeedEntry['type'], id: string, label: string, when: string, me: boolean): FeedEntry => ({
  type,
  id,
  label,
  context: null,
  count: 1,
  last: {
    id: `ev-${id}`,
    action: me ? 'renamed' : 'assigned',
    at: when,
    actor: me ? { kind: 'member', member_id: 'm-ana', name: 'Ana Reyes', me: true } : { kind: 'member', member_id: 'm-maya', name: 'Maya Chen', me: false },
    subject: me ? null : { member_id: 'm-ana', name: 'Ana Reyes', me: true },
    from: null,
    to: null,
    relation: null,
    other: null,
  },
})

let inbox: FeedEntry[] = []
let recent: FeedEntry[] = []
let feedOk = true
let reads = 0
let sources: unknown[] = []
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  opened.length = 0
  flips.length = 0
  filesOpened.length = 0
  windowWs.id = 'ws-home'
  composer.height = 0
  inbox = [entry('action', ACTION, 'Send the Fernhill quote', ago(10), false)]
  recent = [entry('document', DOC, 'Q4 renewals plan', ago(3 * 24 * 60), true)]
  feedOk = true
  reads = 0
  sources = []
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetSubnavOnScreenForTests()
  store.resetSidePanelStore()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Recent's direct reads (GET /api/account/recents): nothing unless a test says.
      if (String(url) === '/api/account/recents') return { ok: true, json: async () => ({ entries: sources, workspace_id: 'ws-home' }) } as Response
      if (!String(url).startsWith('/api/account/feed')) throw new Error(`unexpected ${url}`)
      reads++
      if (!feedOk) return { ok: false, json: async () => ({}) } as Response
      const entries = String(url).includes('assigned_to=me') ? inbox : recent
      return { ok: true, json: async () => ({ entries, next_cursor: null }) } as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

/** The host as the row renders it: the plan gives it room whenever the store says it has something. */
function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return <PagePanelHost mode={state.pagePanel ? 'room' : 'off'} />
}

const panel = () => container.querySelector<HTMLElement>('aside[aria-label="Recent"]')
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-recent-item]')]
const titles = () => rows().map((r) => r.querySelector('[data-recent-title]')?.textContent)

describe('the page panel', () => {
  it('the selected place holds the slot: home’s Recent; My Actions and the page groups their sub-navs; a page with no panel of its own, none', () => {
    expect(pageKeyOf('home')).toBe('home')
    expect(pageKeyOf('actions')).toBe('actions')
    // The page groups (Liam, 11-11: Contacts, Outreach, Calendar).
    expect(pageKeyOf('contacts')).toBe('contacts')
    expect(pageKeyOf('outreach')).toBe('outreach')
    expect(pageKeyOf('calendar')).toBe('calendar')
    // Mail's sub-nav (mail-panel.tsx; Liam, 11-11).
    expect(pageKeyOf('mail')).toBe('mail')
    // Team chat's sub-nav (team-chat-panel.tsx; Liam, 11-11): there only once its card says what it has.
    expect(pageKeyOf('team-chat')).toBe('team-chat')
    // The Studio is one of Outreach's pages (Liam, 11-13): no place, no panel of its own.
    expect(pageKeyOf('studio')).toBeNull()
  })

  it('on a selected page: its own sub-nav at once, before its card says anything (Liam, 11-11: "it goes away completely and reappears"); Recent off; back home, Recent again', async () => {
    act(() => root.render(<Row />))
    await flush()
    expect(store.getSidePanelState().pagePanel).toBe(true)
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    // The Team chat page itself, as the rail opens it: its card has said nothing (none here), its switch and headings show.
    const chat = CARD_PAGES.find((p) => p.slug === 'team-chat')!.spec(new Date()) as CardSpec
    let release = () => {}
    act(() => {
      release = holdFrontCard({ id: 'card-team-chat-page', spec: chat, close: () => {} })
    })
    await flush()
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true, pagePanelShown: true })
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('off')
    const chatPanel = container.querySelector<HTMLElement>('aside[data-page-panel="team-chat"]')!
    expect(chatPanel.getAttribute('data-page-panel-mode')).toBe('room')
    expect(chatPanel.querySelector('[data-team-chat-mode-option="all"]')).not.toBeNull()
    expect([...chatPanel.querySelectorAll('[data-team-chat-section] h3')].map((h) => h.textContent)).toEqual(['Channels', 'DMs'])
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    expect(store.getSidePanelState().pagePanelOpen).toBe(true)
    expect(window.localStorage.getItem(store.PAGE_PANEL_OPEN_KEY)).toBeNull()
    // Back home (the page closed): Recent again, as the person left it.
    act(() => release())
    await flush()
    expect(store.getSidePanelState().pagePanel).toBe(true)
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
  })

  it('beside an artifact opened from home (a record, an event on its day), Recent stays', async () => {
    act(() => root.render(<Row />))
    await flush()
    let release = () => {}
    act(() => {
      release = holdFrontCard({ id: 'card-ev', spec: { kind: 'calendar', title: 'Standup', calendar: { from: '2026-11-10', to: '2026-11-10', view: 'day' } }, close: () => {} })
    })
    await flush()
    expect(store.getSidePanelState().pagePanel).toBe(true)
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    act(() => release())
    await flush()
  })

  it('on home: the recents under their time headings, newest first, what came to the person with a dot', async () => {
    act(() => root.render(<Row />))
    await flush()
    const aside = panel()!
    expect(aside).not.toBeNull()
    expect(aside.getAttribute('data-page-panel-mode')).toBe('room')
    expect(aside.hasAttribute('inert')).toBe(false)
    expect(store.getSidePanelState().pagePanel).toBe(true)
    // Sections by time (docs/plans/recent-panel.md): ten minutes ago is the last hour's, 3 days ago its own day's.
    const now = new Date()
    expect([...aside.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Last hour', recentGroupLabel(recentGroupOf(ago(3 * 24 * 60), now), now)])
    expect(titles()).toEqual(['Send the Fernhill quote', 'Q4 renewals plan'])
    expect(rows()[0].hasAttribute('data-recent-needs-you')).toBe(true)
    expect(rows()[1].hasAttribute('data-recent-needs-you')).toBe(false)
    expect(rows()[0].querySelector('time')?.textContent).toBe('10m')
    expect(rows()[1].querySelector('time')?.textContent).toBe('3d')
    // Rows are buttons in lists; titles are kept out of session replay.
    expect(rows().every((r) => r.tagName === 'BUTTON' && r.closest('li') && r.closest('ul'))).toBe(true)
    expect(aside.querySelector('.ph-no-capture')).not.toBeNull()
    // The glyph alone (Liam, 11-11: "the icons don't need a white background"): no tile, no ring, a fixed slot.
    const icon = rows()[0].querySelector<HTMLElement>('[data-recent-icon]')!
    expect(icon.querySelector('svg')).not.toBeNull()
    expect(icon.className).toContain('w-4')
    expect(icon.className).not.toMatch(/\bbg-|\bring-|rounded/)
  })

  it('nothing to show: nothing at all, and the row keeps its room', async () => {
    inbox = []
    recent = []
    act(() => root.render(<Row />))
    await flush()
    expect(reads).toBe(2)
    expect(panel()).toBeNull()
    expect(container.innerHTML).toBe('')
    expect(store.getSidePanelState().pagePanel).toBe(false)
  })

  it('what the person did outside the log joins the list (their Drive upload), and opens in the file viewer', async () => {
    const FILE = 'b0000000-0000-4000-8000-000000000001'
    sources = [{ type: 'attachment', id: FILE, label: 'fernhill-quote.pdf', context: null, at: ago(2) }]
    act(() => root.render(<Row />))
    await flush()
    expect(titles()).toEqual(['fernhill-quote.pdf', 'Send the Fernhill quote', 'Q4 renewals plan'])
    expect([...panel()!.querySelectorAll('h3')][0].textContent).toBe('Last few minutes')
    act(() => rows()[0].click())
    expect(filesOpened).toEqual([FILE])
    expect(opened).toEqual([])
  })

  it('a first load whose workspace is learned while its reads are out reads again for it, never staying empty', async () => {
    // Before the window knows its workspace: the reads go out naming none, and it is learned meanwhile.
    windowWs.id = null
    const plain = fetch as unknown as ReturnType<typeof vi.fn>
    const answer = plain.getMockImplementation()!
    // Learned as the answers come back, after the panel's last render: nothing else would render it again.
    plain.mockImplementation(async (url: string) => {
      const res = (await answer(url)) as Response
      return { ...res, ok: res.ok, json: async () => ((windowWs.id = 'ws-home'), res.json()) } as Response
    })
    act(() => root.render(<Row />))
    await flush()
    await flush()
    expect(titles()).toEqual(['Send the Fernhill quote', 'Q4 renewals plan'])
  })

  it('keys while it has the focus: J/K and the arrows move, Enter and Shift+Enter open, never while typing', async () => {
    act(() => root.render(<Row />))
    await flush()
    const keys = panel()!.querySelector<HTMLElement>('[data-recents-keys]')!
    const press = (key: string, init: KeyboardEventInit = {}, target: HTMLElement = (document.activeElement as HTMLElement) ?? keys) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
      })
    press('j', {}, keys)
    expect(document.activeElement).toBe(rows()[0])
    press('j')
    expect(document.activeElement).toBe(rows()[1])
    press('j')
    expect(document.activeElement).toBe(rows()[1])
    press('ArrowUp')
    expect(document.activeElement).toBe(rows()[0])
    press('Enter', { shiftKey: true })
    expect(opened).toEqual([{ target: { type: 'action', id: ACTION, title: 'Send the Fernhill quote' }, from: 'recents' }])
    // A modifier is never the panel's.
    press('j', { metaKey: true })
    expect(document.activeElement).toBe(rows()[0])
  })

  it('F opens the filter; a Status or Type narrows the list, kept across reloads, and Reset filters brings it all back', async () => {
    act(() => root.render(<Row />))
    await flush()
    const keys = panel()!.querySelector<HTMLElement>('[data-recents-keys]')!
    act(() => {
      keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))
    })
    await flush()
    const unread = document.querySelector<HTMLElement>('[data-recents-status="unread"]')
    expect(unread).not.toBeNull()
    // Only the kinds the list has rows of are offered.
    expect([...document.querySelectorAll('[data-recents-type]')].map((t) => t.getAttribute('data-recents-type'))).toEqual(['docs', 'actions'])
    act(() => unread!.click())
    await flush()
    expect(titles()).toEqual(['Send the Fernhill quote'])
    expect(JSON.parse(window.localStorage.getItem('ni:page-panel:recents-filter')!)).toEqual({ status: 'unread', types: [] })
    expect(panel()!.querySelector('[data-recents-filter]')!.getAttribute('data-recents-filter-on')).toBe('1')
    // Remembered: a new mount reads it back.
    act(() => root.unmount())
    root = createRoot(container)
    window.localStorage.setItem('ni:page-panel:recents-filter', JSON.stringify({ status: 'read', types: ['actions'] }))
    act(() => root.render(<Row />))
    await flush()
    // Read actions: none. The panel stays, saying so, with its reset.
    expect(rows()).toEqual([])
    const none = panel()!.querySelector<HTMLElement>('[data-recents-none]')!
    expect(none.textContent).toContain('Nothing matches')
    act(() => none.querySelector('button')!.click())
    expect(titles()).toEqual(['Send the Fernhill quote', 'Q4 renewals plan'])
    expect(JSON.parse(window.localStorage.getItem('ni:page-panel:recents-filter')!)).toEqual({ status: 'all', types: [] })
  })

  it('a click opens the record the way the palette does, and its dot goes (remembered)', async () => {
    act(() => root.render(<Row />))
    await flush()
    act(() => rows()[0].click())
    expect(opened).toEqual([{ target: { type: 'action', id: ACTION, title: 'Send the Fernhill quote' }, from: 'recents' }])
    expect(rows()[0].hasAttribute('data-recent-needs-you')).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(SEEN_KEY)!)).toEqual({ [`action:${ACTION}`]: inbox[0].last.at })
    act(() => rows()[1].click())
    expect(opened[1]).toEqual({ target: { type: 'document', id: DOC, title: 'Q4 renewals plan' }, from: 'recents' })
  })

  it('a card full screen: the panel stays (room, not inert), keeps the row, reads on focus, and reads again when the card closes', async () => {
    act(() => root.render(<Row />))
    await flush()
    expect(reads).toBe(2)
    let release = () => {}
    act(() => {
      release = holdFrontCard({ id: 'card-1', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: DOC } } as never, close: () => {} })
    })
    await flush()
    // Opening one over none reads nothing.
    expect(reads).toBe(2)
    expect(store.getSidePanelState().pagePanel).toBe(true)
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(panel()!.hasAttribute('inert')).toBe(false)
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    act(() => window.dispatchEvent(new Event('focus')))
    await flush()
    expect(reads).toBe(4)
    act(() => release())
    await flush()
    expect(store.getSidePanelState().pagePanel).toBe(true)
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(reads).toBe(6)
  })

  it('another card in the front card’s place reads again too', async () => {
    act(() => root.render(<Row />))
    await flush()
    let releaseA = () => {}
    act(() => {
      releaseA = holdFrontCard({ id: 'card-a', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: DOC } } as never, close: () => {} })
    })
    await flush()
    expect(reads).toBe(2)
    // As the card store does: the new one is held, then the old one let go.
    let releaseB = () => {}
    act(() => {
      releaseB = holdFrontCard({ id: 'card-b', spec: { kind: 'record', title: 'Action', record: { type: 'action', id: ACTION } } as never, close: () => {} })
      releaseA()
    })
    await flush()
    expect(reads).toBe(4)
    act(() => releaseB())
    await flush()
    expect(reads).toBe(6)
  })

  it('the open record’s row is lit (the rail’s tint, aria-current), following the card in front', async () => {
    act(() => root.render(<Row />))
    await flush()
    const lit = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.querySelector('[data-recent-title]')?.textContent)
    expect(lit()).toEqual([])
    let releaseDoc = () => {}
    act(() => {
      releaseDoc = holdFrontCard({ id: 'card-doc', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: DOC } } as never, close: () => {} })
    })
    expect(lit()).toEqual(['Q4 renewals plan'])
    expect(rows()[1].className).toContain('bg-foreground/[0.08]')
    expect(rows()[0].className).not.toContain('bg-foreground/[0.08]')
    // A card on no one record lights nothing.
    let releaseCal = () => {}
    act(() => {
      releaseCal = holdFrontCard({ id: 'card-cal', spec: { kind: 'calendar', title: 'Calendar', calendar: { start: '2026-11-09', end: '2026-11-16', view: 'week' } } as never, close: () => {} })
    })
    expect(lit()).toEqual([])
    act(() => releaseCal())
    expect(lit()).toEqual(['Q4 renewals plan'])
    act(() => releaseDoc())
    expect(lit()).toEqual([])
    await flush()
  })

  // Liam, 11-23: "so I can flip through the recent things I've looked at" (docs/plans/hub-panels.md).
  it('flips with J/K while one of its rows is open: the next row opens in its place (flip), the panel keeps the focus', async () => {
    act(() => root.render(<Row />))
    await flush()
    const keys = panel()!.querySelector<HTMLElement>('[data-recents-keys]')!
    const press = (key: string, target: HTMLElement = (document.activeElement as HTMLElement) ?? keys) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    // Nothing open: J only moves.
    press('j', keys)
    expect(opened).toEqual([])
    let release = () => {}
    act(() => {
      release = holdFrontCard({ id: 'card-action', spec: { kind: 'record', title: 'Action', record: { type: 'action', id: ACTION } } as never, close: () => {} })
    })
    // The action's row is lit, and the focus on it: J flips to the doc.
    press('j')
    expect(document.activeElement).toBe(rows()[1])
    expect(opened).toEqual([{ target: { type: 'document', id: DOC, title: 'Q4 renewals plan' }, from: 'recents' }])
    expect(flips).toEqual([true])
    // At the end: nothing more.
    press('j')
    expect(opened).toHaveLength(1)
    act(() => release())
    await flush()
  })

  it('lights a team chat channel’s row while its card is in front (the card names no record)', async () => {
    const CHANNEL = 'c0000000-0000-4000-8000-000000000001'
    recent = [entry('team_chat_channel' as FeedEntry['type'], CHANNEL, 'design', ago(5), true), ...recent]
    act(() => root.render(<Row />))
    await flush()
    const channel = rows().find((r) => r.querySelector('[data-recent-title]')?.textContent === 'design')
    expect(channel).toBeDefined()
    act(() => channel!.click())
    expect(opened.at(-1)).toEqual({ target: { type: 'team_chat', channelId: CHANNEL }, from: 'recents' })
    let release = () => {}
    act(() => {
      release = holdFrontCard({ id: 'card-tc', spec: { kind: 'team_chat', title: 'Team chat' } as never, close: () => {} })
    })
    expect(channel!.getAttribute('aria-current')).toBe('true')
    act(() => release())
    expect(channel!.getAttribute('aria-current')).toBeNull()
    await flush()
  })

  it('with a card open: the lit row’s click opens nothing more; another row opens its record', async () => {
    act(() => root.render(<Row />))
    await flush()
    let release = () => {}
    act(() => {
      release = holdFrontCard({ id: 'card-doc', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: DOC } } as never, close: () => {} })
    })
    act(() => rows()[1].click())
    expect(opened).toEqual([])
    act(() => rows()[0].click())
    expect(opened).toEqual([{ target: { type: 'action', id: ACTION, title: 'Send the Fernhill quote' }, from: 'recents' }])
    act(() => release())
    await flush()
  })

  it('keeps painting under a front card: the row’s hiding rule passes over the panel, a direct child of the row', async () => {
    const css = readFileSync(resolve(__dirname, '../../../../../styles/tailwind.css'), 'utf8')
    const rule = css.match(/([^{}]*)\{\s*visibility: hidden;\s*opacity: 0;\s*\}/)
    expect(rule).not.toBeNull()
    const selectors = rule![1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((x) => x.trim()).filter(Boolean)
    // The chat strip is not among them: its composer keeps painting (Liam, 11-11), the strip's other parts stop.
    expect(selectors).toContain('html[data-app-rail][data-card-front] [data-windows-row] > :not([data-page-panel]):not(#ni-chat-strip-slot):not([data-fading-blur])')
    // The row as dashboard-shell.tsx draws it: the chat strip, then the panel, beside each other.
    function ShellRow() {
      return (
        <div data-windows-row="">
          <div id="ni-chat-strip-slot" />
          <Row />
        </div>
      )
    }
    act(() => root.render(<ShellRow />))
    await flush()
    // <html> as the shell marks it with a card in front (front-card.ts FRONT_CARD_ATTR).
    document.documentElement.setAttribute('data-app-rail', '')
    document.documentElement.setAttribute('data-card-front', '')
    try {
      const hidden = selectors.join(', ')
      expect(panel()!.parentElement!.hasAttribute('data-windows-row')).toBe(true)
      expect(panel()!.matches(hidden)).toBe(false)
      // The strip itself only goes `visibility: hidden` (its dock shows through that, never through opacity).
      expect(container.querySelector('#ni-chat-strip-slot')!.matches(hidden)).toBe(false)
      expect(container.querySelector('#ni-chat-strip-slot')!.matches('html[data-app-rail][data-card-front] #ni-chat-strip-slot')).toBe(true)
      expect(css).toMatch(/html\[data-app-rail\]\[data-card-front\] #ni-chat-strip-slot \{\s*visibility: hidden;\s*\}/)
    } finally {
      document.documentElement.removeAttribute('data-app-rail')
      document.documentElement.removeAttribute('data-card-front')
    }
  })

  it('the layer’s variable goes with the panel: unset with no room, nothing to show, or the notepad on the left', async () => {
    act(() => root.render(<Row />))
    await flush()
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    act(() => store.setCaptureDockOpen(true))
    await flush()
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
    act(() => store.setCaptureDockOpen(false))
    await flush()
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    // No room in the plan: off, and the layer starts at the rail.
    act(() => root.render(<PagePanelHost mode="off" />))
    await flush()
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
  })

  it('while the capture’s notepad holds the left: not shown, and not read', async () => {
    act(() => store.setCaptureDockOpen(true))
    act(() => root.render(<Row />))
    await flush()
    expect(reads).toBe(0)
    expect(panel()).toBeNull()
    expect(store.getSidePanelState().pagePanel).toBe(false)
    act(() => store.setCaptureDockOpen(false))
    await flush()
    expect(reads).toBe(2)
    expect(panel()).not.toBeNull()
    expect(store.getSidePanelState().pagePanel).toBe(true)
  })

  it('reads again on focus while home shows; a failed read keeps the last list', async () => {
    act(() => root.render(<Row />))
    await flush()
    expect(titles()).toHaveLength(2)
    feedOk = false
    act(() => window.dispatchEvent(new Event('focus')))
    await flush()
    expect(reads).toBe(4)
    expect(titles()).toEqual(['Send the Fernhill quote', 'Q4 renewals plan'])
    feedOk = true
    recent = [...recent, entry('document', 'd0000000-0000-4000-8000-000000000002', 'Pricing page copy', ago(30), true)]
    act(() => window.dispatchEvent(new Event('focus')))
    await flush()
    expect(titles()).toEqual(['Send the Fernhill quote', 'Pricing page copy', 'Q4 renewals plan'])
  })

  it('caps the rows, with "Show N more" for the rest', async () => {
    inbox = []
    recent = Array.from({ length: 35 }, (_, i) => entry('document', `d0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, `Doc ${i}`, ago(i + 1), true))
    act(() => root.render(<Row />))
    await flush()
    expect(rows()).toHaveLength(30)
    const more = container.querySelector<HTMLButtonElement>('[data-recents-more]')!
    expect(more.textContent).toBe('Show 5 more')
    act(() => more.click())
    expect(rows()).toHaveLength(35)
    expect(container.querySelector('[data-recents-more]')).toBeNull()
  })

  it('its card has the opened card’s 24px corners, not the right panel’s 12px; the rows round with it, clear of the curve', async () => {
    act(() => root.render(<Row />))
    await flush()
    const card = container.querySelector<HTMLElement>('[data-page-panel-card]')!
    const classes = card.className.split(' ')
    expect(classes).toContain('rounded-3xl')
    expect(classes).not.toContain('rounded-xl')
    // Room under the last row (the filter bar holds the room above), rows rounded 12px.
    expect(container.querySelector<HTMLElement>('[data-recents-scroller]')!.className.split(' ')).toEqual(expect.arrayContaining(['px-1.5', 'pb-2.5']))
    expect(rows()[0].className.split(' ')).toContain('rounded-xl')
  })

  it('carries the id its button controls, and tells the store whether it is on screen', async () => {
    act(() => root.render(<Row />))
    await flush()
    expect(panel()!.id).toBe(PAGE_PANEL_ID)
    expect(store.getSidePanelState().pagePanelShown).toBe(true)
    act(() => root.render(<PagePanelHost mode="off" />))
    await flush()
    expect(store.getSidePanelState().pagePanelShown).toBe(false)
  })

  it('closed by its button: off screen (kept, inert), the layer’s variable gone, the rows still known; opened again, back', async () => {
    /** The row as the plan answers it: room while the panel is wanted (it has rows and is open). */
    function PlannedRow() {
      const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
      return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
    }
    act(() => root.render(<PlannedRow />))
    await flush()
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    act(() => store.setPagePanelOpen(false))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('off')
    expect(panel()!.hasAttribute('inert')).toBe(true)
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelShown: false, pagePanelOpen: false })
    act(() => store.setPagePanelOpen(true))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    expect(store.getSidePanelState().pagePanelShown).toBe(true)
  })

  it('floating (opened by hand with no room): on screen, above the composer, and a card’s layer still starts after it', async () => {
    // Its bottom, as drawn: above `px` by a fifth of the height from its top (PANEL_TOP, mocked here) down to `px` (Liam, 11-11: "it should stop 20% less").
    const capped = (px: number) => `calc(${px}px + 0.2 * (100% - 6px - ${px}px))`
    composer.height = 200
    act(() => root.render(<PagePanelHost mode="float" />))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('float')
    expect(panel()!.style.bottom).toBe(capped(212))
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
    expect(store.getSidePanelState().pagePanelShown).toBe(true)
    // Making room it reaches down to the minimized card's band (Liam, 11-11):
    // the tile (a 185px tall preview, the page panel's width at 16:10) and a gutter above it, over the row's gutter.
    act(() => root.render(<PagePanelHost mode="room" />))
    await flush()
    expect(panel()!.style.bottom).toBe(capped(MINIMIZED_TILE_BAND_PX))
    // Floating over a shorter composer: the tile's band is higher, it wins.
    composer.height = 120
    act(() => root.render(<PagePanelHost mode="float" />))
    await flush()
    expect(panel()!.style.bottom).toBe(capped(MINIMIZED_TILE_BAND_PX))
  })

  it('takes 80% of the height down to its band at the most (pagePanelBottomCss), the same with or without a tile', () => {
    expect(MINIMIZED_TILE_BAND_PX).toBe(12 + 185 + 12)
    expect(PAGE_PANEL_HEIGHT_SHARE).toBe(0.8)
    expect(pagePanelBottom(0)).toBe(209)
    expect(pagePanelBottom(300)).toBe(312)
    expect(pagePanelBottomCss(0)).toBe('calc(209px + 0.2 * (100% - 6px - 209px))')
    // Worked through for Liam's window (600px tall, the top inset 48px): it ends 80% of the way down.
    const row = 600
    const top = 48 + 6
    const bottom = 209 + 0.2 * (row - top - 209)
    expect(row - top - bottom).toBeCloseTo(0.8 * (row - top - 209))
  })

  describe('which page’s sub-nav is on screen, for the cards (subnav-on-screen.ts; Liam, 11-11)', () => {
    /** The row as the plan answers it: room while the panel is wanted (it has rows and is open). */
    function PlannedRow() {
      const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
      return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
    }
    const chatSpec = () => CARD_PAGES.find((p) => p.slug === 'team-chat')!.spec(new Date()) as CardSpec

    it('a card covers its own navigation only while its page’s sub-nav is on screen; undecided, it keeps today’s look', () => {
      expect(subnavCovers('mail', undefined)).toBe(true)
      expect(subnavCovers('mail', 'mail')).toBe(true)
      expect(subnavCovers('mail', null)).toBe(false)
      expect(subnavCovers('mail', 'home')).toBe(false)
      expect(subnavCovers('mail', 'team-chat')).toBe(false)
      // A card that is no page's own: never.
      expect(subnavCovers(null, undefined)).toBe(false)
      expect(subnavCovers(null, 'mail')).toBe(false)
    })

    it('undecided before the host says and with no card in front; the page’s own card in front: its page, never passing through none', async () => {
      expect(subnavOnScreen()).toBeUndefined()
      const seen: Array<string | null | undefined> = []
      const off = subscribeSubnavOnScreen(() => seen.push(subnavOnScreen()))
      act(() => root.render(<PlannedRow />))
      await flush()
      // Recent on screen, but no card to cover: undecided, so a card coming in front first draws as today.
      expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
      expect(subnavOnScreen()).toBeUndefined()
      let release = () => {}
      act(() => {
        release = holdFrontCard({ id: 'card-team-chat-page', spec: chatSpec(), close: () => {} })
      })
      await flush()
      expect(subnavOnScreen()).toBe('team-chat')
      // On the way there it was only ever undecided, never "none" or another page's (a card's own list shown, then taken away).
      expect(seen.every((v) => v === undefined || v === 'team-chat')).toBe(true)
      act(() => release())
      await flush()
      expect(subnavOnScreen()).toBeUndefined()
      off()
      // Gone with the host: undecided again.
      act(() => root.unmount())
      expect(subnavOnScreen()).toBeUndefined()
      root = createRoot(container)
    })

    it('none while the capture’s notepad holds the left, or the panel is closed by its button; back with it', async () => {
      act(() => root.render(<PlannedRow />))
      await flush()
      let release = () => {}
      act(() => {
        release = holdFrontCard({ id: 'card-team-chat-page', spec: chatSpec(), close: () => {} })
      })
      await flush()
      expect(subnavOnScreen()).toBe('team-chat')
      act(() => store.setCaptureDockOpen(true))
      await flush()
      expect(subnavOnScreen()).toBeNull()
      act(() => store.setCaptureDockOpen(false))
      await flush()
      expect(subnavOnScreen()).toBe('team-chat')
      act(() => store.setPagePanelOpen(false))
      await flush()
      expect(subnavOnScreen()).toBeNull()
      act(() => store.setPagePanelOpen(true))
      await flush()
      expect(subnavOnScreen()).toBe('team-chat')
      act(() => release())
      await flush()
    })

    it('a card opened from home (a thread from Recent, a notification): Recent is what shows, so no page’s sub-nav', async () => {
      act(() => root.render(<PlannedRow />))
      await flush()
      let release = () => {}
      act(() => {
        release = holdFrontCard({ id: 'card-thread', spec: { kind: 'mail', title: 'Fernhill quote', mail: { thread_id: 'th-1' } } as never, close: () => {} })
      })
      await flush()
      expect(subnavOnScreen()).toBe('home')
      expect(subnavCovers('mail')).toBe(false)
      act(() => release())
      await flush()
    })
  })

  describe('only where the app rail is (from md up; Liam, 11-11: at 741px “the page looks all crazy”)', () => {
    let wide = false
    const listeners = new Set<() => void>()
    beforeEach(() => {
      wide = false
      listeners.clear()
      vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() {
          return query === RAIL_MEDIA ? wide : false
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      }))
    })
    const cross = (to: boolean) => {
      wide = to
      act(() => listeners.forEach((cb) => cb()))
    }

    it('below md: off, nothing asked of the row, the variable cleared, even opened by hand and planned to float', async () => {
      act(() => store.setPagePanelOpen(true))
      expect(store.getSidePanelState().pagePanelFloatOk).toBe(true)
      act(() => root.render(<PagePanelHost mode="float" />))
      await flush()
      expect(reads).toBe(0)
      expect(panel()).toBeNull()
      expect(store.getSidePanelState()).toMatchObject({ pagePanel: false, pagePanelShown: false })
      expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
      // A page's card in front: no sub-nav on screen, its own navigation (its CSS hides nothing below md anyway).
      const release = holdFrontCard({ id: 'card-team-chat-page', spec: CARD_PAGES.find((p) => p.slug === 'team-chat')!.spec(new Date()) as CardSpec, close: () => {} })
      await flush()
      expect(subnavOnScreen()).toBeNull()
      act(() => release())
      await flush()
    })

    it('crossing md: back as the person left it (open, or closed), and gone again below it', async () => {
      wide = true
      act(() => root.render(<Row />))
      await flush()
      expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
      expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
      cross(false)
      await flush()
      expect(panel()!.getAttribute('data-page-panel-mode')).toBe('off')
      expect(store.getSidePanelState()).toMatchObject({ pagePanel: false, pagePanelShown: false, pagePanelOpen: true })
      expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
      cross(true)
      await flush()
      expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
      expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelShown: true, pagePanelOpen: true })
      expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('calc(296px + 2 * 4px)')
      // Closed by hand, below md and back: still closed.
      act(() => store.setPagePanelOpen(false))
      cross(false)
      cross(true)
      await flush()
      expect(store.getSidePanelState().pagePanelOpen).toBe(false)
      expect(window.localStorage.getItem(store.PAGE_PANEL_OPEN_KEY)).toBe('0')
    })
  })
})
