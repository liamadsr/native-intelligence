// @vitest-environment jsdom
/**
 * The app rail (../app-rail.tsx): its icons in Liam's order, a page opens as
 * `/` opens it (OPEN_CARD_EVENT, full screen in the main chat), Home at the
 * bar's top (Liam, 11-11) puts every card in front away, the selected place
 * is lit (Home under anything opened from home; a page only when it is
 * selected), and <html> carries the rail's width attribute for the
 * full-screen layer while it is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { getEdition, withEffectiveSurface, type EditionDefinition } from '@/lib/editions/manifest'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { __resetSelectedPlaceForTests } from '../selected-place'
import { GROUP_LAST_PAGE_KEY, __resetPageGroupsForTests } from '../page-groups'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { __resetRailPrefsForTests } from '@/lib/rail-prefs-store'
import { RAIL_PAGES_STORAGE_KEY } from '@/lib/rail-prefs'
import { resetSidePanelStore, setPagePanelContent } from '../../side-panels/side-panel-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { edition, openSearch, switcher } = vi.hoisted(() => ({
  edition: { current: null as EditionDefinition | null },
  openSearch: vi.fn(() => true),
  switcher: { variants: [] as string[] },
}))
vi.mock('@/app/account/workspace-switcher', async () => {
  const React = await import('react')
  return {
    useWorkspaceEdition: () => edition.current,
    WorkspaceSwitcher: ({ variant }: { variant: string }) => {
      switcher.variants.push(variant)
      return React.createElement('button', { 'aria-label': 'Workspace and account menu', 'data-variant': variant })
    },
  }
})
vi.mock('@/lib/chat/open-search', () => ({ openSearch }))

import { APP_RAIL_ATTR, AppRail } from '../app-rail'

let container: HTMLDivElement
let root: Root
const releases: Array<() => void> = []

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{"success":true}', { status: 200 }))

beforeEach(() => {
  localStorage.clear()
  __resetRailPrefsForTests()
  __resetSelectedPlaceForTests()
  __resetPageGroupsForTests()
  resetSidePanelStore()
  vi.stubGlobal('fetch', fetchMock)
  edition.current = getEdition('full')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => {
    while (releases.length) releases.pop()!()
  })
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((el) => el.remove())
})

async function render() {
  await act(async () => root.render(h(AppRail)))
}
const item = (id: string) => container.querySelector<HTMLButtonElement>(`[data-app-rail-item="${id}"]`)
const items = () => Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)
const lit = () => Array.from(container.querySelectorAll<HTMLElement>('[aria-current="page"]')).map((el) => el.dataset.appRailItem)

describe('the app rail', () => {
  it('draws the header (the workspace’s thumbnail, Search), then Home, every page that is on, and no New', async () => {
    await render()
    const header = container.querySelector<HTMLElement>('[data-app-rail-header]')!
    // In order: the workspace's thumbnail at the far left, then Search (Liam, 11-09).
    const order = Array.from(header.querySelectorAll<HTMLElement>('[data-app-rail-item="workspace"], [data-app-rail-item="search"]')).map((el) => el.dataset.appRailItem)
    expect(order).toEqual(['workspace', 'search'])
    // For you's button is the top bar's now, beside the side panel's (Liam, 11-11: its cards are a view of the side panel).
    expect(header.querySelector('[data-for-you-panel-toggle]')).toBeNull()
    // The one workspace and account menu (Liam, 11-09), the header's variant.
    expect(header.querySelector('[data-app-rail-item="workspace"] [data-variant="header"]')).not.toBeNull()
    const nav = container.querySelector<HTMLElement>('[data-app-rail-nav]')!
    expect(Array.from(nav.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)).toEqual([
      // Home first (Liam, 11-11), fixed.
      'home',
      // Drive: Docs, Knowledge, Files · Calendar: Captures (Liam, 11-11): one icon each.
      // Projects and Initiatives nest under Tasks (Liam, 11-11): no icons of their own.
      'drive', 'mail', 'team-chat', 'actions', 'calendar',
      // Studio (migration 620): its own icon after the Calendar group.
      'studio',
      // Contacts: Companies, Contacts, Deals · Outreach: Prospecting, Sequences, Campaigns (Liam, 11-11).
      // SEO: Site audit (one icon; its sections join it as they land).
      'contacts', 'outreach', 'seo',
      // Agents: Agents & skills, Flows, Evals (Liam, 11-11). Teams nests under
      // My Actions (Liam, 11-11: "Teams should be under action items"): no icon.
      'agents',
      // Customize bar, at its end (Liam, 11-09).
      'customize',
    ])
    expect(item('mail')?.getAttribute('aria-label')).toBe('Mail')
  })

  it('puts the Recent panel’s button right after Search, only while the panel has something to show (Liam, 11-11)', async () => {
    await render()
    const header = container.querySelector<HTMLElement>('[data-app-rail-header]')!
    const order = () => Array.from(header.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)
    expect(order()).toEqual(['workspace', 'search'])
    act(() => setPagePanelContent(true))
    expect(order()).toEqual(['workspace', 'search', 'page-panel'])
    const button = item('page-panel')!
    expect(button.getAttribute('aria-label')).toBe('Recent')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    act(() => setPagePanelContent(false))
    expect(order()).toEqual(['workspace', 'search'])
  })

  it('floats one bar like Miro’s toolbar ("one big bar instead of four"), a hairline between its groups, with the panels’ glass', async () => {
    await render()
    const pills = Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-pill]'))
    expect(pills.map((p) => p.dataset.appRailPill)).toEqual(['pages'])
    expect(Array.from(pills[0].querySelectorAll<HTMLElement>('[data-app-rail-group]')).map((g) => g.dataset.appRailGroup)).toEqual(['work', 'customers', 'agents'])
    expect(pills[0].querySelectorAll('[data-app-rail-group-line]')).toHaveLength(2)
    // Home at the top (Liam, 11-11: "add a homepage icon on the navside"), the bar's hairline after it.
    const home = item('home')!
    expect(pills[0].firstElementChild).toBe(home)
    expect(home.nextElementSibling?.hasAttribute('data-app-rail-home-line')).toBe(true)
    expect(home.getAttribute('aria-label')).toBe('Home')
    expect(home.querySelector('svg.lucide-house')).not.toBeNull()
    expect(home.className.split(' ')).toContain('rounded-full')
    // Not one of the person's pages: never dragged.
    expect(home.hasAttribute('data-app-rail-page')).toBe(false)
    // At the top, not centred (Liam, 11-09: "top align it so it's not center").
    expect(pills[0].parentElement!.className).not.toContain('my-auto')
    // Still no New button (Liam, 11-09: "we don't need this button").
    expect(item('new')).toBeNull()
    for (const pill of [...pills, container.querySelector<HTMLElement>('[data-app-rail-header]')!]) {
      // Capsules: their ends follow the round buttons inside (Liam, 11-09).
      expect(pill.className.split(' ')).toContain('rounded-full')
      expect(pill.className).toContain('bg-background/70')
      expect(pill.className).toContain('backdrop-blur-md')
      expect(pill.className).toContain('border-border/60')
    }
    expect(pills[0].querySelector('[data-app-rail-item="mail"]')).not.toBeNull()
    // Round hovers and lit states (Liam, 11-09: "the hover states should be circle").
    expect(item('mail')!.className.split(' ')).toContain('rounded-full')
    expect(item('search')!.className.split(' ')).toContain('rounded-full')
    expect(pills[0].querySelector('[data-app-rail-item="outreach"]')).not.toBeNull()
  })

  it('tells the top bar and the full-screen layer where the header ends (on <html>)', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ right: 236, bottom: 45 } as DOMRect)
    await render()
    expect(document.documentElement.style.getPropertyValue('--app-header-right')).toBe('236px')
    expect(document.documentElement.style.getPropertyValue('--app-header-bottom')).toBe('45px')
    rect.mockRestore()
    act(() => root.unmount())
    expect(document.documentElement.style.getPropertyValue('--app-header-right')).toBe('')
    root = createRoot(container)
  })

  it('leaves out a page that is off in the workspace', async () => {
    edition.current = withEffectiveSurface(getEdition('full'), { email: 'off' })
    await render()
    expect(item('mail')).toBeNull()
    expect(item('calendar')).not.toBeNull()
  })

  it('marks <html> with its width attribute while it is mounted', async () => {
    await render()
    expect(document.documentElement.hasAttribute(APP_RAIL_ATTR)).toBe(true)
    act(() => root.unmount())
    expect(document.documentElement.hasAttribute(APP_RAIL_ATTR)).toBe(false)
    root = createRoot(container)
  })

  it('opens a page as `/` does: its card, asked of the main chat', async () => {
    await render()
    const asked: OpenCardRequest[] = []
    const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    await act(async () => item('team-chat')!.click())
    await act(async () => item('mail')!.click())
    window.removeEventListener(OPEN_CARD_EVENT, listen)
    expect(asked.map((r) => r.spec.kind)).toEqual(['team_chat', 'mail'])
    expect(asked.every((r) => r.from === 'rail')).toBe(true)
    expect(asked[1].spec).toEqual({ kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } })
  })

  it('lights Home with nothing in front, and a page while its own card is in front', async () => {
    await render()
    expect(lit()).toEqual(['home'])
    expect(item('home')!.className).toContain('bg-foreground/[0.08]')
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'team_chat', title: 'Team chat' }, close: () => {} }))
    })
    expect(lit()).toEqual(['team-chat'])
    await act(async () => releases.pop()!())
    expect(lit()).toEqual(['home'])
  })

  it('keeps Home lit under an artifact opened from home (Liam, 11-11: its page isn’t selected)', async () => {
    await render()
    // An action's record (the Recent panel, a chip), an event on its day (a notification): their pages stay dark.
    await act(async () => {
      releases.push(holdFrontCard({ id: 'r1', spec: { kind: 'record', title: 'Send the quote', record: { type: 'action', id: 'a1' } }, close: () => {} }))
    })
    expect(lit()).toEqual(['home'])
    await act(async () => releases.pop()!())
    await act(async () => {
      releases.push(holdFrontCard({ id: 'e1', spec: { kind: 'calendar', title: 'Standup', calendar: { from: '2026-11-10', to: '2026-11-10', view: 'day' } }, close: () => {} }))
    })
    expect(lit()).toEqual(['home'])
    // A card no rail page shows: Home too.
    await act(async () => releases.pop()!())
    await act(async () => {
      releases.push(holdFrontCard({ id: 'w1', spec: { kind: 'work_item', title: 'A review' } as never, close: () => {} }))
    })
    expect(lit()).toEqual(['home'])
  })

  it('keeps a page lit for a record opened from inside it, and goes Home for one opened from elsewhere', async () => {
    const layer = document.createElement('div')
    layer.setAttribute('data-chat-card-fullscreen', 'a1')
    const row = document.createElement('button')
    layer.appendChild(row)
    document.body.appendChild(layer)
    await render()
    let releasePage = () => {}
    await act(async () => {
      releasePage = holdFrontCard({ id: 'a1', spec: { kind: 'list', title: 'My actions', entity_type: 'action', filters: [
        { field: 'assignee_id', operator: 'is', value: '@me' },
        { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
      ] }, close: () => {} })
    })
    expect(lit()).toEqual(['actions'])
    // A project linked from a task in the page, opened as a card of its own: one card leaves for the next in one go.
    row.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await act(async () => {
      releasePage()
      releases.push(holdFrontCard({ id: 'p1', spec: { kind: 'record', title: 'Q4', record: { type: 'project', id: 'p1' } }, close: () => {} }))
    })
    expect(lit()).toEqual(['actions'])
    // A doc from Search (a press outside the page): Home.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await act(async () => {
      releases.pop()!()
      releases.push(holdFrontCard({ id: 'd1', spec: { kind: 'record', title: 'Plan', record: { type: 'document', id: 'd1' } }, close: () => {} }))
    })
    expect(lit()).toEqual(['home'])
    layer.remove()
  })

  it('puts every card in front away from Home, and is never in Customize bar', async () => {
    await render()
    const closed: string[] = []
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'team_chat', title: 'Team chat' }, close: () => closed.push('c1') }))
      releases.push(holdFrontCard({ id: 'r1', spec: { kind: 'record', title: 'Doc', record: { type: 'document', id: 'd1' } }, close: () => closed.push('r1') }))
    })
    await act(async () => item('home')!.click())
    expect(closed).toEqual(['r1', 'c1'])
    await act(async () => item('customize')!.click())
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-app-rail-customize-row]')).map((r) => r.dataset.appRailCustomizeRow)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).not.toContain('home')
  })

  it('gives the keys back to the page in front when its own icon is clicked again', async () => {
    const layer = document.createElement('div')
    layer.setAttribute('data-chat-card-fullscreen', 'c1')
    layer.tabIndex = -1
    document.body.appendChild(layer)
    await render()
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'team_chat', title: 'Team chat' }, close: () => {} }))
    })
    item('team-chat')!.focus()
    await act(async () => item('team-chat')!.click())
    expect(document.activeElement).toBe(layer)
    layer.remove()
  })

  it('marks its Search as the rail’s search button (the palette’s flight while the top bar is hidden)', async () => {
    await render()
    expect(item('search')?.getAttribute('data-search-button')).toBe('rail')
  })

  it('opens Search from its button', async () => {
    await render()
    await act(async () => item('search')!.click())
    expect(openSearch).toHaveBeenCalledWith(item('search'))
  })
})

/** The bar's page icons, top to bottom. */
const bar = () => Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-page]')).map((el) => el.dataset.appRailItem)
const lines = () => container.querySelectorAll('[data-app-rail-group-line]').length
/** What the account was asked to save for the bar, last. */
const savedBar = () => {
  const calls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
  const last = calls.at(-1)
  return last ? JSON.parse(String((last[1] as RequestInit).body)).rail_pages : undefined
}
const DEFAULT_BAR = [
  'drive', 'mail', 'team-chat', 'actions', 'calendar', 'studio',
  'contacts', 'outreach', 'seo',
  'agents',
]

