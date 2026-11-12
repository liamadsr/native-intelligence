// @vitest-environment jsdom
/**
 * My Actions' panel: its sub-nav (tasks-panel.tsx; Liam, 11-11: "one todo
 * icon on the main nav and when you click it the sub-nav would show things
 * like milestone and projects that way it's nested and clean and not at the
 * top level"; "ours should look similar except for the parts where our UX is
 * different"). Registered for `actions`: it holds the slot while the page's
 * own card is in front. Its rows move the card through what the card says
 * (tasks-card-controls.ts), the lit row follows where the card is, not the
 * click. The full-screen card has no tabs of its own from `md` up (Liam,
 * 11-11), so the sub-nav asks for the left as the page's one navigation
 * (pagePanelPage: shown while open, room or not). A press in it keeps the
 * page selected. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-home' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
// The shell's teams (teams-context.tsx), as the Teams section lists them.
const teamsMock = vi.hoisted(() => ({ teams: [] as Array<{ id: string; name: string }> }))
vi.mock('@/app/account/teams-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/account/teams-context')>()),
  useTeams: () => ({ teams: teamsMock.teams, loading: false, refetchTeams: async () => {} }),
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

import { PAGE_PANELS, PagePanelHost } from '../page-panel'
import { TasksPanel } from '../tasks-panel'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import {
  __resetTasksCardsForTests,
  publishTasksCard,
  unpublishTasksCard,
  type TasksCardControls,
} from '@/components/chat-cards/tasks-card-controls'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { KEEP_PLACE_ATTR, __resetSelectedPlaceForTests, selectedPlace } from '../../rail/selected-place'

const ACTIONS_CARD = 'card-actions-page'
const actionsSpec = () => CARD_PAGES.find((p) => p.slug === 'actions')!.spec(new Date()) as CardSpec

let container: HTMLDivElement
let root: Root
let releases: Array<() => void> = []
const calls: string[] = []

function controls(over: Partial<TasksCardControls> = {}): TasksCardControls {
  return {
    cardId: ACTIONS_CARD,
    scope: 'assigned',
    viewId: null,
    views: [],
    place: null,
    setScope: (s) => calls.push(`scope:${s}`),
    setView: (id) => calls.push(`view:${id}`),
    go: (p) => calls.push(`go:${p}`),
    show: () => calls.push('show'),
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  teamsMock.teams = []
  releases = []
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetTasksCardsForTests()
  store.resetSidePanelStore()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], next_cursor: null }) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  for (const release of releases) act(() => release())
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

/** The row as the plan answers it: room while the panel is wanted (it has rows and is open). */
function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
}

/** The My Actions page's own card in front, as the rail opens it. */
async function openActionsPage(id = ACTIONS_CARD, spec: CardSpec = actionsSpec()) {
  act(() => {
    releases.push(holdFrontCard({ id, spec, close: () => {} }))
  })
  await flush()
}

const panel = () => container.querySelector<HTMLElement>('aside[data-page-panel="actions"]')
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-tasks-row]')]
const row = (label: string) => rows().find((r) => r.textContent === label)!
const lit = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.textContent)
const headings = () => [...container.querySelectorAll('[data-tasks-section] h3')].map((h) => h.textContent)

