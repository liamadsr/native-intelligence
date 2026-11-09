// @vitest-environment jsdom
/**
 * The app rail (../app-rail.tsx): its icons in Liam's order, a page opens as
 * `/` opens it (OPEN_CARD_EVENT, full screen in the main chat), the page in
 * front is lit (Home with none), Home and New put it away, and <html> carries
 * the rail's width attribute for the full-screen layer while it is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { getEdition, withEffectiveSurface, type EditionDefinition } from '@/lib/editions/manifest'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { holdFrontCard } from '@/components/chat-cards/front-card'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { edition, openSettings, openSearch } = vi.hoisted(() => ({
  edition: { current: null as EditionDefinition | null },
  openSettings: vi.fn(),
  openSearch: vi.fn(() => true),
}))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceEdition: () => edition.current }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => ({ openSettings }) }))
vi.mock('@/lib/chat/open-search', () => ({ openSearch }))

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
  await act(async () => root.render(h(AppRail, { avatarUrl: null, initials: 'FS' })))
}
const item = (id: string) => container.querySelector<HTMLButtonElement>(`[data-app-rail-item="${id}"]`)
const items = () => Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-item]')).map((el) => el.dataset.appRailItem)
const lit = () => Array.from(container.querySelectorAll<HTMLElement>('[aria-current="page"]')).map((el) => el.dataset.appRailItem)

describe('the app rail', () => {
  it('draws New, Search, Home, the pages and Settings, in Liam’s order', async () => {
    await render()
    expect(items()).toEqual(['new', 'search', 'home', 'docs', 'mail', 'team-chat', 'actions', 'calendar', 'agents', 'crm', 'settings'])
    expect(item('mail')?.getAttribute('aria-label')).toBe('Mail')
    expect(item('settings')?.textContent).toBe('FS')
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

  it('lights Home with no page in front, and the page in front when there is one', async () => {
    await render()
    expect(lit()).toEqual(['home'])
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'team_chat', title: 'Team chat' }, close: () => {} }))
    })
    expect(lit()).toEqual(['team-chat'])
    await act(async () => releases.pop()!())
    expect(lit()).toEqual(['home'])
  })

  it('lights nothing for a card no rail page shows', async () => {
    await render()
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'flows', title: 'Flows' }, close: () => {} }))
    })
    expect(lit()).toEqual([])
  })

  it('puts the page in front away from Home', async () => {
    await render()
    const close = vi.fn()
    await act(async () => {
      releases.push(holdFrontCard({ id: 'c1', spec: { kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }, close }))
    })
    await act(async () => item('home')!.click())
    expect(close).toHaveBeenCalledTimes(1)
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

  it('opens Search from its button, and Settings from the avatar', async () => {
    await render()
    await act(async () => item('search')!.click())
    expect(openSearch).toHaveBeenCalledWith(item('search'))
    await act(async () => item('settings')!.click())
    expect(openSettings).toHaveBeenCalledTimes(1)
  })
})