async function rightClick(id: string) {
  await act(async () => {
    item(id)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 100 }))
  })
}
const menuItem = (name: string) => document.querySelector<HTMLElement>(`[data-app-rail-menu-item="${name}"]`)
async function pick(name: string) {
  await act(async () => menuItem(name)!.click())
  // Radix hands the focus back a tick later.
  await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('the person’s bar', () => {
  it('unpins a page from its right-click menu: its icon goes, the page stays on (it still opens)', async () => {
    await render()
    await rightClick('mail')
    expect(document.querySelector('[data-app-rail-menu="mail"]')).not.toBeNull()
    expect(['unpin', 'up', 'down', 'customize'].map((n) => menuItem(n)?.textContent)).toEqual(['Unpin from bar', 'Move up', 'Move down', 'Customize bar…'])
    await pick('unpin')
    expect(item('mail')).toBeNull()
    expect(bar()).toEqual(DEFAULT_BAR.filter((id) => id !== 'mail'))
    // Saved to the account, and this device's copy at once.
    expect(savedBar()).toEqual({ order: [], hidden: ['mail'] })
    expect(JSON.parse(localStorage.getItem(RAIL_PAGES_STORAGE_KEY)!)).toEqual({ order: [], hidden: ['mail'] })
    // Still the default order: the hairlines stay.
    expect(lines()).toBe(2)
    expect(container.querySelector('[data-app-rail-announce]')?.textContent).toBe('Mail unpinned from the bar')
  })

  it('moves a page from its right-click menu, Move up off at the top; a custom order loses the hairlines', async () => {
    await render()
    await rightClick('drive')
    expect(menuItem('up')!.hasAttribute('data-disabled')).toBe(true)
    await pick('down')
    expect(bar().slice(0, 3)).toEqual(['mail', 'drive', 'team-chat'])
    expect(lines()).toBe(0)
    expect(Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-group]')).map((g) => g.dataset.appRailGroup)).toEqual(['custom'])
    expect(document.activeElement).toBe(item('drive'))
    await rightClick('drive')
    await pick('up')
    expect(bar()).toEqual(DEFAULT_BAR)
    // Back in the default order: saved as none, the hairlines back.
    expect(savedBar()).toEqual({ order: [], hidden: [] })
    expect(lines()).toBe(2)
  })

  it('moves the focused icon with Alt+↑/↓, keeps the focus on it and says where it went', async () => {
    await render()
    item('calendar')!.focus()
    await act(async () => {
      item('calendar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    })
    expect(bar().slice(0, 5)).toEqual(['drive', 'mail', 'team-chat', 'calendar', 'actions'])
    expect(document.activeElement).toBe(item('calendar'))
    expect(container.querySelector('[data-app-rail-announce]')?.textContent).toBe('Calendar moved to 4 of 10')
    expect(lines()).toBe(0)
    await act(async () => {
      item('calendar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))
    })
    expect(bar()).toEqual(DEFAULT_BAR)
    expect(document.activeElement).toBe(item('calendar'))
    // A plain arrow is no move.
    await act(async () => {
      item('calendar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    expect(bar()).toEqual(DEFAULT_BAR)
  })

  it('opens Customize bar from its icon: a switch per page hides and shows its icon; Reset to default', async () => {
    await render()
    expect(item('customize')?.getAttribute('aria-label')).toBe('Customize bar')
    // After a hairline, at the bar's end.
    expect(container.querySelector('[data-app-rail-customize-line]')).not.toBeNull()
    await act(async () => item('customize')!.click())
    const panel = document.querySelector<HTMLElement>('[data-app-rail-customize]')!
    expect(panel.textContent).toContain('Navigation bar')
    expect(panel.textContent).toContain('Hidden pages still open from Search and /.')
    expect(Array.from(panel.querySelectorAll<HTMLElement>('[data-app-rail-customize-row]')).map((r) => r.dataset.appRailCustomizeRow)).toEqual(DEFAULT_BAR)
    // Nested under Tasks (Liam, 11-11): not in Customize bar either.
    expect(panel.querySelector('[data-app-rail-customize-row="projects"]')).toBeNull()
    expect(panel.querySelector('[data-app-rail-customize-row="initiatives"]')).toBeNull()
    // The page groups, not their members (Liam, 11-11).
    for (const member of ['companies', 'deals', 'captures', 'prospecting', 'sequences', 'campaigns', 'docs', 'knowledge', 'files', 'flows', 'evals']) expect(panel.querySelector(`[data-app-rail-customize-row="${member}"]`)).toBeNull()
    const toggle = (id: string) => panel.querySelector<HTMLButtonElement>(`[data-app-rail-customize-row="${id}"] [role="switch"]`)!
    expect(toggle('outreach').getAttribute('aria-checked')).toBe('true')
    expect(toggle('outreach').getAttribute('aria-label')).toBe('Show Outreach in the bar')
    const reset = panel.querySelector<HTMLButtonElement>('[data-app-rail-customize-reset]')!
    expect(reset.disabled).toBe(true)
    await act(async () => toggle('outreach').click())
    expect(item('outreach')).toBeNull()
    expect(toggle('outreach').getAttribute('aria-checked')).toBe('false')
    // A hidden group is saved as all its members.
    expect(savedBar()).toEqual({ order: [], hidden: ['prospecting', 'sequences', 'campaigns'] })
    await act(async () => toggle('outreach').click())
    expect(item('outreach')).not.toBeNull()
    await act(async () => toggle('mail').click())
    expect(reset.disabled).toBe(false)
    await act(async () => reset.click())
    expect(bar()).toEqual(DEFAULT_BAR)
    expect(savedBar()).toEqual({ order: [], hidden: [] })
  })

  it('opens Customize bar from an icon’s menu, its rows in the person’s order', async () => {
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order: ['calendar', ...DEFAULT_BAR.filter((id) => id !== 'calendar')], hidden: ['mail'] }))
    await render()
    expect(bar()[0]).toBe('calendar')
    expect(bar()).not.toContain('mail')
    await rightClick('calendar')
    await pick('customize')
    const panel = document.querySelector<HTMLElement>('[data-app-rail-customize]')!
    expect(panel).not.toBeNull()
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('[data-app-rail-customize-row]')).map((r) => r.dataset.appRailCustomizeRow)
    expect(rows[0]).toBe('calendar')
    expect(rows).toContain('mail')
    // Teams nests under My Actions (Liam, 11-11): not a row of its own.
    expect(rows).not.toContain('teams')
  })

  it('shows just Home and Customize bar when every page is hidden', async () => {
    // A group hidden: every one of its members (Calendar and Contacts are members of their own groups).
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order: [], hidden: [...DEFAULT_BAR, 'availability', 'captures', 'companies', 'deals', 'flows', 'evals', 'seo-audit', 'seo-keywords', 'seo-rankings', 'seo-search', 'seo-competitors', 'seo-backlinks', 'seo-ai-visibility', 'seo-local'] }))
    await render()
    const nav = container.querySelector<HTMLElement>('[data-app-rail-nav]')!
    expect(Array.from(nav.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)).toEqual(['home', 'customize'])
    // One hairline, Home's.
    expect(container.querySelector('[data-app-rail-customize-line]')).toBeNull()
    expect(container.querySelectorAll('[data-app-rail-home-line]')).toHaveLength(1)
  })

  it('loads a bar saved while Projects, Initiatives and Teams had icons (Liam, 11-11: they nest under Tasks): their ids are skipped, and dropped at the next save', async () => {
    const order = ['calendar', 'projects', 'initiatives', ...DEFAULT_BAR.filter((id) => id !== 'calendar'), 'teams']
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order, hidden: ['initiatives', 'teams'] }))
    await render()
    expect(item('projects')).toBeNull()
    expect(item('initiatives')).toBeNull()
    expect(item('teams')).toBeNull()
    expect(bar()).toEqual(['calendar', ...DEFAULT_BAR.filter((id) => id !== 'calendar')])
    // Groups: a custom order is one list, as before.
    expect(lines()).toBe(0)
    await rightClick('mail')
    await pick('unpin')
    const saved = savedBar()
    expect(saved.order).not.toContain('projects')
    expect(saved.order).not.toContain('initiatives')
    expect(saved.order).not.toContain('teams')
    expect(saved.hidden).toEqual(['mail'])
  })

  it('puts a page the saved bar doesn’t mention in its default place, and skips one the workspace doesn’t offer', async () => {
    edition.current = withEffectiveSurface(getEdition('full'), { email: 'off' })
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order: ['mail', 'team-chat', 'docs'], hidden: [] }))
    await render()
    expect(bar().slice(0, 3)).toEqual(['team-chat', 'actions', 'calendar'])
    // Docs saved before Drive: Drive stands there.
    expect(bar()).toContain('drive')
    expect(bar()).not.toContain('mail')
  })
})