describe('the Tasks sub-nav', () => {
  it('is My Actions’ registered panel', () => {
    expect(PAGE_PANELS.actions).toBe(TasksPanel)
  })

  it('holds the slot on the My Actions page from its first commit, before its card says anything; the views, then Projects; saved views come with the card', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    expect(selectedPlace()).toBe('actions')
    // No card has said where it is yet (Liam, 11-11: "it goes away completely and reappears"): the rows
    // it knows without it, the page's default view lit, room asked.
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
    expect(rows().map((r) => r.textContent)).toEqual([
      'Assigned to me', 'All issues', 'Created by me',
      'My projects', 'All projects', 'Milestones', 'Initiatives',
    ])
    expect(lit()).toEqual(['Assigned to me'])
    act(() => publishTasksCard(controls({ views: [{ id: 'v-1', name: 'Fernhill launch' }] })))
    await flush()
    expect(headings()).toEqual(['Projects', 'Saved views'])
    act(() => publishTasksCard(controls()))
    await flush()
    expect(panel()).not.toBeNull()
    expect(panel()!.getAttribute('aria-label')).toBe('Views and projects')
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(rows().map((r) => r.textContent)).toEqual([
      'Assigned to me', 'All issues', 'Created by me',
      'My projects', 'All projects', 'Milestones', 'Initiatives',
    ])
    expect(headings()).toEqual(['Projects'])
    // A press in it keeps the page selected (rail/selected-place.ts).
    expect(rows()[0].closest(`[${KEEP_PLACE_ATTR}]`)).not.toBeNull()
  })

  it('asks for the left as the page’s one navigation (shown while open, room or not); closed by its button, off', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls()))
    await flush()
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
    act(() => store.setPagePanelOpen(false))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('off')
    expect(store.getSidePanelState().pagePanelShown).toBe(false)
  })

  it('back home: Recent’s slot, home’s rules (not pinned)', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls()))
    await flush()
    expect(store.getSidePanelState().pagePanelPage).toBe(true)
    act(() => releases.pop()!())
    await flush()
    expect(selectedPlace()).toBe('home')
    expect(store.getSidePanelState().pagePanelPage).toBe(false)
  })

  it('exactly one row lit, following where the card says it is (not the click)', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    const views = [{ id: 'v-1', name: 'Fernhill launch' }]
    act(() => publishTasksCard(controls({ views })))
    await flush()
    expect(lit()).toEqual(['Assigned to me'])
    // A click alone lights nothing new: the card hasn't moved.
    act(() => row('All issues').click())
    expect(calls).toEqual(['scope:all'])
    expect(lit()).toEqual(['Assigned to me'])
    // The card moved (by the panel, its own tabs, or Back): the row follows.
    act(() => publishTasksCard(controls({ views, scope: 'all' })))
    expect(lit()).toEqual(['All issues'])
    act(() => publishTasksCard(controls({ views, scope: null, viewId: 'v-1' })))
    expect(lit()).toEqual(['Fernhill launch'])
    act(() => publishTasksCard(controls({ views, scope: null, viewId: 'v-1', place: 'projects' })))
    expect(lit()).toEqual(['All projects'])
  })

  it('rows move the card: a view, a place inside it, a saved view; the lit row does nothing more', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls({ views: [{ id: 'v-1', name: 'Fernhill launch' }] })))
    await flush()
    act(() => row('Assigned to me').click())
    act(() => row('Created by me').click())
    act(() => row('All projects').click())
    act(() => row('My projects').click())
    act(() => row('Milestones').click())
    act(() => row('Initiatives').click())
    act(() => row('Fernhill launch').click())
    expect(calls).toEqual(['scope:created', 'go:projects', 'go:my-projects', 'go:milestones', 'go:initiatives', 'view:v-1'])
  })

  it('saved views: their section only when the person has any', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls()))
    await flush()
    expect(headings()).toEqual(['Projects'])
    act(() => publishTasksCard(controls({ views: [{ id: 'v-2', name: 'Bugs this week' }] })))
    expect(headings()).toEqual(['Projects', 'Saved views'])
  })

  it('Teams (Liam, 11-11: "Teams should be under action items"): each team then All teams, only when there are teams; a row opens it in the card, lit from where the card is', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls({ views: [{ id: 'v-2', name: 'Bugs this week' }] })))
    await flush()
    expect(headings()).toEqual(['Projects', 'Saved views'])
    act(() => root.unmount())
    root = createRoot(container)
    teamsMock.teams = [{ id: 't-core', name: 'Core' }, { id: 't-field', name: 'Field crew' }]
    act(() => root.render(<Row />))
    await flush()
    expect(headings()).toEqual(['Projects', 'Teams', 'Saved views'])
    const section = [...container.querySelectorAll<HTMLElement>('[data-tasks-section="teams"] [data-tasks-row]')].map((r) => r.textContent)
    expect(section).toEqual(['Core', 'Field crew', 'All teams'])
    act(() => row('Field crew').click())
    act(() => row('All teams').click())
    expect(calls).toEqual(['go:team:t-field', 'go:teams'])
    // Lit from where the card is: the team's board, then All teams.
    act(() => publishTasksCard(controls({ place: 'team:t-field' })))
    expect(lit()).toEqual(['Field crew'])
    act(() => publishTasksCard(controls({ place: 'teams' })))
    expect(lit()).toEqual(['All teams'])
    // The lit row does nothing more.
    act(() => row('All teams').click())
    expect(calls).toEqual(['go:team:t-field', 'go:teams'])
  })

  it('a record opened over the page as its own card in front: the page stays selected, a row puts the page’s card back first', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls()))
    await flush()
    // A record opened from inside the page (a press in the page's panel counts as inside).
    act(() => {
      rows()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await openActionsPage('card-record', { kind: 'record', title: 'Send the Fernhill quote', record: { type: 'action', id: 'a0000000-0000-4000-8000-000000000001' } } as CardSpec)
    expect(selectedPlace()).toBe('actions')
    expect(panel()).not.toBeNull()
    act(() => row('All projects').click())
    expect(calls).toEqual(['show', 'go:projects'])
  })

  it('the card gone (its page still selected): the rows it knows without it stay, the default lit', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => publishTasksCard(controls({ scope: 'all', views: [{ id: 'v-1', name: 'Fernhill launch' }] })))
    await flush()
    expect(lit()).toEqual(['All issues'])
    act(() => unpublishTasksCard(ACTIONS_CARD))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(headings()).toEqual(['Projects'])
    expect(lit()).toEqual(['Assigned to me'])
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
  })

  it('a row pressed before the card says where it is: the latest move waits, then moves the card once it says; leaving the page drops it', async () => {
    act(() => root.render(<Row />))
    await openActionsPage()
    act(() => row('All issues').click())
    act(() => row('All projects').click())
    expect(calls).toEqual([])
    act(() => publishTasksCard(controls()))
    await flush()
    expect(calls).toEqual(['go:projects'])
    act(() => publishTasksCard(controls({ scope: 'all' })))
    await flush()
    expect(calls).toEqual(['go:projects'])
    // Pressed, then the page left before the card said: nothing moves.
    calls.length = 0
    act(() => unpublishTasksCard(ACTIONS_CARD))
    await flush()
    act(() => row('Created by me').click())
    act(() => releases.pop()!())
    await flush()
    expect(selectedPlace()).toBe('home')
    act(() => publishTasksCard(controls()))
    await flush()
    expect(calls).toEqual([])
  })
})
