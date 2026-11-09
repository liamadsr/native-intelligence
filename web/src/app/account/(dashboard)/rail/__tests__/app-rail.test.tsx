// @vitest-environment jsdom
/**
 * The app rail (../app-rail.tsx): its icons in Liam's order, a page opens as
 * `/` opens it (OPEN_CARD_EVENT, full screen in the main chat), the page in
 * front is lit, New puts it away (no Home button: Liam, 11-09), and <html> carries
 * the rail's width attribute for the full-screen layer while it is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { getEdition, withEffectiveSurface, type EditionDefinition } from '@/lib/editions/manifest'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { holdFrontCard } from '@/components/chat-cards/front-card'

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

beforeEach(() => {
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
})

async function render() {
  await act(async () => root.render(h(AppRail)))
}
const item = (id: string) => container.querySelector<HTMLButtonElement>(`[data-app-rail-item="${id}"]`)
const items = () => Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)
const lit = () => Array.from(container.querySelectorAll<HTMLElement>('[aria-current="page"]')).map((el) => el.dataset.appRailItem)

describe('the app rail', () => {
  it('draws the header (the workspace’s thumbnail, For you, Search), then New and every page that is on, and no Home', async () => {
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
      'new',
      'docs', 'mail', 'team-chat', 'actions', 'calendar', 'captures',
      'projects', 'initiatives', 'knowledge', 'flows',
      'companies', 'contacts', 'deals', 'prospecting', 'sequences', 'campaigns',
      'agents', 'evals', 'teams',
    ])
    expect(item('mail')?.getAttribute('aria-label')).toBe('Mail')
  })

  it('floats its pills like Miro’s toolbar: New, then a pill per group, each with the panels’ glass', async () => {
    await render()
    const pills = Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-pill]'))
    expect(pills.map((p) => p.dataset.appRailPill)).toEqual(['new', 'work', 'plans', 'customers', 'agents'])
    // No Home button (Liam, 11-09: "we don't need this button").
    expect(item('home')).toBeNull()
    for (const pill of [...pills, container.querySelector<HTMLElement>('[data-app-rail-header]')!]) {
      expect(pill.className).toContain('rounded-2xl')
      expect(pill.className).toContain('bg-background/70')
      expect(pill.className).toContain('backdrop-blur-md')
      expect(pill.className).toContain('border-border/60')
    }
    expect(pills[1].querySelector('[data-app-rail-item="mail"]')).not.toBeNull()
    expect(pills[3].querySelector('[data-app-rail-item="deals"]')).not.toBeNull()
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

  it('New puts the page away and the cursor in the chat’s composer', async () => {
    const strip = document.createElement('div')
    strip.id = 'dial8-chat-strip-slot'
    strip.innerHTML = '<div data-chat-input-root><textarea></textarea></div>'
    document.body.appendChild(strip)
    await render()
    let release = () => {}
    // Its close puts it back a moment later, as the chat's next commit does.
    const close = vi.fn(() => setTimeout(release, 30))
    await act(async () => {
      release = holdFrontCard({ id: 'c1', spec: { kind: 'calendar', title: 'This week', calendar: { from: '2026-11-08', to: '2026-11-14', view: 'week' } }, close })
    })
    await act(async () => item('new')!.click())
    expect(close).toHaveBeenCalledTimes(1)
    // Not while the page is still in front (the chat under it takes no focus)…
    expect(document.activeElement).not.toBe(strip.querySelector('textarea'))
    // …but once it has gone.
    await act(async () => new Promise((r) => setTimeout(r, 120)))
    expect(document.activeElement).toBe(strip.querySelector('textarea'))
    strip.remove()
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