describe('dragging an icon up or down the bar', () => {
  // jsdom lays nothing out: each icon 32px tall, 2px apart, from y=100.
  let rects: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const icons = Array.from(document.querySelectorAll<HTMLElement>('[data-app-rail-page]'))
      const i = icons.indexOf(this)
      const top = i < 0 ? 96 : 100 + i * 34
      return { top, bottom: top + 32, height: 32, left: 0, right: 32, width: 32, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
  })
  afterEach(() => rects.mockRestore())

  const pointer = (type: string, clientY: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })
    Object.defineProperty(e, 'pointerId', { value: 1 })
    return e
  }
  const centre = (i: number) => 100 + i * 34 + 16
  const dropLine = () => container.querySelector<HTMLElement>('[data-app-rail-drop-line]')!

  it('draws one drop line where the icon would land, moves it there on release, and swallows the release’s click', async () => {
    await render()
    const asked: OpenCardRequest[] = []
    const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    // Hidden at rest.
    expect(dropLine().style.display).toBe('')
    const mail = item('mail')!
    await act(async () => mail.dispatchEvent(pointer('pointerdown', centre(1))))
    // Past Calendar's centre (slot 4): the line between Calendar and Captures.
    await act(async () => window.dispatchEvent(pointer('pointermove', centre(4) + 2)))
    expect(mail.hasAttribute('data-dragging')).toBe(true)
    expect(dropLine().style.display).toBe('block')
    expect(dropLine().style.top).toBe(`${100 + 4 * 34 + 32 + 1 - 96}px`)
    // Back over its own place: no line.
    await act(async () => window.dispatchEvent(pointer('pointermove', centre(1) - 5)))
    expect(dropLine().style.display).toBe('')
    await act(async () => window.dispatchEvent(pointer('pointermove', centre(4) + 2)))
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', centre(4) + 2))
      mail.click()
    })
    window.removeEventListener(OPEN_CARD_EVENT, listen)
    expect(asked).toEqual([])
    expect(dropLine().style.display).toBe('')
    expect(item('mail')!.hasAttribute('data-dragging')).toBe(false)
    expect(bar().slice(0, 5)).toEqual(['drive', 'team-chat', 'actions', 'calendar', 'mail'])
    expect(savedBar()?.order.slice(0, 5)).toEqual(['drive', 'team-chat', 'actions', 'calendar', 'mail'])
  })

  it('takes a press that barely moves as a click, and Esc puts a drag back', async () => {
    await render()
    const asked: OpenCardRequest[] = []
    const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    const mail = item('mail')!
    await act(async () => mail.dispatchEvent(pointer('pointerdown', centre(1))))
    await act(async () => window.dispatchEvent(pointer('pointermove', centre(1) + 3)))
    expect(mail.hasAttribute('data-dragging')).toBe(false)
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', centre(1) + 3))
      mail.click()
    })
    expect(asked.map((r) => r.spec.kind)).toEqual(['mail'])

    await act(async () => mail.dispatchEvent(pointer('pointerdown', centre(1))))
    await act(async () => window.dispatchEvent(pointer('pointermove', centre(6))))
    expect(dropLine().style.display).toBe('block')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(dropLine().style.display).toBe('')
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', centre(6)))
      mail.click()
    })
    window.removeEventListener(OPEN_CARD_EVENT, listen)
    expect(asked).toHaveLength(1)
    expect(bar()).toEqual(DEFAULT_BAR)
    expect(savedBar()).toBeUndefined()
  })
})

