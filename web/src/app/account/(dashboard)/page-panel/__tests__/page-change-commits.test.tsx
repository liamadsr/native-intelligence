// @vitest-environment jsdom
/**
 * The page change, counted in commits (Liam, 11-11: "It still feels kind of
 * laggy like it goes away completely and reappears every time and it feels
 * not smooth" … "it's only on first load that's it's a bit laggy then when I
 * go back and fourth its quick").
 *
 * A test-only timing harness: the real host (page-panel.tsx) under a
 * Profiler, the row's plan as the shell answers it, and the card in front
 * switched from one page's to the next in one step, as the rail does. For
 * each change it records every commit from the switch until the next page's
 * sub-nav is on screen with rows, and whether the slot stood empty in any of
 * them. The page's card never says where it is (nothing published): what the
 * sub-nav shows then is what it knows without its card.
 *
 * Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, Profiler, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-home' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/account' }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('@/components/account-filter-dropdown', () => ({ useConnectedAccounts: () => [] }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [], grouped: [], loading: false }) }))
vi.mock('@/app/account/teams-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/account/teams-context')>()),
  useTeams: () => ({ teams: [], loading: false, refetchTeams: async () => {} }),
}))
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

import { PAGE_PANEL_HOLD_MAX_MS, PagePanelHost } from '../page-panel'
import { PAGE_PANEL_W_VAR } from '@/components/chat-cards/front-card'
import type { FeedEntry } from '@/lib/entities/feed-model'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { __resetSelectedPlaceForTests } from '../../rail/selected-place'
import { __resetTasksCardsForTests } from '@/components/chat-cards/tasks-card-controls'
import { __resetMailCardsForTests } from '@/components/chat-cards/mail-card-controls'
import { __resetTeamChatCardsForTests } from '@/components/chat-cards/team-chat-card-controls'

const specOf = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec

let container: HTMLDivElement
let root: Root
let release: (() => void) | null = null
/** Per commit: the page whose panel is on screen (null: the slot empty), and whether its rows are there. */
let commits: Array<{ shown: string | null; rows: boolean; held: boolean }> = []

beforeEach(() => {
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetTasksCardsForTests()
  __resetMailCardsForTests()
  __resetTeamChatCardsForTests()
  store.resetSidePanelStore()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], next_cursor: null }) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  if (release) act(() => release!())
  release = null
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

const ROWS = '[data-tasks-row], [data-mail-row], [data-team-chat-mode-option], [data-page-group-row]'

function record() {
  const aside = container.querySelector<HTMLElement>('aside[data-page-panel]:not([data-page-panel-mode="off"])')
  commits.push({
    shown: aside?.getAttribute('data-page-panel') ?? null,
    rows: !!aside?.querySelector(ROWS),
    held: !!aside?.hasAttribute('inert'),
  })
}

function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return (
    <Profiler id="row" onRender={record}>
      <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
    </Profiler>
  )
}

/** The rail's switch: the card in front goes from one page's to the next's in one step. */
async function switchTo(slug: string) {
  act(() => {
    const was = release
    release = holdFrontCard({ id: `card-${slug}`, spec: specOf(slug), close: () => {} })
    was?.()
  })
  await flush()
}

/** From the page change: commits until `page`'s sub-nav is on screen (not held) with rows; and any commit with the slot empty. */
function measure(page: string) {
  const at = commits.findIndex((c) => c.shown === page && c.rows && !c.held)
  return { commits: at < 0 ? null : at + 1, emptySlot: commits.slice(0, at < 0 ? undefined : at).some((c) => c.shown === null) }
}

describe('a page change, in commits (harness)', () => {
  it('each page’s sub-nav: on screen within the switch’s own commits, before its card says anything; the slot never empty', async () => {
    act(() => root.render(<Row />))
    await flush()
    const results: Record<string, ReturnType<typeof measure>> = {}
    // Page to page, as Liam measured: My Actions, Mail, Team chat, Contacts (Deals), My Actions again.
    for (const [page, slug] of [
      ['actions', 'actions'],
      ['mail', 'mail'],
      ['team-chat', 'team-chat'],
      ['contacts', 'deals'],
      ['actions again', 'actions'],
    ] as const) {
      commits = []
      await switchTo(slug)
      results[page] = measure(page === 'actions again' ? 'actions' : page)
    }
    console.info('[page-change commits]', JSON.stringify(results))
    // Two commits, both in the switch's own task (before paint): the card in front changes (the last panel still
    // on), then the selected place settles (rail/selected-place.ts, a microtask) and the next panel is there.
    // Before 11-11's fix: Tasks, Mail and Team chat never, until their card had loaded and said where it is
    // (a lazy chunk and a fetch later); Contacts 3, with the slot empty between.
    for (const [page, r] of Object.entries(results)) {
      expect(r.commits, page).toBeLessThanOrEqual(page === 'actions' ? 3 : 2)
      if (page !== 'actions') expect(r.emptySlot, page).toBe(false)
    }
  })
})

