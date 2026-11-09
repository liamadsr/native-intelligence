// @vitest-environment jsdom
/**
 * The app rail (../app-rail.tsx): its icons in Liam's order, a page opens as
 * `/` opens it (OPEN_CARD_EVENT, full screen in the main chat), the page in
 * front is lit (no Home or New button: Liam, 11-09), and <html> carries
 * the rail's width attribute for the full-screen layer while it is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { getEdition, withEffectiveSurface, type EditionDefinition } from '@/lib/editions/manifest'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { __resetRailPrefsForTests } from '@/lib/rail-prefs-store'
import { RAIL_PAGES_STORAGE_KEY } from '@/lib/rail-prefs'

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
// For you's button (side-panels): its own tests; here, where it sits.
vi.mock('../../side-panels/side-panel-toggles', async () => {
  const React = await import('react')
  return { ForYouToggle: ({ variant }: { variant?: string }) => React.createElement('button', { 'data-for-you-panel-toggle': '', 'data-variant': variant }) }
})

import { APP_RAIL_ATTR, AppRail } from '../app-rail'

let container: HTMLDivElement
let root: Root
const releases: Array<() => void> = []

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{"success":true}', { status: 200 }))

beforeEach(() => {
  localStorage.clear()
  __resetRailPrefsForTests()
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
  it('draws the header (the workspace’s thumbnail, For you, Search), then every page that is on, and no Home or New', async () => {
    await render()
    const header = container.querySelector<HTMLElement>('[data-app-rail-header]')!
    // In order: the workspace's thumbnail at the far left, For you, Search (Liam, 11-09).
    const order = Array.from(header.querySelectorAll<HTMLElement>('[data-app-rail-item="workspace"], [data-for-you-panel-toggle], [data-app-rail-item="search"]')).map((el) =>
      el.hasAttribute('data-for-you-panel-toggle') ? 'for-you' : el.dataset.appRailItem,
    )
    expect(order).toEqual(['workspace', 'for-you', 'search'])
    expect(header.querySelector('[data-for-you-panel-toggle]')?.getAttribute('data-variant')).toBe('header')
    // The one workspace and account menu (Liam, 11-09), the header's variant.
    expect(header.querySelector('[data-app-rail-item="workspace"] [data-variant="header"]')).not.toBeNull()
    const nav = container.querySelector<HTMLElement>('[data-app-rail-nav]')!
    expect(Array.from(nav.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)).toEqual([
      'docs', 'mail', 'team-chat', 'actions', 'calendar', 'captures',
      'projects', 'initiatives', 'knowledge', 'flows',
      'companies', 'contacts', 'deals', 'prospecting', 'sequences', 'campaigns',
      'agents', 'evals', 'teams',
      // Customize bar, at its end (Liam, 11-09).
      'customize',
    ])
    expect(item('mail')?.getAttribute('aria-label')).toBe('Mail')
  })

  it('floats one bar like Miro’s toolbar ("one big bar instead of four"), a hairline between its groups, with the panels’ glass', async () => {
    await render()
    const pills = Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-pill]'))
    expect(pills.map((p) => p.dataset.appRailPill)).toEqual(['pages'])
    expect(Array.from(pills[0].querySelectorAll<HTMLElement>('[data-app-rail-group]')).map((g) => g.dataset.appRailGroup)).toEqual(['work', 'plans', 'customers', 'agents'])
    expect(pills[0].querySelectorAll('[data-app-rail-group-line]')).toHaveLength(3)
    // At the top, not centred (Liam, 11-09: "top align it so it's not center").
    expect(pills[0].parentElement!.className).not.toContain('my-auto')
    // No Home or New button (Liam, 11-09: "we don't need this button").

    expect(item('home')).toBeNull()
    expect(item('new')).toBeNull()
    for (const pill of [...pills, container.querySelector<HTMLElement>('[data-app-rail-header]')!]) {
      expect(pill.className).toContain('rounded-2xl')
      expect(pill.className).toContain('bg-background/70')
      expect(pill.className).toContain('backdrop-blur-md')
      expect(pill.className).toContain('border-border/60')
    }
    expect(pills[0].querySelector('[data-app-rail-item="mail"]')).not.toBeNull()
    // Round hovers and lit states (Liam, 11-09: "the hover states should be circle").
    expect(item('mail')!.className.split(' ')).toContain('rounded-full')
    expect(item('search')!.className.split(' ')).toContain('rounded-full')
    expect(pills[0].querySelector('[data-app-rail-item="deals"]')).not.toBeNull()
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

  it('lights nothing with no page in front, and the page in front when there is one', async () => {
    await render()
    expect(lit()).toEqual([])
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'team_chat', title: 'Team chat' }, close: () => {} }))
    })
    expect(lit()).toEqual(['team-chat'])
    await act(async () => releases.pop()!())
    expect(lit()).toEqual([])
  })

  it('lights nothing for a card no rail page shows', async () => {
    await render()
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'work_item', title: 'A review' } as never, close: () => {} }))
    })
    expect(lit()).toEqual([])
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
  'docs', 'mail', 'team-chat', 'actions', 'calendar', 'captures',
  'projects', 'initiatives', 'knowledge', 'flows',
  'companies', 'contacts', 'deals', 'prospecting', 'sequences', 'campaigns',
  'agents', 'evals', 'teams',
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
    expect(lines()).toBe(3)
    expect(container.querySelector('[data-app-rail-announce]')?.textContent).toBe('Mail unpinned from the bar')
  })

  it('moves a page from its right-click menu, Move up off at the top; a custom order loses the hairlines', async () => {
    await render()
    await rightClick('docs')
    expect(menuItem('up')!.hasAttribute('data-disabled')).toBe(true)
    await pick('down')
    expect(bar().slice(0, 3)).toEqual(['mail', 'docs', 'team-chat'])
    expect(lines()).toBe(0)
    expect(Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-group]')).map((g) => g.dataset.appRailGroup)).toEqual(['custom'])
    expect(document.activeElement).toBe(item('docs'))
    await rightClick('docs')
    await pick('up')
    expect(bar()).toEqual(DEFAULT_BAR)
    // Back in the default order: saved as none, the hairlines back.
    expect(savedBar()).toEqual({ order: [], hidden: [] })
    expect(lines()).toBe(3)
  })

  it('moves the focused icon with Alt+↑/↓, keeps the focus on it and says where it went', async () => {
    await render()
    item('calendar')!.focus()
    await act(async () => {
      item('calendar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    })
    expect(bar().slice(0, 5)).toEqual(['docs', 'mail', 'team-chat', 'calendar', 'actions'])
    expect(document.activeElement).toBe(item('calendar'))
    expect(container.querySelector('[data-app-rail-announce]')?.textContent).toBe('Calendar moved to 4 of 19')
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
    const toggle = (id: string) => panel.querySelector<HTMLButtonElement>(`[data-app-rail-customize-row="${id}"] [role="switch"]`)!
    expect(toggle('deals').getAttribute('aria-checked')).toBe('true')
    expect(toggle('deals').getAttribute('aria-label')).toBe('Show Deals in the bar')
    const reset = panel.querySelector<HTMLButtonElement>('[data-app-rail-customize-reset]')!
    expect(reset.disabled).toBe(true)
    await act(async () => toggle('deals').click())
    expect(item('deals')).toBeNull()
    expect(toggle('deals').getAttribute('aria-checked')).toBe('false')
    expect(savedBar()).toEqual({ order: [], hidden: ['deals'] })
    await act(async () => toggle('deals').click())
    expect(item('deals')).not.toBeNull()
    await act(async () => toggle('mail').click())
    expect(reset.disabled).toBe(false)
    await act(async () => reset.click())
    expect(bar()).toEqual(DEFAULT_BAR)
    expect(savedBar()).toEqual({ order: [], hidden: [] })
  })

  it('opens Customize bar from an icon’s menu, its rows in the person’s order', async () => {
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order: ['calendar', ...DEFAULT_BAR.filter((id) => id !== 'calendar')], hidden: ['teams'] }))
    await render()
    expect(bar()[0]).toBe('calendar')
    expect(bar()).not.toContain('teams')
    await rightClick('calendar')
    await pick('customize')
    const panel = document.querySelector<HTMLElement>('[data-app-rail-customize]')!
    expect(panel).not.toBeNull()
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('[data-app-rail-customize-row]')).map((r) => r.dataset.appRailCustomizeRow)
    expect(rows[0]).toBe('calendar')
    expect(rows).toContain('teams')
  })

  it('shows just Customize bar when every page is hidden', async () => {
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order: [], hidden: DEFAULT_BAR }))
    await render()
    const nav = container.querySelector<HTMLElement>('[data-app-rail-nav]')!
    expect(Array.from(nav.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)).toEqual(['customize'])
    expect(container.querySelector('[data-app-rail-customize-line]')).toBeNull()
  })

  it('puts a page the saved bar doesn’t mention in its default place, and skips one the workspace doesn’t offer', async () => {
    edition.current = withEffectiveSurface(getEdition('full'), { email: 'off' })
    localStorage.setItem(RAIL_PAGES_STORAGE_KEY, JSON.stringify({ order: ['mail', 'team-chat', 'docs'], hidden: [] }))
    await render()
    expect(bar().slice(0, 3)).toEqual(['team-chat', 'actions', 'calendar'])
    expect(bar()).toContain('docs')
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
    expect(bar().slice(0, 5)).toEqual(['docs', 'team-chat', 'actions', 'calendar', 'mail'])
    expect(savedBar()?.order.slice(0, 5)).toEqual(['docs', 'team-chat', 'actions', 'calendar', 'mail'])
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