describe('page groups (Liam, 11-11: "Contacts: Companies, Contacts, Deals · Outreach: Prospecting, Sequences, Campaigns · Calendar: Captures")', () => {
  const ownSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec
  const opens = async (id: string) => {
    const asked: OpenCardRequest[] = []
    const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    await act(async () => item(id)!.click())
    window.removeEventListener(OPEN_CARD_EVENT, listen)
    return asked
  }

  it('one icon per group, the group’s label and icon, no member icons', async () => {
    await render()
    for (const member of ['companies', 'deals', 'captures', 'prospecting', 'sequences', 'campaigns']) expect(item(member), member).toBeNull()
    expect(item('contacts')!.getAttribute('aria-label')).toBe('Contacts')
    expect(item('contacts')!.querySelector('svg.lucide-contact')).not.toBeNull()
    expect(item('outreach')!.getAttribute('aria-label')).toBe('Outreach')
    expect(item('outreach')!.querySelector('svg.lucide-send')).not.toBeNull()
    expect(item('calendar')!.getAttribute('aria-label')).toBe('Calendar')
    expect(item('calendar')!.querySelector('svg.lucide-calendar')).not.toBeNull()
  })

  it('a group’s icon opens its default member, then the member last used on this device', async () => {
    await render()
    expect((await opens('outreach')).map((r) => r.spec)).toEqual([ownSpec('prospecting')])
    expect((await opens('contacts')).map((r) => r.spec.title)).toEqual(['Contacts'])
    // Deals came in front (opened from `/`): remembered here.
    await act(async () => {
      releases.push(holdFrontCard({ id: 'deals-1', spec: ownSpec('deals'), close: () => {} }))
    })
    expect(JSON.parse(localStorage.getItem(GROUP_LAST_PAGE_KEY)!)).toEqual({ contacts: 'deals' })
    const asked = await opens('contacts')
    expect(asked.map((r) => r.spec)).toEqual([ownSpec('deals')])
    expect(asked[0].from).toBe('rail')
  })

  it('reads a last used member saved before (another session), and skips one that is off here', async () => {
    localStorage.setItem(GROUP_LAST_PAGE_KEY, JSON.stringify({ calendar: 'captures', outreach: 'nope' }))
    await render()
    expect((await opens('calendar')).map((r) => r.spec.title)).toEqual(['Captures'])
    expect((await opens('outreach')).map((r) => r.spec)).toEqual([ownSpec('prospecting')])
  })

  it('lights the group while any member page’s own card is in front, and keeps it for a record opened from inside', async () => {
    const layer = document.createElement('div')
    layer.setAttribute('data-chat-card-fullscreen', 'deals-1')
    const row = document.createElement('button')
    layer.appendChild(row)
    document.body.appendChild(layer)
    await render()
    let releasePage = () => {}
    await act(async () => {
      releasePage = holdFrontCard({ id: 'deals-1', spec: ownSpec('deals'), close: () => {} })
    })
    expect(lit()).toEqual(['contacts'])
    expect(item('contacts')!.getAttribute('aria-current')).toBe('page')
    row.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await act(async () => {
      releasePage()
      releases.push(holdFrontCard({ id: 'r1', spec: { kind: 'record', title: 'Fernhill renewal', record: { type: 'deal', id: 'd1' } }, close: () => {} }))
    })
    expect(lit()).toEqual(['contacts'])
    layer.remove()
    await act(async () => releases.pop()!())
    // Captures: Calendar lit.
    await act(async () => {
      releases.push(holdFrontCard({ id: 'cap-1', spec: ownSpec('captures'), close: () => {} }))
    })
    expect(lit()).toEqual(['calendar'])
  })

  it('a deal opened from home keeps Home lit', async () => {
    await render()
    await act(async () => {
      releases.push(holdFrontCard({ id: 'r1', spec: { kind: 'record', title: 'Fernhill renewal', record: { type: 'deal', id: 'd1' } }, close: () => {} }))
    })
    expect(lit()).toEqual(['home'])
  })

  it('loads a bar saved with member ids: each group where its first member stood; hidden only when all its members were', async () => {
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({
      order: ['deals', 'captures', 'docs', 'mail', 'team-chat', 'actions', 'calendar', 'knowledge', 'flows', 'companies', 'contacts', 'prospecting', 'sequences', 'campaigns', 'agents', 'evals', 'teams'],
      hidden: ['deals', 'prospecting', 'sequences', 'campaigns'],
    }))
    await render()
    // Drive where Docs was; Agents where Flows was, its first member saved.
    // Studio, not in the saved order, lands after Calendar (its default place). SEO came after this bar
    // was saved too: a page it doesn't mention, shown, after the rest.
    expect(bar()).toEqual(['contacts', 'calendar', 'studio', 'drive', 'mail', 'team-chat', 'actions', 'agents', 'seo'])
    // The next save keeps rail ids in the order, and a hidden group as its members.
    await rightClick('mail')
    await pick('unpin')
    expect(savedBar()).toEqual({
      order: ['contacts', 'calendar', 'drive', 'mail', 'team-chat', 'actions', 'agents', 'outreach'],
      hidden: ['prospecting', 'sequences', 'campaigns', 'mail'],
    })
  })

  it('a group with one member on: its icon opens that member; with none: no icon', async () => {
    edition.current = withEffectiveSurface(getEdition('full'), { prospecting: 'off', campaigns: 'off' })
    await render()
    expect(item('outreach')!.getAttribute('aria-label')).toBe('Outreach')
    expect((await opens('outreach')).map((r) => r.spec)).toEqual([ownSpec('sequences')])
    act(() => root.unmount())
    root = createRoot(container)
    edition.current = withEffectiveSurface(getEdition('full'), { prospecting: 'off', sequences: 'off', campaigns: 'off', crm: 'off' })
    await render()
    expect(item('outreach')).toBeNull()
    expect(item('contacts')).toBeNull()
    expect(item('calendar')).not.toBeNull()
  })
})