/** A feed entry for home's Recent (made up). */
const entry = (id: string, label: string): FeedEntry => ({
  type: 'document',
  id,
  label,
  context: null,
  count: 1,
  last: {
    id: `ev-${id}`,
    action: 'renamed',
    at: new Date(Date.now() - 60_000).toISOString(),
    actor: { kind: 'member', member_id: 'm-ana', name: 'Ana Reyes', me: true },
    subject: null,
    from: null,
    to: null,
    relation: null,
    other: null,
  },
})

describe('never an empty slot: the last panel held while the next has nothing known yet (Liam, 11-11: "it goes away completely and reappears")', () => {
  let animated: Element[]
  const realAnimate = (HTMLElement.prototype as { animate?: unknown }).animate
  /** Home's first read, answered when the test says. */
  let answer: (entries: FeedEntry[]) => void
  beforeEach(() => {
    animated = []
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        animated.push(this)
        return { cancel() {}, finish() {} } as unknown as Animation
      },
    })
    const waiting: Array<(entries: FeedEntry[]) => void> = []
    answer = (entries) => {
      for (const resolve of waiting.splice(0)) resolve(entries)
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise<Response>((resolve) => {
            if (!String(url).startsWith('/api/account/feed')) return resolve({ ok: true, json: async () => ({}) } as Response)
            waiting.push((entries) => resolve({ ok: true, json: async () => ({ entries, next_cursor: null }) } as Response))
          }),
      ),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    if (realAnimate === undefined) delete (HTMLElement.prototype as { animate?: unknown }).animate
    else Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: realAnimate })
  })

  const aside = (page: string) => container.querySelector<HTMLElement>(`aside[data-page-panel="${page}"]`)

  it('home before its first read: My Actions’ sub-nav stays on screen, inert, the card still making room; then Recent swaps in with one entrance', async () => {
    act(() => root.render(<Row />))
    await flush()
    await switchTo('actions')
    expect(aside('actions')!.getAttribute('data-page-panel-mode')).toBe('room')
    animated.length = 0
    // Home (the page put away): Recent has nothing known yet.
    act(() => {
      release!()
      release = null
    })
    await flush()
    const held = aside('actions')!
    expect(held.getAttribute('data-page-panel-mode')).toBe('room')
    expect(held.hasAttribute('inert')).toBe(true)
    expect(held.getAttribute('aria-hidden')).toBe('true')
    expect(held.hasAttribute('data-page-panel-held')).toBe(true)
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).not.toBe('')
    expect(store.getSidePanelState().pagePanelShown).toBe(true)
    // Recent's read lands: the swap, as a page change makes it.
    await act(async () => answer([entry('d1', 'Q4 renewals plan')]))
    await flush()
    expect(aside('home')!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(aside('home')!.hasAttribute('inert')).toBe(false)
    expect(aside('actions')!.getAttribute('data-page-panel-mode')).toBe('off')
    expect(aside('actions')!.hasAttribute('data-page-panel-held')).toBe(false)
    expect(animated).toEqual([aside('home')!.querySelector('[data-page-panel-card]')])
  })

  it(`a panel that never gets anything: the hold ends after ${PAGE_PANEL_HOLD_MAX_MS} ms, the slot empty, the card taking the room`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => root.render(<Row />))
    await flush()
    await switchTo('mail')
    act(() => {
      release!()
      release = null
    })
    await flush()
    expect(aside('mail')!.hasAttribute('data-page-panel-held')).toBe(true)
    act(() => vi.advanceTimersByTime(PAGE_PANEL_HOLD_MAX_MS - 1))
    expect(aside('mail')!.getAttribute('data-page-panel-mode')).toBe('room')
    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(aside('mail')!.getAttribute('data-page-panel-mode')).toBe('off')
    expect(container.querySelector('aside[data-page-panel]:not([data-page-panel-mode="off"])')).toBeNull()
    expect(store.getSidePanelState().pagePanel).toBe(false)
    expect(document.documentElement.style.getPropertyValue(PAGE_PANEL_W_VAR)).toBe('')
    // Its read lands later: Recent arrives as a page change, with its entrance.
    animated.length = 0
    await act(async () => answer([entry('d1', 'Q4 renewals plan')]))
    await flush()
    expect(aside('home')!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(animated).toHaveLength(1)
  })
})