describe('Drive and Agents (Liam, 11-11: "Drive: Docs, Knowledge, and a new page that shows all available files … Agents: Agents & Skills, Flows, Evals")', () => {
  const ownSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec

  it('one icon each, Drive’s HardDrive where Docs stood and Agents’ Sparkles, no member icons and no empty section', async () => {
    await render()
    for (const member of ['docs', 'knowledge', 'files', 'flows', 'evals']) expect(item(member), member).toBeNull()
    expect(item('drive')!.getAttribute('aria-label')).toBe('Drive')
    expect(item('drive')!.querySelector('svg.lucide-hard-drive')).not.toBeNull()
    expect(item('agents')!.getAttribute('aria-label')).toBe('Agents')
    expect(item('agents')!.querySelector('svg.lucide-sparkles')).not.toBeNull()
    expect(container.querySelector('[data-app-rail-group="plans"]')).toBeNull()
  })

  it('opens Docs and Agents & skills by default, and lights its group for any member’s own card', async () => {
    await render()
    const asked: OpenCardRequest[] = []
    const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    await act(async () => item('drive')!.click())
    await act(async () => item('agents')!.click())
    window.removeEventListener(OPEN_CARD_EVENT, listen)
    expect(asked.map((r) => r.spec)).toEqual([ownSpec('docs'), ownSpec('agents')])
    await act(async () => {
      releases.push(holdFrontCard({ id: 'files-1', spec: ownSpec('files'), close: () => {} }))
    })
    expect(lit()).toEqual(['drive'])
    await act(async () => {
      releases.push(holdFrontCard({ id: 'flows-1', spec: ownSpec('flows'), close: () => {} }))
    })
    expect(lit()).toEqual(['agents'])
  })
})

describe('SEO (one page per section: Site audit today)', () => {
  const ownSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec

  it('one icon after Outreach, SearchCheck, that opens Site audit and lights for its card; off with the feature', async () => {
    await render()
    expect(item('seo-audit')).toBeNull()
    expect(item('seo')!.getAttribute('aria-label')).toBe('SEO')
    expect(item('seo')!.querySelector('svg.lucide-search-check')).not.toBeNull()
    expect(bar().indexOf('seo')).toBe(bar().indexOf('outreach') + 1)
    const asked: OpenCardRequest[] = []
    const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    await act(async () => item('seo')!.click())
    window.removeEventListener(OPEN_CARD_EVENT, listen)
    expect(asked.map((r) => r.spec)).toEqual([ownSpec('seo-audit')])
    await act(async () => {
      releases.push(holdFrontCard({ id: 'seo-1', spec: ownSpec('seo-audit'), close: () => {} }))
    })
    expect(lit()).toEqual(['seo'])
    act(() => root.unmount())
    root = createRoot(container)
    edition.current = withEffectiveSurface(getEdition('full'), { seo: 'off' })
    await render()
    expect(item('seo')).toBeNull()
  })
})
